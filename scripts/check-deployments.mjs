import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { devNull } from 'node:os';
import assert from 'node:assert/strict';

// Same source revision and public configuration, through the actual deployment build entry points.
// No personal Gateway configuration is loaded and the VPS's dist/web is not overwritten.
const env = {
  ...process.env,
  POCKET_ENV_FILE: devNull,
  POCKET_CF_ENV_FILE: devNull,
  POCKET_ASSET_BASE: '',
  POCKET_CF_ASSET_BASE: '',
  WRANGLER_SEND_METRICS: 'false',
};
const run = (file, args) => {
  const result = spawnSync(process.execPath, [file, ...args], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const folder = '.implementation/deployment-parity';
run('node_modules/vite/bin/vite.js', ['build', '--outDir', `../../${folder}/node-web`]);
run('scripts/cloudflare.mjs', ['build']);
const manifest = (root, directory = '') =>
  readdirSync(join(root, directory), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? manifest(root, path)
        : [
            [
              path,
              createHash('sha256')
                .update(readFileSync(join(root, path)))
                .digest('hex'),
            ],
          ];
    });
const node = manifest(`${folder}/node-web`),
  cloudflare = manifest('dist/cloudflare-web');
assert.deepEqual(
  cloudflare,
  node,
  'Node and Cloudflare must ship identical frontend files for the same public configuration',
);
console.log(
  `Deployment parity passed: ${node.length} frontend files are byte-for-byte identical; Worker bundle validated.`,
);
