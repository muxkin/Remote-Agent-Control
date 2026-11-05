import { RTCPeerConnection, type RTCIceCandidateInit } from 'werift';
import { CipherWire, type Lane } from '../shared/secure-channel.js';

/** One peer per device session, with independently backpressured control and bulk lanes. */
export class DevicePeer {
  private pc: RTCPeerConnection;
  private wires = new Map<Lane, CipherWire>();
  private ended = false;
  private timer: NodeJS.Timeout;
  constructor(
    stunUrls: string[],
    private signal: (candidate: unknown) => void,
    private opened: (wire: CipherWire, lane: Lane) => void,
    private endedCallback: () => void,
  ) {
    this.pc = new RTCPeerConnection({
      iceServers: stunUrls.map((urls) => ({ urls })),
      maxMessageSize: 65536,
    });
    this.timer = setTimeout(() => this.close(), 15000);
    this.timer.unref();
    this.pc.onIceCandidate.subscribe((candidate) => {
      if (!this.ended) this.signal(candidate?.toJSON() ?? null);
    });
    this.pc.onDataChannel.subscribe((channel) => {
      const lane =
        channel.label === 'pocket-control-v2'
          ? 'control'
          : channel.label === 'pocket-bulk-v2'
            ? 'bulk'
            : null;
      if (!lane || this.wires.has(lane) || !channel.ordered) {
        channel.close();
        return;
      }
      channel.bufferedAmountLowThreshold = 64 * 1024;
      const wire = new CipherWire(
        async (bytes) => {
          if (channel.readyState !== 'open') throw Error('Direct channel closed');
          if (channel.bufferedAmount > 256 * 1024) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                subscription.unSubscribe();
                reject(Error('Direct channel stalled'));
              }, 10000);
              const subscription = channel.bufferedAmountLow.subscribe(() => {
                clearTimeout(timer);
                subscription.unSubscribe();
                resolve();
              });
            });
          }
          channel.send(Buffer.from(bytes));
        },
        () => channel.close(),
      );
      this.wires.set(lane, wire);
      channel.onmessage = ({ data }) => {
        if (typeof data === 'string' || data.length > 65536) {
          channel.close();
          return;
        }
        wire.onData(data);
      };
      channel.onopen = () => {
        clearTimeout(this.timer);
        this.opened(wire, lane);
      };
      channel.onclose = () => wire.onTransportClosed();
      channel.onerror = () => this.close();
    });
    this.pc.connectionStateChange.subscribe((state) => {
      if (['closed', 'failed'].includes(state)) this.close();
      else if (state === 'disconnected') {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.close(), 5000);
        this.timer.unref();
      } else if (state === 'connected') clearTimeout(this.timer);
    });
  }
  async answer(sdp: string) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    return this.pc.localDescription!.sdp;
  }
  async candidate(candidate: RTCIceCandidateInit | null) {
    if (!this.ended) await this.pc.addIceCandidate(candidate);
  }
  close() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    for (const wire of this.wires.values()) wire.onTransportClosed();
    void this.pc.close();
    this.endedCallback();
  }
}
