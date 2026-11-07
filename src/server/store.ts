import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_BACKEND, type BackendAppearance, type BackendAppearancePatch } from '../shared/backends.js';
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
        route_ticket TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS backend_appearance (backend_id TEXT PRIMARY KEY,
        overrides TEXT NOT NULL, revision INTEGER NOT NULL);`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.db.prepare('PRAGMA table_info(operations)').all();
      if (!columns.some((c) => c.name === 'result_thread_id'))
        this.db.exec('ALTER TABLE operations ADD COLUMN result_thread_id TEXT');
      if (!columns.some((c) => c.name === 'backend_id'))
        this.db.exec("ALTER TABLE operations ADD COLUMN backend_id TEXT NOT NULL DEFAULT 'codex-local'");
      const primary = this.db
        .prepare('PRAGMA table_info(operations)')
        .all()
        .filter((c) => Number(c.pk) > 0);
      if (primary.length === 1)
        this.db.exec(`
        ALTER TABLE operations RENAME TO operations_legacy;
        CREATE TABLE operations (id TEXT NOT NULL, device_id TEXT NOT NULL, thread_id TEXT NOT NULL,
          kind TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, turn_id TEXT, error TEXT,
          created INTEGER NOT NULL, updated INTEGER NOT NULL, result_thread_id TEXT,
          backend_id TEXT NOT NULL DEFAULT 'codex-local', PRIMARY KEY(backend_id,id));
        INSERT INTO operations SELECT id,device_id,thread_id,kind,fingerprint,state,turn_id,error,created,updated,result_thread_id,backend_id FROM operations_legacy;
        DROP TABLE operations_legacy;
        CREATE INDEX operations_by_conversation ON operations(backend_id,thread_id,device_id,created);
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  backendAppearance(id: string): { overrides: Partial<BackendAppearance>; revision: number } {
    const row = this.db.prepare('SELECT overrides,revision FROM backend_appearance WHERE backend_id=?').get(id);
    return row ? { overrides: JSON.parse(String(row.overrides)), revision: Number(row.revision) } : { overrides: {}, revision: 0 };
  }
  updateBackendAppearance(id: string, patch: BackendAppearancePatch, expectedRevision?: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.backendAppearance(id);
      if (expectedRevision !== undefined && expectedRevision !== current.revision)
        throw new ConflictError('设置已在其他设备或工具中更新，请重新打开编辑后再保存');
      const overrides: Partial<BackendAppearance> = { ...current.overrides };
      for (const field of ['name', 'description', 'icon'] as const) {
        if (patch[field] === null) delete overrides[field];
        else if (patch[field] !== undefined) Object.assign(overrides, { [field]: patch[field] });
      }
      const revision = current.revision + 1;
      this.db.prepare('INSERT INTO backend_appearance VALUES (?,?,?) ON CONFLICT(backend_id) DO UPDATE SET overrides=excluded.overrides,revision=excluded.revision')
        .run(id, JSON.stringify(overrides), revision);
      this.db.exec('COMMIT');
      return { overrides, revision };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  resultThread(id: string, threadId: string, backendId = DEFAULT_BACKEND) {
    this.db
      .prepare('UPDATE operations SET result_thread_id=? WHERE id=? AND backend_id=?')
      .run(threadId, id, backendId);
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
        "UPDATE operations SET state='uncertain',error='网关重启，等待原实例状态确认',updated=? WHERE state='dispatching'",
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
    backendId = DEFAULT_BACKEND,
  ): { operation: Operation; fresh: boolean } {
    const fingerprint = hash(JSON.stringify([thread, kind, input]));
    const now = Date.now();
    const inserted = this.db
      .prepare(
        'INSERT OR IGNORE INTO operations (id,device_id,thread_id,kind,fingerprint,state,created,updated,backend_id) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(id, device, thread, kind, fingerprint, 'received', now, now, backendId);
    const row = this.db
      .prepare('SELECT * FROM operations WHERE id=? AND backend_id=?')
      .get(id, backendId) as any;
    if (row.backend_id !== backendId || row.device_id !== device || row.fingerprint !== fingerprint)
      throw new ConflictError('请求 ID 已用于其他操作');
    return { operation: this.toOperation(row), fresh: inserted.changes === 1 };
  }
  updateOperation(
    id: string,
    state: OperationState,
    turnId: string | null = null,
    error: string | null = null,
    backendId = DEFAULT_BACKEND,
  ): Operation {
    this.db
      .prepare(
        'UPDATE operations SET state=?,turn_id=COALESCE(?,turn_id),error=?,updated=? WHERE id=? AND backend_id=?',
      )
      .run(state, turnId, error, Date.now(), id, backendId);
    return this.operation(id, undefined, backendId)!;
  }
  operation(id: string, device?: string, backendId = DEFAULT_BACKEND): Operation | null {
    const row = this.db
      .prepare('SELECT * FROM operations WHERE id=? AND backend_id=?')
      .get(id, backendId) as any;
    return row && (!device || row.device_id === device) && (!backendId || row.backend_id === backendId)
      ? this.toOperation(row)
      : null;
  }
  pending(thread: string, backendId = DEFAULT_BACKEND): Operation[] {
    return this.db
      .prepare(
        "SELECT * FROM operations WHERE thread_id=? AND backend_id=? AND state IN ('dispatching','accepted','uncertain')",
      )
      .all(thread, backendId)
      .map((x) => this.toOperation(x));
  }
  recent(device: string, thread: string, backendId = DEFAULT_BACKEND): Operation[] {
    return this.db
      .prepare(
        'SELECT * FROM operations WHERE device_id=? AND thread_id=? AND backend_id=? ORDER BY created DESC LIMIT 20',
      )
      .all(device, thread, backendId)
      .map((x) => this.toOperation(x));
  }
  private toOperation(r: any): Operation {
    return {
      id: r.id,
      threadId: r.thread_id,
      backendId: r.backend_id,
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
