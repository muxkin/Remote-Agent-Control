import { spawn } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const maximum = 512 * 1024 * 1024;
const versionPattern = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;
const fourHours = 4 * 60 * 60 * 1000;

export function updateFilename(version, platform, arch) {
  if (typeof version !== 'string' || !versionPattern.test(version)) throw Error('更新版本无效');
  const suffix = {
    'linux/x64': 'linux-x64.deb',
    'win32/x64': 'windows-x64-setup.exe',
    'darwin/x64': 'macos-x64.dmg',
    'darwin/arm64': 'macos-arm64.dmg',
  }[`${platform}/${arch}`];
  if (!suffix) throw Error('不支持此更新平台');
  return `AgentSpace-Native-${version}-${suffix}`;
}

export function verifyManifest(document, key, current, platform, arch) {
  const envelope = JSON.parse(document);
  const bytes = Buffer.from(envelope.payload, 'base64');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, signature))
    throw Error('更新签名无效');
  const release = JSON.parse(bytes);
  if (
    release.format !== 1 ||
    release.platform !== platform ||
    release.arch !== arch ||
    release.file !== updateFilename(release.version, platform, arch) ||
    !Number.isInteger(release.size) ||
    release.size < 1 ||
    release.size > maximum ||
    typeof release.sha512 !== 'string' ||
    !/^[a-f0-9]{128}$/.test(release.sha512)
  )
    throw Error('更新清单无效');
  if (!versionPattern.test(current)) throw Error('当前版本无效');
  const installed = current.split('.').map(Number);
  const delta = release.version.split('.').map((value, i) => Number(value) - installed[i]);
  return (delta.find(Boolean) ?? 0) > 0 ? release : null;
}

function updateFeed(origin, override, platform, arch) {
  const base = new URL(override || '/downloads/desktop/native/', origin);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw Error('原生更新源必须使用 HTTPS');
  base.pathname = base.pathname.replace(/\/*$/, '/');
  return new URL(`${platform}/${arch}/`, base);
}

async function manifest(feed, signal) {
  const response = await fetch(new URL('latest.json', feed), {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok || !response.body) throw Error('暂无可用更新清单');
  const bytes = [];
  let size = 0;
  for await (const block of response.body) {
    size += block.length;
    if (size > 16384) throw Error('更新清单过大');
    bytes.push(block);
  }
  return Buffer.concat(bytes);
}

async function download(feed, release, stage, signal) {
  const response = await fetch(new URL(release.file, feed), {
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(900000)]),
  });
  if (!response.ok || !response.body) throw Error('无法下载更新包');
  const path = join(stage, release.file);
  const hash = createHash('sha512');
  let size = 0;
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({
      transform(bytes, _encoding, done) {
        size += bytes.length;
        if (size > release.size) return done(Error('更新包长度无效'));
        hash.update(bytes);
        done(null, bytes);
      },
    }),
    createWriteStream(path, { flags: 'wx', mode: 0o600 }),
  );
  if (size !== release.size || hash.digest('hex') !== release.sha512) throw Error('更新包校验失败');
  return path;
}

export function runUpdates({ root, directory, executable, idle, notify, prepare, handoff, recover }) {
  const disabled = { stop() {}, install() {} };
  const keyFile = join(root, 'native-update-key.pem');
  if (process.env.POCKET_NATIVE_UPDATES === '0' || !existsSync(keyFile)) {
    notify(process.env.POCKET_NATIVE_UPDATES === '0' ? '自动更新已关闭' : '此构建未配置签名更新源');
    return disabled;
  }
  const platform = process.platform;
  const arch = process.arch;
  const manual = platform === 'linux';
  const installed =
    platform === 'win32'
      ? process.env.LOCALAPPDATA &&
        resolve(executable).toLowerCase() ===
          join(
            process.env.LOCALAPPDATA,
            'Programs',
            'Agent Space Adapter',
            'agent-space-native.exe',
          ).toLowerCase()
      : platform === 'darwin'
        ? !executable.startsWith('/Volumes/') &&
          executable.endsWith('/Agent Space Adapter.app/Contents/MacOS/agent-space-native')
        : executable === '/usr/bin/agent-space-native';
  if (!installed || (manual && (!existsSync('/usr/bin/pkexec') || !existsSync('/usr/bin/apt-get')))) {
    notify(installed ? '安装更新需要 apt 和 PolicyKit' : '仅正式安装位置可应用更新');
    return disabled;
  }
  const controller = new AbortController();
  let pending, checking, applying, stage, committed;
  let requested = false;
  // A Windows helper cannot unlink the Node executable it is running.
  void readdir(directory, { withFileTypes: true })
    .then(async (entries) => {
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^\.native-update-[a-zA-Z0-9]+$/.test(entry.name)) continue;
        const path = join(directory, entry.name);
        const age = await stat(path).then(
          (file) => Date.now() - file.mtimeMs,
          () => 0,
        );
        if (age > 48 * 60 * 60 * 1000) await rm(path, { recursive: true, force: true });
      }
    })
    .catch(() => {});

  async function check() {
    if (checking || pending || applying || controller.signal.aborted) return;
    checking = true;
    try {
      const key = createPublicKey(await readFile(keyFile));
      const feed = updateFeed(
        process.env.POCKET_PUBLIC_ORIGIN,
        process.env.POCKET_NATIVE_UPDATE_BASE_URL,
        platform,
        arch,
      );
      const release = verifyManifest(
        await manifest(feed, controller.signal),
        key,
        process.env.POCKET_NATIVE_VERSION,
        platform,
        arch,
      );
      if (!release) {
        notify('已是最新版本');
        return;
      }
      const attempted = await readFile(join(directory, 'native-update-attempt.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      if (attempted?.version === release.version && Date.now() - attempted.time < fourHours) {
        notify('上次安装未生效，将稍后重试');
        return;
      }
      stage = await mkdtemp(join(directory, '.native-update-'));
      notify('正在后台下载更新');
      const path = await download(feed, release, stage, controller.signal);
      pending = { path, release };
      notify(manual ? '已下载，安装需要系统授权' : '已下载，等待连接空闲后安装', manual);
    } catch {
      if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
      stage = undefined;
      if (!controller.signal.aborted) notify('检查或下载更新失败，将在后台重试');
    } finally {
      checking = false;
    }
  }

  async function install() {
    if (!pending || applying || controller.signal.aborted || (manual && !requested)) return;
    if (!idle()) {
      if (requested) notify('等待手机连接和操作结束后安装', manual);
      return;
    }
    applying = true;
    let drained = false;
    try {
      const node = join(stage, platform === 'win32' ? 'apply-node.exe' : 'apply-node');
      const helper = join(stage, 'apply.mjs');
      await copyFile(process.execPath, node);
      await copyFile(fileURLToPath(new URL('./native-update-apply.mjs', import.meta.url)), helper);
      if (controller.signal.aborted) return;
      await prepare();
      drained = true;
      if (controller.signal.aborted) return;
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !/^(?:POCKET_RELAY_ENROLLMENT|POCKET_NATIVE_ENROLLMENT)$/i.test(name),
        ),
      );
      const detached = spawn(
        node,
        [
          helper,
          pending.path,
          executable,
          String(process.ppid),
          String(process.pid),
          pending.release.version,
          pending.release.sha512,
          String(pending.release.size),
        ],
        { cwd: stage, detached: true, windowsHide: true, stdio: 'ignore', env },
      );
      await new Promise((resolve, reject) => {
        detached.once('spawn', resolve);
        detached.once('error', reject);
      });
      detached.unref();
      committed = true;
      handoff();
    } catch {
      if (drained) recover();
      if (!controller.signal.aborted) notify('等待适配器安全退出后重试更新', manual);
    } finally {
      applying = false;
      if (!committed && controller.signal.aborted && stage)
        await rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }
  const first = setTimeout(() => void check(), 15000);
  const checks = setInterval(() => void check(), fourHours);
  const installs = setInterval(() => void install(), 30000);
  return {
    install() {
      requested = true;
      void install();
    },
    stop() {
      controller.abort();
      clearTimeout(first);
      clearInterval(checks);
      clearInterval(installs);
      if (!committed && !applying && !checking && stage)
        void rm(stage, { recursive: true, force: true }).catch(() => {});
    },
  };
}
