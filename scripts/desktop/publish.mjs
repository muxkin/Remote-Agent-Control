import { readFile, readdir, writeFile, mkdtemp, rm, mkdir, rename, stat, copyFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { updateFilename } from './native-update.mjs';
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
async function put(name, file, type) {
  const existing = await head(name);
  if (!existing.ok && existing.status !== 404) throw Error('Cannot safely check the existing artifact');
  if (existing.ok && !/\.(yml|json)$/.test(name))
    throw Error(`Immutable release already exists: ${name}; increment the version`);
  const size = (await stat(file)).size;
  if (output) {
    const destination = join(output, name),
      temporary = `${destination}.tmp-${process.pid}`;
    await mkdir(dirname(destination), { recursive: true });
    try {
      await copyFile(file, temporary);
      await rename(temporary, destination);
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
  const file = updateFilename(nativeVersion, platform, arch);
  const source = join(directory, file);
  verifyPlatformSignature(platform, source);
  const bytes = await readFile(source);
  if (!bytes.length || bytes.length > 512 * 1024 * 1024) throw Error('Installer size out of range');
  const path = `native/${platform}/${arch}`;
  const payload = Buffer.from(
    JSON.stringify({
      format: 1,
      platform,
      arch,
      version: nativeVersion,
      file,
      size: bytes.length,
      sha512: createHash('sha512').update(bytes).digest('hex'),
    }),
  );
  const envelope = {
    payload: payload.toString('base64'),
    signature: sign(null, payload, privateKey).toString('base64'),
  };
  await put(`${path}/${file}`, source, 'application/octet-stream');
  const reachable = await head(`${path}/${file}`);
  if (!reachable.ok || reachable.size !== bytes.length) throw Error('Native installer is not reachable');
  const temp = await mkdtemp(join(tmpdir(), 'desktop-native-release-'));
  try {
    const metadata = join(temp, 'latest.json');
    await writeFile(metadata, JSON.stringify(envelope));
    await put(`${path}/latest.json`, metadata, 'application/json');
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
