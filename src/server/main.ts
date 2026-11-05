import { readConfig } from './config.js';
import { Store } from './store.js';
import { HistoryIndex } from './history.js';
import { DesktopAdapter } from './desktop.js';
import { HostService } from './host-service.js';

process.umask(0o077);
const config = readConfig();
const store = new Store(config.stateDir);
const history = new HistoryIndex(config.codexHome);
const desktop = new DesktopAdapter(config);
const host = await HostService.create(config, { store, history, desktop });
store.recover();
await desktop.start();
host.start();
console.log(`Codex Pocket Remote v2 connecting to ${config.origin}; no inbound business port`);
console.log(
  `Desktop connected: ${desktop.status().connected}; controls enabled: ${desktop.status().writesEnabled}`,
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  host.stop();
  desktop.stop();
  history.close();
  store.close();
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
