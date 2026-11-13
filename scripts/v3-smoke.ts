/** Frontend regression on an isolated simulated desktop; never approves a real task. */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, host, store, native, close } from './v2-fixture.js';
import { THREAD, TURN } from '../test/helpers.js';
import { saveRecoveryCode } from './lib/messaging-smoke.js';
import { mathCopyFixture, verifyMathCopy } from './lib/math-copy-smoke.js';
import sharp from 'sharp';
const report: any = { fixture: true, checks: {}, errors: [], physicalPhone: false };
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : { channel: 'chrome' }),
  args: [`--unsafely-treat-insecure-origin-as-secure=${config.origin}`],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
await context.addInitScript(() => {
  const PC = window.RTCPeerConnection;
  (window as any).__peers = [];
  window.RTCPeerConnection = class extends PC {
    constructor(config?: RTCConfiguration) {
      super(config);
      (window as any).__peers.push(this);
    }
  };
});
const page = await context.newPage();
page.on('pageerror', (e) => report.errors.push(e.message));
await mkdir('.test-output/v3', { recursive: true });
async function screenshot(name: string) {
  await page.screenshot({ path: `.test-output/v3/${name}.png` });
}
async function tab(name: string) {
  await page.getByRole('navigation', { name: '主要功能' }).getByRole('button', { name, exact: true }).click();
}
async function openChat() {
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  await page.getByRole('button', { name: /测试会话/ }).click();
  await expect(page.getByRole('heading', { name: /测试会话/ })).toBeVisible();
}
try {
  await page.goto(`${config.origin}/?page=messages`);
  await page.getByLabel('昵称', { exact: true }).fill('测试账户');
  await page.getByLabel('用户名', { exact: true }).fill('frontend-fixture');
  await page.getByLabel('密码', { exact: true }).fill('frontend-fixture-password');
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await saveRecoveryCode(page);
  await expect(page.getByText('还没有聊天记录')).toBeVisible();
  const pair = store.mintPairing();
  await page.goto(`${config.origin}/#pair=${pair.code}&host=${host.identity.peerId}`);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '主要功能' })).toBeVisible();
  await expect(page.locator('.device-bar')).toHaveCount(0);
  await expect(page.getByText('清理缓存')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '添加电脑' })).toHaveCount(0);
  await screenshot('workbench');
  report.checks.quietWorkbench = true;
  await openChat();
  await expect(page.getByLabel('消息', { exact: true })).toBeEnabled({ timeout: 20000 });
  const fixtureTurn = native.current.turnHistory.history.entitiesByKey.one;
  fixtureTurn.status = 'inProgress';
  fixtureTurn.startedAt = Math.floor(Date.now() / 1000) - 10;
  native.revision++;
  native.snapshot();
  const timer = page.locator('.turn-timing');
  await expect(timer).toHaveText(/^已工作/);
  const initialElapsed = await timer.innerText();
  await expect(timer).not.toHaveText(initialElapsed);
  fixtureTurn.status = 'completed';
  fixtureTurn.durationMs = 1_056_000;
  const fixtureItems = fixtureTurn.items;
  const compaction = { type: 'contextCompaction', id: 'compact-fixture', status: 'inProgress', trigger: 'automatic' };
  fixtureItems.push(
    { type: 'subAgentActivity', id: 'repair-ui-started', kind: 'started', agentThreadId: 'repair-ui', agentPath: '/root/separate_plugin' },
    { type: 'subAgentActivity', id: 'repair-qa-started', kind: 'started', agentThreadId: 'repair-qa', agentPath: '/root/reader_layout' },
    { type: 'subAgentActivity', id: 'layout-verify-started', kind: 'started', agentThreadId: 'layout-verify', agentPath: '/root/layout_verify' },
    { type: 'commandExecution', id: 'repair-tool', status: 'completed', command: 'printf fixture' },
    compaction,
  );
  native.revision++;
  native.snapshot();
  const startedAgents = page.locator('.transcript-notice').filter({ hasText: 'Separate plugin、Reader layout、Layout verify 开始工作' });
  await expect(startedAgents).toBeVisible();
  await expect(startedAgents.locator('.subagent-icon')).toHaveCount(3);
  await expect(startedAgents.locator('.subagent-icon-0')).toHaveCount(1);
  await expect(startedAgents.locator('.subagent-icon-1')).toHaveCount(1);
  await expect(page.getByText('本轮用时 17 分 36 秒', { exact: true })).toBeAttached();
  const tools = page.locator('.activity-group-inline').filter({ hasText: '查看 1 项工具活动' });
  await expect(tools).toBeVisible();
  await tools.locator('summary').click();
  await expect(tools.getByText(/printf fixture/)).toBeVisible();
  await tools.locator('summary').click();
  await expect(page.getByRole('status').filter({ hasText: '正在压缩上下文' })).toBeVisible();
  compaction.status = 'completed';
  fixtureItems.push({
    type: 'subAgentActivity', id: 'repair-qa-completed', kind: 'completed', agentThreadId: 'repair-qa', agentPath: '/root/reader_layout',
  });
  native.revision++;
  native.snapshot();
  await expect(page.getByRole('status').filter({ hasText: '已自动压缩上下文' })).toHaveCount(1);
  await expect(page.getByText('正在压缩上下文', { exact: true })).toHaveCount(0);
  await expect(page.locator('.transcript-notice').filter({ hasText: 'Reader layout 已完成' })).toBeVisible();
  await screenshot('codex-timeline-events-mobile');
  report.checks.codexTimelineEvents = true;
  native.current.turnHistory.history.entitiesByKey.one.items.push({
    type: 'agentMessage',
    id: 'math-copy-fixture',
    text: mathCopyFixture,
  });
  native.revision++;
  native.snapshot();
  await page.setViewportSize({ width: 1440, height: 900 });
  await verifyMathCopy(page, page.locator('.message.assistant').filter({ hasText: '起始 前文' }));
  const images = await Promise.all(
    ['#246f5c', '#5971a0', '#ab763e', '#8a5b74', '#285d77'].map(async (background, index) => {
      const png = await sharp({
        create: { width: index % 2 ? 200 : 640, height: index % 2 ? 640 : 220, channels: 3, background },
      })
        .png()
        .toBuffer();
      return { type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}` };
    }),
  );
  native.current.turnHistory.history.entitiesByKey.one.items.push({
    type: 'userMessage',
    id: 'media-gallery-fixture',
    content: [{ type: 'text', text: '比较这些参考图片' }, ...images],
  });
  native.revision++;
  native.snapshot();
  const galleryMessage = page.locator('[data-user-turn="media-gallery-fixture"]');
  await expect(galleryMessage.getByText('比较这些参考图片')).toBeVisible();
  const thumbnails = galleryMessage.locator('.attachment-gallery .image-thumbnail');
  await expect(thumbnails).toHaveCount(5);
  expect(
    await thumbnails.evaluateAll(
      (elements) => new Set(elements.map((el) => el.getBoundingClientRect().y)).size,
    ),
  ).toBe(1);
  await galleryMessage.screenshot({ path: '.test-output/v3/desktop-attachment-gallery.png' });
  await thumbnails.first().click();
  await expect(page.getByRole('button', { name: '关闭图片预览' })).toBeVisible();
  await page.getByRole('button', { name: '关闭图片预览' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      thumbnails.evaluateAll((elements) => new Set(elements.map((el) => el.getBoundingClientRect().y)).size),
    )
    .toBeGreaterThan(1);
  // Let lazy thumbnails finish sizing before measuring the transcript scroll offset.
  await expect
    .poll(() => thumbnails.locator('img').evaluateAll((images) =>
      images.filter((image) => (image as HTMLImageElement).naturalWidth > 0).length,
    ))
    .toBe(5);
  await galleryMessage.screenshot({ path: '.test-output/v3/mobile-attachment-gallery.png' });
  const transcript = page.getByRole('region', { name: '聊天记录' });
  const composer = page.getByLabel('消息', { exact: true });
  const bottomGap = () => transcript.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  native.current.turnHistory.history.entitiesByKey.one.items.push({
    type: 'agentMessage',
    id: 'mobile-scroll-fixture',
    text: `手机滚动测试\n\n${'这一段用于让聊天记录超过可视高度。\n\n'.repeat(40)}`,
  });
  native.revision++;
  native.snapshot();
  await expect(transcript.getByText('手机滚动测试')).toBeAttached();
  await transcript.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(bottomGap).toBeLessThan(2);
  await composer.focus();
  await page.setViewportSize({ width: 390, height: 500 });
  await composer.fill('手机输入测试\n第二行\n第三行\n第四行');
  await expect.poll(bottomGap).toBeLessThan(2);
  await transcript.evaluate((el) => {
    el.scrollTop -= 600;
  });
  await expect.poll(bottomGap).toBeGreaterThan(500);
  const readingTop = await transcript.evaluate((el) => el.scrollTop);
  await composer.fill('仍在查看较早消息');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(readingTop);
  await composer.fill('');
  report.checks.mobileComposerScroll = true;
  report.checks.imageGallery = true;
  const linkedImage = join(config.desktopRoot, 'desktop-preview.png');
  await writeFile(linkedImage, Buffer.from(images[0].image_url.split(',')[1], 'base64'));
  native.current.turnHistory.history.entitiesByKey.one.items.push({
    type: 'agentMessage',
    id: 'linked-image-fixture',
    text: `可以查看 [桌面预览](<${linkedImage}>)。\n\n[单独展示的图片](<${linkedImage}>)`,
  });
  native.revision++;
  native.snapshot();
  const imageLink = page.getByRole('button', { name: '桌面预览', exact: true });
  await imageLink.click();
  const linkedPreview = page.getByRole('dialog', { name: 'desktop-preview.png', exact: true });
  await expect(linkedPreview.getByRole('img')).toBeVisible();
  await linkedPreview.getByRole('img').evaluate((element: HTMLImageElement) => element.decode());
  await page.keyboard.press('Escape');
  await expect(imageLink).toBeFocused();
  const linkedThumbnail = page.getByRole('button', { name: '放大预览：单独展示的图片', exact: true });
  await expect(linkedThumbnail.getByRole('img')).toBeVisible();
  await linkedThumbnail.getByRole('img').evaluate((element: HTMLImageElement) => element.decode());
  report.checks.imageLinks = true;
  report.checks.mathCopy = true;
  await page.getByLabel('消息', { exact: true }).fill('draft-kept-between-modules');
  expect(new URL(page.url()).searchParams.get('host')).toBe(host.identity.peerId);
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as any).__peers.some((p: RTCPeerConnection) => p.connectionState === 'connected'),
        ),
      { timeout: 20000 },
    )
    .toBe(true);
  const peerCount = await page.evaluate(() => (window as any).__peers.length);
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await tab('消息');
  await expect(page.getByText('还没有聊天记录')).toBeVisible();
  await screenshot('messages');
  await tab('联系人');
  await page
    .getByRole('button', { name: '接入 Agent', exact: true })
    .filter({ hasText: '连接你的智能助手' })
    .click();
  await expect(page.getByText('让你的 Agent 加入聊天')).toBeVisible();
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await tab('我的');
  await screenshot('me');
  await expect(page.getByText(/\d+(\.\d+)? (MB|MiB|GB)/)).toHaveCount(0);
  await page.getByRole('button', { name: /个人资料/ }).click();
  await page.getByLabel('昵称').fill('测试用户');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page.getByRole('button', { name: /测试用户.*个人资料/ })).toBeVisible();
  report.checks.accountProfileAndMessagingNavigation = true;
  await tab('工作台');
  await page.getByRole('button', { name: '打开 Codex', exact: true }).click();
  await openChat();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('draft-kept-between-modules');
  expect(await page.evaluate(() => (window as any).__peers.length)).toBe(peerCount);
  report.checks.moduleSwitchKeepsDraftAndConnection = true;
  await page.reload();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('draft-kept-between-modules');
  await expect(page.locator('.chat-head .dot')).toHaveClass(/online/, { timeout: 20000 });
  report.checks.refreshRestoresHostScopedChat = true;
  // Existing content above the old app budget must survive subsequent normal writes.
  await page.evaluate(async () => {
    const q = indexedDB.open('pocket-device-v2');
    const db = await new Promise<IDBDatabase>((resolve) => (q.onsuccess = () => resolve(q.result)));
    const tx = db.transaction('content', 'readwrite');
    tx.objectStore('content').put({
      key: 'qa-large-existing',
      value: 'retained',
      size: 320 * 1024 ** 2,
      touched: 1,
      kind: 'text',
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  native.current.turnHistory.history.entitiesByKey.one.items.push({
    type: 'agentMessage',
    id: 'normal-update',
    text: 'New content after large cache',
  });
  native.revision++;
  native.snapshot();
  await expect(page.getByText('New content after large cache', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await tab('我的');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('button', { name: /清理缓存/ })).toContainText(/320\./);
  await screenshot('settings');
  report.checks.noAppCacheBudgetOrEviction = true;
  const privateBefore = await page.evaluate(async () => {
    const q = indexedDB.open('pocket-device-v2');
    const db = await new Promise<IDBDatabase>((resolve) => (q.onsuccess = () => resolve(q.result)));
    const r = db.transaction('private').objectStore('private').getAll();
    const values = await new Promise<any[]>((resolve) => (r.onsuccess = () => resolve(r.result)));
    db.close();
    localStorage.setItem('pocket-pending:qa-protected', 'pending-id-only');
    return JSON.stringify(values);
  });
  await page.getByRole('button', { name: /清理缓存/ }).click();
  await expect(page.getByRole('status')).toContainText('缓存已清理');
  await expect(page.getByRole('button', { name: /清理缓存/ })).toContainText('0 KB');
  expect(
    await page.evaluate(async () => {
      const q = indexedDB.open('pocket-device-v2');
      const db = await new Promise<IDBDatabase>((resolve) => (q.onsuccess = () => resolve(q.result)));
      const r = db.transaction('private').objectStore('private').getAll();
      const values = await new Promise<any[]>((resolve) => (r.onsuccess = () => resolve(r.result)));
      db.close();
      return JSON.stringify(values);
    }),
  ).toBe(privateBefore);
  expect(await page.evaluate(() => localStorage.getItem('pocket-pending:qa-protected'))).toBe(
    'pending-id-only',
  );
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await tab('工作台');
  await page.getByRole('button', { name: '打开 Codex', exact: true }).click();
  await openChat();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('draft-kept-between-modules');
  report.checks.clearOnlyContentPreservesIdentityDraftsAndOperations = true;
  // Browser storage exhaustion is not an application-level eviction or live-chat failure.
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    (window as any).__restorePut = () => (IDBObjectStore.prototype.put = original);
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'content') throw new DOMException('Simulated full disk', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  native.current.turnHistory.history.entitiesByKey.one.items.push({
    type: 'agentMessage',
    id: 'quota-update',
    text: 'Live chat still works with full cache',
  });
  native.revision++;
  native.snapshot();
  await expect(page.getByText('Live chat still works with full cache', { exact: true })).toBeVisible();
  await page.waitForTimeout(800); // Deliberately cross the coalesced cache write timer.
  await page.evaluate(() => (window as any).__restorePut());
  report.checks.storageWriteFailureKeepsLiveChat = report.errors.length === 0;
  const plan = {
    id: `implement-plan:${TURN}`,
    method: 'item/plan/requestImplementation',
    params: {
      threadId: THREAD,
      turnId: TURN,
      planContent: '# 实施计划\n\n1. 复用现有输入框。\n2. 增加模块导航。\n3. 检查草稿保留。',
    },
  };
  native.current.requests = [plan];
  native.revision++;
  native.snapshot();
  await expect(page.getByRole('button', { name: '批准并执行' })).toBeEnabled();
  await page.locator('.plan-request').scrollIntoViewIfNeeded();
  await expect(page.locator('.plan-content').getByRole('heading', { name: '实施计划' })).toBeVisible();
  await screenshot('plan');
  await page.getByRole('button', { name: '提出修改' }).click();
  await page.locator('.plan-request').getByLabel('消息', { exact: true }).fill('保留所有原有输入能力');
  await expect(page.getByRole('button', { name: '批准并执行' })).toBeDisabled();
  await page.locator('.plan-request').getByRole('button', { name: '发送 ↑', exact: true }).click();
  await expect
    .poll(
      () =>
        native.calls.filter((c) => c.method === 'thread-follower-start-turn').at(-1)?.params.turnStart.request
          .collaborationMode.mode,
    )
    .toBe('plan');
  expect(
    native.calls.filter((c) => c.method === 'thread-follower-start-turn').at(-1).params.turnStart.request
      .input[0].text,
  ).toBe('保留所有原有输入能力');
  report.checks.planRevisionUsesSharedComposerAndNativePlanMode = true;
  native.current.requests = [];
  native.revision++;
  native.snapshot();
  await expect(page.locator('.plan-request')).toHaveCount(0);
  native.current.requests = [
    { ...plan, params: { ...plan.params, planContent: plan.params.planContent + '\n4. 回归测试。' } },
  ];
  native.revision++;
  native.snapshot();
  await page.getByRole('button', { name: '批准并执行' }).click();
  await expect
    .poll(
      () =>
        native.calls.filter((c) => c.method === 'thread-follower-start-turn').at(-1)?.params.turnStart.request
          .collaborationMode.mode,
    )
    .toBe('default');
  const approved = native.calls.filter((c) => c.method === 'thread-follower-start-turn').at(-1).params
    .turnStart.request;
  expect(approved.input[0].text).toBe(
    'PLEASE IMPLEMENT THIS PLAN:\n' + native.current.requests[0].params.planContent,
  );
  expect(approved.clientUserMessageId).toMatch(/^[a-f0-9-]{36}$/);
  await expect(page.getByRole('button', { name: '批准并执行' })).toBeDisabled();
  report.checks.planApprovalUsesBoundPlanAndOperationId = true;
  native.current.requests = [];
  native.revision++;
  native.snapshot();
  await expect(page.locator('.plan-request')).toHaveCount(0);
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await screenshot('desktop');
  report.checks.responsiveNoHorizontalOverflow = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await tab('我的');
  let downloadRequests = 0;
  await page.route('**/downloads/desktop/native/rust/linux/x64/latest.json', (route) => {
    if (++downloadRequests === 1) return route.fulfill({ status: 503 });
    return route.fulfill({ status: 404 });
  });
  await page.getByRole('button', { name: /电脑适配器/ }).click();
  const linuxInstaller = page.locator('.installer-row').filter({ hasText: 'Linux x64（glibc）' });
  await expect(linuxInstaller.getByText('暂时无法验证安装包')).toBeVisible();
  await linuxInstaller.getByRole('button', { name: /^重新检查/ }).click();
  await expect(linuxInstaller.getByText('暂未发布')).toBeVisible();
  expect(downloadRequests).toBe(2);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page.locator('.adapter-downloads')).toHaveCount(0);

  await page.route('**/support.json', (route) =>
    route.fulfill({
      json: {
        platform: { name: '测试平台', url: 'http://example.invalid/', enabled: true },
        wechat: { recipient: '测试账号', qr: '/fixture-qr.png', previewCrop: { x: 0.25, y: 0, size: 0.5 } },
      },
    }),
  );
  await page.route('**/fixture-qr.png*', (route) =>
    new URL(route.request().url()).searchParams.has('retry')
      ? route.fulfill({ path: 'src/web/public/app-icon-32.png' })
      : route.fulfill({ status: 404 }),
  );
  await page.getByRole('button', { name: /支持项目/ }).click();
  await expect(page.getByText('测试平台主页正在准备中。')).toBeVisible();
  await expect(page.getByRole('link', { name: /测试平台/ })).toHaveCount(0);
  await page.getByRole('button', { name: '重新加载赞赏码' }).click();
  const qr = page.getByRole('img', { name: '测试账号的微信赞赏码' });
  await qr.evaluate((image: HTMLImageElement) => image.decode());
  await expect(qr).toHaveClass(/cropped/);
  await page.getByRole('button', { name: '返回', exact: true }).click();

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: /外观/ }).click();
  await page.getByLabel('深色', { exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-color-mode', 'dark');
  const addTheme = page.getByRole('button', { name: '添加深色主题' });
  await addTheme.click();
  const themeEditor = page.getByRole('dialog', { name: '添加主题' });
  await expect(themeEditor).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(themeEditor).toHaveCount(0);
  await expect(addTheme).toBeFocused();
  await addTheme.click();
  await themeEditor.getByLabel('主题名称').fill('测试深色');
  await themeEditor.getByRole('button', { name: '保存主题' }).click();
  await expect(page.getByRole('button', { name: '选择测试深色' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: /外观/ }).click();
  await expect(page.getByLabel('深色', { exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: '选择测试深色' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '删除测试深色' }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByRole('button', { name: '选择测试深色' })).toHaveCount(0);
  report.checks.migratedSettingsRoutes = true;

  report.checks.noUncaughtErrors = report.errors.length === 0;
  report.passed = Object.values(report.checks).every(Boolean);
} catch (e) {
  report.passed = false;
  report.error = (e as Error).message;
  await screenshot('failure').catch(() => {});
} finally {
  await browser.close();
  await close();
  await writeFile('.test-output/v3/results.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
