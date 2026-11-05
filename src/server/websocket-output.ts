import { WebSocket } from 'ws';

/** Serialize writes: a single legitimate snapshot is not a slow-consumer backlog. */
export class WebSocketOutput {
  private queue: { data: string; bytes: number }[] = [];
  private queuedBytes = 0;
  private sending = false;
  private stopped = false;
  constructor(private socket: WebSocket) {
    socket.once('close', () => this.stop());
  }
  send(data: string): boolean {
    if (this.stopped || this.socket.readyState !== WebSocket.OPEN) return false;
    if (this.sending) {
      const bytes = Buffer.byteLength(data);
      // Bound additional unsent work, excluding the frame already being written.
      if (this.queue.length >= 128 || this.queuedBytes + bytes > 8 * 1024 * 1024) {
        this.stop();
        this.socket.close(1013, 'Slow consumer; reconnect for snapshot');
        return false;
      }
      this.queue.push({ data, bytes });
      this.queuedBytes += bytes;
    } else this.write(data);
    return true;
  }
  private write(data: string): void {
    this.sending = true;
    this.socket.send(data, (error) => {
      this.sending = false;
      if (error || this.socket.readyState !== WebSocket.OPEN) {
        this.stop();
        if (error && this.socket.readyState === WebSocket.OPEN)
          this.socket.close(1011, 'Write failed; reconnect for snapshot');
        return;
      }
      if (this.stopped) return;
      const next = this.queue.shift();
      if (next) {
        this.queuedBytes -= next.bytes;
        this.write(next.data);
      }
    });
  }
  private stop(): void {
    this.stopped = true;
    this.queue = [];
    this.queuedBytes = 0;
  }
}
