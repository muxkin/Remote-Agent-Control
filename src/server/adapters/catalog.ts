import { snapshotBundled } from './bundled.js';
import { existsSync, statSync, unlinkSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { readAdapterPackage, type AdapterPackage } from './package.js';
import { platformRuntime } from '../platform.js';
export interface Catalog {
  format: 1;
  packages: Record<string, { root: string; name: string; version: string; stateVersion: number }>;
  instances: Record<string, { current: string; previous?: string }>;
}
export const packageKey = (pack: AdapterPackage) => `${pack.name}@${pack.version}`;
export const adapterDirectory = (config: Config) => join(config.stateDir, 'adapters');
export function writeJson(path: string, value: unknown, privateParent = false) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
  // Atomic files inherit the already restricted Windows parent ACL.
  if (!privateParent) platformRuntime().privateFile(path);
}
export function loadCatalog(config: Config): Catalog {
  const directory = adapterDirectory(config);
  platformRuntime().privateDirectory(directory);
  const path = join(directory, 'registry.json');
  const catalog: Catalog = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : { format: 1, packages: {}, instances: {} };
  if (catalog.format !== 1) throw Error('Unsupported adapter registry format');
  // Reading manifests never imports product implementations into the gateway.
  for (const name of ['codex', 'dsh']) {
    const root = resolve(config.webRoot, '../../packages', `adapter-${name}`);
    if (!existsSync(root)) continue;
    let pack;
    try {
      pack = readAdapterPackage(root);
    } catch {
      continue;
    }
    const key = packageKey(pack);
    try {
      if (!catalog.packages[key])
        catalog.packages[key] = {
          root: snapshotBundled(pack, directory),
          name: pack.name,
          version: pack.version,
          stateVersion: pack.agentAdapter.stateVersion,
        };
    } catch {
      /* A damaged bundled package must not stop other instances. */
    }
  }
  return catalog;
}
export function saveCatalog(config: Config, catalog: Catalog) {
  writeJson(join(adapterDirectory(config), 'registry.json'), catalog);
}
/** Serialize CLI installs and supervisor activation without holding a lock while draining. */
export async function catalogLock<T>(config: Config, fn: () => Promise<T> | T): Promise<T> {
  const { open, unlink } = await import('node:fs/promises');
  const path = join(adapterDirectory(config), 'registry.lock');
  let handle;
  for (let n = 0; n < 100; n++) {
    try {
      handle = await open(path, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        const owner = Number(readFileSync(path, 'utf8'));
        if (owner > 0) {
          try {
            process.kill(owner, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') unlinkSync(path);
          }
        } else if (Date.now() - statSync(path).mtimeMs > 30000) unlinkSync(path);
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (!handle) throw Error('Adapter registry is busy; retry later');
  try {
    return await fn();
  } finally {
    await handle.close();
    await unlink(path);
  }
}
