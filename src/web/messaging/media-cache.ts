import { openDB, type DBSchema } from 'idb';
import type { AttachmentResource } from '../AttachmentAccess';
import type { EncryptedFileCache } from '../../client/encrypted-messaging';
interface MediaDB extends DBSchema {
  blobs: {
    key: string;
    value: { key: string; account: string; blob: Blob; used: number };
    indexes: { account: string; used: number };
  };
}
const database =
  typeof indexedDB === 'undefined'
    ? Promise.resolve(undefined)
    : openDB<MediaDB>('pocket-im-media', 1, {
        upgrade(db) {
          const store = db.createObjectStore('blobs', { keyPath: 'key' });
          store.createIndex('account', 'account');
          store.createIndex('used', 'used');
        },
      }).catch(() => undefined);
const metadata = new Map<string, { until: number; promise: Promise<MediaResource> }>();
const memory = new Map<string, { url: string; size: number; blob?: Blob }>();
const inflight = new Map<string, Promise<string>>();
const decrypted = new Map<string, { name: string; mime: string; size: number }>();
const decrypting = new Map<string, Promise<void>>();
let account = '',
  epoch = 0,
  controller = new AbortController();
interface MediaResource extends AttachmentResource {
  encrypted?: string;
  cacheKey: string;
  width?: number;
  height?: number;
  downloadUrl: string;
}
let encryptedDownload:
  | ((
      path: string,
      signal?: AbortSignal,
      cache?: EncryptedFileCache,
    ) => Promise<{ data: Uint8Array<ArrayBuffer>; name: string; mime: string; size: number }>)
  | undefined;
export function setEncryptedDownload(loader: NonNullable<typeof encryptedDownload>) {
  encryptedDownload = loader;
}
export function setMediaAccount(next: string | null) {
  if (account === (next ?? '')) return;
  const previous = account;
  account = next ?? '';
  epoch++;
  controller.abort();
  controller = new AbortController();
  metadata.clear();
  inflight.clear();
  decrypted.clear();
  decrypting.clear();
  for (const value of memory.values()) URL.revokeObjectURL(value.url);
  memory.clear();
  if (previous)
    void database
      .then(async (db) => {
        if (!db) return;
        const keys = await db.getAllKeysFromIndex('blobs', 'account', previous);
        const tx = db.transaction('blobs', 'readwrite');
        for (const key of keys) void tx.store.delete(key);
        await tx.done;
      })
      .catch(() => {});
}
export function invalidateMediaConversations(ids: Set<string>) {
  for (const key of metadata.keys()) {
    const cid = /\/conversations\/([^/]+)\/files\//.exec(key)?.[1];
    if (cid && !ids.has(cid)) metadata.delete(key);
  }
}
async function readBlob(key: string) {
  try {
    const db = await database;
    if (!db) return;
    const tx = db.transaction('blobs', 'readwrite');
    const row = await tx.store.get(key);
    if (row) await tx.store.put({ ...row, used: Date.now() });
    await tx.done;
    return row?.blob;
  } catch {
    return undefined;
  }
}
async function saveBlob(key: string, account: string, blob: Blob, ticketEpoch: number) {
  try {
    const db = await database;
    if (!db || ticketEpoch !== epoch) return;
    const tx = db.transaction('blobs', 'readwrite');
    await tx.store.put({ key, account, blob, used: Date.now() });
    const rows = await tx.store.index('used').getAll();
    let total = rows.reduce((n, r) => n + r.blob.size, 0);
    for (const row of rows) {
      if (total <= 64 * 1024 * 1024) break;
      await tx.store.delete(row.key);
      total -= row.blob.size;
    }
    await tx.done;
  } catch {
    /* Storage denied/full: memory cache remains usable. */
  }
}
/** Reauthorize metadata before reading persistent bytes. Cache keys include the signed-in account and content hash. */
export async function loadMessagingMedia(
  accountId: string,
  path: string,
  signal?: AbortSignal,
  fullSize = false,
): Promise<MediaResource> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!accountId) throw Error('请先登录');
  // Provider sets the active account before any profile/media request.
  if (account !== accountId) throw new DOMException('Account changed', 'AbortError');
  const ticketEpoch = epoch,
    url = new URL(path, location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/im/')) throw Error('附件地址无效');
  const key = `${accountId}:${url.pathname}:${fullSize ? 'full' : 'preview'}`;
  let entry = metadata.get(key);
  if (!entry || entry.until <= Date.now()) {
    const request = fetch(`${url.pathname}?meta=1${fullSize ? '&full=1' : ''}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw Error('附件不可用或你已离开此会话');
      return (await response.json()) as MediaResource;
    });
    entry = { until: Date.now() + 20000, promise: request };
    metadata.set(key, entry);
    void request.catch(() => {
      if (metadata.get(key)?.promise === request) metadata.delete(key);
    });
  }
  const resource = await entry.promise;
  if (ticketEpoch !== epoch || signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (resource.encrypted) {
    const blobKey = `${accountId}:encrypted:${resource.cacheKey}`;
    if (!encryptedDownload) throw Error('请先解锁账号');
    if (!memory.has(blobKey)) {
      let pending = decrypting.get(blobKey);
      if (!pending) {
        const loader = encryptedDownload;
        pending = (async () => {
          const prefix = `${accountId}:cipher:v1:`;
          const file = await loader(path, controller.signal, {
            get: async (key) => {
              if (ticketEpoch !== epoch) return;
              const blob = await readBlob(prefix + key);
              if (ticketEpoch !== epoch) return;
              return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
            },
            put: async (key, bytes) => {
              await saveBlob(prefix + key, accountId, new Blob([bytes]), ticketEpoch);
            },
            remove: async (key) => {
              await (await database)?.delete('blobs', prefix + key);
            },
          });
          if (ticketEpoch !== epoch) throw new DOMException('Aborted', 'AbortError');
          const blob = new Blob([file.data], { type: file.mime });
          const url = URL.createObjectURL(blob);
          memory.set(blobKey, { url, size: file.size, blob });
          decrypted.set(blobKey, { name: file.name, mime: file.mime, size: file.size });
          let total = [...memory.values()].reduce((sum, v) => sum + v.size, 0);
          for (const [old, value] of memory) {
            if (total <= 64 * 1024 * 1024) break;
            if (old === blobKey) continue;
            total -= value.size;
            URL.revokeObjectURL(value.url);
            memory.delete(old);
            decrypted.delete(old);
          }
        })();
        decrypting.set(blobKey, pending);
        void pending
          .finally(() => {
            if (decrypting.get(blobKey) === pending) decrypting.delete(blobKey);
          })
          .catch(() => {});
      }
      await pending;
    }
    if (ticketEpoch !== epoch || signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const { url, blob } = memory.get(blobKey)!;
    return { ...resource, ...decrypted.get(blobKey)!, url, blob, downloadUrl: url, expiresAt: 0 };
  }
  if (!resource.mime.startsWith('image/')) return resource;
  const blobKey = `${accountId}:${resource.cacheKey}`;
  let cached = memory.get(blobKey)?.url;
  if (!cached) {
    let pending = inflight.get(blobKey);
    if (!pending) {
      const currentController = controller;
      pending = (async () => {
        let blob = await readBlob(blobKey);
        if (!blob) {
          const response = await fetch(resource.url, {
            credentials: resource.url.startsWith('/') ? 'same-origin' : 'omit',
            cache: 'default',
            signal: AbortSignal.any([currentController.signal, AbortSignal.timeout(45000)]),
          });
          if (!response.ok) throw Error('图片加载失败，请重试');
          blob = await response.blob();
          if (ticketEpoch !== epoch) throw new DOMException('Aborted', 'AbortError');
          await saveBlob(blobKey, accountId, blob, ticketEpoch);
        }
        if (ticketEpoch !== epoch) throw new DOMException('Aborted', 'AbortError');
        const objectURL = URL.createObjectURL(blob);
        memory.set(blobKey, { url: objectURL, size: blob.size });
        let total = [...memory.values()].reduce((n, v) => n + v.size, 0);
        for (const [old, value] of memory) {
          if (total <= 64 * 1024 * 1024) break;
          if (old === blobKey) continue;
          URL.revokeObjectURL(value.url);
          memory.delete(old);
          total -= value.size;
        }
        return objectURL;
      })();
      inflight.set(blobKey, pending);
      void pending
        .finally(() => {
          if (inflight.get(blobKey) === pending) inflight.delete(blobKey);
        })
        .catch(() => {});
    }
    cached = await pending;
  } else {
    const value = memory.get(blobKey)!;
    memory.delete(blobKey);
    memory.set(blobKey, value);
  }
  if (ticketEpoch !== epoch || signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return { ...resource, url: cached, expiresAt: 0 };
}
