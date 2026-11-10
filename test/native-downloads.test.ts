import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { desktopRelease, nativeInstallerTargets, type ReleaseStore } from '../src/shared/desktop-releases.js';
import { loadNativeInstaller } from '../src/web/shell/native-installers.js';

const signer = generateKeyPairSync('ed25519');
const key = () =>
  crypto.subtle.importKey(
    'spki',
    signer.publicKey.export({ type: 'spki', format: 'der' }),
    'Ed25519',
    false,
    ['verify'],
  );
const version = '0.3.19';
const signal = new AbortController().signal;

function fixture(
  target: (typeof nativeInstallerTargets)[number],
  options: {
    channel?: 'rust' | 'hybrid';
    manifest?: boolean;
    size?: number;
    fields?: Record<string, unknown>;
    trusted?: boolean;
  } = {},
) {
  const rust = options.channel !== 'hybrid';
  const file = `AgentSpace-Native-${version}-${target.suffix}`;
  const base = `/downloads/desktop/native/${rust ? 'rust/' : ''}${target.platform}/${target.arch}/`;
  const payload = Buffer.from(
    JSON.stringify({
      format: 1,
      ...(rust ? { runtime: 'rust' } : {}),
      platform: target.platform,
      arch: target.arch,
      version,
      file,
      size: 10,
      sha512: '0'.repeat(128),
      ...options.fields,
    }),
  );
  const privateKey =
    options.trusted === false ? generateKeyPairSync('ed25519').privateKey : signer.privateKey;
  const manifest = JSON.stringify({
    payload: payload.toString('base64'),
    signature: sign(null, payload, privateKey).toString('base64'),
  });
  const store: ReleaseStore = {
    head: async (name) => {
      if (name.endsWith('latest.json') && options.manifest !== false)
        return { size: Buffer.byteLength(manifest), etag: '"manifest"' };
      if (name.endsWith(file) && options.size !== 0) return { size: options.size ?? 10, etag: '"installer"' };
      return null;
    },
    read: async () => new Response(manifest).body,
  };
  const fetch = vi.fn((path: string, init: RequestInit) =>
    desktopRelease(new Request(new URL(path, 'https://updates.example'), init), store),
  );
  vi.stubGlobal('fetch', fetch);
  return { fetch, file, base };
}

afterEach(() => vi.unstubAllGlobals());

it.each(nativeInstallerTargets)('shows a signed, available $platform/$arch installer', async (target) => {
  const publisher = target.platform === 'linux' ? undefined : 'release-key';
  const { base, file, fetch } = fixture(target, { fields: { publisher } });
  await expect(loadNativeInstaller(target, 'rust', signal, key)).resolves.toEqual({
    version,
    size: 10,
    href: base + file,
    manifest: base + 'latest.json',
    releaseKeyOnly: !!publisher,
  });
  expect(fetch).toHaveBeenCalledWith(
    base + file,
    expect.objectContaining({ method: 'HEAD', redirect: 'error' }),
  );
});

it('keeps the old Linux feed separate and exposes it from its original path', async () => {
  const linux = nativeInstallerTargets[3];
  const { base, file } = fixture(linux, { channel: 'hybrid' });
  await expect(loadNativeInstaller(linux, 'hybrid', signal, key)).resolves.toMatchObject({
    href: base + file,
  });
});

it('treats an absent manifest as unpublished', async () => {
  const target = nativeInstallerTargets[0];
  const { fetch } = fixture(target, { manifest: false });
  await expect(loadNativeInstaller(target, 'rust', signal, key)).resolves.toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  { trusted: false },
  { fields: { runtime: undefined } },
  { fields: { arch: 'x64' } },
  { fields: { file: 'https://other.example/installer.dmg' } },
  { fields: { version: '00.3.19' } },
])('rejects a signed-feed violation before probing the artifact %o', async (options) => {
  const target = nativeInstallerTargets[1];
  const { fetch } = fixture(target, options);
  await expect(loadNativeInstaller(target, 'rust', signal, key)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([0, 20])(
  'omits a signed package if the shared route has the wrong size or returns 404 (%s)',
  async (size) => {
    const target = nativeInstallerTargets[0];
    fixture(target, { size });
    await expect(loadNativeInstaller(target, 'rust', signal, key)).rejects.toThrow(
      'Release installer unavailable',
    );
  },
);
