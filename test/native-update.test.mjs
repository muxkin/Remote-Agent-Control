import { generateKeyPairSync, sign } from 'node:crypto';
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

describe('signed native updates', () => {
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
  });
});
