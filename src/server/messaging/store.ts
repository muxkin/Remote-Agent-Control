import { DatabaseSync } from 'node:sqlite';
import { attachmentMime } from './media.js';
import { interactionInput, interactionResponse } from './interaction.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { nextUserId, USER_ID_PATTERN, USERNAME_PATTERN } from '../../shared/account-identity.js';
import type {
  ChatInteraction,
  InteractionResponse,
  ChatSticker,
  ChatConversation,
  ChatEvent,
  ChatHistory,
  ChatMessage,
  ChatUser,
  ChatAttachment,
  ChatContact,
  MessageState,
  SendMessageOptions,
} from '../../shared/messaging.js';

export class ChatError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const userColumns = 'id, kind, username, display_name AS displayName, created_at AS createdAt';
const messageColumns =
  'id, sequence, conversation_id AS conversationId, sender_id AS senderId, client_id AS clientId, text, created_at AS createdAt, updated_at AS updatedAt, revision, state, mentions, reply_to AS replyTo';
const DAY = 86_400_000;

/** Persistent, single-process provider. All multi-row mutations commit before notifying clients. */
export class MessagingStore {
  readonly db: DatabaseSync;
  readonly changes = new EventEmitter();
  constructor(
    path: string,
    readonly authority = 'local',
  ) {
    this.db = new DatabaseSync(path);
    this.changes.setMaxListeners(0);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS im_uid_allocator (
        name TEXT PRIMARY KEY, last_uid TEXT NOT NULL CHECK(typeof(last_uid)='text')
      );
      INSERT OR IGNORE INTO im_uid_allocator(name,last_uid) VALUES ('user','9999999');
      CREATE TABLE IF NOT EXISTS im_users (
        id TEXT PRIMARY KEY NOT NULL CHECK(typeof(id)='text' AND length(id)>0 AND id NOT GLOB '*[^0-9]*' AND substr(id,1,1)<>'0'),
        kind TEXT NOT NULL CHECK(kind IN ('human','agent')),
        username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT,
        owner_id TEXT REFERENCES im_users(id), created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS im_sessions (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES im_users(id), expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS im_sessions_user ON im_sessions(user_id);
      CREATE TABLE IF NOT EXISTS im_invites (
        hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES im_users(id), expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS im_contacts (
        user_id TEXT NOT NULL REFERENCES im_users(id), contact_id TEXT NOT NULL REFERENCES im_users(id),
        remark TEXT NOT NULL DEFAULT '', blocked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id,contact_id)
      );
      CREATE TABLE IF NOT EXISTS im_conversations (
        id TEXT PRIMARY KEY, low_id TEXT REFERENCES im_users(id), high_id TEXT REFERENCES im_users(id),
        kind TEXT NOT NULL DEFAULT 'direct', name TEXT NOT NULL DEFAULT '', owner_id TEXT REFERENCES im_users(id),
        closed INTEGER NOT NULL DEFAULT 0, UNIQUE(low_id,high_id)
      );
      CREATE TABLE IF NOT EXISTS im_members (
        conversation_id TEXT NOT NULL REFERENCES im_conversations(id), user_id TEXT NOT NULL REFERENCES im_users(id),
        read_sequence INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(conversation_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS im_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES im_conversations(id), sender_id TEXT NOT NULL REFERENCES im_users(id),
        client_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'complete',
        mentions TEXT NOT NULL DEFAULT '[]', reply_to TEXT, request_fingerprint TEXT NOT NULL,
        UNIQUE(sender_id,client_id)
      );
      CREATE INDEX IF NOT EXISTS im_messages_conversation ON im_messages(conversation_id,sequence);
      CREATE INDEX IF NOT EXISTS im_messages_streaming ON im_messages(state,updated_at);
      CREATE TABLE IF NOT EXISTS im_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES im_users(id),
        type TEXT NOT NULL, conversation_id TEXT, message_id TEXT
      );
      CREATE INDEX IF NOT EXISTS im_events_user ON im_events(user_id,sequence);
      CREATE TABLE IF NOT EXISTS im_files (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES im_conversations(id), user_id TEXT NOT NULL REFERENCES im_users(id),
        message_id TEXT REFERENCES im_messages(id), name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS im_files_message ON im_files(message_id);
      CREATE TABLE IF NOT EXISTS im_message_features (
        message_id TEXT PRIMARY KEY REFERENCES im_messages(id), interaction TEXT,
        expires_at INTEGER, status TEXT, sticker INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS im_features_expiry ON im_message_features(status,expires_at);
      CREATE TABLE IF NOT EXISTS im_media_objects (
        kind TEXT NOT NULL, id TEXT NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(kind,id)
      );
      CREATE TABLE IF NOT EXISTS im_avatars (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES im_users(id), mime TEXT NOT NULL,
        size INTEGER NOT NULL, data BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS im_stickers (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES im_users(id), name TEXT NOT NULL,
        mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, source_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, UNIQUE(user_id,source_id)
      );
    `);
  }
  close() {
    this.db.close();
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = action();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  user(id: string): ChatUser {
    const user = this.db.prepare(`SELECT ${userColumns} FROM im_users WHERE id=?`).get(id);
    if (!user) throw new ChatError(404, '用户不存在');
    const avatar = this.db.prepare('SELECT id FROM im_avatars WHERE user_id=?').get(id);
    return {
      ...user,
      address: `${id}@${this.authority}`,
      ...(avatar ? { avatarUrl: `/api/im/users/${id}/avatar/${avatar.id}` } : {}),
    } as unknown as ChatUser;
  }
  /** A qualified UID is accepted only for this service; federation is not implied. */
  private account(identifier: string) {
    const value = identifier.trim().toLowerCase();
    if (USER_ID_PATTERN.test(value)) return this.db.prepare('SELECT id FROM im_users WHERE id=?').get(value);
    const separator = value.indexOf('@');
    if (separator > 0) {
      const id = value.slice(0, separator),
        authority = value.slice(separator + 1);
      if (!USER_ID_PATTERN.test(id) || authority !== this.authority) return undefined;
      return this.db.prepare('SELECT id FROM im_users WHERE id=?').get(id);
    }
    const username = value.startsWith('@') ? value.slice(1) : value;
    if (!USERNAME_PATTERN.test(username)) return undefined;
    return this.db.prepare('SELECT id FROM im_users WHERE username=?').get(username);
  }
  credentials(identifier: string) {
    const account = this.account(identifier);
    return account
      ? (this.db
          .prepare("SELECT id,password_hash AS passwordHash FROM im_users WHERE id=? AND kind='human'")
          .get(account.id!) as { id: string; passwordHash: string } | undefined)
      : undefined;
  }
  createUser(
    kind: ChatUser['kind'],
    username: string,
    displayName: string,
    passwordHash: string | null,
    ownerId: string | null = null,
  ) {
    const create = () => {
      if (this.db.prepare('SELECT 1 FROM im_users WHERE username=?').get(username))
        throw new ChatError(409, '用户名已被使用');
      const counter = this.db.prepare("SELECT last_uid FROM im_uid_allocator WHERE name='user'").get()!;
      const id = nextUserId(String(counter.last_uid));
      this.db.prepare("UPDATE im_uid_allocator SET last_uid=? WHERE name='user'").run(id);
      this.db
        .prepare(
          'INSERT INTO im_users(id,kind,username,display_name,password_hash,owner_id,created_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(id, kind, username, displayName, passwordHash, ownerId, Date.now());
      return this.user(id);
    };
    // Agent registration already owns a transaction; both paths serialize allocation with insertion.
    return this.db.isTransaction ? create() : this.transaction(create);
  }
  issueSession(userId: string) {
    const token = secret(),
      expiresAt = Date.now() + (this.user(userId).kind === 'agent' ? 365 : 30) * DAY;
    this.db.prepare('DELETE FROM im_sessions WHERE expires_at<=?').run(Date.now());
    this.db.prepare('INSERT INTO im_sessions VALUES (?,?,?)').run(digest(token), userId, expiresAt);
    return { token, expiresAt };
  }
  authenticate(token: string) {
    const row = this.db
      .prepare('SELECT user_id FROM im_sessions WHERE hash=? AND expires_at>?')
      .get(digest(token), Date.now());
    return row ? this.user(String(row.user_id)) : null;
  }
  logout(token: string) {
    const user = this.authenticate(token);
    this.db.prepare('DELETE FROM im_sessions WHERE hash=?').run(digest(token));
    if (user) this.changes.emit(user.id);
  }
  invite(ownerId: string) {
    const invitation = secret(),
      expiresAt = Date.now() + 15 * 60_000;
    this.db.prepare('DELETE FROM im_invites WHERE expires_at<=? OR owner_id=?').run(Date.now(), ownerId);
    this.db.prepare('INSERT INTO im_invites VALUES (?,?,?)').run(digest(invitation), ownerId, expiresAt);
    return { invitation, expiresAt };
  }
  registerAgent(invitation: string, username: string, displayName: string) {
    const result = this.transaction(() => {
      const invite = this.db
        .prepare('SELECT owner_id FROM im_invites WHERE hash=? AND expires_at>?')
        .get(digest(invitation), Date.now());
      if (!invite) throw new ChatError(400, '邀请无效、已使用或已过期');
      const ownerId = String(invite.owner_id);
      const user = this.createUser('agent', username, displayName, null, ownerId);
      this.db.prepare('DELETE FROM im_invites WHERE hash=?').run(digest(invitation));
      this.link(ownerId, user.id);
      this.link(user.id, ownerId);
      return { user, owner: this.user(ownerId), ...this.issueSession(user.id) };
    });
    this.changes.emit(result.owner.id);
    return result;
  }
  agents(ownerId: string) {
    return this.db
      .prepare('SELECT id FROM im_users WHERE owner_id=? ORDER BY created_at')
      .all(ownerId)
      .map((row) => this.user(String(row.id)));
  }
  revokeAgent(ownerId: string, id: string, rotate: boolean) {
    if (!this.db.prepare('SELECT 1 FROM im_users WHERE id=? AND owner_id=?').get(id, ownerId))
      throw new ChatError(404, 'Agent 不存在');
    const result = this.transaction(() => {
      this.db.prepare('DELETE FROM im_sessions WHERE user_id=?').run(id);
      return rotate ? this.issueSession(id) : { ok: true };
    });
    this.changes.emit(id);
    return result;
  }
  profile(id: string, displayName: string) {
    const affected = new Set([
      id,
      ...this.db
        .prepare('SELECT user_id FROM im_contacts WHERE contact_id=?')
        .all(id)
        .map((r) => String(r.user_id)),
      ...this.db
        .prepare(
          'SELECT DISTINCT b.user_id FROM im_members a JOIN im_members b ON a.conversation_id=b.conversation_id WHERE a.user_id=?',
        )
        .all(id)
        .map((r) => String(r.user_id)),
    ]);
    this.transaction(() => {
      this.db.prepare('UPDATE im_users SET display_name=? WHERE id=?').run(displayName, id);
      for (const userId of affected) this.event(userId, 'profile');
    });
    for (const userId of affected) this.changes.emit(userId);
    return this.user(id);
  }
  contacts(id: string): ChatContact[] {
    return this.db
      .prepare('SELECT contact_id,remark,blocked FROM im_contacts WHERE user_id=? ORDER BY rowid DESC')
      .all(id)
      .map((r) => ({ ...this.user(String(r.contact_id)), remark: String(r.remark), blocked: !!r.blocked }));
  }
  editContact(id: string, contactId: string, change: { remark?: string; blocked?: boolean }, remove = false) {
    if (!this.db.prepare('SELECT 1 FROM im_contacts WHERE user_id=? AND contact_id=?').get(id, contactId))
      throw new ChatError(404, '联系人不存在');
    if (
      remove &&
      this.db
        .prepare('SELECT 1 FROM im_contacts WHERE user_id=? AND contact_id=? AND blocked=1')
        .get(id, contactId)
    )
      throw new ChatError(409, '请先解除屏蔽，再移除联系人');
    this.transaction(() => {
      if (remove)
        this.db.prepare('DELETE FROM im_contacts WHERE user_id=? AND contact_id=?').run(id, contactId);
      else {
        if (change.remark !== undefined)
          this.db
            .prepare('UPDATE im_contacts SET remark=? WHERE user_id=? AND contact_id=?')
            .run(change.remark, id, contactId);
        if (change.blocked !== undefined)
          this.db
            .prepare('UPDATE im_contacts SET blocked=? WHERE user_id=? AND contact_id=?')
            .run(Number(change.blocked), id, contactId);
      }
      this.event(id, 'contacts');
    });
    this.changes.emit(id);
  }
  changePassword(id: string, passwordHash: string, keepToken: string) {
    this.transaction(() => {
      this.db.prepare('UPDATE im_users SET password_hash=? WHERE id=?').run(passwordHash, id);
      this.db.prepare('DELETE FROM im_sessions WHERE user_id=? AND hash<>?').run(id, digest(keepToken));
    });
    this.changes.emit(id);
  }
  logoutOthers(id: string, keepToken: string) {
    this.db.prepare('DELETE FROM im_sessions WHERE user_id=? AND hash<>?').run(id, digest(keepToken));
    this.changes.emit(id);
  }
  private link(id: string, contactId: string) {
    if (
      this.db.prepare('INSERT OR IGNORE INTO im_contacts(user_id,contact_id) VALUES (?,?)').run(id, contactId)
        .changes
    )
      this.event(id, 'contacts');
  }
  addContact(id: string, identifier: string) {
    const row = this.account(identifier);
    if (!row) throw new ChatError(404, '没有找到这个 UID 或用户名，请确认账号属于当前服务');
    const contactId = String(row.id);
    if (id === contactId) throw new ChatError(400, '不能添加自己为联系人');
    this.transaction(() => this.link(id, contactId));
    this.changes.emit(id);
    return this.user(contactId);
  }
  member(id: string, conversationId: string) {
    const row = this.db
      .prepare('SELECT read_sequence FROM im_members WHERE user_id=? AND conversation_id=?')
      .get(id, conversationId);
    if (!row) throw new ChatError(404, '会话不存在或你已离开');
    return Number(row.read_sequence);
  }
  private members(conversationId: string) {
    return this.db
      .prepare('SELECT user_id FROM im_members WHERE conversation_id=?')
      .all(conversationId)
      .map((r) => String(r.user_id));
  }
  private notify(ids: string[]) {
    for (const id of ids) this.changes.emit(id);
  }
  private assertWritable(id: string, conversationId: string) {
    this.member(id, conversationId);
    const row = this.db.prepare('SELECT * FROM im_conversations WHERE id=?').get(conversationId)!;
    if (row.closed) throw new ChatError(409, '群聊已解散，只能阅读历史');
    if (
      row.kind === 'direct' &&
      this.db
        .prepare(
          'SELECT 1 FROM im_contacts WHERE blocked=1 AND ((user_id=? AND contact_id=?) OR (user_id=? AND contact_id=?))',
        )
        .get(row.low_id!, row.high_id!, row.high_id!, row.low_id!)
    )
      throw new ChatError(403, '此联系人的私聊已被屏蔽');
    return row;
  }
  private attachment(row: Record<string, unknown>): ChatAttachment {
    return {
      id: String(row.id),
      name: String(row.name),
      size: Number(row.size),
      mime: String(row.mime),
      url: `/api/im/conversations/${row.conversation_id}/files/${row.id}/${encodeURIComponent(String(row.name))}`,
    };
  }
  private decodeMessage(row: Record<string, unknown>): ChatMessage {
    const features = this.db
      .prepare('SELECT * FROM im_message_features WHERE message_id=?')
      .get(String(row.id));
    return {
      ...(features?.interaction ? { interaction: JSON.parse(String(features.interaction)) } : {}),
      ...(features?.sticker ? { sticker: true } : {}),
      ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'requestFingerprint')),
      sender: this.user(String(row.senderId)),
      mentions: JSON.parse(String(row.mentions)),
      attachments: this.db
        .prepare('SELECT id,conversation_id,name,size,mime FROM im_files WHERE message_id=? ORDER BY rowid')
        .all(String(row.id))
        .map((r) => this.attachment(r)),
    } as unknown as ChatMessage;
  }
  message(id: string, conversationId: string, messageId: string) {
    this.member(id, conversationId);
    const row = this.db
      .prepare(`SELECT ${messageColumns} FROM im_messages WHERE id=? AND conversation_id=?`)
      .get(messageId, conversationId);
    if (!row) throw new ChatError(404, '消息不存在');
    return this.decodeMessage(row);
  }
  conversation(id: string, conversationId: string): ChatConversation {
    const readSequence = this.member(id, conversationId);
    const row = this.db.prepare('SELECT * FROM im_conversations WHERE id=?').get(conversationId)!;
    const members = this.db
      .prepare('SELECT user_id,read_sequence FROM im_members WHERE conversation_id=? ORDER BY rowid')
      .all(conversationId)
      .map((m) => ({
        ...this.user(String(m.user_id)),
        readSequence: Number(m.read_sequence),
        role: m.user_id === row.owner_id ? ('owner' as const) : ('member' as const),
      }));
    const peer = members.find((m) => m.id !== id) ?? null;
    const last = this.db
      .prepare(
        `SELECT ${messageColumns} FROM im_messages WHERE conversation_id=? ORDER BY sequence DESC LIMIT 1`,
      )
      .get(conversationId);
    const unread = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM im_messages WHERE conversation_id=? AND sequence>? AND sender_id<>?',
      )
      .get(conversationId, readSequence, id)!;
    return {
      id: conversationId,
      kind: row.kind as 'direct' | 'group',
      name: row.kind === 'group' ? String(row.name) : (peer?.displayName ?? '联系人'),
      ownerId: row.owner_id ? String(row.owner_id) : null,
      closed: !!row.closed,
      peer: row.kind === 'direct' ? peer : null,
      members,
      readSequence,
      peerReadSequence: peer?.readSequence ?? 0,
      unread: Number(unread.n),
      lastMessage: last ? this.decodeMessage(last) : null,
    };
  }
  conversations(id: string) {
    return this.db
      .prepare('SELECT conversation_id FROM im_members WHERE user_id=?')
      .all(id)
      .map((r) => this.conversation(id, String(r.conversation_id)))
      .sort((a, b) => (b.lastMessage?.updatedAt ?? 0) - (a.lastMessage?.updatedAt ?? 0));
  }
  direct(id: string, peerId: string) {
    if (id === peerId) throw new ChatError(400, '请选择其他联系人');
    const [low, high] = [id, peerId].sort();
    const existing = this.db
      .prepare('SELECT id FROM im_conversations WHERE low_id=? AND high_id=?')
      .get(low, high);
    if (existing) return this.conversation(id, String(existing.id));
    this.requireContact(id, peerId);
    const cid = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO im_conversations(id,low_id,high_id) VALUES (?,?,?)').run(cid, low, high);
      for (const uid of [id, peerId]) {
        this.db.prepare('INSERT INTO im_members(conversation_id,user_id) VALUES (?,?)').run(cid, uid);
        this.event(uid, 'conversation', cid);
      }
    });
    this.notify([id, peerId]);
    return this.conversation(id, cid);
  }
  private requireContact(id: string, peer: string) {
    if (
      !this.db
        .prepare('SELECT 1 FROM im_contacts WHERE user_id=? AND contact_id=? AND blocked=0')
        .get(id, peer)
    )
      throw new ChatError(403, '请先添加联系人，且不要选择已屏蔽的联系人');
    if (
      this.db
        .prepare('SELECT 1 FROM im_contacts WHERE user_id=? AND contact_id=? AND blocked=1')
        .get(peer, id)
    )
      throw new ChatError(403, '对方已限制邀请');
  }
  createGroup(id: string, name: string, userIds: string[]) {
    const ids = [...new Set([id, ...userIds])];
    if (ids.length < 2 || ids.length > 50) throw new ChatError(400, '群聊需要 2–50 位成员');
    for (const uid of ids) if (uid !== id) this.requireContact(id, uid);
    const cid = randomUUID();
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO im_conversations(id,kind,name,owner_id) VALUES (?,'group',?,?)")
        .run(cid, name, id);
      for (const uid of ids) {
        this.db.prepare('INSERT INTO im_members(conversation_id,user_id) VALUES (?,?)').run(cid, uid);
        this.event(uid, 'conversation', cid);
      }
    });
    this.notify(ids);
    return this.conversation(id, cid);
  }
  updateGroup(
    id: string,
    cid: string,
    change: { name?: string; add?: string[]; remove?: string; ownerId?: string; closed?: boolean },
  ) {
    const convo = this.conversation(id, cid);
    if (convo.kind !== 'group') throw new ChatError(400, '此操作仅适用于群聊');
    const leaving = change.remove === id && Object.keys(change).length === 1;
    if (convo.ownerId !== id && !leaving) throw new ChatError(403, '只有群主可以管理成员和群资料');
    if (convo.closed && !leaving) throw new ChatError(409, '群聊已解散');
    if (change.remove === convo.ownerId && !convo.closed) throw new ChatError(400, '请先转让群主或解散群聊');
    const members = this.members(cid),
      added = [...new Set(change.add ?? [])].filter((uid) => !members.includes(uid));
    if (members.length + added.length > 50) throw new ChatError(400, '群聊最多 50 位成员');
    for (const uid of added) this.requireContact(id, uid);
    if (change.ownerId && !members.includes(change.ownerId)) throw new ChatError(400, '新群主必须已经在群内');
    this.transaction(() => {
      if (change.name !== undefined)
        this.db.prepare('UPDATE im_conversations SET name=? WHERE id=?').run(change.name, cid);
      if (change.ownerId)
        this.db.prepare('UPDATE im_conversations SET owner_id=? WHERE id=?').run(change.ownerId, cid);
      if (change.closed) this.db.prepare('UPDATE im_conversations SET closed=1 WHERE id=?').run(cid);
      for (const uid of added)
        this.db.prepare('INSERT INTO im_members(conversation_id,user_id) VALUES (?,?)').run(cid, uid);
      if (change.remove)
        this.db
          .prepare('DELETE FROM im_members WHERE conversation_id=? AND user_id=?')
          .run(cid, change.remove);
      const streams = this.db
        .prepare(
          "SELECT id FROM im_messages WHERE conversation_id=? AND state='streaming' AND (?=1 OR sender_id=?)",
        )
        .all(cid, Number(!!change.closed), change.remove ?? '');
      for (const stream of streams) {
        this.db
          .prepare("UPDATE im_messages SET state='cancelled',revision=revision+1,updated_at=? WHERE id=?")
          .run(Date.now(), stream.id!);
        for (const uid of this.members(cid)) this.event(uid, 'message.updated', cid, String(stream.id));
      }
      if (change.remove || change.closed) {
        const pending = this.db
          .prepare(
            "SELECT f.message_id,f.interaction,m.sender_id FROM im_message_features f JOIN im_messages m ON m.id=f.message_id WHERE m.conversation_id=? AND f.status='pending'",
          )
          .all(cid);
        for (const row of pending) {
          const interaction = JSON.parse(String(row.interaction)) as ChatInteraction;
          if (change.closed || row.sender_id === change.remove || interaction.recipientId === change.remove) {
            interaction.status = 'cancelled';
            this.writeInteraction(cid, String(row.message_id), interaction);
          }
        }
      }
      for (const uid of [...members, ...added]) this.event(uid, 'conversation', cid);
    });
    this.notify([...members, ...added]);
  }
  history(id: string, cid: string, before = Number.MAX_SAFE_INTEGER): ChatHistory {
    this.member(id, cid);
    const rows = this.db
      .prepare(
        `SELECT ${messageColumns} FROM im_messages WHERE conversation_id=? AND sequence<? ORDER BY sequence DESC LIMIT 51`,
      )
      .all(cid, before);
    const messages = rows
      .slice(0, 50)
      .reverse()
      .map((row) => this.decodeMessage(row));
    return { messages, ...(rows.length > 50 ? { before: messages[0].sequence } : {}) };
  }
  search(id: string, cid: string, query: string, before = Number.MAX_SAFE_INTEGER): ChatHistory {
    this.member(id, cid);
    const rows = this.db
      .prepare(
        `SELECT ${messageColumns} FROM im_messages WHERE conversation_id=? AND sequence<? AND instr(lower(text),lower(?))>0 ORDER BY sequence DESC LIMIT 51`,
      )
      .all(cid, before, query);
    const messages = rows.slice(0, 50).map((row) => this.decodeMessage(row));
    return { messages, ...(rows.length > 50 ? { before: messages.at(-1)!.sequence } : {}) };
  }
  send(id: string, cid: string, clientId: string, text: string, options: SendMessageOptions = {}) {
    this.assertWritable(id, cid);
    const state = options.state ?? 'complete',
      attachmentIds = [...new Set(options.attachmentIds ?? [])],
      mentions = [...new Set(options.mentions ?? [])];
    if (state === 'streaming' && this.user(id).kind !== 'agent')
      throw new ChatError(403, '流式回复仅适用于 Agent');
    if (
      !text.trim() &&
      !attachmentIds.length &&
      !options.interaction &&
      !options.stickerId &&
      state !== 'streaming'
    )
      throw new ChatError(400, '请输入消息或添加附件');
    const fingerprint = digest(
      JSON.stringify({
        cid,
        text,
        state,
        attachmentIds: [...attachmentIds].sort(),
        mentions: [...mentions].sort(),
        replyTo: options.replyTo ?? null,
        ...(options.interaction ? { interaction: options.interaction } : {}),
        ...(options.stickerId ? { stickerId: options.stickerId } : {}),
      }),
    );
    const previous = this.db
      .prepare(
        `SELECT ${messageColumns}, request_fingerprint AS requestFingerprint FROM im_messages WHERE sender_id=? AND client_id=?`,
      )
      .get(id, clientId);
    if (previous) {
      const message = this.decodeMessage(previous);
      if (previous.requestFingerprint !== fingerprint) throw new ChatError(409, '消息请求标识已用于其他内容');
      return message;
    }
    const members = this.members(cid);
    let interaction: ChatInteraction | undefined;
    if (options.interaction) {
      const parsed = interactionInput.parse(options.interaction);
      if (state !== 'complete' || attachmentIds.length || options.stickerId)
        throw new ChatError(400, '交互卡片不能包含流式回复、附件或表情包');
      if (
        parsed.recipientId === id ||
        !members.includes(parsed.recipientId) ||
        this.user(parsed.recipientId).kind !== 'human'
      )
        throw new ChatError(400, '请选择会话中的另一位个人用户回答');
      const expiresAt = parsed.expiresAt ?? Date.now() + DAY;
      if (expiresAt <= Date.now() || expiresAt > Date.now() + 7 * DAY)
        throw new ChatError(400, '有效期必须在未来七天内');
      interaction = { ...parsed, id: randomUUID(), expiresAt, status: 'pending' };
    }
    const sticker = options.stickerId ? this.sticker(id, options.stickerId) : undefined;
    if (sticker && (attachmentIds.length || state !== 'complete'))
      throw new ChatError(400, '表情包需单独发送');
    if (
      sticker &&
      !this.db.prepare("SELECT 1 FROM im_media_objects WHERE kind='sticker' AND id=?").get(sticker.id)
    )
      this.checkFileQuota(id, sticker.size);
    if (mentions.some((uid) => !members.includes(uid))) throw new ChatError(400, '只能提及当前会话成员');
    if (options.replyTo) this.message(id, cid, options.replyTo);
    if (attachmentIds.length > 6) throw new ChatError(400, '每条消息最多 6 个附件');
    for (const fileId of attachmentIds)
      if (
        !this.db
          .prepare(
            'SELECT 1 FROM im_files WHERE id=? AND user_id=? AND conversation_id=? AND message_id IS NULL',
          )
          .get(fileId, id, cid)
      )
        throw new ChatError(400, '附件不存在、已发送或不属于此会话');
    const messageId = randomUUID(),
      now = Date.now();
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO im_messages(id,conversation_id,sender_id,client_id,text,created_at,updated_at,state,mentions,reply_to,request_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          messageId,
          cid,
          id,
          clientId,
          text,
          now,
          now,
          state,
          JSON.stringify(mentions),
          options.replyTo ?? null,
          fingerprint,
        );
      if (interaction || sticker)
        this.db
          .prepare(
            'INSERT INTO im_message_features(message_id,interaction,expires_at,status,sticker) VALUES (?,?,?,?,?)',
          )
          .run(
            messageId,
            interaction ? JSON.stringify(interaction) : null,
            interaction?.expiresAt ?? null,
            interaction?.status ?? null,
            sticker ? 1 : 0,
          );
      if (sticker) {
        const fileId = randomUUID();
        this.db
          .prepare(
            'INSERT INTO im_files(id,conversation_id,user_id,message_id,name,mime,size,data,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          )
          .run(fileId, cid, id, messageId, sticker.name, sticker.mime, sticker.size, sticker.data, now);
        this.copyMedia('sticker', sticker.id, 'file', fileId);
      }
      for (const fileId of attachmentIds)
        this.db.prepare('UPDATE im_files SET message_id=? WHERE id=?').run(messageId, fileId);
      for (const uid of members) this.event(uid, 'message', cid, messageId);
    });
    this.notify(members);
    return this.message(id, cid, messageId);
  }
  updateMessage(
    id: string,
    cid: string,
    messageId: string,
    revision: number,
    text: string,
    state: MessageState,
  ) {
    this.assertWritable(id, cid);
    const old = this.message(id, cid, messageId);
    if (old.senderId !== id) throw new ChatError(403, '只能更新自己发出的回复');
    if (revision === old.revision && text === old.text && state === old.state) return old;
    if (old.state !== 'streaming' || revision !== old.revision + 1)
      throw new ChatError(409, '回复已结束或版本冲突，请读取最新消息');
    const members = this.members(cid);
    this.transaction(() => {
      this.db
        .prepare('UPDATE im_messages SET text=?,state=?,revision=?,updated_at=? WHERE id=?')
        .run(text, state, revision, Date.now(), messageId);
      for (const uid of members) this.event(uid, 'message.updated', cid, messageId);
    });
    this.notify(members);
    return this.message(id, cid, messageId);
  }
  cancel(id: string, cid: string, messageId: string) {
    const old = this.message(id, cid, messageId);
    if (old.senderId !== id && this.user(id).kind !== 'human')
      throw new ChatError(403, '只有回复者或群内用户可以停止回复');
    if (old.state !== 'streaming') return old;
    const members = this.members(cid);
    this.transaction(() => {
      this.db
        .prepare("UPDATE im_messages SET state='cancelled',revision=revision+1,updated_at=? WHERE id=?")
        .run(Date.now(), messageId);
      for (const uid of members) this.event(uid, 'message.updated', cid, messageId);
    });
    this.notify(members);
    return this.message(id, cid, messageId);
  }
  expireStreams() {
    const expired = this.db
      .prepare("SELECT id,conversation_id FROM im_messages WHERE state='streaming' AND updated_at<?")
      .all(Date.now() - 120_000);
    for (const row of expired) {
      const ids = this.members(String(row.conversation_id));
      this.transaction(() => {
        this.db
          .prepare("UPDATE im_messages SET state='failed',revision=revision+1,updated_at=? WHERE id=?")
          .run(Date.now(), row.id!);
        for (const uid of ids)
          this.event(uid, 'message.updated', String(row.conversation_id), String(row.id));
      });
      this.notify(ids);
    }
  }
  upload(id: string, cid: string, name: string, data: Buffer) {
    this.assertWritable(id, cid);
    if (!data.length || data.length > 10 * 1024 * 1024) throw new ChatError(400, '附件需要为 1 字节至 10 MB');
    this.db.prepare('DELETE FROM im_files WHERE message_id IS NULL AND created_at<?').run(Date.now() - DAY);
    this.checkFileQuota(id, data.length);
    const mime = attachmentMime(name, data);
    const fileId = randomUUID();
    this.db
      .prepare(
        'INSERT INTO im_files(id,conversation_id,user_id,name,mime,size,data,created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(fileId, cid, id, name, mime, data.length, data, Date.now());
    return this.attachment({ id: fileId, conversation_id: cid, name, mime, size: data.length });
  }
  file(id: string, cid: string, fileId: string) {
    this.member(id, cid);
    const row = this.db
      .prepare(
        'SELECT * FROM im_files WHERE id=? AND conversation_id=? AND (message_id IS NOT NULL OR user_id=?)',
      )
      .get(fileId, cid, id);
    if (!row) throw new ChatError(404, '附件不存在');
    return { ...this.attachment(row), data: Buffer.from(row.data as Uint8Array) };
  }
  removeUpload(id: string, cid: string, fileId: string) {
    this.member(id, cid);
    this.db
      .prepare('DELETE FROM im_files WHERE id=? AND conversation_id=? AND user_id=? AND message_id IS NULL')
      .run(fileId, cid, id);
  }
  private checkFileQuota(id: string, bytes: number) {
    const size = Number(
      this.db
        .prepare(
          `SELECT COALESCE(SUM(size),0) AS size FROM (
        SELECT MAX(size) AS size FROM (
          SELECT f.size,COALESCE(json_extract(m.metadata,'$.hash'),'file:'||f.id) AS resource FROM im_files f LEFT JOIN im_media_objects m ON m.kind='file' AND m.id=f.id WHERE f.user_id=?
          UNION ALL SELECT s.size,COALESCE(json_extract(m.metadata,'$.hash'),'sticker:'||s.id) AS resource FROM im_stickers s LEFT JOIN im_media_objects m ON m.kind='sticker' AND m.id=s.id WHERE s.user_id=?
        ) GROUP BY resource
      )`,
        )
        .get(id, id)!.size,
    );
    if (size + bytes > 250 * 1024 * 1024) throw new ChatError(413, '此账户的附件已达到 250 MB 上限');
  }
  stickers(id: string): ChatSticker[] {
    return this.db
      .prepare('SELECT id,name,mime,size FROM im_stickers WHERE user_id=? ORDER BY created_at DESC')
      .all(id)
      .map((row) => ({ ...row, url: `/api/im/stickers/${row.id}/file` }) as unknown as ChatSticker);
  }
  sticker(id: string, stickerId: string) {
    const row = this.db
      .prepare('SELECT id,name,mime,size,data FROM im_stickers WHERE user_id=? AND id=?')
      .get(id, stickerId);
    if (!row) throw new ChatError(404, '表情包不存在');
    return { ...row, data: Buffer.from(row.data as Uint8Array) } as unknown as ChatSticker & { data: Buffer };
  }
  saveSticker(id: string, cid: string, fileId: string) {
    const file = this.file(id, cid, fileId);
    if (!file.mime.startsWith('image/')) throw new ChatError(400, '只能收藏 PNG、JPEG、GIF 或 WebP 图片');
    if (file.size > 2 * 1024 * 1024) throw new ChatError(400, '每个表情包不能超过 2 MB');
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM im_stickers WHERE user_id=? AND source_id=?').get(id, fileId))
        return;
      if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM im_stickers WHERE user_id=?').get(id)!.n) >= 50)
        throw new ChatError(400, '最多收藏 50 个表情包，请先移除不需要的收藏');
      const stickerId = randomUUID();
      this.db
        .prepare(
          'INSERT INTO im_stickers(id,user_id,name,mime,size,data,source_id,created_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(stickerId, id, file.name, file.mime, file.size, file.data, fileId, Date.now());
      this.copyMedia('file', fileId, 'sticker', stickerId);
    });
    return this.stickers(id);
  }
  removeSticker(id: string, stickerId: string) {
    this.db.prepare('DELETE FROM im_stickers WHERE user_id=? AND id=?').run(id, stickerId);
  }
  private copyMedia(from: string, fromId: string, to: string, toId: string) {
    this.db
      .prepare(
        'INSERT INTO im_media_objects(kind,id,metadata) SELECT ?,?,metadata FROM im_media_objects WHERE kind=? AND id=?',
      )
      .run(to, toId, from, fromId);
  }
  avatar(viewer: string, userId: string, version: string) {
    if (
      viewer !== userId &&
      !this.db
        .prepare(
          `SELECT 1 FROM im_contacts WHERE user_id=? AND contact_id=? UNION SELECT 1 FROM im_members a JOIN im_members b ON a.conversation_id=b.conversation_id WHERE a.user_id=? AND b.user_id=?`,
        )
        .get(viewer, userId, viewer, userId)
    )
      throw new ChatError(404, '头像不存在');
    const row = this.db.prepare('SELECT * FROM im_avatars WHERE user_id=? AND id=?').get(userId, version);
    if (!row) throw new ChatError(404, '头像不存在');
    return {
      id: String(row.id),
      name: 'avatar.webp',
      mime: String(row.mime),
      size: Number(row.size),
      data: Buffer.from(row.data as Uint8Array),
    };
  }
  setAvatar(id: string, data: Buffer) {
    const version = randomUUID();
    this.db
      .prepare(
        'INSERT INTO im_avatars(id,user_id,mime,size,data) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET id=excluded.id,mime=excluded.mime,size=excluded.size,data=excluded.data',
      )
      .run(version, id, 'image/webp', data.length, data);
    this.profile(id, this.user(id).displayName);
    return version;
  }
  removeAvatar(id: string) {
    this.db.prepare('DELETE FROM im_avatars WHERE user_id=?').run(id);
    return this.profile(id, this.user(id).displayName);
  }
  private writeInteraction(cid: string, messageId: string, interaction: ChatInteraction) {
    this.db
      .prepare('UPDATE im_message_features SET interaction=?,status=? WHERE message_id=?')
      .run(JSON.stringify(interaction), interaction.status, messageId);
    this.db
      .prepare('UPDATE im_messages SET revision=revision+1,updated_at=? WHERE id=?')
      .run(Date.now(), messageId);
    for (const uid of this.members(cid)) this.event(uid, 'message.updated', cid, messageId);
  }
  respond(id: string, cid: string, messageId: string, response: InteractionResponse) {
    this.expireInteractions();
    const parsed = interactionResponse.parse(response);
    this.transaction(() => {
      this.assertWritable(id, cid);
      const message = this.message(id, cid, messageId),
        interaction = message.interaction;
      if (!interaction) throw new ChatError(400, '此消息不是交互请求');
      if (this.user(id).kind !== 'human' || interaction.recipientId !== id)
        throw new ChatError(403, '只有指定的个人用户可以回答或授权');
      this.member(message.senderId, cid);
      if (interaction.status !== 'pending') {
        if (interaction.respondedBy === id && JSON.stringify(interaction.response) === JSON.stringify(parsed))
          return;
        throw new ChatError(409, '请求已处理或已失效，请刷新消息');
      }
      if (interaction.kind === 'question') {
        if (!('answers' in parsed)) throw new ChatError(400, '请提交问题答案');
        const questions = interaction.questions!;
        if (
          Object.keys(parsed.answers).length !== questions.length ||
          questions.some(
            (q) =>
              !Object.hasOwn(parsed.answers, q.id) || (!q.multiSelect && parsed.answers[q.id].length !== 1),
          )
        )
          throw new ChatError(400, '请完整回答所有问题');
        interaction.status = 'answered';
      } else {
        if (!('decision' in parsed)) throw new ChatError(400, '请选择允许或拒绝');
        interaction.status = parsed.decision === 'approve' ? 'approved' : 'rejected';
      }
      interaction.response = parsed;
      interaction.respondedBy = id;
      interaction.respondedAt = Date.now();
      this.writeInteraction(cid, messageId, interaction);
    });
    this.notify(this.members(cid));
    return this.message(id, cid, messageId);
  }
  cancelInteraction(id: string, cid: string, messageId: string) {
    this.transaction(() => {
      const message = this.message(id, cid, messageId),
        interaction = message.interaction;
      if (!interaction) throw new ChatError(400, '此消息不是交互请求');
      if (id !== message.senderId && id !== interaction.recipientId)
        throw new ChatError(403, '只有发起人和回答者可以取消');
      if (interaction.status !== 'pending') return;
      interaction.status = 'cancelled';
      this.writeInteraction(cid, messageId, interaction);
    });
    this.notify(this.members(cid));
    return this.message(id, cid, messageId);
  }
  expireInteractions() {
    const rows = this.db
      .prepare(
        "SELECT message_id,interaction FROM im_message_features WHERE status='pending' AND expires_at<=?",
      )
      .all(Date.now());
    for (const row of rows) {
      const cid = String(
        this.db.prepare('SELECT conversation_id FROM im_messages WHERE id=?').get(row.message_id!)!
          .conversation_id,
      );
      this.transaction(() => {
        const fresh = this.db
          .prepare('SELECT interaction,status FROM im_message_features WHERE message_id=?')
          .get(row.message_id!)!;
        if (fresh.status !== 'pending') return;
        const interaction = JSON.parse(String(fresh.interaction)) as ChatInteraction;
        interaction.status = 'expired';
        this.writeInteraction(cid, String(row.message_id), interaction);
      });
      this.notify(this.members(cid));
    }
  }
  read(id: string, cid: string, sequence: number) {
    if (sequence <= this.member(id, cid)) return;
    if (
      !this.db.prepare('SELECT 1 FROM im_messages WHERE conversation_id=? AND sequence=?').get(cid, sequence)
    )
      throw new ChatError(400, '已读位置不属于此会话');
    const members = this.members(cid);
    this.transaction(() => {
      this.db
        .prepare('UPDATE im_members SET read_sequence=? WHERE user_id=? AND conversation_id=?')
        .run(sequence, id, cid);
      for (const uid of members) this.event(uid, 'read', cid);
    });
    this.notify(members);
  }
  private event(
    userId: string,
    type: ChatEvent['type'],
    cid: string | null = null,
    messageId: string | null = null,
  ) {
    this.db
      .prepare('INSERT INTO im_events(user_id,type,conversation_id,message_id) VALUES (?,?,?,?)')
      .run(userId, type, cid, messageId);
  }
  cursor(id: string) {
    return Number(
      this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM im_events WHERE user_id=?').get(id)!.n,
    );
  }
  sync(id: string, cursor: number): { events: ChatEvent[]; cursor: number } {
    const rows = this.db
      .prepare(
        'SELECT sequence,type,conversation_id AS conversationId,message_id AS messageId FROM im_events WHERE user_id=? AND sequence>? ORDER BY sequence LIMIT 100',
      )
      .all(id, cursor);
    const lastMessageEvent = new Map(rows.filter((r) => r.messageId).map((r) => [r.messageId, r.sequence]));
    const events = rows.map((row) => {
      const event = {
        sequence: Number(row.sequence),
        type: row.type as ChatEvent['type'],
        conversationId: row.conversationId as string | null,
      };
      if (
        row.messageId &&
        lastMessageEvent.get(row.messageId) === row.sequence &&
        this.db
          .prepare('SELECT 1 FROM im_members WHERE conversation_id=? AND user_id=?')
          .get(row.conversationId!, id)
      )
        return { ...event, message: this.message(id, String(row.conversationId), String(row.messageId)) };
      return event;
    });
    return { events, cursor: events.at(-1)?.sequence ?? cursor };
  }
}
