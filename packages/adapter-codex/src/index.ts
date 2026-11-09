import type { AdapterFactory } from '../../adapter-sdk/src/index.js';
import { CodexBackend } from './backend.js';
import { DesktopAdapter } from './desktop.js';
import { HistoryIndex } from './history.js';
import { nativeConfig } from './config.js';
import { join } from 'node:path';
export const createAdapter: AdapterFactory = (context) => {
  const config = nativeConfig(context.config, context.readOnly);
  return new CodexBackend(
    config,
    new DesktopAdapter(config),
    new HistoryIndex(config.codexHome, join(context.stateDirectory, 'recovered-images')),
    context.id,
    context.name,
  );
};
