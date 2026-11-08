import { relayContract } from '../contracts/relay.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import sharp from 'sharp';
import { AccountClient } from '../../src/client/account.js';
import { EncryptedMessagingClient } from '../../src/client/encrypted-messaging.js';
import { createIdentity, identityKey, base64, type Identity } from '../../src/shared/secure-channel.js';
import { hostProof, relayFrame, type RelayRoute } from '../../src/shared/relay-protocol.js';
import { nodeSession } from '../../src/client/node-session.js';
import { HostService } from '../../src/server/host-service.js';
import { Store } from '../../src/server/store.js';
import { BackendRegistry } from '../../src/server/backends/registry.js';
import { CodexBackend } from '../../packages/adapter-codex/src/backend.js';
import { DesktopAdapter } from '../../packages/adapter-codex/src/desktop.js';
import { HistoryIndex } from '../../packages/adapter-codex/src/history.js';
import { fixtureConfig, historyFixture, FakeTransport, THREAD } from '../helpers.js';
import { temporaryRuntime } from '../temporary-runtime.js';
import { apiCall } from '../../src/shared/rpc.js';

let mf: Miniflare, origin: string;
const enrollment = 'isolated-cloudflare-test-enrollment-32';
const sockets: WebSocket[] = [];
beforeAll(async () => {
  mkdirSync('.implementation/cloudflare-test/assets', { recursive: true });
  writeFileSync('.implementation/cloudflare-test/assets/index.html', '<html>isolated test</html>');
  execFileSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'deploy',
      '--dry-run',
      '--outdir',
      '.implementation/cloudflare-test',
      '--assets',
      '.implementation/cloudflare-test/assets',
    ],
    { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe' },
  );
  const portServer = createServer().listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  origin = `http://127.0.0.1:${port}`;
  mf = new Miniflare({
    ...convertV4MiniflareOptions({
      name: 'pocket-test',
      modules: true,
      scriptPath: '.implementation/cloudflare-test/index.js',
      compatibilityDate: '2026-11-04',
      compatibilityFlags: ['nodejs_compat'],
      host: '127.0.0.1',
      port,
      bindings: { POCKET_PUBLIC_ORIGIN: origin, POCKET_RELAY_ENROLLMENT: enrollment },
      durableObjects: {
        RELAY: { className: 'RelayHub', useSQLite: true },
        MESSAGING: { className: 'MessagingHub', useSQLite: true },
      },
      r2Buckets: ['IM_MEDIA'],
      images: { binding: 'IMAGES' },
      serviceBindings: {
        ASSETS: async (request) =>
          new Response('<html>test application</html>', {
            headers: {
              'Content-Type':
                new URL(request.url).pathname === '/assets/test.js' ? 'text/javascript' : 'text/html',
            },
          }),
      },
    }),
    unsafeInspectDurableObjects: true,
  });
  await mf.ready;
});
afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await mf?.dispose();
});

function session() {
  let cookie = '';
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(`${origin}/api/im${path}`, {
      method,
      headers: { Origin: origin, Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = response.headers.get('Set-Cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const value = (await response.json()) as any;
    if (!response.ok) throw Object.assign(Error(value.error), { status: response.status });
    return value as T;
  };
  const account = new AccountClient(request);
  return {
    account,
    request,
    client() {
      const client = new EncryptedMessagingClient(origin, cookie.split('=')[1]);
      client.account.activate(account.user!, account.secrets!, account.vault, account.revision);
      return client;
    },
    cookie: () => cookie,
  };
}
function connect(auth: (challenge: string) => object | Promise<object>) {
  const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/connect`, { headers: { Origin: origin } });
  sockets.push(ws);
  return new Promise<WebSocket>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('close', (code) => reject(Error(`Closed ${code}`)));
    ws.on('message', (raw, binary) => {
      if (binary) return;
      const value = JSON.parse(raw.toString());
      if (value.type === 'challenge')
        void Promise.resolve(auth(value.challenge))
          .then((message) => ws.send(JSON.stringify(message)))
          .catch(reject);
      if (value.type === 'registered' || value.type === 'joined') resolve(ws);
    });
  });
}
async function host(identity: Identity, lane: 'control' | 'bulk' = 'control', secret = enrollment) {
  return connect(async (challenge) => ({
    type: 'host',
    hostId: identity.peerId,
    lane,
    signature: base64(await identityKey(identity).sign(hostProof(challenge, identity.peerId, lane))),
    enrollment: secret,
  }));
}

it('serves the same health, API isolation and static cache/security headers', async () => {
  const health = await fetch(`${origin}/health`);
  expect(await health.json()).toEqual({ ok: true, protocol: 2 });
  expect(health.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  expect((await fetch(`${origin}/version.json`)).headers.get('Cache-Control')).toBe('no-cache');
  expect((await fetch(`${origin}/assets/test.js`)).headers.get('Cache-Control')).toContain('immutable');
  expect((await fetch(`${origin}/assets/missing.js`)).headers.get('Cache-Control')).toBe('no-cache');
  expect((await fetch(`${origin}/api/not-found`)).status).toBe(404);
  expect((await fetch(`${origin}/api/im/me`, { headers: { Origin: 'https://evil.test' } })).status).toBe(403);
  expect(
    (
      await fetch(`${origin}/api/im/crypto/parameters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'x'.repeat(5000) }),
      })
    ).status,
  ).toBe(413);
  expect(
    (
      await fetch(`${origin}/api/im/crypto/parameters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
    ).status,
  ).toBe(400);
});

it('uses the existing account, encrypted messaging, recovery and R2 attachment protocols', async () => {
  const a = session(),
    b = session(),
    outsider = session();
  await a.account.register('alice', 'Alice', 'strong-password-alice');
  await b.account.register('bob', 'Bob', 'strong-password-bob');
  await outsider.account.register('eve', 'Eve', 'strong-password-eve');
  await a.account.writeItem('host:fixture', { private: 'pairing-secret-marker' });
  const alice = a.client(),
    bob = b.client();
  const csrf = await fetch(`${origin}/api/im/me`, {
    method: 'PATCH',
    headers: { Cookie: a.cookie(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'forbidden' }),
  });
  expect(csrf.status).toBe(403);
  await alice.addContact(b.account.user!.id);
  const { conversation } = await alice.direct(b.account.user!.id),
    cid = conversation.id;
  const sent = await alice.send(cid, 'encrypted-test-marker', 'stable-message');
  expect((await alice.send(cid, 'encrypted-test-marker', 'stable-message')).message.id).toBe(sent.message.id);
  expect((await bob.history(cid)).messages[0].text).toBe('encrypted-test-marker');
  const { cursor } = await bob.sync(0, 0);
  const pending = bob.sync(cursor, 5000);
  await alice.send(cid, 'wake-long-poll', 'long-poll-message');
  expect((await pending).events.some((event) => event.type === 'message')).toBe(true);
  // Larger than a DO SQL row: ciphertext must go straight to R2, without transient BLOB storage.
  const data = new Uint8Array(9 * 1024 * 1024).fill(97);
  const uploaded = await alice.upload(cid, 'private-large.txt', new Blob([data]));
  await alice.send(cid, '', 'attachment-message', { attachmentIds: [uploaded.file.id] });
  const file = (await bob.history(cid)).messages.at(-1)!.attachments[0];
  const downloaded = await bob.download(file.url);
  expect(createHash('sha256').update(new Uint8Array(downloaded.data)).digest('hex')).toBe(
    createHash('sha256').update(data).digest('hex'),
  );
  const denied = await fetch(new URL(file.url, origin), { headers: { Cookie: outsider.cookie() } });
  expect(denied.status).toBe(404);
  const storage = await mf.unsafeGetDurableObjectStorage('pocket-test', 'MessagingHub', {
    name: 'accounts-v1',
  });
  const rows = await storage.exec('SELECT text FROM im_messages');
  expect(JSON.stringify(rows)).not.toContain('encrypted-test-marker');
  expect((await storage.exec('SELECT length(data) AS n FROM im_files'))[0].n).toBe(0);
  expect((await (await mf.getR2Bucket('IM_MEDIA')).list()).objects).toHaveLength(1);
  await mf.unsafeEvictDurableObject('pocket-test', 'MessagingHub', { name: 'accounts-v1' });
  const fresh = session();
  await fresh.account.login('alice', 'strong-password-alice');
  expect(await fresh.account.readItem('host:fixture')).toEqual({ private: 'pairing-secret-marker' });
  expect((await fresh.client().history(cid)).messages[0].text).toBe('encrypted-test-marker');
  const recovered = session();
  await recovered.account.login('alice', a.account.recoveryCode, true);
  expect(recovered.account.secrets!.root).toBe(a.account.secrets!.root);
  // No HTTP request wakes the message hub: a persisted alarm must expire this card.
  const card = await fresh.client().send(cid, '', 'expiry-card', {
    interaction: {
      kind: 'approval',
      recipientId: b.account.user!.id,
      title: 'Test approval',
      description: 'Fixture',
      expiresAt: Date.now() + 2000,
    },
  });
  await mf.unsafeEvictDurableObject('pocket-test', 'MessagingHub', { name: 'accounts-v1' });
  await expect
    .poll(
      async () =>
        (await storage.exec('SELECT status FROM im_message_features WHERE message_id=?', card.message.id))[0]
          .status,
      { timeout: 10000 },
    )
    .toBe('expired');
});

it('processes avatars through the Images binding with authenticated download', async () => {
  const a = session();
  await a.account.register('avataruser', 'Avatar', 'strong-avatar-password');
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#aa77cc' } })
    .png()
    .toBuffer();
  const result = await fetch(`${origin}/api/im/me/avatar`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: a.cookie(), 'Content-Type': 'application/octet-stream' },
    body: png,
  });
  expect(result.status, await result.clone().text()).toBe(200);
  const { user } = (await result.json()) as any;
  const image = await fetch(new URL(user.avatarUrl, origin), { headers: { Cookie: a.cookie() } });
  expect(image.status).toBe(200);
  expect(await sharp(Buffer.from(await image.arrayBuffer())).metadata()).toMatchObject({
    format: 'webp',
    width: 256,
    height: 256,
  });
});

it('retains v2 host authentication, routes and both lanes through hibernation', async () => {
  const identity = await createIdentity(),
    ticket = 'a'.repeat(32);
  const control = await host(identity),
    bulk = await host(identity, 'bulk');
  const routes: RelayRoute[] = [{ ticket, expires: Date.now() + 60000 }];
  control.send(JSON.stringify({ type: 'routes', routes }));
  const joined = once(control, 'message');
  const client = await connect(() => ({ type: 'join', hostId: identity.peerId, lane: 'control', ticket }));
  const [join] = await joined,
    id = JSON.parse(join.toString()).id;
  let received = once(control, 'message');
  client.send(Buffer.from('opaque-ciphertext'));
  expect((await received)[0].subarray(36).toString()).toBe('opaque-ciphertext');
  await mf.unsafeEvictDurableObject('pocket-test', 'RelayHub', { name: 'relay-v2', webSockets: 'hibernate' });
  received = once(client, 'message');
  control.send(relayFrame(id, Buffer.from('after-hibernation')));
  expect((await received)[0].toString()).toBe('after-hibernation');
  const bulkJoin = once(bulk, 'message');
  const bulkClient = await connect(() => ({ type: 'join', hostId: identity.peerId, lane: 'bulk', ticket }));
  const bulkId = JSON.parse((await bulkJoin)[0].toString()).id;
  received = once(bulkClient, 'message');
  bulk.send(relayFrame(bulkId, Buffer.alloc(65536, 3)));
  expect((await received)[0].length).toBe(65536);
  await expect(host(await createIdentity(), 'control', 'wrong-secret')).rejects.toThrow('1008');
  // Registered identities reconnect without re-enrollment, exactly as on the VPS.
  const replacement = await host(identity, 'control', '');
  replacement.close();
  bulk.close();
  client.close();
  bulkClient.close();
});

it('pairs the unchanged Gateway and client, resumes encrypted RPC, and keeps bulk separate', async () => {
  const config = fixtureConfig();
  historyFixture(config);
  config.origin = origin;
  config.p2p = { enabled: false, stunUrls: [] };
  config.relay = { origin, enrollment };
  const store = new Store(config.stateDir, temporaryRuntime),
    transport = new FakeTransport();
  const registry = new BackendRegistry().register(
    new CodexBackend(config, new DesktopAdapter(config, () => transport), new HistoryIndex(config.codexHome)),
  );
  const identity = await createIdentity(),
    phone = await createIdentity(),
    sessionId = crypto.randomUUID();
  const gateway = new HostService(config, identity, { store, registry });
  const pairing = store.mintPairing();
  const links: Awaited<ReturnType<typeof nodeSession>>[] = [];
  try {
    await registry.start();
    gateway.start();
    const link = await nodeSession(
      origin,
      identity.peerId,
      phone,
      createHash('sha256').update(pairing.code).digest('hex'),
      { type: 'pair', protocol: 2, sessionId, code: pairing.code, name: 'CF fixture' },
    );
    links.push(link);
    const ready = await link.ready;
    expect((await link.rpc<{ total: number }>(apiCall('/projects'))).total).toBe(1);
    const bulk = await nodeSession(
      origin,
      identity.peerId,
      phone,
      ready.ticket,
      { type: 'authenticate', protocol: 2, sessionId },
      'bulk',
    );
    links.push(bulk);
    const requestId = crypto.randomUUID(),
      call = apiCall(`/threads/${THREAD}/messages`, 'POST', { requestId, text: 'cf-single-delivery' });
    await link.rpc(call);
    await expect.poll(() => store.operation(requestId)?.state).toBe('accepted');
    const count = transport.calls.length;
    await mf.unsafeEvictDurableObject('pocket-test', 'RelayHub', {
      name: 'relay-v2',
      webSockets: 'hibernate',
    });
    await link.rpc(call);
    expect(transport.calls).toHaveLength(count);
    expect((await bulk.request('ping')).value).toEqual({ ok: true });
    link.close();
    const resumed = await nodeSession(origin, identity.peerId, phone, ready.ticket, {
      type: 'authenticate',
      protocol: 2,
      sessionId,
    });
    links.push(resumed);
    expect(await resumed.rpc(apiCall(`/operations/${requestId}`))).toMatchObject({ state: 'accepted' });
  } finally {
    for (const link of links) link.close();
    gateway.stop();
    registry.stop();
    store.close();
    rmSync(config.desktopRoot, { recursive: true, force: true });
  }
});

it('preserves device quotas across rotated tickets, both lanes, and hibernation', async () => {
  const identity = await createIdentity(),
    peerId = (await createIdentity()).peerId;
  const control = await host(identity),
    bulk = await host(identity, 'bulk');
  const routes = ['q', 'r'].map((v) => ({ ticket: v.repeat(32), peerId, expires: Date.now() + 60000 }));
  control.send(JSON.stringify({ type: 'routes', routes }));
  const clients: WebSocket[] = [];
  for (let i = 0; i < 8; i++)
    clients.push(
      await connect(() => ({
        type: 'join',
        hostId: identity.peerId,
        lane: i % 2 ? 'bulk' : 'control',
        ticket: routes[i % 2].ticket,
      })),
    );
  await mf.unsafeEvictDurableObject('pocket-test', 'RelayHub', { name: 'relay-v2', webSockets: 'hibernate' });
  await expect(
    connect(() => ({ type: 'join', hostId: identity.peerId, lane: 'bulk', ticket: routes[1].ticket })),
  ).rejects.toThrow('1008');
  const closed = once(clients[0], 'close');
  clients[0].close();
  await closed;
  clients.push(
    await connect(() => ({
      type: 'join',
      hostId: identity.peerId,
      lane: 'control',
      ticket: routes[0].ticket,
    })),
  );
  for (const client of clients) client.close();
  control.close();
  bulk.close();
});

it('keeps exact string UIDs and rolls back multi-table registration failures in DO SQLite', async () => {
  const storage = await mf.unsafeGetDurableObjectStorage('pocket-test', 'MessagingHub', {
    name: 'accounts-v1',
  });
  await storage.exec("UPDATE im_uid_allocator SET last_uid='9007199254740992' WHERE name='user'");
  const count = (await storage.exec('SELECT count(*) AS n FROM im_users'))[0].n;
  await storage.exec(
    "CREATE TRIGGER fixture_fail_vault BEFORE INSERT ON im_account_crypto BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END",
  );
  try {
    await expect(
      session().account.register('rollbackuser', 'Rollback', 'strong-rollback-password'),
    ).rejects.toMatchObject({ status: 500 });
    expect((await storage.exec('SELECT count(*) AS n FROM im_users'))[0].n).toBe(count);
    expect((await storage.exec("SELECT last_uid FROM im_uid_allocator WHERE name='user'"))[0].last_uid).toBe(
      '9007199254740992',
    );
  } finally {
    await storage.exec('DROP TRIGGER fixture_fail_vault');
  }
  const a = session();
  await a.account.register('largeuiduser', 'Large UID', 'strong-uid-password');
  expect(a.account.user!.id).toBe('9007199254740993');
});

relayContract(async () => ({ connect, enrollment }));
