/** Isolated automated test fixture; never uses the user's real desktop/state. */
import { resolve, join } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fixtureConfig, historyFixture, FakeTransport, THREAD, state } from '../test/helpers.js';
import { Store } from '../src/server/store.js';
import { HistoryIndex } from '../src/server/history.js';
import { DesktopAdapter } from '../src/server/desktop.js';
import { HostService } from '../src/server/host-service.js';
import { buildRelay } from '../src/server/relay.js';
import { createIdentity } from '../src/shared/secure-channel.js';
const config = fixtureConfig();
historyFixture(config);
config.port = Number(process.env.TEST_PORT ?? 18917);
config.origin = `http://127.0.0.1:${config.port}`;
config.webRoot = resolve('.implementation/web');
config.p2p = { enabled: process.env.TEST_DIRECT !== '0', stunUrls: [] };
config.relay = { origin: config.origin, enrollment: 'fixture-only-enrollment-secret-32-chars' };
const file = join(config.desktopRoot, 'fixture.txt');
await writeFile(file, 'private-file-fixture\n'.repeat(100000));
const audio = join(config.desktopRoot, 'fixture.wav');
const samples = 48000 * 20,
  wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(48000, 24);
wav.writeUInt32LE(96000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(samples * 2, 40);
await writeFile(audio, wav);
const native = new FakeTransport();
native.current = state({ cwd: config.desktopRoot });
native.current.turnHistory.history.entitiesByKey.one.items.push({
  type: 'agentMessage',
  id: 'attachment',
  text: `[测试附件](${file})`,
});
native.current.turnHistory.history.entitiesByKey.one.items.push({
  type: 'agentMessage',
  id: 'audio',
  text: `[测试音频](${audio})`,
});
const db = new DatabaseSync(join(config.codexHome, 'state_5.sqlite'));
db.prepare('UPDATE threads SET cwd=?').run(config.desktopRoot);
db.close();
const store = new Store(config.stateDir),
  history = new HistoryIndex(config.codexHome),
  desktop = new DesktopAdapter(config, () => native);
const identity = await createIdentity(),
  host = new HostService(config, identity, { store, history, desktop });
const relay = await buildRelay({
  origin: config.origin,
  webRoot: config.webRoot,
  assetOrigin: null,
  enrollmentSecret: config.relay.enrollment,
  uploadOrigins: [],
});
await relay.app.listen({ port: config.port, host: '127.0.0.1' });
await desktop.start();
host.start();
const pair = store.mintPairing();
await writeFile(
  '.implementation/fixture.json',
  JSON.stringify({
    origin: config.origin,
    hostId: identity.peerId,
    code: pair.code,
    threadId: THREAD,
    file,
    stateDir: config.stateDir,
  }),
  { mode: 0o600 },
);
console.log(`Isolated v2 fixture ready on loopback:${config.port}`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  host.stop();
  desktop.stop();
  history.close();
  store.close();
  await relay.app.close();
  await rm(config.desktopRoot, { recursive: true, force: true });
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());

export { config, host, relay, store, native, close, file };
