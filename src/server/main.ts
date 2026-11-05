import { readConfig } from './config.js';
import { Store } from './store.js';
import { HistoryIndex } from './history.js';
import { DesktopAdapter } from './desktop.js';
import { buildGateway } from './gateway.js';

process.umask(0o077);
const config = readConfig();
const store = new Store(config.stateDir);
const history = new HistoryIndex(config.codexHome);
const desktop = new DesktopAdapter(config);
const app = await buildGateway(config, { store, history, desktop });
await app.listen({ host: '127.0.0.1', port: config.port });
store.recover();
await desktop.start();
console.log(`Codex Pocket Remote listening on 127.0.0.1:${config.port}; browser origin: ${config.origin}`);
console.log(
  `Desktop connected: ${desktop.status().connected}; controls enabled: ${desktop.status().writesEnabled}`,
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  desktop.stop();
  history.close();
  store.close();
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
