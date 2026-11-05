import { privateOutput } from './private-output.js';
await privateOutput('.deploy');
/** Packages only public build assets for any object store. */
import { readdir, readFile, mkdir, cp, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { assetSettings } from '../src/shared/assets.js';

const { values } = parseArgs({ options: { 'build-dir': { type: 'string', default: 'dist/web' } } });
const buildDir = resolve(values['build-dir']!);
const built = JSON.parse(await readFile(join(buildDir, 'asset-origin.json'), 'utf8'));
const assets = assetSettings(process.env.POCKET_ASSET_BASE);
if (assets.base !== built.base) throw new Error('Build and asset export settings differ; rebuild first.');
const output = resolve('.deploy/assets');
const source = join(buildDir, 'assets');
const prefix = assets.origin ? new URL(assets.base).pathname.slice(1) : '';
await mkdir(output, { recursive: true, mode: 0o700 });
const files = [];
for (const name of await readdir(source, { recursive: true })) {
  if (!/\.(js|css|woff2?|ttf|otf|wasm|png|svg|webp|avif|ico)$/.test(name)) continue;
  const path = join(source, name);
  const data = await readFile(path);
  const objectKey = `${prefix}assets/${name}`;
  const destination = resolve(output, objectKey);
  if (!destination.startsWith(output + '/')) throw new Error('Invalid asset prefix');
  await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 });
  await cp(path, destination);
  files.push({
    file: relative(output, destination),
    key: objectKey,
    bytes: data.length,
    gzipBytes: gzipSync(data).length,
    sha256: createHash('sha256').update(data).digest('hex'),
    cacheControl: 'public, max-age=31536000, immutable',
  });
}
await writeFile('.deploy/asset-manifest.json', JSON.stringify({ assetBase: assets.base, files }, null, 2), {
  mode: 0o600,
});

console.log(
  JSON.stringify(
    {
      files: files.length,
      bytes: files.reduce((s, f) => s + f.bytes, 0),
      gzipBytes: files.reduce((s, f) => s + f.gzipBytes, 0),
      output,
      uploaded: false,
    },
    null,
    2,
  ),
);
