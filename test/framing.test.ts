import { describe, it, expect } from 'vitest';
import { encodeFrame, FrameReader, MAX_FRAME } from '../src/server/framing.js';
describe('IPC framing', () => {
  it('preserves UTF-8 across every byte boundary and coalesced frames', () => {
    const messages = [{ text: '中文🙂', n: 1 }, { text: 'next' }];
    const data = Buffer.concat(messages.map(encodeFrame));
    for (let cut = 0; cut <= data.length; cut++) {
      const result: any[] = [];
      const reader = new FrameReader();
      reader.push(data.subarray(0, cut), (x) => result.push(x));
      reader.push(data.subarray(cut), (x) => result.push(x));
      expect(result).toEqual(messages);
    }
    const result: any[] = [];
    const reader = new FrameReader();
    for (const byte of data) reader.push(Buffer.from([byte]), (x) => result.push(x));
    expect(result).toEqual(messages);
  });
  it('rejects zero and oversized frames before allocation', () => {
    for (const size of [0, MAX_FRAME + 1]) {
      const h = Buffer.alloc(4);
      h.writeUInt32LE(size);
      expect(() => new FrameReader().push(h, () => {})).toThrow();
    }
  });
  it('rejects invalid JSON and non-object envelopes', () => {
    expect(() => new FrameReader().push(encodeFrame(null), () => {})).toThrow();
    const b = Buffer.from([1, 0, 0, 0, 123]);
    expect(() => new FrameReader().push(b, () => {})).toThrow();
  });
});
