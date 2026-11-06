import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { codexPaths, type CodexConnector } from './connector.js';
import { platformRuntime, type PlatformRuntime } from '../../../src/server/platform.js';
export interface CodexConfig {
  codexHome: string;
  desktopRoot: string;
  socketPath: string;
  bridgePath: string;
  readOnly: boolean;
  platform?: PlatformRuntime;
  codexConnector?: CodexConnector;
}
export function nativeConfig(config: Record<string, unknown>, readOnly = false): CodexConfig {
  const options = z
    .object({
      home: z.string().optional(),
      root: z.string().optional(),
      socket: z.string().optional(),
      executable: z.string().optional(),
      appTools: z.string().optional(),
      python: z.string().optional(),
    })
    .strict()
    .parse(config);
  for (const [key, value] of Object.entries({
    POCKET_CODEX_ROOT: options.root,
    POCKET_CODEX_SOCKET: options.socket,
    POCKET_CODEX_EXECUTABLE: options.executable,
    POCKET_CODEX_APP_TOOLS: options.appTools,
    POCKET_PYTHON: options.python,
  }))
    if (value) process.env[key] = value;
  const platform = platformRuntime(),
    home = resolve(options.home ?? `${homedir()}/.codex`);
  return {
    codexHome: home,
    ...codexPaths(platform.id, home),
    readOnly,
    bridgePath: fileURLToPath(new URL('./peer-bridge.py', import.meta.url)),
    platform,
  };
}
