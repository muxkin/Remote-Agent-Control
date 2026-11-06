/** A packed third-party adapter exercises the existing built UI without rebuilding it. */
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const directory = await mkdtemp(join(tmpdir(), 'third-adapter-ui-'));
const exec = promisify(execFile),
  npm = process.env.npm_execpath!;
const before = createHash('sha256')
  .update(await readFile(join(process.env.TEST_WEB_ROOT ?? 'dist/web', 'index.html')))
  .digest('hex');
const packed = await exec(
  process.execPath,
  [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory],
  { cwd: resolve('test/fixtures/adapter') },
);
await exec(process.execPath, [
  npm,
  'install',
  '--prefix',
  directory,
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--',
  join(directory, JSON.parse(packed.stdout)[0].filename),
]);
process.env.TEST_ADAPTER_PACKAGE = join(directory, 'node_modules/test-adapter');
const { config, host, store, registry, close } = await import('./v2-fixture.js');
const browser = await chromium.launch({
  channel: 'chrome',
  args: [`--unsafely-treat-insecure-origin-as-secure=${config.origin}`],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }),
  errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  const pair = store.mintPairing();
  await page.goto(`${config.origin}/#pair=${pair.code}&host=${host.identity.peerId}`);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('button', { name: '← 工作台', exact: true }).click();
  await page.locator('.backend-card').filter({ hasText: '第三方测试 Agent' }).click();
  await page
    .getByRole('button', { name: /Fixture conversation/ })
    .last()
    .click();
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await expect(input).toBeEnabled();
  await input.fill('third-plugin-ui-check');
  await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
  await expect(page.getByText('third-plugin-ui-check', { exact: true }).first()).toBeVisible();
  const backend = registry.get('third-agent');
  await expect.poll(async () => (await backend.history.page('shared')).messages.length).toBe(1);
  await page.reload();
  await expect(page.getByText('third-plugin-ui-check', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '工具', exact: true }).click();
  await expect(page.getByRole('button', { name: '下载日志 ZIP' })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: '计划模式' })).toHaveCount(0);
  await page.screenshot({ path: '/tmp/third-adapter-mobile.png' });
  expect(errors).toEqual([]);
  expect(
    createHash('sha256')
      .update(await readFile(join(process.env.TEST_WEB_ROOT ?? 'dist/web', 'index.html')))
      .digest('hex'),
  ).toBe(before);
  console.log(
    JSON.stringify({
      externalPackage: true,
      unchangedFrontend: true,
      thirdAgent: true,
      encryptedChat: true,
      refresh: true,
      capabilityMenus: true,
      errors,
    }),
  );
} finally {
  await browser.close();
  await close();
  await rm(directory, { recursive: true, force: true });
}
