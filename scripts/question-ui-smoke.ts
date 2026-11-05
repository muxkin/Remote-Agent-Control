import { privateOutput } from './private-output.js';
await privateOutput('.test-output');
/** Isolated UI fixtures for the current web build. Never controls Desktop. */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:net';
import { readFile, writeFile, rm, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fixtureConfig, historyFixture, FakeTransport, THREAD, state } from '../test/helpers.js';
import { DesktopAdapter } from '../src/server/desktop.js';
import { Store } from '../src/server/store.js';
import { HistoryIndex } from '../src/server/history.js';
import { buildGateway } from '../src/server/gateway.js';
const report: any = { checks: {}, errors: [], fixture: true };
const browser = await chromium.launch({ channel: process.env.POCKET_BROWSER_CHANNEL ?? 'chrome' });
async function run(webRoot: string) {
  const c = fixtureConfig();
  historyFixture(c);
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  c.port = (socket.address() as any).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  c.origin = `http://127.0.0.1:${c.port}`;
  c.webRoot = join(c.desktopRoot, 'web');
  await cp(resolve(webRoot), c.webRoot, { recursive: true });
  const originalVersion = await readFile(join(c.webRoot, 'version.json'), 'utf8');
  c.assetOrigin = JSON.parse(await readFile(`${c.webRoot}/asset-origin.json`, 'utf8')).origin;
  c.p2p = { enabled: false, stunUrls: [] };
  const native = new FakeTransport();
  native.current = state();
  const turn = native.current.turnHistory.history.entitiesByKey.one;
  turn.items.push({
    id: 'questions-ui',
    type: 'agentMessage',
    text: '',
    questions: [
      {
        title: '选择工作方式：' + '这是一段用于检查长问题滚动布局的说明。'.repeat(50),
        options: ['方式一', '方式二'],
      },
      { title: '补充备注' },
      { title: '选择最后一项', options: ['默认方案', '备用方案'] },
    ],
  });
  const store = new Store(c.stateDir);
  const desktop = new DesktopAdapter(c, () => native);
  await desktop.start();
  const app = await buildGateway(c, { store, desktop, history: new HistoryIndex(c.codexHome) });
  const actualResponses: any[] = [];
  const original = native.request;
  native.request = async (...args) => {
    const result = await original(...args);
    if (args[0] === 'thread-follower-start-turn') {
      actualResponses.push(args[1].turnStart.request.input);
      turn.items.push({
        type: 'userMessage',
        id: 'fixture-reply',
        clientId: args[1].turnStart.request.clientUserMessageId,
        content: args[1].turnStart.request.input,
      });
      native.revision++;
      native.snapshot();
    } else if (args[0] === 'thread-follower-submit-user-input') {
      actualResponses.push(args[1].response);
      native.current.requests = [];
      native.revision++;
      native.snapshot();
    }
    return result;
  };
  await app.listen({ host: '127.0.0.1', port: c.port });
  const context = await browser.newContext({ viewport: { width: 390, height: 744 }, isMobile: true });
  const page = await context.newPage();
  page.on('pageerror', (error) => report.errors.push(error.message));
  try {
    await page.goto(c.origin);
    await expect(page).toHaveTitle('Codex Pocket Remote');
    await page.getByLabel('一次性配对码').fill(store.mintPairing().code);
    await page.getByRole('button', { name: '连接电脑', exact: true }).click();
    await page.getByRole('tab', { name: '最近', exact: true }).click();
    await page.getByRole('button', { name: '测试会话', exact: false }).click();
    await expect(page.getByRole('status', { name: '网页更新提示' })).toHaveCount(0);
    const card = page.locator('.question-card');
    await card.getByRole('button', { name: '回答问题（3 题）' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '拒绝', exact: true })).toHaveCount(0);
    const visibleAction = async (name: string) => {
      const box = await dialog.getByRole('button', { name, exact: true }).boundingBox();
      return !!box && box.y >= 0 && box.y + box.height <= page.viewportSize()!.height;
    };
    report.checks.longQuestionKeepsActionVisible = await visibleAction('下一题');
    await expect(dialog.getByRole('button', { name: '下一题', exact: true })).toBeDisabled();
    await dialog.getByRole('radio').first().check();
    report.checks.selectionDoesNotSubmit = actualResponses.length === 0;
    await dialog.getByRole('button', { name: '下一题', exact: true }).click();
    await dialog.getByLabel('你的回答', { exact: true }).fill('第二题的多行备注\n保留这一行');
    await dialog.getByLabel('收起答题面板').click();
    const beforeUpdate = await page.evaluate(() => performance.timeOrigin);
    await writeFile(join(c.webRoot, 'version.json'), JSON.stringify({ buildId: 'ffffffffffffffff' }));
    const updateNotice = page.getByRole('status', { name: '网页更新提示' });
    await expect(updateNotice).toBeVisible({ timeout: 20000 });
    await expect(updateNotice.getByRole('button', { name: '刷新页面' })).toBeDisabled();
    report.checks.versionPushWithoutReload =
      beforeUpdate === (await page.evaluate(() => performance.timeOrigin));
    report.checks.answerDraftBlocksReload = true;

    await card.getByRole('button', { name: '继续回答（3 题）' }).click();
    await expect(dialog.getByLabel('你的回答', { exact: true })).toHaveValue('第二题的多行备注\n保留这一行');
    report.checks.collapsePreservesDraftAndStep = true;
    await page.setViewportSize({ width: 390, height: 430 });
    await dialog.getByLabel('你的回答', { exact: true }).focus();
    report.checks.reducedViewportKeepsActionVisible = await visibleAction('下一题');
    await page.screenshot({ path: '/tmp/pocket-question-small-viewport.png' });
    await page.setViewportSize({ width: 390, height: 744 });
    await dialog.getByRole('button', { name: '下一题', exact: true }).click();
    await dialog.getByRole('radio').last().check();
    await dialog.getByLabel('你的回答', { exact: true }).fill('自定义第三项');
    await dialog.getByRole('button', { name: '上一题', exact: true }).click();
    await expect(dialog.getByLabel('你的回答', { exact: true })).toHaveValue('第二题的多行备注\n保留这一行');
    await dialog.getByRole('button', { name: '下一题', exact: true }).click();
    await expect(dialog.getByLabel('你的回答', { exact: true })).toHaveValue('自定义第三项');
    report.checks.previousNextPreserveAnswers = true;
    await dialog.getByRole('button', { name: '核对答案', exact: true }).click();
    await expect(dialog.locator('.answer-review li')).toHaveCount(3);
    await dialog.getByRole('button', { name: '修改第 1 题', exact: true }).click();
    await dialog.getByRole('radio').nth(1).check();
    await dialog.getByRole('button', { name: '下一题', exact: true }).click();
    await dialog.getByRole('button', { name: '下一题', exact: true }).click();
    await dialog.getByRole('button', { name: '核对答案', exact: true }).click();
    await expect(dialog.locator('.answer-review li').first()).toContainText('方式二');
    report.checks.reviewAndEdit = await visibleAction('提交全部回答（3 题）');
    await page.screenshot({ path: '/tmp/pocket-question-review.png' });
    await dialog.getByRole('button', { name: '提交全部回答（3 题）', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toHaveCount(0);
    const text = actualResponses[0][0].text;
    const answers = JSON.parse(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n'))).map(
      (r: any) => r.answer,
    );
    report.checks.allAnswersSubmittedOnce =
      actualResponses.length === 1 &&
      JSON.stringify(answers) === JSON.stringify(['方式二', '第二题的多行备注\n保留这一行', '自定义第三项']);
    // Single blocking question shares the same accessible answer panel and native RPC.
    native.current.requests = [
      {
        id: 123,
        method: 'item/tool/requestUserInput',
        params: {
          turnId: turn.turnId,
          questions: [{ id: 'single', header: '单题', question: '输入一个答案', options: [] }],
        },
      },
    ];
    native.revision++;
    native.snapshot();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('.question-card').getByRole('button', { name: '回答问题', exact: true }).click();
    await page.getByRole('dialog').getByLabel('你的回答', { exact: true }).fill('单题回答');
    await page.getByRole('dialog').getByRole('button', { name: '提交回答', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    report.checks.singleBlockingQuestionDesktop =
      actualResponses[1]?.answers?.single?.answers?.[0] === '单题回答';
    await expect(updateNotice.getByRole('button', { name: '刷新页面' })).toBeEnabled();
    await page.getByLabel('消息', { exact: true }).fill('尚未发送的文字');
    await expect(updateNotice.getByRole('button', { name: '刷新页面' })).toBeDisabled();
    report.checks.messageDraftBlocksReload = true;
    await page.getByLabel('消息', { exact: true }).fill('');
    await expect(updateNotice.getByRole('button', { name: '刷新页面' })).toBeEnabled();
    await writeFile(join(c.webRoot, 'version.json'), originalVersion);
    await updateNotice.getByRole('button', { name: '刷新页面' }).click();
    await expect(page.getByRole('heading', { name: '会话', exact: true })).toBeVisible();
    await expect(page.getByRole('status', { name: '网页更新提示' })).toHaveCount(0);
    report.checks.manualRefreshPreservesPairing = true;

    report.checks.noHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    );
  } finally {
    await context.close();
    await app.close();
    desktop.stop();
    store.close();
    await rm(c.desktopRoot, { recursive: true, force: true });
  }
}
try {
  await run(process.env.POCKET_TEST_WEB_ROOT ?? '.test-output/question-panel-web');
} catch (error) {
  report.error = (error as Error).message;
  process.exitCode = 1;
} finally {
  await browser.close();
  report.checks.noBrowserErrors = report.errors.length === 0;
  report.passed = !report.error && Object.values(report.checks).every(Boolean);
  if (!report.passed) process.exitCode = 1;
  await writeFile('.test-output/question-ui-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
