import { privateOutput } from './private-output.js';
await privateOutput('.test-output');
/** Real native question + browser response, using only the dedicated test chat. */
import { chromium, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { readConfig } from './legacy-config.js';
import { DesktopAdapter } from '../packages/adapter-codex/src/desktop.js';
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
const deviceName = `临时问题卡片验收-${randomUUID()}`;
await mkdir('.test-output', { recursive: true, mode: 0o700 });
const code = store.mintPairing().code;
const browser = await chromium.launch({ channel: process.env.POCKET_BROWSER_CHANNEL ?? 'chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const report: any = { checks: {}, errors: [] };
page.on('pageerror', (e) => report.errors.push(e.message));
try {
  await page.goto(config.origin);
  await page.getByLabel('设备名称').fill(deviceName);
  await page.getByLabel('一次性配对码').fill(code);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  await expect(page.getByRole('heading', { name: '会话', exact: true })).toBeVisible();
  const title = await page.evaluate(
    async (threadId) => (await (await fetch(`/api/threads/${threadId}/history`)).json()).thread.title,
    id,
  );
  const button = page.getByRole('button', { name: title, exact: false });
  for (let i = 0; i < 10 && (await button.count()) === 0; i++)
    await page.getByRole('button', { name: '加载更多会话', exact: true }).click();
  await button.first().click();
  await desktop.control(
    id,
    'settings',
    JSON.stringify({
      model: original.model,
      effort: original.reasoningEffort,
      expectedModel: original.model,
      expectedEffort: original.reasoningEffort,
      mode: 'plan',
    }),
    randomUUID(),
  );
  await desktop.control(
    id,
    'send',
    '这是手机页面问题卡片验收。请使用 request_user_input 工具询问我选择红色还是蓝色，收到回答后只复述选择；不要操作文件或执行命令。',
    randomUUID(),
  );
  await expect(page.locator('.request-card').first()).toBeVisible({ timeout: 60000 });
  await page.locator('.question-card').first().getByRole('button', { name: '回答问题' }).click();
  await page.getByRole('dialog').getByRole('radio').last().check();
  await page.getByRole('dialog').getByLabel('你的回答', { exact: true }).fill('蓝色');
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect(page.locator('.request-card')).toHaveCount(0, { timeout: 15000 });
  await expect.poll(() => desktop.view(id)?.activeTurnId, { timeout: 60000 }).toBeNull();
  report.checks.nativeQuestionAnsweredFromBrowser = desktop
    .view(id)
    ?.messages.some((m) => m.role === 'assistant' && m.text.includes('蓝色'));
  report.checks.noBrowserErrors = report.errors.length === 0;
} catch (e) {
  report.error = (e as Error).message;
  process.exitCode = 1;
} finally {
  const current = desktop.view(id);
  if (current?.activeTurnId)
    await desktop.control(id, 'interrupt', current.activeTurnId, randomUUID()).catch(() => {});
  await expect.poll(() => desktop.view(id)?.activeTurnId, { timeout: 10000 }).toBeNull();
  const v = desktop.view(id)!;
  await desktop.control(
    id,
    'settings',
    JSON.stringify({
      model: original.model,
      effort: original.reasoningEffort,
      expectedModel: v.model,
      expectedEffort: v.reasoningEffort,
      mode: original.mode ?? 'default',
    }),
    randomUUID(),
  );
  await expect.poll(() => desktop.view(id)?.mode).toBe(original.mode);
  report.checks.originalSettingsRestored = true;
  for (const device of store.devices()) if (device.name === deviceName) store.revoke(device.id);
  await browser.close();
  release();
  desktop.stop();
  store.close();
  report.passed = !report.error && Object.values(report.checks).every(Boolean);
  if (!report.passed) process.exitCode = 1;
  await writeFile('.test-output/request-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
