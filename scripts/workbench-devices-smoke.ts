/** Exercise host routing with two independent simulated desktops sharing the same conversation ID. */
import { chromium, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { CodexBackend } from '../packages/adapter-codex/src/backend.js';
import { DesktopAdapter } from '../packages/adapter-codex/src/desktop.js';
import { HistoryIndex } from '../packages/adapter-codex/src/history.js';
import { BackendRegistry } from '../src/server/backends/registry.js';
import { HostService } from '../src/server/host-service.js';
import { Store } from '../src/server/store.js';
import { createIdentity } from '../src/shared/secure-channel.js';
import { FakeTransport, fixtureConfig, historyFixture, THREAD } from '../test/helpers.js';
import { saveRecoveryCode } from './lib/messaging-smoke.js';

const { config, host, store, native, close } = await import('./v2-fixture.js');
const other = fixtureConfig();
other.relay = config.relay;
historyFixture(other);
const otherStore = new Store(other.stateDir);
const otherTransport = new FakeTransport();
const registry = new BackendRegistry().register(
  new CodexBackend(other, new DesktopAdapter(other, () => otherTransport), new HistoryIndex(other.codexHome)),
);
const otherHost = new HostService(other, await createIdentity(), { store: otherStore, registry });
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : { channel: 'chrome' }),
  args: [`--unsafely-treat-insecure-origin-as-secure=${config.origin}`],
});
try {
  await registry.start();
  otherHost.start();
  for (const [transport, text] of [
    [native, '办公电脑的回复'],
    [otherTransport, '实验室电脑的回复'],
  ] as const) {
    transport.current.turnHistory.history.entitiesByKey.one.items.push({
      type: 'agentMessage',
      id: 'shared-message-id',
      text,
    });
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${config.origin}/?page=messages`);
  await page.getByLabel('昵称', { exact: true }).fill('测试账户');
  await page.getByLabel('用户名', { exact: true }).fill('workbench-fixture');
  await page.getByLabel('密码', { exact: true }).fill('workbench-fixture-password');
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await saveRecoveryCode(page);
  const workbench = () =>
    page
      .getByRole('navigation', { name: '主要功能' })
      .getByRole('button', { name: '工作台', exact: true })
      .click();
  async function pair(service: HostService, data: Store, name: string) {
    const pair = data.mintPairing();
    await page.goto(`${config.origin}/#pair=${pair.code}&host=${service.identity.peerId}`);
    await page.getByRole('button', { name: '连接电脑', exact: true }).click();
    await page.getByRole('tab', { name: '最近', exact: true }).waitFor();
    await workbench();
    const card = page
      .locator('.computer-card')
      .filter({ hasNotText: /^办公电脑/ })
      .last();
    await card.getByRole('button', { name: /^管理 / }).click();
    await card.getByRole('button', { name: '重命名' }).click();
    await card.getByLabel('电脑名称').fill(name);
    await card.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('article', { name, exact: true })).toBeVisible();
  }
  await pair(host, store, '办公电脑');
  await pair(otherHost, otherStore, '实验室电脑');
  const office = page.getByRole('article', { name: '办公电脑', exact: true });
  const lab = page.getByRole('article', { name: '实验室电脑', exact: true });
  await expect(office.getByRole('button', { name: '打开 Codex', exact: true })).toBeVisible();
  await expect(lab.getByRole('button', { name: '打开 Codex', exact: true })).toBeVisible();
  const search = page.getByRole('searchbox', { name: '搜索电脑、工具或最近会话' });
  await search.fill('实验室');
  await expect(lab).toBeVisible();
  await expect(office).toHaveCount(0);
  await search.clear();
  const desktopColumns = await page
    .locator('.computer-grid')
    .evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(desktopColumns.split(' ')).toHaveLength(2);

  await office.getByRole('button', { name: '打开 Codex', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('host')).toBe(host.identity.peerId);
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  await page.getByRole('button', { name: /测试会话/ }).click();
  await expect(page.getByText('办公电脑的回复', { exact: true })).toBeVisible();
  await expect(page.getByText('实验室电脑的回复', { exact: true })).toHaveCount(0);

  await workbench();
  await lab.getByRole('button', { name: '测试会话', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('host')).toBe(otherHost.identity.peerId);
  await expect.poll(() => new URL(page.url()).searchParams.get('thread')).toBe(THREAD);
  await expect(page.getByText('实验室电脑的回复', { exact: true })).toBeVisible();
  await expect(page.getByText('办公电脑的回复', { exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(lab).toBeVisible();
  await page.goForward();
  await expect(page.getByText('实验室电脑的回复', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('实验室电脑的回复', { exact: true })).toBeVisible();

  otherHost.stop();
  await workbench();
  await expect(lab.getByText('离线', { exact: true })).toBeVisible();
  await expect(lab.getByRole('button', { name: '打开 Codex', exact: true })).toHaveText('查看历史');
  await lab.getByRole('button', { name: '测试会话', exact: true }).click();
  await expect(page.getByText('实验室电脑的回复', { exact: true })).toBeVisible();
  await expect(page.getByLabel('消息', { exact: true })).toBeDisabled();

  await workbench();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileColumns = await page
    .locator('.computer-grid')
    .evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(mobileColumns.split(' ')).toHaveLength(1);
  expect(errors).toEqual([]);
  console.log(
    'Workbench devices: parallel discovery, scoped tool and recent links, offline history, rename, mobile grid.',
  );
} finally {
  await browser.close();
  otherHost.stop();
  await registry.stop();
  otherStore.close();
  await rm(other.desktopRoot, { recursive: true, force: true });
  await close();
}
