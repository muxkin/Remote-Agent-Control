import type { AdapterFactory } from '../../adapter-sdk/src/index.js';
import { DshBackend } from './backend.js';
import { join } from 'node:path';
export const createAdapter: AdapterFactory = (context) => {
  const { url, token, version = 'unknown' } = context.config;
  if (typeof url !== 'string' || typeof token !== 'string' || typeof version !== 'string')
    throw Error('DSH requires url, token and an optional diagnostic version');
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)
    throw Error('Invalid DSH endpoint');
  return new DshBackend(
    { id: context.id, name: context.name, url, token, version },
    join(context.stateDirectory, 'native-media'),
    context.readOnly,
  );
};
