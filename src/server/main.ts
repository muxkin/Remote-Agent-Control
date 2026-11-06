import { builtinBackends } from './backends/builtins.js';
import { readConfig } from './config.js';
import { Store } from './store.js';
import { HostService } from './host-service.js';

process.umask(0o077);
const config = readConfig();
const store = new Store(config.stateDir);
const registry = builtinBackends(config);
const host = await HostService.create(config, { store, registry });
store.recover();
await registry.start();
host.start();
console.log(`Codex Pocket Remote v2 connecting to ${config.origin}; no inbound business port`);
for (const backend of registry.all())
  console.log(
    `${backend.id}: connected=${backend.status().connected}; controls=${backend.status().writesEnabled}`,
  );
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  host.stop();
  registry.stop();
  store.close();
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
