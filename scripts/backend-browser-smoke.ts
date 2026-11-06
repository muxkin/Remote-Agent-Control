import { DshBackend } from '../src/server/backends/dsh.js';
import { DshFixtureConnection } from '../test/dsh-fixture.js';
/** Isolated UI contract: Browser plugin not available; use the repository's Playwright runner. */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config, host, store, close, registry } from './v2-fixture.js';
const directory = join(tmpdir(), 'pocket-backend-ui');
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome',
  args: [`--unsafely-treat-insecure-origin-as-secure=${config.origin}`],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
const errors: string[] = [];
const failedRequests: string[] = [];
page.on('response', (response) => {
  if (response.status() >= 400)
    failedRequests.push(`${response.status()} ${new URL(response.url()).pathname}`);
});
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
const checks: string[] = [];
try {
  const pair = store.mintPairing();
  await page.goto(`${config.origin}/#pair=${pair.code}&host=${host.identity.peerId}`);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('button', { name: /测试会话/ }).click();
  await expect(page.getByLabel('消息', { exact: true })).toBeEnabled({ timeout: 20000 });
  await page.getByLabel('消息', { exact: true }).fill('codex-only-draft');
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await page.getByRole('button', { name: '← 工作台', exact: true }).click();
  await expect(page.locator('.backend-card')).toHaveCount(3);
  await page.screenshot({ path: join(directory, 'mobile-workbench.png') });
  checks.push('separate Codex and two DSH entries');
  for (const id of ['dsh-one', 'dsh-two']) {
    await page.locator('.backend-card').filter({ hasText: id }).click();
    await page.locator('.thread-button').filter({ hasText: id }).click();
    await expect(page.getByLabel('消息', { exact: true })).toBeEnabled({ timeout: 20000 });
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('');
    await page.getByLabel('消息', { exact: true }).fill(`${id}-draft`);
    await page.getByRole('button', { name: '返回会话列表' }).click();
    await page.getByRole('button', { name: '← 工作台', exact: true }).click();
  }
  await page.locator('.backend-card').filter({ hasText: 'dsh-one' }).click();
  await page.locator('.thread-button').filter({ hasText: 'dsh-one' }).click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('dsh-one-draft');
  await page.reload();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('dsh-one-draft');
  expect(new URL(page.url()).searchParams.get('backend')).toBe('dsh-one');
  checks.push('same native ID keeps drafts and deep links isolated');
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await page
    .getByRole('navigation', { name: '主要功能' })
    .getByRole('button', { name: '我的', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: '主要功能' })
    .getByRole('button', { name: '工作台', exact: true })
    .click();
  await page.locator('.thread-button').filter({ hasText: 'dsh-one' }).click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('dsh-one-draft');
  expect(new URL(page.url()).searchParams.get('backend')).toBe('dsh-one');
  checks.push('module switching retains the selected DSH instance');
  await page.screenshot({ path: join(directory, 'mobile-dsh-chat.png') });
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await page.getByRole('button', { name: '← 工作台', exact: true }).click();
  await page.locator('.backend-card').filter({ hasText: 'Codex' }).click();
  await page.getByRole('button', { name: /测试会话/ }).click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('codex-only-draft');
  checks.push('legacy Codex draft retained');
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await page.getByRole('button', { name: '← 工作台', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: join(directory, 'desktop-workbench.png') });
  const native = (registry.get('dsh-two') as DshBackend).connection as DshFixtureConnection;
  native.hideInitial = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.backend-card').filter({ hasText: 'dsh-two' }).click();
  await page.getByRole('button', { name: '刷新会话', exact: true }).click();
  await expect(page.locator('.thread-button')).toHaveCount(0);
  await page.getByRole('button', { name: '新会话', exact: true }).click();
  const composer = page.locator('.new-conversation-sheet');
  await composer.getByPlaceholder('发送第一条消息，开始新会话…').fill('first message');
  await composer.getByRole('button', { name: '发送 ↑', exact: true }).click();
  await expect.poll(() => native.calls.filter((c) => c.endpoint === 'session/create').length).toBe(1);
  await expect(composer).toBeHidden();
  await expect(page.getByLabel('消息', { exact: true })).toBeEnabled();
  expect(new URL(page.url()).searchParams.get('backend')).toBe('dsh-two');
  expect(new URL(page.url()).searchParams.get('thread')).not.toBe('new');
  checks.push('creates and opens the first conversation in an empty DSH instance');
  await page.screenshot({ path: join(directory, 'mobile-dsh-created.png') });
  expect(await page.title()).toBeTruthy();
  expect(await page.locator('body').innerText()).toContain('新会话');
  expect(await page.locator('vite-error-overlay').count()).toBe(0);
  expect(errors).toEqual([]);
  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify({ checks, errors, viewports: ['390x844', '1440x900'], fixture: true }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors, evidence: directory }));
} catch (error) {
  await writeFile(
    join(directory, 'failure.json'),
    JSON.stringify({ errors, failedRequests, body: await page.locator('body').innerText() }, null, 2),
  );
  await page.screenshot({ path: join(directory, 'failure.png') });
  throw error;
} finally {
  await browser.close();
  await close();
}
