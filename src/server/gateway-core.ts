import { join } from 'node:path';
import { DEFAULT_BACKEND } from '../shared/backends.js';
import { requireCapability } from './backends/registry.js';
import { resolveBackend, type BackendDependencies } from './backends/resolve.js';
import { z } from 'zod';
import { CoreRouter } from './core-router.js';
import type { Config } from './config.js';
import type { Store } from './store.js';
import { Operations } from './operations.js';
import { MediaService, authorizeFile } from './media.js';
import { Uploads, uploadSpec } from './uploads.js';
import { FileService } from './file-service.js';
import { creationBody } from './control-schemas.js';
import { responseBody } from './control-schemas.js';
import {
  uuid,
  params,
  pageQuery,
  sendBody,
  queueBody,
  removeQueueBody,
  stopBody,
  steerBody,
  settingsBody,
} from './control-schemas.js';

/** One business dispatcher, independent of HTTP, WebSocket and WebRTC. */
export function createGatewayCore(config: Config, deps: { store: Store } & BackendDependencies) {
  const { store } = deps;
  const desktop = resolveBackend(config, deps),
    history = desktop.history;
  const backendId = desktop.id;
  // Preserve the original Codex upload namespace; other instances get private directories.
  const scopedConfig =
    backendId === DEFAULT_BACKEND
      ? config
      : { ...config, stateDir: join(config.stateDir, 'backends', backendId) };
  const app = new CoreRouter();
  const operations = new Operations(desktop, store, backendId);
  const submit = operations.submit.bind(operations);
  operations.submit = (...args) => {
    requireCapability(desktop, args[3] === 'queue-remove' ? 'queue' : args[3]);
    return submit(...args);
  };
  const media = new MediaService({ ...scopedConfig, media: undefined });
  const uploads = new Uploads({ ...scopedConfig, media: undefined });
  const files = new FileService(scopedConfig, uploads);
  async function messageInput(body: z.infer<typeof sendBody>, device: string, thread: string) {
    await desktop.validateSelection(thread, body.skillIds ?? [], body.pluginIds ?? []);
    return JSON.stringify({
      text: body.text,
      attachments: await uploads.attachments(body.uploadIds ?? [], device, thread),
      skillIds: body.skillIds ?? [],
      pluginIds: body.pluginIds ?? [],
    });
  }
  app.get('/api/session', async (req) => ({
    device: req.device,
    status: desktop.status(),
  }));
  app.post('/api/logout', async (req, reply) => {
    const device = req.device;
    store.revoke(device.id);
    return { ok: true };
  });
  app.get('/api/status', async () => desktop.status());
  app.get('/api/threads/:id/content', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { messageId } = z
      .object({ messageId: z.string().min(1).max(500) })
      .strict()
      .parse(req.query);
    if (!(await history.get(id))) return reply.code(404).send({ error: '找不到此会话' });
    const message = desktop.fullMessage(id, messageId);
    if (!message) return reply.code(404).send({ error: '该内容不在当前会话快照中，请重新打开会话' });
    return { message };
  });
  app.post('/api/threads/:id/media', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { path } = z
      .object({ path: z.string().min(1).max(4096) })
      .strict()
      .parse(req.body);
    const thread = await history.get(id);
    if (!thread) return reply.code(404).send({ error: '找不到此会话' });
    try {
      if (path.startsWith('pocket-inline:')) {
        const source = desktop.inlineMedia(id, path);
        if (!source) throw Error();
        const link = await media.inline(source, req.device.id);
        const grant = await media.grant(link.url.split('/').at(-1)!, req.device.id);
        if (!grant) throw Error();
        return files.describe(grant.file, req.device.id, id, grant.mimeType);
      }
      const file =
        (await uploads.reference(path, req.device.id, id)) ??
        (desktop.attachment
          ? await desktop.attachment(id, path)
          : await authorizeFile(path, thread.cwd, [
              ...(desktop.view(id)?.messages ?? []),
              ...(await history.page(id)).messages,
            ]));
      const link = await media.resolve(file, req.device.id);
      const grant = await media.grant(link.url.split('/').at(-1)!, req.device.id);
      return files.describe(file, req.device.id, id, grant?.mimeType);
    } catch {
      return reply
        .code(403)
        .send({ error: '附件暂不可访问：请确认原文件仍存在，且已在当前会话中发送；也可以重新加载' });
    }
  });
  app.post('/api/threads/:id/uploads', async (req, reply) => {
    const { id } = params.parse(req.params);
    if (!(await history.get(id))) return reply.code(404).send({ error: '找不到此会话' });
    requireCapability(desktop, 'attachments');
    if (desktop.maxUploadBytes && req.body?.size > desktop.maxUploadBytes)
      return reply.code(400).send({ error: '文件超过此实例的附件大小限制' });
    return files.begin(req.body, req.device.id, id);
  });
  const uploadParams = params.extend({ uploadId: uuid });
  app.post('/api/threads/:id/uploads/:uploadId/chunk', async (req) => {
    const { id, uploadId } = uploadParams.parse(req.params);
    const { offset } = z.object({ offset: z.coerce.number().int().nonnegative() }).parse(req.query);
    if (!Buffer.isBuffer(req.body)) throw new z.ZodError([]);
    return uploads.chunk(uploadId, req.device.id, id, offset, req.body);
  });
  app.post('/api/threads/:id/uploads/:uploadId/complete', async (req) => {
    const { id, uploadId } = uploadParams.parse(req.params);
    return uploads.finish(uploadId, req.device.id, id);
  });
  app.get('/api/models', async () => desktop.models());
  app.get('/api/threads/:id/skills', async (req) => ({
    skills: await desktop.skills(params.parse(req.params).id),
  }));
  app.get('/api/threads/:id/plugins', async (req) => ({
    plugins: await desktop.plugins(params.parse(req.params).id),
  }));
  app.post('/api/threads/:id/responses', async (req, reply) => {
    const { id } = params.parse(req.params);
    const body = responseBody.parse(req.body);
    if (!(await history.get(id))) return reply.code(404).send({ error: '找不到此会话' });
    const { requestId, ...response } = body;
    return reply
      .code(202)
      .send(operations.submit(req.device.id, id, requestId, 'respond', JSON.stringify(response)));
  });
  app.post('/api/threads/:id/settings', async (req, reply) => {
    const { id } = params.parse(req.params);
    const body = settingsBody.parse(req.body);
    if (!(await history.get(id))) return reply.code(404).send({ error: '找不到此会话' });
    await desktop.validateSettings(body);
    const { requestId, ...settings } = body;
    return reply
      .code(202)
      .send(operations.submit(req.device.id, id, requestId, 'settings', JSON.stringify(settings)));
  });
  app.get('/api/projects', async () => history.projects());
  app.get('/api/threads', async (req) => {
    const query = pageQuery
      .extend({
        project: z.string().min(1).max(200).optional(),
        q: z.string().trim().max(120).optional(),
      })
      .parse(req.query);
    return history.list(query.cursor, 30, query.project, query.q);
  });
  app.get('/api/threads/:id/history', async (req, reply) => {
    const { id } = params.parse(req.params);
    const thread = await history.get(id);
    if (!thread) return reply.code(404).send({ error: '找不到此会话' });
    const summary = thread;
    return { thread: summary, ...(await history.page(id, pageQuery.parse(req.query).cursor)) };
  });
  app.get('/api/threads/:id', async (req, reply) => {
    const thread = await history.get(params.parse(req.params).id);
    if (!thread) return reply.code(404).send({ error: '找不到此会话' });
    const summary = thread;
    return { thread: summary };
  });
  app.get('/api/threads/:id/projects', async (req, reply) => {
    const { id } = params.parse(req.params);
    if (id !== 'new' && !(await history.get(id))) return reply.code(404).send({ error: '找不到此会话' });
    return { projects: (await desktop.projects(id)).map(({ id, name }) => ({ id, name })) };
  });
  app.post('/api/threads/:id/create', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { requestId, ...value } = creationBody.parse(req.body);
    if (id !== 'new' && !(await history.get(id))) return reply.code(404).send({ error: '找不到此会话' });
    await desktop.validateCreation(value);
    return reply
      .code(202)
      .send(operations.submit(req.device.id, id, requestId, 'create', JSON.stringify(value)));
  });
  app.post('/api/threads/:id/open', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { requestId } = z.object({ requestId: uuid }).strict().parse(req.body);
    if (!(await history.get(id))) return reply.code(404).send({ error: '找不到此会话' });
    return reply.code(202).send(operations.submit(req.device.id, id, requestId, 'open', ''));
  });
  app.post('/api/threads/:id/messages', async (req, reply) => {
    const { id } = params.parse(req.params);
    const body = sendBody.parse(req.body);
    if (!(await history.get(id))) return reply.code(404).send({ error: '找不到此会话' });
    const device = req.device;
    return reply
      .code(202)
      .send(
        operations.submit(device.id, id, body.requestId, 'send', await messageInput(body, device.id, id)),
      );
  });
  for (const kind of ['queue', 'queue-remove'] as const)
    app.post(`/api/threads/:id/${kind}`, async (req, reply) => {
      const { id } = params.parse(req.params);
      if (!(await history.get(id))) return reply.code(404).send({ error: '找不到此会话' });
      const { requestId, ...value } = (kind === 'queue' ? queueBody : removeQueueBody).parse(req.body);
      return reply
        .code(202)
        .send(operations.submit(req.device.id, id, requestId, kind, JSON.stringify(value)));
    });
  app.post('/api/threads/:id/interrupt', async (req, reply) => {
    const { id } = params.parse(req.params);
    const body = stopBody.parse(req.body);
    if (!(await history.get(id))) return reply.code(404).send({ error: '找不到此会话' });
    return reply
      .code(202)
      .send(operations.submit(req.device.id, id, body.requestId, 'interrupt', body.expectedTurnId));
  });
  app.post('/api/threads/:id/steer', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { requestId, uploadIds, ...value } = steerBody.parse(req.body);
    if (!(await history.get(id))) return reply.code(404).send({ error: '找不到此会话' });
    let attachments;
    try {
      attachments = await uploads.attachments(uploadIds ?? [], req.device.id, id);
    } catch {
      return reply.code(400).send({ error: '附件不可用，请重新添加到当前会话' });
    }
    return reply
      .code(202)
      .send(
        operations.submit(
          req.device.id,
          id,
          requestId,
          'steer',
          JSON.stringify(attachments.length ? { ...value, attachments } : value),
        ),
      );
  });
  app.get('/api/operations/:id', async (req, reply) => {
    const result = store.operation(params.parse(req.params).id, req.device.id, backendId);
    return result ?? reply.code(404).send({ error: '找不到此操作' });
  });
  app.get('/api/threads/:id/operations', async (req) =>
    store.recent(req.device.id, params.parse(req.params).id, backendId),
  );

  return {
    router: app,
    operations,
    uploads,
    media,
    files,
    status: () => desktop.status(),
    close: () => {
      operations.close();
      files.close();
    },
  };
}
