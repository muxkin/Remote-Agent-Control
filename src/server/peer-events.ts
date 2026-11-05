import { RTCPeerConnection, type RTCDataChannel } from 'werift';

/** One authenticated signalling session owns one reliable, ordered data channel. */
export class PeerEvents {
  private pc: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private stopped = false;
  private timer: NodeJS.Timeout;
  constructor(
    stunUrls: string[],
    private opened: () => void,
    private closed: () => void,
    private control: (message: unknown) => void,
  ) {
    this.pc = new RTCPeerConnection({
      iceServers: stunUrls.map((urls) => ({ urls })),
      iceUseIpv6: false,
      maxMessageSize: 1024 * 1024,
    });
    this.timer = setTimeout(() => this.close(), 12000);
    this.timer.unref();
    this.pc.onDataChannel.subscribe((channel) => {
      if (this.channel || channel.label !== 'pocket-events' || !channel.ordered) {
        channel.close();
        return;
      }
      this.channel = channel;
      channel.onopen = () => {
        clearTimeout(this.timer);
        if (!this.stopped) this.opened();
      };
      channel.onmessage = (event) => {
        try {
          const raw = String(event.data);
          if (raw.length > 70000) throw Error();
          this.control(JSON.parse(raw));
        } catch {
          this.close();
        }
      };
      channel.onclose = () => this.close();
      channel.onerror = () => this.close();
    });
    this.pc.connectionStateChange.subscribe((state) => {
      if (['failed', 'disconnected', 'closed'].includes(state)) this.close();
    });
  }
  async answer(sdp: string): Promise<string> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    if (this.stopped) throw new Error('Peer closed');
    return this.pc.localDescription!.sdp;
  }
  get ready(): boolean {
    return !this.stopped && this.channel?.readyState === 'open';
  }
  send(data: string): boolean {
    if (!this.ready) return false;
    if (this.channel!.bufferedAmount > 2 * 1024 * 1024) {
      this.close();
      return false;
    }
    // SDP implementations differ in their max message size. Chunk on Unicode-safe boundaries.
    try {
      for (let offset = 0; offset < data.length; offset += 12000)
        this.channel!.send(
          JSON.stringify({ more: offset + 12000 < data.length, data: data.slice(offset, offset + 12000) }),
        );
      return true;
    } catch {
      this.close();
      return false;
    }
  }
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    void this.pc.close();
    this.closed();
  }
}
