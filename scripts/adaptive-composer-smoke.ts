/** Isolated responsive layout and clipboard/active-turn attachment acceptance. */
import { chromium, expect } from '@playwright/test';
import { PNG } from 'pngjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { config, host, store, native, close } from './v2-fixture.js';
const browser = await chromium.launch({
  channel: 'chrome',
  args: [`--unsafely-treat-insecure-origin-as-secure=${config.origin}`],
});
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await context.newPage();
const checks: Record<string, boolean> = {},
  errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const fixtureImage = new PNG({ width: 8, height: 8 });
fixtureImage.data.fill(255);
const png = PNG.sync.write(fixtureImage).toString('base64');
const tab = (name: string) =>
  page.getByRole('navigation', { name: '主要功能' }).getByRole('button', { name, exact: true });
async function pasteImage() {
  await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) }),
    ]);
  }, png);
  await page.getByLabel('消息', { exact: true }).focus();
  await page.keyboard.press('Control+V');
  await expect(page.locator('.upload-chip')).toHaveCount(1, { timeout: 20000 });
}
try {
  const pair = store.mintPairing();
  await page.goto(`${config.origin}/#pair=${pair.code}&host=${host.identity.peerId}`);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('button', { name: /测试会话/ }).click();
  await expect(page.getByLabel('消息', { exact: true })).toBeEnabled({ timeout: 20000 });
  const [filePicker] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.composer .upload-button').click(),
  ]);
  await filePicker.setFiles([]);
  const tools = page.getByRole('button', { name: '工具', exact: true });
  await tools.click();
  await expect(page.getByRole('dialog', { name: '工具', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tools).toBeFocused();
  // Same page adapts through wide desktop, compact desktop, mobile and short landscape windows.
  for (const size of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 800, height: 600 },
    { width: 390, height: 844 },
    { width: 430, height: 844 },
    { width: 320, height: 500 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(size);
    await expect
      .poll(() => page.locator('.app-shell').evaluate((el) => Math.round(el.getBoundingClientRect().height)))
      .toBe(size.height);
    const shell = await page.locator('.app-shell').boundingBox();
    expect(shell!.x).toBe(0);
    expect(shell!.width).toBe(size.width);
    const nav = await page.locator('.bottom-navigation').boundingBox();
    const chat = await page.locator('.chat').boundingBox();
    const composer = await page.locator('.composer').boundingBox();
    const send = await page.locator('.composer .send-button').boundingBox();
    const compact = await page
      .locator('.composer-box')
      .evaluate(
        (el) =>
          el.clientWidth -
            parseFloat(getComputedStyle(el).paddingLeft) -
            parseFloat(getComputedStyle(el).paddingRight) <=
          520,
      );
    for (const selector of ['.permission-trigger > span', '.composer-tool-trigger > span']) {
      if (compact) await expect(page.locator(selector)).toBeHidden();
      else await expect(page.locator(selector)).toBeVisible();
    }
    for (const name of ['会话权限', '工具'])
      await expect(page.getByRole('button', { name, exact: true })).toBeInViewport();
    const model = await page.getByRole('button', { name: '模型设置', exact: true }).boundingBox();
    expect(model!.x + model!.width).toBeLessThanOrEqual(send!.x);
    if (size.width > 700) {
      for (const name of ['消息', '工作台', '我的']) await expect(tab(name)).toBeVisible();
      expect(nav!.x).toBe(0);
      expect(nav!.width).toBe(80);
      const sidebar = await page.locator('.sidebar').boundingBox();
      expect(sidebar!.x).toBe(nav!.width);
      expect(chat!.x).toBe(sidebar!.x + sidebar!.width);
      expect(chat!.x + chat!.width).toBe(size.width);
    } else {
      await expect(page.locator('.sidebar')).toBeHidden();
      expect(chat!.x).toBe(0);
      await expect(page.locator('.bottom-navigation')).toBeHidden();
      expect(composer!.y + composer!.height).toBe(size.height);
      await page.getByRole('button', { name: '返回会话列表' }).click();
      for (const name of ['消息', '工作台', '我的']) await expect(tab(name)).toBeVisible();
      await page.getByRole('button', { name: /测试会话/ }).click();
      await expect(page.locator('.bottom-navigation')).toBeHidden();
    }
    expect(send!.y + send!.height).toBeLessThanOrEqual(size.height);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollHeight <= innerHeight &&
          document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  checks.adaptiveNavigationAndIndependentPanels = true;
  checks.compactComposerIconsAndModelSpace = true;
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByLabel('消息', { exact: true }).fill('draft with image');
  await pasteImage();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('draft with image');
  await tab('我的').click();
  await tab('工作台').click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('draft with image');
  await expect(page.locator('.upload-chip')).toHaveCount(1);
  checks.clipboardAndModuleSwitchPreserveDraft = true;
  await page.locator('.composer .send-button').click();
  await expect
    .poll(() => native.calls.filter((c) => c.method === 'thread-follower-start-turn').length)
    .toBe(1);
  const initial = native.calls.find((c) => c.method === 'thread-follower-start-turn').params.turnStart.request
    .input;
  expect(initial.some((i: any) => i.type === 'localImage')).toBe(true);
  await expect(page.locator('.upload-chip')).toHaveCount(0);
  checks.pastedImageUsesExistingUploadAndNativeInput = true;
  native.current.threadRuntimeStatus = { type: 'active' };
  native.current.turnHistory.history.entitiesByKey.one.status = 'inProgress';
  native.revision++;
  native.snapshot();
  await expect(page.getByPlaceholder('给当前任务追加指令…')).toBeEnabled();
  await pasteImage();
  await page.locator('input[type=file]').setInputFiles({
    name: 'running-note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('active attachment fixture'),
  });
  await expect(page.locator('.upload-chip')).toHaveCount(2);
  await page.getByLabel('消息', { exact: true }).fill('');
  await mkdir('/tmp/pocket-adaptive-qa', { recursive: true });
  await page.screenshot({ path: '/tmp/pocket-adaptive-qa/desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/pocket-adaptive-qa/mobile.png' });
  await expect(page.locator('.composer .send-button')).toBeEnabled();
  await page.locator('.composer .send-button').click();
  await expect
    .poll(() => native.calls.filter((c) => c.method === 'thread-follower-steer-turn').length)
    .toBe(1);
  const steered = native.calls.find((c) => c.method === 'thread-follower-steer-turn').params;
  expect(steered.input.some((i: any) => i.type === 'localImage')).toBe(true);
  expect(steered.attachments).toHaveLength(2);
  const note = steered.attachments.find((f: any) => f.label === 'running-note.txt');
  expect(await readFile(note.path, 'utf8')).toBe('active attachment fixture');
  await expect(page.locator('.upload-chip')).toHaveCount(0);
  checks.runningImageAndFileSubmitTogetherWithoutText = true;
  expect(errors).toEqual([]);
  checks.noBrowserErrors = true;
} catch (e) {
  errors.push((e as Error).message);
  process.exitCode = 1;
} finally {
  await mkdir('.test-output/adaptive', { recursive: true });
  await writeFile(
    '.test-output/adaptive/results.json',
    JSON.stringify({ checks, errors, physicalPhone: false }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }));
  await browser.close();
  await close();
}
