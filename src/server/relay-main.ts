import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { buildRelay } from './relay.js';
import { assetSettings } from '../shared/assets.js';
process.umask(0o077);
const state = resolve(process.env.POCKET_RELAY_STATE ?? './relay-state');
mkdirSync(state, { recursive: true, mode: 0o700 });
const app = await buildRelay({
  origin: new URL(process.env.POCKET_PUBLIC_ORIGIN!).origin,
  webRoot: resolve(process.env.POCKET_WEB_ROOT ?? './dist/web'),
  database: join(state, 'relay.sqlite'),
  enrollmentSecret: process.env.POCKET_RELAY_ENROLLMENT ?? '',
  assetOrigin: assetSettings(process.env.POCKET_ASSET_BASE).origin,
  uploadOrigins: (process.env.POCKET_UPLOAD_ORIGINS ?? '').split(',').filter(Boolean),
});
await app.app.listen({
  host: process.env.POCKET_RELAY_BIND ?? '127.0.0.1',
  port: Number(process.env.POCKET_RELAY_PORT ?? 4318),
});
console.log('Codex Pocket v2 coordination and encrypted relay ready');
process.on('SIGTERM', () => void app.app.close());
process.on('SIGINT', () => void app.app.close());
