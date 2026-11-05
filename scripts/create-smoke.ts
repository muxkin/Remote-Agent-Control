import { privateOutput } from './private-output.js';
await privateOutput('.test-output');
/** One explicit native creation, with no automatic retry on uncertain delivery. */
import { chromium, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { readConfig } from '../src/server/config.js';
import { DesktopAdapter } from '../src/server/desktop.js';
import { Store } from '../src/server/store.js';
const anchor = process.argv[2];
if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(anchor ?? '') ||
  !process.argv.includes('--allow-control')
)
  throw Error('Dedicated test anchor required');
const config = readConfig(),
  store = new Store(config.stateDir),
  desktop = new DesktopAdapter(config);
await desktop.start();
const release = await desktop.acquire(anchor);
const original = await desktop.waitForView(anchor);
if (!original?.canSend) throw Error('Anchor must be idle');
const browser = await chromium.launch({ channel: 'chrome' }),
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const deviceName = `临时新建验收-${randomUUID()}`,
  title = `Pocket Remote 新建验收 ${randomUUID().slice(0, 6)}`,
  marker = `NATIVE_CREATE_${randomUUID().slice(0, 8)}`;
const report: any = { date: new Date().toISOString(), checks: {}, errors: [] };
let newRelease: (() => void) | undefined;
page.on('pageerror', (e) => report.errors.push(e.message));
try {
  await page.goto(config.origin);
  await page.getByLabel('设备名称').fill(deviceName);
  await page.getByLabel('一次性配对码').fill(store.mintPairing().code);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  const button = page.getByRole('button', { name: original.title, exact: false });
  for (let i = 0; i < 20 && (await button.count()) === 0; i++)
    await page.getByRole('button', { name: '加载更多会话', exact: true }).click();
  await button.first().click();
  await page.getByRole('button', { name: '会话工具', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await page.screenshot({ path: '.test-output/create-debug.png', fullPage: true });
  await page.getByLabel('新会话标题').fill(title);
  await page
    .getByLabel('新会话第一条消息')
    .fill(`这是手机原生新建会话验收。请只回复 ${marker}，不要调用任何工具、修改文件或继续其他工作。`);
  await page.getByRole('button', { name: '创建并发送', exact: true }).click();
  const device = store.devices().find((d) => d.name === deviceName);
  await expect
    .poll(() => store.recent(device.id, anchor).find((o) => o.kind === 'create')?.state, { timeout: 45000 })
    .toBe('completed');
  const operation = store.recent(device.id, anchor).find((o) => o.kind === 'create')!;
  report.threadId = operation.resultThreadId;
  report.checks.createdByDesktop = !!report.threadId;
  newRelease = await desktop.acquire(report.threadId);
  await desktop.waitForView(report.threadId);
  await expect(page.locator('.chat-head h2')).toHaveText(title, { timeout: 15000 });
  await expect
    .poll(
      () =>
        desktop
          .view(report.threadId)
          ?.messages.some((m) => m.role === 'assistant' && m.text.includes(marker)),
      { timeout: 90000 },
    )
    .toBe(true);
  await expect.poll(() => desktop.view(report.threadId)?.activeTurnId, { timeout: 30000 }).toBeNull();
  report.checks.newThreadHasDesktopOwner = desktop.view(report.threadId)?.owner === true;
  report.checks.singleInitialExecution =
    desktop.view(report.threadId)!.messages.filter((m) => m.role === 'assistant' && m.text.includes(marker))
      .length === 1;
  report.checks.browserNavigatedToNewThread = true;
  report.checks.anchorUnchanged =
    desktop.view(anchor)?.model === original.model && desktop.view(anchor)?.activeTurnId === null;
} catch (e) {
  report.error = (e as Error).message;
  report.formText = await page
    .locator('.new-conversation')
    .textContent()
    .catch(() => null);
  await page.screenshot({ path: '.test-output/create-error.png', fullPage: true });
} finally {
  report.operations = store
    .recent(store.devices().find((d) => d.name === deviceName)?.id, anchor)
    .map((o) => ({ state: o.state, resultThreadId: o.resultThreadId, error: o.error }));
  for (const d of store.devices()) if (d.name === deviceName) store.revoke(d.id);
  await browser.close();
  newRelease?.();
  release();
  desktop.stop();
  store.close();
  report.checks.noBrowserErrors = !report.errors.length;
  report.passed = !report.error && Object.values(report.checks).every(Boolean);
  if (!report.passed) process.exitCode = 1;
  await writeFile('.test-output/create-results.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
