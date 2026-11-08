import type { MessagingStore } from './store-core.js';
import type { MediaObject } from './objects.js';

/** Durable deletion queue; shared objects survive until their last live reference disappears. */
export class MediaGarbage {
  constructor(
    private store: MessagingStore,
    private remove: (key: string) => Promise<void>,
  ) {}
  pending(keys: string[], delay = 600000) {
    for (const key of new Set(keys))
      this.store.db
        .prepare(
          'INSERT INTO im_object_gc VALUES (?,?) ON CONFLICT(key) DO UPDATE SET not_before=MIN(not_before,excluded.not_before)',
        )
        .run(key, Date.now() + delay);
  }
  committed(object: MediaObject) {
    for (const key of new Set([object.key, object.previewKey]))
      this.store.db.prepare('DELETE FROM im_object_gc WHERE key=?').run(key);
  }
  async collect(limit = 100) {
    const db = this.store.db;
    this.store.transaction(() => {
      const orphans = db
        .prepare(
          `SELECT * FROM im_media_objects m WHERE
        (kind='file' AND NOT EXISTS(SELECT 1 FROM im_files f WHERE f.id=m.id AND f.removed=0)) OR
        (kind='sticker' AND NOT EXISTS(SELECT 1 FROM im_stickers s WHERE s.id=m.id)) OR
        (kind='avatar' AND NOT EXISTS(SELECT 1 FROM im_avatars a WHERE a.id=m.id)) LIMIT ?`,
        )
        .all(limit);
      for (const row of orphans) {
        const object = JSON.parse(String(row.metadata)) as MediaObject;
        this.pending([object.key, object.previewKey], 0);
        db.prepare('DELETE FROM im_media_objects WHERE kind=? AND id=?').run(row.kind!, row.id!);
      }
    });
    let removed = 0;
    for (const row of db
      .prepare('SELECT key FROM im_object_gc WHERE not_before<=? LIMIT ?')
      .all(Date.now(), limit)) {
      const key = String(row.key);
      if (
        !db
          .prepare(
            "SELECT 1 FROM im_media_objects WHERE json_extract(metadata,'$.key')=? OR json_extract(metadata,'$.previewKey')=? LIMIT 1",
          )
          .get(key, key)
      ) {
        await this.remove(key);
        removed++;
      }
      db.prepare('DELETE FROM im_object_gc WHERE key=?').run(key);
    }
    return removed;
  }
}
