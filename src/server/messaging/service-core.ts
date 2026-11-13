import type { MessagingHttp, MessagingReply, MessagingRequest } from './http.js';
import { CallStore, callId, type CallIceConfig } from './calls.js';
import { scrypt } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { USER_ID_PATTERN, USERNAME_PATTERN } from '../../shared/account-identity.js';
import { ChatError, type MessagingStore } from './store-core.js';
import type { MessagingObjects, MediaKind } from './objects.js';
import { registerAccounts, vaultSchema } from './accounts.js';
import { ResourceError } from '../resources/service.js';
import type { DesktopAuthorizations } from '../desktop-authorization.js';
import { desktopAuthorizationSchema, desktopTicketSchema } from '../../shared/desktop-authorization.js';
import { hostIdSchema, laneSchema, routeSchema } from '../../shared/relay-protocol.js';
import { assertEncryptedDatabase } from './encryption-state.js';
import { attachmentMime } from './media.js';
import { interactionInput, interactionResponse } from './interaction.js';
import type { ChatUser } from '../../shared/messaging.js';
import {
  SELECTION_TRANSLATION_LANGUAGES,
  SELECTION_TRANSLATION_MAX_LENGTH,
} from '../../shared/selection-translation.js';
import {
  selectionTranslationProviderInput,
  translateWithPersonalProvider,
  TranslationProviderError,
  type SelectionTranslator,
} from './translation.js';

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_PATTERN, '用户名为 3–32 位字母、数字、横线或下划线，至少包含一个字母');
const userId = z.string().regex(USER_ID_PATTERN, 'UID 必须是无前导零的正十进制字符串');
const identifier = z.string().trim().min(1).toLowerCase();
const displayName = z.string().trim().min(1).max(60);
const opaque = z.string().min(20).max(256);
const integer = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const isBuffer = (value: unknown): value is Buffer => Buffer.isBuffer(value);
const COOKIE = 'pocket_im_session';
const derive = (value: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(value, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
export interface MessagingConfig {
  store: MessagingStore;
  objects: Pick<MessagingObjects, 'put' | 'commit' | 'metadata' | 'resource' | 'bytes'> & {
    redirects?: boolean;
    collectGarbage?: () => Promise<number>;
  };
  avatar: (data: Buffer) => Promise<Buffer>;
  externalUploads?: boolean;
  maintenance?: boolean;
  maxHashing?: number;
  take?: (key: string, max: number) => void;
  origin: string;
  registrationCode?: string;
  humanContacts?: boolean;
  callIce?: CallIceConfig;
  storage?: boolean;
  desktops?: DesktopAuthorizations;
  translate?: SelectionTranslator;
}

/** Shared account/message routes; each provider supplies its HTTP and persistence adapters. */
export async function registerMessaging(app: MessagingHttp, config: MessagingConfig) {
  const { store, objects } = config;
  store.humanContacts = config.humanContacts === true;
  const calls = (store.calls = new CallStore(store, config.callIce));
  try {
    assertEncryptedDatabase(store.db);
  } catch (error) {
    store.close();
    throw error;
  }
  const limits = new Map<string, { count: number; expires: number }>();
  const waiters = new Map<string, Set<() => void>>();
  let hashing = 0,
    closing = false;
  const take =
    config.take ??
    ((key: string, max: number) => {
      const now = Date.now();
      for (const [key, value] of limits) if (value.expires <= now) limits.delete(key);
      const item = limits.get(key) ?? { count: 0, expires: now + 60_000 };
      if (item.count >= max || (!limits.has(key) && limits.size >= 20_000))
        throw new ChatError(429, '操作过于频繁，请稍后再试');
      item.count++;
      limits.set(key, item);
    });
  const hash = async (value: string, salt: string) => {
    if (hashing >= (config.maxHashing ?? 4)) throw new ChatError(429, '登录服务繁忙，请稍后再试');
    hashing++;
    try {
      return await derive(value, salt);
    } finally {
      hashing--;
    }
  };
  const token = (req: MessagingRequest) =>
    req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : (req.cookies[COOKIE] ?? '');
  const identity = (req: MessagingRequest): ChatUser => {
    const value = token(req);
    const user = value.length <= 256 ? store.authenticate(value) : null;
    if (!user) throw new ChatError(401, '请先登录');
    return user;
  };
  const human = (req: MessagingRequest) => {
    const user = identity(req);
    if (user.kind !== 'human') throw new ChatError(403, '此操作需要个人账户');
    return user;
  };
  const session = (reply: MessagingReply, user: ChatUser) => {
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
  const cid = (req: MessagingRequest) => z.object({ id: z.string().uuid() }).parse(req.params).id;
  await registerAccounts(app, {
    store,
    identity,
    human,
    token,
    session,
    hash,
    take,
    registrationCode: config.registrationCode,
  });
  const uid = (req: MessagingRequest) => z.object({ id: userId }).parse(req.params).id;
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
      address = req.clientAddress();
    } catch {
      throw new ChatError(400, '请求地址无效');
    }
    take(`ip:${address}`, 2400);
    if (/\/(login|register|agents\/register)$/.test(req.url.split('?')[0])) take(`auth:${address}`, 15);
    if (Number(req.headers['content-length'] ?? 0) > 11 * 1024 * 1024) throw new ChatError(413, '消息过大');
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: error.issues[0]?.message ?? '请求格式不正确' });
    const status =
      error instanceof ChatError ? error.statusCode : (error as { statusCode?: number }).statusCode;
    if (status === 429) reply.header('Retry-After', '60');
    return reply.code(status && status >= 400 && status < 600 ? status : 500).send({
      error:
        error instanceof ChatError || error instanceof ResourceError ? error.message : '请求未完成，请重试',
    });
  });
  const translate = config.translate;
  app.get('/translation', (req) => {
    human(req);
    return { available: !!translate };
  });
  app.post('/translation', { bodyLimit: 16 * 1024 }, async (req) => {
    const user = human(req);
    const { text, targetLanguage, provider } = z
      .object({
        text: z
          .string()
          .max(SELECTION_TRANSLATION_MAX_LENGTH, '最多可翻译 2000 个字符')
          .trim()
          .min(1, '请选择要翻译的文字'),
        targetLanguage: z.enum(SELECTION_TRANSLATION_LANGUAGES),
        provider: selectionTranslationProviderInput.optional(),
      })
      .parse(req.body);
    if (!provider && !translate) throw new ChatError(503, '站内翻译服务尚未配置');
    take(`translation:${user.id}`, 20);
    try {
      const translatedText = provider
        ? await translateWithPersonalProvider(provider, text, targetLanguage)
        : await translate!(text, targetLanguage);
      return { translatedText };
    } catch (error) {
      if (error instanceof TranslationProviderError)
        throw new ChatError(error.reason === 'timeout' ? 504 : 502, error.message);
      throw new ChatError(502, '翻译服务暂不可用，请稍后重试');
    }
  });
  if (config.desktops) {
    const desktops = config.desktops;
    const owner = (req: MessagingRequest, accountId: string) => {
      const user = human(req);
      if (user.id !== accountId || !user.encrypted) throw new ChatError(403, '请登录并解锁对应账号');
      return user.id;
    };
    app.post('/desktop-devices/approve', async (req) => {
      const { accountId, authorization } = z
        .object({
          accountId: userId,
          authorization: desktopAuthorizationSchema,
        })
        .parse(req.body);
      const account = owner(req, accountId);
      take(`desktop-approve:${account}`, 20);
      switch (await desktops.approve(account, authorization)) {
        case 'ok':
          return { ok: true };
        case 'expired':
          throw new ChatError(410, '授权请求已过期，请在适配器重新打开登录页');
        case 'invalid':
          throw new ChatError(400, '电脑签名无效');
        case 'conflict':
          throw new ChatError(409, '这台电脑已由另一个账号登记');
        case 'limit':
          throw new ChatError(409, '账号已达到电脑数量上限');
      }
    });
    app.post('/desktop-devices/ready', async (req) => {
      const { accountId, hostId, ticket } = z
        .object({
          accountId: userId,
          hostId: hostIdSchema,
          ticket: desktopTicketSchema,
        })
        .parse(req.body);
      const account = owner(req, accountId);
      take(`desktop-ready:${account}`, 120);
      return { ready: await desktops.ready(account, hostId, ticket) };
    });
    app.get('/desktop-devices', async (req) => ({ devices: await desktops.list(human(req).id) }));
    app.delete('/desktop-devices/:id', async (req) => {
      const { id } = z.object({ id: hostIdSchema }).parse(req.params);
      const { accountId } = z.object({ accountId: userId }).parse(req.body);
      if (!(await desktops.revoke(owner(req, accountId), id))) throw new ChatError(404, '找不到这台电脑');
      return { ok: true };
    });
  }
  const messageParams = (req: MessagingRequest) =>
    z.object({ id: z.string().uuid(), messageId: z.string().uuid() }).parse(req.params);
  const fileParams = (req: MessagingRequest) =>
    z.object({ id: z.string().uuid(), fileId: z.string().uuid() }).parse(req.params);
  const serveMedia = async (
    req: MessagingRequest,
    reply: MessagingReply,
    kind: MediaKind,
    id: string,
    file: { name: string; mime: string; size: number; data: Buffer; encrypted?: string; context?: string },
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
    if (query.meta === '1') return { ...resource, ...(file.context ? { context: file.context } : {}) };
    reply
      .header('Cache-Control', 'private, no-cache')
      .header('Vary', 'Cookie, Authorization')
      .header('ETag', `"${resource.cacheKey}"`);
    if (req.headers['if-none-match'] === `"${resource.cacheKey}"`) return reply.code(304).send();
    const object = objects.metadata(kind, id);
    if (object && objects.redirects !== false && query.download === undefined)
      return reply.redirect(resource.url);
    const name = encodeURIComponent(file.name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16));
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
    await store.resources?.prepare(user.id);
    take(`avatar:${user.id}`, 10);
    if (!isBuffer(req.body) || !attachmentMime('avatar', req.body).startsWith('image/'))
      throw new ChatError(400, '请选择 PNG、JPEG、GIF 或 WebP 图片');
    let data: Buffer;
    try {
      data = await config.avatar(req.body);
    } catch {
      throw new ChatError(400, '无法读取头像图片');
    }
    const id = store.setAvatar(user.id, data);
    const object = config.storage ? await objects.put(data, 'image/webp') : undefined;
    if (object) objects.commit('avatar', id, object);
    return { user: store.user(user.id) };
  });
  app.delete('/me/avatar', async (req) => ({ user: store.removeAvatar(identity(req).id) }));
  app.get('/users/:userId/avatar/:version', async (req, reply) => {
    const params = z.object({ userId, version: z.string().uuid() }).parse(req.params);
    const file = store.avatar(identity(req).id, params.userId, params.version);
    return serveMedia(req, reply, 'avatar', file.id, file);
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
    const q = z.object({ q: z.string().trim().min(1).max(100), before: integer.optional() }).parse(req.query);
    return store.search(identity(req).id, cid(req), q.q, q.before);
  });
  app.get('/conversations/:id/messages/:messageId', async (req) => {
    const params = messageParams(req);
    return { message: store.message(identity(req).id, params.id, params.messageId) };
  });
  app.get('/conversations/:id/by-client/:clientId', async (req) => {
    const params = z
      .object({ id: z.string().uuid(), clientId: z.string().min(1).max(128) })
      .parse(req.params);
    return { message: store.byClient(identity(req).id, params.id, params.clientId) };
  });
  app.patch('/conversations/:id/messages/:messageId', { bodyLimit: 1024 * 1024 }, async (req) => {
    const user = identity(req);
    take(`stream:${user.id}`, 600);
    const params = messageParams(req),
      body = z
        .object({
          revision: z.number().int().min(1).max(1000000),
          text: z.string().max(800000),
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
    await store.resources?.prepare(user.id);
    take(`sticker:${user.id}`, 30);
    const body = z.object({ conversationId: z.string().uuid(), fileId: z.string().uuid() }).parse(req.body);
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
  app.post('/conversations/:id/files', { bodyLimit: 10 * 1024 * 1024 + 16 }, async (req) => {
    const user = identity(req);
    await store.resources?.prepare(user.id);
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
    if (!isBuffer(req.body)) throw new ChatError(400, '请发送原始文件字节');
    const encrypted = req.headers['x-encrypted-header']
      ? z.string().max(16000).parse(req.headers['x-encrypted-header'])
      : undefined;
    const file = store.upload(user.id, cid(req), name, req.body, encrypted, !config.externalUploads);
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
  app.get('/resources', async (req) => {
    const user = identity(req);
    if (store.resources) return store.resources.status(user.id);
    return {
      managed: false,
      label: '自托管',
      storage: { used: store.mediaUsage(store.resourceOwner(user.id)), limit: null },
      relay: { used: 0, limit: null, resetsAt: 0, timeZone: 'UTC' },
    };
  });
  app.get('/resources/files', async (req) => {
    const { cursor = '' } = z.object({ cursor: z.string().max(100).optional() }).parse(req.query);
    return store.resourceFiles(identity(req).id, cursor);
  });
  app.get('/resources/files/:kind/:fileId', async (req, reply) => {
    const { kind, fileId } = z
      .object({ kind: z.enum(['file', 'sticker', 'avatar']), fileId: z.string().uuid() })
      .parse(req.params);
    return serveMedia(req, reply, kind, fileId, store.resourceFile(identity(req).id, kind, fileId));
  });
  app.post('/resources/cleanup', { bodyLimit: 16384 }, async (req) => {
    const user = identity(req);
    const { files } = z
      .object({
        files: z
          .array(z.object({ kind: z.enum(['file', 'sticker', 'avatar']), id: z.string().uuid() }).strict())
          .min(1)
          .max(100),
      })
      .strict()
      .parse(req.body);
    const result = store.clearResourceFiles(user.id, files);
    // Metadata deletion is durable; unavailable object storage is retried by maintenance.
    if (config.storage) await objects.collectGarbage?.().catch(() => {});
    return result;
  });
  app.post('/resources/relay-ticket', { bodyLimit: 2048 }, async (req) => {
    const user = identity(req);
    if (!store.resources) return { token: null };
    const { hostId, ticket, lane } = z
      .object({ hostId: hostIdSchema, ticket: routeSchema.shape.ticket, lane: laneSchema })
      .strict()
      .parse(req.body);
    return store.resources.issueRelay(user.id, token(req), hostId, ticket, lane);
  });
  const expiry =
    config.maintenance === false
      ? undefined
      : setInterval(() => {
          store.expireStreams();
          store.expireInteractions();
          calls.expire();
          if (config.storage) void objects.collectGarbage?.().catch(() => {});
        }, 15000);
  expiry?.unref();
  app.addHook('onClose', async () => clearInterval(expiry));
  app.get('/bootstrap', async (req) => {
    const user = identity(req);
    return {
      user,
      humanContacts: store.humanContacts,
      contacts: store.contacts(user.id),
      conversations: store.conversations(user.id),
      cursor: store.cursor(user.id),
    };
  });
  app.get('/calls/ice', async (req) => ({ iceServers: calls.iceServers(identity(req).id) }));
  app.put('/calls/presence', { bodyLimit: 1024 }, async (req) => {
    const user = identity(req);
    take(`call-presence:${user.id}`, 10);
    const body = z
      .object({ video: z.boolean(), available: z.boolean().default(true) })
      .strict()
      .parse(req.body);
    return calls.ready(user.id, body.video, body.available);
  });
  app.get('/conversations/:id/call-capabilities', async (req) =>
    calls.capabilities(identity(req).id, cid(req)),
  );
  app.post('/conversations/:id/calls', { bodyLimit: 1024 }, async (req) => {
    const user = human(req);
    take(`call-create:${user.id}`, 10);
    const body = z
      .object({ id: callId, mode: z.enum(['audio', 'video']) })
      .strict()
      .parse(req.body);
    return { call: calls.create(user.id, cid(req), body.id, body.mode) };
  });
  app.get('/calls', async (req) => ({ calls: calls.list(identity(req).id) }));
  app.get('/calls/:id', async (req) => {
    const id = z.object({ id: callId }).parse(req.params).id;
    const { after } = z.object({ after: integer.default(0) }).parse(req.query);
    return calls.poll(identity(req).id, id, after);
  });
  app.patch('/calls/:id', { bodyLimit: 1024 }, async (req) => {
    const id = z.object({ id: callId }).parse(req.params).id;
    const body = z
      .object({
        action: z.enum(['accept', 'heartbeat', 'end']),
        reason: z.enum(['hangup', 'declined', 'failed']).optional(),
      })
      .strict()
      .parse(req.body);
    return { call: calls.update(identity(req).id, id, body.action, body.reason) };
  });
  app.post('/calls/:id/signals', { bodyLimit: 128 * 1024 }, async (req) => {
    const user = identity(req),
      id = z.object({ id: callId }).parse(req.params).id;
    take(`call-signal:${user.id}`, 300);
    const body = z
      .object({
        id: callId,
        encrypted: z
          .string()
          .min(1)
          .max(120 * 1024),
      })
      .strict()
      .parse(req.body);
    calls.signal(user.id, id, body.id, body.encrypted);
    return { ok: true };
  });
  app.get('/status', async () => ({ registrationRequiresCode: !!config.registrationCode }));
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
  app.post('/agents/register', { bodyLimit: 32 * 1024 }, async (req, reply) => {
    const body = z.object({ invitation: opaque, username, displayName, vault: vaultSchema }).parse(req.body);
    const result = store.registerAgent(body.invitation, body.username, body.displayName, body.vault);
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
  app.post('/conversations/:id/messages', { bodyLimit: 1024 * 1024 }, async (req) => {
    const user = identity(req);
    take(`send:${user.id}`, 120);
    const body = z
      .object({
        clientId: z.string().min(1).max(128),
        text: z.string().max(800000).default(''),
        state: z.enum(['complete', 'streaming']).optional(),
        attachmentIds: z.array(z.string().uuid()).max(6).optional(),
        mentions: z.array(userId).max(50).optional(),
        replyTo: z.string().uuid().optional(),
        interaction: interactionInput.optional(),
        stickerId: z.string().uuid().optional(),
      })
      .parse(req.body);
    if (body.stickerId) await store.resources?.prepare(user.id);
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
  return store;
}
