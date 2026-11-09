import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { adapterDirectory, loadCatalog, writeJson } from './catalog.js';
import { readAdapterPackage, type AdapterPackage } from './package.js';
import { existsSync } from 'node:fs';

/** Desktop releases carry official packages; use the existing draining/rollback supervisor. */
export async function queueBundledUpdates(config: Config) {
  const catalog = loadCatalog(config),
    directory = adapterDirectory(config);
  for (const name of ['codex', 'dsh']) {
    let pack: AdapterPackage;
    try {
      pack = readAdapterPackage(resolve(config.webRoot, '../../packages', `adapter-${name}`));
    } catch {
      console.error(`Cannot queue bundled adapter update: ${name} package unavailable`);
      continue;
    }
    const target = `${pack.name}@${pack.version}`;
    if (!catalog.packages[target]) continue;
    for (const [instanceId, binding] of Object.entries(catalog.instances)) {
      const previous = catalog.packages[binding.current];
      if (
        !previous ||
        previous.name !== pack.name ||
        previous.stateVersion !== pack.agentAdapter.stateVersion
      )
        continue;
      if (pack.version.localeCompare(previous.version, 'en', { numeric: true }) <= 0) continue;
      const hex = createHash('sha256').update(`${instanceId}:${binding.current}:${target}`).digest('hex');
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}.json`;
      if (existsSync(join(directory, 'requests', id)) || existsSync(join(directory, 'results', id))) continue;
      writeJson(join(directory, 'requests', id), { instanceId, target, from: binding.current });
    }
  }
}
