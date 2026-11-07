import { openDB, type DBSchema } from 'idb';
import type { AttachmentResource } from '../AttachmentAccess';
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
const memory = new Map<string, { url: string; size: number }>();
const inflight = new Map<string, Promise<string>>();
let account = '',
  epoch = 0,
  controller = new AbortController();
interface MediaResource extends AttachmentResource {
  cacheKey: string;
  width?: number;
  height?: number;
  downloadUrl: string;
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
    return (await (await database)?.get('blobs', key))?.blob;
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
