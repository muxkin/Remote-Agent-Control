import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { updateFilename, verifyManifest } from '../scripts/desktop/native-update.mjs';
import { releaseKey } from '../src/shared/desktop-releases.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const release = {
  format: 1,
  version: '0.2.10',
  platform: 'linux',
  arch: 'x64',
  file: 'AgentSpace-Native-0.2.10-linux-x64.deb',
  size: 50,
  sha512: '0'.repeat(128),
};
function signed(fields = {}) {
  const payload = Buffer.from(JSON.stringify({ ...release, ...fields }));
  return {
    payload: payload.toString('base64'),
    signature: sign(null, payload, privateKey).toString('base64'),
  };
}
const check = (envelope = signed(), current = '0.2.9') =>
  verifyManifest(JSON.stringify(envelope), publicKey, current, 'linux', 'x64');

async function releaseFixture(directory) {
  const scripts = join(directory, 'scripts', 'desktop');
  const native = join(directory, 'desktop', 'native');
  await mkdir(scripts, { recursive: true });
  await mkdir(native, { recursive: true });
  await symlink(await realpath(new URL('../node_modules', import.meta.url)), join(directory, 'node_modules'), 'junction');
  for (const script of ['publish.mjs', 'native-update.mjs', 'native-signing.mjs']) {
    await copyFile(new URL(`../scripts/desktop/${script}`, import.meta.url), join(scripts, script));
  }
  const keyPath = join(directory, 'test-key.pem');
  await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(join(native, 'update-release.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
  return (platform, arch, target, ...extra) =>
    spawnSync(
      process.execPath,
      [join(scripts, 'publish.mjs'), '--output', directory, '--directory', directory,
        '--platform', platform, '--arch', arch, '--native-version', target, '--rust-native',
        ...extra],
      { encoding: 'utf8', env: { ...process.env, POCKET_NATIVE_UPDATE_SIGNING_KEY_FILE: keyPath } },
    );
}

describe('signed native updates', () => {
  it('rejects a Rust publisher key that cannot be trusted by installed clients', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-publish-test-'));
    try {
      const keyPath = join(directory, 'test-key.pem');
      await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../scripts/desktop/publish.mjs', import.meta.url)),
          '--output',
          directory,
          '--directory',
          directory,
          '--platform',
          'linux',
          '--arch',
          'x64',
          '--native-version',
          release.version,
          '--rust-native',
        ],
        { encoding: 'utf8', env: { ...process.env, POCKET_NATIVE_UPDATE_SIGNING_KEY_FILE: keyPath } },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('The release signing key does not match the Rust updater public key');
      expect(await readdir(directory)).toEqual(['test-key.pem']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('stages and verifies the same signed Rust release for hybrid and Rust clients', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-bridge-test-'));
    try {
      const run = await releaseFixture(directory);
      const old = join(directory, 'desktop-releases', 'native', 'linux', 'x64');
      const rust = join(directory, 'desktop-releases', 'native', 'rust', 'linux', 'x64');
      await mkdir(old, { recursive: true });
      const oldLatest = join(old, 'latest.json');
      const rustLatest = join(rust, 'latest.json');
      const previous = JSON.stringify(signed());
      await writeFile(oldLatest, previous);
      const version = '0.3.25';
      const file = updateFilename(version, 'linux', 'x64');
      const installer = Buffer.from('test installer');
      await writeFile(join(directory, file), installer);
      const publish = (target = version, ...extra) => run('linux', 'x64', target, ...extra);
      const bridge = '--bridge-hybrid-linux';
      expect(publish(version).status).toBe(0);
      expect(await readFile(oldLatest, 'utf8')).toBe(previous);
      await writeFile(join(old, file), Buffer.alloc(installer.length));
      const collision = publish(version, bridge);
      expect(collision.status).toBe(1);
      expect(collision.stderr).toContain('Immutable release already exists');
      expect(await readFile(oldLatest, 'utf8')).toBe(previous);
      await rm(join(old, file));
      expect(publish(version, bridge).status).toBe(0);
      const current = await readFile(oldLatest, 'utf8');
      expect(current).toBe(await readFile(rustLatest, 'utf8'));
      expect(check(JSON.parse(current), release.version)).toMatchObject({ version, runtime: 'rust', file });
      expect(await readFile(join(old, file))).toEqual(installer);
      expect(await readFile(join(rust, file))).toEqual(installer);
      expect(publish(version, bridge).status).toBe(0);
      await writeFile(join(directory, release.file), installer);
      const downgrade = publish(release.version, bridge);
      expect(downgrade.status).toBe(1);
      expect(downgrade.stderr).toContain('Refusing to downgrade');
      expect(await readFile(oldLatest, 'utf8')).toBe(current);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['win32', 'x64'],
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'x64'],
  ])('resumes a partially staged release without downgrading the %s/%s feed', async (platform, arch) => {
    const directory = await mkdtemp(join(tmpdir(), 'native-publish-retry-test-'));
    try {
      const run = await releaseFixture(directory);
      const channel = join(directory, 'desktop-releases', 'native', 'rust', platform, arch);
      const latest = join(channel, 'latest.json');
      const version = '0.3.34';
      const file = updateFilename(version, platform, arch);
      const previous = updateFilename('0.3.33', platform, arch);
      const bytes = platform === 'win32'
        ? Buffer.from('MZ test installer')
        : platform === 'darwin'
          ? Buffer.concat([Buffer.from('test installerkoly'), Buffer.alloc(508)])
          : Buffer.from('test installer');
      const flags = platform === 'linux' ? [] : ['--release-key-only'];
      await mkdir(channel, { recursive: true });
      await writeFile(join(directory, file), bytes);
      await writeFile(join(channel, file), bytes);
      expect(run(platform, arch, version, ...flags).status).toBe(0);
      const manifest = await readFile(latest, 'utf8');
      expect(verifyManifest(manifest, publicKey, '0.3.33', platform, arch, true)).toMatchObject({
        version, runtime: 'rust', file, sha512: createHash('sha512').update(bytes).digest('hex'),
      });
      expect(run(platform, arch, version, ...flags).status).toBe(0);
      expect(await readFile(latest, 'utf8')).toBe(manifest);
      const replacement = Buffer.from(bytes);
      replacement[2] ^= 1;
      await writeFile(join(directory, file), replacement);
      const changed = run(platform, arch, version, ...flags);
      expect(changed.status).toBe(1);
      expect(changed.stderr).toContain('Refusing to change the published release');
      expect(await readFile(join(channel, file))).toEqual(bytes);
      await writeFile(join(directory, previous), bytes);
      const downgrade = run(platform, arch, '0.3.33', ...flags);
      expect(downgrade.status).toBe(1);
      expect(downgrade.stderr).toContain('Refusing to downgrade the published release');
      expect(await readdir(channel)).not.toContain(previous);
      expect(await readFile(latest, 'utf8')).toBe(manifest);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps unsigned preview artifacts separate from the signed update channel', () => {
    const path = '/downloads/desktop/native/preview/linux/x64/';
    expect(releaseKey(path + 'preview.json')).toBe('desktop-releases/native/preview/linux/x64/preview.json');
    expect(releaseKey(path + 'AgentSpace-Native-0.2.7-linux-x64.tar.xz')).toContain('native/preview/');
    expect(releaseKey(path + 'latest.json')).toBeNull();
    expect(releaseKey(path + 'AgentSpace-Native-0.2.7-windows-x64-setup.exe')).toBeNull();
  });
  it('checks signatures and compares numeric versions without downgrading', () => {
    expect(check()).toEqual(release);
    expect(check(signed(), '0.2.10')).toBeNull();
    expect(check(signed(), '0.3.0')).toBeNull();
    const envelope = signed();
    expect(() => check({ ...envelope, payload: signed({ size: 100 }).payload })).toThrow('更新签名无效');
  });
  it.each([
    ['win32', 'x64'],
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
  ])('accepts a release-key update only in opted-in %s/%s builds', (platform, arch) => {
    const fields = { platform, arch, file: updateFilename(release.version, platform, arch) };
    const envelope = signed({ ...fields, publisher: 'release-key' });
    const verify = (document, optIn = false) =>
      verifyManifest(JSON.stringify(document), publicKey, '0.2.9', platform, arch, optIn);
    expect(() => verify(envelope)).toThrow('更新清单无效');
    expect(verify(envelope, true).publisher).toBe('release-key');
    expect(verify(signed(fields), true).publisher).toBeUndefined();
    expect(() => verify(signed({ ...fields, publisher: 'unknown' }), true)).toThrow('更新清单无效');
    expect(() => verify({ ...envelope, payload: signed(fields).payload }, true)).toThrow('更新签名无效');
  });
  it('requires the existing Linux manifest policy even when release-key opt-in is set', () => {
    const document = JSON.stringify(signed({ publisher: 'release-key' }));
    expect(() => verifyManifest(document, publicKey, '0.2.9', 'linux', 'x64', true)).toThrow('更新清单无效');
  });
  it.each([
    { file: 'https://example.org/installer' },
    { arch: 'arm64' },
    { platform: 'win32' },
    { size: 1e9 },
    { sha512: 'bad' },
  ])('rejects signed metadata that does not match the native installer contract', (fields) => {
    expect(() => check(signed(fields))).toThrow('更新清单无效');
  });
  it.each([
    ['win32', 'x64'],
    ['linux', 'x64'],
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
  ])('uses the same allowlisted native artifact on both relay runtimes for %s/%s', (platform, arch) => {
    const prefix = `native/${platform}/${arch}/`;
    const file = updateFilename(release.version, platform, arch);
    const get = (name) => releaseKey('/downloads/desktop/' + prefix + name);
    expect(get('latest.json')).toBe('desktop-releases/' + prefix + 'latest.json');
    expect(get(file)).toBe('desktop-releases/' + prefix + file);
    expect(get('another.exe')).toBeNull();
    expect(get('../' + file)).toBeNull();
    const rust = '/downloads/desktop/native/rust/' + platform + '/' + arch + '/';
    expect(releaseKey(rust + 'latest.json')).toBe(
      'desktop-releases/native/rust/' + platform + '/' + arch + '/latest.json',
    );
    expect(releaseKey(rust + file)).toBe(
      'desktop-releases/native/rust/' + platform + '/' + arch + '/' + file,
    );
    expect(releaseKey(rust + 'untrusted.exe')).toBeNull();
  });
});
