import { privateOutput } from './private-output.js';
await privateOutput('.deploy');
/** Upload only the hashed, public asset manifest; no source, HTML, state or credentials. */
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assetSettings } from '../src/shared/assets.js';
import { loadStorage } from '../src/server/object-storage.js';
import { readStorageSettings } from '../src/server/config.js';

const assets = assetSettings(process.env.POCKET_ASSET_BASE);
if (!assets.origin) throw Error('Configure POCKET_ASSET_BASE before publishing');
const assetOrigin = assets.origin;
const settings = readStorageSettings('assets');
if (!settings) throw Error('Configure POCKET_ASSET_ADAPTER before publishing');
const origin = z.url().parse(process.env.POCKET_PUBLIC_ORIGIN);
const storage = await loadStorage(settings, 'assets', origin);
const manifest = z
  .object({
    assetBase: z.string(),
    files: z.array(
      z.object({
        file: z.string(),
        key: z.string(),
        bytes: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    ),
  })
  .parse(JSON.parse(await readFile('.deploy/asset-manifest.json', 'utf8')));
if (manifest.assetBase !== assets.base) throw Error('Asset manifest and configured URL differ');
const root = await realpath('.deploy/assets');
const prefix = new URL(assets.base).pathname.slice(1) + 'assets/';
const mime: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};
let index = 0,
  uploaded = 0,
  existing = 0;
async function worker() {
  while (index < manifest.files.length) {
    const item = manifest.files[index++];
    if (
      item.file !== item.key ||
      !item.key.startsWith(prefix) ||
      item.key.includes('..') ||
      !mime[extname(item.key)]
    )
      throw Error('Manifest contains an unexpected public asset path');
    const file = await realpath(resolve(root, item.file));
    if (!file.startsWith(root + sep)) throw Error('Asset escapes export directory');
    const data = await readFile(file);
    if (data.length !== item.bytes || createHash('sha256').update(data).digest('hex') !== item.sha256)
      throw Error('Asset checksum changed since export');
    const result = await storage.putFile({
      key: item.key,
      file,
      contentType: mime[extname(item.key)],
      cacheControl: 'public, max-age=31536000, immutable',
      allowedOrigin: origin,
    });
    if (result === 'exists') {
      const remote = await fetch(new URL(item.key, assetOrigin), { signal: AbortSignal.timeout(30000) });
      if (
        !remote.ok ||
        createHash('sha256')
          .update(Buffer.from(await remote.arrayBuffer()))
          .digest('hex') !== item.sha256
      )
        throw Error('Existing immutable object differs from local asset');
      existing++;
    } else if (result === 'created') uploaded++;
    else throw Error('Storage adapter returned an invalid upload result');
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
const report = {
  date: new Date().toISOString(),
  assetBase: assets.base,
  uploaded,
  existing,
  bytes: manifest.files.reduce((n, f) => n + f.bytes, 0),
};
await writeFile('.deploy/asset-publish-result.json', JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
