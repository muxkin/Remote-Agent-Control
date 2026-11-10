import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { nodeSession } from '../../src/client/node-session.js';
import { buildRelay } from '../../src/server/relay.js';
import { platformRuntime } from '../../src/server/platform.js';
import { apiCall } from '../../src/shared/rpc.js';
import { createIdentity } from '../../src/shared/secure-channel.js';

const [executable, fixture] = process.argv.slice(2).map((path) => resolve(path));
const state = await mkdtemp(join(tmpdir(), 'native-plugin-state-'));
if (process.platform === 'win32') platformRuntime().privateDirectory(state);
const packages = await mkdtemp(join(tmpdir(), 'native-plugin-packages-'));
const backendId = 'rust-fixture';
const name = 'example-native-plugin';
const thread = 'demo-thread';
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(POCKET_|CODEX_)/i.test(name)),
);
const env = {
  ...cleanEnv,
  CODEX_HOME: join(state, 'no-codex'),
  POCKET_NATIVE_STATE_DIR: state,
  POCKET_NATIVE_P2P: '0',
  NATIVE_PLUGIN_FIXTURE_TOKEN: 'fixture-token',
  NATIVE_PLUGIN_SECOND_TOKEN: 'second-token',
};
const cli = (...args: string[]) =>
  execFileSync(executable, ['--adapter', ...args], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const runCli = promisify(execFile);
const cliAsync = async (...args: string[]) =>
  (await runCli(executable, ['--adapter', ...args], { env, encoding: 'utf8', timeout: 42_000 })).stdout;
const binary = basename(fixture);
const digest = createHash('sha256')
  .update(await readFile(fixture))
  .digest('hex');

const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const address = probe.address();
assert(address && typeof address !== 'string');
await new Promise<void>((done) => probe.close(() => done()));
const origin = 'http://127.0.0.1:' + address.port;
const enrollment = randomBytes(32).toString('hex');
const relay = await buildRelay({
  origin,
  enrollmentSecret: enrollment,
  webRoot: join(state, 'no-web'),
  assetOrigin: null,
  uploadOrigins: [],
});
const phone = await createIdentity();
let child: ReturnType<typeof spawn> | undefined;
let session: Awaited<ReturnType<typeof nodeSession>> | undefined;
async function launch() {
  child = spawn(executable, ['--headless', '--print-pair'], {
    env: { ...env, POCKET_NATIVE_ORIGIN: origin, POCKET_NATIVE_ENROLLMENT: enrollment },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout! });
  const timeout = setTimeout(() => child?.kill(), 15_000);
  try {
    for await (const line of lines) if (line.startsWith(origin)) return new URL(line);
    throw Error('Native adapter did not advertise pairing');
  } finally {
    clearTimeout(timeout);
    lines.close();
  }
}
async function stop() {
  session?.close();
  session = undefined;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'close');
    child.kill('SIGINT');
    await exit;
  }
  child = undefined;
}
async function until<T>(fn: () => T | Promise<T>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const found = await fn();
    if (found) return found;
    await delay(50);
  }
  assert.fail('Expected native plugin state did not arrive');
}

try {
  for (const [version, stateVersion, sha256] of [
    ['1.0.0', 1, digest],
    ['1.1.0', 1, digest],
    ['1.2.0', 1, digest],
    ['2.0.0', 2, digest],
    ['3.0.0', 1, '0'.repeat(64)],
  ] as const) {
    const root = join(packages, version);
    await mkdir(root);
    await copyFile(fixture, join(root, binary));
    await writeFile(
      join(root, 'adapter.json'),
      JSON.stringify({
        sdk: 1,
        name,
        version,
        product: 'fixture',
        stateVersion,
        entry: binary,
        sha256,
      }),
    );
    if (version === '3.0.0') assert.throws(() => cli('install', root));
    else assert.equal(cli('install', root).trim(), name + '@' + version);
  }
  assert.throws(() => cli('install', join(packages, '1.0.0')));
  assert.equal(JSON.parse(cli('list')).packages.length, 4);
  const config = async (version: string) => {
    const path = join(state, 'instances.json');
    await writeFile(
      path,
      JSON.stringify([
        {
          id: backendId,
          name: 'Rust fixture',
          plugin: name,
          version,
          secrets: { token: 'NATIVE_PLUGIN_FIXTURE_TOKEN' },
        },
        {
          id: 'second-fixture',
          name: 'Second fixture',
          plugin: name,
          version: '1.0.0',
          secrets: { token: 'NATIVE_PLUGIN_SECOND_TOKEN' },
        },
        { id: 'missing-fixture', name: 'Missing fixture', plugin: 'not-installed', version: '1.0.0' },
      ]),
      { mode: 0o600 },
    );
    if (process.platform === 'win32') platformRuntime().privateFile(path);
  };
  await config('1.0.0');
  await relay.app.listen({ host: '127.0.0.1', port: address.port });
  const first = new URLSearchParams((await launch()).hash.slice(1));
  const pair = first.get('pair')!;
  const host = first.get('host')!;
  session = await nodeSession(origin, host, phone, createHash('sha256').update(pair).digest('hex'), {
    type: 'pair',
    protocol: 2,
    sessionId: randomUUID(),
    code: pair,
    name: 'Native plugin test',
  });
  const { ticket } = await session.ready;
  const rpc = <T>(path: string, method = 'GET', body?: unknown) =>
    session!.rpc<T>({ ...apiCall(path, method, body), backendId });
  const version = async (expected: string) => {
    const { backends } = await rpc<{ backends: { id: string; version: string; connected: boolean }[] }>(
      '/backends',
    );
    const plugin = backends.find((row) => row.id === backendId);
    assert.deepEqual([plugin?.version, plugin?.connected], [expected, true]);
    assert.deepEqual(
      backends.filter((row) => row.id === 'second-fixture').map((row) => [row.version, row.connected]),
      [['1.0.0', true]],
    );
    assert.equal(backends.find((row) => row.id === 'missing-fixture')?.connected, false);
  };
  const watch = async () => {
    let synced = false;
    const remove = session!.onEvent((packet) => {
      if (packet.type === 'sync' && packet.backendId === backendId)
        synced = packet.updates.some(
          (update: { thread: { synchronized?: boolean } }) => update.thread.synchronized === true,
        );
    });
    try {
      await session!.request('watch', { backendId, threadId: thread });
      await until(() => synced);
    } finally {
      remove();
    }
  };
  const reconnect = async () => {
    await stop();
    await launch();
    session = await nodeSession(origin, host, phone, ticket, {
      type: 'authenticate',
      protocol: 2,
      sessionId: randomUUID(),
    });
    await session.ready;
  };
  const history = () => rpc<{ messages: { text: string }[] }>(`/threads/${thread}/history`);
  await version('1.0.0');
  assert.equal((await rpc<{ threads: { id: string }[] }>('/threads')).threads[0].id, thread);
  await watch();
  for (const text of ['first message', 'crash-after-write']) {
    const send = { requestId: randomUUID(), text };
    await rpc(`/threads/${thread}/messages`, 'POST', send);
    await until(
      async () => (await rpc<{ state: string }>('/operations/' + send.requestId)).state === 'completed',
    );
    await rpc(`/threads/${thread}/messages`, 'POST', send);
  }
  assert.deepEqual(
    (await history()).messages.map((message) => message.text),
    ['first message', 'crash-after-write'],
  );
  const second = await session.rpc<{ messages: unknown[] }>({
    ...apiCall(`/threads/${thread}/history`),
    backendId: 'second-fixture',
  });
  assert.deepEqual(second.messages, []);
  assert.throws(() => cli('upgrade', backendId, name + '@2.0.0'));
  await config('1.1.0');
  await reconnect();
  await version('1.0.0');
  await watch();
  let stale = false;
  let restored = false;
  const remove = session!.onEvent((packet) => {
    if (packet.type !== 'sync' || packet.backendId !== backendId) return;
    for (const { thread } of packet.updates) {
      if (thread.synchronized === false) stale = true;
      if (stale && thread.synchronized === true) restored = true;
    }
  });
  const slow = { requestId: randomUUID(), text: 'slow-write' };
  await rpc(`/threads/${thread}/messages`, 'POST', slow);
  const marker = join(state, 'native-plugins', 'instances', backendId, 'write-in-flight');
  await until(() =>
    access(marker).then(
      () => true,
      () => false,
    ),
  );
  const upgrade = cliAsync('upgrade', backendId, name + '@1.1.0');
  try {
    await delay(1100);
    assert.equal(
      JSON.parse(cli('list')).instances.find((row: { instance: string }) => row.instance === backendId)
        .current,
      name + '@1.0.0',
    );
    await assert.rejects(
      rpc(`/threads/${thread}/messages`, 'POST', { requestId: randomUUID(), text: 'during-upgrade' }),
    );
  } finally {
    assert.match(await upgrade, /1\.1\.0/);
  }
  await until(() => restored);
  remove();
  await version('1.1.0');
  assert.equal((await rpc<{ state: string }>('/operations/' + slow.requestId)).state, 'completed');
  const texts = async () => (await history()).messages.map((message) => message.text);
  const expected = ['first message', 'crash-after-write', 'slow-write'];
  assert.deepEqual(await texts(), expected);
  await assert.rejects(cliAsync('upgrade', backendId, name + '@1.2.0'), /已保留旧版本/);
  await version('1.1.0');
  assert.deepEqual(await texts(), expected);
  assert.match(await cliAsync('rollback', backendId), /1\.0\.0/);
  await version('1.0.0');
  assert.deepEqual(await texts(), expected);
  await stop();
  const queued = cli('upgrade', backendId, name + '@1.1.0');
  const request = queued.match(/已排队，请求 ([\da-f-]+)）/)?.[1];
  assert(request);
  assert.equal(JSON.parse(cli('result', request)).outcome, null);
  await reconnect();
  await until(() => JSON.parse(cli('result', request)).outcome === 'applied');
  await version('1.1.0');
  assert.deepEqual(await texts(), expected);
  console.log(
    'Native plugin: pinned installs, isolated state, crash recovery, online drain and cutover, failed upgrade recovery, rollback and offline queue passed.',
  );
} finally {
  await stop();
  await relay.app.close();
  await rm(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(packages, { recursive: true, force: true });
}
