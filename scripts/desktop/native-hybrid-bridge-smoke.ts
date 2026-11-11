import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer as httpsServer } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { nodeSession } from '../../src/client/node-session.js';
import { hostIdentity } from '../../src/server/device-identity.js';
import { buildRelay } from '../../src/server/relay.js';
import { Store } from '../../src/server/store.js';
import { createIdentity } from '../../src/shared/secure-channel.js';

const run = promisify(execFile);
const gateway = '/usr/lib/agent-space-native/gateway';
const executable = '/usr/bin/agent-space-native';
const oldNode = join(gateway, 'runtime/node');
const versionOf = async (file: string) => (await run('dpkg-deb', ['--field', file, 'Version'])).stdout.trim();

assert(process.platform === 'linux' && process.arch === 'x64' && process.getuid?.() === 0 &&
  process.env.POCKET_QA_DISPOSABLE_INSTALL === '1', 'Run as root in a disposable Linux x64 container or VM');

if (process.argv[2] === '--supervise-legacy') {
  await superviseLegacy();
} else {
  await checkBridge();
}

async function superviseLegacy() {
  const legacy = spawn(oldNode, ['--import', join(gateway, 'scripts/env.mjs'),
    join(gateway, 'scripts/native-manager.mjs'), executable], {
    cwd: gateway, stdio: ['pipe', 'pipe', 'inherit'], signal: AbortSignal.timeout(90_000),
  });
  let confirmed = false;
  let handoff = false;
  const lines = createInterface({ input: legacy.stdout });
  lines.on('line', (line) => {
    const event = JSON.parse(line);
    if (event.type === 'exit-for-update') handoff = true;
    if (!confirmed && event.relayConnected && event.safeToRestart && event.manualUpdate && event.update?.includes('已下载')) {
      confirmed = true;
      legacy.stdin.write('install-update\n');
    }
  });
  assert.equal((await once(legacy, 'close'))[0], 0);
  assert(handoff && confirmed, 'The archived manager did not hand off the signed update');
}

async function checkBridge() {
  assert(!existsSync(executable) && !existsSync(gateway), 'The disposable runner must start without an installed adapter');
  const [oldInstaller, installer, newBinary] = process.argv.slice(2).map((file) => resolve(file));
  assert(oldInstaller && installer && newBinary, 'Pass the archived v0.2.8 DEB, the Rust DEB and its matching binary');
  assert.equal(await versionOf(oldInstaller), '0.2.8');
  const version = await versionOf(installer);
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const file = `AgentSpace-Native-${version}-linux-x64.deb`;
  assert.equal(basename(installer), file);

  const directory = await mkdtemp(join(tmpdir(), 'native-hybrid-bridge-'));
  const state = join(directory, 'state');
  const home = join(directory, 'home');
  await mkdir(state, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  await run('dpkg', ['-i', oldInstaller]);
  assert(existsSync(oldNode), 'The archived package must contain the legacy Node gateway');
  const key = generateKeyPairSync('ed25519');
  await writeFile(join(gateway, 'native-update-key.pem'), key.publicKey.export({ type: 'spki', format: 'pem' }));
  const certificate = join(directory, 'localhost.pem');
  const tlsKey = join(directory, 'localhost.key');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', tlsKey, '-out', certificate]);
  const bytes = await readFile(installer);
  const hash = (data: Buffer) => createHash('sha512').update(data).digest('hex');
  const payload = Buffer.from(JSON.stringify({
    format: 1, runtime: 'rust', version, platform: 'linux', arch: 'x64', file, size: bytes.length, sha512: hash(bytes),
  }));
  const manifest = JSON.stringify({
    payload: payload.toString('base64'), signature: sign(null, payload, key.privateKey).toString('base64'),
  });
  const channel = '/channel/native/';
  const feed = channel + 'linux/x64/';
  const paths = new Set<string>();
  const server = httpsServer({ key: await readFile(tlsKey), cert: await readFile(certificate) }, (req, res) => {
    const path = req.url ?? '';
    paths.add(path);
    if (path === feed + 'latest.json') res.end(manifest);
    else if (path === feed + file) res.writeHead(200, { 'Content-Length': bytes.length }).end(bytes);
    else res.writeHead(404).end();
  });
  const port = async (listener: ReturnType<typeof createServer> | typeof server) => {
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    assert(address && typeof address !== 'string');
    return address.port;
  };
  const updateOrigin = `https://127.0.0.1:${await port(server)}${channel}`;
  const portFinder = createServer();
  const relayPort = await port(portFinder);
  await new Promise<void>((done) => portFinder.close(() => done()));
  const origin = `http://127.0.0.1:${relayPort}`;
  const enrollmentSecret = randomBytes(32).toString('hex');
  const { app } = await buildRelay({ origin, webRoot: join(directory, 'web'), enrollmentSecret, assetOrigin: null, uploadOrigins: [] });

  try {
    await app.listen({ host: '127.0.0.1', port: relayPort });
    const host = await hostIdentity(state);
    const phone = await createIdentity();
    const store = new Store(state);
    const paired = store.pair(store.mintPairing().code, 'Existing hybrid phone', phone.peerId);
    store.close();
    assert(paired?.routeTicket);
    const identityPath = join(state, 'device-identity-v2.json');
    const identityBefore = await readFile(identityPath);
    const environmentFile = join(state, 'gateway.env');
    await writeFile(join(state, 'service-origin'), origin, { mode: 0o600 });
    await writeFile(environmentFile, `POCKET_NATIVE_UPDATE_BASE_URL=${updateOrigin}\n`, { mode: 0o600 });
    const env = {
      PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
      POCKET_STATE_DIR: state, POCKET_NATIVE_STATE_DIR: state, POCKET_PUBLIC_ORIGIN: origin, POCKET_NATIVE_VERSION: '0.2.8',
      POCKET_RELAY_ENROLLMENT: enrollmentSecret, POCKET_ENV_FILE: environmentFile, POCKET_NATIVE_P2P: '0', POCKET_READ_ONLY: '1',
      NODE_EXTRA_CA_CERTS: certificate, POCKET_QA_DISPOSABLE_INSTALL: '1',
    };

    // The legacy updater waits for its manager and the manager's parent to exit.
    await run(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--supervise-legacy'], {
      env, timeout: 95_000,
    });

    const connectionDeadline = Date.now() + 45_000;
    let deviceId: string | undefined;
    while (!deviceId && Date.now() < connectionDeadline) {
      const installed = (await run('dpkg-query', ['-W', '-f=${Version}', 'agent-space-native'])).stdout;
      if (installed === version) {
        const session = await nodeSession(origin, host.peerId, phone, paired.routeTicket, {
          type: 'authenticate', protocol: 2, sessionId: crypto.randomUUID(),
        }).catch(() => null);
        if (session) {
          try { deviceId = (await session.ready).device.id; } catch {} finally { session.close(); }
        }
      }
      if (!deviceId) await delay(250);
    }
    assert.equal(deviceId, paired.deviceId, 'The restarted Rust adapter did not reconnect the existing paired device');
    assert(!existsSync(gateway), 'The upgraded package retained the bundled legacy gateway');
    assert.equal(hash(await readFile(executable)), hash(await readFile(newBinary)));
    assert.deepEqual(await readFile(identityPath), identityBefore);
    assert(paths.has(feed + 'latest.json') && paths.has(feed + file));

    const preferences = JSON.parse(await readFile(join(state, 'native-update-settings.json'), 'utf8'));
    assert.equal(preferences.updateBaseURL, updateOrigin + 'rust/');
    assert.equal(preferences.autoUpdate, true);
    const plugins = JSON.parse((await run(executable, ['--adapter', 'list'], { env })).stdout);
    assert.deepEqual(plugins.packages, [`@agent-remote/adapter-codex@${version}`, `@agent-remote/adapter-dsh@${version}`]);
    assert(plugins.instances.some((binding: { instance: string; current: string }) =>
      binding.instance === 'codex-local' && binding.current === `@agent-remote/adapter-codex@${version}`));
    console.log(`Archived hybrid 0.2.8 upgraded to Rust ${version}, preserving device identity, pairing and its custom update channel.`);
  } finally {
    server.closeAllConnections();
    await Promise.all([new Promise<void>((done) => server.close(() => done())), app.close()]);
  }
}
