import type { AgentCallsClient } from '../../client/calls';
import type { AgentCall, CallMode, CallPayload } from '../../shared/calls';

export interface CallViewState {
  phase: 'preparing' | 'ringing' | 'connecting' | 'connected' | 'ended';
  local?: MediaStream;
  remote?: MediaStream;
  error?: string;
  muted: boolean;
  camera: boolean;
  connectedAt?: number;
  route?: 'direct' | 'relay';
}
const endedReason: Record<string, string> = {
  unanswered: 'Agent 暂未接听',
  declined: 'Agent 已拒绝通话',
  disconnected: '通话连接已中断',
  unavailable: 'Agent 已断开',
  failed: '通话未能建立',
  hangup: '通话已结束',
};
export class AgentCallSession {
  private abort = new AbortController();
  private pc?: RTCPeerConnection;
  private call?: AgentCall;
  private id?: string;
  private timer?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private routeTimer?: ReturnType<typeof setInterval>;
  private candidates: RTCIceCandidateInit[] = [];
  private sending = Promise.resolve();
  private stopped = false;
  private state: CallViewState = { phase: 'preparing', muted: false, camera: false };
  constructor(
    readonly client: AgentCallsClient,
    readonly changed: (state: CallViewState) => void,
  ) {}
  private update(value: Partial<CallViewState>) {
    this.state = { ...this.state, ...value };
    this.changed(this.state);
  }
  private async checkRoute(pc: RTCPeerConnection) {
    const report = await pc.getStats().catch(() => undefined);
    if (!report || this.stopped || pc.connectionState !== 'connected') return;
    const routes = new Set<string>();
    report.forEach((transport) => {
      if (transport.type !== 'transport' || !transport.selectedCandidatePairId) return;
      const pair = report.get(transport.selectedCandidatePairId);
      const local = report.get(pair?.localCandidateId)?.candidateType;
      const remote = report.get(pair?.remoteCandidateId)?.candidateType;
      if (local && remote) routes.add(local === 'relay' || remote === 'relay' ? 'relay' : 'direct');
    });
    const route = routes.has('relay') ? 'relay' : routes.has('direct') ? 'direct' : undefined;
    if (route !== this.state.route) this.update({ route });
  }
  async start(cid: string, mode: CallMode) {
    const signal = this.abort.signal;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
        throw Error('当前浏览器不支持安全音视频通话，请使用 HTTPS 页面和支持 WebRTC 的浏览器');
      const [cap, { iceServers }] = await Promise.all([
        this.client.capabilities(cid, signal),
        this.client.ice(signal),
      ]);
      if (!cap[mode])
        throw Error(
          mode === 'video' ? 'Agent 尚未开启视频接听，或目前离线' : 'Agent 尚未开启语音接听，或目前离线',
        );
      const local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video:
          mode === 'video' ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false,
      });
      if (signal.aborted) {
        local.getTracks().forEach((t) => t.stop());
        return;
      }
      this.update({ local, camera: mode === 'video' });
      this.id = crypto.randomUUID();
      const { call } = await this.client.create(cid, mode, this.id, signal);
      signal.throwIfAborted();
      this.call = call;
      // ICE ranks direct candidates ahead of TURN and can still use TURN when required.
      const pc = (this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' })),
        remote = new MediaStream();
      this.update({ phase: 'ringing', remote });
      local.getTracks().forEach((t) => pc.addTrack(t, local));
      pc.ontrack = (e) => {
        if (signal.aborted) {
          e.track.stop();
          return;
        }
        remote.addTrack(e.track);
        this.update({ remote });
      };
      pc.onicecandidate = (e) => {
        if (e.candidate)
          this.send({
            type: 'candidate',
            candidate: { ...e.candidate.toJSON(), candidate: e.candidate.candidate },
          });
      };
      pc.onconnectionstatechange = () => {
        if (signal.aborted) return;
        if (pc.connectionState === 'connected') {
          clearTimeout(this.deadline);
          clearInterval(this.routeTimer);
          this.update({
            phase: 'connected',
            error: undefined,
            connectedAt: this.state.connectedAt ?? Date.now(),
          });
          void this.checkRoute(pc);
          this.routeTimer = setInterval(() => void this.checkRoute(pc), 5000);
        } else if (pc.connectionState === 'failed') this.close('连接失败，请检查网络或通话中继配置');
        else if (pc.connectionState === 'disconnected') {
          clearInterval(this.routeTimer);
          this.update({ phase: 'connecting', route: undefined });
          clearTimeout(this.deadline);
          this.deadline = setTimeout(() => this.close('网络已断开，通话结束'), 15_000);
        }
      };
      this.deadline = setTimeout(() => this.close('连接超时，Agent 可能未接听或媒体连接不可用'), 65_000);
      const offer = await pc.createOffer();
      signal.throwIfAborted();
      await pc.setLocalDescription(offer);
      this.send({ type: 'description', description: { type: 'offer', sdp: offer.sdp! } });
      this.timer = setInterval(() => {
        void this.client.update(call.id, 'heartbeat', undefined, signal).catch(() => {
          /* poll reports failures */
        });
      }, 20_000);
      void this.poll();
    } catch (e) {
      if (!signal.aborted)
        this.close(
          e instanceof DOMException && e.name === 'NotAllowedError'
            ? '未获得麦克风或摄像头权限，请在浏览器中允许后重试'
            : e instanceof Error
              ? e.message
              : '无法开始通话',
        );
    }
  }
  private send(payload: CallPayload) {
    this.sending = this.sending
      .then(async () => {
        this.abort.signal.throwIfAborted();
        await this.client.send(this.call!, payload, this.abort.signal);
      })
      .catch((e) => {
        if (!this.abort.signal.aborted) this.close(e instanceof Error ? e.message : '通话信令发送失败');
      });
  }
  private async poll() {
    let after = 0,
      failures = 0;
    const signal = this.abort.signal;
    while (!signal.aborted) {
      try {
        const result = await this.client.poll(this.call!.id, after, signal);
        if (signal.aborted) return;
        if (result.call.state === 'ended') {
          this.close(endedReason[result.call.reason] ?? '通话已结束', false);
          return;
        }
        if (result.call.state === 'active' && this.state.phase === 'ringing')
          this.update({ phase: 'connecting' });
        for (const item of result.signals) {
          if (item.senderId !== result.call.agentId) continue;
          const data = await this.client.decode(result.call, item);
          signal.throwIfAborted();
          if (data.type === 'description') {
            if (data.description.type !== 'answer') throw Error('Agent 返回了无效的接听信令');
            await this.pc!.setRemoteDescription(data.description);
            for (const candidate of this.candidates.splice(0)) await this.pc!.addIceCandidate(candidate);
          } else if (this.pc!.remoteDescription) await this.pc!.addIceCandidate(data.candidate);
          else this.candidates.push(data.candidate);
        }
        after = result.cursor;
        failures = 0;
      } catch (e) {
        if (signal.aborted) return;
        if (
          ++failures >= 3 ||
          (e as { status?: number }).status === 401 ||
          (e as { status?: number }).status === 403
        ) {
          this.close('与通话服务的连接已中断，请重新呼叫');
          return;
        }
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, failures ? 2000 : this.state.phase === 'connecting' ? 350 : 1000);
        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
      });
    }
  }
  mute() {
    const muted = !this.state.muted;
    this.state.local?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
    this.update({ muted });
  }
  async camera() {
    const sender =
      this.pc?.getSenders().find((s) => s.track?.kind === 'video') ??
      this.pc?.getTransceivers().find((t) => t.receiver.track.kind === 'video')?.sender;
    if (!sender || this.stopped) return;
    if (this.state.camera) {
      await sender.replaceTrack(null);
      this.state.local?.getVideoTracks().forEach((t) => {
        t.stop();
        this.state.local?.removeTrack(t);
      });
      if (!this.stopped) this.update({ camera: false });
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 } },
        audio: false,
      });
      if (this.stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const track = stream.getVideoTracks()[0]!;
      try {
        await sender.replaceTrack(track);
      } catch (e) {
        track.stop();
        throw e;
      }
      if (this.stopped) {
        track.stop();
        return;
      }
      this.state.local?.addTrack(track);
      this.update({ camera: true });
    }
  }
  close(error?: string, notify = true) {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    clearInterval(this.timer);
    clearInterval(this.routeTimer);
    clearTimeout(this.deadline);
    this.state.local?.getTracks().forEach((t) => t.stop());
    this.state.remote?.getTracks().forEach((t) => t.stop());
    this.pc?.close();
    if (notify && this.id)
      void this.client.update(this.id, 'end', error ? 'failed' : 'hangup').catch(() => {});
    this.update({
      phase: 'ended',
      error: error ?? '通话已结束',
      local: undefined,
      remote: undefined,
      camera: false,
    });
  }
}
