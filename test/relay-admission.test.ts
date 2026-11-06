import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { RelayAdmission, relayClientAddress, relayLimits } from '../src/server/relay-admission.js';

function request(remoteAddress: string, forwarded?: string) {
  return {
    socket: { remoteAddress },
    headers: { 'x-forwarded-for': forwarded },
  } as unknown as IncomingMessage;
}

describe('relay proxy trust', () => {
  it('ignores forwarding headers unless the socket peer is explicitly trusted', () => {
    expect(relayClientAddress()(request('127.0.0.1', '203.0.113.1'))).toBe('127.0.0.1');
    expect(relayClientAddress(['127.0.0.1'])(request('198.51.100.8', '203.0.113.1'))).toBe('198.51.100.8');
  });
  it('stops at the nearest untrusted hop, ignoring a spoofed prefix', () => {
    const resolve = relayClientAddress(['127.0.0.1', '10.1.0.0/16']);
    expect(resolve(request('127.0.0.1', '203.0.113.1, 198.51.100.8, 10.1.2.3'))).toBe('198.51.100.8');
    expect(resolve(request('127.0.0.1'))).toBe('127.0.0.1');
  });
  it('normalizes IPv6 and mapped IPv4 addresses into the same quota keys', () => {
    const resolve = relayClientAddress(['127.0.0.1']);
    expect(resolve(request('::ffff:127.0.0.1', '::ffff:c633:6408'))).toBe('198.51.100.8');
    expect(resolve(request('127.0.0.1', '2001:0db8:0:0:0:0:0:1'))).toBe('2001:db8::1');
  });
  it('rejects malformed selected addresses and invalid trust configuration', () => {
    expect(() => relayClientAddress(['any'])).toThrow();
    expect(() => relayClientAddress(['127.0.0.1'])(request('127.0.0.1', 'unknown'))).toThrow();
  });
});

describe('relay admission budgets', () => {
  it('releases the IP handshake slot after authentication, retaining the global socket limit', () => {
    const gate = new RelayAdmission({ ...relayLimits, connections: 3, pendingPerIp: 1 });
    const a = gate.acquire('a')!;
    expect(gate.acquire('a')).toBeUndefined();
    a.authenticated();
    const b = gate.acquire('a')!;
    b.authenticated();
    const c = gate.acquire('a')!;
    c.authenticated();
    expect(gate.acquire('b')).toBeUndefined();
    a.release();
    a.release();
    expect(gate.acquire('b')).toBeDefined();
    expect(gate.snapshot()).toMatchObject({ connections: 3, pending: 1 });
  });
  it('reserves global and per-IP pending capacity before WebSocket upgrade', () => {
    const gate = new RelayAdmission({ ...relayLimits, pending: 2, pendingPerIp: 1 });
    const a = gate.acquire('a')!;
    expect(gate.acquire('a')).toBeUndefined();
    expect(gate.acquire('b')).toBeDefined();
    expect(gate.acquire('c')).toBeUndefined();
    a.release();
    expect(a.authenticated()).toBe(false);
    expect(gate.acquire('c')).toBeDefined();
  });
  it('limits connection rate even when every connection authenticates successfully', () => {
    let now = 0;
    const gate = new RelayAdmission({ ...relayLimits, attemptsPerMinute: 2 }, () => now);
    for (let i = 0; i < 2; i++) {
      const lease = gate.acquire('a')!;
      lease.authenticated();
      lease.release();
    }
    expect(gate.acquire('a')).toBeUndefined();
    expect(gate.acquire('b')).toBeDefined();
    now = 60_000;
    expect(gate.acquire('a')).toBeDefined();
  });
  it('counts each failed handshake once, separately from the connection rate', () => {
    let now = 0;
    const gate = new RelayAdmission({ ...relayLimits, failuresPerMinute: 2 }, () => now);
    const first = gate.acquire('a')!;
    first.failed();
    first.failed();
    first.release();
    const second = gate.acquire('a')!;
    second.failed();
    expect(second.authenticated()).toBe(false);
    second.release();
    expect(gate.acquire('a')).toBeUndefined();
    expect(gate.acquire('b')).toBeDefined();
    now = 60_000;
    expect(gate.acquire('a')).toBeDefined();
  });
  it('bounds source bookkeeping and reclaims expired entries without losing pending counts', () => {
    let now = 0;
    const gate = new RelayAdmission({ ...relayLimits, trackedIps: 2 }, () => now);
    const a = gate.acquire('a')!;
    gate.acquire('b')!.release();
    expect(gate.acquire('c')).toBeUndefined();
    now = 60_000;
    expect(gate.acquire('c')).toBeDefined();
    expect(gate.snapshot()).toEqual({ connections: 2, pending: 2, trackedIps: 2 });
    a.release();
    expect(gate.snapshot().pending).toBe(1);
  });
});
