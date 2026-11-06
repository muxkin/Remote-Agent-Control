import { temporaryRuntime } from './temporary-runtime.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { it, expect, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import { Store } from '../src/server/store.js';
import { fixtureConfig, THREAD } from './helpers.js';
const callbacks: (() => void)[] = [];
afterEach(() => {
  callbacks.splice(0).forEach((x) => x());
  vi.useRealTimers();
});
function setup() {
  const c = fixtureConfig();
  const s = new Store(c.stateDir, temporaryRuntime);
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

it('migrates an original database without losing pairing, devices or operation deduplication', () => {
  const c = fixtureConfig();
  mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(c.stateDir, 'state.sqlite'));
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  db.exec(`CREATE TABLE pairing(hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE operations(id TEXT PRIMARY KEY,device_id TEXT NOT NULL,thread_id TEXT NOT NULL,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,turn_id TEXT,error TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);`);
  db.prepare('INSERT INTO pairing VALUES (?,?)').run(hash('existing-code'), Date.now() + 300000);
  db.prepare('INSERT INTO devices VALUES (?,?,?,?,?,0)').run(
    'existing-device',
    'phone',
    hash('existing-token'),
    Date.now(),
    Date.now() + 300000,
  );
  db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    'existing-op',
    'existing-device',
    THREAD,
    'send',
    hash(JSON.stringify([THREAD, 'send', 'hello'])),
    'dispatching',
    null,
    null,
    1,
    1,
  );
  db.close();
  let s = new Store(c.stateDir, temporaryRuntime);
  callbacks.push(() => {
    s.close();
    rmSync(c.desktopRoot, { recursive: true, force: true });
  });
  expect(s.authenticate('existing-token')?.id).toBe('existing-device');
  expect(s.pair('existing-code', 'second phone')).not.toBeNull();
  expect(s.beginOperation('existing-op', 'existing-device', THREAD, 'send', 'hello').fresh).toBe(false);
  expect(s.operation('existing-op')?.backendId).toBe('codex-local');
  expect(s.operation('existing-op', undefined, 'dsh-one')).toBeNull();
  expect(
    s.beginOperation('existing-op', 'existing-device', THREAD, 'send', 'different', 'dsh-one').fresh,
  ).toBe(true);
  s.recover();
  s.close();
  s = new Store(c.stateDir, temporaryRuntime);
  expect(s.operation('existing-op')?.state).toBe('uncertain');
  expect(s.authenticate('existing-token')?.id).toBe('existing-device');
});
