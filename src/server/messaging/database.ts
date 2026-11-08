import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

/** Synchronous transactions are shared by Node SQLite and Durable Object SQLite. */
export interface MessagingDatabase {
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    all(...values: SQLInputValue[]): Record<string, SQLOutputValue>[];
    run(...values: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
  transaction<T>(action: () => T): T;
  close(): void;
}
