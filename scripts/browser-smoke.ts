import { privateOutput } from './private-output.js';
await privateOutput('.test-output');
/** Opt-in live browser QA. Never target a working conversation. */
import { chromium, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readConfig } from './legacy-config.js';
import { Store } from '../src/server/store.js';
import { DesktopAdapter } from '../packages/adapter-codex/src/desktop.js';

const threadId = process.argv[2];
if (!threadId || !process.argv.includes('--allow-control')) {
  throw new Error('Usage: browser-smoke.ts <DEDICATED_TEST_THREAD_ID> --allow-control');
}
const config = readConfig();
const desktop = new DesktopAdapter(config);
await desktop.start();
const release = await desktop.acquire(threadId);
const original = await desktop.waitForView(threadId);
if (!original?.canSend) {
  release();
  desktop.stop();
  throw Error('Dedicated test chat must be idle');
}
const store = new Store(config.stateDir);
const deviceName = `临时手机界面验收-${randomUUID()}`;
const pairing = store.mintPairing();
const report: any = { date: new Date().toISOString(), checks: {}, timingsMs: {}, errors: [] };
const output = resolve('.test-output');
await mkdir(output, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ channel: process.env.POCKET_BROWSER_CHANNEL ?? 'chrome' });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
let controlHttpRequests = 0;
page.on('request', (request) => {
  if (request.method() === 'POST' && /\/(messages|settings)$/.test(request.url())) controlHttpRequests++;
});
await page.addInitScript(() => {
  const Native = window.RTCPeerConnection;
  (window as any).__testPeers = [];
  window.RTCPeerConnection = class extends Native {
    constructor(configuration?: RTCConfiguration) {
      super(configuration);
      (window as any).__testPeers.push(this);
    }
  };
});
page.on('pageerror', (error) => report.errors.push(error.message));
try {
  const started = Date.now();
  await page.goto(config.origin);
  await expect(page.getByRole('button', { name: '连接电脑', exact: true })).toBeVisible();
  report.timingsMs.pairingPage = Date.now() - started;
  await page.getByLabel('设备名称').fill(deviceName);
  await page.getByLabel('一次性配对码').fill(pairing.code);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  await expect(page.getByRole('heading', { name: '会话', exact: true })).toBeVisible();
  const title = await page.evaluate(async (id) => {
    const data = await (await fetch(`/api/threads/${id}/history`)).json();
    return data.thread.title as string;
  }, threadId);
  const button = page.getByRole('button', { name: title, exact: false });
  for (let i = 0; i < 10 && (await button.count()) === 0; i++)
    await page.getByRole('button', { name: '加载更多会话', exact: true }).click();
  await button.first().click();
  await expect(page.getByLabel('消息', { exact: true })).toBeEnabled({ timeout: 15000 });
  report.checks.uiPairingAndOwnedThread = true;
  report.checks.mobileNoHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
  report.checks.mobileListHidden = await page.locator('.sidebar').isHidden();
  if (config.p2p?.enabled) {
    await expect(page.locator('.chat-head .dot')).toHaveAttribute('title', 'P2P 直连', { timeout: 15000 });
    report.checks.localP2P = true;
  }
  const originalModel = original.model!,
    originalEffort = original.reasoningEffort!;
  const alternative = (
    await page.request.get(`${config.origin}/api/models`).then((r) => r.json())
  ).models.find((m: any) => m.id !== originalModel)?.id;
  async function changeModel(model: string, effort?: string) {
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('button', { name: '选择模型' }).click();
    await page.getByLabel('搜索模型').fill(model);
    await page
      .locator('.model-catalog [role=radio]')
      .filter({ has: page.locator('small', { hasText: model }) })
      .first()
      .click();
    if (effort)
      await page
        .getByRole('radiogroup', { name: '推理强度' })
        .getByRole('radio', {
          name:
            (
              {
                minimal: '最低',
                low: '低',
                medium: '中',
                high: '高',
                xhigh: '更高',
                max: '最高',
                ultra: '极高',
              } as any
            )[effort] ?? effort,
          exact: true,
        })
        .click();
    await page.getByRole('button', { name: '应用到下一轮', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '模型设置' })).toHaveCount(0, { timeout: 15000 });
    await expect.poll(() => desktop.view(threadId)?.model).toBe(model);
  }
  if (!alternative) throw new Error('No alternate desktop model available for dedicated test');
  await changeModel(alternative);
  report.checks.nativeModelChange = true;
  const marker = `POCKET_UI_${randomUUID().slice(0, 8)}`;
  await page.getByLabel('消息', { exact: true }).fill(`请只回复 ${marker}，不要调用工具或修改文件。`);
  const sendAt = Date.now();
  await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
  await expect(page.locator('.message.assistant .message-text').filter({ hasText: marker })).toHaveCount(1, {
    timeout: 90000,
  });
  await expect(page.getByRole('status').filter({ hasText: '消息 · 已完成' }).first()).toHaveCount(1, {
    timeout: 10000,
  });
  report.timingsMs.uiSendCompleted = Date.now() - sendAt;
  report.checks.uiSendOnce = true;
  await changeModel(originalModel, originalEffort);
  report.checks.originalModelRestored = true;
  if (config.p2p?.enabled) report.checks.controlsBypassCloudHttp = controlHttpRequests === 0;
  if (config.p2p?.enabled) {
    await page.evaluate(() => {
      for (const peer of (window as any).__testPeers) peer.close();
    });
    await expect(page.locator('.chat-head .dot')).toHaveAttribute('title', '已连接', { timeout: 15000 });
    report.checks.p2pFallsBackToWebSocket = true;
  }
  await page.screenshot({ path: resolve(output, 'mobile-chat.png') });

  await page.setViewportSize({ width: 1280, height: 900 });
  report.checks.desktopListVisible = await page.locator('.sidebar').isVisible();
  report.checks.desktopNoHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
  // Capture only the dedicated test conversation; unrelated sidebar titles stay private.
  await page.locator('.chat').screenshot({ path: resolve(output, 'desktop-chat.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByLabel('消息', { exact: true })
    .fill(
      '这是手机界面中断验收。请执行一次 sleep 25，然后回复 POCKET_UI_WAIT_FINISHED；不要执行其他命令或修改文件。',
    );
  await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
  const stop = page.getByRole('button', { name: '中断任务', exact: true });
  await expect(stop).toBeEnabled({ timeout: 15000 });
  await stop.click();
  await expect(page.getByRole('status').filter({ hasText: '中断 · 已中断' }).first()).toHaveCount(1, {
    timeout: 15000,
  });
  report.checks.uiInterrupt = true;
  await expect(page.getByLabel('消息', { exact: true })).toBeEnabled({ timeout: 15000 });

  // Break delivery before it reaches the gateway: an unknown result must block resend.
  await page.route(`**/api/threads/${threadId}/messages`, (route) => route.abort('failed'));
  await page.getByLabel('消息', { exact: true }).fill('此请求会在浏览器测试层阻断，不应交给桌面执行。');
  await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '结果待确认' }).first()).toBeVisible();
  await expect(page.getByLabel('消息', { exact: true })).toBeDisabled();
  await page.reload();
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  await page.getByRole('button', { name: title, exact: false }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '结果待确认' }).first()).toBeVisible();
  await expect(page.getByLabel('消息', { exact: true })).toBeDisabled();
  report.checks.ambiguousDeliverySurvivesReload = true;

  const device = store.devices().find((item) => item.name === deviceName);
  if (!device) throw new Error('Temporary device missing');
  store.revoke(device.id);
  await expect(page.getByRole('button', { name: '连接电脑', exact: true })).toBeVisible({ timeout: 20000 });
  report.checks.revokedSocketCloses = true;

  // Revocation before selecting a chat produces HTTP 401 at the WS handshake,
  // which browsers expose only as close code 1006, not an explicit revoked frame.
  const secondPairing = store.mintPairing();
  await page.getByLabel('设备名称').fill(deviceName);
  await page.getByLabel('一次性配对码').fill(secondPairing.code);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  await expect(page.getByRole('heading', { name: '会话', exact: true })).toBeVisible();
  // The heading renders before the asynchronous list fetch. Revoke only after it finishes.
  await expect(page.getByRole('button', { name: title, exact: false }).first()).toBeVisible();
  const revokedBeforeConnect = store.devices().find((item) => item.name === deviceName && !item.revoked);
  if (!revokedBeforeConnect) throw new Error('Second QA pairing missing');
  store.revoke(revokedBeforeConnect.id);
  await page.getByRole('button', { name: title, exact: false }).first().click();
  await expect(page.getByRole('button', { name: '连接电脑', exact: true })).toBeVisible({ timeout: 10000 });
  report.checks.revokedBeforeSocketConnectReturnsToPairing = true;
  report.checks.noUncaughtBrowserErrors = report.errors.length === 0;
  report.passed = Object.values(report.checks).every(Boolean);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.passed = false;
  report.error = (error as Error).message;
  process.exitCode = 1;
} finally {
  try {
    const active = desktop.view(threadId)?.activeTurnId;
    if (active) await desktop.control(threadId, 'interrupt', active, randomUUID());
    await expect.poll(() => desktop.view(threadId)?.activeTurnId, { timeout: 15000 }).toBeNull();
    const current = desktop.view(threadId)!;
    if (
      current.model !== original.model ||
      current.reasoningEffort !== original.reasoningEffort ||
      current.mode !== original.mode ||
      current.serviceTier !== original.serviceTier
    ) {
      await desktop.control(
        threadId,
        'settings',
        JSON.stringify({
          model: original.model,
          effort: original.reasoningEffort,
          expectedModel: current.model,
          expectedEffort: current.reasoningEffort,
          mode: original.mode ?? 'default',
          serviceTier: original.serviceTier ?? 'default',
          expectedServiceTier: current.serviceTier ?? null,
          expectedMode: current.mode,
        }),
        randomUUID(),
      );
    }
  } catch (error) {
    report.cleanupError = (error as Error).message;
    report.passed = false;
    process.exitCode = 1;
  }
  release();
  desktop.stop();
  for (const device of store.devices()) if (device.name === deviceName) store.revoke(device.id);
  store.close();
  await browser.close();
  await writeFile(resolve(output, 'browser-results.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
