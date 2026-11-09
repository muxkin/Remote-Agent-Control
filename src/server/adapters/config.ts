import { readFileSync } from 'node:fs';
import { z } from 'zod';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const packageName = z.string().regex(/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/);
const instanceSchema = z
  .object({
    id,
    name: z.string().min(1).max(80),
    plugin: packageName,
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/),
    config: z.record(z.string(), z.unknown()).default({}),
    secrets: z.record(z.string(), z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default({}),
  })
  .strict();
export interface AdapterInstance {
  id: string;
  name: string;
  plugin: string;
  version: string;
  config: Record<string, unknown>;
}
/** One-way legacy mapping preserves IDs and does not write credentials to the registry. */
export function readInstances(): AdapterInstance[] {
  const codex: AdapterInstance = {
    id: 'codex-local',
    name: 'Codex',
    plugin: '@agent-remote/adapter-codex',
    version: '1.0.7',
    config: {},
  };
  for (const [key, env] of Object.entries({
    home: 'CODEX_HOME',
    root: 'POCKET_CODEX_ROOT',
    socket: 'POCKET_CODEX_SOCKET',
    executable: 'POCKET_CODEX_EXECUTABLE',
    appTools: 'POCKET_CODEX_APP_TOOLS',
    python: 'POCKET_PYTHON',
  }))
    if (process.env[env]) codex.config[key] = process.env[env];
  const file = process.env.POCKET_ADAPTERS_FILE ?? process.env.POCKET_BACKENDS_FILE;
  if (!file) return [codex];
  const input = z
    .array(z.unknown())
    .max(32)
    .parse(JSON.parse(readFileSync(file, 'utf8')));
  const entries: AdapterInstance[] = input.map((raw: any) => {
    if (raw?.type === 'dsh') {
      const legacy = z
        .object({
          id,
          name: z.string().min(1).max(80),
          type: z.literal('dsh'),
          url: z.string().url(),
          tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
          version: z.string().min(1).max(80),
        })
        .strict()
        .parse(raw);
      return {
        id: legacy.id,
        name: legacy.name,
        plugin: '@agent-remote/adapter-dsh',
        version: '1.0.2',
        config: { url: legacy.url, token: process.env[legacy.tokenEnv] ?? '', version: legacy.version },
      };
    }
    const parsed = instanceSchema.parse(raw),
      config = { ...parsed.config };
    for (const [key, env] of Object.entries(parsed.secrets)) config[key] = process.env[env] ?? '';
    return { ...parsed, config };
  });
  if (!entries.some((e) => e.id === codex.id)) entries.unshift(codex);
  if (new Set(entries.map((e) => e.id)).size !== entries.length)
    throw Error('Adapter instance IDs must be unique');
  if (entries.find((e) => e.id === codex.id)?.plugin !== codex.plugin)
    throw Error('codex-local is reserved for legacy Codex clients');
  return entries;
}
