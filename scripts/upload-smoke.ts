import { privateOutput } from './private-output.js';
await privateOutput('.test-output');
/** Real native question + browser response, using only the dedicated test chat. */
import { chromium, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { readConfig } from './legacy-config.js';
import { DesktopAdapter } from '../packages/adapter-codex/src/desktop.js';
import { Store } from '../src/server/store.js';
import { turnsOf } from '../packages/adapter-codex/src/timeline.js';
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
const deviceName = `临时附件验收-${randomUUID()}`;
await mkdir('.test-output', { recursive: true, mode: 0o700 });
const code = store.mintPairing().code;
const browser = await chromium.launch({ channel: process.env.POCKET_BROWSER_CHANNEL ?? 'chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const report: any = { checks: {}, errors: [] };
page.on('pageerror', (e) => report.errors.push(e.message));
let attachmentMetadata = false;
desktop.on('state', (threadId, state) => {
  if (threadId !== id) return;
  const latest = turnsOf(state).at(-1);
  if (
    latest?.params?.attachments?.some((file: any) => file.label === 'phone-attachment.txt') &&
    latest.params.attachments.some((file: any) => file.label === 'phone-image.png')
  )
    attachmentMetadata = true;
});
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
      model: 'gpt-6.1-sol',
      effort: 'low',
      expectedModel: original.model,
      expectedEffort: original.reasoningEffort,
      mode: 'default',
    }),
    randomUUID(),
  );
  const marker = `PHONE_UPLOAD_${randomUUID()}`;
  await page.getByLabel('添加附件').setInputFiles([
    { name: 'phone-attachment.txt', mimeType: 'text/plain', buffer: Buffer.from(marker) },
    {
      name: 'phone-image.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aFwkAAAAASUVORK5CYII=',
        'base64',
      ),
    },
  ]);
  await expect(page.locator('.upload-chip').filter({ hasText: 'phone-attachment.txt' })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.locator('.upload-chip').filter({ hasText: 'phone-image.png' })).toBeVisible({
    timeout: 20000,
  });
  await page
    .getByLabel('消息', { exact: true })
    .fill('请读取我上传的文本附件，只回复其完整内容，不修改文件。');
  await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
  await expect
    .poll(() => desktop.view(id)?.messages.some((m) => m.role === 'assistant' && m.text.includes(marker)), {
      timeout: 90000,
    })
    .toBe(true);
  await expect.poll(() => desktop.view(id)?.activeTurnId, { timeout: 60000 }).toBeNull();
  report.checks.attachmentReadByDesktop = true;
  report.checks.nativeAttachmentMetadata = attachmentMetadata;
  const message = page
    .locator('.message.user')
    .filter({ hasText: '请读取我上传的文本附件，只回复其完整内容，不修改文件。' })
    .last();
  await expect(message.locator('.message-text')).toHaveText(
    '请读取我上传的文本附件，只回复其完整内容，不修改文件。',
  );
  await expect(message.getByRole('button', { name: 'phone-attachment.txt', exact: true })).toBeVisible();
  report.checks.cleanUserTextAndFileCard = true;
  const image = page.locator('.message.user img').last();
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  report.checks.nativeImageThumbnail = true;
  await page.screenshot({ path: '/tmp/pocket-clean-attachments.png' });
  report.checks.attachmentExecutedOnce =
    desktop.view(id)!.messages.filter((m) => m.role === 'assistant' && m.text.includes(marker)).length === 1;
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
  await writeFile('.test-output/upload-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
