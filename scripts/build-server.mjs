import { build } from 'esbuild';
import { rmSync } from 'node:fs';
rmSync('dist/server', { recursive: true, force: true });
await build({
  entryPoints: [
    'src/server/main.ts',
    'src/server/relay-main.ts',
    'src/server/cli.ts',
    'src/server/adapters/host.ts',
    'src/server/adapters/cli.ts',
  ],
  outbase: 'src',
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
});
