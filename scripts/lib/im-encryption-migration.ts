/** One-time, offline migration. Never imported by the running messaging service. */
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  canonical,
  encryptFor,
  decryptFor,
  parseEnvelope,
  seal,
  unseal,
  encode64,
  decode64,
  SEALED_PREFIX,
  type AccountSecrets,
  type AccountVault,
  type PublicAccountKeys,
} from '../../src/shared/account-crypto.js';
import { MessagingStore } from '../../src/server/messaging/store.js';
import { MessagingObjects } from '../../src/server/messaging/objects.js';
import { vaultSchema } from '../../src/server/messaging/accounts.js';
import { assertEncryptedDatabase } from '../../src/server/messaging/encryption-state.js';
import type { StorageAdapter } from '../../src/server/object-storage.js';
import type { ChatInteraction, ChatUser, InteractionInput } from '../../src/shared/messaging.js';

type Row = Record<string, any>;
export interface Enrollment {
  userId: string;
  vault: AccountVault;
  auth?: string;
  recoveryAuth?: string;
}
export interface MigrationJob {
  version: 1;
  snapshot: string;
  user: ChatUser;
  vault?: AccountVault;
  previousPasswordHash?: string;
  members: Record<string, string[]>;
  messages: Row[];
  files: Row[];
  stickers: Row[];
  responses: Row[];
}
export interface MigrationPart {
  version: 1;
  snapshot: string;
  userId: string;
  enrollment: Enrollment;
  messages: { id: string; text: string }[];
  files: { id: string; encrypted: string; data: string }[];
  stickers: { id: string; encrypted: string; data: string }[];
  responses: { id: string; response: unknown }[];
  signature: string;
}
export function snapshotId(db: DatabaseSync) {
  const hash = createHash('sha256');
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'im_%' ORDER BY name")
    .all()) {
    const table = String(name);
    if (!/^im_[a-z_]+$/.test(table)) throw Error('Unexpected table');
    const rows = db
      .prepare(`SELECT * FROM ${table}`)
      .all()
      .map((row) =>
        canonical(
          Object.fromEntries(
            Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? encode64(v) : v]),
          ),
        ),
      )
      .sort();
    hash.update(table);
    for (const row of rows) hash.update(row + '\n');
  }
  return hash.digest('hex');
}
function isPlain(row: Row) {
  return !String(row.text).startsWith(SEALED_PREFIX);
}
function interaction(row: Row): ChatInteraction | undefined {
  return row.interaction ? JSON.parse(String(row.interaction)) : undefined;
}
function input(value: ChatInteraction): InteractionInput {
  return {
    kind: value.kind,
    recipientId: value.recipientId,
    title: value.title,
    description: value.description,
    questions: value.questions,
    expiresAt: value.expiresAt,
  };
}
/** Each export contains only the account's authored records and responses, never another account's keys. */
export async function exportJob(
  store: MessagingStore,
  userId: string,
  adapter?: StorageAdapter,
  origin = 'https://migration.invalid',
): Promise<MigrationJob> {
  const db = store.db,
    snapshot = snapshotId(db),
    user = store.user(userId);
  const objects = new MessagingObjects(store, adapter, origin);
  const all = db
    .prepare(
      'SELECT m.*,f.interaction,f.sticker FROM im_messages m LEFT JOIN im_message_features f ON f.message_id=m.id ORDER BY m.sequence',
    )
    .all()
    .filter(isPlain);
  const messages = all
    .filter((row) => row.sender_id === userId)
    .map((row) => ({
      ...row,
      attachmentIds: db
        .prepare('SELECT id FROM im_files WHERE message_id=? ORDER BY id')
        .all(row.id!)
        .map((f) => f.id),
    }));
  const responses = all
    .filter((row) => interaction(row)?.respondedBy === userId && interaction(row)?.response)
    .map((row) => ({
      id: row.id,
      conversation_id: row.conversation_id,
      sender_id: row.sender_id,
      interaction: row.interaction,
    }));
  const members: Record<string, string[]> = {};
  for (const row of db.prepare('SELECT conversation_id,user_id FROM im_members ORDER BY user_id').all())
    (members[String(row.conversation_id)] ??= []).push(String(row.user_id));
  // Former senders retain their own historical copy, without receiving new messages.
  for (const row of all) {
    const ids = (members[String(row.conversation_id)] ??= []);
    if (!ids.includes(String(row.sender_id))) ids.push(String(row.sender_id));
    const responder = interaction(row)?.respondedBy;
    if (responder && !ids.includes(responder)) ids.push(responder);
  }
  const media = async (kind: 'file' | 'sticker', table: string) => {
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE user_id=? AND encrypted IS NULL ORDER BY id`)
      .all(userId);
    const result: Row[] = [];
    for (const row of rows) {
      const data = await objects.bytes(kind, String(row.id), Buffer.from(row.data as Uint8Array));
      if (!data.length || data.length !== Number(row.size))
        throw Error('Original attachment is missing or has changed');
      result.push({ ...row, data: encode64(data) });
    }
    return result;
  };
  const row = db.prepare('SELECT vault FROM im_account_crypto WHERE user_id=?').get(userId);
  const job = {
    version: 1 as const,
    snapshot,
    user,
    ...(row ? { vault: JSON.parse(String(row.vault)) } : {}),
    ...(!row && user.kind === 'human'
      ? { previousPasswordHash: store.credentials(user.username)?.passwordHash }
      : {}),
    members,
    messages,
    responses,
    files: await media('file', 'im_files'),
    stickers: await media('sticker', 'im_stickers'),
  };
  if (snapshotId(db) !== snapshot)
    throw Error('Database changed during export; stop the relay and export again');
  return job;
}
export async function encryptJob(
  job: MigrationJob,
  secrets: AccountSecrets,
  enrollment: Enrollment,
  directory: Record<string, PublicAccountKeys>,
): Promise<MigrationPart> {
  const uid = job.user.id;
  if (
    enrollment.userId !== uid ||
    canonical(secrets.publicKeys) !== canonical(enrollment.vault.publicKeys) ||
    canonical(directory[uid]) !== canonical(secrets.publicKeys)
  )
    throw Error('Account identity mismatch');
  const recipients = (cid?: string) =>
    Object.fromEntries(
      [...new Set([uid, ...(cid ? (job.members[cid] ?? []) : [])])].map((id) => {
        if (!directory[id]) throw Error(`Missing public keys for account ${id}`);
        return [id, directory[id]];
      }),
    );
  const encrypt = async (context: string, value: unknown, cid?: string) => {
    const ciphertext = await encryptFor(secrets, uid, recipients(cid), context, value);
    const decoded = await decryptFor(secrets, uid, uid, secrets.publicKeys, context, ciphertext);
    if (canonical(decoded) !== canonical(value)) throw Error('Encrypted round-trip verification failed');
    return ciphertext;
  };
  const part: MigrationPart = {
    version: 1,
    snapshot: job.snapshot,
    userId: uid,
    enrollment,
    messages: [],
    files: [],
    stickers: [],
    responses: [],
    signature: '',
  };
  for (const message of job.messages) {
    const details = interaction(message);
    const options = {
      attachmentIds: message.attachmentIds,
      mentions: JSON.parse(message.mentions),
      replyTo: message.reply_to ?? undefined,
      ...(details ? { interaction: input(details) } : {}),
      ...(message.sticker ? { encryptedSticker: true } : {}),
    };
    part.messages.push({
      id: message.id,
      text: await encrypt(
        `message:${message.conversation_id}:${message.client_id}:${message.revision}`,
        { text: message.text, state: message.state, options },
        message.conversation_id,
      ),
    });
  }
  for (const kind of ['files', 'stickers'] as const)
    for (const file of job[kind]) {
      const context = `attachment:${kind === 'files' ? file.conversation_id : 'sticker'}:${file.id}`;
      const key = crypto.getRandomValues(new Uint8Array(32)),
        plain = decode64(file.data),
        ciphertext = await seal(key, plain, context);
      if (!Buffer.from(await unseal(key, ciphertext, context)).equals(Buffer.from(plain)))
        throw Error('Attachment verification failed');
      const encrypted = await encrypt(
        context,
        {
          key: encode64(key),
          iv: ciphertext.iv,
          context,
          name: file.name,
          mime: file.mime,
          size: plain.length,
        },
        kind === 'files' ? file.conversation_id : undefined,
      );
      part[kind].push({ id: file.id, encrypted, data: ciphertext.data });
    }
  for (const row of job.responses) {
    const value = interaction(row)!;
    const sealed = await encrypt(
      `response:${row.conversation_id}:${row.id}:${value.id}`,
      value.response,
      row.conversation_id,
    );
    part.responses.push({
      id: row.id,
      response:
        'decision' in value.response!
          ? { decision: value.response.decision, comment: sealed }
          : { answers: { encrypted: [sealed] } },
    });
  }
  const key = await crypto.subtle.importKey(
    'jwk',
    secrets.signing,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  part.signature = encode64(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        new TextEncoder().encode(canonical(part)),
      ),
    ),
  );
  return part;
}
function hashCredential(value: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(value, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
}
/** Merge into a NEW database only. Server/operator receives ciphertext and public enrollment, never private keys. */
export async function applyParts(store: MessagingStore, parts: MigrationPart[]) {
  const db = store.db,
    snapshot = snapshotId(db),
    users = db
      .prepare('SELECT id FROM im_users ORDER BY id')
      .all()
      .map((r) => String(r.id));
  if (canonical(parts.map((p) => p.userId).sort()) !== canonical([...users].sort()))
    throw Error('Exactly one signed migration part is required for each account');
  const byUser = new Map(parts.map((p) => [p.userId, p]));
  for (const part of parts) {
    vaultSchema.parse(part.enrollment.vault);
    if (part.enrollment.auth && !/^[A-Za-z0-9+/]{43}=$/.test(part.enrollment.auth))
      throw Error('Invalid authentication proof');
    if (part.enrollment.recoveryAuth && !/^[A-Za-z0-9+/]{43}=$/.test(part.enrollment.recoveryAuth))
      throw Error('Invalid recovery proof');
    if (part.version !== 1 || part.snapshot !== snapshot || part.enrollment.userId !== part.userId)
      throw Error('Migration snapshot mismatch');
    const key = await crypto.subtle.importKey(
      'jwk',
      part.enrollment.vault.publicKeys.signing,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    if (
      !(await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        decode64(part.signature),
        new TextEncoder().encode(canonical({ ...part, signature: '' })),
      ))
    )
      throw Error('Invalid migration signature');
    const existing = db.prepare('SELECT vault FROM im_account_crypto WHERE user_id=?').get(part.userId);
    if (existing && canonical(JSON.parse(String(existing.vault))) !== canonical(part.enrollment.vault))
      throw Error('Existing account keys cannot be replaced by migration');
    if (!existing && (!part.enrollment.auth || !part.enrollment.recoveryAuth))
      throw Error('Missing account enrollment');
    const ids = (table: string, predicate: string) =>
      db
        .prepare(`SELECT id FROM ${table} WHERE user_id=? AND ${predicate} ORDER BY id`)
        .all(part.userId)
        .map((r) => r.id);
    for (const [kind, table] of [
      ['files', 'im_files'],
      ['stickers', 'im_stickers'],
    ] as const)
      if (canonical(part[kind].map((r) => r.id).sort()) !== canonical(ids(table, 'encrypted IS NULL')))
        throw Error('Incomplete attachment migration');
    const expected = db
      .prepare('SELECT id,text FROM im_messages WHERE sender_id=? ORDER BY id')
      .all(part.userId)
      .filter(isPlain)
      .map((r) => r.id);
    if (canonical(part.messages.map((m) => m.id).sort()) !== canonical(expected))
      throw Error('Incomplete message migration');
  }
  const retired = new Set<string>();
  db.exec('PRAGMA secure_delete=ON');
  store.transaction(() => {
    for (const part of parts) {
      if (!db.prepare('SELECT 1 FROM im_account_crypto WHERE user_id=?').get(part.userId)) {
        db.prepare('INSERT INTO im_account_crypto VALUES (?,?,?,1)').run(
          part.userId,
          JSON.stringify(part.enrollment.vault),
          hashCredential(part.enrollment.recoveryAuth!),
        );
        if (store.user(part.userId).kind === 'human')
          db.prepare('UPDATE im_users SET password_hash=? WHERE id=?').run(
            hashCredential(part.enrollment.auth!),
            part.userId,
          );
      }
      for (const message of part.messages) {
        const old = db.prepare('SELECT * FROM im_messages WHERE id=?').get(message.id)!;
        const envelope = parseEnvelope(message.text);
        if (
          envelope.sender !== part.userId ||
          envelope.context !== `message:${old.conversation_id}:${old.client_id}:${old.revision}`
        )
          throw Error('Message migration context mismatch');
        db.prepare('UPDATE im_messages SET text=?,request_fingerprint=? WHERE id=?').run(
          message.text,
          randomBytes(32).toString('hex'),
          message.id,
        );
        const feature = db
          .prepare('SELECT interaction FROM im_message_features WHERE message_id=?')
          .get(message.id);
        if (feature?.interaction) {
          const original: ChatInteraction = JSON.parse(String(feature.interaction));
          const migrated = {
            ...original,
            title: '加密请求',
            description: '请使用加密客户端读取',
            ...(original.kind === 'question'
              ? { questions: [{ id: 'encrypted', header: '', question: '加密问题', options: [] }] }
              : {}),
          };
          if (original.response) {
            const response = byUser
              .get(original.respondedBy!)
              ?.responses.find((r) => r.id === message.id)?.response;
            if (!response) throw Error('Missing signed interaction response');
            migrated.response = response as ChatInteraction['response'];
          }
          db.prepare('UPDATE im_message_features SET interaction=? WHERE message_id=?').run(
            JSON.stringify(migrated),
            message.id,
          );
        }
      }
      for (const [kind, table, mediaKind] of [
        ['files', 'im_files', 'file'],
        ['stickers', 'im_stickers', 'sticker'],
      ] as const)
        for (const file of part[kind]) {
          const envelope = parseEnvelope(file.encrypted);
          if (envelope.sender !== part.userId || !envelope.context.startsWith('attachment:'))
            throw Error('Attachment migration context mismatch');
          const bytes = decode64(file.data);
          const object = db
            .prepare('SELECT metadata FROM im_media_objects WHERE kind=? AND id=?')
            .get(mediaKind, file.id);
          if (object) {
            const value = JSON.parse(String(object.metadata));
            retired.add(value.key);
            retired.add(value.previewKey);
          }
          db.prepare(
            `UPDATE ${table} SET name='encrypted.pocket',mime='application/octet-stream',size=?,data=?,encrypted=? WHERE id=?`,
          ).run(bytes.length, bytes, file.encrypted, file.id);
          db.prepare('DELETE FROM im_media_objects WHERE kind=? AND id=?').run(mediaKind, file.id);
        }
    }
    // Password credentials change. Existing Agent tokens remain valid with the owner's migrated local state.
    db.prepare("DELETE FROM im_sessions WHERE user_id IN (SELECT id FROM im_users WHERE kind='human')").run();
    assertEncryptedDatabase(db);
  });
  for (const row of db.prepare('SELECT metadata FROM im_media_objects').all()) {
    const value = JSON.parse(String(row.metadata));
    retired.delete(value.key);
    retired.delete(value.previewKey);
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
  return {
    snapshot,
    retiredObjects: [...retired],
    users: users.length,
    messages: parts.reduce((n, p) => n + p.messages.length, 0),
    attachments: parts.reduce((n, p) => n + p.files.length + p.stickers.length, 0),
  };
}
