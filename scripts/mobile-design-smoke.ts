import { privateOutput } from './private-output.js';
await privateOutput('.test-output');
/** Visual and interaction QA against isolated Desktop fixtures, never a real chat. */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:net';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixtureConfig, historyFixture, FakeTransport, THREAD, state } from '../test/helpers.js';
import { Store } from '../src/server/store.js';
import { HistoryIndex } from '../src/server/history.js';
import { DesktopAdapter } from '../src/server/desktop.js';
import { buildGateway } from '../test/legacy/gateway.js';
const c = fixtureConfig();
await writeFile(historyFixture(c), '');
const db = new DatabaseSync(join(c.codexHome, 'state_5.sqlite'));
db.prepare('UPDATE threads SET title=?, cwd=?').run('开发示例应用', '/fixture/Example-App');
db.prepare('INSERT INTO projects VALUES (?,?,?)').run(
  '11111111-1111-4111-8111-111111111111',
  'Example-App',
  0,
);
db.prepare('UPDATE threads SET project_id=?').run('11111111-1111-4111-8111-111111111111');
db.close();
const native = new FakeTransport();
native.current = state({
  title: '开发示例应用',
  latestModel: 'gpt-6-astra',
  latestReasoningEffort: 'high',
});
const turn = native.current.turnHistory.history.entitiesByKey.one;
turn.items = [
  {
    type: 'userMessage',
    id: 'design-user',
    content: [{ type: 'text', text: '给示例应用添加搜索功能，并补充测试。' }],
  },
  {
    type: 'agentMessage',
    id: 'design-answer',
    text: '搜索功能已完成，可以开始检查：\n\n- **搜索**：按关键词查找结果\n- **筛选**：按分类缩小范围\n- **测试**：覆盖空结果与输入清除\n\n- [x] 通过基础交互测试',
  },
  ...[1, 2, 3].map((n) => ({
    type: 'commandExecution',
    id: `tool-${n}`,
    command: `echo fixture-${n}`,
    status: 'completed',
    aggregatedOutput: `fixture-${n}`,
  })),
  {
    type: 'agentMessage',
    id: 'design-question',
    text: '',
    questions: [
      { title: '先检查哪个部分？', options: ['搜索与筛选', '结果展示'] },
      { title: '还有什么需要调整？' },
    ],
  },
];
const socket = createServer();
await new Promise<void>((r) => socket.listen(0, '127.0.0.1', r));
c.port = (socket.address() as any).port;
await new Promise<void>((r) => socket.close(() => r()));
c.origin = `http://127.0.0.1:${c.port}`;
c.webRoot = resolve(process.env.POCKET_TEST_WEB_ROOT ?? '.test-output/mobile-web');
c.p2p = { enabled: false, stunUrls: [] };
const store = new Store(c.stateDir),
  history = new HistoryIndex(c.codexHome),
  desktop = new DesktopAdapter(c, () => native);
await desktop.start();
const originalStatus = desktop.status.bind(desktop);
desktop.status = () => {
  const status = originalStatus();
  return { ...status, capabilities: { ...status.capabilities, newThread: true } };
};
const app = await buildGateway(c, { store, history, desktop });
await app.listen({ host: '127.0.0.1', port: c.port });
const browser = await chromium.launch({ channel: process.env.POCKET_BROWSER_CHANNEL ?? 'chrome' });
const context = await browser.newContext({ viewport: { width: 390, height: 964 }, isMobile: true });
const page = await context.newPage();
const output = resolve(process.env.POCKET_TEST_OUTPUT ?? '/tmp/pocket-v2-design');
await privateOutput(output);
const report: any = { fixture: true, checks: {}, errors: [], measurements: {} };
page.on('pageerror', (e) => report.errors.push(e.message));
try {
  await page.goto(c.origin);
  await page.getByLabel('一次性配对码').fill(store.mintPairing().code);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  await expect(page.getByRole('heading', { name: '会话', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 845 });
  await page.screenshot({ path: join(output, 'list.png') });
  await page.getByRole('button', { name: '开发示例应用', exact: false }).click();
  await page.setViewportSize({ width: 390, height: 964 });
  await expect(page.locator('.question-card')).toBeVisible();
  await expect(page.locator('.activity-group')).toHaveCount(1);
  await expect(page.locator('.contains-task-list')).toBeVisible();
  await page.getByRole('button', { name: '加载更早的记录', exact: true }).click();
  await expect(page.getByRole('button', { name: '加载更早的记录', exact: true })).toHaveCount(0);
  await page.locator('.transcript').evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: join(output, 'chat.png') });
  report.checks.toolsInitiallyCollapsed = !(await page.locator('.activity-group').getAttribute('open'));
  await page.locator('.activity-group > summary').click();
  await expect(page.getByText('fixture-1', { exact: false }).first()).toBeVisible();
  await page.locator('.activity-group > summary').click();
  report.checks.toolsExpand = true;
  await page.getByRole('button', { name: '回答问题（2 题）' }).click();
  await page.getByRole('radio', { name: '搜索与筛选', exact: true }).check();
  await page.screenshot({ path: join(output, 'answer.png') });
  await page.getByLabel('收起答题面板').click();
  await page.getByRole('button', { name: '会话工具', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '会话工具' })).toBeVisible();
  await page
    .getByRole('dialog', { name: '会话工具', exact: true })
    .getByRole('button', { name: '模型设置', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '选择模型' })).toBeVisible();
  await page.getByLabel('关闭模型设置').click();
  await page.getByRole('button', { name: '会话工具', exact: true }).click();
  await expect(page.getByRole('button', { name: '新建会话', exact: true })).toBeVisible();
  report.checks.modelAndCreateReachable = true;
  await page.screenshot({ path: join(output, 'tools.png') });
  await page.getByLabel('关闭会话工具').click();
  await page.getByRole('button', { name: '继续回答（2 题）' }).click();
  await expect(page.getByRole('radio', { name: '搜索与筛选', exact: true })).toBeChecked();
  await page.getByLabel('收起答题面板').click();
  report.checks.questionDraftRetained = true;
  for (const [width, height] of [
    [390, 844],
    [360, 740],
    [390, 430],
    [1280, 800],
  ]) {
    await page.setViewportSize({ width, height });
    await page.getByLabel('消息', { exact: true }).fill('第一行\n第二行\n第三行');
    const box = await page.getByRole('button', { name: '发送 ↑', exact: true }).boundingBox();
    report.checks[`sendVisible${width}x${height}`] = !!box && box.y + box.height <= height;
    await page.getByLabel('消息', { exact: true }).fill('');
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('');
    const sizes = await page.evaluate(() => ({
      composer: document.querySelector('.composer')!.getBoundingClientRect().height,
      transcript: document.querySelector('.transcript')!.getBoundingClientRect().height,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    report.measurements[`${width}x${height}`] = sizes;
    report.checks[`layout${width}x${height}`] = !sizes.overflow && sizes.composer < 210;
    if (width === 390 && height === 844) {
      await page.locator('.transcript').evaluate((el) => (el.scrollTop = 0));
      await page.screenshot({ path: join(output, 'chat-844.png') });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  native.current.threadRuntimeStatus = { type: 'active' };
  turn.status = 'inProgress';
  native.revision++;
  native.snapshot();
  await expect(page.getByRole('button', { name: '中断任务', exact: true })).toBeVisible();
  await expect(page.locator('.running-actions')).toHaveCount(0);
  await page.getByLabel('消息', { exact: true }).fill('运行中继续补充');
  await expect(page.getByRole('button', { name: '追加指令 ↑', exact: true })).toBeVisible();
  await page.getByLabel('消息', { exact: true }).fill('');
  report.checks.runningControlsReachable = true;
  await page.screenshot({ path: join(output, 'running.png') });
  c.readOnly = true;
  desktop.emit('status', desktop.status());
  native.revision++;
  native.snapshot();
  await expect(page.locator('.connection-note')).toBeVisible();
  await expect(page.locator('.connection-note')).toContainText('当前连接仅允许查看');
  await expect(page.getByLabel('消息', { exact: true })).toBeDisabled();
  report.checks.readOnlyReasonVisible = true;
  report.checks.noBrowserErrors = report.errors.length === 0;
  report.passed = Object.values(report.checks).every(Boolean);
  if (!report.passed) process.exitCode = 1;
} catch (e) {
  report.passed = false;
  report.error = String(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  await app.close();
  desktop.stop();
  history.close();
  store.close();
  await rm(c.desktopRoot, { recursive: true, force: true });
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
