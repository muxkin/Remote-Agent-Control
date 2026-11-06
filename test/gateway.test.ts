import { temporaryRuntime } from './temporary-runtime.js';
import { it, expect, afterEach, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { fixtureConfig, historyFixture, FakeTransport, THREAD } from './helpers.js';
import { Store } from '../src/server/store.js';
import { HistoryIndex } from '../packages/adapter-codex/src/history.js';
import { DesktopAdapter } from '../packages/adapter-codex/src/desktop.js';
import { DesktopAppTools } from '../packages/adapter-codex/src/app-tools.js';
import { buildGateway } from './legacy/gateway.js';
const callbacks: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of callbacks.splice(0)) await f();
});
async function setup(configure?: (config: ReturnType<typeof fixtureConfig>) => void) {
  const c = fixtureConfig();
  configure?.(c);
  historyFixture(c);
  const store = new Store(c.stateDir, temporaryRuntime);
  const history = new HistoryIndex(c.codexHome);
  const transport = new FakeTransport();
  const desktop = new DesktopAdapter(c, () => transport);
  await desktop.start();
  const app = await buildGateway(c, { store, history, desktop });
  callbacks.push(async () => {
    await app.close();
    desktop.stop();
    store.close();
    history.close();
    rmSync(c.desktopRoot, { recursive: true, force: true });
  });
  const p = store.mintPairing();
  const res = await app.inject({
    method: 'POST',
    url: '/api/pair',
    headers: { host: '127.0.0.1:4317', origin: c.origin },
    payload: { code: p.code, name: 'phone' },
  });
  const cookie = (res.headers['set-cookie'] as string).split(';')[0];
  const headers = { host: '127.0.0.1:4317', origin: c.origin, cookie };
  return { c, store, transport, desktop, app, headers };
}
it('allows browser connections only to the app and explicitly configured storage origins', async () => {
  const local = await setup();
  const localResponse = await local.app.inject({ url: '/api/status', headers: local.headers });
  expect(String(localResponse.headers['content-security-policy']).match(/connect-src [^;]+/)?.[0]).toBe(
    "connect-src 'self'",
  );
  const remote = await setup((config) => {
    const path = join(config.desktopRoot, 'storage-adapter.mjs');
    writeFileSync(
      path,
      `export default () => ({ version: 1, visibility: 'private', uploadOrigins: ['https://upload.example.com'], putFile() {}, createUpload() {}, downloadUrl() {} });`,
    );
    config.media = { adapterPath: path };
  });
  const remoteResponse = await remote.app.inject({ url: '/api/status', headers: remote.headers });
  expect(String(remoteResponse.headers['content-security-policy']).match(/connect-src [^;]+/)?.[0]).toBe(
    "connect-src 'self' https://upload.example.com",
  );
});
it('requires pairing, exact Host and mutation Origin', async () => {
  const { app, headers } = await setup();
  expect((await app.inject({ url: '/api/status', headers: { host: headers.host } })).statusCode).toBe(401);
  expect(
    (await app.inject({ url: '/api/status', headers: { ...headers, host: 'evil.test' } })).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/logout',
        headers: { ...headers, origin: 'https://evil.test' },
      })
    ).statusCode,
  ).toBe(403);
  expect((await app.inject({ url: '/api/status', headers })).statusCode).toBe(200);
});
it('serves authorized media ranges and stops serving immediately after device revocation', async () => {
  const { app, headers, c, desktop, transport, store } = await setup();
  const file = join(c.desktopRoot, 'clip.mp4');
  writeFileSync(file, '0123456789');
  const db = new DatabaseSync(join(c.codexHome, 'state_5.sqlite'));
  db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(c.desktopRoot, THREAD);
  db.close();
  transport.current.cwd = c.desktopRoot;
  transport.current.turnHistory.history.entitiesByKey.one.items.push({
    type: 'agentMessage',
    id: 'clip',
    text: `[视频](${file})`,
  });
  const release = await desktop.acquire(THREAD);
  const response = await app.inject({
    method: 'POST',
    url: `/api/threads/${THREAD}/media`,
    headers,
    payload: { path: file },
  });
  expect(response.statusCode).toBe(200);
  const url = response.json().url;
  const partial = await app.inject({ url, headers: { ...headers, range: 'bytes=2-5' } });
  expect(partial.statusCode).toBe(206);
  expect(partial.headers['content-range']).toBe('bytes 2-5/10');
  expect(partial.body).toBe('2345');
  store.revoke(store.devices()[0].id);
  expect((await app.inject({ url, headers })).statusCode).toBe(401);
  release();
});
it('rejects arbitrary RPC calls and invalid request schemas', async () => {
  const { app, headers } = await setup();
  expect(
    (await app.inject({ method: 'POST', url: '/api/rpc', headers, payload: { method: 'thread/start' } }))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/threads/${THREAD}/messages`,
        headers,
        payload: { text: 'hi', requestId: randomUUID(), model: 'override' },
      })
    ).statusCode,
  ).toBe(400);
});
it('returns UTF-8 text headers and original Chinese bytes for local attachment previews', async () => {
  const { app, headers, c, desktop, transport } = await setup();
  const file = join(c.desktopRoot, '中文附件.txt');
  const bytes = Buffer.from('中文正常 ✅ 📱\n第二行\n');
  writeFileSync(file, bytes);
  transport.current.turnHistory.history.entitiesByKey.one.items.push({
    type: 'agentMessage',
    id: 'text-preview',
    text: `[附件](${file})`,
  });
  const release = await desktop.acquire(THREAD);
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD}/media`,
      headers,
      payload: { path: file },
    });
    expect(response.statusCode).toBe(200);
    const preview = await app.inject({ url: response.json().url, headers });
    expect(preview.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(preview.headers['content-disposition']).toContain("inline; filename*=UTF-8''");
    expect(preview.rawPayload).toEqual(bytes);
  } finally {
    release();
  }
});
it('deduplicates a repeated send across HTTP retries', async () => {
  const { app, headers, transport } = await setup();
  const payload = { text: 'hello', requestId: randomUUID() };
  await Promise.all([
    app.inject({ method: 'POST', url: `/api/threads/${THREAD}/messages`, headers, payload }),
    app.inject({ method: 'POST', url: `/api/threads/${THREAD}/messages`, headers, payload }),
  ]);
  await new Promise((r) => setTimeout(r, 30));
  expect(transport.calls.filter((x) => x.method === 'thread-follower-start-turn')).toHaveLength(1);
});
it('delivers a large initial snapshot followed by previous operation receipts without disconnecting', async () => {
  const { app, headers, transport, store } = await setup();
  transport.current.turnHistory.history.entitiesByKey.one.items = Array.from({ length: 50 }, (_, i) => ({
    type: 'agentMessage',
    id: `large-${i}`,
    text: 'x'.repeat(80000),
  }));
  const operationId = randomUUID();
  store.beginOperation(operationId, store.devices()[0].id, THREAD, 'send', 'previous completed input');
  store.updateOperation(operationId, 'completed');
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as any).port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events?threadId=${THREAD}`, { headers });
  const events: any[] = [],
    closes: number[] = [];
  socket.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  socket.on('close', (code) => closes.push(code));
  try {
    await expect
      .poll(
        () =>
          events.some((e) => e.type === 'operation' && e.operation.id === operationId) || closes.length > 0,
      )
      .toBe(true);
    expect(closes).toEqual([]);
    expect(events.some((e) => e.type === 'operation' && e.operation.id === operationId)).toBe(true);
    expect(events.find((e) => e.type === 'thread')?.thread.messages).toHaveLength(51);
    transport.current.turnHistory.history.entitiesByKey.one.items.at(-1)!.text += 'continued';
    transport.revision++;
    transport.snapshot();
    await expect
      .poll(() => events.some((e) => e.type === 'threadDelta' && e.delta.thread.revision === 2))
      .toBe(true);
    expect(closes).toEqual([]);
  } finally {
    socket.terminate();
  }
});
it('keeps an ambiguous send uncertain and never retries it', async () => {
  const { app, headers, transport, store } = await setup();
  const original = transport.request;
  transport.request = async (...args) => {
    if (args[0] === 'thread-follower-start-turn') throw new Error('connection lost after write');
    return original(...args);
  };
  const payload = { text: 'hello', requestId: randomUUID() };
  await app.inject({ method: 'POST', url: `/api/threads/${THREAD}/messages`, headers, payload });
  await new Promise((r) => setTimeout(r, 30));
  expect(store.operation(payload.requestId)?.state).toBe('uncertain');
  await app.inject({ method: 'POST', url: `/api/threads/${THREAD}/messages`, headers, payload });
  expect(store.operation(payload.requestId)?.state).toBe('uncertain');
});
it('checks WebSocket authentication and Origin before upgrade', async () => {
  const { app, c, headers } = await setup();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as any).port;
  const check = (h: any) =>
    new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events?threadId=${THREAD}`, { headers: h });
      ws.on('unexpected-response', (_req, res) => {
        res.resume();
        ws.terminate();
        resolve(res.statusCode!);
      });
      ws.on('open', () => {
        ws.close();
        resolve(101);
      });
      ws.on('error', () => {});
    });
  expect(await check({ host: headers.host, origin: c.origin })).toBe(401);
  expect(await check({ ...headers, origin: 'https://evil.test' })).toBe(403);
  expect(await check(headers)).toBe(101);
});
it('rejects revoked cookies for both API and fresh sockets', async () => {
  const { app, headers, store } = await setup();
  store.revoke(store.devices()[0].id);
  expect((await app.inject({ url: '/api/threads', headers })).statusCode).toBe(401);
});
it('rate-limits failed pairing attempts', async () => {
  const { app, headers } = await setup();
  let response;
  for (let i = 0; i < 11; i++)
    response = await app.inject({
      method: 'POST',
      url: '/api/pair',
      headers,
      payload: { code: 'x'.repeat(32), name: 'phone' },
    });
  expect(response!.statusCode).toBe(429);
});

it('native creation result is journaled and never replayed on repeated HTTP requests', async () => {
  const createdId = randomUUID();
  const create = vi.spyOn(DesktopAppTools.prototype, 'create').mockResolvedValue(createdId);
  try {
    const { app, headers, store } = await setup();
    const requestId = randomUUID();
    const payload = { requestId, title: 'Phone chat', prompt: 'hello' };
    const first = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD}/create`,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(202);
    await vi.waitFor(() => expect(store.operation(requestId)?.state).toBe('completed'));
    const repeated = await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD}/create`,
      headers,
      payload,
    });
    expect(repeated.json()).toMatchObject({ state: 'completed', resultThreadId: createdId, turnId: null });
    expect(create).toHaveBeenCalledTimes(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/threads/${THREAD}/create`,
          headers,
          payload: { ...payload, requestId: randomUUID(), target: { type: 'codexCloud' } },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    create.mockRestore();
  }
});
it.each([undefined, '', '  '])(
  'creates without a title (%s) or an anchor history subscription',
  async (title) => {
    const create = vi.spyOn(DesktopAppTools.prototype, 'create').mockResolvedValue(randomUUID());
    try {
      const { app, headers, store, transport } = await setup();
      transport.autoSnapshot = false;
      const requestId = randomUUID();
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${THREAD}/create`,
        headers,
        payload: { requestId, prompt: 'Only an opening message', ...(title === undefined ? {} : { title }) },
      });
      expect(response.statusCode).toBe(202);
      await vi.waitFor(() => expect(store.operation(requestId)?.state).toBe('completed'));
      expect(transport.calls).toHaveLength(0);
      expect(transport.broadcasts).toHaveLength(0);
      expect(create).toHaveBeenCalledOnce();
    } finally {
      create.mockRestore();
    }
  },
);
it('keeps creation disabled for a read-only desktop even without an anchor subscription', async () => {
  const create = vi.spyOn(DesktopAppTools.prototype, 'create').mockResolvedValue(randomUUID());
  try {
    const { app, headers, store } = await setup((config) => {
      config.readOnly = true;
    });
    const requestId = randomUUID();
    await app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD}/create`,
      headers,
      payload: { requestId, prompt: 'hello' },
    });
    await vi.waitFor(() => expect(store.operation(requestId)?.state).toBe('rejected'));
    expect(create).not.toHaveBeenCalled();
  } finally {
    create.mockRestore();
  }
});
it('returns a thread summary without reading its rollout for post-creation navigation', async () => {
  const { app, headers, c } = await setup();
  rmSync(join(c.codexHome, 'sessions'), { recursive: true });
  const response = await app.inject({ url: `/api/threads/${THREAD}`, headers });
  expect(response.statusCode).toBe(200);
  expect(response.json().thread).toMatchObject({ id: THREAD, title: '测试会话' });
  expect(response.json().thread.rolloutPath).toBeUndefined();
  expect(response.json().messages).toBeUndefined();
});
it('validates advertised speed tiers before accepting an operation', async () => {
  const { app, headers, c, transport } = await setup();
  writeFileSync(
    join(c.codexHome, 'models_cache.codex_work_desktop.json'),
    JSON.stringify({
      models: [
        {
          slug: 'desktop-model',
          visibility: 'list',
          supported_reasoning_levels: [{ effort: 'low' }],
          service_tiers: [{ id: 'priority', name: 'Fast' }],
        },
      ],
    }),
  );
  const base = {
    requestId: randomUUID(),
    model: 'desktop-model',
    effort: 'low',
    expectedModel: 'desktop-model',
    expectedEffort: null,
  };
  const invalid = await app.inject({
    method: 'POST',
    url: `/api/threads/${THREAD}/settings`,
    headers,
    payload: { ...base, serviceTier: 'invented' },
  });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json().error).toContain('速度');
  expect(transport.calls).toHaveLength(0);
  const catalog = (await app.inject({ url: '/api/models', headers })).json();
  expect(catalog.models[0].speeds.map((s: any) => s.id)).toEqual(['default', 'priority']);
});
it('accepts skill IDs only and refuses unknown skills before sending', async () => {
  const { app, headers, transport } = await setup();
  const response = await app.inject({
    method: 'POST',
    url: `/api/threads/${THREAD}/messages`,
    headers,
    payload: { requestId: randomUUID(), text: 'inspect', skillIds: ['0'.repeat(64)] },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toContain('技能');
  expect(transport.calls).toHaveLength(0);
  const arbitrary = await app.inject({
    method: 'POST',
    url: `/api/threads/${THREAD}/messages`,
    headers,
    payload: {
      requestId: randomUUID(),
      text: 'inspect',
      skills: [{ name: 'secret', path: '/tmp/arbitrary/SKILL.md' }],
    },
  });
  expect(arbitrary.statusCode).toBe(400);
});
