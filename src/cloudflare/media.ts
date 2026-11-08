import { createHash, randomUUID } from 'node:crypto';
import { MediaGarbage } from '../server/messaging/object-gc.js';
import type { MessagingStore } from '../server/messaging/store-core.js';
import type { MediaKind, MediaObject } from '../server/messaging/objects.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const tables = { file: 'im_files', sticker: 'im_stickers', avatar: 'im_avatars' } as const;

/** R2 remains private. Every download uses the existing account/member authorization route. */
export class R2MessagingObjects {
  readonly redirects = false;
  private garbage: MediaGarbage;
  constructor(
    private store: MessagingStore,
    private bucket: R2Bucket,
  ) {
    this.garbage = new MediaGarbage(store, (key) => bucket.delete(key));
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
  async put(data: Buffer, _mime: string): Promise<MediaObject> {
    const sha = hash(data),
      key = `im-media-v1/${sha.slice(0, 2)}/${sha}-${randomUUID()}`;
    this.garbage.pending([key]);
    // Chat files and stickers are already encrypted; avatars have already been resized.
    await this.bucket.put(key, data, {
      httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, no-store' },
    });
    return {
      key,
      hash: sha,
      previewKey: key,
      previewHash: sha,
      previewMime: _mime,
      previewSize: data.length,
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
        .prepare('INSERT OR REPLACE INTO im_media_objects VALUES (?,?,?)')
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
    _full: boolean,
  ) {
    const object = this.metadata(kind, id);
    return {
      ...(file.encrypted ? { encrypted: file.encrypted } : {}),
      url,
      name: file.name,
      mime: file.mime,
      size: file.size,
      cacheKey: object?.hash ?? hash(file.data),
      expiresAt: (Math.floor(Date.now() / 60000) + 5) * 60000,
      downloadUrl: `${url}${url.includes('?') ? '&' : '?'}download=1`,
      width: undefined,
      height: undefined,
    };
  }
  async bytes(kind: MediaKind, id: string, local: Buffer) {
    const object = this.metadata(kind, id);
    if (!object) return local;
    const result = await this.bucket.get(object.key);
    if (!result) throw Error('Private object unavailable');
    const bytes = Buffer.from(await result.arrayBuffer());
    if (hash(bytes) !== object.hash) throw Error('Object integrity mismatch');
    return bytes;
  }
}
export async function avatar(images: ImagesBinding, bytes: Buffer) {
  const stream = () => new Response(new Uint8Array(bytes)).body!;
  const info = await images.info(stream());
  if (!('width' in info) || info.width * info.height > 20_000_000) throw Error('Image too large');
  const result = await images
    .input(stream())
    .transform({ width: 256, height: 256, fit: 'cover' })
    .output({ format: 'image/webp', quality: 85, anim: false });
  return Buffer.from(await result.response().arrayBuffer());
}
