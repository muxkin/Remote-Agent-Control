import { expect, it } from 'vitest';
import { once } from 'node:events';
import type WebSocket from 'ws';
import { createIdentity, identityKey, base64, type Identity } from '../../src/shared/secure-channel.js';
import { hostProof, readRelayFrame, relayFrame } from '../../src/shared/relay-protocol.js';

type Connect = (authenticate: (challenge: string) => object | Promise<object>) => Promise<WebSocket>;
/** The exact same wire-level assertions run against Node ws and Cloudflare workerd. */
export function relayContract(setup: () => Promise<{ connect: Connect; enrollment: string }>) {
  it('shares route removal, channel isolation and host replacement behavior across deployments', async () => {
    const { connect, enrollment } = await setup(),
      sockets: WebSocket[] = [];
    const open = async (auth: Parameters<Connect>[0]) => {
      const ws = await connect(auth);
      sockets.push(ws);
      return ws;
    };
    const host = async (identity: Identity, lane: 'control' | 'bulk', secret = enrollment) =>
      open(async (challenge) => ({
        type: 'host',
        hostId: identity.peerId,
        lane,
        enrollment: secret,
        signature: base64(await identityKey(identity).sign(hostProof(challenge, identity.peerId, lane))),
      }));
    const identity = await createIdentity(),
      other = await createIdentity(),
      ticket = 'contract_route'.padEnd(32, 'x');
    try {
      const control = await host(identity, 'control'),
        bulk = await host(identity, 'bulk'),
        foreign = await host(other, 'control');
      control.send(JSON.stringify({ type: 'routes', routes: [{ ticket, expires: Date.now() + 60000 }] }));
      const joined = once(control, 'message');
      const client = await open(() => ({ type: 'join', hostId: identity.peerId, lane: 'control', ticket }));
      const id = JSON.parse((await joined)[0].toString()).id;
      const received: string[] = [];
      client.on('message', (raw) => received.push(raw.toString()));
      // Knowing a stream UUID grants neither another host nor the bulk lane access.
      foreign.send(relayFrame(id, new TextEncoder().encode('foreign')));
      bulk.send(relayFrame(id, new TextEncoder().encode('wrong-lane')));
      control.send(JSON.stringify({ type: 'routes', routes: [] }));
      control.send(relayFrame(id, new TextEncoder().encode('existing-channel')));
      await expect.poll(() => received).toEqual(['existing-channel']);
      const upstream = once(control, 'message');
      client.send(Buffer.from('client-data'));
      expect(new TextDecoder().decode(readRelayFrame(new Uint8Array((await upstream)[0])).bytes)).toBe(
        'client-data',
      );
      await expect(
        connect(() => ({ type: 'join', hostId: identity.peerId, lane: 'control', ticket })),
      ).rejects.toThrow('1008');
      const displaced = once(control, 'close');
      const replacement = await host(identity, 'control', '');
      expect((await displaced)[0]).toBe(1012);
      const downstream = once(client, 'message');
      replacement.send(relayFrame(id, Buffer.from('replacement')));
      expect((await downstream)[0].toString()).toBe('replacement');
      const closed = once(client, 'close');
      replacement.send(JSON.stringify({ type: 'close', id }));
      expect((await closed)[0]).toBe(1000);
      expect(bulk.readyState).toBe(1);
    } finally {
      for (const socket of sockets) socket.terminate();
    }
  });
}
