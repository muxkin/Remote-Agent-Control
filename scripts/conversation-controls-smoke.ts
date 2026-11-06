/** Isolated DSH controls UI regression; no production feedback or agent execution. */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
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
  await page.locator('.backend-card').filter({ hasText: 'dsh-one' }).click();
  await page
    .getByRole('button', { name: /same ID|dsh-one/ })
    .last()
    .click();
  await expect(page.getByLabel('会话控制', { exact: true })).toBeVisible();
  await page.getByLabel('会话控制', { exact: true }).click();
  await expect(page.getByLabel('会话权限', { exact: true })).toBeVisible();
  await page.getByLabel('会话权限', { exact: true }).selectOption('read-only');
  await expect(page.getByLabel('会话权限', { exact: true })).toHaveValue('read-only');
  await expect(page.getByRole('button', { name: '进入计划模式', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '进入计划模式', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出计划模式', exact: true })).toBeVisible();
  await expect(page.getByText('目标', { exact: true })).toBeVisible();
  await expect(page.getByText('反馈', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '下载日志 ZIP' })).toBeVisible();
  await mkdir('/tmp/remote-controls-qa', { recursive: true });
  await page.screenshot({ path: '/tmp/remote-controls-qa/mobile.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: '/tmp/remote-controls-qa/desktop.png' });
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ permission: true, plan: true, menu: true, errors }));
} finally {
  await browser.close();
  await close();
}
