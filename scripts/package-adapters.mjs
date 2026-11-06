import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const directory = resolve('dist/adapters');
mkdirSync(directory, { recursive: true });
const hashes = [];
for (const name of ['sdk', 'codex', 'dsh']) {
  const result = execFileSync(
    process.execPath,
    [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory],
    { cwd: resolve(`packages/adapter-${name}`), encoding: 'utf8' },
  );
  const [{ filename, files }] = JSON.parse(result);
  if (files.some((f) => /(?:\.env|node_modules|state|\.sqlite)(?:\/|$)/.test(f.path)))
    throw Error('Unexpected private package content');
  hashes.push(
    `${createHash('sha256')
      .update(readFileSync(join(directory, filename)))
      .digest('hex')}  ${filename}`,
  );
  console.log(filename);
}
writeFileSync(join(directory, 'SHA256SUMS'), hashes.join('\n') + '\n');
