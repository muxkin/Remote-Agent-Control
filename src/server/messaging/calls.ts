import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { ChatError, type MessagingStore } from './store-core.js';
import type { AgentCall, CallCapabilities, CallIceServer, CallMode, CallSignal } from '../../shared/calls.js';

export interface CallIceConfig {
  stunUrls: string[];
  turnUrls: string[];
  turnSecret?: string;
}
export function callIceConfig(env: Record<string, string | undefined>): CallIceConfig {
  const urls = (key: string, pattern: RegExp) =>
    (env[key] ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => {
        if (!pattern.test(v) || /[\s@]/.test(v)) throw Error(`Invalid ${key}`);
        return v;
      });
  const result = {
    stunUrls: urls('POCKET_IM_CALL_STUN_URLS', /^stuns?:[^/]+$/),
    turnUrls: urls('POCKET_IM_CALL_TURN_URLS', /^turns?:[^/]+$/),
    turnSecret: env.POCKET_IM_CALL_TURN_SECRET,
  };
  if (result.turnUrls.length && !result.turnSecret) throw Error('POCKET_IM_CALL_TURN_SECRET is required');
  return result;
}
export class CallStore {
  constructor(
    readonly store: MessagingStore,
    readonly ice: CallIceConfig = { stunUrls: [], turnUrls: [] },
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS im_call_presence (agent_id TEXT PRIMARY KEY, video INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS im_calls (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, caller_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        mode TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL,
        caller_seen INTEGER NOT NULL, agent_seen INTEGER NOT NULL, ended INTEGER
      );
      CREATE INDEX IF NOT EXISTS im_calls_state ON im_calls(state);
      CREATE TABLE IF NOT EXISTS im_call_signals (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, call_id TEXT NOT NULL,
        sender_id TEXT NOT NULL, encrypted TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS im_call_signals_call ON im_call_signals(call_id,sequence);
    `);
  }
  private value(row: Record<string, unknown>): AgentCall {
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      callerId: String(row.caller_id),
      agentId: String(row.agent_id),
      mode: row.mode as CallMode,
      state: row.state as AgentCall['state'],
      reason: String(row.reason),
      createdAt: Number(row.created),
    };
  }
  private participants(user: string, cid: string) {
    this.store.assertWritable(user, cid);
    const c = this.store.conversation(user, cid);
    const human = c.members.find((m) => m.kind === 'human'),
      agent = c.members.find((m) => m.kind === 'agent');
    if (c.kind !== 'direct' || c.members.length !== 2 || !human || !agent)
      throw new ChatError(403, '通话仅限个人与 Agent 的单独会话');
    return { human, agent };
  }
  ready(user: string, video: boolean, available: boolean) {
    if (this.store.user(user).kind !== 'agent') throw new ChatError(403, '仅 Agent 可以声明接听能力');
    const expiresAt = available ? Date.now() + 90_000 : 0;
    this.store.db
      .prepare(
        'INSERT INTO im_call_presence VALUES (?,?,?) ON CONFLICT(agent_id) DO UPDATE SET video=excluded.video,expires=excluded.expires',
      )
      .run(user, Number(video), expiresAt);
    return { expiresAt };
  }
  capabilities(user: string, cid: string): CallCapabilities {
    const { agent } = this.participants(user, cid);
    const p = this.store.db
      .prepare('SELECT * FROM im_call_presence WHERE agent_id=? AND expires>?')
      .get(agent.id, Date.now());
    return { audio: !!p, video: !!p?.video, expiresAt: Number(p?.expires ?? 0) };
  }
  iceServers(user: string): CallIceServer[] {
    const servers: CallIceServer[] = this.ice.stunUrls.map((url) => ({ urls: [url] }));
    if (this.ice.turnUrls.length && this.ice.turnSecret) {
      const username = `${Math.floor(Date.now() / 1000) + 7200}:${user}`;
      servers.push({
        urls: this.ice.turnUrls,
        username,
        credential: createHmac('sha1', this.ice.turnSecret).update(username).digest('base64'),
      });
    }
    return servers;
  }
  create(user: string, cid: string, id: string, mode: CallMode) {
    this.expire();
    const { human, agent } = this.participants(user, cid);
    if (user !== human.id) throw new ChatError(403, '请由个人用户发起通话');
    const existing = this.store.db.prepare('SELECT * FROM im_calls WHERE id=?').get(id);
    if (existing) {
      if (existing.caller_id !== user || existing.conversation_id !== cid || existing.mode !== mode)
        throw new ChatError(409, '通话标识已使用');
      return this.value(existing);
    }
    if (!this.capabilities(user, cid)[mode])
      throw new ChatError(
        409,
        mode === 'video' ? 'Agent 尚未接入视频通话，或目前离线' : 'Agent 尚未接入语音通话，或目前离线',
      );
    return this.store.transaction(() => {
      if (
        this.store.db
          .prepare("SELECT 1 FROM im_calls WHERE state<>'ended' AND (caller_id=? OR agent_id=?)")
          .get(user, agent.id)
      )
        throw new ChatError(409, '你或 Agent 正在另一通通话中');
      const now = Date.now();
      this.store.db
        .prepare(
          "INSERT INTO im_calls(id,conversation_id,caller_id,agent_id,mode,state,created,caller_seen,agent_seen) VALUES (?,?,?,?,?,'ringing',?,?,?)",
        )
        .run(id, cid, user, agent.id, mode, now, now, now);
      return this.get(user, id);
    });
  }
  get(user: string, id: string) {
    const row = this.store.db
      .prepare('SELECT * FROM im_calls WHERE id=? AND (caller_id=? OR agent_id=?)')
      .get(id, user, user);
    if (!row) throw new ChatError(404, '通话不存在');
    return this.value(row);
  }
  list(user: string) {
    this.expire();
    return this.store.db
      .prepare("SELECT * FROM im_calls WHERE state<>'ended' AND (caller_id=? OR agent_id=?) ORDER BY created")
      .all(user, user)
      .map((r) => this.value(r));
  }
  update(user: string, id: string, action: 'accept' | 'heartbeat' | 'end', reason = 'hangup') {
    this.expire();
    const call = this.get(user, id);
    if (action === 'end') {
      this.end(id, reason);
      return this.get(user, id);
    }
    if (call.state === 'ended') throw new ChatError(409, '通话已经结束');
    this.participants(user, call.conversationId);
    if (action === 'accept') {
      if (call.agentId !== user) throw new ChatError(403, '只有 Agent 可以接听');
      this.store.db.prepare("UPDATE im_calls SET state='active' WHERE id=?").run(id);
    }
    this.store.db
      .prepare(`UPDATE im_calls SET ${user === call.callerId ? 'caller_seen' : 'agent_seen'}=? WHERE id=?`)
      .run(Date.now(), id);
    return this.get(user, id);
  }
  signal(user: string, id: string, signalId: string, encrypted: string) {
    this.expire();
    const call = this.get(user, id);
    if (call.state === 'ended') throw new ChatError(409, '通话已经结束');
    this.participants(user, call.conversationId);
    this.store.validateEncryption(user, call.conversationId, encrypted, `call:${id}:${signalId}`);
    const previous = this.store.db.prepare('SELECT * FROM im_call_signals WHERE id=?').get(signalId);
    if (previous) {
      if (previous.call_id !== id || previous.sender_id !== user || previous.encrypted !== encrypted)
        throw new ChatError(409, '信令标识已使用');
      return;
    }
    if (
      Number(this.store.db.prepare('SELECT count(*) AS n FROM im_call_signals WHERE call_id=?').get(id)!.n) >=
      256
    )
      throw new ChatError(429, '通话信令过多，请重新呼叫');
    this.store.db
      .prepare('INSERT INTO im_call_signals(id,call_id,sender_id,encrypted) VALUES (?,?,?,?)')
      .run(signalId, id, user, encrypted);
  }
  poll(user: string, id: string, after: number) {
    this.expire();
    const call = this.get(user, id);
    if (call.state !== 'ended') this.participants(user, call.conversationId);
    const signals: CallSignal[] = this.store.db
      .prepare('SELECT * FROM im_call_signals WHERE call_id=? AND sequence>? ORDER BY sequence LIMIT 256')
      .all(id, after)
      .map((r) => ({
        id: String(r.id),
        sequence: Number(r.sequence),
        senderId: String(r.sender_id),
        encrypted: String(r.encrypted),
      }));
    return { call, signals, cursor: signals.at(-1)?.sequence ?? after };
  }
  end(id: string, reason: string) {
    this.store.db
      .prepare("UPDATE im_calls SET state='ended',reason=?,ended=? WHERE id=? AND state<>'ended'")
      .run(reason, Date.now(), id);
    this.store.db.prepare('DELETE FROM im_call_signals WHERE call_id=?').run(id);
  }
  endFor(user: string) {
    for (const c of this.list(user)) this.end(c.id, 'unavailable');
    this.store.db.prepare('DELETE FROM im_call_presence WHERE agent_id=?').run(user);
  }
  nextDeadline() {
    // Separate small queries keep within Durable Object SQLite's compound SELECT limit.
    const queries = [
      "SELECT min(min(CASE WHEN state='ringing' THEN created+45001 ELSE min(caller_seen,agent_seen)+90001 END,created+3600001)) AS deadline FROM im_calls WHERE state<>'ended'",
      'SELECT min(expires)+1 AS deadline FROM im_call_presence',
      "SELECT min(ended)+86400001 AS deadline FROM im_calls WHERE state='ended'",
    ];
    const values = queries
      .map((sql) => this.store.db.prepare(sql).get()?.deadline)
      .filter((v) => v !== null && v !== undefined)
      .map(Number);
    return values.length ? Math.min(...values) : undefined;
  }
  expire() {
    const now = Date.now();
    for (const r of this.store.db
      .prepare(
        "SELECT id,state FROM im_calls WHERE state<>'ended' AND ((state='ringing' AND created<?) OR caller_seen<? OR agent_seen<? OR created<?)",
      )
      .all(now - 45_000, now - 90_000, now - 90_000, now - 3_600_000))
      this.end(String(r.id), r.state === 'ringing' ? 'unanswered' : 'disconnected');
    this.store.db.prepare("DELETE FROM im_calls WHERE state='ended' AND ended<?").run(now - 86_400_000);
    this.store.db.prepare('DELETE FROM im_call_presence WHERE expires<?').run(now);
  }
}
export const callId = z.string().uuid();
