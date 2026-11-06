import type { Config } from '../config.js';
import { prepareBundled } from '../adapters/catalog.js';
import { AdapterManager } from '../adapters/manager.js';
/** Official packages are installed by default; all instances use isolated hosts. */
export async function builtinBackends(config: Config, supervise = true) {
  await prepareBundled(config);
  return new AdapterManager(config, supervise);
}
