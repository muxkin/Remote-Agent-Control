import releaseKey from '../../../desktop/native/update-release.pub?raw';
import type { NativeInstallerTarget } from '../../shared/desktop-releases.js';

const MAX_MANIFEST = 16 * 1024;
const MAX_INSTALLER = 512 * 1024 * 1024;
const VERSION = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;

export interface NativeInstaller {
  version: string;
  size: number;
  href: string;
  manifest: string;
  releaseKeyOnly: boolean;
}

export function nativeSourceArchive(verified: readonly Pick<NativeInstaller, 'version'>[]) {
  const version = verified
    .map((release) => release.version)
    .sort((left, right) => right.localeCompare(left, 'en', { numeric: true }))[0];
  if (!version) return undefined;
  return {
    version,
    href: `https://github.com/muxkin/Remote-Agent-Control/releases/download/native-rust-v${version}/AgentSpace-Native-${version}-source.tar.gz`,
  };
}

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

let publicKey: Promise<CryptoKey> | undefined;
function pinnedKey() {
  return (publicKey ??= crypto.subtle.importKey(
    'spki',
    fromBase64(releaseKey.replace(/-----[^\n]+-----/g, '').replace(/\s/g, '')),
    'Ed25519',
    false,
    ['verify'],
  ));
}

async function readManifest(response: Response) {
  const stream = response.body?.getReader();
  if (!stream) throw new Error('Missing release manifest');
  const buffer = new Uint8Array(MAX_MANIFEST);
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await stream.read();
      if (done) break;
      if (length + value.length > buffer.length) throw new Error('Release manifest is too large');
      buffer.set(value, length);
      length += value.length;
    }
  } finally {
    await stream.cancel();
  }
  return JSON.parse(new TextDecoder().decode(buffer.subarray(0, length)));
}

export async function loadNativeInstaller(
  target: NativeInstallerTarget,
  runtime: 'rust' | 'hybrid',
  signal: AbortSignal,
  key: () => Promise<CryptoKey> = pinnedKey,
): Promise<NativeInstaller | null> {
  const base = `/downloads/desktop/native/${runtime === 'rust' ? 'rust/' : ''}${target.platform}/${target.arch}/`;
  const manifest = base + 'latest.json';
  const options = { signal, cache: 'no-cache', redirect: 'error' } as const;
  const response = await fetch(manifest, options);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Release manifest unavailable');

  const envelope = await readManifest(response);
  if (
    typeof envelope?.payload !== 'string' ||
    typeof envelope.signature !== 'string' ||
    envelope.signature.length !== 88
  )
    throw new Error('Invalid release envelope');
  const payload = fromBase64(envelope.payload);
  if (!(await crypto.subtle.verify('Ed25519', await key(), fromBase64(envelope.signature), payload)))
    throw new Error('Invalid release signature');
  const release = JSON.parse(new TextDecoder().decode(payload));
  if (
    release?.format !== 1 ||
    release.runtime !== (runtime === 'rust' ? 'rust' : undefined) ||
    release.platform !== target.platform ||
    release.arch !== target.arch ||
    typeof release.version !== 'string' ||
    !VERSION.test(release.version) ||
    release.file !== `AgentSpace-Native-${release.version}-${target.suffix}` ||
    !Number.isSafeInteger(release.size) ||
    release.size < 1 ||
    release.size > MAX_INSTALLER ||
    typeof release.sha512 !== 'string' ||
    !/^[a-f0-9]{128}$/.test(release.sha512) ||
    (release.publisher !== undefined && (release.publisher !== 'release-key' || target.platform === 'linux'))
  )
    throw new Error('Invalid native release');

  let href = base + release.file;
  const direct = href.replace('/desktop/native/rust/', '/desktop/direct/native/rust/');
  let artifact = await fetch(direct, { ...options, method: 'HEAD' });
  if (artifact.status === 404 && direct !== href)
    artifact = await fetch(href, { ...options, method: 'HEAD' });
  else href = direct;
  if (!artifact.ok || artifact.headers.get('Content-Length') !== String(release.size))
    throw new Error('Release installer unavailable');
  return {
    version: release.version,
    size: release.size,
    href,
    manifest,
    releaseKeyOnly: !!release.publisher,
  };
}
