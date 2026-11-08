import type { MessagingHttp, MessagingReply, MessagingRequest } from './http.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ChatError, type MessagingStore } from './store-core.js';
import { USER_ID_PATTERN, USERNAME_PATTERN } from '../../shared/account-identity.js';
import { canonical, fingerprint, type AccountVault } from '../../shared/account-crypto.js';
import type { ChatUser } from '../../shared/messaging.js';

const b64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const encryptedValue = z.object({ iv: b64.length(16), data: b64.min(24).max(1_500_000) }).strict();
const publicKey = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().length(43),
    y: z.string().length(43),
    ext: z.boolean().optional(),
    key_ops: z.array(z.string()).max(2).optional(),
  })
  .strict();
export const accountPublicKeys = z.object({ encryption: publicKey, signing: publicKey }).strict();
export const vaultSchema = z
  .object({
    version: z.literal(1),
    salt: b64.length(44),
    password: encryptedValue,
    recovery: encryptedValue,
    secrets: encryptedValue,
    publicKeys: accountPublicKeys,
  })
  .strict();
const credential = b64.length(44);
const protectSchema = z.object({ vault: vaultSchema, auth: credential, recoveryAuth: credential });
type Dependencies = {
  store: MessagingStore;
  identity: (req: MessagingRequest) => ChatUser;
  human: (req: MessagingRequest) => ChatUser;
  token: (req: MessagingRequest) => string;
  session: (reply: MessagingReply, user: ChatUser) => { user: ChatUser };
  hash: (value: string, salt: string) => Promise<Buffer>;
  take: (key: string, max: number) => void;
  registrationCode?: string;
};
export async function registerAccounts(app: MessagingHttp, d: Dependencies) {
  const { store, identity, human, token, session, hash, take } = d;
  const account = (id: string) => store.db.prepare('SELECT * FROM im_account_crypto WHERE user_id=?').get(id);
  const hashed = async (value: string) => {
    const salt = randomBytes(16).toString('hex');
    return `${salt}:${(await hash(value, salt)).toString('hex')}`;
  };
  const verify = async (value: string, expected?: string) => {
    const [salt, digest] = (expected ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
    return timingSafeEqual(await hash(value, salt), Buffer.from(digest, 'hex')) && !!expected;
  };
  const insert = (id: string, vault: AccountVault, recoveryHash: string) =>
    store.db
      .prepare('INSERT INTO im_account_crypto(user_id,vault,recovery_hash,revision) VALUES (?,?,?,1)')
      .run(id, JSON.stringify(vault), recoveryHash);
  app.post('/crypto/parameters', { bodyLimit: 4096 }, async (req) => {
    const { identifier } = z.object({ identifier: z.string().trim().min(1).max(1024) }).parse(req.body);
    const user = store.credentials(identifier),
      row = user && account(user.id);
    return { salt: row ? JSON.parse(String(row.vault)).salt : randomBytes(32).toString('base64') };
  });
  app.post('/crypto/register', { bodyLimit: 32 * 1024 }, async (req, reply) => {
    const body = protectSchema
      .extend({
        username: z.string().toLowerCase().regex(USERNAME_PATTERN),
        displayName: z.string().trim().min(1).max(60),
        registrationCode: z.string().max(256).optional(),
      })
      .parse(req.body);
    if (d.registrationCode && body.registrationCode !== d.registrationCode)
      throw new ChatError(403, '注册码不正确');
    const passwordHash = await hashed(body.auth),
      recoveryHash = await hashed(body.recoveryAuth);
    const id = store.transaction(() => {
      const user = store.createUser('human', body.username, body.displayName, passwordHash);
      insert(user.id, body.vault, recoveryHash);
      return user.id;
    });
    reply.code(201);
    return { ...session(reply, store.user(id)), vault: body.vault };
  });
  app.post('/crypto/login', { bodyLimit: 4096 }, async (req, reply) => {
    const body = z
      .object({
        identifier: z.string().trim().min(1).max(1024),
        auth: credential,
        recovery: z.boolean().optional(),
      })
      .parse(req.body);
    const user = store.credentials(body.identifier),
      row = user && account(user.id);
    take(`login:${user?.id ?? body.identifier}`, 15);
    if (
      !(await verify(
        body.auth,
        row ? (body.recovery ? String(row.recovery_hash) : user!.passwordHash) : undefined,
      ))
    )
      throw new ChatError(401, '用户名、密码或恢复码不正确');
    return {
      ...session(reply, store.user(user!.id)),
      vault: JSON.parse(String(row!.vault)),
      revision: Number(row!.revision),
    };
  });
  app.get('/crypto/account', async (req) => {
    const row = account(identity(req).id);
    return row
      ? { vault: JSON.parse(String(row.vault)), revision: Number(row.revision) }
      : { vault: null, revision: 0 };
  });
  app.post('/crypto/password', { bodyLimit: 32 * 1024 }, async (req) => {
    const user = human(req),
      previous = account(user.id),
      existing = store.credentials(user.username)!;
    take(`password:${user.id}`, 5);
    const body = protectSchema
      .extend({
        currentAuth: credential,
        recovery: z.boolean().optional(),
        revision: z.number().int().positive(),
      })
      .parse(req.body);
    if (
      !previous ||
      !(await verify(
        body.currentAuth,
        body.recovery ? String(previous.recovery_hash) : existing.passwordHash,
      ))
    )
      throw new ChatError(403, '当前密码或恢复码不正确');
    const previousVault: AccountVault = JSON.parse(String(previous.vault));
    if (canonical(previousVault.publicKeys) !== canonical(body.vault.publicKeys))
      throw new ChatError(400, '修改密码不能替换账号身份');
    const passwordHash = await hashed(body.auth),
      recoveryHash = await hashed(body.recoveryAuth);
    store.transaction(() => {
      if (
        Number(account(user.id)?.revision) !== body.revision ||
        store.credentials(user.username)?.passwordHash !== existing.passwordHash
      )
        throw new ChatError(409, '密码已变化，请重新登录');
      store.db
        .prepare('UPDATE im_account_crypto SET vault=?,recovery_hash=?,revision=revision+1 WHERE user_id=?')
        .run(JSON.stringify(body.vault), recoveryHash, user.id);
      store.changePassword(user.id, passwordHash, token(req));
    });
    return { ok: true, revision: body.revision + 1 };
  });
  app.get('/crypto/keys/:id', async (req) => {
    identity(req);
    const { id } = z.object({ id: z.string().regex(USER_ID_PATTERN) }).parse(req.params);
    const row = account(id);
    if (!row) throw new ChatError(409, '对方的加密身份不存在');
    const publicKeys = JSON.parse(String(row.vault)).publicKeys;
    return { publicKeys, fingerprint: await fingerprint(publicKeys) };
  });
  app.get('/crypto/items', async (req) => {
    const user = identity(req);
    const { accountId } = z.object({ accountId: z.string().regex(USER_ID_PATTERN) }).parse(req.query);
    if (accountId !== user.id) throw new ChatError(409, '账号已切换，请重新登录');
    return {
      items: store.db
        .prepare('SELECT id,revision,ciphertext FROM im_vault_items WHERE user_id=?')
        .all(user.id)
        .map((r) => ({
          id: r.id,
          revision: r.revision,
          ciphertext: r.ciphertext ? JSON.parse(String(r.ciphertext)) : null,
        })),
    };
  });
  app.put('/crypto/items/:id', { bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const user = identity(req);
    if (!account(user.id)) throw new ChatError(409, '请先启用账号加密');
    const { id } = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).parse(req.params);
    const { accountId, revision, ciphertext } = z
      .object({
        accountId: z.string().regex(USER_ID_PATTERN),
        revision: z.number().int().nonnegative(),
        ciphertext: encryptedValue.nullable(),
      })
      .parse(req.body);
    if (accountId !== user.id) throw new ChatError(409, '账号已切换，请重新登录');
    take(`vault:${user.id}`, 120);
    return store.transaction(() => {
      const old = store.db
        .prepare('SELECT revision FROM im_vault_items WHERE user_id=? AND id=?')
        .get(user.id, id);
      if (Number(old?.revision ?? 0) !== revision)
        throw new ChatError(409, '账号数据已在其他设备更新，请重试');
      const count = Number(
        store.db.prepare('SELECT count(*) AS n FROM im_vault_items WHERE user_id=?').get(user.id)!.n,
      );
      if (!old && count >= 1000) throw new ChatError(413, '账号配置条目过多');
      store.db
        .prepare(
          'INSERT INTO im_vault_items VALUES (?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET revision=excluded.revision,ciphertext=excluded.ciphertext',
        )
        .run(user.id, id, revision + 1, ciphertext ? JSON.stringify(ciphertext) : null);
      return { revision: revision + 1 };
    });
  });
}
