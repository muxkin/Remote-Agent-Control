import { join } from 'node:path';
import type { Config } from '../config.js';
import { DesktopAdapter } from '../desktop.js';
import { HistoryIndex } from '../history.js';
import { CodexBackend } from './codex.js';
import { DshBackend } from './dsh.js';
import { BackendRegistry } from './registry.js';

/** Built-in adapters only; constructing these objects never starts an Agent. */
export function builtinBackends(config: Config) {
  const registry = new BackendRegistry().register(
    new CodexBackend(config, new DesktopAdapter(config), new HistoryIndex(config.codexHome)),
  );
  for (const instance of config.backends ?? [])
    registry.register(
      new DshBackend(
        instance,
        join(config.stateDir, 'backends', instance.id, 'native-media'),
        config.readOnly,
      ),
    );
  return registry;
}
