import { readConfig } from '../config.js';
import { installAdapter } from './install.js';
import { adapterDirectory, loadCatalog, writeJson } from './catalog.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { platformRuntime } from '../platform.js';
process.umask(0o077);
const config = readConfig(),
  [command, ...args] = process.argv.slice(2);
try {
  if (command === 'install') console.log(await installAdapter(config, args[0] ?? ''));
  else if (command === 'list') {
    const catalog = loadCatalog(config);
    console.table(
      Object.entries(catalog.packages).map(([key, p]) => ({ package: key, stateVersion: p.stateVersion })),
    );
    console.table(Object.entries(catalog.instances).map(([instance, b]) => ({ instance, ...b })));
    const status = join(adapterDirectory(config), 'status.json');
    if (existsSync(status)) {
      const latest = JSON.parse(readFileSync(status, 'utf8'));
      console.log(`Supervisor status: ${new Date(latest.updatedAt).toISOString()}`);
      console.table(latest.instances);
    }
  } else if (command === 'upgrade' || command === 'rollback') {
    const instanceId = args[0],
      catalog = loadCatalog(config),
      binding = catalog.instances[instanceId];
    if (!binding) throw Error('Unknown configured instance');
    const target = command === 'rollback' ? binding.previous : args[1];
    if (!target || !catalog.packages[target])
      throw Error('Install the exact target package first (or no previous version exists)');
    const id = randomUUID(),
      directory = adapterDirectory(config);
    platformRuntime().privateDirectory(join(directory, 'requests'));
    writeJson(join(directory, 'requests', `${id}.json`), { instanceId, target });
    const result = join(directory, 'results', `${id}.json`),
      deadline = Date.now() + 35000;
    while (!existsSync(result) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    if (!existsSync(result)) {
      console.log(`Queued ${id}; the gateway supervisor will apply it when available. Result: ${result}`);
    } else {
      const outcome = JSON.parse(readFileSync(result, 'utf8'));
      if (!outcome.ok) throw Error(outcome.error);
      console.log(`${instanceId}: ${target}`);
    }
  } else
    throw Error(
      'Usage: adapter install <name@version|release.tgz> | list | upgrade <instance> <name@version> | rollback <instance>',
    );
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
