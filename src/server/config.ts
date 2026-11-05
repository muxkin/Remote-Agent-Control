import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assetSettings } from '../shared/assets.js';

export interface StorageSettings {
  adapterPath: string;
  prefix?: string;
}

export interface Config {
  port: number;
  origin: string;
  stateDir: string;
  codexHome: string;
  desktopRoot: string;
  socketPath: string;
  readOnly: boolean;
  webRoot: string;
  bridgePath: string;
  assetOrigin: string | null;
  p2p?: { enabled: boolean; stunUrls: string[] };
  media?: StorageSettings;
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
  const codexHome = resolve(process.env.CODEX_HOME ?? `${homedir()}/.codex`);
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
  return {
    port,
    origin: url.origin,
    codexHome,
    stateDir: resolve(
      process.env.POCKET_STATE_DIR ??
        `${process.env.XDG_STATE_HOME ?? `${homedir()}/.local/state`}/codex-pocket-remote`,
    ),
    desktopRoot: '/usr/lib/chatgpt',
    socketPath: `${codexHome}/ipc/ipc.sock`,
    readOnly: process.env.POCKET_READ_ONLY === '1',
    webRoot: resolve(projectRoot, 'dist/web'),
    bridgePath: resolve(projectRoot, 'src/server/peer-bridge.py'),
    assetOrigin: assetSettings(process.env.POCKET_ASSET_BASE).origin,
    p2p: {
      enabled: process.env.POCKET_P2P !== '0',
      stunUrls: z
        .array(z.string().regex(/^stuns?:[^\s]+$/))
        .parse((process.env.POCKET_STUN_URLS ?? '').split(',').filter(Boolean)),
    },
    media: readStorageSettings('media'),
  };
}

export function readStorageSettings(purpose: 'media' | 'assets'): StorageSettings | undefined {
  const path = process.env[purpose === 'media' ? 'POCKET_MEDIA_ADAPTER' : 'POCKET_ASSET_ADAPTER'];
  if (!path) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || !/\.m?js$/.test(path))
    throw Error('Storage adapter must be a local .js or .mjs file');
  return {
    adapterPath: resolve(path),
    prefix: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/)
      .parse(process.env.POCKET_MEDIA_PREFIX ?? 'codex-pocket'),
  };
}
