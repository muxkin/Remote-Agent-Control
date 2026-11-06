import { conversationId } from './control-schemas.js';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, writeFile, stat, readdir, rm, rename } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { Uploads, uploadSpec } from './uploads.js';
import { mediaTypes } from './media.js';
import { loadStorage, signedDownload, validateUpload } from './object-storage.js';
import {
  BLOCK_SIZE,
  MAX_FILE_SIZE,
  fileSecret,
  encryptBlock,
  decryptBlock,
  hashBytes,
  blockLength,
  type FileManifest,
} from '../shared/files.js';

interface Transfer {
  manifest: FileManifest;
  file: string;
  device: string;
  thread: string;
  direction: 'up' | 'down';
  present: number[];
  expires: number;
  mtime?: number;
}
const uuid = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const blockIds = z
  .array(z.number().int().nonnegative().max(255))
  .min(1)
  .max(15)
  .refine((a) => new Set(a).size === a.length && a.every((n, i) => i === 0 || n === a[i - 1] + 1));
export class FileService {
  private transfers = new Map<string, Transfer>();
  private describing = new Map<string, Promise<FileManifest>>();
  private locks = new Set<string>();
  private directory: string;
  private cleanupTimer: NodeJS.Timeout;
  metrics = { storageUploadBytes: 0, storageDownloadBytes: 0, resumedBlocks: 0 };
  constructor(
    private config: Config,
    private uploads: Uploads,
  ) {
    this.directory = join(config.stateDir, 'transfers-v2');
    this.cleanupTimer = setInterval(() => void this.cleanup().catch(() => {}), 60000);
    this.cleanupTimer.unref();
    void this.cleanup().catch(() => {});
  }
  close() {
    clearInterval(this.cleanupTimer);
  }
  private async save(transfer: Transfer) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = join(this.directory, `${transfer.manifest.id}.json`);
    const pending = `${temp}.${randomUUID()}.tmp`;
    await writeFile(pending, JSON.stringify(transfer), { mode: 0o600 });
    await rename(pending, temp);
    this.transfers.set(transfer.manifest.id, transfer);
    if (this.transfers.size > 128) this.transfers.delete(this.transfers.keys().next().value!);
  }
  private async get(id: string, device: string, thread: string) {
    uuid.parse(id);
    const transfer: Transfer =
      this.transfers.get(id) ?? JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8'));
    if (transfer.device !== device || transfer.thread !== thread || transfer.expires < Date.now())
      throw Error('File transfer expired');
    return transfer;
  }
  async describe(file: string, device: string, thread: string, mime?: string): Promise<FileManifest> {
    const info = await stat(file);
    if (info.size > MAX_FILE_SIZE) throw Error('File too large');
    const fingerprint = `${device}:${thread}:${file}:${info.size}:${info.mtimeMs}`;
    const old = this.describing.get(fingerprint);
    if (old) {
      try {
        const manifest = await old;
        await this.get(manifest.id, device, thread);
        return manifest;
      } catch {
        this.describing.delete(fingerprint);
      }
    }
    const promise = (async () => {
      const hashes: string[] = [],
        whole = createHash('sha256');
      for await (const block of createReadStream(file, { highWaterMark: BLOCK_SIZE })) {
        hashes.push(hashBytes(block));
        whole.update(block);
      }
      const manifest: FileManifest = {
        id: randomUUID(),
        ...fileSecret(),
        name: basename(file),
        size: info.size,
        mime: mime ?? mediaTypes[extname(file).toLowerCase()] ?? 'application/octet-stream',
        sha256: whole.digest('hex'),
        hashes,
        storage: !!this.config.media,
      };
      await this.save({
        manifest,
        file,
        device,
        thread,
        direction: 'down',
        present: [],
        expires: Date.now() + 86400000,
        mtime: info.mtimeMs,
      });
      return manifest;
    })();
    this.describing.set(fingerprint, promise);
    if (this.describing.size > 128) this.describing.delete(this.describing.keys().next().value!);
    promise.catch(() => this.describing.delete(fingerprint));
    return promise;
  }
  async begin(body: unknown, device: string, thread: string) {
    const parsed = uploadSpec
      .extend({ hashes: z.array(hash).min(1).max(256) })
      .strict()
      .parse(body);
    if (parsed.hashes.length !== Math.ceil(parsed.size / BLOCK_SIZE)) throw Error('Invalid chunk manifest');
    const { hashes, ...spec } = parsed;
    const upload = await this.uploads.begin(spec, device, thread);
    const local = await this.uploads.get(upload.id, device, thread);
    const manifest: FileManifest = {
      ...spec,
      hashes,
      id: upload.id,
      ...fileSecret(),
      mime: 'application/octet-stream',
      storage: !!this.config.media,
    };
    await this.save({
      manifest,
      file: local.file + '.part',
      device,
      thread,
      direction: 'up',
      present: [],
      expires: Date.now() + 86400000,
    });
    return manifest;
  }
  private async readBlock(t: Transfer, index: number) {
    const length = blockLength(t.manifest, index),
      info = await stat(t.file);
    if (info.size !== t.manifest.size || info.mtimeMs !== t.mtime)
      throw Error('File changed; obtain a new manifest');
    const handle = await open(t.file, 'r');
    try {
      const bytes = Buffer.alloc(length);
      const result = await handle.read(bytes, 0, length, index * BLOCK_SIZE);
      if (result.bytesRead !== length || hashBytes(bytes) !== t.manifest.hashes[index])
        throw Error('File changed');
      return bytes;
    } finally {
      await handle.close();
    }
  }
  private async writeBlock(t: Transfer, index: number, bytes: Uint8Array) {
    if (
      t.direction !== 'up' ||
      bytes.length !== blockLength(t.manifest, index) ||
      hashBytes(bytes) !== t.manifest.hashes[index]
    )
      throw Error('Invalid file block');
    if (t.present.includes(index)) {
      this.metrics.resumedBlocks++;
      return;
    }
    if (this.locks.has(t.manifest.id)) throw Error('Transfer busy');
    this.locks.add(t.manifest.id);
    try {
      const handle = await open(t.file, 'r+').catch((e) => {
        if (e.code !== 'ENOENT') throw e;
        return open(t.file, 'w+', 0o600);
      });
      try {
        await handle.write(bytes, 0, bytes.length, index * BLOCK_SIZE);
        await handle.sync();
      } finally {
        await handle.close();
      }
      t.present.push(index);
      await this.save(t);
    } finally {
      this.locks.delete(t.manifest.id);
    }
  }
  async handle(
    action: string,
    body: any,
    device: string,
    bytes?: Uint8Array,
  ): Promise<{ value: any; bytes?: Uint8Array }> {
    const thread = conversationId.parse(body.threadId),
      t = await this.get(body.fileId, device, thread);
    if (action === 'missing')
      return {
        value: {
          manifest: t.manifest,
          missing: t.manifest.hashes.map((_, i) => i).filter((i) => !t.present.includes(i)),
        },
      };
    if (action === 'read') {
      if (t.direction !== 'down') throw Error('Invalid transfer direction');
      const data = await this.readBlock(t, body.index);
      return { value: { index: body.index }, bytes: data };
    }
    if (action === 'write') {
      if (!bytes) throw Error('Missing bytes');
      await this.writeBlock(t, body.index, bytes);
      return { value: { ok: true } };
    }
    if (action === 'finish') {
      if (t.direction !== 'up' || t.present.length !== t.manifest.hashes.length)
        throw Error('File incomplete');
      return { value: await this.uploads.finish(t.manifest.id, device, thread) };
    }
    if (!this.config.media) throw Error('Storage unavailable');
    const storage = await loadStorage(this.config.media, 'media', this.config.origin);
    if (action === 'storage-plan') {
      const indices = blockIds.parse(body.indices);
      for (const i of indices) blockLength(t.manifest, i);
      const objectId = randomUUID(),
        key = `${this.config.media.prefix ?? 'codex-pocket'}/private-encrypted-v2/${objectId}`;
      const object = { id: objectId, key, transfer: t.manifest.id, indices, expires: Date.now() + 86400000 };
      await writeFile(join(this.directory, `${objectId}.object`), JSON.stringify(object), { mode: 0o600 });
      const size = indices.reduce((n, i) => n + blockLength(t.manifest, i) + 16, 0);
      if (t.direction === 'up')
        return {
          value: {
            objectId,
            upload: validateUpload(
              await storage.createUpload({ key, size, expiresAt: Date.now() + 900000 }),
              storage,
            ),
          },
        };
      const temp = join(this.directory, `${objectId}.cipher`),
        handle = await open(temp, 'w', 0o600);
      try {
        for (const i of indices)
          await handle.write(await encryptBlock(t.manifest, i, await this.readBlock(t, i)));
      } finally {
        await handle.close();
      }
      try {
        await storage.putFile({
          key,
          file: temp,
          contentType: 'application/octet-stream',
          cacheControl: 'private, max-age=0',
          expiresAt: object.expires,
        });
        this.metrics.storageUploadBytes += size;
      } finally {
        await rm(temp, { force: true });
      }
      return {
        value: { objectId, url: await signedDownload(storage, key, Date.now() + 900000), indices, size },
      };
    }
    const objectId = uuid.parse(body.objectId),
      object = JSON.parse(await readFile(join(this.directory, `${objectId}.object`), 'utf8'));
    if (object.transfer !== t.manifest.id || object.expires < Date.now()) throw Error('Invalid object');
    if (action === 'storage-import') {
      if (t.direction !== 'up') throw Error('Invalid transfer direction');
      const url = await signedDownload(storage, object.key, Date.now() + 300000);
      let offset = 0;
      for (const index of object.indices as number[]) {
        const length = blockLength(t.manifest, index) + 16;
        if (!t.present.includes(index)) {
          const response = await fetch(url, {
            headers: { Range: `bytes=${offset}-${offset + length - 1}` },
            redirect: 'error',
            signal: AbortSignal.timeout(60000),
          });
          if (
            response.status !== 206 ||
            response.headers.get('content-range')?.split('/')[0] !== `bytes ${offset}-${offset + length - 1}`
          ) {
            await response.body?.cancel();
            throw Error('Storage must support Range');
          }
          const data = await boundedBody(response, length);
          this.metrics.storageDownloadBytes += data.length;
          await this.writeBlock(t, index, await decryptBlock(t.manifest, index, data));
        }
        offset += length;
      }
    } else if (action !== 'storage-done') throw Error('Unsupported file action');
    if (storage.remove) {
      await storage.remove(object.key);
      await rm(join(this.directory, `${objectId}.object`), { force: true });
    }
    return { value: { ok: true } };
  }
  private async cleanup() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const storage = this.config.media
      ? await loadStorage(this.config.media, 'media', this.config.origin)
      : null;
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith('.object') && !name.endsWith('.json')) continue;
      try {
        const file = join(this.directory, name),
          record = JSON.parse(await readFile(file, 'utf8'));
        if (record.expires > Date.now()) continue;
        if (name.endsWith('.object')) {
          if (!storage?.remove) continue;
          await storage.remove(record.key);
        }
        await rm(file, { force: true });
      } catch {
        /* Retry without logging names, object URLs, or secrets. */
      }
    }
  }
}
export async function boundedBody(response: Response, limit: number) {
  if (!response.body) throw Error('Empty object');
  const data = new Uint8Array(limit),
    reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > limit) throw Error('Object exceeds expected size');
      data.set(value, offset);
      offset += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (offset !== limit) throw Error('Truncated object');
  return data;
}
