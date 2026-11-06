import { expect, it } from 'vitest';
import Arborist from '@npmcli/arborist';
import pacote from 'pacote';
import { execaNode } from 'execa';
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import { manual as remove } from 'rimraf';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { validatePackage, installAdapter } from '../src/server/adapters/install.js';
import { loadCatalog } from '../src/server/adapters/catalog.js';
import { fixtureConfig } from './helpers.js';
import { hostEnvironment } from '../src/server/adapters/package.js';

async function timed<T>(phase: string, action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await action();
  } finally {
    // Public phase names only; no paths, config, credentials or dependency output.
    process.stderr.write(`[release-contract] ${phase}: ${Math.round(performance.now() - started)} ms\n`);
  }
}

it.each(['sdk', 'codex', 'dsh'])(
  'installs %s offline outside the repository with an empty cache',
  async (name) => {
    const directory = await mkdtemp(join(tmpdir(), 'adapter-release-'));
    try {
      const manifest = JSON.parse(await readFile(`packages/adapter-${name}/package.json`, 'utf8'));
      const archive = resolve(`dist/adapters/agent-remote-adapter-${name}-${manifest.version}.tgz`);
      const destination = join(directory, name);
      await timed(`${name} offline install`, () =>
        new Arborist({
          path: destination,
          ignoreScripts: true,
          omit: ['dev'],
          audit: false,
          offline: true,
          cache: join(directory, 'empty-cache'),
        }).reify({ add: [archive] }),
      );
      const root = join(destination, 'node_modules', manifest.name);
      if (name !== 'sdk') await timed(`${name} host validation`, () => validatePackage(root));
      else expect(await readFile(join(root, 'dist/index.d.ts'), 'utf8')).toContain('AdapterFactory');
      expect(await readFile(join(root, 'package.json'), 'utf8')).not.toContain('workspace:');
    } finally {
      await timed(`${name} offline installation cleanup`, () => remove(directory));
    }
  },
  240000,
);

it('pins bundled runtime dependencies so a later gateway build cannot mutate installed plugins', async () => {
  const { mkdir, writeFile, cp, symlink } = await import('node:fs/promises');
  const { readAdapterPackage } = await import('../src/server/adapters/package.js');
  const { snapshotBundled } = await import('../src/server/adapters/bundled.js');
  const directory = await mkdtemp(join(tmpdir(), 'adapter-pin-'));
  try {
    const source = join(directory, 'source');
    await cp('test/fixtures/adapter', source, { recursive: true });
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    manifest.dependencies = { 'fixture-dependency': '1.0.0' };
    manifest.bundleDependencies = true;
    await writeFile(join(source, 'package.json'), JSON.stringify(manifest));
    const dependency = join(source, 'node_modules/fixture-dependency');
    await mkdir(dependency, { recursive: true });
    await writeFile(
      join(dependency, 'package.json'),
      JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', type: 'module', main: 'index.js' }),
    );
    await writeFile(join(dependency, 'index.js'), 'export const value="original";');
    await writeFile(
      join(source, 'index.mjs'),
      'import "fixture-dependency";\n' + (await readFile(join(source, 'index.mjs'), 'utf8')),
    );
    // macOS temp paths commonly contain /var -> /private/var symlinks.
    const alias = join(directory, 'source-alias');
    await symlink(source, alias, 'junction');
    const pack = readAdapterPackage(alias),
      archive = join(directory, 'fixture.tgz');
    await pacote.tarball.file(pack.root, archive, { Arborist, ignoreScripts: true });
    const pinned = await snapshotBundled(pack, join(directory, 'private'), archive);
    await writeFile(join(source, 'index.mjs'), 'throw Error("changed gateway package");');
    expect(await snapshotBundled(pack, join(directory, 'private'), archive)).toBe(pinned);
    await rm(source, { recursive: true, force: true });
    await validatePackage(pinned);
  } finally {
    await remove(directory);
  }
}, 30000);

it('installs through npm libraries without a CLI and never executes package lifecycle scripts', async () => {
  const { cp, writeFile } = await import('node:fs/promises');
  const config = fixtureConfig(),
    root = config.desktopRoot;
  const previous = process.env.npm_execpath;
  try {
    process.env.npm_execpath = join(root, 'no-npm-cli-here.js');
    const source = join(root, 'source');
    await cp('test/fixtures/adapter', source, { recursive: true });
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    manifest.scripts = { preinstall: 'node -e "process.exit(93)"', install: 'node -e "process.exit(94)"' };
    await writeFile(join(source, 'package.json'), JSON.stringify(manifest));
    const archive = join(root, 'test-adapter.tgz');
    await pacote.tarball.file(await realpath(source), archive, {
      Arborist,
      ignoreScripts: true,
    });
    const key = await installAdapter(config, archive);
    expect(key).toBe('test-adapter@1.0.0');
    await validatePackage(loadCatalog(config).packages[key].root);
    await expect(installAdapter(config, archive)).rejects.toThrow('immutable');
    await expect(installAdapter(config, 'test-adapter@latest')).rejects.toThrow('exact npm version');
    // Exercise the production JS host without tsx or a repository-local plugin dependency.
    const compiled = await execaNode(resolve('dist/server/adapters/cli.js'), ['install', archive], {
      nodeOptions: [],
      extendEnv: false,
      env: { ...hostEnvironment(), POCKET_STATE_DIR: join(root, 'compiled state 中文') },
    });
    expect(compiled.stdout.trim()).toBe(key);
  } finally {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
    await remove(root);
  }
}, 60000);
