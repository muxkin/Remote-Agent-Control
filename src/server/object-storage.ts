import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { StorageSettings } from './config.js';
import type { DirectUpload } from '../shared/storage.js';

export interface StoredFile {
  key: string;
  file: string;
  contentType?: string;
  cacheControl?: string;
  allowedOrigin?: string;
}
export interface StorageAdapter {
  version: 1;
  visibility: 'private' | 'public';
  /** Exact HTTPS origins used for direct browser uploads. No wildcards. */
  uploadOrigins: string[];
  putFile(file: StoredFile): Promise<'created' | 'exists'>;
  downloadUrl(key: string, expiresAt: number): Promise<string>;
  createUpload(input: { key: string; size: number; expiresAt: number }): Promise<DirectUpload>;
  remove?(key: string): Promise<void>;
}
export type StorageFactory = (context: {
  purpose: 'media' | 'assets';
  origin: string;
}) => StorageAdapter | Promise<StorageAdapter>;

const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  });
const httpsOrigin = httpsUrl.refine(
  (value) =>
    /^https:\/\/(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d+)?$/.test(value) && new URL(value).origin === value,
);
const headers = z.record(z.string().regex(/^[a-zA-Z0-9-]+$/), z.string().regex(/^[^\r\n]*$/)).optional();
const directUpload = z.discriminatedUnion('encoding', [
  z
    .object({
      url: httpsUrl,
      method: z.literal('POST'),
      encoding: z.literal('multipart'),
      fields: z.record(z.string().min(1).max(200), z.string()),
      fileField: z.string().min(1).max(200),
      headers,
    })
    .strict(),
  z.object({ url: httpsUrl, method: z.literal('PUT'), encoding: z.literal('raw'), headers }).strict(),
]);
const adapters = new WeakMap<StorageSettings, Map<string, Promise<StorageAdapter>>>();

/** Only an operator-selected local module can supply an adapter; never a browser parameter. */
export function loadStorage(settings: StorageSettings, purpose: 'media' | 'assets', origin: string) {
  let contexts = adapters.get(settings);
  if (!contexts) adapters.set(settings, (contexts = new Map()));
  const contextKey = `${purpose}:${origin}`;
  let pending = contexts.get(contextKey);
  if (!pending) {
    pending = (async () => {
      try {
        const module = await import(pathToFileURL(settings.adapterPath).href);
        if (typeof module.default !== 'function') throw Error();
        const adapter: StorageAdapter = await module.default({ purpose, origin });
        if (
          adapter.version !== 1 ||
          adapter.visibility !== (purpose === 'media' ? 'private' : 'public') ||
          typeof adapter.putFile !== 'function' ||
          (purpose === 'media' &&
            (typeof adapter.downloadUrl !== 'function' || typeof adapter.createUpload !== 'function'))
        )
          throw Error();
        adapter.uploadOrigins = [...new Set(z.array(httpsOrigin).parse(adapter.uploadOrigins))];
        return adapter;
      } catch {
        // SDK exceptions can contain signed URLs or credentials; do not expose them.
        throw Error('Storage adapter initialization failed; check its local configuration and contract.');
      }
    })();
    contexts.set(contextKey, pending);
    pending.catch(() => contexts.delete(contextKey));
  }
  return pending;
}

export function validateUpload(value: unknown, adapter: StorageAdapter): DirectUpload {
  const plan = directUpload.parse(value);
  if (!adapter.uploadOrigins.includes(new URL(plan.url).origin))
    throw Error('Storage upload origin was not declared by the adapter');
  if (plan.encoding === 'multipart' && Object.hasOwn(plan.fields, plan.fileField))
    throw Error('Storage upload file field overlaps a policy field');
  return plan;
}

export async function signedDownload(adapter: StorageAdapter, key: string, expiresAt: number) {
  return httpsUrl.parse(await adapter.downloadUrl(key, expiresAt));
}
