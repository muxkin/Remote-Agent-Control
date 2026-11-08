import { assetSettings } from '../shared/assets.js';
import { edgeSecurityHeaders } from '../server/edge-policy.js';
import type { Env } from './env.js';

export function originFor(env: Env) {
  const url = new URL(env.POCKET_PUBLIC_ORIGIN);
  if (url.origin !== env.POCKET_PUBLIC_ORIGIN || !['http:', 'https:'].includes(url.protocol))
    throw Error('POCKET_PUBLIC_ORIGIN must be an exact HTTP(S) origin');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw Error('Public deployments require HTTPS');
  return url.origin;
}
export function securityHeaders(env: Env) {
  return edgeSecurityHeaders(
    assetSettings(env.POCKET_ASSET_BASE).origin,
    (env.POCKET_UPLOAD_ORIGINS ?? '').split(',').filter(Boolean),
  );
}
