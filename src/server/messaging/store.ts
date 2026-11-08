import { DatabaseSync } from 'node:sqlite';
import { MessagingStore as CoreStore } from './store-core.js';
import type { MessagingDatabase } from './database.js';
export { ChatError, digest } from './store-core.js';

/** The VPS provider retains its existing on-disk SQLite format and settings. */
export class MessagingStore extends CoreStore {
  declare readonly db: DatabaseSync & MessagingDatabase;
  constructor(path: string, authority = 'local') {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    super(
      Object.assign(db, {
        transaction<T>(action: () => T): T {
          db.exec('BEGIN IMMEDIATE');
          try {
            const result = action();
            db.exec('COMMIT');
            return result;
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        },
      }),
      authority,
    );
  }
}
