import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import type { MessagingDatabase } from '../server/messaging/database.js';

export class DurableDatabase implements MessagingDatabase {
  private depth = 0;
  constructor(private storage: DurableObjectStorage) {}
  get isTransaction() {
    return this.depth > 0;
  }
  exec(sql: string) {
    this.storage.sql.exec(sql);
  }
  prepare(sql: string) {
    const query = (values: SQLInputValue[]) =>
      this.storage.sql.exec(
        sql,
        ...(values.map((v) =>
          typeof v === 'bigint'
            ? Number(v)
            : ArrayBuffer.isView(v)
              ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice().buffer
              : v,
        ) as SqlStorageValue[]),
      );
    const row = (r: Record<string, SqlStorageValue>): Record<string, SQLOutputValue> =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, v instanceof ArrayBuffer ? new Uint8Array(v) : v]),
      );
    return {
      get: (...values: SQLInputValue[]) => {
        const r = query(values).toArray()[0];
        return r ? row(r) : undefined;
      },
      all: (...values: SQLInputValue[]) => query(values).toArray().map(row),
      run: (...values: SQLInputValue[]) => {
        // Exhaust the cursor before reading connection-local change metadata.
        query(values).toArray();
        const r = this.storage.sql.exec('SELECT changes() AS changes, last_insert_rowid() AS id').one();
        return { changes: Number(r.changes), lastInsertRowid: Number(r.id) };
      },
    };
  }
  transaction<T>(action: () => T): T {
    return this.storage.transactionSync(() => {
      this.depth++;
      try {
        return action();
      } finally {
        this.depth--;
      }
    });
  }
  close() {}
}
