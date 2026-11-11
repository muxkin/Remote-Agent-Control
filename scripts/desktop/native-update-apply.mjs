import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [artifact, executable, parent, manager, version, digest, size, publisher = 'platform'] =
  process.argv.slice(2);
const releaseKeyOnly = publisher === 'release-key';
const stage = dirname(artifact);
const directory = dirname(stage);
if (
  !/^\.native-update-[a-zA-Z0-9]+$/.test(basename(stage)) ||
  !/^\d+\.\d+\.\d+$/.test(version) ||
  !/^[a-f0-9]{128}$/.test(digest) ||
  (publisher !== 'platform' && !(releaseKeyOnly && ['win32', 'darwin'].includes(process.platform))) ||
  ![parent, manager, size].every((value) => /^[1-9]\d*$/.test(value))
)
  throw Error('Invalid native update handoff');

function alive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function verifyArtifact() {
  let length = 0;
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(artifact)) {
    length += chunk.length;
    if (length > Number(size)) throw Error('Invalid update size');
    hash.update(chunk);
  }
  if (length !== Number(size) || hash.digest('hex') !== digest) throw Error('Invalid update hash');
}

function command(path, args, options = {}) {
  return execFileSync(path, args, { stdio: 'ignore', windowsHide: true, timeout: 600000, ...options });
}

async function restart() {
  const launchApp = releaseKeyOnly && process.platform === 'darwin';
  const app = dirname(dirname(dirname(executable)));
  const child = spawn(
    launchApp ? '/usr/bin/open' : executable,
    launchApp ? ['-a', app, '--args', '--background'] : ['--background'],
    {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    },
  );
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
}

async function verifyAuthenticode() {
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  command(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'if ((Get-AuthenticodeSignature -LiteralPath $env:POCKET_NATIVE_UPDATE_ARTIFACT).Status -ne "Valid") { exit 1 }',
    ],
    { env: { ...process.env, POCKET_NATIVE_UPDATE_ARTIFACT: artifact } },
  );
}

async function replaceWindows() {
  if (!releaseKeyOnly) await verifyAuthenticode();
  const install = dirname(executable);
  const backup = await mkdtemp(join(install, '.previous-'));
  const moved = [];
  let preserve = false;
  try {
    for (const name of [basename(executable), 'gateway']) {
      await rename(join(install, name), join(backup, name));
      moved.push(name);
    }
    command(artifact, ['/S']);
  } catch (error) {
    for (const name of moved.reverse()) {
      try {
        await rm(join(install, name), { recursive: true, force: true });
        await rename(join(backup, name), join(install, name));
      } catch {
        preserve = true;
      }
    }
    throw error;
  } finally {
    if (!preserve) await rm(backup, { recursive: true, force: true }).catch(() => {});
  }
}

async function replaceMacApp() {
  const app = dirname(dirname(dirname(executable)));
  const folder = dirname(app);
  if (basename(app) !== 'Agent Space Adapter.app') throw Error('Invalid installation path');
  const mount = join(stage, 'dmg');
  await mkdir(mount);
  command('/usr/bin/hdiutil', ['attach', artifact, '-readonly', '-nobrowse', '-mountpoint', mount]);
  let transaction;
  try {
    const next = join(mount, basename(app));
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', next]);
    if (!releaseKeyOnly) command('/usr/sbin/spctl', ['--assess', '--type', 'execute', next]);
    transaction = await mkdtemp(join(folder, '.agent-space-update-'));
    const incoming = join(transaction, basename(app));
    const backup = join(transaction, 'previous.app');
    command('/usr/bin/ditto', [next, incoming]);
    await rename(app, backup);
    try {
      await rename(incoming, app);
    } catch (error) {
      await rename(backup, app).catch(() => {
        transaction = undefined;
      });
      throw error;
    }
  } finally {
    if (transaction) await rm(transaction, { recursive: true, force: true }).catch(() => {});
    try {
      command('/usr/bin/hdiutil', ['detach', mount]);
    } catch {}
  }
}

async function apply() {
  const deadline = Date.now() + 30000;
  while (alive(parent) || alive(manager)) {
    if (Date.now() >= deadline) return;
    await delay(250);
  }
  try {
    await verifyArtifact();
    const attempt = join(directory, `.update-attempt-${randomUUID()}`);
    await writeFile(attempt, JSON.stringify({ version, time: Date.now() }), { mode: 0o600, flag: 'wx' });
    await rename(attempt, join(directory, 'native-update-attempt.json'));
    if (process.platform === 'win32') await replaceWindows();
    else if (process.platform === 'darwin') await replaceMacApp();
    else if (process.platform === 'linux' && executable === '/usr/bin/agent-space-native')
      command('/usr/bin/pkexec', ['/usr/bin/apt-get', '-y', 'install', '--', artifact]);
  } finally {
    await restart();
  }
}

try {
  await apply();
} catch {
  process.exitCode = 1;
} finally {
  // Windows retains the running helper executable until process exit.
  if (process.platform === 'win32') await rm(artifact, { force: true }).catch(() => {});
  else await rm(stage, { recursive: true, force: true }).catch(() => {});
}
