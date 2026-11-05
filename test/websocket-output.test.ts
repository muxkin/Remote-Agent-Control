import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { WebSocketOutput } from '../src/server/websocket-output.js';

class DelayedSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  frames: string[] = [];
  callbacks: ((error?: Error) => void)[] = [];
  closeCodes: number[] = [];
  send(data: string, callback: (error?: Error) => void) {
    this.frames.push(data);
    this.callbacks.push(callback);
  }
  close(code: number) {
    this.closeCodes.push(code);
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}
it('preserves snapshot, receipt and delta ordering while a large write is still pending', () => {
  const socket = new DelayedSocket();
  const output = new WebSocketOutput(socket as unknown as WebSocket);
  expect(output.send('x'.repeat(4 * 1024 * 1024))).toBe(true);
  expect(output.send('receipt')).toBe(true);
  expect(output.send('delta')).toBe(true);
  expect(socket.frames).toHaveLength(1);
  socket.callbacks.shift()!();
  expect(socket.frames.at(-1)).toBe('receipt');
  socket.callbacks.shift()!();
  expect(socket.frames.at(-1)).toBe('delta');
  expect(socket.closeCodes).toEqual([]);
});
it('still disconnects an actually stalled receiver when additional queued work exceeds the limit', () => {
  const socket = new DelayedSocket();
  const output = new WebSocketOutput(socket as unknown as WebSocket);
  output.send('in-flight');
  expect(output.send('x'.repeat(8 * 1024 * 1024))).toBe(true);
  expect(output.send('overflow')).toBe(false);
  expect(socket.closeCodes).toEqual([1013]);
  socket.callbacks.shift()!();
  expect(socket.frames).toEqual(['in-flight']);
});
it('closes on a write failure so the client can reconnect instead of remaining silently stalled', () => {
  const socket = new DelayedSocket();
  const output = new WebSocketOutput(socket as unknown as WebSocket);
  output.send('snapshot');
  output.send('receipt');
  socket.callbacks.shift()!(new Error('write failed'));
  expect(socket.closeCodes).toEqual([1011]);
  expect(output.send('later')).toBe(false);
  expect(socket.frames).toEqual(['snapshot']);
});
