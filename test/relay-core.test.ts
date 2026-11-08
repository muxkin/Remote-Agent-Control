import { expect, it } from 'vitest';
import { createIdentity } from '../src/shared/secure-channel.js';
import { RelayCore, type RelaySession } from '../src/server/relay-core.js';

it('reserves device capacity after concurrent account grants complete and never resurrects closed joins', async () => {
  const hostId = (await createIdentity()).peerId,
    peerId = (await createIdentity()).peerId,
    ticket = 'pending_resource_grants'.padEnd(32, 'x');
  type Socket = { state: RelaySession; messages: string[]; code?: number };
  const sockets: Socket[] = [],
    grants: (() => void)[] = [];
  const core = new RelayCore<Socket>(
    {
      sockets: () => sockets,
      data: (s) => s.state,
      save: (s, v) => {
        s.state = v;
      },
      isOpen: (s) => !s.code,
      send: (s, value) => {
        s.messages.push(String(value));
        return true;
      },
      close: (s, code) => {
        s.code = code;
      },
    },
    {
      hasHost: () => true,
      enrollHost: () => {},
      route: () => ({ ticket, expires: Date.now() + 60000, peerId }),
      replaceRoutes: () => {},
      clearRoutes: () => {},
    },
    'unused-fixture-enrollment-secret',
    {
      redeemRelay: () =>
        new Promise((resolve) => grants.push(() => resolve({ ownerId: 'owner', sessionHash: 'session' }))),
      consumeRelay: async () => ({ ok: true }),
    },
  );
  const socket = () => {
    const s = { state: core.createSession('test-ip'), messages: [] };
    sockets.push(s);
    return s as Socket;
  };
  const control = socket(),
    bulk = socket();
  Object.assign(control.state, { kind: 'host', hostId, lane: 'control' });
  Object.assign(bulk.state, { kind: 'host', hostId, lane: 'bulk' });
  const clients = Array.from({ length: 10 }, socket);
  const work = clients.map((s, i) =>
    core.message(
      s,
      JSON.stringify({
        type: 'join',
        hostId,
        lane: i % 2 ? 'bulk' : 'control',
        ticket,
        resourceToken: 'grant',
      }),
    ),
  );
  await expect.poll(() => grants.length).toBe(10);
  core.close(clients[9], 1000, 'Disconnected during policy lookup');
  for (const resolve of grants) resolve();
  await Promise.all(work);
  expect(clients.filter((s) => s.state.kind === 'client' && !s.state.closed)).toHaveLength(8);
  expect(clients.filter((s) => s.code === 1008)).toHaveLength(1);
  expect(clients[9].state.kind).toBe('pending');
  expect(control.messages.length + bulk.messages.length).toBe(8);
});
