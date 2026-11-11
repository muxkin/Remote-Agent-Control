import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { nodeSession } from '../../src/client/node-session.js';
import { hostIdentity } from '../../src/server/device-identity.js';
import { platformRuntime } from '../../src/server/platform.js';
import { buildRelay } from '../../src/server/relay.js';
import { Store } from '../../src/server/store.js';
import { apiCall } from '../../src/shared/rpc.js';
import { createIdentity } from '../../src/shared/secure-channel.js';
import { historyFixture, THREAD } from '../../test/helpers.js';

const root = await mkdtemp(join(tmpdir(), 'agent-space-managed-'));
const codexHome = join(root, 'codex');
const state = join(root, 'state');
const executable = resolve(process.argv[2] ?? 'desktop/native/target/release/agent-space-native');
historyFixture({ codexHome } as Parameters<typeof historyFixture>[0]);
const platform = platformRuntime();
platform.privateDirectory(state);
const phone = await createIdentity();
const identity = await hostIdentity(state);
const store = new Store(state);
const previous = store.pair(store.mintPairing().code, 'Existing phone', phone.peerId);
store.close();
assert(previous?.routeTicket);
const upload = randomUUID();
const legacy = Buffer.from('Existing native attachment');
const legacyPath = join(state, 'native-uploads', upload, 'attachment.txt');
await mkdir(join(state, 'native-uploads', upload), { recursive: true, mode: 0o700 });
await writeFile(legacyPath, legacy, { mode: 0o600 });
const db = new DatabaseSync(join(state, 'state.sqlite'));
db.exec('CREATE TABLE native_uploads (id TEXT, device TEXT, thread TEXT, manifest TEXT, complete INTEGER)');
db.prepare('INSERT INTO native_uploads VALUES (?,?,?,?,1)').run(
  upload,
  previous.deviceId,
  THREAD,
  JSON.stringify({
    name: 'saved.txt',
    size: legacy.length,
    sha256: createHash('sha256').update(legacy).digest('hex'),
  }),
);
db.close();
if (process.platform === 'win32')
  for (const file of ['device-identity-v2.json', 'state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm'])
    if (existsSync(join(state, file))) platform.privateFile(join(state, file));

const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const address = probe.address();
assert(address && typeof address !== 'string');
await new Promise<void>((done) => probe.close(() => done()));
const origin = `http://127.0.0.1:${address.port}`;
const enrollment = randomBytes(32).toString('hex');
await writeFile(
  join(state, 'instances.json'),
  JSON.stringify(
    ['dsh-one', 'dsh-two'].map((id) => ({
      id,
      name: id,
      plugin: '@agent-remote/adapter-dsh',
      version: '1.0.2',
      config: { url: origin, version: 'fixture' },
      secrets: { token: 'DSH_TEST_TOKEN' },
    })),
  ),
  { mode: 0o600 },
);
const relay = await buildRelay({
  origin,
  enrollmentSecret: enrollment,
  webRoot: join(root, 'no-web'),
  assetOrigin: null,
  uploadOrigins: [],
});
let child: ReturnType<typeof spawn> | undefined;
try {
  await relay.app.listen({ host: '127.0.0.1', port: address.port });
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(POCKET_|CODEX_|NODE_)/i.test(key)),
    ),
    POCKET_NATIVE_GATEWAY_PAYLOAD: process.env.POCKET_NATIVE_GATEWAY_PAYLOAD,
    POCKET_ENV_FILE: devNull,
    POCKET_NATIVE_STATE_DIR: state,
    POCKET_NATIVE_ORIGIN: origin,
    POCKET_NATIVE_ENROLLMENT: enrollment,
    POCKET_NATIVE_CODEX_HOME: codexHome,
    POCKET_NATIVE_P2P: '0',
    POCKET_NATIVE_UPDATES: '0',
    DSH_TEST_TOKEN: 'fixture-only',
  };
  child = spawn(executable, ['--headless', '--print-pair'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'close');
  void exited.catch(() => {});
  const lines = createInterface({ input: child.stdout! });
  const timeout = setTimeout(() => child?.kill(), 90000);
  try {
    let link;
    for await (const line of lines)
      if (line.startsWith(origin)) {
        link = new URL(line);
        break;
      }
    assert(
      link && new URLSearchParams(link.hash.slice(1)).get('host') === identity.peerId,
      'Pairing must preserve host identity',
    );
    const session = await nodeSession(origin, identity.peerId, phone, previous.routeTicket, {
      type: 'authenticate',
      protocol: 2,
      sessionId: randomUUID(),
    });
    try {
      const result = await session.rpc<{ backends: { id: string; product: string }[] }>(apiCall('/backends'));
      assert.deepEqual(
        result.backends.map(({ id, product }) => [id, product]),
        [
          ['codex-local', 'codex'],
          ['dsh-one', 'dsh'],
          ['dsh-two', 'dsh'],
        ],
      );
      const history = await session.rpc<{ messages: { text: string }[] }>(
        apiCall(`/threads/${THREAD}/history`),
      );
      assert(history.messages.some(({ text }) => text === '历史消息'));
      const file = await session.rpc<{ name: string; size: number }>(
        apiCall(`/threads/${THREAD}/media`, 'POST', { path: legacyPath }),
      );
      assert.deepEqual([file.name, file.size], ['saved.txt', legacy.length]);
    } finally {
      session.close();
    }
    const statusFile = join(state, 'adapters', 'status.json');
    for (let i = 0; i < 80; i++) {
      const status = JSON.parse(await readFile(statusFile, 'utf8'));
      if (status.instances.every(({ pid }: { pid?: number }) => Number.isInteger(pid))) {
        assert.equal(new Set(status.instances.map(({ pid }: { pid: number }) => pid)).size, 3);
        break;
      }
      if (i === 79) throw Error('Official plugins did not start independent hosts');
      await delay(250);
    }
    const cli = spawn(executable, ['--adapter', 'list'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
    assert.equal((await once(cli, 'close'))[0], 0);
    console.log(
      'Ely managed gateway: existing identity, pairing, native attachment, Codex history and separate DSH plugin hosts passed.',
    );
  } finally {
    lines.close();
    clearTimeout(timeout);
    child.kill('SIGINT');
    await exited.catch(() => {});
    for (let i = 0; i < 60 && existsSync(join(state, 'adapters', 'supervisor.json')); i++) await delay(250);
    assert(!existsSync(join(state, 'adapters', 'supervisor.json')), 'Plugin gateway did not shut down');
  }
} finally {
  await relay.app.close();
  await rm(root, { recursive: true, force: true });
}
