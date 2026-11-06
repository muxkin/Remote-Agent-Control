import WebSocket from 'ws';
import { CipherWire, base64, identityKey, type Identity, type Lane } from '../shared/secure-channel.js';
import { hostProof, readRelayFrame, relayFrame, type RelayRoute } from '../shared/relay-protocol.js';

export class HostRelay {
  private sockets = new Map<Lane, WebSocket>();
  private wires = new Map<string, { lane: Lane; wire: CipherWire }>();
  private timers = new Set<NodeJS.Timeout>();
  private stopped = false;
  private announced = '';
  private routesTimer?: NodeJS.Timeout;
  constructor(
    private origin: string,
    private identity: Identity,
    private enrollment: string,
    private routes: () => RelayRoute[],
    private joined: (wire: CipherWire, lane: Lane, ticket: string, peerId?: string) => void,
    private changed: (connected: boolean) => void = () => {},
  ) {}
  start() {
    this.connect('control');
    this.connect('bulk');
    this.routesTimer = setInterval(() => this.announce(), 1000);
    this.routesTimer.unref();
  }
  announce() {
    const ws = this.sockets.get('control');
    if (ws?.readyState === WebSocket.OPEN && (ws as any).registered) {
      const message = JSON.stringify({ type: 'routes', routes: this.routes() });
      if (message !== this.announced) {
        ws.send(message);
        this.announced = message;
      }
    }
  }
  private connect(lane: Lane, attempt = 0) {
    if (this.stopped) return;
    const url = new URL('/connect', this.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url, {
      headers: { Origin: this.origin },
      maxPayload: 128 * 1024,
      handshakeTimeout: 10000,
      perMessageDeflate: false,
    });
    this.sockets.set(lane, ws);
    ws.on('message', (raw, binary) => {
      if (binary) {
        try {
          const frame = readRelayFrame(new Uint8Array(raw as Buffer));
          this.wires.get(frame.id)?.wire.onData(frame.bytes);
        } catch {
          ws.close();
        }
        return;
      }
      void (async () => {
        const value = JSON.parse(raw.toString());
        if (value.type === 'challenge') {
          const signature = await identityKey(this.identity).sign(
            hostProof(value.challenge, this.identity.peerId, lane),
          );
          ws.send(
            JSON.stringify({
              type: 'host',
              hostId: this.identity.peerId,
              lane,
              signature: base64(signature),
              enrollment: this.enrollment,
            }),
          );
        } else if (value.type === 'registered') {
          (ws as any).registered = true;
          attempt = 0;
          if (lane === 'control') {
            this.announced = '';
            this.announce();
            this.changed(true);
          }
        } else if (value.type === 'join') {
          const id = value.id;
          const wire = new CipherWire(
            (bytes) =>
              new Promise<void>((resolve, reject) => {
                if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 2 * 1024 * 1024) {
                  reject(Error('Relay disconnected'));
                  return;
                }
                ws.send(relayFrame(id, bytes), (error) => (error ? reject(error) : resolve()));
              }),
            () => {
              this.wires.delete(id);
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'close', id }));
            },
          );
          this.wires.set(id, { lane, wire });
          this.joined(wire, lane, value.ticket, value.peerId);
        } else if (value.type === 'leave') {
          this.wires.get(value.id)?.wire.onTransportClosed();
          this.wires.delete(value.id);
        }
      })().catch(() => ws.close());
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      for (const [id, entry] of this.wires)
        if (entry.lane === lane) {
          entry.wire.onTransportClosed();
          this.wires.delete(id);
        }
      if (lane === 'control') this.changed(false);
      if (!this.stopped) {
        const timer = setTimeout(
          () => {
            this.timers.delete(timer);
            this.connect(lane, attempt + 1);
          },
          Math.min(15000, 500 * 2 ** attempt),
        );
        // The gateway must stay alive while the network or relay is unavailable,
        // including at login before a desktop IPC connection exists.
        this.timers.add(timer);
      }
    });
  }
  stop() {
    this.stopped = true;
    clearInterval(this.routesTimer);
    for (const timer of this.timers) clearTimeout(timer);
    for (const socket of this.sockets.values()) socket.terminate();
    for (const { wire } of this.wires.values()) wire.onTransportClosed();
    this.wires.clear();
  }
}
