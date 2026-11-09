import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import WebSocket from 'ws';
import { AccountClient } from '../src/client/account.js';
import { createIdentity, identityKey, base64 } from '../src/shared/secure-channel.js';
import { hostProof, readRelayFrame, relayFrame } from '../src/shared/relay-protocol.js';
import { unzipSync, strFromU8 } from 'fflate';
import { MessagingStore } from './messaging-fixtures.js';
import { ResourceService, resourceMonth } from '../src/server/resources/service.js';
import { LagoResourcePolicy } from '../src/server/resources/lago.js';
import { MessagingObjects } from '../src/server/messaging/objects.js';
import { buildRelay } from '../src/server/relay.js';
import { protectAccount } from '../src/shared/account-crypto.js';
import { EncryptedMessagingClient } from '../src/client/encrypted-messaging.js';
import { exportResources } from '../src/client/resource-export.js';
import type { ResourcePolicy, ResourceFile } from '../src/shared/resources.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const policy: ResourcePolicy = {
  label: '后台任意名称',
  storageBytes: 100,
  relayBytes: 10,
  timeZone: 'Asia/Shanghai',
};
function fixture() {
  const store = new MessagingStore(':memory:');
  cleanup.push(() => store.close());
  const a = store.createUser('human', 'alice', 'Alice', null),
    b = store.createUser('human', 'bob', 'Bob', null);
  store.addContact(a.id, b.id);
  const cid = store.direct(a.id, b.id).id;
  const provider = { resolve: vi.fn(async () => ({ ...policy })) };
  const resources = new ResourceService(store, provider);
  store.resources = resources;
  return { store, a, b, cid, provider, resources };
}

it('rejects full storage without deleting old attachments, and includes Agent usage in the owner budget', async () => {
  const { store, a, b, cid, resources } = fixture();
  await resources.prepare(a.id);
  const first = store.upload(a.id, cid, 'a.txt', Buffer.alloc(80));
  expect(() => store.upload(a.id, cid, 'b.txt', Buffer.alloc(21))).toThrow('空间不足');
  expect(store.file(a.id, cid, first.id).data).toHaveLength(80);
  const agent = store.registerAgent(store.invite(a.id).invitation, 'agent', 'Agent').user;
  const ac = store.direct(a.id, agent.id).id;
  store.upload(agent.id, ac, 'agent.txt', Buffer.alloc(20));
  expect(resources.storageUsed(a.id)).toBe(100);
  expect(() => store.upload(agent.id, ac, 'overflow.txt', Buffer.alloc(1))).toThrow('空间不足');
  expect(store.resourceFiles(agent.id).files).toHaveLength(1);
  expect(() => store.resourceFile(agent.id, 'file', first.id)).toThrow('文件不存在');
  expect(() => store.clearResourceFiles(b.id, [{ kind: 'file', id: first.id }])).toThrow('文件不存在');
  expect(resources.storageUsed(a.id)).toBe(100);
});

it('reloads backend limits and fails closed after policy expiry instead of using stale privileges', async () => {
  vi.useFakeTimers();
  const { store, a, cid, resources, provider } = fixture();
  await resources.prepare(a.id);
  store.upload(a.id, cid, 'first.txt', Buffer.alloc(90));
  provider.resolve.mockResolvedValue({ ...policy, storageBytes: 95 });
  vi.advanceTimersByTime(60001);
  await resources.prepare(a.id);
  expect(() => store.upload(a.id, cid, 'second.txt', Buffer.alloc(6))).toThrow('空间不足');
  expect(store.resourceFiles(a.id).files).toHaveLength(1);
  provider.resolve.mockRejectedValue(Error('service down'));
  vi.advanceTimersByTime(60001);
  await expect(resources.prepare(a.id)).rejects.toThrow('无法读取');
  expect(() => store.upload(a.id, cid, 'third.txt', Buffer.alloc(1))).toThrow('刷新');
  expect(
    store.clearResourceFiles(a.id, [{ kind: 'file', id: store.resourceFiles(a.id).files[0].id }])
      .releasedBytes,
  ).toBe(90);
});

it('meters both concurrent transfers atomically, persists usage across restart, and honors revoked sessions', async () => {
  const { store, a, resources, provider } = fixture(),
    session = store.issueSession(a.id);
  const grant = await resources.issueRelay(a.id, session.token, 'host', 'route', 'control');
  await expect(resources.redeemRelay(grant.token, 'other-host', 'route', 'control')).rejects.toThrow();
  const account = await resources.redeemRelay(grant.token, 'host', 'route', 'control');
  await expect(resources.redeemRelay(grant.token, 'host', 'route', 'control')).rejects.toThrow();
  const transfers = await Promise.allSettled([
    resources.consumeRelay(account, 8),
    resources.consumeRelay(account, 8),
  ]);
  expect(transfers.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const restarted = new ResourceService(store, provider);
  expect((await restarted.status(a.id)).relay.used).toBe(8);
  await restarted.consumeRelay(account, 2);
  await expect(restarted.consumeRelay(account, 1)).rejects.toThrow('用完');
  expect((await restarted.status(a.id)).relay.used).toBe(10);
  store.logout(session.token);
  await expect(restarted.consumeRelay(account, 0)).rejects.toThrow('会话');
});

it('resets only monthly traffic at the configured month boundary, retaining occupied storage', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-30T15:59:59.000Z'));
  const { store, a, cid, resources } = fixture(),
    session = store.issueSession(a.id);
  const token = await resources.issueRelay(a.id, session.token, 'host', 'route', 'control');
  const account = await resources.redeemRelay(token.token, 'host', 'route', 'control');
  store.upload(a.id, cid, 'file.txt', Buffer.alloc(30));
  await resources.consumeRelay(account, 10);
  expect((await resources.status(a.id)).relay.resetsAt).toBe(Date.parse('2026-11-30T16:00:00Z'));
  vi.advanceTimersByTime(1000);
  const status = await resources.status(a.id);
  expect(status.relay.used).toBe(0);
  expect(status.storage.used).toBe(30);
  await resources.consumeRelay(account, 10);
  expect(resourceMonth(Date.parse('2026-03-15T00:00:00Z'), 'America/New_York')).toMatchObject({
    startsAt: Date.parse('2026-03-01T05:00:00Z'),
    resetsAt: Date.parse('2026-04-01T04:00:00Z'),
  });
});

it('revokes frames waiting for a refreshed policy when the account logs out', async () => {
  const { store, a, resources, provider } = fixture(),
    session = store.issueSession(a.id);
  const grant = await resources.issueRelay(a.id, session.token, 'host', 'route', 'control');
  const account = await resources.redeemRelay(grant.token, 'host', 'route', 'control');
  store.db.prepare('DELETE FROM resource_policies').run();
  let finish!: (value: ResourcePolicy) => void;
  provider.resolve.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const frame = resources.consumeRelay(account, 1);
  store.logout(session.token);
  finish(policy);
  await expect(frame).rejects.toThrow('会话');
  expect((await resources.status(a.id)).relay.used).toBe(0);
});

it('enforces Node WebSocket traffic in both directions without closing the shared host', async () => {
  const origin = 'http://resource-relay.test',
    enrollment = 'resource-relay-test-secret-32-characters';
  const relay = await buildRelay({
    origin,
    enrollmentSecret: enrollment,
    webRoot: '/nonexistent',
    assetOrigin: null,
    uploadOrigins: [],
    messaging: { humanContacts: true, resourcePolicy: { resolve: async () => policy } },
  });
  const url = await relay.app.listen({ host: '127.0.0.1', port: 0 }),
    sockets: WebSocket[] = [];
  cleanup.push(async () => {
    for (const ws of sockets) ws.terminate();
    await relay.app.close();
  });
  let cookie = '';
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const r = await relay.app.inject({
      method: method as any,
      url: `/api/im${path}`,
      headers: { host: 'resource-relay.test', origin, cookie },
      payload: body as Record<string, unknown> | undefined,
    });
    if (r.headers['set-cookie']) cookie = String(r.headers['set-cookie']).split(';')[0];
    const value = r.json();
    if (r.statusCode >= 400) throw Error(value.error);
    return value;
  };
  const account = new AccountClient(request);
  await account.register('relayresource', 'Quota test', 'strong-resource-test-password');
  const connect = (auth: (challenge: string) => object | Promise<object>) => {
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/connect', {
      headers: { Host: 'resource-relay.test', Origin: origin },
    });
    sockets.push(ws);
    return new Promise<WebSocket>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('close', (code) => reject(Error(`Closed ${code}`)));
      ws.on('message', (raw, binary) => {
        if (binary) return;
        const m = JSON.parse(raw.toString());
        if (m.type === 'challenge')
          void Promise.resolve(auth(m.challenge))
            .then((v) => ws.send(JSON.stringify(v)))
            .catch(reject);
        if (m.type === 'registered' || m.type === 'joined') resolve(ws);
      });
    });
  };
  const identity = await createIdentity(),
    ticket = 'q'.repeat(32);
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
  const grant = await request<{ token: string }>('/resources/relay-ticket', 'POST', {
    hostId: identity.peerId,
    lane: 'control',
    ticket,
  });
  const joined = once(host, 'message');
  const client = await connect(() => ({ ...join, resourceToken: grant.token }));
  const id = JSON.parse((await joined)[0].toString()).id;
  const up = once(host, 'message');
  client.send(Buffer.from('1234'));
  expect(Buffer.from(readRelayFrame(new Uint8Array((await up)[0])).bytes).toString()).toBe('1234');
  const down = once(client, 'message');
  host.send(relayFrame(id, Buffer.from('123456')));
  expect((await down)[0].toString()).toBe('123456');
  const closed = once(client, 'close');
  client.send(Buffer.from('x'));
  expect((await closed)[0]).toBe(1008);
  expect(host.readyState).toBe(WebSocket.OPEN);
  expect((await request<any>('/resources')).relay.used).toBe(10);
  await expect(
    request('/resources/relay-ticket', 'POST', { hostId: identity.peerId, lane: 'control', ticket }),
  ).rejects.toThrow('用完');
});

it('preserves shared external objects until the last reference is cleaned and retries deletion failures', async () => {
  const { store, a, b, cid, resources } = fixture();
  await resources.prepare(a.id);
  await resources.prepare(b.id);
  const bytes = new Map<string, Buffer>();
  let fail = false;
  const objects = new MessagingObjects(
    store,
    {
      version: 1,
      visibility: 'private',
      uploadOrigins: [],
      async putFile(file) {
        bytes.set(file.key, await readFile(file.file));
        return 'created';
      },
      async remove(key) {
        if (fail) throw Error('offline');
        bytes.delete(key);
      },
      async downloadUrl(key) {
        return `https://objects.test/${key}`;
      },
      async createUpload() {
        throw Error();
      },
    },
    'https://test',
  );
  const file = store.upload(a.id, cid, 'a.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const object = await objects.put(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png');
  objects.commit('file', file.id, object);
  store.send(a.id, cid, 'message', 'kept', { attachmentIds: [file.id] });
  const sticker = store.saveSticker(b.id, cid, file.id)[0];
  store.clearResourceFiles(a.id, [{ kind: 'file', id: file.id }]);
  await objects.collectGarbage();
  expect(bytes.has(object.key)).toBe(true);
  expect(store.message(a.id, cid, store.history(a.id, cid).messages[0].id).attachments[0].removed).toBe(true);
  store.clearResourceFiles(b.id, [{ kind: 'sticker', id: sticker.id }]);
  fail = true;
  await expect(objects.collectGarbage()).rejects.toThrow('offline');
  expect(bytes.size).toBe(1);
  fail = false;
  await objects.collectGarbage();
  expect(bytes.size).toBe(0);
  expect(await objects.restoreLocal()).toEqual({ restored: 0 });
});

it('exports decrypted bytes and preserves encrypted message verification after clearing attachments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-http-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'im.sqlite'),
    store = new MessagingStore(path);
  const [ak, bk] = await Promise.all([
    protectAccount('resource-test-password-123'),
    protectAccount('resource-test-password-456'),
  ]);
  const a = store.createUser('human', 'alice', 'Alice', null),
    b = store.createUser('human', 'bob', 'Bob', null);
  for (const [u, key] of [
    [a, ak],
    [b, bk],
  ] as const)
    store.db
      .prepare('INSERT INTO im_account_crypto VALUES (?,?,?,1)')
      .run(u.id, JSON.stringify(key.vault), 'disabled');
  store.addContact(a.id, b.id);
  const cid = store.direct(a.id, b.id).id,
    token = store.issueSession(a.id).token;
  store.close();
  const relay = await buildRelay({
    origin: 'https://resource.test',
    webRoot: '/nonexistent',
    assetOrigin: null,
    uploadOrigins: [],
    enrollmentSecret: 'resource-test-enrollment-secret-32',
    messaging: {
      humanContacts: true,
      database: path,
      resourcePolicy: { resolve: async () => ({ ...policy, storageBytes: 1024 }) },
    },
  });
  cleanup.push(() => relay.app.close());
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)),
      headers = Object.fromEntries(new Headers(init.headers));
    const payload = ArrayBuffer.isView(init.body)
      ? Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength)
      : init.body;
    const response = await relay.app.inject({
      method: (init.method ?? 'GET') as any,
      url: url.pathname + url.search,
      headers: { ...headers, host: url.host, origin: url.origin },
      payload: payload as any,
    });
    return new Response(new Uint8Array(response.rawPayload), {
      status: response.statusCode,
      headers: response.headers as Record<string, string>,
    });
  });
  const client = new EncryptedMessagingClient('https://resource.test', token);
  client.account.activate(a, ak.secrets, ak.vault, 1);
  const original = new TextEncoder().encode('解密后的内容，不是密文');
  const uploaded = await client.upload(cid, '秘密.txt', original);
  const sent = await client.send(cid, '附件清理后文字仍可验证', 'encrypted-resource-message', {
    attachmentIds: [uploaded.file.id],
  });
  const inventory = await client.raw<{ files: ResourceFile[] }>('/resources/files');
  const decoded = await client.download(inventory.files[0].url);
  expect(decoded.data).toEqual(original);
  expect(decoded.name).toBe('秘密.txt');
  const archives: Uint8Array[] = [];
  await exportResources(
    inventory.files,
    (f) => client.download(f.url),
    async (chunks) => {
      archives.push(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    },
    () => {},
  );
  const zip = unzipSync(archives[0]);
  expect(strFromU8(Object.values(zip)[0])).toBe('解密后的内容，不是密文');
  await client.raw('/resources/cleanup', 'POST', { files: [{ kind: 'file', id: uploaded.file.id }] });
  const after = await client.request<{ message: { text: string; attachments: { removed?: boolean }[] } }>(
    `/conversations/${cid}/messages/${sent.message.id}`,
  );
  expect(after.message.text).toBe('附件清理后文字仍可验证');
  expect(after.message.attachments[0].removed).toBe(true);
  await expect(client.download(inventory.files[0].url)).rejects.toThrow('不可用');
});

it('does not reinstate cancelled subscriptions, and retries only interrupted initial provisioning', async () => {
  let created = 0,
    terminated = true;
  const calls: string[] = [];
  const http = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname.includes('/customers/'))
      return Response.json({
        customer: { metadata: [{ key: 'pocket_instance', value: 'ac.example' }] },
      });
    if (url.pathname === '/api/v1/subscriptions' && init?.method === 'POST') {
      created++;
      return Response.json({});
    }
    if (url.searchParams.getAll('status[]').includes('terminated'))
      return Response.json({ subscriptions: terminated ? [{ status: 'terminated' }] : [] });
    if (url.pathname.includes('/entitlements'))
      return Response.json({
        entitlements: [
          { code: 'storage', privileges: [{ code: 'max_bytes', value: 123 }] },
          {
            code: 'relay',
            privileges: [
              { code: 'max_bytes', value: 456 },
              { code: 'time_zone', value: 'Asia/Shanghai' },
            ],
          },
        ],
      });
    if (url.pathname.startsWith('/api/v1/plans/')) return Response.json({ plan: { name: '后台套餐名' } });
    return Response.json({
      subscriptions: created
        ? [{ external_id: 'ac.example:123', plan_code: 'configured.plan', name: '' }]
        : [],
    });
  });
  const provider = new LagoResourcePolicy(
    { url: 'https://lago.test', apiKey: 'private', instance: 'ac.example', defaultPlan: 'configured.plan' },
    http as typeof fetch,
  );
  expect((await provider.resolve('123')).storageBytes).toBe(0);
  expect(created).toBe(0);
  terminated = false;
  expect(await provider.resolve('123')).toMatchObject({
    label: '后台套餐名',
    storageBytes: 123,
    relayBytes: 456,
  });
  expect(created).toBe(1);
  expect(calls.some((p) => p.startsWith('/api/v1/customers/ac%2Eexample%3A123'))).toBe(true);
  expect(calls).toContain('/api/v1/subscriptions/ac%2Eexample%3A123/entitlements');
  expect(calls).toContain('/api/v1/plans/configured%2Eplan');
  expect(calls.some((s) => s.includes('status[]=terminated'))).toBe(true);
});

it('keeps successful decrypted exports when another file fails and reports failures without cleanup', async () => {
  const files = ['a', 'b', 'c'].map((id) => ({
    id,
    kind: 'file',
    name: 'unused',
    mime: 'text/plain',
    size: 4,
    userId: '1',
    url: '/',
  })) as ResourceFile[];
  const archives: Uint8Array[] = [];
  const result = await exportResources(
    files,
    async (f) => {
      if (f.id === 'b') throw Error('缺少对应密钥');
      return { data: new TextEncoder().encode('data'), name: '../same.txt' };
    },
    async (chunks) => {
      archives.push(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    },
    () => {},
    undefined,
    4,
  );
  expect(result.downloaded).toBe(2);
  expect(result.failed).toHaveLength(1);
  expect(archives).toHaveLength(2);
  const names = archives.flatMap((data) => Object.keys(unzipSync(data)));
  expect(names.every((name) => !name.includes('../'))).toBe(true);
  expect(names).toContain('export-errors.json');
});
