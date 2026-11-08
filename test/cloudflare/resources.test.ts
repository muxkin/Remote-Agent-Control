import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { AccountClient } from '../../src/client/account.js';
import { EncryptedMessagingClient } from '../../src/client/encrypted-messaging.js';
import { createIdentity, identityKey, base64 } from '../../src/shared/secure-channel.js';
import { hostProof, readRelayFrame, relayFrame } from '../../src/shared/relay-protocol.js';
import type { ResourceFile, ResourceStatus } from '../../src/shared/resources.js';

let mf: Miniflare, origin: string;
const policyRequests: string[] = [];
const sockets: WebSocket[] = [],
  name = 'resource-test',
  enrollment = 'resource-fixture-enrollment-secret-32';
beforeAll(async () => {
  const folder = '.implementation/cloudflare-resource-test';
  mkdirSync(`${folder}/assets`, { recursive: true });
  writeFileSync(`${folder}/assets/index.html`, 'isolated resource test');
  execFileSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'deploy',
      '--dry-run',
      '--outdir',
      folder,
      '--assets',
      `${folder}/assets`,
    ],
    { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe' },
  );
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  origin = `http://127.0.0.1:${port}`;
  mf = new Miniflare({
    ...convertV4MiniflareOptions({
      name,
      modules: true,
      scriptPath: `${folder}/index.js`,
      compatibilityDate: '2026-11-04',
      compatibilityFlags: ['nodejs_compat'],
      host: '127.0.0.1',
      port,
      bindings: {
        POCKET_PUBLIC_ORIGIN: origin,
        POCKET_RELAY_ENROLLMENT: enrollment,
        POCKET_LAGO_URL: 'https://unreachable-billing.invalid',
        POCKET_LAGO_API_KEY: 'isolated-test',
        POCKET_LAGO_DEFAULT_PLAN: 'operator-selected-plan',
        POCKET_RESOURCE_INSTANCE: 'test.example',
      },
      durableObjects: {
        RELAY: { className: 'RelayHub', useSQLite: true },
        MESSAGING: { className: 'MessagingHub', useSQLite: true },
      },
      r2Buckets: ['IM_MEDIA'],
      images: { binding: 'IMAGES' },
      serviceBindings: { ASSETS: async () => new Response('test') },
      outboundService: async (request: Request) => {
        const url = new URL(request.url);
        policyRequests.push(url.pathname);
        if (url.pathname.startsWith('/api/v1/customers/')) return Response.json({ customer: {} });
        if (url.pathname === '/api/v1/subscriptions')
          return Response.json({
            subscriptions: [
              { external_id: url.searchParams.get('external_customer_id'), plan_code: 'backend-plan' },
            ],
          });
        if (url.pathname.startsWith('/api/v1/plans/'))
          return Response.json({ plan: { name: 'Native Worker policy' } });
        if (url.pathname.endsWith('/entitlements'))
          return Response.json({
            entitlements: [
              { code: 'storage', privileges: [{ code: 'max_bytes', value: 100 }] },
              {
                code: 'relay',
                privileges: [
                  { code: 'max_bytes', value: 10 },
                  { code: 'time_zone', value: 'Asia/Shanghai' },
                ],
              },
            ],
          });
        return new Response(null, { status: 404 });
      },
    }),
    unsafeInspectDurableObjects: true,
  });
  await mf.ready;
});
afterAll(async () => {
  for (const socket of sockets) socket.terminate();
  await mf?.dispose();
});

async function user(username: string, storageBytes = 100, cached = true) {
  let cookie = '';
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(`${origin}/api/im${path}`, {
      method,
      headers: { Origin: origin, Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const next = response.headers.get('Set-Cookie');
    if (next) cookie = next.split(';')[0];
    const result = (await response.json()) as any;
    if (!response.ok) throw Object.assign(Error(result.error), { status: response.status });
    return result;
  };
  const account = new AccountClient(request);
  await account.register(username, username, `strong-${username}-password`);
  const db = await mf.unsafeGetDurableObjectStorage(name, 'MessagingHub', { name: 'accounts-v1' });
  if (cached)
    await db.exec(
      'INSERT INTO resource_policies VALUES (?,?,?)',
      account.user!.id,
      JSON.stringify({ label: 'Test policy', storageBytes, relayBytes: 10, timeZone: 'Asia/Shanghai' }),
      Date.now(),
    );
  const client = new EncryptedMessagingClient(origin, cookie.split('=')[1]);
  client.account.activate(account.user!, account.secrets!, account.vault, account.revision);
  return { account, client, request, db };
}

it('loads Lago entitlements using native Worker fetch and escapes domain namespaces', async () => {
  const u = await user('resourcepolicy', 100, false);
  const status = await u.request<ResourceStatus>('/resources');
  expect(status).toMatchObject({
    label: 'Native Worker policy',
    storage: { limit: 100 },
    relay: { limit: 10 },
  });
  expect(policyRequests).toContain(`/api/v1/customers/test%2Eexample%3A${u.account.user!.id}`);
  expect(policyRequests).toContain(
    `/api/v1/subscriptions/test%2Eexample%3A${u.account.user!.id}/entitlements`,
  );
});
function connect(auth: (challenge: string) => object | Promise<object>) {
  const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/connect`, { headers: { Origin: origin } });
  sockets.push(ws);
  return new Promise<WebSocket>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('close', (code) => reject(Error(`Closed ${code}`)));
    ws.on('message', (raw, binary) => {
      if (binary) return;
      const message = JSON.parse(raw.toString());
      if (message.type === 'challenge')
        void Promise.resolve(auth(message.challenge))
          .then((v) => ws.send(JSON.stringify(v)))
          .catch(reject);
      if (message.type === 'registered' || message.type === 'joined') resolve(ws);
    });
  });
}

it('enforces persisted R2 space quotas and frees actual objects without breaking signed message history', async () => {
  const a = await user('resourcealice', 100),
    b = await user('resourcebob');
  await a.client.addContact(b.account.user!.id);
  const cid = (await a.client.direct(b.account.user!.id)).conversation.id;
  const plain = new Uint8Array(84).fill(37); // GCM authentication tag occupies the remaining 16 bytes.
  const file = (await a.client.upload(cid, 'resource.bin', plain)).file;
  const message = (await a.client.send(cid, '保留加密文字', 'resource-message', { attachmentIds: [file.id] }))
    .message;
  await expect(a.client.upload(cid, 'overflow.bin', new Uint8Array(1))).rejects.toThrow('空间不足');
  expect((await a.request<ResourceStatus>('/resources')).storage).toEqual({ used: 100, limit: 100 });
  const inventory = await a.request<{ files: ResourceFile[] }>('/resources/files');
  expect((await a.client.download(inventory.files[0].url)).data).toEqual(plain);
  expect((await (await mf.getR2Bucket('IM_MEDIA')).list()).objects).toHaveLength(1);
  await mf.unsafeEvictDurableObject(name, 'MessagingHub', { name: 'accounts-v1' });
  expect((await a.request<ResourceStatus>('/resources')).storage.used).toBe(100);
  await a.request('/resources/cleanup', 'POST', { files: [{ kind: 'file', id: file.id }] });
  expect((await (await mf.getR2Bucket('IM_MEDIA')).list()).objects).toHaveLength(0);
  const history = await b.client.history(cid);
  expect(history.messages.find((m) => m.id === message.id)).toMatchObject({
    text: '保留加密文字',
    attachments: [{ id: file.id, removed: true }],
  });
  expect((await a.request<ResourceStatus>('/resources')).storage.used).toBe(0);
});

it('requires account-bound relay grants and keeps both-direction traffic limits through hibernation', async () => {
  const u = await user('resourcerelay'),
    identity = await createIdentity(),
    ticket = 'r'.repeat(32);
  const host = await connect(async (challenge) => ({
    type: 'host',
    hostId: identity.peerId,
    lane: 'control',
    enrollment,
    signature: base64(await identityKey(identity).sign(hostProof(challenge, identity.peerId, 'control'))),
  }));
  host.send(JSON.stringify({ type: 'routes', routes: [{ ticket, expires: Date.now() + 60000 }] }));
  const join = { type: 'join', hostId: identity.peerId, lane: 'control', ticket };
  await expect(connect(() => join)).rejects.toThrow('1008');
  const grant = await u.request<{ token: string }>('/resources/relay-ticket', 'POST', {
    hostId: identity.peerId,
    lane: 'control',
    ticket,
  });
  const joined = once(host, 'message');
  const client = await connect(() => ({ ...join, resourceToken: grant.token }));
  const id = JSON.parse((await joined)[0].toString()).id;
  const upstream = once(host, 'message');
  client.send(Buffer.from('1234'));
  expect(Buffer.from(readRelayFrame(new Uint8Array((await upstream)[0])).bytes).toString()).toBe('1234');
  const downstream = once(client, 'message');
  host.send(relayFrame(id, Buffer.from('123456')));
  expect((await downstream)[0].toString()).toBe('123456');
  expect((await u.request<ResourceStatus>('/resources')).relay.used).toBe(10);
  await mf.unsafeEvictDurableObject(name, 'RelayHub', { name: 'relay-v2', webSockets: 'hibernate' });
  await mf.unsafeEvictDurableObject(name, 'MessagingHub', { name: 'accounts-v1' });
  const closed = once(client, 'close');
  client.send(Buffer.from('x'));
  expect((await closed)[0]).toBe(1008);
  expect((await u.request<ResourceStatus>('/resources')).relay.used).toBe(10);
  expect(host.readyState).toBe(WebSocket.OPEN);
  await expect(
    u.request('/resources/relay-ticket', 'POST', { hostId: identity.peerId, lane: 'control', ticket }),
  ).rejects.toMatchObject({ status: 429 });
});
