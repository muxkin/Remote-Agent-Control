import { privateOutput } from './private-output.js';
await privateOutput('.test-output');
/** Dedicated native chat only: actual async prompts -> phone UI -> accepted native reply. */
import { chromium, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { readConfig } from '../src/server/config.js';
import { DesktopAdapter } from '../src/server/desktop.js';
import { Store } from '../src/server/store.js';
const id = process.argv[2];
if (!id || !process.argv.includes('--allow-control'))
  throw Error('Dedicated test thread and --allow-control required');
const config = readConfig();
const desktop = new DesktopAdapter(config);
await desktop.start();
const release = await desktop.acquire(id);
const original = await desktop.waitForView(id);
if (!original?.canSend) throw Error('Test chat must be idle');
const store = new Store(config.stateDir);
const deviceName = `临时异步问题验收-${randomUUID()}`;
const browser = await chromium.launch({ channel: process.env.POCKET_BROWSER_CHANNEL ?? 'chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
const report: any = {
  checks: {},
  errors: [],
  browser: 'Playwright (Browser plugin not available; BrowserAct entry page checked separately)',
  viewport: '390x844',
};
page.on('pageerror', (error) => report.errors.push(error.message));
async function openChat() {
  const title = await page.evaluate(
    async (threadId) => (await (await fetch(`/api/threads/${threadId}/history`)).json()).thread.title,
    id,
  );
  const button = page.getByRole('button', { name: title, exact: false });
  for (let i = 0; i < 15 && !(await button.count()); i++)
    await page.getByRole('button', { name: '加载更多会话', exact: true }).click();
  await button.first().click();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
}
try {
  await page.goto(config.origin);
  await page.getByLabel('设备名称').fill(deviceName);
  await page.getByLabel('一次性配对码').fill(store.mintPairing().code);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  await expect(page.getByRole('heading', { name: '会话', exact: true })).toBeVisible();
  await openChat();
  await desktop.control(
    id,
    'settings',
    JSON.stringify({
      model: 'gpt-6.1-sol',
      effort: 'low',
      mode: 'default',
      expectedModel: original.model,
      expectedEffort: original.reasoningEffort,
    }),
    randomUUID(),
  );
  for (const active of [false, true]) {
    const marker = `QA-${randomUUID().slice(0, 8)}`;
    await desktop.control(
      id,
      'send',
      `这是手机异步问题交互验收（${marker}），仅在此专用测试会话执行。请调用 functions.request_user_input_async，包含两个问题：标题“${marker} 选择颜色”，选项“蓝色”和“红色”；标题“${marker} 输入备注”，不提供选项。${active ? '调用后立刻用 clock.sleep 等待 45000 毫秒，以便我在运行中回答；收到回答后只复述我的颜色和备注。' : '调用后直接结束本轮并说“问题已准备好”，不要等待；收到下一条回答后只复述颜色和备注。'}不要修改文件或调用其他工具。`,
      randomUUID(),
    );
    const card = page.locator('[data-question-mode="async"]').filter({ hasText: marker });
    await expect(card).toBeVisible({ timeout: 90000 });
    await expect(card.getByRole('button', { name: '回答问题（2 题）' })).toBeVisible();
    report.checks[`${active ? 'active' : 'idle'}ChoiceAndFreeform`] = true;
    if (!active) {
      await expect.poll(() => desktop.view(id)?.activeTurnId, { timeout: 60000 }).toBeNull();
      await page.reload();
      await page.getByRole('tab', { name: '最近', exact: true }).click();
      await expect(page.getByRole('heading', { name: '会话', exact: true })).toBeVisible();
      await openChat();
      await expect(card).toBeVisible();
      report.checks.reconnectRestoresPendingQuestions = true;
    } else {
      report.checks.activeTurnAtResponse = !!desktop.view(id)?.activeTurnId;
    }
    await card.getByRole('button', { name: '回答问题（2 题）' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: '下一题', exact: true })).toBeDisabled();
    await dialog.getByRole('radio').first().check();
    await dialog.getByRole('button', { name: '下一题', exact: true }).click();
    await dialog.getByLabel('你的回答', { exact: true }).fill(`备注-${marker}`);
    await dialog.getByRole('button', { name: '核对答案', exact: true }).click();
    const submit = dialog.getByRole('button', { name: '提交全部回答（2 题）', exact: true });
    await expect(submit).toBeEnabled();
    const box = await submit.boundingBox();
    report.checks.submitVisibleWithoutScrolling = !!box && box.y + box.height <= page.viewportSize()!.height;
    if (!active) await page.screenshot({ path: '/tmp/pocket-question-review-live.png' });
    await submit.click();
    await expect(card).toHaveCount(0, { timeout: 30000 });
    await expect
      .poll(
        () =>
          desktop.view(id)?.messages.some((m) => m.role === 'assistant' && m.text.includes(`备注-${marker}`)),
        { timeout: 90000 },
      )
      .toBe(true);
    await expect.poll(() => desktop.view(id)?.activeTurnId, { timeout: 90000 }).toBeNull();
    report.checks[`${active ? 'active' : 'idle'}NativeReplyReceived`] = true;
    const replies = desktop
      .view(id)!
      .messages.filter((m) => m.role === 'user' && m.text.includes(`备注-${marker}`));
    report.checks[`${active ? 'active' : 'idle'}ReplyOnce`] =
      new Set(replies.map((m) => m.clientMessageId ?? m.id)).size === 1;
    report.checks.cleanReplyText = replies.every(
      (m) => !m.text.includes('send_user_message_question_reply') && !m.text.includes('questionItemId'),
    );
  }
  report.checks.noHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
  report.checks.noBrowserErrors = !report.errors.length;
} catch (error) {
  report.error = (error as Error).message;
  process.exitCode = 1;
  await page.screenshot({ path: '/tmp/pocket-async-error.png' }).catch(() => {});
} finally {
  if (desktop.view(id)?.activeTurnId)
    await desktop.control(id, 'interrupt', desktop.view(id)!.activeTurnId!, randomUUID()).catch(() => {});
  await expect.poll(() => desktop.view(id)?.activeTurnId, { timeout: 15000 }).toBeNull();
  const current = desktop.view(id)!;
  await desktop.control(
    id,
    'settings',
    JSON.stringify({
      model: original.model,
      effort: original.reasoningEffort,
      mode: original.mode ?? 'default',
      expectedModel: current.model,
      expectedEffort: current.reasoningEffort,
    }),
    randomUUID(),
  );
  report.checks.originalSettingsRestored = true;
  for (const device of store.devices()) if (device.name === deviceName) store.revoke(device.id);
  await browser.close();
  release();
  desktop.stop();
  store.close();
  report.passed = !report.error && Object.values(report.checks).every(Boolean);
  if (!report.passed) process.exitCode = 1;
  await writeFile('.test-output/async-request-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
