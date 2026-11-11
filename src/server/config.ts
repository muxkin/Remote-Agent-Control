import { readInstances, type AdapterInstance } from './adapters/config.js';
import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assetSettings } from '../shared/assets.js';
import { platformRuntime, type PlatformRuntime } from './platform.js';

export interface StorageSettings {
  adapterPath: string;
  prefix?: string;
}

export interface Config {
  instances?: AdapterInstance[];
  port: number;
  origin: string;
  stateDir: string;
  readOnly: boolean;
  webRoot: string;
  assetOrigin: string | null;
  p2p?: { enabled: boolean; stunUrls: string[] };
  media?: StorageSettings;
  platform?: PlatformRuntime;
  relay?: { origin: string; enrollment: string };
}
export function readConfig(): Config {
  const port = z.coerce
    .number()
    .int()
    .min(1024)
    .max(65535)
    .parse(process.env.POCKET_PORT ?? 4317);
  const url = new URL(process.env.POCKET_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`);
  if (
    url.origin !== url.href.replace(/\/$/, '') ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
  ) {
    throw new Error('POCKET_PUBLIC_ORIGIN must be an HTTPS origin (HTTP is allowed only on loopback).');
  }
  let projectRoot = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifest = resolve(projectRoot, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'codex-pocket-remote')
      break;
    const parent = dirname(projectRoot);
    if (parent === projectRoot) throw Error('Gateway package root not found');
    projectRoot = parent;
  }
  const platform = platformRuntime();
  const codexPackage = resolve(projectRoot, 'packages/adapter-codex/package.json');
  return {
    port,
    instances: readInstances(existsSync(codexPackage) ? JSON.parse(readFileSync(codexPackage, 'utf8')).version : undefined),
    origin: url.origin,
    stateDir: resolve(process.env.POCKET_STATE_DIR ?? platform.stateDirectory()),
    platform,
    readOnly: process.env.POCKET_READ_ONLY === '1',
    webRoot: resolve(projectRoot, 'dist/web'),
    assetOrigin: assetSettings(process.env.POCKET_ASSET_BASE).origin,
    p2p: {
      enabled: process.env.POCKET_P2P !== '0',
      stunUrls: z
        .array(z.string().regex(/^stuns?:[^\s]+$/))
        .parse((process.env.POCKET_STUN_URLS ?? '').split(',').filter(Boolean)),
    },
    media: readStorageSettings('media'),
    relay: { origin: url.origin, enrollment: process.env.POCKET_RELAY_ENROLLMENT ?? '' },
  };
}

export function readStorageSettings(purpose: 'media' | 'assets'): StorageSettings | undefined {
  const path = process.env[purpose === 'media' ? 'POCKET_MEDIA_ADAPTER' : 'POCKET_ASSET_ADAPTER'];
  if (!path) return undefined;
  if ((/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) || !/\.m?js$/.test(path))
    throw Error('Storage adapter must be a local .js or .mjs file');
  return {
    adapterPath: resolve(path),
    prefix: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/)
      .parse(process.env.POCKET_MEDIA_PREFIX ?? 'codex-pocket'),
  };
}
