import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { signedDownload, type StorageAdapter } from '../object-storage.js';
import type { MessagingStore } from './store-core.js';
import { MediaGarbage } from './object-gc.js';

export type MediaKind = 'file' | 'sticker' | 'avatar';
export interface MediaObject {
  key: string;
  hash: string;
  previewKey: string;
  previewHash: string;
  previewMime: string;
  previewSize: number;
  width?: number;
  height?: number;
}
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const tables = { file: 'im_files', sticker: 'im_stickers', avatar: 'im_avatars' } as const;
/** Immutable private objects, shared by saved stickers and every message referencing them. */
export class MessagingObjects {
  readonly redirects = true;
  private garbage: MediaGarbage;
  constructor(
    readonly store: MessagingStore,
    readonly adapter: StorageAdapter | undefined,
    readonly origin: string,
  ) {
    this.garbage = new MediaGarbage(store, async (key) => {
      if (!adapter?.remove) throw Error('Object storage deletion is not configured');
      await adapter.remove(key);
    });
  }
  collectGarbage() {
    return this.garbage.collect();
  }
  metadata(kind: MediaKind, id: string): MediaObject | undefined {
    const row = this.store.db
      .prepare('SELECT metadata FROM im_media_objects WHERE kind=? AND id=?')
      .get(kind, id);
    return row ? JSON.parse(String(row.metadata)) : undefined;
  }
  async put(data: Buffer, mime: string): Promise<MediaObject> {
    if (!this.adapter) throw Error('Object storage is not configured');
    const sha = hash(data),
      key = `im-media-v1/${sha.slice(0, 2)}/${sha}-${randomUUID()}`;
    let preview = data,
      previewMime = mime,
      width: number | undefined,
      height: number | undefined;
    if (mime.startsWith('image/')) {
      try {
        const image = sharp(data, { limitInputPixels: 40_000_000 });
        const info = await image.metadata();
        width = info.width;
        height = info.height;
        if (mime !== 'image/gif' && (info.pages ?? 1) === 1) {
          const candidate = await image
            .rotate()
            .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();
          if (candidate.length < data.length) {
            preview = candidate;
            previewMime = 'image/webp';
          }
        }
      } catch {
        /* Original bytes stay available when thumbnail decoding fails. */
      }
    }
    const previewHash = hash(preview),
      previewKey = previewHash === sha ? key : `${key}-preview`;
    this.garbage.pending([key, previewKey]);
    const folder = await mkdtemp(join(tmpdir(), 'im-object-'));
    try {
      const upload = async (key: string, bytes: Buffer, contentType: string) => {
        const file = join(folder, key.split('/').at(-1)!);
        await writeFile(file, bytes, { mode: 0o600 });
        await this.adapter!.putFile({
          key,
          file,
          contentType,
          cacheControl: 'private, max-age=31536000, immutable',
          allowedOrigin: this.origin,
        });
      };
      await upload(key, data, mime);
      if (previewKey !== key) await upload(previewKey, preview, previewMime);
    } catch (error) {
      this.garbage.pending([key, previewKey], 0);
      throw error;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
    return {
      key,
      hash: sha,
      previewKey,
      previewHash,
      previewMime,
      previewSize: preview.length,
      width,
      height,
    };
  }
  commit(kind: MediaKind, id: string, object: MediaObject) {
    this.store.transaction(() => {
      if (
        !this.store.db
          .prepare(`SELECT 1 FROM ${tables[kind]} WHERE id=?${kind === 'file' ? ' AND removed=0' : ''}`)
          .get(id)
      )
        return;
      this.store.db
        .prepare('INSERT OR REPLACE INTO im_media_objects(kind,id,metadata) VALUES (?,?,?)')
        .run(kind, id, JSON.stringify(object));
      this.store.db.prepare(`UPDATE ${tables[kind]} SET data=x'' WHERE id=?`).run(id);
      this.garbage.committed(object);
    });
  }
  async resource(
    kind: MediaKind,
    id: string,
    file: { name: string; mime: string; size: number; data: Buffer; encrypted?: string },
    url: string,
    full: boolean,
  ) {
    const object = this.metadata(kind, id),
      expiresAt = (Math.floor(Date.now() / 60000) + 5) * 60000;
    const preview = !!object && !full && file.mime.startsWith('image/');
    if (object && !this.adapter) throw Error('Private object storage is unavailable');
    return {
      ...(file.encrypted ? { encrypted: file.encrypted } : {}),
      url: object
        ? await signedDownload(this.adapter!, preview ? object.previewKey : object.key, expiresAt)
        : url,
      name: file.name,
      mime: preview ? object!.previewMime : file.mime,
      size: preview ? object!.previewSize : file.size,
      cacheKey: object ? (preview ? object.previewHash : object.hash) : hash(file.data),
      expiresAt,
      width: object?.width,
      height: object?.height,
      downloadUrl: `${url}${url.includes('?') ? '&' : '?'}download=1`,
    };
  }
  async bytes(kind: MediaKind, id: string, local: Buffer) {
    const object = this.metadata(kind, id);
    if (!object) return local;
    if (!this.adapter) throw Error('Private object storage is unavailable');
    const response = await fetch(await signedDownload(this.adapter, object.key, Date.now() + 60000), {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Error('Object download failed');
    const data = Buffer.from(await response.arrayBuffer());
    if (hash(data) !== object.hash) throw Error('Object integrity mismatch');
    return data;
  }
  async restoreLocal() {
    let restored = 0;
    for (const kind of ['file', 'sticker', 'avatar'] as const) {
      const rows = this.store.db
        .prepare(
          `SELECT id FROM ${tables[kind]} WHERE length(data)=0${kind === 'file' ? ' AND removed=0' : ''}`,
        )
        .all();
      for (const row of rows) {
        const id = String(row.id);
        const bytes = await this.bytes(kind, id, Buffer.alloc(0));
        if (!bytes.length) throw Error('Missing original object');
        this.store.db
          .prepare(`UPDATE ${tables[kind]} SET data=? WHERE id=? AND length(data)=0`)
          .run(bytes, id);
        restored++;
      }
    }
    return { restored };
  }
  async migrate(limit = 100) {
    let migrated = 0,
      bytes = 0;
    for (const kind of ['file', 'sticker', 'avatar'] as const) {
      const rows = this.store.db
        .prepare(`SELECT id,mime,data,size FROM ${tables[kind]} WHERE length(data)>0 LIMIT ?`)
        .all(Math.max(0, limit - migrated));
      for (const row of rows) {
        const data = Buffer.from(row.data as Uint8Array),
          object = await this.put(data, String(row.mime));
        // Verify existing data before releasing the local copy.
        const response = await fetch(await signedDownload(this.adapter!, object.key, Date.now() + 60000), {
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok || hash(Buffer.from(await response.arrayBuffer())) !== object.hash)
          throw Error('Object verification failed');
        this.commit(kind, String(row.id), object);
        migrated++;
        bytes += data.length;
      }
    }
    return { migrated, bytes };
  }
}
