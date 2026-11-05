/** Bounded app layout and foreground recovery, with isolated native state. */
import { chromium, expect } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import { config, host, store, native, close } from './v2-fixture.js';
import { RpcError } from '../src/shared/rpc.js';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const checks: Record<string, boolean> = {},
  errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(`(() => {
  const original = window.visualViewport;
  const viewport = new EventTarget();
  let override;
  Object.defineProperties(viewport, {
    height: { get: () => override?.height ?? original.height },
    offsetTop: { get: () => override?.offsetTop ?? original.offsetTop },
    scale: { get: () => 1 },
  });
  window.__setVisibleViewport = (height, offsetTop = 0) => {
    override = { height, offsetTop };
    viewport.dispatchEvent(new Event('resize'));
  };
  Object.defineProperty(window, 'visualViewport', { get: () => viewport });
})();`);
async function bounds(selector: string, bottom: number, top = 0) {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(top - 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(bottom + 1);
}
try {
  const pair = store.mintPairing();
  await page.goto(`${config.origin}/#pair=${pair.code}&host=${host.identity.peerId}`);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('navigation', { name: '主要功能' }).waitFor();
  // Long project lists cannot expand the app shell and push the bottom navigation away.
  await page.locator('.sidebar nav').evaluate((el) => {
    const original = el.querySelector('.thread-button');
    if (original) for (let i = 0; i < 100; i++) el.append(original.cloneNode(true));
  });
  for (const size of [
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
    { width: 320, height: 500 },
  ]) {
    await page.setViewportSize(size);
    await page.evaluate((height) => (window as any).__setVisibleViewport(height), size.height);
    await expect
      .poll(() => page.locator('.app-shell').evaluate((el) => Math.round(el.getBoundingClientRect().height)))
      .toBe(size.height);
    await bounds('.bottom-navigation', size.height);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollHeight <= innerHeight &&
          document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  checks.longListsKeepNavigationInViewport = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (window as any).__setVisibleViewport(844));
  await page
    .getByRole('button', { name: /测试会话/ })
    .first()
    .click();
  await expect(page.getByLabel('消息', { exact: true })).toBeEnabled({ timeout: 20000 });
  native.current.turnHistory.history.entitiesByKey.one.items.push({
    type: 'agentMessage',
    id: 'long-layout',
    text: 'Long content '.repeat(20000),
  });
  native.revision++;
  native.snapshot();
  for (const visible of [
    { height: 700, top: 0 },
    { height: 390, top: 24 },
    { height: 280, top: 0 },
  ]) {
    await page.evaluate((v) => (window as any).__setVisibleViewport(v.height, v.top), visible);
    await expect
      .poll(() => page.locator('.app-shell').evaluate((el) => Math.round(el.getBoundingClientRect().height)))
      .toBe(visible.height);
    await page.getByLabel('消息', { exact: true }).fill('Unsaved input');
    await bounds('.composer-box', visible.top + visible.height, visible.top);
    await bounds('.composer .send-button', visible.top + visible.height, visible.top);
    expect(await page.evaluate(() => scrollY)).toBe(0);
  }
  checks.visualViewportKeepsComposerAndSendVisible = true;
  await page.evaluate(() => (window as any).__setVisibleViewport(844));
  // Desktop state advances while a foreground/background transition loses a sync delivery.
  native.current.threadRuntimeStatus = { type: 'notLoaded' };
  native.revision++;
  native.snapshot();
  await expect(
    page.locator('.composer .connection-note').filter({ hasText: '桌面会话尚未就绪' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复桌面会话' })).toBeVisible();
  const service = host as any,
    send = service.send;
  let dropped = false;
  service.send = function (session: any, event: any) {
    if (event.type !== 'sync') return send.call(this, session, event);
    dropped = true;
  };
  native.current.threadRuntimeStatus = { type: 'idle' };
  native.revision++;
  native.snapshot();
  await expect.poll(() => dropped).toBe(true);
  service.send = send;
  const watch = service.watch;
  let attempts = 0;
  service.watch = function (...args: any[]) {
    if (++attempts === 1) throw new RpcError('Transient watch failure', 503);
    return watch.apply(this, args);
  };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByLabel('消息', { exact: true })).toBeEnabled({ timeout: 10000 });
  await expect.poll(() => attempts, { timeout: 10000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('Unsaved input');
  checks.foregroundResyncAndSubscriptionRetryRestoreControls = true;
  service.watch = watch;
  await mkdir('.test-output/layout-recovery', { recursive: true });
  for (const height of [720, 400]) {
    await page.setViewportSize({ width: 1280, height });
    await page.evaluate((h) => (window as any).__setVisibleViewport(h), height);
    await expect
      .poll(() => page.locator('.app-shell').evaluate((el) => Math.round(el.getBoundingClientRect().height)))
      .toBe(height);
    await bounds('.composer .send-button', height);
  }
  checks.desktopComposerFitsShortWindows = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (window as any).__setVisibleViewport(844));
  await expect
    .poll(() => page.locator('.app-shell').evaluate((el) => Math.round(el.getBoundingClientRect().height)))
    .toBe(844);
  await page.screenshot({ path: '.test-output/layout-recovery/chat-mobile.png' });
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => (window as any).__setVisibleViewport(720));
  await expect
    .poll(() => page.locator('.app-shell').evaluate((el) => Math.round(el.getBoundingClientRect().height)))
    .toBe(720);
  await bounds('.bottom-navigation', 720);
  await page.screenshot({ path: '.test-output/layout-recovery/workbench-desktop.png' });
  await page.getByRole('button', { name: '新会话', exact: true }).click();
  await expect(page.getByPlaceholder('发送第一条消息，开始新会话…')).toBeVisible();
  await page.evaluate(() => (window as any).__setVisibleViewport(390, 24));
  await expect
    .poll(() => page.locator('.app-shell').evaluate((el) => Math.round(el.getBoundingClientRect().height)))
    .toBe(390);
  await bounds('.new-conversation-sheet', 414, 24);
  await bounds('.new-conversation .send-button', 414, 24);
  checks.newConversationFitsVisibleViewport = true;
  expect(errors).toEqual([]);
  checks.noBrowserErrors = true;
} catch (error) {
  errors.push((error as Error).message);
  process.exitCode = 1;
} finally {
  await mkdir('.test-output/layout-recovery', { recursive: true });
  await writeFile(
    '.test-output/layout-recovery/results.json',
    JSON.stringify({ checks, errors, physicalPhone: false }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }));
  await browser.close();
  await close();
}
