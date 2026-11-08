import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';

// Build the same application for the Worker runtime, using this deployment's explicit configuration.
// Never auto-load this machine's Gateway configuration or overwrite its Node web output.
const env = { ...process.env, POCKET_ENV_FILE: process.env.POCKET_CF_ENV_FILE || devNull };
delete env.POCKET_ASSET_BASE;
if (process.env.POCKET_CF_ASSET_BASE) env.POCKET_ASSET_BASE = process.env.POCKET_CF_ASSET_BASE;
const [mode, ...args] = process.argv.slice(2);
const run = (file, argv) => {
  const child = spawnSync(process.execPath, [file, ...argv], { env, stdio: 'inherit' });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
};
if (!['build', 'deploy', 'dev'].includes(mode)) throw Error('Expected build, deploy or dev');
run('node_modules/vite/bin/vite.js', ['build', '--outDir', '../../dist/cloudflare-web']);
run(
  'node_modules/wrangler/bin/wrangler.js',
  mode === 'build'
    ? ['deploy', '--dry-run', '--outdir', '.implementation/cloudflare', ...args]
    : [mode, ...args],
);
