import Arborist from '@npmcli/arborist';
import pacote from 'pacote';
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { manual as remove } from 'rimraf';

const directory = resolve('dist/adapters');
await remove(directory);
await mkdir(directory, { recursive: true });
const hashes = [];
for (const name of ['sdk', 'codex', 'dsh']) {
  const source = resolve(`packages/adapter-${name}`);
  const stage = await mkdtemp(join(tmpdir(), 'agent-adapter-package-'));
  try {
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const installManifest = { ...manifest };
    delete installManifest.bundleDependencies;
    // Copy only this package's own release files. npm owns the entire dependency tree.
    await cp(join(source, 'dist'), join(stage, 'dist'), { recursive: true });
    await cp(join(source, 'README.md'), join(stage, 'README.md'));
    await writeFile(join(stage, 'package.json'), JSON.stringify(installManifest, null, 2) + '\n');
    if (Object.keys(manifest.dependencies ?? {}).length) {
      const lock = join(source, 'package-lock.json');
      if (!existsSync(lock) && !process.argv.includes('--update-locks'))
        throw Error(`${name}: missing independent dependency lockfile`);
      if (existsSync(lock)) await cp(lock, join(stage, 'package-lock.json'));
      await new Arborist({
        path: stage,
        ignoreScripts: true,
        // The connected-client path uses JS fallbacks; omit optional native accelerators
        // so the same official archive works on all supported operating systems.
        omit: ['dev', 'optional'],
        audit: false,
        workspacesEnabled: false,
        packageLock: true,
        fetchTimeout: 180000,
        fetchRetries: 1,
      }).reify();
      const resolvedLock = await readFile(join(stage, 'package-lock.json'), 'utf8');
      if (process.argv.includes('--update-locks')) await writeFile(lock, resolvedLock);
      else if (resolvedLock !== (await readFile(lock, 'utf8')))
        throw Error(`${name}: release dependency lock changed; update and review it explicitly`);
      await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    }
    const filename = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
    await pacote.tarball.file(stage, join(directory, filename), {
      Arborist,
      ignoreScripts: true,
      offline: true,
    });
    hashes.push(
      `${createHash('sha256')
        .update(await readFile(join(directory, filename)))
        .digest('hex')}  ${filename}`,
    );
    console.log(filename);
  } finally {
    await remove(stage);
  }
}
await writeFile(join(directory, 'SHA256SUMS'), hashes.join('\n') + '\n');
