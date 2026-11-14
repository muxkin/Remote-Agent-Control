import type { CodexVoiceEvent } from '../shared/codex-voice';

type VoiceTranscript = Extract<CodexVoiceEvent, { type: 'transcript' }>;

export interface CodexVoiceState {
  phase: 'idle' | 'connecting' | 'connected' | 'ended' | 'error';
  muted: boolean;
  audioBlocked: boolean;
  transcript: readonly Omit<VoiceTranscript, 'type'>[];
  activity: 'idle' | 'listening' | 'speaking';
  error?: string;
  connectedAt?: number;
  voiceThreadId?: string;
}

interface VoiceTransport {
  start(sdp: string): Promise<unknown>;
  stop(): Promise<unknown>;
}

export class CodexVoiceSession {
  private readonly lifetime = new AbortController();
  private readonly transport: VoiceTransport;
  private readonly changed: (state: CodexVoiceState) => void;
  private peer?: RTCPeerConnection;
  private events?: RTCDataChannel;
  private input?: MediaStream;
  private audio?: HTMLAudioElement;
  private deadline?: ReturnType<typeof setTimeout>;
  private meter?: ReturnType<typeof setInterval>;
  private requested = false;
  private acceptedAnswer = false;
  private state: CodexVoiceState = {
    phase: 'idle',
    muted: false,
    audioBlocked: false,
    transcript: [],
    activity: 'idle',
  };

  constructor(transport: VoiceTransport, changed: (state: CodexVoiceState) => void) {
    this.transport = transport;
    this.changed = changed;
  }

  async start(audio: HTMLAudioElement) {
    if (this.state.phase !== 'idle') return;
    const signal = this.lifetime.signal;
    this.audio = audio;
    this.update({ phase: 'connecting' });
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
        throw Error('Codex Voice 需要 HTTPS 和支持 WebRTC 的浏览器');
      const input = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (signal.aborted) {
        input.getTracks().forEach((track) => track.stop());
        return;
      }
      this.input = input;
      const peer = (this.peer = new RTCPeerConnection());
      for (const track of input.getAudioTracks()) {
        track.enabled = false;
        peer.addTrack(track, input);
        track.onended = () => this.finish('麦克风已断开');
      }
      // This channel carries Realtime events alongside the microphone and playback tracks.
      this.events = peer.createDataChannel('oai-events');
      this.events.onclose = () => this.finish('Codex Voice 连接已断开');
      this.events.onerror = () => this.finish('Codex Voice 连接出错');
      peer.ontrack = (event) => {
        if (signal.aborted || event.track.kind !== 'audio') return;
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void this.resumeAudio();
        this.monitorPlayback(event.receiver, audio);
      };
      peer.onconnectionstatechange = () => this.connectionChanged(peer.connectionState);
      this.deadline = setTimeout(() => this.finish('Codex Voice 连接超时'), 45_000);
      const offer = await peer.createOffer();
      signal.throwIfAborted();
      await peer.setLocalDescription(offer);
      signal.throwIfAborted();
      await waitForIce(peer, signal);
      signal.throwIfAborted();
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw Error('无法生成 Codex Voice 通话信令');
      this.requested = true;
      await this.transport.start(sdp);
    } catch (error) {
      if (!signal.aborted) this.finish(startError(error));
    }
  }

  receive(event: CodexVoiceEvent) {
    if (this.lifetime.signal.aborted) return;
    switch (event.type) {
      case 'answer':
        if (!this.peer || this.acceptedAnswer) return;
        this.acceptedAnswer = true;
        void this.peer.setRemoteDescription({ type: 'answer', sdp: event.sdp }).catch(() => {
          this.finish('无法建立 Codex Voice 音频连接');
        });
        break;
      case 'started':
        this.update({ voiceThreadId: event.voiceThreadId });
        break;
      case 'transcript':
        this.transcribe(event);
        break;
      case 'closed':
        this.finish(undefined, false);
        break;
      case 'error':
        this.finish(event.message || 'Codex Voice 会话出错');
        break;
    }
  }

  mute(muted: boolean) {
    if (this.lifetime.signal.aborted || this.state.muted === muted) return;
    const connected = this.state.phase === 'connected';
    this.microphone(muted, connected);
    const activity = this.state.activity === 'speaking' ? 'speaking' : this.microphoneActivity(muted);
    this.update({ muted, activity });
  }

  async resumeAudio() {
    if (!this.audio?.srcObject || this.lifetime.signal.aborted) return;
    try {
      await this.audio.play();
      if (this.state.audioBlocked && !this.lifetime.signal.aborted) this.update({ audioBlocked: false });
    } catch (error) {
      if (this.lifetime.signal.aborted) return;
      if (error instanceof DOMException && error.name === 'NotAllowedError')
        this.update({ audioBlocked: true });
    }
  }

  stop(error?: string) {
    this.finish(error);
  }

  private update(change: Partial<CodexVoiceState>) {
    this.state = { ...this.state, ...change };
    this.changed(this.state);
  }

  private microphone(muted: boolean, connected: boolean) {
    this.input?.getAudioTracks().forEach((track) => {
      track.enabled = connected && !muted;
    });
  }

  private microphoneActivity(muted = this.state.muted): 'idle' | 'listening' {
    return this.state.phase === 'connected' && !muted ? 'listening' : 'idle';
  }

  private connectionChanged(state: RTCPeerConnectionState) {
    if (this.lifetime.signal.aborted) return;
    switch (state) {
      case 'connected':
        clearTimeout(this.deadline);
        this.microphone(this.state.muted, true);
        this.update({
          phase: 'connected',
          connectedAt: this.state.connectedAt ?? Date.now(),
          activity: this.state.muted ? 'idle' : 'listening',
        });
        break;
      case 'disconnected':
        clearTimeout(this.deadline);
        this.microphone(this.state.muted, false);
        this.update({ phase: 'connecting', activity: 'idle' });
        this.deadline = setTimeout(() => this.finish('网络已断开，Codex Voice 通话结束'), 12_000);
        break;
      case 'closed':
      case 'failed':
        this.finish('Codex Voice 音频连接已中断');
        break;
    }
  }

  private monitorPlayback(receiver: RTCRtpReceiver, audio: HTMLAudioElement) {
    clearInterval(this.meter);
    let lastSpoken = Number.NEGATIVE_INFINITY;
    this.meter = setInterval(() => {
      if (this.state.phase !== 'connected' || audio.paused) return;
      const now = performance.now();
      const speaking = receiver
        .getSynchronizationSources?.()
        .some((source) => now - source.timestamp < 500 && (source.audioLevel ?? 0) > 0.025);
      if (speaking) lastSpoken = now;
      // Bridge short pauses between syllables so the status does not flicker.
      const activity = now - lastSpoken < 350 ? 'speaking' : this.microphoneActivity();
      if (activity !== this.state.activity) this.update({ activity });
    }, 120);
  }

  private transcribe({ role, text, final }: VoiceTranscript) {
    const transcript = this.state.transcript.slice();
    let pending = transcript.length - 1;
    while (pending >= 0 && transcript[pending]!.role !== role) pending -= 1;
    const previous = transcript[pending];
    if (previous && !previous.final) {
      const content = text || previous.text;
      transcript[pending] = { role, text: content.slice(-8_000), final };
    } else if (text) {
      transcript.push({ role, text: text.slice(-8_000), final });
    }
    this.update({ transcript: transcript.slice(-24) });
  }

  private finish(error?: string, notify = true) {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    clearTimeout(this.deadline);
    clearInterval(this.meter);
    this.input?.getTracks().forEach((track) => track.stop());
    this.events?.close();
    this.peer?.close();
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
    }
    if (notify && this.requested)
      void Promise.resolve()
        .then(() => this.transport.stop())
        .catch(() => {});
    this.update({ phase: error ? 'error' : 'ended', error, activity: 'idle', audioBlocked: false });
  }
}

function waitForIce(peer: RTCPeerConnection, signal: AbortSignal) {
  if (peer.iceGatheringState === 'complete' || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    // The remote candidate can also discover the local peer after receiving the initial SDP.
    const timeout = setTimeout(finish, 2_000);
    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      peer.removeEventListener('icegatheringstatechange', check);
      resolve();
    }
    function check() {
      if (peer.iceGatheringState === 'complete') finish();
    }
    signal.addEventListener('abort', finish, { once: true });
    peer.addEventListener('icegatheringstatechange', check);
  });
}

function startError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return '未获得麦克风权限，请在浏览器中允许后重试';
    if (error.name === 'NotFoundError') return '找不到可用的麦克风';
    if (error.name === 'NotReadableError') return '无法读取麦克风，请检查设备连接和系统权限';
  }
  return error instanceof Error ? error.message : '无法开始 Codex Voice';
}
