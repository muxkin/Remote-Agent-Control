import { afterEach, expect, it, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DesktopAppTools } from '../packages/adapter-codex/src/app-tools.js';
import { fixtureConfig, THREAD } from './helpers.js';
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
});
function setup() {
  const config = fixtureConfig();
  const app = new DesktopAppTools(config);
  const requests: any[] = [];
  const client = {
    request: vi.fn(async (_method: string, payload: any) => {
      requests.push(payload);
      return {
        success: true,
        contentItems: [
          {
            type: 'inputText',
            text: JSON.stringify(
              payload.tool === 'list_projects'
                ? {
                    projects: [
                      {
                        hostId: 'local',
                        projectKind: 'local',
                        projectId: 'project',
                        label: 'Project',
                        path: '/test',
                      },
                    ],
                  }
                : { threadId: THREAD, hostId: 'local' },
            ),
          },
        ],
      };
    }),
  };
  vi.spyOn(app as any, 'connect').mockResolvedValue(client);
  vi.spyOn(app, 'has').mockImplementation((tool) => ['list_projects', 'create_thread'].includes(tool));
  cleanup.push(() => {
    app.close();
    rmSync(config.desktopRoot, { recursive: true, force: true });
  });
  return { app, requests, client, config };
}
it('coalesces project reads and reuses the fresh directory when validating creation', async () => {
  const { app, requests } = setup();
  const [a, b] = await Promise.all([app.projects(THREAD), app.projects(THREAD)]);
  expect(a).toEqual(b);
  expect(requests).toHaveLength(1);
  await app.create(THREAD, 'request', { prompt: 'hello', projectId: 'project' });
  expect(requests.map((r) => r.tool)).toEqual(['list_projects', 'create_thread']);
  await expect(app.create(THREAD, 'invalid', { prompt: 'hello', projectId: 'absent' })).rejects.toThrow(
    '项目不可用',
  );
  expect(requests).toHaveLength(2);
});
it.each([undefined, '', '  '])(
  'omits a blank title from the actual native creation call (%s)',
  async (title) => {
    const { app, requests } = setup();
    await app.create(THREAD, 'request', { prompt: 'hello', title });
    expect(requests[0].arguments).toEqual({ prompt: 'hello', target: { type: 'projectless' } });
  },
);
it('passes only explicitly chosen model and thinking to the desktop', async () => {
  const { app, requests } = setup();
  await app.create(THREAD, 'request', {
    prompt: 'hello',
    title: 'custom',
    model: 'desktop-model',
    thinking: 'high',
  });
  expect(requests[0].arguments).toMatchObject({ title: 'custom', model: 'desktop-model', thinking: 'high' });
});
it('maps catalog project IDs to Desktop IDs only through explicit migration assignments', async () => {
  const { app, requests, config } = setup();
  mkdirSync(config.codexHome, { recursive: true });
  writeFileSync(
    join(config.codexHome, '.codex-global-state.json'),
    JSON.stringify({
      'app-server-project-id-by-legacy-project-id-by-host': {
        [`local:${config.codexHome}`]: { project: 'catalog-project' },
      },
    }),
  );
  expect((await app.projects(THREAD))[0]).toMatchObject({ id: 'catalog-project', desktopId: 'project' });
  await app.create(THREAD, 'request', { prompt: 'hello', projectId: 'catalog-project' });
  expect(requests.at(-1).arguments.target).toEqual({
    type: 'project',
    projectId: 'project',
    environment: { type: 'local' },
  });
});
it('does not retry an ambiguous native creation', async () => {
  const { app, requests, client } = setup();
  client.request.mockRejectedValueOnce(new Error('connection lost'));
  await expect(app.create(THREAD, 'request', { prompt: 'hello' })).rejects.toThrow('connection lost');
  expect(client.request).toHaveBeenCalledOnce();
  expect(requests).toHaveLength(0);
});
it('renames and forks the explicit local Codex thread through the Desktop tools', async () => {
  const { app, requests, client } = setup();
  const branch = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  vi.mocked(app.has).mockImplementation((tool) => ['set_thread_title', 'fork_thread'].includes(tool));
  await expect(app.rename(THREAD, 'rename-request', '新名称')).resolves.toBeNull();
  client.request.mockResolvedValueOnce({
    success: true,
    contentItems: [{ type: 'inputText', text: JSON.stringify({ threadId: branch, hostId: 'local' }) }],
  });
  await expect(app.fork(THREAD, 'fork-request')).resolves.toBe(branch);
  expect(requests[0]).toMatchObject({
    tool: 'set_thread_title',
    threadId: THREAD,
    callId: 'pocket-rename-request',
    arguments: { source: 'codex', threadId: THREAD, title: '新名称' },
  });
  expect(client.request.mock.calls[1][1]).toMatchObject({
    tool: 'fork_thread',
    threadId: THREAD,
    callId: 'pocket-fork-request',
    arguments: { threadId: THREAD, environment: { type: 'same-directory' } },
  });
  await expect(app.fork(THREAD, 'bad-result')).rejects.toThrow('分支标识');
});
