import { temporaryRuntime } from './temporary-runtime.js';
import { manual as remove } from 'rimraf';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AdapterProxy } from '../src/server/adapters/proxy.js';
import { readAdapterPackage } from '../src/server/adapters/package.js';
import { Operations } from '../src/server/operations.js';
import { Store } from '../src/server/store.js';
// Native Windows ACL setup can block the test parent for more than one second.
// Keep a short but realistic heartbeat budget; the hang test still verifies forced recovery.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});
const presentation = {
  creation: { empty: true, permission: 'select', preset: false, plan: false },
  plan: 'none',
  fileReferences: false,
  exportLog: false,
  nativeCommands: false,
};
function pack(version = '1.0.0', options: { fail?: boolean; stateVersion?: number; sdk?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adapter host 中文-'));
  clean.push(async () => {
    await remove(dir);
  });
  cpSync(resolve('test/fixtures/adapter/index.mjs'), join(dir, 'index.mjs'));
  if (options.fail)
    writeFileSync(join(dir, 'index.mjs'), 'export function createAdapter(){throw Error("Startup failed");}');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'test-adapter',
      version,
      type: 'module',
      agentAdapter: {
        sdk: options.sdk ?? 1,
        entry: 'index.mjs',
        stateVersion: options.stateVersion ?? 1,
        product: 'test',
        name: 'Third Agent',
        presentation,
      },
    }),
  );
  return readAdapterPackage(dir);
}
async function instance(id = 'one', p = pack(), config: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'adapter state 中文-'));
  const backend = new AdapterProxy(
    p,
    { id, name: id, stateDirectory: directory, readOnly: false, config },
    { startup: 20000, request: 20000, heartbeat: 250, hang: 5000, restart: 100 },
  );
  clean.push(async () => {
    await backend.stop();
    // Windows may release a dev-loader helper's CWD after the host close event.
    await remove(directory);
  });
  await backend.start();
  return { backend, directory };
}
const send = (text: string) => ({
  kind: 'send' as const,
  text,
  attachments: [],
  skillIds: [],
  pluginIds: [],
});
it('preserves optional arguments and RPC framing, rejects unknown methods, and awaits graceful cleanup', async () => {
  const { backend, directory } = await instance('lifecycle', pack(), { noisy: true, stopDelay: 150 });
  const pid = backend.pid;
  expect((await backend.waitForView('shared'))?.id).toBe('shared');
  expect((await backend.history.list(undefined, undefined, undefined, 'query')).threads).toHaveLength(1);
  await expect(
    (backend as any).host.connection.sendRequest('adapter/arbitraryNativeRPC', {}),
  ).rejects.toThrow('Unhandled method');
  expect(backend.status().connected).toBe(true);
  await backend.stop();
  expect(JSON.parse(readFileSync(join(directory, 'stopped.jsonl'), 'utf8'))).toEqual({ pid });
});
it('isolates same native IDs, credentials and subscriptions in three independent hosts', async () => {
  process.env.POCKET_RELAY_ENROLLMENT = 'must-not-inherit';
  process.env.DSH_OTHER_TOKEN = 'must-not-inherit';
  clean.push(() => {
    delete process.env.POCKET_RELAY_ENROLLMENT;
    delete process.env.DSH_OTHER_TOKEN;
  });
  const entries = await Promise.all(['codex-local', 'dsh-one', 'dsh-two'].map((id) => instance(id)));
  for (const { backend } of entries) {
    await backend.acquire('shared');
    await backend.execute('shared', send(backend.id), randomUUID());
  }
  expect(new Set(entries.map((e) => e.backend.pid)).size).toBe(3);
  for (const { backend } of entries) {
    expect((await backend.history.page('shared')).messages.map((m) => m.text)).toEqual([backend.id]);
    expect((await backend.fileReferences!('shared', '')).map((f) => f.name)).not.toContain('DSH_OTHER_TOKEN');
    expect((await backend.fileReferences!('shared', '')).map((f) => f.name)).not.toContain(
      'POCKET_RELAY_ENROLLMENT',
    );
  }
  expect(new Set(await Promise.all(entries.map((e) => e.backend.attachment!('shared', 'file')))).size).toBe(
    3,
  );
});
it('marks lost writes uncertain, restores subscriptions and never replays creates, sends or approvals', async () => {
  const { backend, directory } = await instance();
  const store = new Store(join(directory, 'store'), temporaryRuntime);
  const operations = new Operations(backend, store, backend.id);
  clean.push(() => {
    operations.close();
    store.close();
  });
  const release = await backend.acquire('shared');
  const requestId = randomUUID();
  operations.submit('phone', 'shared', requestId, 'send', JSON.stringify(send('crash')));
  await expect
    .poll(() => store.operation(requestId, undefined, backend.id)?.state, { timeout: 5000 })
    .toBe('uncertain');
  await expect.poll(() => backend.view('shared')?.synchronized, { timeout: 10000 }).toBe(true);
  operations.submit('phone', 'shared', requestId, 'send', JSON.stringify(send('crash')));
  expect(readFileSync(join(directory, 'dispatches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  release();
});
it('kills a hung host without affecting other instances and does not repeat the write', async () => {
  const { backend: bad, directory } = await instance('bad'),
    { backend: good } = await instance('good');
  const pid = bad.pid;
  await bad.acquire('shared');
  const result = bad.execute('shared', send('hang'), randomUUID()).catch((e) => e);
  expect(await good.execute('shared', send('works'), randomUUID())).toBeTruthy();
  expect((await result).notSent).toBe(false);
  await expect.poll(() => bad.status().connected && bad.pid !== pid, { timeout: 10000 }).toBe(true);
  expect(readFileSync(join(directory, 'dispatches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
});
it('defers unsafe upgrades, restores subscriptions, rolls back failed starts and refuses state migrations', async () => {
  const original = pack(),
    next = pack('1.1.0'),
    broken = pack('1.2.0', { fail: true }),
    incompatible = pack('2.0.0', { stateVersion: 2 });
  const { backend } = await instance('upgrade', original);
  await backend.acquire('shared');
  const pid = backend.pid;
  const pending = backend.execute('shared', send('delay'), randomUUID());
  await expect(backend.replace(next, 50)).rejects.toThrow('升级已延后');
  expect(backend.pid).toBe(pid);
  await pending;
  await backend.replace(next);
  expect(backend.packageInfo.version).toBe('1.1.0');
  expect(backend.view('shared')?.synchronized).toBe(true);
  await expect(backend.replace(broken)).rejects.toThrow('已恢复旧版本');
  expect(backend.packageInfo.version).toBe('1.1.0');
  await expect(backend.replace(incompatible)).rejects.toThrow('显式迁移');
  await backend.replace(original);
  expect(backend.packageInfo.version).toBe('1.0.0');
});
it('ignores replies from an earlier generation and enforces SDK compatibility', async () => {
  const { backend } = await instance();
  await backend.acquire('shared');
  const host = (backend as any).host,
    generation = (backend as any).generation;
  await backend.replace(pack('1.1.0'));
  expect(host.child.exitCode).not.toBeNull();
  expect(() =>
    host.connection.sendRequest('adapter/history.get', { generation, args: ['shared'] }),
  ).toThrow();
  const stale = JSON.stringify({
    jsonrpc: '2.0',
    method: 'adapter/event',
    params: {
      generation,
      event: 'thread',
      args: [{ ...backend.view('shared'), title: 'stale' }],
    },
  });
  host.child.stdout.emit('data', Buffer.from(`Content-Length: ${Buffer.byteLength(stale)}\r\n\r\n${stale}`));
  expect(backend.view('shared')?.title).not.toBe('stale');
  expect(() => pack('3.0.0', { sdk: 2 })).toThrow();
});

it.each(['create', 'respond'] as const)('does not repeat a lost %s after host recovery', async (kind) => {
  const { backend, directory } = await instance(kind, pack(), { crashKind: kind });
  const store = new Store(join(directory, 'store'), temporaryRuntime),
    operations = new Operations(backend, store, backend.id);
  clean.push(() => {
    operations.close();
    store.close();
  });
  const id = randomUUID(),
    input = JSON.stringify(
      kind === 'create' ? { prompt: 'fixture' } : { requestId: 'native-fixture', decision: 'accept' },
    );
  operations.submit('phone', 'shared', id, kind, input);
  await expect
    .poll(() => store.operation(id, undefined, backend.id)?.state, { timeout: 10000 })
    .toBe('uncertain');
  await expect.poll(() => backend.status().connected, { timeout: 10000 }).toBe(true);
  operations.submit('phone', 'shared', id, kind, input);
  expect(readFileSync(join(directory, 'dispatches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
});

it('defers an upgrade if its host dies during handoff, and recovers the original version', async () => {
  const { backend, directory } = await instance();
  await backend.acquire('shared');
  const write = backend.execute('shared', send('delay'), randomUUID()).catch((error) => error);
  await expect
    .poll(() => {
      try {
        return readFileSync(join(directory, 'dispatches.jsonl'), 'utf8').length > 0;
      } catch {
        return false;
      }
    })
    .toBe(true);
  const upgrade = backend.replace(pack('1.1.0')).catch((error) => error);
  process.kill(backend.pid!, 'SIGKILL');
  expect((await write).notSent).toBe(false);
  expect((await upgrade).message).toContain('升级已延后');
  await expect.poll(() => backend.status().connected, { timeout: 10000 }).toBe(true);
  expect(backend.packageInfo.version).toBe('1.0.0');
  expect(readFileSync(join(directory, 'dispatches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
});
