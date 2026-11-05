import { z } from 'zod';
import { CoreRouter } from './core-router.js';
import type { Config } from './config.js';
import type { Store } from './store.js';
import type { DesktopBackend } from './desktop-backend.js';
import type { HistoryIndex } from './history.js';
import { Operations } from './operations.js';
import { MediaService, authorizeFile } from './media.js';
import { Uploads, uploadSpec } from './uploads.js';
import { FileService } from './file-service.js';
import { SkillCatalog } from './skills.js';
import { PluginCatalog } from './plugins.js';
import { modelCatalog, validateModelSettings } from './models.js';
import { webBuildReader } from './web-build.js';
import { SelectionError } from './selection-error.js';
import { creationBody } from './app-tools.js';
import { responseBody } from './approvals.js';
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
export function createGatewayCore(
  config: Config,
  deps: { store: Store; desktop: DesktopBackend; history: HistoryIndex },
) {
  const { store, desktop, history } = deps;
  const app = new CoreRouter();
  const operations = new Operations(desktop, store);
  const media = new MediaService({ ...config, media: undefined });
  const uploads = new Uploads({ ...config, media: undefined });
  const files = new FileService(config, uploads);
  const skills = new SkillCatalog(config.codexHome);
  const plugins = new PluginCatalog(config.codexHome);
  const readWebBuild = webBuildReader(config.webRoot);
  const withBuild = () => ({ ...desktop.status(), webBuildId: readWebBuild() });
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
  app.get('/api/session', async (req) => ({
    device: req.device,
    status: withBuild(),
  }));
  app.post('/api/logout', async (req, reply) => {
    const device = req.device;
    store.revoke(device.id);
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
        const link = await media.inline(source, req.device.id);
        const grant = await media.grant(link.url.split('/').at(-1)!, req.device.id);
        if (!grant) throw Error();
        return files.describe(grant.file, req.device.id, id, grant.mimeType);
      }
      const messages = [...(desktop.view(id)?.messages ?? []), ...(await history.page(id)).messages];
      const file =
        (await uploads.reference(path, req.device.id, id)) ??
        (await authorizeFile(path, thread.cwd, messages));
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
    if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
    return files.begin(req.body, req.device.id, id);
  });
  const uploadParams = z.object({ id: uuid, uploadId: uuid });
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
      .send(operations.submit(req.device.id, id, requestId, 'respond', JSON.stringify(response)));
  });
  app.post('/api/threads/:id/settings', async (req, reply) => {
    const { id } = params.parse(req.params);
    const body = settingsBody.parse(req.body);
    if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
    await validateModelSettings(config.codexHome, body);
    const { requestId, ...settings } = body;
    return reply
      .code(202)
      .send(operations.submit(req.device.id, id, requestId, 'settings', JSON.stringify(settings)));
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
      .send(operations.submit(req.device.id, id, requestId, 'create', JSON.stringify(value)));
  });
  app.post('/api/threads/:id/open', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { requestId } = z.object({ requestId: uuid }).strict().parse(req.body);
    if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
    return reply.code(202).send(operations.submit(req.device.id, id, requestId, 'open', ''));
  });
  app.post('/api/threads/:id/messages', async (req, reply) => {
    const { id } = params.parse(req.params);
    const body = sendBody.parse(req.body);
    if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
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
      if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
      const { requestId, ...value } = (kind === 'queue' ? queueBody : removeQueueBody).parse(req.body);
      return reply
        .code(202)
        .send(operations.submit(req.device.id, id, requestId, kind, JSON.stringify(value)));
    });
  app.post('/api/threads/:id/interrupt', async (req, reply) => {
    const { id } = params.parse(req.params);
    const body = stopBody.parse(req.body);
    if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
    return reply
      .code(202)
      .send(operations.submit(req.device.id, id, body.requestId, 'interrupt', body.expectedTurnId));
  });
  app.post('/api/threads/:id/steer', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { requestId, uploadIds, ...value } = steerBody.parse(req.body);
    if (!history.get(id)) return reply.code(404).send({ error: '找不到此会话' });
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
    const result = store.operation(params.parse(req.params).id, req.device.id);
    return result ?? reply.code(404).send({ error: '找不到此操作' });
  });
  app.get('/api/threads/:id/operations', async (req) =>
    store.recent(req.device.id, params.parse(req.params).id),
  );

  return {
    router: app,
    operations,
    uploads,
    media,
    files,
    status: withBuild,
    close: () => {
      operations.close();
      files.close();
    },
  };
}
