/** Deterministic browser acceptance: isolated state, no real desktop operations. */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { config, host, relay, store, native, close, file } from './v2-fixture.js';
import { THREAD } from '../test/helpers.js';
const report: any = {
  fixture: true,
  checks: {},
  errors: [],
  environment: 'Linux Chrome, mobile viewport; no physical phone or cellular NAT',
};
const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
await context.addInitScript(() => {
  const w = window as any;
  w.__qa = { peers: [], sockets: [], plaintext: false, blockRelay: false, blockDirect: false };
  const WS = window.WebSocket;
  window.WebSocket = class extends WS {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (w.__qa.blockRelay) throw Error('QA relay outage');
      super(url, protocols);
      w.__qa.sockets.push(this);
      this.addEventListener('message', (e) => {
        if (e.data instanceof ArrayBuffer) {
          const text = new TextDecoder().decode(e.data);
          if (text.includes('private-file-fixture') || text.includes('fixture.txt')) w.__qa.plaintext = true;
        }
      });
    }
  };
  const PC = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends PC {
    constructor(config?: RTCConfiguration) {
      if (w.__qa.blockDirect) throw Error('QA UDP unavailable');
      super(config);
      w.__qa.peers.push(this);
    }
  };
});
page.on('pageerror', (e) => report.errors.push(e.message));
async function selectChat() {
  if (new URL(page.url()).searchParams.has('thread'))
    await page.getByRole('button', { name: '返回会话列表' }).click();
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  await page.getByRole('button', { name: /测试会话/ }).click();
  await expect(page.getByLabel('消息', { exact: true })).toBeEnabled({ timeout: 20000 });
}
async function previewTestAttachment() {
  await page.getByRole('button', { name: '测试附件', exact: true }).click();
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page
      .getByRole('dialog', { name: '附件操作：fixture.txt' })
      .getByRole('button', { name: '预览', exact: true })
      .click(),
  ]);
  await popup.waitForURL('blob:**', { timeout: 30000 });
  return popup;
}
try {
  const pair = store.mintPairing();
  await page.goto(`${config.origin}/#pair=${pair.code}&host=${host.identity.peerId}`);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await selectChat();
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as any).__qa.peers.some((p: RTCPeerConnection) => p.connectionState === 'connected'),
        ),
      { timeout: 20000 },
    )
    .toBe(true);
  report.checks.pairingAndDirect = true;
  expect(new URL(page.url()).hash).toBe('');
  const peers = await page.evaluate(() => (window as any).__qa.peers.length);
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await selectChat();
  expect(await page.evaluate(() => (window as any).__qa.peers.length)).toBe(peers);
  report.checks.connectionReusedAcrossChats = true;
  const before = relay.counters.bulkBytes;
  const popup = await previewTestAttachment();
  await expect.poll(() => popup.evaluate(() => document.body.innerText.length)).toBeGreaterThan(1000000);
  expect(relay.counters.bulkBytes).toBe(before);
  await popup.close();
  report.checks.directFilesNoRelayBody = true;
  await page.locator('audio').scrollIntoViewIfNeeded();
  await page.locator('audio').evaluate((element: HTMLAudioElement) => {
    element.load();
  });
  await expect
    .poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.duration))
    .toBe(20);
  await page.locator('audio').evaluate((element: HTMLAudioElement) => {
    element.currentTime = 12;
  });
  await expect
    .poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBe(12);
  expect(relay.counters.bulkBytes).toBe(before);
  report.checks.localMediaRangeAndSeek = true;
  await page.locator('input[type=file]').setInputFiles({
    name: 'upload.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(2 * 1024 * 1024 + 37, 17),
  });
  await expect(page.locator('.upload-chip')).toContainText('upload.bin', { timeout: 30000 });
  expect(relay.counters.bulkBytes).toBe(before);
  report.checks.directUpload = true;
  await page.evaluate(() => {
    const q = (window as any).__qa;
    q.blockRelay = true;
    for (const s of q.sockets) s.close();
  });
  await expect(page.locator('.chat-head .dot')).toHaveClass(/online/);
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await selectChat();
  await page.getByLabel('消息', { exact: true }).fill('direct-control-fixture');
  await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
  await expect
    .poll(() => native.calls.some((c) => JSON.stringify(c).includes('direct-control-fixture')))
    .toBe(true);
  report.checks.relayOutageKeepsDirect = true;
  await page.evaluate(() => {
    const q = (window as any).__qa;
    q.blockRelay = false;
    q.blockDirect = true;
    for (const p of q.peers) p.close();
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.locator('.chat-head .dot')).toHaveAttribute('title', '已连接', { timeout: 20000 });
  report.checks.directFailureUsesRelay = true;
  await page.getByLabel('消息', { exact: true }).fill('relay-control-fixture');
  await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
  await expect
    .poll(() => native.calls.some((c) => JSON.stringify(c).includes('relay-control-fixture')))
    .toBe(true);
  report.checks.controlUsesBothPaths = true;
  const beforeRelayUpload = relay.counters.bulkBytes;
  await page.locator('input[type=file]').setInputFiles({
    name: 'relay-upload.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(2 * 1024 * 1024 + 39, 18),
  });
  await expect(page.locator('.upload-chip')).toContainText('relay-upload.bin', { timeout: 30000 });
  expect(relay.counters.bulkBytes).toBeGreaterThan(beforeRelayUpload + 2 * 1024 * 1024);
  report.checks.freshUploadOverEncryptedRelay = true;
  const beforeCache = relay.counters.bulkBytes;
  const second = await previewTestAttachment();
  await second.close();
  expect(relay.counters.bulkBytes).toBe(beforeCache);
  report.checks.attachmentCacheAvoidsDownload = true;
  report.checks.mobileNoHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
  await page.screenshot({ path: '/tmp/pocket-v2-mobile.png' });
  await page.reload();
  await selectChat();
  report.checks.identityAndHistorySurviveReload = true;
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const request = indexedDB.open('pocket-device-v2');
        const db = await new Promise<IDBDatabase>((r) => (request.onsuccess = () => r(request.result)));
        const tx = db.transaction('content'),
          q = tx.objectStore('content').count();
        return new Promise<number>((r) => (q.onsuccess = () => r(q.result)));
      }),
    )
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__qa.plaintext)).toBe(false);
  report.checks.relayHasNoPlaintext = true;
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.connection-note')).toContainText('连接中断', { timeout: 15000 });
  await expect(page.locator('.message').nth(0)).toContainText('你好');
  await expect(page.locator('.message').nth(1)).toContainText('世界');
  await expect(page.getByLabel('消息', { exact: true })).toBeDisabled();
  report.checks.offlineCacheReadOnly = true;
  await context.setOffline(false);
  report.checks.noUncaughtErrors = report.errors.length === 0;
  report.metrics = { relay: relay.counters, host: host.metrics, files: host.core.files.metrics };
  report.passed = Object.values(report.checks).every(Boolean);
} catch (error) {
  report.passed = false;
  report.error = (error as Error).message;
  await page.screenshot({ path: '/tmp/pocket-v2-failure.png' }).catch(() => {});
} finally {
  await browser.close();
  await close();
  await mkdir('.test-output', { recursive: true });
  await writeFile('.test-output/v2-results.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
