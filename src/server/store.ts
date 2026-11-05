import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Operation, OperationState } from '../shared/types.js';
import { platformRuntime, type PlatformRuntime } from './platform.js';

const hash = (x: string) => createHash('sha256').update(x).digest('hex');
export class ConflictError extends Error {}
export class Store {
  private db: DatabaseSync;
  constructor(directory: string, runtime: PlatformRuntime = platformRuntime()) {
    runtime.privateDirectory(directory);
    const file = join(directory, 'state.sqlite');
    this.db = new DatabaseSync(file);
    runtime.privateFile(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS pairing (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
        created INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        kind TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, turn_id TEXT, error TEXT,
        created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS device_keys (peer_id TEXT PRIMARY KEY, device_id TEXT NOT NULL,
        route_ticket TEXT UNIQUE NOT NULL);`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.db.prepare('PRAGMA table_info(operations)').all();
      if (!columns.some((c) => c.name === 'result_thread_id'))
        this.db.exec('ALTER TABLE operations ADD COLUMN result_thread_id TEXT');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  resultThread(id: string, threadId: string) {
    this.db.prepare('UPDATE operations SET result_thread_id=? WHERE id=?').run(threadId, id);
  }
  mintPairing(): { code: string; expiresAt: number } {
    const code = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + 5 * 60000;
    this.db.prepare('DELETE FROM pairing WHERE expires < ?').run(Date.now());
    this.db.prepare('INSERT INTO pairing VALUES (?, ?)').run(hash(code), expiresAt);
    return { code, expiresAt };
  }
  pair(
    code: string,
    name: string,
    peerId?: string,
  ): { token: string; deviceId: string; routeTicket?: string } | null {
    const token = randomBytes(32).toString('base64url');
    const deviceId = randomUUID();
    const routeTicket = randomBytes(32).toString('base64url');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db
        .prepare('DELETE FROM pairing WHERE hash = ? AND expires > ?')
        .run(hash(code), Date.now());
      if (changed.changes !== 1) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.db
        .prepare('INSERT INTO devices (id,name,token_hash,created,expires) VALUES (?,?,?,?,?)')
        .run(deviceId, name, hash(token), Date.now(), Date.now() + 30 * 86400000);
      if (peerId) {
        this.db
          .prepare(
            'UPDATE devices SET revoked=1 WHERE id IN (SELECT device_id FROM device_keys WHERE peer_id=?)',
          )
          .run(peerId);
        this.db
          .prepare('INSERT OR REPLACE INTO device_keys VALUES (?,?,?)')
          .run(peerId, deviceId, routeTicket);
      }
      this.db.exec('COMMIT');
      return { token, deviceId, ...(peerId ? { routeTicket } : {}) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  authenticate(token: string | undefined): { id: string; name: string } | null {
    if (!token || token.length > 256) return null;
    return (
      (this.db
        .prepare('SELECT id,name FROM devices WHERE token_hash=? AND revoked=0 AND expires>?')
        .get(hash(token), Date.now()) as any) ?? null
    );
  }
  devices(): any[] {
    return this.db.prepare('SELECT id,name,created,expires,revoked FROM devices ORDER BY created DESC').all();
  }
  peer(peerId: string): { id: string; name: string; expires: number; ticket: string } | null {
    return (
      (this.db
        .prepare(
          'SELECT d.id,d.name,d.expires,k.route_ticket AS ticket FROM devices d JOIN device_keys k ON k.device_id=d.id WHERE k.peer_id=? AND d.revoked=0 AND d.expires>?',
        )
        .get(peerId, Date.now()) as any) ?? null
    );
  }
  relayRoutes(): { ticket: string; expires: number; peerId?: string }[] {
    const pairs = this.db
      .prepare('SELECT hash AS ticket,expires FROM pairing WHERE expires>?')
      .all(Date.now());
    const devices = this.db
      .prepare(
        'SELECT k.route_ticket AS ticket,d.expires,k.peer_id AS peerId FROM device_keys k JOIN devices d ON d.id=k.device_id WHERE d.revoked=0 AND d.expires>?',
      )
      .all(Date.now());
    return [...pairs, ...devices] as any;
  }
  revoke(id: string): void {
    this.db.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(id);
  }
  recover(): void {
    this.db
      .prepare(
        "UPDATE operations SET state='uncertain',error='网关重启，等待桌面状态确认',updated=? WHERE state='dispatching'",
      )
      .run(Date.now());
    this.db
      .prepare(
        "UPDATE operations SET state='rejected',error='网关在发送前退出',updated=? WHERE state='received'",
      )
      .run(Date.now());
  }
  beginOperation(
    id: string,
    device: string,
    thread: string,
    kind: Operation['kind'],
    input: string,
  ): { operation: Operation; fresh: boolean } {
    const fingerprint = hash(JSON.stringify([thread, kind, input]));
    const now = Date.now();
    const inserted = this.db
      .prepare(
        'INSERT OR IGNORE INTO operations (id,device_id,thread_id,kind,fingerprint,state,created,updated) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(id, device, thread, kind, fingerprint, 'received', now, now);
    const row = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as any;
    if (row.device_id !== device || row.fingerprint !== fingerprint)
      throw new ConflictError('请求 ID 已用于其他操作');
    return { operation: this.toOperation(row), fresh: inserted.changes === 1 };
  }
  updateOperation(
    id: string,
    state: OperationState,
    turnId: string | null = null,
    error: string | null = null,
  ): Operation {
    this.db
      .prepare('UPDATE operations SET state=?,turn_id=COALESCE(?,turn_id),error=?,updated=? WHERE id=?')
      .run(state, turnId, error, Date.now(), id);
    return this.operation(id)!;
  }
  operation(id: string, device?: string): Operation | null {
    const row = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as any;
    return row && (!device || row.device_id === device) ? this.toOperation(row) : null;
  }
  pending(thread: string): Operation[] {
    return this.db
      .prepare(
        "SELECT * FROM operations WHERE thread_id=? AND state IN ('dispatching','accepted','uncertain')",
      )
      .all(thread)
      .map((x) => this.toOperation(x));
  }
  recent(device: string, thread: string): Operation[] {
    return this.db
      .prepare('SELECT * FROM operations WHERE device_id=? AND thread_id=? ORDER BY created DESC LIMIT 20')
      .all(device, thread)
      .map((x) => this.toOperation(x));
  }
  private toOperation(r: any): Operation {
    return {
      id: r.id,
      threadId: r.thread_id,
      kind: r.kind,
      state: r.state,
      ...(r.result_thread_id ? { resultThreadId: r.result_thread_id } : {}),
      turnId: r.turn_id,
      error: r.error,
      createdAt: r.created,
      updatedAt: r.updated,
    };
  }
  close(): void {
    this.db.close();
  }
}
