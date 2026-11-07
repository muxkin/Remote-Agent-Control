import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { MessagingStore } from '../src/server/messaging/store.js';
import { MessagingObjects } from '../src/server/messaging/objects.js';
import { buildRelay } from '../src/server/relay.js';
import type { StorageAdapter } from '../src/server/object-storage.js';
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.unstubAllGlobals();
});
function storage() {
  const data = new Map<string, Buffer>();
  let puts = 0;
  const adapter: StorageAdapter = {
    version: 1,
    visibility: 'private',
    uploadOrigins: [],
    async putFile(args) {
      puts++;
      expect(args.expiresAt).toBeUndefined();
      if (data.has(args.key)) return 'exists';
      data.set(args.key, await readFile(args.file));
      return 'created';
    },
    async downloadUrl(key, expires) {
      return `https://private.test/${key}?expires=${expires}`;
    },
    async createUpload() {
      throw Error('not used');
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(new Uint8Array(data.get(new URL(url).pathname.slice(1))!), { status: 200 }),
    ),
  );
  return { adapter, data, puts: () => puts };
}
function fixture() {
  const store = new MessagingStore(':memory:');
  cleanup.push(() => store.close());
  const a = store.createUser('human', 'alice', 'Alice', null),
    b = store.createUser('human', 'bob', 'Bob', null);
  store.addContact(a.id, b.id);
  const cid = store.direct(a.id, b.id).id;
  return { store, a, b, cid };
}
it('stores original plus a smaller preview and shares object references for repeated stickers', async () => {
  const { store, a, b, cid } = fixture(),
    s = storage(),
    objects = new MessagingObjects(store, s.adapter, 'https://chat.test');
  const png = await sharp({ create: { width: 1400, height: 900, channels: 3, background: '#d2e8db' } })
    .png()
    .toBuffer();
  const file = store.upload(a.id, cid, 'picture.png', png),
    obj = await objects.put(png, 'image/png');
  objects.commit('file', file.id, obj);
  expect(obj.previewSize).toBeLessThan(png.length);
  expect(store.file(a.id, cid, file.id).data.length).toBe(0);
  expect(await objects.bytes('file', file.id, Buffer.alloc(0))).toEqual(png);
  const sticker = store.saveSticker(a.id, cid, file.id)[0],
    puts = s.puts();
  for (let i = 0; i < 4; i++) {
    const message = store.send(a.id, cid, `send-${i}`, '', { stickerId: sticker.id });
    const media = store.file(b.id, cid, message.attachments[0].id);
    expect(media.data.length).toBe(0);
    expect(objects.metadata('file', media.id)?.key).toBe(obj.key);
  }
  expect(s.puts()).toBe(puts);
  expect(s.data.size).toBe(2);
  store.removeSticker(a.id, sticker.id);
  expect(await objects.bytes('file', file.id, Buffer.alloc(0))).toEqual(png);
});
it('migration verifies uploaded bytes before clearing local data and retains content on corruption', async () => {
  const { store, a, cid } = fixture(),
    s = storage(),
    objects = new MessagingObjects(store, s.adapter, 'https://chat.test');
  const file = store.upload(a.id, cid, 'a.txt', Buffer.from('original'));
  store.send(a.id, cid, 'm', '', { attachmentIds: [file.id] });
  vi.stubGlobal('fetch', async () => new Response('corrupt'));
  await expect(objects.migrate()).rejects.toThrow('verification');
  expect(store.file(a.id, cid, file.id).data.toString()).toBe('original');
  vi.stubGlobal(
    'fetch',
    async (url: string) => new Response(new Uint8Array(s.data.get(new URL(url).pathname.slice(1))!)),
  );
  expect((await objects.migrate()).migrated).toBe(1);
  expect(store.history(a.id, cid).messages).toHaveLength(1);
  expect(store.file(a.id, cid, file.id).data.length).toBe(0);
  expect(store.user(a.id).id).toBe(a.id);
  expect((await objects.restoreLocal()).restored).toBe(1);
  expect(store.file(a.id, cid, file.id).data.toString()).toBe('original');
});
it('authorizes signed metadata and 304s, returns original downloads and supports private versioned avatars', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'im-objects-test-'));
  cleanup.push(() => rmSync(folder, { recursive: true, force: true }));
  const db = join(folder, 'im.sqlite'),
    s = storage();
  const store = new MessagingStore(db);
  cleanup.push(() => store.close());
  const a = store.createUser('human', 'alice', 'Alice', null),
    b = store.createUser('human', 'bob', 'Bob', null),
    eve = store.createUser('human', 'eve', 'Eve', null);
  store.addContact(a.id, b.id);
  const cid = store.direct(a.id, b.id).id;
  const auth = store.issueSession(a.id).token,
    other = store.issueSession(b.id).token,
    unauthorized = store.issueSession(eve.id).token;
  const relay = await buildRelay({
    origin: 'https://chat.test',
    webRoot: '/nonexistent',
    assetOrigin: null,
    uploadOrigins: [],
    enrollmentSecret: 'testing-object-relay-secret-32-chars',
    messaging: { database: db, storage: s.adapter },
  });
  cleanup.push(() => relay.app.close());
  const call = (url: string, token = auth, extra: object = {}) =>
    relay.app.inject({
      url,
      headers: { host: 'chat.test', origin: 'https://chat.test', authorization: `Bearer ${token}` },
      ...extra,
    });
  const png = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#22aa88' } })
    .png()
    .toBuffer();
  const uploaded = await call(`/api/im/conversations/${cid}/files`, auth, {
    method: 'POST',
    payload: png,
    headers: {
      host: 'chat.test',
      origin: 'https://chat.test',
      authorization: `Bearer ${auth}`,
      'content-type': 'application/octet-stream',
      'x-file-name': 'original.png',
    },
  });
  expect(uploaded.statusCode).toBe(200);
  const file = uploaded.json().file;
  store.send(a.id, cid, 'image', '', { attachmentIds: [file.id] });
  const meta = await call(file.url + '?meta=1', other);
  expect(meta.statusCode).toBe(200);
  expect(meta.json().mime).toBe('image/webp');
  expect((await call(file.url + '?meta=1', unauthorized)).statusCode).toBe(404);
  const raw = await call(file.url, other);
  expect(raw.statusCode).toBe(302);
  expect(new URL(String(raw.headers.location)).pathname).toContain(
    new MessagingObjects(store, s.adapter, '').metadata('file', file.id)!.hash,
  );
  const downloaded = await call(file.url + '?download=1', other);
  expect(downloaded.rawPayload).toEqual(png);
  const headers = {
    host: 'chat.test',
    authorization: `Bearer ${other}`,
    'if-none-match': downloaded.headers.etag,
  };
  expect((await call(file.url, other, { headers })).statusCode).toBe(304);
  expect(
    (await call(file.url, unauthorized, { headers: { ...headers, authorization: `Bearer ${unauthorized}` } }))
      .statusCode,
  ).toBe(404);
  const avatar = await call('/api/im/me/avatar', auth, {
    method: 'POST',
    payload: png,
    headers: {
      host: 'chat.test',
      origin: 'https://chat.test',
      authorization: `Bearer ${auth}`,
      'content-type': 'application/octet-stream',
    },
  });
  expect(avatar.statusCode).toBe(200);
  const url = avatar.json().user.avatarUrl;
  expect((await call(url + '?meta=1', other)).statusCode).toBe(200);
  expect((await call(url, unauthorized)).statusCode).toBe(404);
  expect((await call('/api/im/me/avatar', auth, { method: 'DELETE' })).statusCode).toBe(200);
  expect((await call(url, other)).statusCode).toBe(404);
});
