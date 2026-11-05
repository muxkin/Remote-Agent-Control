import { privateOutput } from './private-output.js';
await privateOutput('.test-output');
/** Deterministic content/transport fixture; this does not control a real Desktop chat. */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:net';
import { writeFile, readFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fixtureConfig, historyFixture, FakeTransport, THREAD, state } from '../test/helpers.js';
import { Store } from '../src/server/store.js';
import { HistoryIndex } from '../src/server/history.js';
import { DesktopAdapter } from '../src/server/desktop.js';
import { buildGateway } from '../test/legacy/gateway.js';

const c = fixtureConfig();
historyFixture(c);
const output = resolve(process.env.POCKET_TEST_OUTPUT ?? '.test-output');
await mkdir(output, { recursive: true });
const externalDirectory = await mkdtemp(join(tmpdir(), 'pocket-external-media-'));
const externalPicture = join(externalDirectory, 'downloaded photo (1).png');
const video = join(c.desktopRoot, 'sample.mp4');
const audio = join(c.desktopRoot, 'sample.wav');
const picture = join(c.desktopRoot, 'sample.png');
for (const [destination, source] of [
  [video, 'color=c=blue:s=160x90:r=10'],
  [audio, 'sine=frequency=440:sample_rate=8000'],
]) {
  const command = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    source,
    '-t',
    '1',
    '-y',
    destination,
  ]);
  if (command.status !== 0) throw new Error('ffmpeg fixture generation failed');
}
const inlinePng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aFwkAAAAASUVORK5CYII=';
await writeFile(picture, Buffer.from(inlinePng, 'base64'));
await writeFile(externalPicture, Buffer.from(inlinePng, 'base64'));
const text = [
  '# 内容渲染验收',
  '**粗体**、[链接](https://example.com)、任务列表',
  '- [x] 已完成',
  '- [ ] 待处理',
  '| 项目 | 数值 |\n| --- | --- |\n| 测试 | 42 |',
  '行内公式 $E=mc^2$。',
  '$$\\int_0^1 x^2 dx=\\frac13$$',
  '```python',
  'print("你好")',
  '```',
  '```mermaid',
  'flowchart LR',
  ' A[手机] --> B[电脑]',
  '```',
  `![图片](${picture})`,
  `[视频](${video})`,
  `[音频](${audio})`,
  '<script>window.__unsafeExecuted=true</script>',
  '[危险链接](javascript:alert(1))',
].join('\n\n');
const native = new FakeTransport();
native.current = state({ title: '富内容验收', cwd: c.desktopRoot });
native.current.turnHistory.history.entitiesByKey.one.items = [
  { type: 'agentMessage', id: 'content-fixture', text },
  { type: 'imageGeneration', id: 'native-image', result: inlinePng },
  {
    type: 'mcpToolCall',
    id: 'native-audio',
    status: 'completed',
    result: {
      content: [{ type: 'audio', mimeType: 'audio/wav', data: (await readFile(audio)).toString('base64') }],
    },
  },
];
native.current.turnHistory.history.entitiesByKey.one.items.push({
  type: 'imageView',
  id: 'native-viewed-image',
  path: externalPicture,
  completedAtMs: Date.now(),
});
const db = new DatabaseSync(join(c.codexHome, 'state_5.sqlite'));
db.prepare('UPDATE threads SET cwd=?').run(c.desktopRoot);
db.close();
const server = createServer();
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
c.port = (server.address() as any).port;
await new Promise<void>((r) => server.close(() => r()));
c.origin = `http://127.0.0.1:${c.port}`;
c.webRoot = resolve(process.env.POCKET_TEST_WEB_ROOT ?? 'dist/web');
c.p2p = { enabled: true, stunUrls: [] };
const store = new Store(c.stateDir);
const history = new HistoryIndex(c.codexHome);
const desktop = new DesktopAdapter(c, () => native);
await desktop.start();
const app = await buildGateway(c, { store, history, desktop });
await app.listen({ host: '127.0.0.1', port: c.port });
const browser = await chromium.launch({ channel: process.env.POCKET_BROWSER_CHANNEL ?? 'chrome' });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
const page = await context.newPage();
const report: any = { fixture: true, checks: {}, errors: [] };
page.on('pageerror', (error) => report.errors.push(error.message));
let videoGrants = 0;
const mediaPaths: string[] = [];
let externalAttempts = 0;
await page.route('https://images.example.test/**', async (route) => {
  externalAttempts++;
  if (externalAttempts === 1) await route.fulfill({ status: 503, body: 'fixture unavailable' });
  else await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(inlinePng, 'base64') });
});
await page.route('**/api/threads/*/media', async (route) => {
  mediaPaths.push(route.request().postDataJSON().path);
  const response = await route.fetch();
  if (route.request().postDataJSON().path === video) {
    videoGrants++;
    const body = await response.json();
    // Exercise expiry renewal without waiting five minutes or invalidating the real grant.
    if (videoGrants === 1) body.expiresAt = Date.now() - 1000;
    await route.fulfill({ response, json: body });
  } else await route.fulfill({ response });
});
try {
  await page.goto(c.origin);
  await page.getByLabel('一次性配对码').fill(store.mintPairing().code);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  await page.getByRole('button', { name: '测试会话', exact: false }).click();
  const message = page.locator('.message.assistant').filter({ has: page.locator('h1') });
  await expect(message.locator('h1')).toHaveText('内容渲染验收');
  await expect(message.locator('strong')).toHaveText('粗体');
  await expect(message.locator('table')).toBeVisible();
  report.checks.markdown = true;
  await expect(message.locator('.katex')).toHaveCount(2, { timeout: 10000 });
  report.checks.latex = true;
  await message.locator('.code-block').first().scrollIntoViewIfNeeded();
  await expect(message.locator('.shiki')).toBeVisible({ timeout: 10000 });
  report.checks.syntaxHighlight = true;
  await message.locator('.diagram').scrollIntoViewIfNeeded();
  await expect(message.locator('.diagram svg')).toBeVisible({ timeout: 15000 });
  await expect(message.locator('.diagram svg')).toContainText('手机');
  await expect(message.locator('.diagram svg')).toContainText('电脑');
  report.checks.mermaid = true;
  await message.locator('.media').nth(0).scrollIntoViewIfNeeded();
  await expect
    .poll(() => message.locator('.message-text img').evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  report.checks.image = true;
  await message.locator('.media').nth(1).scrollIntoViewIfNeeded();
  await expect
    .poll(() => message.locator('video').evaluate((el: HTMLVideoElement) => el.readyState))
    .toBeGreaterThanOrEqual(1);
  await message.locator('video').evaluate((el: HTMLVideoElement) => {
    el.currentTime = 0.5;
  });
  await expect.poll(() => videoGrants).toBe(2);
  await expect
    .poll(() => message.locator('video').evaluate((el: HTMLVideoElement) => el.currentTime))
    .toBeCloseTo(0.5, 1);
  report.checks.expiredVideoLinkRenews = true;
  report.checks.videoMetadataAndSeeking = true;
  await message.locator('video').evaluate((el) => {
    (el as any).__renderIdentity = 'retained';
  });
  native.current = structuredClone(native.current);
  native.current.turnHistory.history.entitiesByKey.one.items[0].text += '\n\n追加内容不应重建播放器。';
  native.revision++;
  native.snapshot();
  await expect(message).toContainText('追加内容不应重建播放器');
  expect(await message.locator('video').evaluate((el) => (el as any).__renderIdentity)).toBe('retained');
  report.checks.incrementalTextPreservesPlayer = true;
  await message.locator('.media').nth(2).scrollIntoViewIfNeeded();
  await expect(message.locator('audio')).toHaveCount(1);
  await message.locator('audio').evaluate((el: HTMLAudioElement) => {
    el.load();
  });
  await expect
    .poll(() => message.locator('audio').evaluate((el: HTMLAudioElement) => el.readyState))
    .toBeGreaterThanOrEqual(1);
  report.checks.audio = true;
  // The alt label is not textContent; select the generated image by its accessible name instead.
  await page.locator('.media').nth(3).scrollIntoViewIfNeeded();
  const inlineImage = page.getByRole('img', { name: '会话附件', exact: true });
  await inlineImage.scrollIntoViewIfNeeded();
  await expect.poll(() => inlineImage.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  report.checks.nativeInlineImage = true;
  await page.locator('.media').nth(4).scrollIntoViewIfNeeded();
  const inlineAudio = page.locator('audio[aria-label="会话附件"]');
  await inlineAudio.scrollIntoViewIfNeeded();
  await inlineAudio.evaluate((el: HTMLAudioElement) => el.load());
  await expect
    .poll(() => inlineAudio.evaluate((el: HTMLAudioElement) => el.readyState))
    .toBeGreaterThanOrEqual(1);
  report.checks.nativeInlineAudio = true;
  const viewedImage = page.getByRole('img', { name: '查看的图片', exact: true });
  const viewedGroup = page.locator('.activity-group').last();
  await expect(viewedGroup.locator(':scope > summary')).toHaveText('查看 2 项工具活动');
  await expect(viewedImage).toHaveCount(0);
  report.checks.viewedImageInitiallyCollapsed = true;
  const viewedGrants = () => mediaPaths.filter((path) => decodeURIComponent(path) === externalPicture).length;
  report.checks.viewedImageDoesNotLoadBeforeExpansion = viewedGrants() === 0;
  await viewedGroup.locator(':scope > summary').click();
  await viewedImage.scrollIntoViewIfNeeded();
  await expect.poll(() => viewedImage.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  report.checks.nativeViewedImageVisibleAfterExpansion = true;
  report.checks.viewedImageUsesAuthorizedMedia = viewedGrants() === 1;
  report.checks.viewedImageSharesExistingToolGroup = await viewedImage.evaluate(
    (el) => !!el.closest('.activity-group'),
  );
  await viewedGroup.locator(':scope > summary').click();
  await expect(viewedGroup.locator('img')).toBeHidden();
  await viewedGroup.locator(':scope > summary').click();
  await expect(viewedImage).toBeVisible();
  report.checks.viewedImageReopenReusesLoadedMedia = viewedGrants() === 1;
  await expect(page.locator('.message.tool').filter({ hasText: 'imageView' })).toHaveCount(0);
  report.checks.noScriptExecution = await page.evaluate(
    () => !(window as any).__unsafeExecuted && !document.querySelector('a[href^="javascript:"]'),
  );
  report.checks.noHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
  await message.locator('.diagram').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'rich-content.png') });
  native.current.turnHistory.history.entitiesByKey.one.items = [
    {
      type: 'agentMessage',
      id: 'outside-media',
      text: `![下载图片](<${externalPicture}>)\n\n![网页图片](https://images.example.test/picture.png)`,
    },
  ];
  native.revision++;
  native.snapshot();
  const downloaded = page.getByRole('img', { name: '下载图片', exact: true });
  await downloaded.scrollIntoViewIfNeeded();
  await expect.poll(() => downloaded.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  report.checks.outsideWorkspaceSpacedImage = true;
  await page.getByRole('img', { name: '网页图片', exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: '重新加载附件' }).click();
  await expect
    .poll(() =>
      page
        .getByRole('img', { name: '网页图片', exact: true })
        .evaluate((el: HTMLImageElement) => el.naturalWidth),
    )
    .toBeGreaterThan(0);
  report.checks.remoteImageRetry = externalAttempts === 2;
  native.current.turnHistory.history.entitiesByKey.one.items[0].text = `![下载图片](<${externalPicture}>)\n\n![网页图片](https://images.example.test/updated.png)`;
  native.revision++;
  native.snapshot();
  await expect(page.getByRole('img', { name: '网页图片', exact: true })).toHaveAttribute(
    'src',
    'https://images.example.test/updated.png',
  );
  report.checks.remoteSourceUpdates = true;
  report.checks.remoteBypassesGateway = !mediaPaths.some((path) => path.startsWith('https:'));
  const unauthorized = await page.request.post(c.origin + `/api/threads/${THREAD}/media`, {
    headers: { Origin: c.origin },
    data: { path: join(externalDirectory, 'unmentioned.txt') },
  });
  report.checks.unmentionedLocalFileRejected = unauthorized.status() === 403;
  native.current.turnHistory.history.entitiesByKey.one.items = [
    { type: 'agentMessage', id: 'long-fixture', text: '长内容 '.repeat(25010) + 'END_OF_FULL_CONTENT' },
  ];
  native.revision++;
  native.snapshot();
  await page.getByRole('button', { name: '展开完整内容', exact: true }).click();
  await expect(page.locator('.message.assistant .message-text')).toContainText('END_OF_FULL_CONTENT');
  report.checks.longContentExpansion = true;
  native.current.turnHistory.history.entitiesByKey.one.items.push({
    type: 'fileChange',
    id: 'diff-fixture',
    status: 'completed',
    changes: [{ path: '/test/example.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' }],
  });
  native.revision++;
  native.snapshot();
  await page.locator('.activity-group > summary').last().click();
  await page
    .locator('.activity-group')
    .last()
    .getByRole('button', { name: '展开活动详情', exact: true })
    .last()
    .click();
  await page.locator('.diff-file summary').click();
  await expect(page.locator('.diff-add')).toHaveText('+new');
  await expect(page.locator('.diff-remove')).toHaveText('-old');
  report.checks.diffRendering = true;
  const originalRequest = native.request;
  native.request = async (method, params, version, target) => {
    if (method.startsWith('thread-follower-') && method.includes('response')) {
      native.calls.push({ method, params, version, target });
      native.current.requests = [];
      native.revision++;
      native.snapshot();
      return { result: { ok: true } };
    }
    return originalRequest(method, params, version, target);
  };
  native.current.requests = [
    {
      id: 41,
      method: 'item/permissions/requestApproval',
      params: {
        turnId: null,
        permissions: { fileSystem: { read: ['/test/first', '/test/second'] }, network: { enabled: true } },
        reason: '只授予选中的路径',
      },
    },
  ];
  native.revision++;
  native.snapshot();
  const permissionCard = page.locator('[data-request-kind=permissions]');
  await permissionCard.locator('input[type=checkbox]').nth(1).check();
  await permissionCard.getByRole('button', { name: '授予所选权限', exact: true }).click();
  await expect(permissionCard).toHaveCount(0);
  const permissionCall = native.calls.findLast(
    (c) => c.method === 'thread-follower-permissions-request-approval-response',
  );
  report.checks.permissionSubset =
    JSON.stringify(permissionCall.params.response) ===
    '{"permissions":{"fileSystem":{"read":["/test/first"]}},"scope":"turn"}';
  native.current.requests = [
    {
      id: 42,
      method: 'mcpServer/elicitation/request',
      params: {
        turnId: null,
        serverName: 'Fixture',
        mode: 'form',
        message: '填写连接器表单',
        requestedSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'confirmed'],
          properties: {
            label: { type: 'string', title: '名称', minLength: 1 },
            confirmed: { type: 'boolean', title: '已确认' },
          },
        },
      },
    },
  ];
  native.revision++;
  native.snapshot();
  const formCard = page.locator('[data-request-kind=elicitation]');
  await formCard.getByLabel('名称', { exact: true }).fill('Phone form');
  await formCard.getByLabel('已确认', { exact: true }).selectOption('false');
  await formCard.getByRole('button', { name: '提交表单', exact: true }).click();
  await expect(formCard).toHaveCount(0);
  const formCall = native.calls.findLast(
    (c) => c.method === 'thread-follower-submit-mcp-server-elicitation-response',
  );
  report.checks.schemaForm =
    JSON.stringify(formCall.params.response) ===
    '{"action":"accept","content":{"label":"Phone form","confirmed":false}}';
  await page.getByLabel('添加附件').setInputFiles({
    name: 'fixture.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Attachment from phone'),
  });
  await expect(page.locator('.upload-chip')).toContainText('fixture.txt');
  await page.getByLabel('消息', { exact: true }).fill('Read attached file');
  await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
  await expect
    .poll(() =>
      native.calls.some(
        (c) =>
          c.method === 'thread-follower-start-turn' &&
          c.params.turnStart.request.input[0].text.includes('fixture.txt'),
      ),
    )
    .toBe(true);
  report.checks.uploadSentThroughNativeInput = true;
  native.current.threadRuntimeStatus = { type: 'active' };
  native.current.turnHistory.history.entitiesByKey.one.status = 'inProgress';
  native.revision++;
  native.snapshot();
  native.emit('broadcast', {
    method: 'thread-queued-followups-changed',
    version: 2,
    sourceClientId: native.owner,
    params: {
      hostId: 'local',
      conversationId: THREAD,
      messages: [{ id: 'fixture-queue', text: '排队下一轮测试消息', submission: { status: 'queued' } }],
    },
  });
  await expect(page.getByRole('button', { name: '排队下一轮', exact: true })).toHaveCount(0);
  await expect(page.locator('.running-actions')).toHaveCount(0);
  await page.getByRole('button', { name: '会话工具', exact: true }).click();
  await expect(page.getByText('排队下一轮测试消息', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭会话工具' }).click();
  report.checks.queueNoHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
  await page.screenshot({ path: resolve(output, 'phase2-mobile.png'), fullPage: true });
  report.checks.installManifest =
    (await (await page.request.get(c.origin + '/manifest.webmanifest')).json()).display === 'standalone';
  report.checks.noBrowserErrors = report.errors.length === 0;
  report.passed = Object.values(report.checks).every(Boolean);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.passed = false;
  report.error = (error as Error).message;
  process.exitCode = 1;
} finally {
  await browser.close();
  await app.close();
  desktop.stop();
  history.close();
  store.close();
  await rm(externalDirectory, { recursive: true, force: true });
  await rm(c.desktopRoot, { recursive: true, force: true });
  await writeFile(resolve(output, 'content-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
