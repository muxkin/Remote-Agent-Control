import { expect, it } from 'vitest';
import { once } from 'node:events';
import type WebSocket from 'ws';
import type { AccountClient } from '../../src/client/account.js';
import { desktopAuthorizationProof } from '../../src/shared/desktop-authorization.js';
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

export function desktopAuthorizationContract(
  setup: () => Promise<{
    connect: Connect;
    enrollment: string;
    origin: string;
    session: () => { account: AccountClient; request: AccountClient['request'] };
  }>,
) {
  it('binds signed desktop enrollment to one account and revokes both lanes and future registration', async () => {
    const { connect, enrollment, origin, session } = await setup();
    const owner = session();
    const other = session();
    const anonymous = session();
    const identity = await createIdentity();
    const hostId = identity.peerId;
    const ticket = 'a'.repeat(64);
    const key = identityKey(identity);
    const signed = async (issuedAt: number, authority = origin) => {
      const intent = { hostId, name: 'Fixture computer', issuedAt, ticket };
      return { ...intent, signature: base64(await key.sign(desktopAuthorizationProof(authority, intent))) };
    };
    const host = (lane: 'control' | 'bulk', enrollment = '') =>
      connect(async (challenge) => ({
        type: 'host',
        hostId,
        lane,
        enrollment,
        signature: base64(await key.sign(hostProof(challenge, hostId, lane))),
      }));
    const { user } = await owner.account.register('desktopowner', 'Owner', 'desktop-owner-password');
    const stranger = (await other.account.register('desktopstranger', 'Other', 'desktop-other-password'))
      .user;
    const authorization = await signed(Date.now());
    const approve = '/desktop-devices/approve';
    const data = { accountId: user.id, authorization };
    await expect(anonymous.request(approve, 'POST', data)).rejects.toMatchObject({ status: 401 });
    await expect(other.request(approve, 'POST', data)).rejects.toMatchObject({ status: 403 });
    await expect(
      owner.request(approve, 'POST', {
        ...data,
        authorization: await signed(Date.now() - 6 * 60_000),
      }),
    ).rejects.toMatchObject({ status: 410 });
    await expect(
      owner.request(approve, 'POST', {
        ...data,
        authorization: await signed(Date.now(), 'https://foreign.example'),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(host('control')).rejects.toThrow('1008');
    await expect(owner.request(approve, 'POST', data)).resolves.toEqual({ ok: true });
    await expect(owner.request(approve, 'POST', data)).resolves.toEqual({ ok: true });
    await expect(other.request(approve, 'POST', { ...data, accountId: stranger.id })).rejects.toMatchObject({
      status: 409,
    });
    await expect(owner.request('/desktop-devices')).resolves.toEqual({
      devices: [{ hostId, name: authorization.name }],
    });
    await expect(other.request('/desktop-devices')).resolves.toEqual({ devices: [] });
    const control = await host('control'),
      bulk = await host('bulk');
    control.send(JSON.stringify({ type: 'routes', routes: [{ ticket, expires: Date.now() + 60_000 }] }));
    await expect
      .poll(() =>
        owner.request('/desktop-devices/ready', 'POST', {
          accountId: user.id,
          hostId,
          ticket,
        }),
      )
      .toEqual({ ready: true });
    await expect(
      other.request('/desktop-devices/ready', 'POST', {
        accountId: stranger.id,
        hostId,
        ticket,
      }),
    ).resolves.toEqual({ ready: false });
    const path = `/desktop-devices/${hostId}`;
    await expect(other.request(path, 'DELETE', { accountId: stranger.id })).rejects.toMatchObject({
      status: 404,
    });
    const closed = [once(control, 'close'), once(bulk, 'close')];
    await expect(owner.request(path, 'DELETE', { accountId: user.id })).resolves.toEqual({ ok: true });
    for (const signal of closed) {
      const [code, reason] = await signal;
      expect(code).toBe(1008);
      expect(reason.toString()).toBe('Desktop authorization revoked');
    }
    await expect(host('control', enrollment)).rejects.toThrow('1008');
    await expect(owner.request(approve, 'POST', data)).rejects.toMatchObject({ status: 410 });
    await expect(owner.request('/desktop-devices')).resolves.toEqual({ devices: [] });
  });
}
