import type { ServerEvent, Operation } from '../shared/types';
export class ControlRejectedError extends Error {}
export class BrowserPeer {
  private pc: RTCPeerConnection;
  private chunks = '';
  private stopped = false;
  private timer: ReturnType<typeof setTimeout>;
  active = false;
  private channel: RTCDataChannel;
  private pending = new Map<
    string,
    {
      resolve: (operation: Operation) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private socket: WebSocket,
    stunUrls: string[],
    private receive: (event: ServerEvent) => void,
    private changed: (active: boolean) => void,
  ) {
    this.pc = new RTCPeerConnection({ iceServers: stunUrls.map((urls) => ({ urls })) });
    const channel = this.pc.createDataChannel('pocket-events', { ordered: true });
    this.channel = channel;
    channel.onmessage = (event) => {
      if (this.stopped) return;
      try {
        const chunk = JSON.parse(event.data);
        if (typeof chunk.data !== 'string') throw Error();
        this.chunks += chunk.data;
        if (this.chunks.length > 16 * 1024 * 1024) throw Error();
        if (!chunk.more) {
          const value = JSON.parse(this.chunks) as ServerEvent;
          this.chunks = '';
          if (!this.active) {
            this.active = true;
            this.changed(true);
          }
          if (value.type === 'control-receipt') {
            const pending = this.pending.get(value.requestId);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(value.requestId);
              if (value.operation) pending.resolve(value.operation);
              else
                pending.reject(
                  value.notSent
                    ? new ControlRejectedError(value.error)
                    : new Error(value.error ?? '请求尚未确认'),
                );
            }
          } else this.receive(value);
        }
      } catch {
        this.close(true);
      }
    };
    channel.onclose = () => this.close(true);
    channel.onerror = () => this.close(true);
    this.pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(this.pc.connectionState)) this.close(true);
    };
    this.timer = setTimeout(() => {
      if (!this.active) this.close(true);
    }, 15000);
  }
  async offer(): Promise<void> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    if (this.pc.iceGatheringState !== 'complete')
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 4000);
        this.pc.onicegatheringstatechange = () => {
          if (this.pc.iceGatheringState === 'complete') {
            clearTimeout(timeout);
            resolve();
          }
        };
      });
    if (!this.stopped && this.socket.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: 'p2p-offer', sdp: this.pc.localDescription!.sdp }));
  }
  async answer(sdp: string): Promise<void> {
    if (!this.stopped) await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }
  request(
    action: Operation['kind'],
    payload: { requestId: string; [key: string]: unknown },
  ): Promise<Operation> {
    return new Promise((resolve, reject) => {
      if (!this.active || this.channel.readyState !== 'open') {
        reject(new Error('P2P 连接已断开'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(payload.requestId);
        reject(new Error('P2P 请求未获得确认'));
      }, 10000);
      this.pending.set(payload.requestId, { resolve, reject, timer });
      try {
        this.channel.send(JSON.stringify({ type: 'control', action, payload }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(payload.requestId);
        reject(new Error('P2P 发送结果待确认'));
      }
    });
  }
  close(notify = false): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.active = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('P2P 连接中断，结果待确认'));
    }
    this.pending.clear();
    this.pc.close();
    this.changed(false);
    if (notify && this.socket.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: 'p2p-fallback' }));
  }
}
