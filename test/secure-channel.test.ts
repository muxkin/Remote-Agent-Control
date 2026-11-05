import { describe, it, expect } from 'vitest';
import { CipherWire, SecureChannel, createIdentity } from '../src/shared/secure-channel.js';

describe('authenticated device encryption', () => {
  it('pins the host identity and carries fragmented binary packets without exposing plaintext', async () => {
    const [phone, host] = await Promise.all([createIdentity(), createIdentity()]);
    const observed: Uint8Array[] = [];
    let a: CipherWire, b: CipherWire;
    a = new CipherWire(
      async (bytes) => {
        observed.push(bytes);
        b.onData(bytes);
      },
      () => b.onTransportClosed(),
    );
    b = new CipherWire(
      async (bytes) => {
        observed.push(bytes);
        a.onData(bytes);
      },
      () => a.onTransportClosed(),
    );
    const [client, server] = await Promise.all([
      SecureChannel.open(a, phone, true, 'control', host.peerId),
      SecureChannel.open(b, host, false, 'control'),
    ]);
    expect(server.remotePeer).toBe(phone.peerId);
    const content = crypto.getRandomValues(new Uint8Array(60000));
    const received = new Promise<any>((resolve) => server.onPacket(resolve));
    await client.send({ type: 'request', text: 'private-chat-marker-keep-out-of-relay' }, content);
    const packet = await received;
    expect(packet.message.text).toBe('private-chat-marker-keep-out-of-relay');
    expect(packet.bytes).toEqual(content);
    expect(observed.map((x) => new TextDecoder().decode(x)).join('')).not.toContain(packet.message.text);
    client.close();
    server.close();
  });
  it('rejects a relay replacing the pinned desktop identity', async () => {
    const [phone, intended, attacker] = await Promise.all([
      createIdentity(),
      createIdentity(),
      createIdentity(),
    ]);
    let a: CipherWire, b: CipherWire;
    a = new CipherWire(
      async (bytes) => b.onData(bytes),
      () => b.onTransportClosed(),
    );
    b = new CipherWire(
      async (bytes) => a.onData(bytes),
      () => a.onTransportClosed(),
    );
    const results = await Promise.allSettled([
      SecureChannel.open(a, phone, true, 'control', intended.peerId),
      SecureChannel.open(b, attacker, false, 'control'),
    ]);
    expect(results[0].status).toBe('rejected');
    for (const result of results) if (result.status === 'fulfilled') result.value.close();
  });
  it.each(['tamper', 'replay'])('closes an authenticated connection after ciphertext %s', async (attack) => {
    const [phone, host] = await Promise.all([createIdentity(), createIdentity()]);
    let a: CipherWire,
      b: CipherWire,
      attacking = false;
    a = new CipherWire(
      async (bytes) => {
        const frame = bytes.slice();
        if (attacking && attack === 'tamper') frame[frame.length - 1] ^= 1;
        b.onData(frame);
        if (attacking && attack === 'replay') b.onData(frame.slice());
      },
      () => b.onTransportClosed(),
    );
    b = new CipherWire(
      async (bytes) => a.onData(bytes),
      () => a.onTransportClosed(),
    );
    const [client, server] = await Promise.all([
      SecureChannel.open(a, phone, true, 'control', host.peerId),
      SecureChannel.open(b, host, false, 'control', phone.peerId),
    ]);
    let received = 0,
      closed = false;
    server.onPacket(() => received++);
    server.onClose(() => {
      closed = true;
    });
    attacking = true;
    await client.send({ marker: 'private-body' }).catch(() => {});
    await expect.poll(() => closed).toBe(true);
    expect(received).toBeLessThanOrEqual(attack === 'replay' ? 1 : 0);
    client.close();
    server.close();
  });
});
