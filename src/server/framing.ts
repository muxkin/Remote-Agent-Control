export const MAX_FRAME = 32 * 1024 * 1024;
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (!body.length || body.length > MAX_FRAME) throw new Error('IPC frame exceeds limit');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
export class FrameReader {
  private header = Buffer.alloc(4);
  private headerUsed = 0;
  private body: Buffer | null = null;
  private used = 0;
  push(chunk: Buffer, onMessage: (value: any) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        const length = Math.min(4 - this.headerUsed, chunk.length - offset);
        chunk.copy(this.header, this.headerUsed, offset, offset + length);
        this.headerUsed += length;
        offset += length;
        if (this.headerUsed < 4) continue;
        const size = this.header.readUInt32LE();
        if (!size || size > MAX_FRAME) throw new Error('Invalid IPC frame size');
        this.body = Buffer.allocUnsafe(size);
        this.used = 0;
        this.headerUsed = 0;
      }
      const length = Math.min(this.body.length - this.used, chunk.length - offset);
      chunk.copy(this.body, this.used, offset, offset + length);
      this.used += length;
      offset += length;
      if (this.used === this.body.length) {
        const body = this.body;
        this.body = null;
        const value = JSON.parse(body.toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Invalid IPC message');
        onMessage(value);
      }
    }
  }
}
