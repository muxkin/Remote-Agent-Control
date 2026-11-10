import { readFile, readdir, writeFile, mkdtemp, rm, mkdir, rename, stat, copyFile, link } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { updateFilename, verifyManifest } from './native-update.mjs';
import { verifyPlatformSignature } from './native-signing.mjs';
const args = process.argv.slice(2),
  get = (key) => args[args.indexOf(key) + 1];
const output = args.includes('--output') ? resolve(get('--output'), 'desktop-releases') : null;
for (const key of ['--platform', '--arch', ...(output ? [] : ['--config', '--bucket', '--origin'])])
  if (!args.includes(key) || !get(key) || get(key).startsWith('--')) throw Error(`Missing ${key}`);
const config = output ? null : resolve(get('--config')),
  bucket = output ? null : get('--bucket'),
  platform = get('--platform'),
  arch = get('--arch');
const url = output ? null : new URL(get('--origin'));
if (
  !['linux', 'darwin', 'win32'].includes(platform) ||
  !['x64', 'arm64'].includes(arch) ||
  (!output &&
    (url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !/^[a-z0-9-]+$/.test(bucket)))
)
  throw Error('Invalid release destination');
const origin = url?.origin;
const directory = resolve(args.includes('--directory') ? get('--directory') : 'dist/desktop');
const nativeVersion = args.includes('--native-version') ? get('--native-version') : null;
const releaseKeyOnly = args.includes('--release-key-only');
const rustNative = args.includes('--rust-native');
const bridgeHybrid = args.includes('--bridge-hybrid-linux');
if (rustNative && !nativeVersion) throw Error('--rust-native requires an explicit native release version');
if (bridgeHybrid && (!rustNative || platform !== 'linux' || arch !== 'x64'))
  throw Error('--bridge-hybrid-linux requires a Linux x64 Rust native release');
if (releaseKeyOnly && (!nativeVersion || platform === 'linux'))
  throw Error('--release-key-only requires a Windows or macOS native release');
if (args.includes('--native-version') && !/^\d+\.\d+\.\d+$/.test(nativeVersion ?? ''))
  throw Error('Set --native-version to an explicit version');
const metadata =
  platform === 'linux' ? 'latest-linux.yml' : platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml';
const artifacts = [];
let manifest;
if (!nativeVersion) {
  manifest = parse(await readFile(join(directory, metadata), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || !Array.isArray(manifest.files) || !manifest.files.length)
    throw Error('Invalid release metadata');
  for (const file of manifest.files) {
    if (!/^AgentSpace-[0-9][A-Za-z0-9._-]*\.(exe|dmg|zip|AppImage)$/.test(file.url))
      throw Error('Release metadata must use relative installer names');
    const bytes = await readFile(join(directory, file.url));
    if (createHash('sha512').update(bytes).digest('base64') !== file.sha512 || file.size !== bytes.length)
      throw Error(`Release integrity mismatch: ${file.url}`);
    artifacts.push({ file: file.url, size: bytes.length });
  }
  // DMG is the visible macOS installer; updater metadata uses ZIP.
  for (const name of await readdir(directory))
    if (name === `AgentSpace-${manifest.version}-mac-${arch}.dmg` && !artifacts.some((x) => x.file === name))
      artifacts.push({ file: name, size: (await readFile(join(directory, name))).length });
}
const publicURL = `${origin}/downloads/desktop/`;
async function head(name) {
  if (output) {
    try {
      return { status: 200, ok: true, size: (await stat(join(output, name))).size };
    } catch (e) {
      if (e.code === 'ENOENT') return { status: 404, ok: false };
      throw e;
    }
  }
  const response = await fetch(publicURL + name, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
  return { status: response.status, ok: response.ok, size: Number(response.headers.get('Content-Length')) };
}
let index;
if (nativeVersion) {
  index = { files: [] };
} else if (output) {
  try {
    index = JSON.parse(await readFile(join(output, 'releases.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    index = { files: [] };
  }
} else {
  const current = await fetch(`${publicURL}releases.json`, { signal: AbortSignal.timeout(20000) });
  if (!current.ok && current.status !== 404) throw Error('Cannot safely read the previous release index');
  index = current.status === 404 ? { files: [] } : await current.json();
}
if (!Array.isArray(index.files)) throw Error('Invalid release index');
const uploaded = new Map();
async function releaseBody(name) {
  if (output) {
    const existing = await head(name);
    return existing.ok ? createReadStream(join(output, name)) : null;
  }
  const response = await fetch(publicURL + name, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status === 404) return null;
  if (!response.ok || !response.body) throw Error(`Cannot read published release file: ${name}`);
  return response.body;
}

async function sameInstaller(name, size, sha512) {
  const body = await releaseBody(name);
  if (!body) return false;
  let length = 0;
  const hash = createHash('sha512');
  for await (const chunk of body) {
    length += chunk.length;
    if (length > size) return false;
    hash.update(chunk);
  }
  return length === size && hash.digest('hex') === sha512;
}

async function readNativeManifest(path) {
  const body = await releaseBody(`${path}/latest.json`);
  if (!body) return null;
  const chunks = [];
  let length = 0;
  for await (const chunk of body) {
    length += chunk.length;
    if (length > 16384) throw Error(`Published release manifest exceeds its size limit: ${path}`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function verifyExistingManifest(path, key, version, size, sha512) {
  const current = await readNativeManifest(path);
  if (!current) return;
  const previous = verifyManifest(current, key, '0.0.0', platform, arch, true);
  if (!previous) return;
  const order = previous.version.split('.').map((value, index) => Number(value) - Number(version.split('.')[index]));
  if (order.find(Boolean) > 0)
    throw Error(`Refusing to downgrade the published release: ${path}`);
  if (previous.version === version && (previous.size !== size || previous.sha512 !== sha512))
    throw Error(`Refusing to change the published release: ${path}`);
}

async function put(name, file, type, sha512) {
  const existing = await head(name);
  if (!existing.ok && existing.status !== 404) throw Error('Cannot safely check the existing artifact');
  const size = (await stat(file)).size;
  if (existing.ok && !/\.(yml|json)$/.test(name)) {
    if (sha512 && existing.size === size && await sameInstaller(name, size, sha512)) return;
    throw Error(`Immutable release already exists: ${name}; increment the version`);
  }
  if (output) {
    const destination = join(output, name),
      temporary = `${destination}.tmp-${process.pid}`;
    await mkdir(dirname(destination), { recursive: true });
    try {
      await copyFile(file, temporary);
      if (sha512) {
        try {
          await link(temporary, destination);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (!await sameInstaller(name, size, sha512))
            throw Error(`Immutable release already exists: ${name}; increment the version`);
        }
      } else {
        await rename(temporary, destination);
      }
    } finally {
      await rm(temporary, { force: true });
    }
    uploaded.set(name, size);
    return;
  }
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'r2',
      'object',
      'put',
      `${bucket}/desktop-releases/${name}`,
      '--file',
      file,
      '--content-type',
      type,
      '--remote',
      '--config',
      config,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw Error('R2 upload failed; release manifest was not advanced');
  uploaded.set(name, size);
}
if (nativeVersion) {
  const key = process.env.POCKET_NATIVE_UPDATE_SIGNING_KEY_FILE;
  if (!key) throw Error('Set POCKET_NATIVE_UPDATE_SIGNING_KEY_FILE to the private signing key path');
  const privateKey = createPrivateKey(await readFile(key));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw Error('Expected an Ed25519 signing key');
  if (rustNative) {
    const pinnedKey = createPublicKey(
      await readFile(new URL('../../desktop/native/update-release.pub', import.meta.url)),
    );
    const encoding = { type: 'spki', format: 'der' };
    if (!createPublicKey(privateKey).export(encoding).equals(pinnedKey.export(encoding)))
      throw Error('The release signing key does not match the Rust updater public key');
  }
  const file = updateFilename(nativeVersion, platform, arch);
  const source = join(directory, file);
  if (!releaseKeyOnly) verifyPlatformSignature(platform, source);
  const bytes = await readFile(source);
  if (releaseKeyOnly) {
    const validInstaller =
      platform === 'win32'
        ? bytes.subarray(0, 2).toString() === 'MZ'
        : bytes.subarray(-512, -508).toString() === 'koly';
    if (!validInstaller) throw Error('Invalid native installer format');
  }
  if (!bytes.length || bytes.length > 512 * 1024 * 1024) throw Error('Installer size out of range');
  const path = `native/${rustNative ? 'rust/' : ''}${platform}/${arch}`;
  const paths = bridgeHybrid ? [path, 'native/linux/x64'] : [path];
  const sha512 = createHash('sha512').update(bytes).digest('hex');
  const publicKey = createPublicKey(privateKey);
  for (const destination of paths) {
    await verifyExistingManifest(destination, publicKey, nativeVersion, bytes.length, sha512);
  }
  const payload = Buffer.from(
    JSON.stringify({
      format: 1,
      ...(rustNative ? { runtime: 'rust' } : {}),
      ...(releaseKeyOnly ? { publisher: 'release-key' } : {}),
      platform,
      arch,
      version: nativeVersion,
      file,
      size: bytes.length,
      sha512,
    }),
  );
  const envelope = {
    payload: payload.toString('base64'),
    signature: sign(null, payload, privateKey).toString('base64'),
  };
  const temp = await mkdtemp(join(tmpdir(), 'desktop-native-release-'));
  try {
    const installer = join(temp, file);
    await writeFile(installer, bytes);
    for (const destination of paths) {
      const name = `${destination}/${file}`;
      await put(name, installer, 'application/octet-stream', sha512);
      if (!await sameInstaller(name, bytes.length, sha512))
        throw Error(`Native installer is not reachable with the expected digest: ${name}`);
    }
    const metadata = join(temp, 'latest.json');
    const signedManifest = Buffer.from(JSON.stringify(envelope));
    await writeFile(metadata, signedManifest);
    // Existing hybrid clients must never transition before the Rust feed is available.
    for (const destination of paths) {
      await verifyExistingManifest(destination, publicKey, nativeVersion, bytes.length, sha512);
      await put(`${destination}/latest.json`, metadata, 'application/json');
      const published = await readNativeManifest(destination);
      if (!published?.equals(signedManifest))
        throw Error(`Published native manifest is not visible with the expected signature: ${destination}`);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  console.log(`Published native ${platform}/${arch} ${nativeVersion}`);
  process.exit(0);
}
for (const artifact of artifacts) {
  await put(
    `${platform}/${arch}/${artifact.file}`,
    join(directory, artifact.file),
    'application/octet-stream',
  );
  const blockmap = `${artifact.file}.blockmap`;
  if ((await readdir(directory)).includes(blockmap))
    await put(`${platform}/${arch}/${blockmap}`, join(directory, blockmap), 'application/octet-stream');
}
// Commit the updater manifest only after every artifact has been uploaded and checked.
for (const [name, size] of uploaded) {
  const check = await head(name);
  if (!check.ok || check.size !== size)
    throw Error('Uploaded artifact is not publicly reachable; manifest not advanced');
}
await put(`${platform}/${arch}/${metadata}`, join(directory, metadata), 'text/yaml');
index.files = [
  ...index.files.filter((x) => x.platform !== platform || x.arch !== arch),
  ...artifacts
    .filter((x) => !x.file.endsWith('.zip'))
    .map((x) => ({ ...x, platform, arch, version: manifest.version })),
];
const temp = await mkdtemp(join(tmpdir(), 'desktop-release-'));
try {
  const file = join(temp, 'releases.json');
  await writeFile(file, JSON.stringify(index));
  await put('releases.json', file, 'application/json');
} finally {
  await rm(temp, { recursive: true, force: true });
}
console.log(
  `Published ${platform}/${arch} ${manifest.version} on ${output ? 'the filesystem release store' : 'Cloudflare R2'}`,
);
