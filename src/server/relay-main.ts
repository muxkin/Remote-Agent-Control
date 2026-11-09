import { mkdirSync } from 'node:fs';
import { callIceConfig } from './messaging/calls.js';
import { resolve, join } from 'node:path';
import { buildRelay } from './relay.js';
import { loadStorage } from './object-storage.js';
import { assetSettings } from '../shared/assets.js';
import { resourceProvider } from './resources/lago.js';
process.umask(0o077);
const state = resolve(process.env.POCKET_RELAY_STATE ?? './relay-state');
mkdirSync(state, { recursive: true, mode: 0o700 });
const app = await buildRelay({
  origin: new URL(process.env.POCKET_PUBLIC_ORIGIN!).origin,
  webRoot: resolve(process.env.POCKET_WEB_ROOT ?? './dist/web'),
  releaseRoot: process.env.POCKET_DESKTOP_RELEASE_ROOT
    ? resolve(process.env.POCKET_DESKTOP_RELEASE_ROOT)
    : undefined,
  database: join(state, 'relay.sqlite'),
  enrollmentSecret: process.env.POCKET_RELAY_ENROLLMENT ?? '',
  messaging: {
    resourcePolicy: resourceProvider(process.env),
    database: join(state, 'messaging.sqlite'),
    registrationCode: process.env.POCKET_IM_REGISTRATION_CODE,
    humanContacts: process.env.POCKET_IM_HUMAN_CONTACTS === 'true',
    callIce: callIceConfig(process.env),
    storage: process.env.POCKET_IM_MEDIA_ADAPTER
      ? await loadStorage(
          { adapterPath: resolve(process.env.POCKET_IM_MEDIA_ADAPTER) },
          'media',
          new URL(process.env.POCKET_PUBLIC_ORIGIN!).origin,
        )
      : undefined,
  },
  assetOrigin: assetSettings(process.env.POCKET_ASSET_BASE).origin,
  uploadOrigins: [
    ...new Set(
      [
        ...(process.env.POCKET_UPLOAD_ORIGINS ?? '').split(','),
        process.env.POCKET_IM_MEDIA_ORIGIN ?? '',
      ].filter(Boolean),
    ),
  ],
  trustedProxies: (process.env.POCKET_RELAY_TRUSTED_PROXIES ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
});
await app.app.listen({
  host: process.env.POCKET_RELAY_BIND ?? '127.0.0.1',
  port: Number(process.env.POCKET_RELAY_PORT ?? 4318),
});
console.log('Codex Pocket v2 coordination and encrypted relay ready');
process.on('SIGTERM', () => void app.app.close());
process.on('SIGINT', () => void app.app.close());
