import type { Config } from '../config.js';
import { AdapterManager } from '../adapters/manager.js';
/** Official packages are installed by default; all instances use isolated hosts. */
export function builtinBackends(config: Config, supervise = true) {
  return new AdapterManager(config, supervise);
}
