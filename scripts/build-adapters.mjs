import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
execFileSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '-p', 'packages/adapter-sdk/tsconfig.json'],
  { stdio: 'inherit' },
);
for (const name of ['codex', 'dsh']) {
  const directory = `packages/adapter-${name}/dist`;
  mkdirSync(directory, { recursive: true });
  await build({
    entryPoints: [`packages/adapter-${name}/src/index.ts`],
    outfile: `${directory}/index.js`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
    sourcemap: true,
    metafile: true,
  }).then((result) => writeFileSync(`${directory}/build-meta.json`, JSON.stringify(result.metafile)));
  cpSync('packages/adapter-sdk/dist', `${directory}/sdk`, { recursive: true });
  writeFileSync(
    `${directory}/index.d.ts`,
    'export declare const createAdapter: import("./sdk/index.js").AdapterFactory;\n',
  );
}
copyFileSync('packages/adapter-codex/src/peer-bridge.py', 'packages/adapter-codex/dist/peer-bridge.py');
