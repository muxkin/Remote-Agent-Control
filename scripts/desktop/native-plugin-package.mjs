import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { nativeNotices } from './native-notices.mjs';

const [
  product,
  binary,
  output,
  target = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim(),
] = process.argv.slice(2);
assert(product === 'dsh' && binary && output, 'Usage: native-plugin-package.mjs dsh BINARY OUTPUT');
const entry = basename(binary);
assert.match(entry, /^agent-space-adapter-dsh(?:\.exe)?$/);
const cargo = await readFile(new URL('../../desktop/native/Cargo.toml', import.meta.url), 'utf8');
const version = cargo.match(/^version = "(\d+\.\d+\.\d+)"$/m)?.[1];
assert(version, 'Cannot read native plugin version');
const sha256 = createHash('sha256')
  .update(await readFile(binary))
  .digest('hex');
await mkdir(output, { recursive: true });
const destination = join(output, entry);
await copyFile(binary, destination);
if (process.platform !== 'win32') await chmod(destination, 0o755);
await copyFile(new URL('../../LICENSE', import.meta.url), join(output, 'LICENSE'));
await writeFile(
  join(output, 'THIRD-PARTY-NOTICES.txt'),
  await nativeNotices(resolve('desktop/native'), target, [
    '--no-default-features',
    '--features',
    'official-plugins',
  ]),
);
await writeFile(
  join(output, 'adapter.json'),
  JSON.stringify(
    { sdk: 1, name: '@agent-remote/adapter-dsh', version, product, stateVersion: 1, entry, sha256 },
    null,
    2,
  ) + '\n',
);
