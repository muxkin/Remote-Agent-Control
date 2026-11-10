import { build } from 'esbuild';
import { rmSync, writeFileSync } from 'node:fs';
rmSync('dist/server', { recursive: true, force: true });
const { metafile } = await build({
  entryPoints: [
    'src/server/main.ts',
    'src/server/relay-main.ts',
    'src/server/messaging-migrate.ts',
    'src/server/cli.ts',
    'src/server/adapters/host.ts',
    'src/server/adapters/cli.ts',
    'src/server/backends/appearance-cli.ts',
  ],
  outbase: 'src',
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
  metafile: true,
});
writeFileSync('dist/server/build-meta.json', JSON.stringify(metafile));

// The migration executable is offline tooling, never part of the relay request path.
await build({
  entryPoints: ['scripts/im-encryption-migrate.ts'],
  outfile: 'dist/server/account-encryption-migrate.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
});
