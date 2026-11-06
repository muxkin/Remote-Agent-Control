import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { validatePackage } from '../src/server/adapters/install.js';
const exec = promisify(execFile);
it('installs release tarballs outside the repository with their own dependencies and SDK declarations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'adapter-release-'));
  const npm = process.env.npm_execpath!;
  try {
    const packages = ['sdk', 'codex', 'dsh'];
    const tarballs: string[] = [];
    for (const name of packages) {
      const result = await exec(
        process.execPath,
        [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory],
        { cwd: resolve(`packages/adapter-${name}`) },
      );
      const tarball = join(directory, JSON.parse(result.stdout)[0].filename);
      tarballs.push(tarball);
      const destination = join(directory, name);
      await exec(
        process.execPath,
        [
          npm,
          'install',
          '--prefix',
          destination,
          '--ignore-scripts',
          '--omit=dev',
          '--no-audit',
          '--no-fund',
          '--',
          tarball,
        ],
        { timeout: 180000, maxBuffer: 2 * 1024 * 1024 },
      );
      const root = join(destination, 'node_modules', `@agent-remote/adapter-${name}`);
      if (name !== 'sdk') await validatePackage(root);
      else expect(await readFile(join(root, 'dist/index.d.ts'), 'utf8')).toContain('AdapterFactory');
      expect(await readFile(join(root, 'package.json'), 'utf8')).not.toContain('workspace:');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 240000);

it('pins bundled runtime dependencies so a later gateway build cannot mutate installed plugins', async () => {
  const { mkdir, writeFile, cp } = await import('node:fs/promises');
  const { readAdapterPackage } = await import('../src/server/adapters/package.js');
  const { snapshotBundled } = await import('../src/server/adapters/bundled.js');
  const directory = await mkdtemp(join(tmpdir(), 'adapter-pin-'));
  try {
    const source = join(directory, 'source');
    await cp('test/fixtures/adapter', source, { recursive: true });
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    manifest.dependencies = { 'fixture-dependency': '1.0.0' };
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
    const pack = readAdapterPackage(source),
      pinned = snapshotBundled(pack, join(directory, 'private'));
    await writeFile(join(source, 'index.mjs'), 'throw Error("changed gateway package");');
    expect(snapshotBundled(pack, join(directory, 'private'))).toBe(pinned);
    await rm(source, { recursive: true, force: true });
    await validatePackage(pinned);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
