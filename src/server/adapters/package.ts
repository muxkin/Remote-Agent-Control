import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { z } from 'zod';
export const manifestSchema = z.object({
  name: z.string().regex(/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  type: z.literal('module'),
  agentAdapter: z.object({
    sdk: z.literal(1),
    entry: z.string().min(1),
    stateVersion: z.number().int().positive(),
    product: z.string().min(1).max(80),
    name: z.string().min(1).max(80),
    presentation: z.object({
      description: z.string().max(160).optional(),
      creation: z.object({
        empty: z.boolean(),
        permission: z.enum(['native', 'select']),
        preset: z.boolean(),
        plan: z.boolean(),
        notice: z.string().max(160).optional(),
      }),
      plan: z.enum(['settings', 'control', 'none']),
      fileReferences: z.boolean(),
      exportLog: z.boolean(),
      nativeCommands: z.boolean(),
    }),
  }),
});
export type AdapterPackage = ReturnType<typeof readAdapterPackage>;
export function readAdapterPackage(directory: string) {
  const root = realpathSync(directory),
    manifest = manifestSchema.parse(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')));
  const entry = realpathSync(resolve(root, manifest.agentAdapter.entry));
  const local = relative(root, entry);
  if (
    !local ||
    local === '..' ||
    local.startsWith(`..${sep}`) ||
    isAbsolute(local) ||
    !statSync(entry).isFile()
  )
    throw Error('Adapter entry must be a file inside its package');
  return { root, entry, ...manifest };
}
/** Deliberately omit NODE_OPTIONS, npm credentials, pairing secrets and other instance credentials. */
export function hostEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'APPDATA',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'XDG_RUNTIME_DIR',
    'XDG_STATE_HOME',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'DBUS_SESSION_BUS_ADDRESS',
    'LANG',
    'LC_ALL',
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
