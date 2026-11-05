import { it, expect, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { Store } from '../src/server/store.js';
import { fixtureConfig, THREAD } from './helpers.js';
const callbacks: (() => void)[] = [];
afterEach(() => {
  callbacks.splice(0).forEach((x) => x());
  vi.useRealTimers();
});
function setup() {
  const c = fixtureConfig();
  const s = new Store(c.stateDir);
  callbacks.push(() => {
    s.close();
    rmSync(c.desktopRoot, { recursive: true, force: true });
  });
  return s;
}
it('pairing codes are single-use and sessions are revocable', () => {
  const s = setup();
  const p = s.mintPairing();
  const device = s.pair(p.code, 'phone')!;
  expect(s.pair(p.code, 'again')).toBeNull();
  expect(s.authenticate(device.token)?.id).toBe(device.deviceId);
  s.revoke(device.deviceId);
  expect(s.authenticate(device.token)).toBeNull();
});
it('rejects expired pairing codes', () => {
  vi.useFakeTimers();
  const s = setup();
  const p = s.mintPairing();
  vi.advanceTimersByTime(300001);
  expect(s.pair(p.code, 'phone')).toBeNull();
});
it('deduplicates matching requests and rejects mismatched reuse', () => {
  const s = setup();
  expect(s.beginOperation('a', 'd', THREAD, 'send', 'hello').fresh).toBe(true);
  expect(s.beginOperation('a', 'd', THREAD, 'send', 'hello').fresh).toBe(false);
  expect(() => s.beginOperation('a', 'd', THREAD, 'send', 'different')).toThrow();
  expect(() => s.beginOperation('a', 'another', THREAD, 'send', 'hello')).toThrow();
});
it('marks in-flight requests uncertain after restart without replay', () => {
  const s = setup();
  s.beginOperation('a', 'd', THREAD, 'send', 'hello');
  s.updateOperation('a', 'dispatching');
  s.recover();
  expect(s.operation('a')?.state).toBe('uncertain');
  expect(s.beginOperation('a', 'd', THREAD, 'send', 'hello').fresh).toBe(false);
});
it('does not expose another device’s operation', () => {
  const s = setup();
  s.beginOperation('a', 'd', THREAD, 'send', 'hello');
  expect(s.operation('a', 'other')).toBeNull();
});
