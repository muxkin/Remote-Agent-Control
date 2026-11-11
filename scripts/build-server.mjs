import { build } from 'esbuild';
import { rmSync, writeFileSync } from 'node:fs';
rmSync('dist/server', { recursive: true, force: true });
const { metafile } = await build({
  entryPoints: {
    'server/main': 'src/server/main.ts',
    'server/relay-main': 'src/server/relay-main.ts',
    'server/messaging-migrate': 'src/server/messaging-migrate.ts',
    'server/cli': 'src/server/cli.ts',
    'server/adapters/host': 'src/server/adapters/host.ts',
    'server/adapters/cli': 'src/server/adapters/cli.ts',
    'server/backends/appearance-cli': 'src/server/backends/appearance-cli.ts',
    'server/desktop-im-agent': 'src/server/desktop-im-agent.ts',
    'server/desktop-im-cli': 'scripts/im-agent.ts',
    'server/desktop-call-cli': 'scripts/im-call-agent.ts',
  },
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
