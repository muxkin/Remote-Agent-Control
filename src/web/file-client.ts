import type { UploadProgress } from '../shared/upload-progress';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  BLOCK_SIZE,
  MAX_FILE_SIZE,
  blockLength,
  decryptBlock,
  encryptBlock,
  fileRoute,
  hashBytes,
  type FileManifest,
} from '../shared/files';
import { deviceSession as session } from './device-session';
import { uploadToStorage } from './storage-upload';
import type { AttachmentResource } from './AttachmentAccess';

const owners = new Map<string, string>();
const inflight = new Map<string, Promise<Uint8Array>>();
const providers = new Map<string, { threadId: string; manifest: FileManifest }>();
const urls = new Map<string, Pick<AttachmentResource, 'url' | 'blob'>>();
const waited = new Set<string>();
let generation = 0;
function fileGuard(backendId = session.backendId) {
  const ticket = generation,
    scope = session.cache.scope,
    key = session.contentKey('', backendId);
  return () => {
    if (ticket !== generation || scope !== session.cache.scope || key !== session.contentKey('', backendId))
      throw new DOMException('Attachment session changed', 'AbortError');
  };
}
export function clearFileProviders() {
  generation++;
  owners.clear();
  inflight.clear();
  waited.clear();
  for (const { url } of urls.values()) if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  urls.clear();
  providers.clear();
}
const fileCall = (
  action: string,
  threadId: string,
  id: string,
  extra = {},
  bytes?: Uint8Array,
  bulk = false,
) =>
  session.request(
    'file',
    { action, threadId, fileId: id, ...extra },
    bytes,
    bulk,
    owners.get(id) ?? session.backendId,
  );
async function route(file: FileManifest) {
  if (session.establishingDirect && !waited.has(file.id)) {
    waited.add(file.id);
    if (waited.size > 128) waited.delete(waited.values().next().value!);
    const deadline = Date.now() + 2000;
    while (!session.direct && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }
  return fileRoute(file.size, session.direct, file.storage);
}
export async function uploadFile(threadId: string, file: File, progress: (value: UploadProgress) => void) {
  const backendId = session.backendId;
  if (!file.size || file.size > MAX_FILE_SIZE) throw Error('附件大小需在 1 B 至 256 MiB 之间');
  progress({ phase: 'preparing', loaded: 0, total: file.size });
  const whole = sha256.create(),
    hashes: string[] = [];
  for (let offset = 0; offset < file.size; offset += BLOCK_SIZE) {
    const bytes = new Uint8Array(await file.slice(offset, offset + BLOCK_SIZE).arrayBuffer());
    whole.update(bytes);
    hashes.push(hashBytes(bytes));
  }
  const digest = bytesToHex(whole.digest()),
    resumeKey = session.contentKey(`upload:${threadId}:${digest}:${file.size}`, backendId);
  let manifest = await session.cache.get<FileManifest>(resumeKey),
    missing: number[] = [];
  if (manifest) {
    try {
      owners.set(manifest.id, backendId);
      const result = await fileCall('missing', threadId, manifest.id);
      manifest = result.value.manifest;
      missing = result.value.missing;
    } catch {
      manifest = undefined;
    }
  }
  if (!manifest) {
    manifest = await session.api<FileManifest>(
      `/threads/${encodeURIComponent(threadId)}/uploads`,
      {
        method: 'POST',
        body: JSON.stringify({ name: file.name, size: file.size, sha256: digest, hashes }),
      },
      backendId,
    );
    owners.set(manifest.id, backendId);
    session.cache.put(resumeKey, manifest);
    await session.cache.flush();
    missing = hashes.map((_, i) => i);
  }
  const path = await route(manifest);
  while (missing.length) {
    progress({
      phase: 'uploading',
      loaded: file.size - missing.reduce((size, index) => size + blockLength(manifest!, index), 0),
      total: file.size,
    });
    const group: number[] = [missing[0]];
    while (group.length < 15 && missing[group.length] === group.at(-1)! + 1)
      group.push(missing[group.length]);
    let stored = false;
    if (path === 'storage' && !session.direct) {
      try {
        const { value: plan } = await fileCall('storage-plan', threadId, manifest.id, { indices: group });
        const chunks: BlobPart[] = [];
        for (const i of group)
          chunks.push(
            (await encryptBlock(
              manifest,
              i,
              new Uint8Array(await file.slice(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE).arrayBuffer()),
            )) as Uint8Array<ArrayBuffer>,
          );
        await uploadToStorage(plan.upload, new File(chunks, 'data', { type: 'application/octet-stream' }));
        await fileCall('storage-import', threadId, manifest.id, { objectId: plan.objectId });
        stored = true;
      } catch {
        session.metrics.fallback = '对象存储不可用，恢复加密中继';
      }
    }
    if (!stored) {
      // Resume only missing validated blocks if a storage import or previous path was interrupted.
      const present = await fileCall('missing', threadId, manifest.id);
      for (const index of group)
        if (present.value.missing.includes(index)) {
          const bytes = new Uint8Array(
            await file.slice(index * BLOCK_SIZE, (index + 1) * BLOCK_SIZE).arrayBuffer(),
          );
          await fileCall('write', threadId, manifest.id, { index }, bytes, true);
        }
    }
    missing.splice(0, group.length);
  }
  progress({ phase: 'finalizing', loaded: file.size, total: file.size });
  return (await fileCall('finish', threadId, manifest.id)).value as {
    id: string;
    name: string;
    path?: string;
  };
}
async function downloadBlock(threadId: string, manifest: FileManifest, index: number): Promise<Uint8Array> {
  const check = fileGuard(owners.get(manifest.id));
  const key = session.contentKey(`block:${manifest.sha256}:${index}`, owners.get(manifest.id));
  const cached = await session.cache.get<Uint8Array>(key);
  check();
  if (cached && hashBytes(cached) === manifest.hashes[index]) return cached;
  const old = inflight.get(key);
  if (old) return old;
  const pending = (async () => {
    let data: Uint8Array | undefined;
    if ((await route(manifest)) === 'storage') {
      try {
        const { value: plan } = await fileCall('storage-plan', threadId, manifest.id, { indices: [index] });
        const length = blockLength(manifest, index) + 16;
        const response = await fetch(plan.url, {
          headers: { Range: `bytes=0-${length - 1}` },
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
        });
        if (
          response.status !== 206 ||
          response.headers.get('content-range')?.split('/')[0] !== `bytes 0-${length - 1}`
        ) {
          await response.body?.cancel();
          throw Error('Range unsupported');
        }
        const reader = response.body!.getReader(),
          bytes = new Uint8Array(length);
        let count = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            if (count + part.value.length > length) throw Error('Invalid object size');
            bytes.set(part.value, count);
            count += part.value.length;
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        if (count !== length) throw Error('Truncated file');
        data = await decryptBlock(manifest, index, bytes);
        void fileCall('storage-done', threadId, manifest.id, { objectId: plan.objectId }).catch(() => {});
      } catch {
        session.metrics.fallback = '对象存储读取失败，恢复加密中继';
      }
    }
    check();
    data ??= (await fileCall('read', threadId, manifest.id, { index }, undefined, true)).bytes;
    check();
    if (!data || data.length !== blockLength(manifest, index) || hashBytes(data) !== manifest.hashes[index])
      throw Error('附件校验失败');
    await session.cache.block(key, data);
    check();
    return data;
  })();
  inflight.set(key, pending);
  try {
    return await pending;
  } finally {
    if (inflight.get(key) === pending) inflight.delete(key);
  }
}
async function readRange(threadId: string, file: FileManifest, start: number, end: number) {
  const data = new Uint8Array(end - start + 1);
  for (let index = Math.floor(start / BLOCK_SIZE); index <= Math.floor(end / BLOCK_SIZE); index++) {
    const block = await downloadBlock(threadId, file, index),
      begin = Math.max(start, index * BLOCK_SIZE),
      stop = Math.min(end + 1, (index + 1) * BLOCK_SIZE);
    data.set(block.subarray(begin - index * BLOCK_SIZE, stop - index * BLOCK_SIZE), begin - start);
  }
  return data;
}
if ('serviceWorker' in navigator)
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type !== 'local-file' || !event.ports[0]) return;
    const provider = providers.get(event.data.id),
      port = event.ports[0];
    if (!provider) {
      port.postMessage({ error: '附件未在当前页面授权' });
      return;
    }
    const { manifest, threadId } = provider;
    if (event.data.metadata) {
      port.postMessage({ size: manifest.size, mime: manifest.mime, name: manifest.name });
      return;
    }
    const { start, end } = event.data;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end >= manifest.size ||
      end - start >= BLOCK_SIZE
    ) {
      port.postMessage({ error: 'Invalid range' });
      return;
    }
    void readRange(threadId, manifest, start, end)
      .then((data) => port.postMessage({ data }, [data.buffer as ArrayBuffer]))
      .catch(() => port.postMessage({ error: '附件读取中断，请恢复电脑连接后重试' }));
  });
export async function mediaContent(threadId: string, path: string, backendId = session.backendId) {
  const check = fileGuard(backendId);
  const cacheKey = session.contentKey(
    `file:${threadId}:${hashBytes(new TextEncoder().encode(path))}`,
    backendId,
  );
  let manifest = await session.cache.get<FileManifest>(cacheKey);
  if (session.online || !manifest) {
    manifest = await session.api<FileManifest>(
      `/threads/${encodeURIComponent(threadId)}/media`,
      {
        method: 'POST',
        body: JSON.stringify({ path }),
      },
      backendId,
    );
    check();
    session.cache.put(cacheKey, manifest);
  }
  check();
  return manifestContent(threadId, manifest, backendId);
}
export async function exportSessionLog(threadId: string) {
  const backendId = session.backendId,
    check = fileGuard(backendId);
  const manifest = await session.api<FileManifest>(`/threads/${encodeURIComponent(threadId)}/export`, {
    method: 'POST',
  });
  check();
  return manifestContent(threadId, manifest, backendId);
}
async function manifestContent(threadId: string, manifest: FileManifest, backendId: string) {
  const check = fileGuard(backendId);
  owners.set(manifest.id, backendId);
  const metadata = { name: manifest.name, mime: manifest.mime, size: manifest.size, expiresAt: 0 };
  const key = session.contentKey(`url:${manifest.sha256}:${manifest.mime}`, backendId),
    old = urls.get(key);
  if (old) return { ...old, ...metadata };
  if (manifest.size > 8 * BLOCK_SIZE && !navigator.serviceWorker?.controller) {
    if ('serviceWorker' in navigator)
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener('controllerchange', done);
          resolve();
        };
        const timer = setTimeout(done, 3000);
        navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
      });
    check();
    if (!navigator.serviceWorker?.controller) throw Error('流式附件尚未就绪，请刷新页面后重试');
  }
  if (
    navigator.serviceWorker?.controller &&
    (manifest.mime.startsWith('video/') ||
      manifest.mime.startsWith('audio/') ||
      manifest.size > 8 * BLOCK_SIZE)
  ) {
    const id = crypto.randomUUID();
    providers.set(id, { manifest, threadId });
    const url = `/local-files/${id}`;
    urls.set(key, { url });
    return { url, ...metadata };
  }
  const parts: BlobPart[] = [],
    hash = sha256.create();
  for (let i = 0; i < manifest.hashes.length; i++) {
    const bytes = await downloadBlock(threadId, manifest, i);
    hash.update(bytes);
    parts.push(bytes as Uint8Array<ArrayBuffer>);
  }
  if (bytesToHex(hash.digest()) !== manifest.sha256) throw Error('附件整体校验失败');
  check();
  const blob = new Blob(parts, { type: manifest.mime });
  const url = URL.createObjectURL(blob);
  urls.set(key, { url, blob });
  if (urls.size > 32) {
    const entry = urls.entries().next().value!;
    if (entry[1].url.startsWith('blob:')) URL.revokeObjectURL(entry[1].url);
    urls.delete(entry[0]);
  }
  return { url, blob, ...metadata };
}

/** Both Blob and streaming downloads keep the original Unicode filename and extension. */
export function downloadFile(file: { url: string; name: string }) {
  const anchor = document.createElement('a');
  anchor.href = file.url.startsWith('/local-files/') ? `${file.url}?download=1` : file.url;
  if (file.url.startsWith('/local-files/')) {
    // Navigate through the service worker and use its Content-Disposition filename.
    // A download-attribute request can bypass the worker and cancel the stream.
    anchor.target = '_blank';
    anchor.rel = 'noopener';
  } else anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
