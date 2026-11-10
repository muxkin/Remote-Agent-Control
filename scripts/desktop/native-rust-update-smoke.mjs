import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildInstaller } from './native-installer.mjs';
import { updateFilename } from './native-update.mjs';

const run = promisify(execFile);
const [distribution, newBinary] = process.argv.slice(2).map((path) => resolve(path));
assert(distribution && newBinary, 'Usage: native-rust-update-smoke.mjs DISTRIBUTION NEW_BINARY');
assert(
  process.env.GITHUB_ACTIONS === 'true' || process.env.POCKET_QA_DISPOSABLE_INSTALL === '1',
  'Run this installer test in a disposable runner or VM',
);
const platform = process.platform;
const arch = process.arch;
assert(platform === 'linux' || platform === 'win32' || platform === 'darwin');
const program = platform === 'win32' ? 'agent-space-native.exe' : 'agent-space-native';
const lf = (text) => text.replaceAll('\r\n', '\n');
const manifest = lf(await readFile('desktop/native/Cargo.toml', 'utf8'));
const release = manifest.match(/^version = "(\d+\.\d+\.\d+)"$/m)?.[1];
assert(release && release !== '0.0.0');
const filename = updateFilename(release, platform, arch);
const installer = join(distribution, filename);
const payload = await readFile(installer);
const directory = await mkdtemp(join(tmpdir(), 'native-rust-update-smoke-'));
const binDir = dirname(newBinary);
const targetDir = dirname(binDir);
const root = join(directory, 'fixture');
const crate = join(root, 'desktop', 'native');
const staged = join(directory, 'old-package');
const oldBinary = join(binDir, platform === 'win32' ? 'agent-space-update-fixture.exe' : 'agent-space-update-fixture');
const oldInstaller = join(directory, updateFilename('0.0.0', platform, arch));
const releaseKey = generateKeyPairSync('ed25519');
const foreignKey = generateKeyPairSync('ed25519');
const cargoOptions = { maxBuffer: 20 * 1024 * 1024, timeout: 15 * 60_000 };
let server;
let installed;

async function digest(path) {
  const hash = createHash('sha512');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

async function mountedMacApp(image, mount, action) {
  await mkdir(mount);
  await run('hdiutil', ['attach', image, '-readonly', '-nobrowse', '-mountpoint', mount]);
  try {
    return await action(join(mount, 'Agent Space Adapter.app'));
  } finally {
    await run('hdiutil', ['detach', mount]);
  }
}

async function buildOldAdapter() {
  await mkdir(crate, { recursive: true });
  await cp('desktop/native/src', join(crate, 'src'), { recursive: true });
  for (const file of ['build.rs', 'agent-space.rc']) await cp(join('desktop/native', file), join(crate, file));
  await writeFile(join(crate, 'update-release.pub'), releaseKey.publicKey.export({ type: 'spki', format: 'pem' }));
  const previous = manifest
    .replace(/^version = "[^"]+"$/m, 'version = "0.0.0"')
    .replace(/^default-run = .*\n/m, '');
  await writeFile(join(crate, 'Cargo.toml'), previous + '\n[[bin]]\nname = "agent-space-update-fixture"\npath = "src/main.rs"\n');
  const lock = lf(await readFile('desktop/native/Cargo.lock', 'utf8'));
  await writeFile(join(crate, 'Cargo.lock'), lock.replace(
    /(name = "agent-space-native"\nversion = ")[^"]+(")/, (_match, prefix, suffix) => prefix + '0.0.0' + suffix,
  ));
  const args = ['--release', '--locked', '--no-default-features', '--manifest-path', join(crate, 'Cargo.toml'),
    '--target-dir', targetDir];
  await run('cargo', ['build', ...args, '--bin', 'agent-space-update-fixture'], cargoOptions);
  const tests = await run('cargo', ['test', ...args, '--lib', '--no-run', '--message-format=json'], cargoOptions);
  const testBinary = tests.stdout.split('\n').filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .find((item) => item.reason === 'compiler-artifact' && item.target.kind.includes('lib') && item.profile.test)?.executable;
  assert.equal(typeof testBinary, 'string', 'The update test executable is missing');
  await mkdir(staged);
  await cp(oldBinary, join(staged, program));
  await cp('LICENSE', join(staged, 'LICENSE'));
  for (const file of ['README.txt', 'THIRD-PARTY-NOTICES.txt'])
    await writeFile(join(staged, file), 'Disposable signed-update test fixture\n');
  await buildInstaller(platform, staged, '0.0.0', oldInstaller);
  return testBinary;
}

async function installOldAdapter() {
  if (platform === 'linux') {
    const args = ['-i', oldInstaller];
    if (process.getuid?.() === 0) await run('dpkg', args);
    else await run('sudo', ['-n', 'dpkg', ...args]);
    return '/usr/bin/agent-space-native';
  }
  if (platform === 'win32') {
    assert(process.env.LOCALAPPDATA);
    await run(oldInstaller, ['/S'], { timeout: 60_000 });
    return join(process.env.LOCALAPPDATA, 'Programs', 'Agent Space Adapter', program);
  }
  const app = 'Agent Space Adapter.app';
  await mountedMacApp(oldInstaller, join(directory, 'old-mount'), (source) =>
    run('ditto', [source, join(directory, app)]),
  );
  return join(directory, app, 'Contents', 'MacOS', program);
}

async function serveRelease() {
  const ca = join(directory, 'ca.pem');
  const caKey = join(directory, 'ca-key.pem');
  const key = join(directory, 'https-key.pem');
  const certificate = join(directory, 'https.pem');
  const request = join(directory, 'https.csr');
  const extensions = join(directory, 'extensions.cnf');
  await writeFile(extensions, 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=Native Update QA CA', '-keyout', caKey, '-out', ca]);
  await run('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1',
    '-keyout', key, '-out', request]);
  await run('openssl', ['x509', '-req', '-in', request, '-CA', ca, '-CAkey', caKey, '-CAcreateserial',
    '-days', '1', '-extfile', extensions, '-out', certificate]);
  const document = Buffer.from(JSON.stringify({
    format: 1, runtime: 'rust', version: release, platform, arch, file: filename,
    size: payload.length, sha512: createHash('sha512').update(payload).digest('hex'),
    ...(platform !== 'linux' && { publisher: 'release-key' }),
  }));
  const envelope = (key) => JSON.stringify({
    payload: document.toString('base64'),
    signature: sign(null, document, key).toString('base64'),
  });
  const corrupt = Buffer.from(payload);
  corrupt[0] ^= 1;
  const requests = [];
  const root = `/${platform}/${arch}/`;
  const good = '/downloads/desktop/native/rust' + root;
  server = createServer({ key: await readFile(key), cert: await readFile(certificate) }, (req, res) => {
    const path = req.url ?? '';
    requests.push(path);
    for (const name of ['good', 'corrupt', 'foreign', 'redirect', 'partial', 'abandoned']) {
      const prefix = name === 'good' ? good : '/' + name + root;
      if (path === prefix + 'latest.json') {
        if (name === 'redirect') {
          res.writeHead(302, { Location: good + 'latest.json' }).end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(
            envelope(name === 'foreign' ? foreignKey.privateKey : releaseKey.privateKey),
          );
        }
        return;
      }
      if (path === prefix + filename && ['good', 'corrupt', 'partial', 'abandoned'].includes(name)) {
        res.writeHead(200, { 'Content-Length': payload.length });
        if (name === 'partial') {
          res.socket?.setNoDelay(true);
          res.flushHeaders();
          res.write(payload.subarray(0, 256 * 1024));
        } else res.end(name === 'corrupt' ? corrupt : payload);
        return;
      }
    }
    res.writeHead(404).end();
  });
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { origin: `https://127.0.0.1:${address.port}/`, ca, requests, root, good };
}

try {
  const test = await buildOldAdapter();
  // codesign embeds the signature in the Mach-O binary inside the packaged application.
  const packagedDigest = (image, name) =>
    mountedMacApp(image, join(directory, name), (app) => digest(join(app, 'Contents', 'MacOS', program)));
  const expected = platform === 'darwin' ? await packagedDigest(installer, 'new-hash') : await digest(newBinary);
  const previous = platform === 'darwin' ? await packagedDigest(oldInstaller, 'old-hash') : await digest(oldBinary);
  installed = await installOldAdapter();
  assert.equal(await digest(installed), previous, 'The old installer did not install the expected executable');
  assert.notEqual(previous, expected, 'The update fixture needs distinct old and new executables');
  const { origin, ca, requests, root, good } = await serveRelease();
  const env = {
    POCKET_QA_UPDATE_ORIGIN: origin,
    POCKET_QA_UPDATE_CA: ca,
    POCKET_QA_UPDATE_STATE: join(directory, 'state'),
    POCKET_QA_UPDATE_EXE: installed,
    POCKET_QA_UPDATE_SHA512: expected,
    POCKET_QA_UPDATE_VERSION: release,
  };
  const args = ['update::tests::installed_release_smoke', '--ignored', '--exact', '--nocapture'];
  const timeout = 220_000;
  const runEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(POCKET_|DISPLAY$|WAYLAND_DISPLAY$)/i.test(key))),
    ...env,
  };
  const result = platform === 'linux' && process.getuid?.() !== 0
    ? await run('sudo', ['-n', 'env', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), test, ...args], { timeout })
      .catch(reportRequests)
    : await run(test, args, { env: runEnv, timeout }).catch(reportRequests);
  function reportRequests(error) {
    console.error('Isolated fixture requests:', requests.join(', ') || '(none)');
    throw error;
  }
  process.stdout.write(result.stdout);
  assert.equal(requests.filter((path) => path === good + 'latest.json').length, 1);
  assert(requests.includes(good + filename));
  assert(requests.includes('/corrupt' + root + filename));
  assert(requests.includes('/partial' + root + filename));
  assert(requests.includes('/abandoned' + root + filename));
  assert(!requests.includes('/foreign' + root + filename));
  assert.equal(await digest(installed), expected);
} finally {
  server?.closeAllConnections();
  if (server) await new Promise((done) => server.close(() => done()));
  if (installed && platform === 'win32') {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:QA_UPDATE_EXE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
    ], { env: { ...process.env, QA_UPDATE_EXE: installed } }).catch(() => {});
    await run(join(dirname(installed), 'Uninstall.exe'), ['/S']).catch(() => {});
  }
  if (installed && platform === 'darwin') {
    const path = await realpath(installed).catch(() => installed);
    const literal = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await run('pkill', ['-f', `^${literal}( |$)`]).catch(() => {});
  }
  if (platform === 'linux' && process.getuid?.() !== 0)
    await run('sudo', ['-n', 'rm', '-rf', '--', join(directory, 'state')]);
  await rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  await rm(oldBinary, { force: true });
}
