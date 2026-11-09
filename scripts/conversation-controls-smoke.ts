/** Isolated DSH controls UI regression; no production feedback or agent execution. */
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
process.env.TEST_DSH = '1';
const { config, host, store, close } = await import('./v2-fixture.js');
const browser = await chromium.launch({
  channel: 'chrome',
  args: [`--unsafely-treat-insecure-origin-as-secure=${config.origin}`],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  const pair = store.mintPairing();
  await page.goto(`${config.origin}/#pair=${pair.code}&host=${host.identity.peerId}`);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('button', { name: '← 工作台', exact: true }).click();
  await page.getByRole('button', { name: '打开 dsh-one', exact: true }).click();
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  await page.getByRole('button', { name: /dsh-one/ }).click();
  const permission = page.getByRole('button', { name: '会话权限', exact: true });
  await expect(permission).toBeVisible();
  await permission.click();
  const menu = page.getByRole('menu', { name: '会话权限' });
  await expect(menu).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await page.getByRole('menuitemradio', { name: '只读', exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(permission).toContainText('只读');
  await permission.click();
  await expect(page.getByRole('menuitemradio', { name: '只读', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await mkdir('/tmp/remote-controls-qa', { recursive: true });
  await page.screenshot({ path: '/tmp/remote-controls-qa/mobile-permission.png' });
  const rect = await menu.boundingBox();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: '工作区内修改', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(permission).toBeFocused();
  await page.getByRole('button', { name: '工具', exact: true }).click();
  await page.getByRole('switch', { name: '计划模式' }).click();
  await expect(page.getByRole('switch', { name: '计划模式' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: '目标', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '反馈', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '下载日志 ZIP' })).toBeVisible();
  await page.getByRole('button', { name: '目标', exact: true }).click();
  await expect(page.getByLabel('目标内容', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回工具' }).click();
  await page.getByRole('button', { name: '反馈', exact: true }).click();
  await expect(page.getByLabel('反馈内容')).toBeVisible();
  await page.getByRole('button', { name: '关闭工具' }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await permission.click();
  await page.screenshot({ path: '/tmp/remote-controls-qa/desktop-permission.png' });
  await page.getByRole('textbox', { name: '消息', exact: true }).click();
  await expect(menu).toBeHidden();
  await page.reload();
  await expect(permission).toContainText('只读');
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ permission: true, plan: true, menu: true, errors }));
} finally {
  await browser.close();
  await close();
}
