// V1 regression fixture only. Not included in any production entrypoint.
import { loadStorage } from '../../src/server/object-storage.js';
import { webBuildReader } from '../../src/server/web-build.js';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Config } from '../../src/server/config.js';
import { Store, ConflictError } from '../../src/server/store.js';
import { DesktopAdapter } from '../../src/server/desktop.js';
import { HistoryIndex } from '../../src/server/history.js';
import { Operations } from '../../src/server/operations.js';
import type { ServerEvent, ThreadView } from '../../src/shared/types.js';
import { diffViews } from '../../src/shared/delta.js';
import { modelCatalog, validateModelSettings } from '../../src/server/models.js';
import { SkillCatalog } from '../../src/server/skills.js';
import { PluginCatalog } from '../../src/server/plugins.js';
import { SelectionError } from '../../src/server/selection-error.js';
import { MediaService, authorizeFile, mediaTypes } from '../../src/server/media.js';
import { createReadStream } from 'node:fs';
import { basename, extname } from 'node:path';
import { PeerEvents } from './peer-events.js';
import { Uploads, uploadSpec } from '../../src/server/uploads.js';
import { creationBody } from '../../src/server/app-tools.js';
import { responseBody } from '../../src/server/approvals.js';
import { WebSocketOutput } from '../../src/server/websocket-output.js';

const uuid = z.string().uuid();
const params = z.object({ id: uuid });
const pageQuery = z.object({ cursor: z.string().max(512).optional() });
const sendBody = z
  .object({
    requestId: uuid,
    text: z.string().trim().max(16000),
    uploadIds: z.array(uuid).max(10).optional(),
    pluginIds: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .max(10)
      .optional(),
    skillIds: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .max(10)
      .optional(),
  })
  .strict()
  .refine((v) => !!v.text || !!v.uploadIds?.length);
const queueBody = z
  .object({
    requestId: uuid,
    text: z.string().trim().min(1).max(16000),
    expectedQueueFingerprint: z.string().length(64),
  })
  .strict();
const removeQueueBody = z
  .object({ requestId: uuid, messageId: uuid, expectedQueueFingerprint: z.string().length(64) })
  .strict();
const stopBody = z.object({ requestId: uuid, expectedTurnId: z.string().min(1).max(200) }).strict();
const steerBody = z
  .object({
    requestId: uuid,
    expectedTurnId: z.string().min(1).max(200),
    text: z.string().trim().min(1).max(16000),
  })
  .strict();
const pairingBody = z
  .object({ code: z.string().min(20).max(128), name: z.string().trim().min(1).max(80) })
  .strict();
const settingsBody = z
  .object({
    requestId: uuid,
    model: z.string().min(1).max(100),
    effort: z.string().min(1).max(20),
    mode: z.enum(['default', 'plan']).optional(),
    serviceTier: z.string().min(1).max(40).optional(),
    expectedServiceTier: z.string().nullable().optional(),
    expectedMode: z.enum(['default', 'plan']).optional(),
    expectedModel: z.string().nullable(),
    expectedEffort: z.string().nullable(),
  })
  .strict();
const COOKIE = 'pocket_session';
export async function buildGateway(
  config: Config,
  deps: { store: Store; desktop: DesktopAdapter; history: HistoryIndex },
) {
  const { store, desktop, history } = deps;
  const readWebBuild = webBuildReader(config.webRoot);
  const withBuild = (status = desktop.status()) => ({ ...status, webBuildId: readWebBuild() });
  const app = Fastify({ logger: false, bodyLimit: 70000, trustProxy: false });
  const operations = new Operations(desktop, store);
  const media = new MediaService(config);
  const uploads = new Uploads(config);
  const skills = new SkillCatalog(config.codexHome);
  const plugins = new PluginCatalog(config.codexHome);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );
  async function messageInput(body: z.infer<typeof sendBody>, device: string, thread: string) {
    await skills.selected(history.get(thread)!.cwd, body.skillIds ?? [], desktop.disabledPlugins(thread));
    await plugins.selected(history.get(thread)!.cwd, body.pluginIds ?? [], desktop.disabledPlugins(thread));
    return (
      '\u001e' +
      JSON.stringify({
        text: body.text,
        attachments: await uploads.attachments(body.uploadIds ?? [], device, thread),
        skillIds: body.skillIds ?? [],
        pluginIds: body.pluginIds ?? [],
      })
    );
  }
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 128 * 1024,
    perMessageDeflate: {
      threshold: 1024,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      concurrencyLimit: 2,
      zlibDeflateOptions: { level: 3 },
    },
  });
  const assetManifest = join(config.webRoot, 'asset-origin.json');
  if (
    existsSync(assetManifest) &&
    JSON.parse(readFileSync(assetManifest, 'utf8')).origin !== config.assetOrigin
  )
    throw new Error(
      'Asset origin changed: rebuild the frontend with the same POCKET_ASSET_BASE as the gateway.',
    );
  const assetSource = config.assetOrigin ? ` ${config.assetOrigin}` : '';
  const storage = config.media ? await loadStorage(config.media, 'media', config.origin) : null;
  const uploadSources = storage?.uploadOrigins.map((origin) => ` ${origin}`).join('') ?? '';
  const origin = new URL(config.origin);
  const pairingAttempts = new Map<string, { count: number; start: number }>();
  await app.register(cookie);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'${assetSource}; style-src 'self' 'unsafe-inline'${assetSource}; font-src 'self'${assetSource}; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self'${assetSource}${uploadSources}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
    if (req.headers.host !== origin.host) return reply.code(403).send({ error: 'Host 不匹配' });
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== config.origin)
      return reply.code(403).send({ error: 'Origin 不匹配' });
    if (req.url.split('?')[0] === '/api/pair') return;
    if (req.url.startsWith('/api/') && !store.authenticate(req.cookies[COOKIE]))
      return reply.code(401).send({ error: '请先配对设备' });
  });
  app.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof SelectionError) return reply.code(400).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: '请求参数无效' });
    if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
    if (error.statusCode && error.statusCode < 500)
      return reply.code(error.statusCode).send({ error: '请求无效' });
    reply.code(503).send({ error: '暂时无法读取桌面数据，请检查本机状态' });
  });
  app.post('/api/pair', async (req, reply) => {
    const now = Date.now();
    const ip = req.ip;
    for (const [key, value] of pairingAttempts) if (now - value.start > 60000) pairingAttempts.delete(key);
    const attempt = pairingAttempts.get(ip) ?? { count: 0, start: now };
    attempt.count++;
    pairingAttempts.set(ip, attempt);
    if (attempt.count > 10) return reply.code(429).send({ error: '配对尝试过多，请一分钟后重试' });
    const body = pairingBody.parse(req.body);
    const result = store.pair(body.code, body.name);
    if (!result) return reply.code(401).send({ error: '配对码无效或已过期，请在电脑重新生成' });
    reply.setCookie(COOKIE, result.token, {
      httpOnly: true,
      secure: origin.protocol === 'https:',
      sameSite: 'strict',
      path: '/',
      maxAge: 30 * 86400,
    });
    return { deviceId: result.deviceId };
  });
  app.get('/api/session', async (req) => ({
    device: store.authenticate(req.cookies[COOKIE]),
    status: withBuild(),
  }));
  app.post('/api/logout', async (req, reply) => {
    const device = store.authenticate(req.cookies[COOKIE])!;
    store.revoke(device.id);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/status', async () => withBuild());
  app.get('/api/threads/:id/content', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { messageId } = z
      .object({ messageId: z.string().min(1).max(500) })
      .strict()
      .parse(req.query);
    if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
    const message = desktop.fullMessage(id, messageId);
    if (!message) return reply.code(404).send({ error: '该内容不在当前桌面快照中，请重新打开会话' });
    return { message };
  });
  app.post('/api/threads/:id/media', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { path } = z
      .object({ path: z.string().min(1).max(4096) })
      .strict()
      .parse(req.body);
    const thread = history.get(id);
    if (!thread) return reply.code(404).send({ error: '找不到此会话' });
    try {
      if (path.startsWith('pocket-inline:')) {
        const source = desktop.inlineMedia(id, path);
        if (!source) throw Error();
        return await media.inline(source, store.authenticate(req.cookies[COOKIE])!.id);
      }
      const messages = [...(desktop.view(id)?.messages ?? []), ...(await history.page(id)).messages];
      const file =
        (await uploads.reference(path, store.authenticate(req.cookies[COOKIE])!.id, id)) ??
        (await authorizeFile(path, thread.cwd, messages));
      return await media.resolve(file, store.authenticate(req.cookies[COOKIE])!.id);
    } catch {
      return reply
        .code(403)
        .send({ error: '附件暂不可访问：请确认原文件仍存在，且已在当前会话中发送；也可以重新加载' });
    }
  });
  app.get('/api/media/:token', async (req, reply) => {
    const token = z.object({ token: z.string().max(128) }).parse(req.params).token;
    const grant = await media.grant(token, store.authenticate(req.cookies[COOKIE])!.id);
    if (!grant) return reply.code(403).send({ error: '附件链接已过期或不属于此设备' });
    const mime =
      grant.mimeType ?? mediaTypes[extname(grant.file).toLowerCase()] ?? 'application/octet-stream';
    reply
      .type(mime)
      .header('Accept-Ranges', 'bytes')
      .header(
        'Content-Disposition',
        `${mime === 'application/octet-stream' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(basename(grant.file))}`,
      );
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) return reply.code(416).send();
      const start = match[1] ? Number(match[1]) : Math.max(0, grant.size - Number(match[2]));
      const end = match[1] ? (match[2] ? Number(match[2]) : grant.size - 1) : grant.size - 1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start > end ||
        end >= grant.size
      )
        return reply.code(416).header('Content-Range', `bytes */${grant.size}`).send();
      reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${grant.size}`)
        .header('Content-Length', end - start + 1);
      return reply.send(createReadStream(grant.file, { start, end }));
    }
    reply.header('Content-Length', grant.size);
    return reply.send(createReadStream(grant.file));
  });
  app.post('/api/threads/:id/uploads', async (req, reply) => {
    const { id } = params.parse(req.params);
    if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
    return uploads.begin(uploadSpec.parse(req.body), store.authenticate(req.cookies[COOKIE])!.id, id);
  });
  const uploadParams = z.object({ id: uuid, uploadId: uuid });
  app.post('/api/threads/:id/uploads/:uploadId/chunk', { bodyLimit: 256 * 1024 }, async (req) => {
    const { id, uploadId } = uploadParams.parse(req.params);
    const { offset } = z.object({ offset: z.coerce.number().int().nonnegative() }).parse(req.query);
    if (!Buffer.isBuffer(req.body)) throw new z.ZodError([]);
    return uploads.chunk(uploadId, store.authenticate(req.cookies[COOKIE])!.id, id, offset, req.body);
  });
  app.post('/api/threads/:id/uploads/:uploadId/complete', async (req) => {
    const { id, uploadId } = uploadParams.parse(req.params);
    return uploads.finish(uploadId, store.authenticate(req.cookies[COOKIE])!.id, id);
  });
  app.get('/api/models', async () => modelCatalog(config.codexHome));
  app.get('/api/threads/:id/skills', async (req, reply) => {
    const { id } = params.parse(req.params);
    const thread = history.get(id);
    if (!thread) return reply.code(404).send({ error: '找不到此会话' });
    const excluded = desktop.disabledPlugins(id);
    return {
      skills: (await skills.list(thread.cwd))
        .filter((s) => !excluded.includes(s.pluginId ?? ''))
        .map(({ id, name, description, source, displayName, sourceKind }) => ({
          id,
          name,
          description,
          source,
          displayName,
          sourceKind,
        })),
    };
  });
  app.get('/api/threads/:id/plugins', async (req, reply) => {
    const { id } = params.parse(req.params),
      thread = history.get(id);
    if (!thread) return reply.code(404).send({ error: '找不到此会话' });
    const disabled = desktop.disabledPlugins(id);
    return {
      plugins: (await plugins.list(thread.cwd))
        .filter((p) => !disabled.includes(p.remoteId) && !disabled.includes(p.nativeId))
        .map(({ id, name, description }) => ({ id, name, description })),
    };
  });
  app.post('/api/threads/:id/responses', async (req, reply) => {
    const { id } = params.parse(req.params);
    const body = responseBody.parse(req.body);
    if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
    const { requestId, ...response } = body;
    return reply
      .code(202)
      .send(
        operations.submit(
          store.authenticate(req.cookies[COOKIE])!.id,
          id,
          requestId,
          'respond',
          JSON.stringify(response),
        ),
      );
  });
  app.post('/api/threads/:id/settings', async (req, reply) => {
    const { id } = params.parse(req.params);
    const body = settingsBody.parse(req.body);
    if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
    await validateModelSettings(config.codexHome, body);
    const { requestId, ...settings } = body;
    return reply
      .code(202)
      .send(
        operations.submit(
          store.authenticate(req.cookies[COOKIE])!.id,
          id,
          requestId,
          'settings',
          JSON.stringify(settings),
        ),
      );
  });
  app.get('/api/projects', async () => history.projects());
  app.get('/api/threads', async (req) => {
    const query = pageQuery
      .extend({
        project: z.union([uuid, z.literal('none')]).optional(),
        q: z.string().trim().max(120).optional(),
      })
      .parse(req.query);
    return history.list(query.cursor, 30, query.project, query.q);
  });
  app.get('/api/threads/:id/history', async (req, reply) => {
    const { id } = params.parse(req.params);
    const thread = history.get(id);
    if (!thread) return reply.code(404).send({ error: '找不到此会话' });
    const { rolloutPath: _, ...summary } = thread;
    return { thread: summary, ...(await history.page(id, pageQuery.parse(req.query).cursor)) };
  });
  app.get('/api/threads/:id', async (req, reply) => {
    const thread = history.get(params.parse(req.params).id);
    if (!thread) return reply.code(404).send({ error: '找不到此会话' });
    const { rolloutPath: _, ...summary } = thread;
    return { thread: summary };
  });
  app.get('/api/threads/:id/projects', async (req, reply) => {
    const { id } = params.parse(req.params);
    if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
    return { projects: (await desktop.projects(id)).map(({ id, name }) => ({ id, name })) };
  });
  app.post('/api/threads/:id/create', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { requestId, ...value } = creationBody.parse(req.body);
    if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
    if (value.thinking && !value.model) throw new SelectionError('请先选择模型');
    if (value.model) {
      const model = (await modelCatalog(config.codexHome)).models.find((m) => m.id === value.model);
      if (!model || (value.thinking && !model.efforts.includes(value.thinking)))
        throw new SelectionError('模型或推理强度不在桌面目录中，请重新选择');
    }
    return reply
      .code(202)
      .send(
        operations.submit(
          store.authenticate(req.cookies[COOKIE])!.id,
          id,
          requestId,
          'create',
          JSON.stringify(value),
        ),
      );
  });
  app.post('/api/threads/:id/open', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { requestId } = z.object({ requestId: uuid }).strict().parse(req.body);
    if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
    return reply
      .code(202)
      .send(operations.submit(store.authenticate(req.cookies[COOKIE])!.id, id, requestId, 'open', ''));
  });
  app.post('/api/threads/:id/messages', async (req, reply) => {
    const { id } = params.parse(req.params);
    const body = sendBody.parse(req.body);
    if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
    const device = store.authenticate(req.cookies[COOKIE])!;
    return reply
      .code(202)
      .send(
        operations.submit(device.id, id, body.requestId, 'send', await messageInput(body, device.id, id)),
      );
  });
  for (const kind of ['queue', 'queue-remove'] as const)
    app.post(`/api/threads/:id/${kind}`, async (req, reply) => {
      const { id } = params.parse(req.params);
      if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
      const { requestId, ...value } = (kind === 'queue' ? queueBody : removeQueueBody).parse(req.body);
      return reply
        .code(202)
        .send(
          operations.submit(
            store.authenticate(req.cookies[COOKIE])!.id,
            id,
            requestId,
            kind,
            JSON.stringify(value),
          ),
        );
    });
  app.post('/api/threads/:id/interrupt', async (req, reply) => {
    const { id } = params.parse(req.params);
    const body = stopBody.parse(req.body);
    if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
    return reply
      .code(202)
      .send(
        operations.submit(
          store.authenticate(req.cookies[COOKIE])!.id,
          id,
          body.requestId,
          'interrupt',
          body.expectedTurnId,
        ),
      );
  });
  app.post('/api/threads/:id/steer', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { requestId, ...value } = steerBody.parse(req.body);
    if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
    return reply
      .code(202)
      .send(
        operations.submit(
          store.authenticate(req.cookies[COOKIE])!.id,
          id,
          requestId,
          'steer',
          JSON.stringify(value),
        ),
      );
  });
  app.get('/api/operations/:id', async (req, reply) => {
    const result = store.operation(params.parse(req.params).id, store.authenticate(req.cookies[COOKIE])!.id);
    return result ?? reply.code(404).send({ error: '找不到此操作' });
  });
  app.get('/api/threads/:id/operations', async (req) =>
    store.recent(store.authenticate(req.cookies[COOKIE])!.id, params.parse(req.params).id),
  );
  if (existsSync(config.webRoot))
    await app.register(staticFiles, {
      root: config.webRoot,
      index: 'index.html',
      cacheControl: false,
      setHeaders(response, file) {
        response.setHeader(
          'Cache-Control',
          file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Not found' }));

  app.server.on('upgrade', (request, socket, head) => {
    const reject = (status: number) => {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
    };
    if (request.headers.host !== origin.host || request.headers.origin !== config.origin) return reject(403);
    const token = app.parseCookie(request.headers.cookie ?? '')[COOKIE];
    const device = store.authenticate(token);
    if (!device) return reject(401);
    const url = new URL(request.url ?? '/', config.origin);
    const id = uuid.safeParse(url.searchParams.get('threadId'));
    if (url.pathname !== '/api/events' || !id.success) return reject(400);
    let thread;
    try {
      thread = history.get(id.data);
    } catch {
      return reject(503);
    }
    if (!thread) return reject(404);
    wss.handleUpgrade(request, socket, head, (ws) => {
      const threadId = id.data;
      let release: (() => void) | undefined;
      let alive = true;
      let closed = false;
      let pendingView: ThreadView | null = null;
      let flush: NodeJS.Timeout | undefined;
      let published: ThreadView | null = null;
      let peer: PeerEvents | undefined;
      let peerAttempted = false;
      let previewTimer: NodeJS.Timeout | undefined;
      const output = new WebSocketOutput(ws);
      const send = (event: ServerEvent): boolean => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        const encoded = JSON.stringify(event);
        if (['thread', 'threadDelta', 'operation', 'control-receipt'].includes(event.type) && peer?.ready) {
          if (peer.send(encoded)) return true;
          // Closing the peer synchronously publishes a fresh WSS snapshot. Never append
          // an older delta or overwrite its revision after that resynchronization.
          if (event.type === 'thread' || event.type === 'threadDelta') return false;
        }
        return output.send(encoded);
      };
      let sentWebBuild: string | null = null;
      const onStatus = (status: any) => {
        const current = withBuild(status);
        sentWebBuild = current.webBuildId;
        return send({ type: 'status', status: current });
      };
      const publish = (view: ThreadView) => {
        if (view.synchronized) clearTimeout(previewTimer);
        const delivered =
          published && published.id === view.id
            ? send({ type: 'threadDelta', delta: diffViews(published, view) })
            : send({ type: 'thread', thread: view });
        if (delivered) published = view;
      };
      const onThread = (view: ThreadView) => {
        if (view.id !== threadId) return;
        pendingView = view;
        if (!flush)
          flush = setTimeout(() => {
            flush = undefined;
            if (pendingView) publish(pendingView);
            pendingView = null;
          }, 60);
      };
      const onOperation = (operation: any) => {
        if (operation.threadId === threadId && store.operation(operation.id, device.id))
          send({ type: 'operation', operation });
      };
      desktop.on('status', onStatus);
      desktop.on('thread', onThread);
      operations.on('operation', onOperation);
      onStatus(desktop.status());
      send({
        type: 'transport',
        p2pAvailable: config.p2p?.enabled ?? false,
        stunUrls: config.p2p?.stunUrls ?? [],
      });
      const ping = setInterval(() => {
        if (readWebBuild() !== sentWebBuild) onStatus(desktop.status());
        if (!store.authenticate(token)) {
          ws.close(1008, 'Device revoked or expired');
          return;
        }
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, 15000);
      ping.unref();
      ws.on('pong', () => {
        alive = true;
      });
      ws.on('message', (raw) => {
        try {
          const input = JSON.parse(raw.toString());
          if (input.type === 'p2p-fallback') {
            peer?.close();
            return;
          }
          if (
            input.type !== 'p2p-offer' ||
            !config.p2p?.enabled ||
            peerAttempted ||
            typeof input.sdp !== 'string' ||
            input.sdp.length > 100000
          )
            throw Error();
          peerAttempted = true;
          const snapshot = () => {
            if (closed) return;
            const view = desktop.view(threadId) ?? published;
            if (view) {
              published = null;
              publish(view);
            }
          };
          peer = new PeerEvents(
            config.p2p.stunUrls,
            snapshot,
            () => {
              if (closed) return;
              send({ type: 'transport', p2pAvailable: false, stunUrls: [] });
              snapshot();
            },
            (input) => {
              void (async () => {
                if (!store.authenticate(token)) {
                  peer?.close();
                  ws.close(1008, 'Device revoked');
                  return;
                }
                const message = z
                  .object({
                    type: z.literal('control'),
                    action: z.enum([
                      'send',
                      'steer',
                      'interrupt',
                      'settings',
                      'respond',
                      'queue',
                      'queue-remove',
                    ]),
                    payload: z.record(z.string(), z.unknown()),
                  })
                  .strict()
                  .parse(input);
                const requestId = uuid.parse(message.payload.requestId);
                try {
                  let payload: string;
                  if (message.action === 'send')
                    payload = await messageInput(sendBody.parse(message.payload), device.id, threadId);
                  else if (message.action === 'steer') {
                    const { requestId: _, ...value } = steerBody.parse(message.payload);
                    payload = JSON.stringify(value);
                  } else if (message.action === 'interrupt')
                    payload = stopBody.parse(message.payload).expectedTurnId;
                  else if (message.action === 'settings') {
                    const { requestId: _, ...value } = settingsBody.parse(message.payload);
                    await validateModelSettings(config.codexHome, value);
                    payload = JSON.stringify(value);
                  } else if (message.action === 'queue' || message.action === 'queue-remove') {
                    const { requestId: _, ...value } = (
                      message.action === 'queue' ? queueBody : removeQueueBody
                    ).parse(message.payload);
                    payload = JSON.stringify(value);
                  } else {
                    const { requestId: _, ...value } = responseBody.parse(message.payload);
                    payload = JSON.stringify(value);
                  }
                  send({
                    type: 'control-receipt',
                    requestId,
                    operation: operations.submit(device.id, threadId, requestId, message.action, payload),
                  });
                } catch (error) {
                  send({
                    type: 'control-receipt',
                    requestId,
                    error:
                      error instanceof SelectionError
                        ? error.message
                        : '请求参数或当前状态不允许此操作，请重新核对',
                    notSent: error instanceof SelectionError || error instanceof z.ZodError,
                  });
                }
              })().catch(() => peer?.close());
            },
          );
          void peer
            .answer(input.sdp)
            .then((sdp) => {
              if (!closed) send({ type: 'p2p-answer', sdp });
            })
            .catch(() => peer?.close());
        } catch {
          ws.close(1008, 'Unsupported signalling message');
        }
      });
      ws.on('error', () => {});
      ws.on('close', () => {
        closed = true;
        peer?.close();
        clearInterval(ping);
        clearTimeout(flush);
        clearTimeout(previewTimer);
        release?.();
        desktop.off('status', onStatus);
        desktop.off('thread', onThread);
        operations.off('operation', onOperation);
      });
      // Reading history should not wait on owner discovery or a full Desktop snapshot.
      // Give the usually fast live stream a head start to avoid downloading both.
      const preview = async () => {
        if (closed || published) return;
        const page = await history.page(threadId);
        if (closed || published) return;
        publish({
          id: thread.id,
          title: thread.title,
          cwd: thread.cwd,
          updatedAt: thread.updatedAt,
          messages: page.messages,
          revision: -1,
          owner: false,
          synchronized: false,
          activeTurnId: null,
          runtimeStatus: 'notLoaded',
          model: null,
          pendingRequests: 0,
          canSend: false,
          canInterrupt: false,
          reason: desktop.observation(threadId).reason,
        });
      };
      previewTimer = setTimeout(() => {
        void preview().catch(() => {});
      }, 700);
      void (async () => {
        release = await desktop.acquire(threadId);
        if (closed) {
          release();
          return;
        }
        const view = await desktop.waitForView(threadId);
        if (closed) return;
        if (view) publish(view);
        else await preview();
        for (const operation of store.recent(device.id, threadId)) send({ type: 'operation', operation });
      })().catch(() => send({ type: 'error', message: '无法订阅此会话，请刷新后重试' }));
    });
  });
  app.addHook('preClose', async () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    operations.close();
  });
  return app;
}
