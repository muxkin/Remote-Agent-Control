import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { USER_ID_PATTERN, USERNAME_PATTERN } from '../../shared/account-identity.js';
import { ChatError, MessagingStore } from './store.js';
import { MessagingObjects, type MediaKind } from './objects.js';
import type { StorageAdapter } from '../object-storage.js';
import { attachmentMime } from './media.js';
import sharp from 'sharp';
import { interactionInput, interactionResponse } from './interaction.js';
import type { ChatUser } from '../../shared/messaging.js';

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_PATTERN, '用户名为 3–32 位字母、数字、横线或下划线，至少包含一个字母');
const userId = z.string().regex(USER_ID_PATTERN, 'UID 必须是无前导零的正十进制字符串');
const identifier = z.string().trim().min(1).toLowerCase();
const displayName = z.string().trim().min(1).max(60);
const password = z.string().min(10).max(128);
const opaque = z.string().min(20).max(256);
const integer = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const COOKIE = 'pocket_im_session';
const derive = (value: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(value, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
export interface MessagingConfig {
  database: string;
  origin: string;
  registrationCode?: string;
  storage?: StorageAdapter;
  clientAddress: (request: FastifyRequest['raw']) => string;
}

/** HTTP is intentionally independent of the encrypted desktop relay protocol. */
export async function registerMessaging(parent: FastifyInstance, config: MessagingConfig) {
  const store = new MessagingStore(config.database, new URL(config.origin).host.toLowerCase());
  const objects = new MessagingObjects(store, config.storage, config.origin);
  await parent.register(
    async (app) => {
      await app.register(cookie);
      const limits = new Map<string, { count: number; expires: number }>();
      const waiters = new Map<string, Set<() => void>>();
      let hashing = 0,
        closing = false;
      const take = (key: string, max: number) => {
        const now = Date.now();
        for (const [key, value] of limits) if (value.expires <= now) limits.delete(key);
        const item = limits.get(key) ?? { count: 0, expires: now + 60_000 };
        if (item.count >= max || (!limits.has(key) && limits.size >= 20_000))
          throw new ChatError(429, '操作过于频繁，请稍后再试');
        item.count++;
        limits.set(key, item);
      };
      const hash = async (value: string, salt: string) => {
        if (hashing >= 4) throw new ChatError(429, '登录服务繁忙，请稍后再试');
        hashing++;
        try {
          return await derive(value, salt);
        } finally {
          hashing--;
        }
      };
      const token = (req: FastifyRequest) =>
        req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : (req.cookies[COOKIE] ?? '');
      const identity = (req: FastifyRequest): ChatUser => {
        const value = token(req);
        const user = value.length <= 256 ? store.authenticate(value) : null;
        if (!user) throw new ChatError(401, '请先登录');
        return user;
      };
      const human = (req: FastifyRequest) => {
        const user = identity(req);
        if (user.kind !== 'human') throw new ChatError(403, '此操作需要个人账户');
        return user;
      };
      const session = (reply: FastifyReply, user: ChatUser) => {
        const { token: value, expiresAt } = store.issueSession(user.id);
        reply.setCookie(COOKIE, value, {
          path: '/api/im',
          httpOnly: true,
          sameSite: 'strict',
          secure: config.origin.startsWith('https:'),
          expires: new Date(expiresAt),
        });
        return { user };
      };
      const cid = (req: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(req.params).id;
      const uid = (req: FastifyRequest) => z.object({ id: userId }).parse(req.params).id;
      app.addHook('onRequest', async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (closing) throw new ChatError(503, '消息服务正在重启');
        if (req.headers.origin && req.headers.origin !== config.origin)
          throw new ChatError(403, '请求来源不受信任');
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new ChatError(403, '请求来源不受信任');
        if (
          !['GET', 'HEAD'].includes(req.method) &&
          req.cookies[COOKIE] &&
          !req.headers.authorization &&
          req.headers.origin !== config.origin
        )
          throw new ChatError(403, '请求缺少同源验证');
        let address: string;
        try {
          address = config.clientAddress(req.raw);
        } catch {
          throw new ChatError(400, '请求地址无效');
        }
        take(`ip:${address}`, 2400);
        if (/\/(login|register|agents\/register)$/.test(req.url.split('?')[0])) take(`auth:${address}`, 15);
        if (Number(req.headers['content-length'] ?? 0) > 11 * 1024 * 1024)
          throw new ChatError(413, '消息过大');
      });
      app.setErrorHandler((error, _req, reply) => {
        if (error instanceof z.ZodError)
          return reply.code(400).send({ error: error.issues[0]?.message ?? '请求格式不正确' });
        const status =
          error instanceof ChatError ? error.statusCode : (error as { statusCode?: number }).statusCode;
        if (status === 429) reply.header('Retry-After', '60');
        return reply
          .code(status && status >= 400 && status < 500 ? status : 500)
          .send({ error: error instanceof ChatError ? error.message : '请求未完成，请重试' });
      });
      app.addContentTypeParser(
        'application/octet-stream',
        { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 },
        (_req, body, done) => done(null, body),
      );
      const messageParams = (req: FastifyRequest) =>
        z.object({ id: z.string().uuid(), messageId: z.string().uuid() }).parse(req.params);
      const fileParams = (req: FastifyRequest) =>
        z.object({ id: z.string().uuid(), fileId: z.string().uuid() }).parse(req.params);
      const serveMedia = async (
        req: FastifyRequest,
        reply: FastifyReply,
        kind: MediaKind,
        id: string,
        file: { name: string; mime: string; size: number; data: Buffer },
      ) => {
        const query = z
          .object({
            meta: z.string().optional(),
            full: z.string().optional(),
            download: z.string().optional(),
          })
          .parse(req.query);
        const path = req.url.split('?')[0],
          resource = await objects.resource(kind, id, file, path, query.full === '1' || query.meta !== '1');
        if (query.meta === '1') return resource;
        reply
          .header('Cache-Control', 'private, no-cache')
          .header('Vary', 'Cookie, Authorization')
          .header('ETag', `"${resource.cacheKey}"`);
        if (req.headers['if-none-match'] === `"${resource.cacheKey}"`) return reply.code(304).send();
        const object = objects.metadata(kind, id);
        if (object && query.download === undefined) return reply.redirect(resource.url);
        const name = encodeURIComponent(file.name).replace(
          /['()*]/g,
          (c) => '%' + c.charCodeAt(0).toString(16),
        );
        reply
          .header('Content-Security-Policy', "default-src 'none'; sandbox")
          .header(
            'Content-Disposition',
            `${query.download === undefined && (/^(image|audio|video)\//.test(file.mime) || /^(text\/plain|application\/pdf)(;|$)/.test(file.mime)) ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
          )
          .type(file.mime);
        return reply.send(await objects.bytes(kind, id, file.data));
      };
      app.post('/me/avatar', { bodyLimit: 2 * 1024 * 1024 }, async (req) => {
        const user = identity(req);
        take(`avatar:${user.id}`, 10);
        if (!Buffer.isBuffer(req.body) || !attachmentMime('avatar', req.body).startsWith('image/'))
          throw new ChatError(400, '请选择 PNG、JPEG、GIF 或 WebP 图片');
        let data: Buffer;
        try {
          data = await sharp(req.body, { limitInputPixels: 20_000_000 })
            .rotate()
            .resize(256, 256, { fit: 'cover' })
            .webp({ quality: 85 })
            .toBuffer();
        } catch {
          throw new ChatError(400, '无法读取头像图片');
        }
        const object = config.storage ? await objects.put(data, 'image/webp') : undefined;
        const id = store.setAvatar(user.id, data);
        if (object) objects.commit('avatar', id, object);
        return { user: store.user(user.id) };
      });
      app.delete('/me/avatar', async (req) => ({ user: store.removeAvatar(identity(req).id) }));
      app.get('/users/:userId/avatar/:version', async (req, reply) => {
        const params = z.object({ userId, version: z.string().uuid() }).parse(req.params);
        const file = store.avatar(identity(req).id, params.userId, params.version);
        return serveMedia(req, reply, 'avatar', file.id, file);
      });
      app.post('/password', { bodyLimit: 4096 }, async (req) => {
        const user = human(req);
        take(`password:${user.id}`, 5);
        const body = z.object({ currentPassword: password, newPassword: password }).parse(req.body);
        const existing = store.credentials(user.username)!;
        const [salt, expected] = existing.passwordHash.split(':');
        if (!timingSafeEqual(await hash(body.currentPassword, salt), Buffer.from(expected, 'hex')))
          throw new ChatError(403, '当前密码不正确');
        const nextSalt = randomBytes(16).toString('hex'),
          key = await hash(body.newPassword, nextSalt);
        // Another change while hashing must not overwrite newer credentials.
        if (store.credentials(user.username)?.passwordHash !== existing.passwordHash)
          throw new ChatError(409, '密码已被更改，请重新登录');
        store.changePassword(user.id, `${nextSalt}:${key.toString('hex')}`, token(req));
        return { ok: true };
      });
      app.post('/logout-others', async (req) => {
        store.logoutOthers(human(req).id, token(req));
        return { ok: true };
      });
      app.patch('/contacts/:id', { bodyLimit: 4096 }, async (req) => {
        store.editContact(
          identity(req).id,
          uid(req),
          z
            .object({ remark: z.string().trim().max(60).optional(), blocked: z.boolean().optional() })
            .parse(req.body),
        );
        return { ok: true };
      });
      app.delete('/contacts/:id', async (req) => {
        store.editContact(identity(req).id, uid(req), {}, true);
        return { ok: true };
      });
      app.post('/groups', { bodyLimit: 8192 }, async (req) => {
        const body = z
          .object({
            name: z.string().trim().min(1).max(80),
            userIds: z.array(userId).min(1).max(49),
          })
          .parse(req.body);
        return { conversation: store.createGroup(identity(req).id, body.name, body.userIds) };
      });
      app.patch('/groups/:id', { bodyLimit: 8192 }, async (req) => {
        const change = z
          .object({
            name: z.string().trim().min(1).max(80).optional(),
            add: z.array(userId).max(49).optional(),
            remove: userId.optional(),
            ownerId: userId.optional(),
            closed: z.literal(true).optional(),
          })
          .parse(req.body);
        store.updateGroup(identity(req).id, cid(req), change);
        return { ok: true };
      });
      app.get('/conversations/:id', async (req) => ({
        conversation: store.conversation(identity(req).id, cid(req)),
      }));
      app.get('/conversations/:id/search', async (req) => {
        const q = z
          .object({ q: z.string().trim().min(1).max(100), before: integer.optional() })
          .parse(req.query);
        return store.search(identity(req).id, cid(req), q.q, q.before);
      });
      app.get('/conversations/:id/messages/:messageId', async (req) => {
        const params = messageParams(req);
        return { message: store.message(identity(req).id, params.id, params.messageId) };
      });
      app.patch('/conversations/:id/messages/:messageId', { bodyLimit: 256 * 1024 }, async (req) => {
        const user = identity(req);
        take(`stream:${user.id}`, 600);
        const params = messageParams(req),
          body = z
            .object({
              revision: z.number().int().min(1).max(1000000),
              text: z.string().max(64000),
              state: z.enum(['streaming', 'complete', 'failed']).default('streaming'),
            })
            .parse(req.body);
        return {
          message: store.updateMessage(
            user.id,
            params.id,
            params.messageId,
            body.revision,
            body.text,
            body.state,
          ),
        };
      });
      app.post('/conversations/:id/messages/:messageId/cancel', async (req) => {
        const params = messageParams(req);
        return { message: store.cancel(identity(req).id, params.id, params.messageId) };
      });
      app.post('/conversations/:id/messages/:messageId/respond', { bodyLimit: 128 * 1024 }, async (req) => {
        const user = human(req),
          params = messageParams(req);
        take(`response:${user.id}`, 120);
        return {
          message: store.respond(user.id, params.id, params.messageId, interactionResponse.parse(req.body)),
        };
      });
      app.post('/conversations/:id/messages/:messageId/interaction/cancel', async (req) => {
        const params = messageParams(req);
        return { message: store.cancelInteraction(identity(req).id, params.id, params.messageId) };
      });
      app.get('/stickers', async (req) => ({ stickers: store.stickers(identity(req).id) }));
      app.post('/stickers', async (req) => {
        const user = identity(req);
        take(`sticker:${user.id}`, 30);
        const body = z
          .object({ conversationId: z.string().uuid(), fileId: z.string().uuid() })
          .parse(req.body);
        return { stickers: store.saveSticker(user.id, body.conversationId, body.fileId) };
      });
      app.delete('/stickers/:id', async (req) => {
        store.removeSticker(identity(req).id, cid(req));
        return { ok: true };
      });
      app.get('/stickers/:id/file', async (req, reply) => {
        const file = store.sticker(identity(req).id, cid(req));
        return serveMedia(req, reply, 'sticker', file.id, file);
      });
      app.post('/conversations/:id/files', { bodyLimit: 10 * 1024 * 1024 }, async (req) => {
        const user = identity(req);
        take(`upload:${user.id}`, 30);
        let name: string;
        try {
          name = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
        } catch {
          throw new ChatError(400, '文件名格式无效');
        }
        name = z
          .string()
          .trim()
          .min(1)
          .max(180)
          .regex(/^[^\x00-\x1f/\\]+$/)
          .parse(name);
        if (!Buffer.isBuffer(req.body)) throw new ChatError(400, '请发送原始文件字节');
        const file = store.upload(user.id, cid(req), name, req.body);
        if (config.storage) {
          try {
            objects.commit('file', file.id, await objects.put(req.body, file.mime));
          } catch {
            store.removeUpload(user.id, cid(req), file.id);
            throw new ChatError(503, '附件存储暂不可用，请重试');
          }
        }
        return { file };
      });
      app.get('/conversations/:id/files/:fileId/:name', async (req, reply) => {
        const params = fileParams(req),
          file = store.file(identity(req).id, params.id, params.fileId);
        return serveMedia(req, reply, 'file', file.id, file);
      });
      app.delete('/conversations/:id/files/:fileId', async (req) => {
        const params = fileParams(req);
        store.removeUpload(identity(req).id, params.id, params.fileId);
        return { ok: true };
      });
      const expiry = setInterval(() => {
        store.expireStreams();
        store.expireInteractions();
      }, 15000);
      expiry.unref();
      app.addHook('onClose', async () => clearInterval(expiry));
      app.get('/bootstrap', async (req) => {
        const user = identity(req);
        return {
          user,
          contacts: store.contacts(user.id),
          conversations: store.conversations(user.id),
          cursor: store.cursor(user.id),
        };
      });
      app.get('/status', async () => ({ registrationRequiresCode: !!config.registrationCode }));
      app.post('/register', { bodyLimit: 4096 }, async (req, reply) => {
        const body = z
          .object({ username, displayName, password, registrationCode: z.string().max(256).optional() })
          .parse(req.body);
        if (config.registrationCode && body.registrationCode !== config.registrationCode)
          throw new ChatError(403, '注册码不正确');
        const salt = randomBytes(16).toString('hex');
        const key = await hash(body.password, salt);
        const user = store.createUser(
          'human',
          body.username,
          body.displayName,
          `${salt}:${key.toString('hex')}`,
        );
        reply.code(201);
        return session(reply, user);
      });
      app.post('/login', { bodyLimit: 4096 }, async (req, reply) => {
        const body = z.object({ identifier, password }).parse(req.body);
        const user = store.credentials(body.identifier);
        take(`login:${user?.id ?? body.identifier}`, 15);
        const [salt, expected] = (user?.passwordHash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
        const key = await hash(body.password, salt);
        if (!user || !timingSafeEqual(key, Buffer.from(expected, 'hex')))
          throw new ChatError(401, '用户名或密码不正确');
        return session(reply, store.user(user.id));
      });
      app.get('/me', async (req) => ({ user: token(req) ? identity(req) : null }));
      app.patch('/me', { bodyLimit: 4096 }, async (req) => {
        const user = identity(req);
        return { user: store.profile(user.id, z.object({ displayName }).parse(req.body).displayName) };
      });
      app.post('/logout', async (req, reply) => {
        store.logout(token(req));
        reply.clearCookie(COOKIE, {
          path: '/api/im',
          httpOnly: true,
          sameSite: 'strict',
          secure: config.origin.startsWith('https:'),
        });
        return { ok: true };
      });
      app.post('/agent-invitations', async (req) => store.invite(human(req).id));
      app.post('/agents/register', { bodyLimit: 4096 }, async (req, reply) => {
        const body = z.object({ invitation: opaque, username, displayName }).parse(req.body);
        const result = store.registerAgent(body.invitation, body.username, body.displayName);
        reply.code(201);
        return result;
      });
      app.get('/agents', async (req) => ({ users: store.agents(human(req).id) }));
      app.delete('/agents/:id/credentials', async (req) => store.revokeAgent(human(req).id, uid(req), false));
      app.post('/agents/:id/credentials', async (req) => store.revokeAgent(human(req).id, uid(req), true));
      app.get('/contacts', async (req) => ({ users: store.contacts(identity(req).id) }));
      app.post('/contacts', { bodyLimit: 4096 }, async (req) => ({
        user: store.addContact(identity(req).id, z.object({ identifier }).parse(req.body).identifier),
      }));
      app.get('/conversations', async (req) => ({ conversations: store.conversations(identity(req).id) }));
      app.post('/conversations', { bodyLimit: 4096 }, async (req) => ({
        conversation: store.direct(identity(req).id, z.object({ userId }).parse(req.body).userId),
      }));
      app.get('/conversations/:id/messages', async (req) => {
        const query = z.object({ before: integer.optional() }).parse(req.query);
        return store.history(identity(req).id, cid(req), query.before);
      });
      app.post('/conversations/:id/messages', { bodyLimit: 256 * 1024 }, async (req) => {
        const user = identity(req);
        take(`send:${user.id}`, 120);
        const body = z
          .object({
            clientId: z.string().min(1).max(128),
            text: z.string().max(64000).default(''),
            state: z.enum(['complete', 'streaming']).optional(),
            attachmentIds: z.array(z.string().uuid()).max(6).optional(),
            mentions: z.array(userId).max(50).optional(),
            replyTo: z.string().uuid().optional(),
            interaction: interactionInput.optional(),
            stickerId: z.string().uuid().optional(),
          })
          .parse(req.body);
        return { message: store.send(user.id, cid(req), body.clientId, body.text, body) };
      });
      app.post('/conversations/:id/read', { bodyLimit: 4096 }, async (req) => {
        store.read(identity(req).id, cid(req), z.object({ sequence: integer }).parse(req.body).sequence);
        return { ok: true };
      });
      app.get('/sync', async (req, reply) => {
        const user = identity(req);
        const { cursor, wait } = z
          .object({
            cursor: integer.default(0),
            wait: z.coerce.number().int().min(0).max(25_000).default(25_000),
          })
          .parse(req.query);
        const initial = store.sync(user.id, cursor);
        if (initial.events.length || !wait) return initial;
        const pending = waiters.get(user.id) ?? new Set<() => void>();
        if (pending.size >= 5) throw new ChatError(429, '此账户的实时连接过多');
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            store.changes.off(user.id, finish);
            reply.raw.off('close', finish);
            pending.delete(finish);
            if (!pending.size) waiters.delete(user.id);
            resolve();
          };
          const timer = setTimeout(finish, wait);
          pending.add(finish);
          waiters.set(user.id, pending);
          store.changes.once(user.id, finish);
          reply.raw.once('close', finish);
        });
        if (closing) return { events: [], cursor };
        identity(req); // Revoked/expired credentials cannot receive a pending response.
        return store.sync(user.id, cursor);
      });
      app.addHook('preClose', async () => {
        closing = true;
        for (const pending of waiters.values()) for (const finish of pending) finish();
      });
      app.addHook('onClose', async () => store.close());
    },
    { prefix: '/api/im' },
  );
  return store;
}
