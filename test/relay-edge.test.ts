import { AccountClient } from '../src/client/account.js';
import { desktopAuthorizationContract, relayContract } from './contracts/relay.js';
import { afterEach, expect, it } from 'vitest';
import { request } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { buildRelay } from '../src/server/relay.js';
import { base64, createIdentity, identityKey, type Identity } from '../src/shared/secure-channel.js';
import { hostProof, type RelayRoute } from '../src/shared/relay-protocol.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function setup(trustedProxies: string[] = ['127.0.0.1']) {
  const origin = 'http://relay.test';
  const enrollment = 'relay-security-fixture-secret-32-characters';
  const relay = await buildRelay({
    origin,
    enrollmentSecret: enrollment,
    webRoot: '/nonexistent',
    assetOrigin: null,
    uploadOrigins: [],
    trustedProxies,
  });
  const url = await relay.app.listen({ host: '127.0.0.1', port: 0 });
  const sockets: WebSocket[] = [];
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate();
    await relay.app.close();
  });
  function open(forwarded: string, authenticate?: (challenge: string) => object | Promise<object>) {
    const socket = new WebSocket(url.replace('http:', 'ws:') + '/connect', {
      headers: { Host: 'relay.test', Origin: origin, 'X-Forwarded-For': forwarded },
    });
    sockets.push(socket);
    return new Promise<WebSocket>((resolve, reject) => {
      socket.on('error', reject);
      socket.on('close', (code) => reject(Error(`Closed ${code}`)));
      socket.on('message', (raw, binary) => {
        if (binary) return;
        const value = JSON.parse(raw.toString());
        if (value.type === 'challenge') {
          if (!authenticate) resolve(socket);
          else
            void Promise.resolve(authenticate(value.challenge))
              .then((message) => socket.send(JSON.stringify(message)))
              .catch(reject);
        } else if (value.type === 'registered' || value.type === 'joined') resolve(socket);
      });
    });
  }
  async function host(routes: RelayRoute[], identity?: Identity) {
    identity ??= await createIdentity();
    const hostId = identity.peerId;
    const key = identityKey(identity);
    const socket = await open('198.51.100.1', async (challenge) => ({
      type: 'host',
      hostId,
      lane: 'control',
      enrollment,
      signature: base64(await key.sign(hostProof(challenge, hostId, 'control'))),
    }));
    socket.send(JSON.stringify({ type: 'routes', routes }));
    return { socket, hostId };
  }
  return { relay, url, open, host, enrollment };
}

it('keeps more than 64 authenticated sockets behind one proxy/NAT, with per-device quotas', async () => {
  const { relay, open, host } = await setup();
  const routes = await Promise.all(
    Array.from({ length: 10 }, async (_, i) => ({
      ticket: String(i).padStart(32, 't'),
      expires: Date.now() + 60_000,
      peerId: (await createIdentity()).peerId,
    })),
  );
  const { hostId } = await host(routes);
  for (const route of routes)
    for (let i = 0; i < 8; i++)
      await open('198.51.100.1', () => ({ type: 'join', hostId, lane: 'control', ticket: route.ticket }));
  expect(relay.connections()).toMatchObject({ connections: 81, pending: 0 });
  await expect(
    open('198.51.100.2', () => ({ type: 'join', hostId, lane: 'control', ticket: routes[0].ticket })),
  ).rejects.toThrow('1008');
}, 15_000);

it('shares the device quota across ticket rotation, but scopes it to the owning host', async () => {
  const { open, host } = await setup();
  const peerId = (await createIdentity()).peerId;
  const routes = ['a', 'b'].map((v) => ({ ticket: v.repeat(32), peerId, expires: Date.now() + 60_000 }));
  const a = await host(routes),
    b = await host(routes);
  for (let i = 0; i < 8; i++)
    await open('198.51.100.1', () => ({
      type: 'join',
      hostId: a.hostId,
      lane: 'control',
      ticket: routes[i % 2].ticket,
    }));
  await expect(
    open('198.51.100.2', () => ({
      type: 'join',
      hostId: a.hostId,
      lane: 'control',
      ticket: routes[1].ticket,
    })),
  ).rejects.toThrow('1008');
  await expect(
    open('198.51.100.1', () => ({
      type: 'join',
      hostId: b.hostId,
      lane: 'control',
      ticket: routes[0].ticket,
    })),
  ).resolves.toBeInstanceOf(WebSocket);
});

it('separates pending clients behind a trusted proxy and ignores a spoofed leftmost address', async () => {
  const { open } = await setup();
  for (let i = 0; i < 64; i++) await open('198.51.100.1');
  await expect(open('203.0.113.99, 198.51.100.1')).rejects.toThrow('429');
  await expect(open('198.51.100.2')).resolves.toBeInstanceOf(WebSocket);
});

it('does not trust forwarding headers in a direct deployment', async () => {
  const { open } = await setup([]);
  for (let i = 0; i < 64; i++) await open(`198.51.100.${i + 1}`);
  await expect(open('203.0.113.99')).rejects.toThrow('429');
});

it('throttles repeated authentication failures without blocking another real source IP', async () => {
  const { open } = await setup();
  for (let i = 0; i < 64; i++)
    await expect(open('198.51.100.1', () => ({ type: 'invalid' }))).rejects.toThrow('1008');
  await expect(open('198.51.100.1')).rejects.toThrow('429');
  await expect(open('198.51.100.2')).resolves.toBeInstanceOf(WebSocket);
});

it('releases admission reservations when the WebSocket upgrade is malformed', async () => {
  const { relay, url } = await setup();
  const req = request(url + '/connect', {
    headers: {
      Host: 'relay.test',
      Origin: 'http://relay.test',
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'invalid',
    },
  });
  req.end();
  const [response] = await once(req, 'response');
  response.resume();
  await once(response, 'end');
  expect(response.statusCode).toBe(400);
  await expect.poll(() => relay.connections().connections).toBe(0);
  expect(relay.connections().pending).toBe(0);
});

it('does not allocate a client after it disconnects during route discovery', async () => {
  const { relay, open, host } = await setup();
  const { socket, hostId } = await host([]);
  const route = {
    ticket: 'r'.repeat(32),
    expires: Date.now() + 60_000,
    peerId: (await createIdentity()).peerId,
  };
  for (let i = 0; i < 8; i++) {
    const client = await open('198.51.100.1');
    client.send(JSON.stringify({ type: 'join', hostId, lane: 'control', ticket: route.ticket }));
    client.close();
    await once(client, 'close');
  }
  socket.send(JSON.stringify({ type: 'routes', routes: [route] }));
  for (let i = 0; i < 8; i++)
    await open('198.51.100.1', () => ({ type: 'join', hostId, lane: 'control', ticket: route.ticket }));
  expect(relay.connections()).toMatchObject({ connections: 9, pending: 0 });
});

relayContract(async () => {
  const instance = await setup();
  return { connect: (auth) => instance.open('198.51.100.1', auth), enrollment: instance.enrollment };
});

desktopAuthorizationContract(async () => {
  const instance = await setup();
  const origin = 'http://relay.test';
  return {
    origin,
    enrollment: instance.enrollment,
    connect: (auth) => instance.open('198.51.100.1', auth),
    session() {
      let cookie = '';
      const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
        const response = await instance.relay.app.inject({
          method: method as 'GET',
          url: `/api/im${path}`,
          headers: { host: 'relay.test', origin, cookie },
          payload: body as object,
        });
        if (response.cookies[0]) cookie = `${response.cookies[0].name}=${response.cookies[0].value}`;
        const data = response.json();
        if (response.statusCode >= 400)
          throw Object.assign(Error(data.error), { status: response.statusCode });
        return data as T;
      };
      return { request, account: new AccountClient(request) };
    },
  };
});
