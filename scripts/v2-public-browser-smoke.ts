/** Public release, real desktop, read-only browser verification. Never submits a prompt. */
import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { readConfig } from './legacy-config.js';
import { hostIdentity } from '../src/server/device-identity.js';
import { Store } from '../src/server/store.js';
import { HistoryIndex } from '../packages/adapter-codex/src/history.js';
const config = readConfig(),
  store = new Store(config.stateDir),
  history = new HistoryIndex(config.codexHome),
  host = await hostIdentity(config.stateDir);
const thread = history.get(process.argv[2]);
if (!thread) throw Error('Specify an existing read-only QA thread');
const name = `v2-browser-read-only-${crypto.randomUUID()}`,
  pair = store.mintPairing(),
  checks: Record<string, boolean> = {},
  errors: string[] = [];
const browser = await chromium.launch({ channel: 'chrome' }),
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  }),
  page = await context.newPage();
await context.addInitScript(() => {
  const PC = window.RTCPeerConnection;
  (window as any).__qaPeers = [];
  window.RTCPeerConnection = class extends PC {
    constructor(config?: RTCConfiguration) {
      super(config);
      (window as any).__qaPeers.push(this);
    }
  };
});
page.on('pageerror', () => errors.push('browser error'));
try {
  await page.goto(`${config.origin}/#pair=${pair.code}&host=${host.peerId}`);
  await page.getByLabel('设备名称').fill(name);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  const input = page.getByPlaceholder('搜索项目或会话');
  await expect(input).toBeVisible();
  await input.fill(thread.title);
  await page.getByRole('button', { name: thread.title, exact: false }).first().click();
  await expect(page.locator('.chat-head .dot')).toHaveClass(/online/, { timeout: 30000 });
  checks.publicCdnAndEncryptedHistory = true;
  for (const size of [
    { width: 390, height: 844 },
    { width: 1920, height: 1080 },
    { width: 800, height: 600 },
    { width: 1280, height: 720 },
    { width: 1280, height: 400 },
  ]) {
    await page.setViewportSize(size);
    await expect
      .poll(() => page.locator('.app-shell').evaluate((el) => Math.round(el.getBoundingClientRect().height)))
      .toBe(size.height);
    const shell = await page.locator('.app-shell').boundingBox();
    expect(shell!.x).toBe(0);
    expect(shell!.width).toBe(size.width);
    const navigation = page.locator('.bottom-navigation');
    if (size.width > 700) {
      for (const name of ['消息', '工作台', '我的'])
        await expect(navigation.getByRole('button', { name, exact: true })).toBeVisible();
      expect((await navigation.boundingBox())!.width).toBe(80);
    } else {
      await expect(navigation).toBeHidden();
      const composer = await page.locator('.composer').boundingBox();
      expect(composer!.y + composer!.height).toBe(size.height);
    }
    const send = await page.locator('.composer .send-button').boundingBox();
    expect(send).not.toBeNull();
    expect(send!.y).toBeGreaterThanOrEqual(0);
    expect(send!.y + send!.height).toBeLessThanOrEqual(size.height + 1);
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && scrollY === 0),
    ).toBe(true);
  }
  checks.mobileAndDesktopComposerWithinViewport = true;
  checks.desktopNavigationAndMobileChatHierarchy = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as any).__qaPeers.some((p: RTCPeerConnection) => p.connectionState === 'connected'),
        ),
      { timeout: 25000 },
    )
    .toBe(true);
  checks.publicSignalingAndDirect = true;
  await page.getByRole('button', { name: '返回会话列表' }).click();
  const navigation = await page.getByRole('navigation', { name: '主要功能' }).boundingBox();
  expect(navigation).not.toBeNull();
  expect(navigation!.y + navigation!.height).toBeLessThanOrEqual(845);
  checks.homeNavigationWithinViewport = true;
  await page.getByRole('button', { name: '新会话', exact: true }).click();
  await expect(page.getByPlaceholder('发送第一条消息，开始新会话…')).toBeEnabled();
  await page.getByPlaceholder('发送第一条消息，开始新会话…').fill('仅用于检查输入框，不会发送');
  await expect(page.locator('.new-conversation .send-button')).toBeEnabled();
  expect(await page.getByLabel('新会话标题（可选）').getAttribute('required')).toBeNull();
  checks.optionalTitleAndReusedComposer = true;
  checks.mobileNoHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
  checks.noBrowserErrors = errors.length === 0;
} catch {
  process.exitCode = 1;
  checks.browserAcceptance = false;
} finally {
  await browser.close();
  for (const device of store.devices()) if (device.name === name) store.revoke(device.id);
  store.close();
  history.close();
  await writeFile(
    '.test-output/v2-public-browser.json',
    JSON.stringify({ checks, errors, physicalPhone: false }, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(checks));
}
