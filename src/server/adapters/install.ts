import Arborist from '@npmcli/arborist';
import { manual as remove } from 'rimraf';
import { mkdtemp, readFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { adapterDirectory, loadCatalog, saveCatalog, catalogLock, packageKey } from './catalog.js';
import { readAdapterPackage } from './package.js';
import { startHostProcess } from './process.js';
import { checkPackage } from './protocol.js';
export async function validatePackage(directory: string) {
  readAdapterPackage(directory);
  const host = startHostProcess(directory, undefined, true);
  host.connection.listen();
  const timer = setTimeout(() => void host.close(), 20000);
  try {
    const result = await host.connection.sendRequest(checkPackage);
    if (result.sdk !== 1) throw Error('Unsupported adapter SDK protocol');
  } catch (error) {
    throw new Error(`Adapter factory or dependency check failed: ${(error as Error).message}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    await host.close();
  }
}
export async function installAdapter(config: Config, spec: string) {
  const local = /\.(?:tgz|tar\.gz)$/.test(spec) && existsSync(resolve(spec));
  if (!local && !/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(spec))
    throw Error('Use an exact npm version (name@1.2.3) or a local release .tgz');
  const directory = adapterDirectory(config);
  loadCatalog(config);
  const stage = await mkdtemp(join(directory, 'stage-'));
  try {
    // Use npm's own dependency resolver/installer without locating or spawning a platform CLI.
    const installer = new Arborist({
      path: stage,
      ignoreScripts: true,
      omit: ['dev'],
      audit: false,
      saveExact: true,
      packageLock: true,
      fetchTimeout: 180000,
      fetchRetries: 1,
    });
    await installer.reify({ add: [local ? resolve(spec) : spec] });
    const installed = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8')).dependencies;
    const names = Object.keys(installed ?? {});
    if (names.length !== 1) throw Error('Expected exactly one adapter package');
    const root = join(stage, 'node_modules', names[0]);
    const pack = readAdapterPackage(root);
    await validatePackage(root);
    const key = packageKey(pack);
    await catalogLock(config, async () => {
      const catalog = loadCatalog(config);
      if (catalog.packages[key]) throw Error(`${key} is already installed; published versions are immutable`);
      const destination = join(directory, 'packages', randomUUID());
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await rename(stage, destination);
      const finalRoot = join(destination, 'node_modules', pack.name);
      catalog.packages[key] = {
        root: finalRoot,
        name: pack.name,
        version: pack.version,
        stateVersion: pack.agentAdapter.stateVersion,
      };
      saveCatalog(config, catalog);
    });
    return key;
  } finally {
    await remove(stage);
  }
}
