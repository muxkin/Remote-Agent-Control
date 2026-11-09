/** Frontend regression on an isolated simulated desktop; never approves a real task. */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { config, host, store, native, close } from './v2-fixture.js';
import { THREAD, TURN } from '../test/helpers.js';
import { saveRecoveryCode } from './lib/messaging-smoke.js';
import { mathCopyFixture, verifyMathCopy } from './lib/math-copy-smoke.js';
const report: any = { fixture: true, checks: {}, errors: [], physicalPhone: false };
const browser = await chromium.launch({
  channel: 'chrome',
  args: [`--unsafely-treat-insecure-origin-as-secure=${config.origin}`],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
await context.addInitScript(() => {
  const PC = window.RTCPeerConnection;
  (window as any).__peers = [];
  window.RTCPeerConnection = class extends PC {
    constructor(config?: RTCConfiguration) {
      super(config);
      (window as any).__peers.push(this);
    }
  };
});
const page = await context.newPage();
page.on('pageerror', (e) => report.errors.push(e.message));
await mkdir('.test-output/v3', { recursive: true });
async function screenshot(name: string) {
  await page.screenshot({ path: `.test-output/v3/${name}.png` });
}
async function tab(name: string) {
  await page.getByRole('navigation', { name: '主要功能' }).getByRole('button', { name, exact: true }).click();
}
async function openChat() {
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  await page.getByRole('button', { name: /测试会话/ }).click();
  await expect(page.getByRole('heading', { name: /测试会话/ })).toBeVisible();
}
try {
  await page.goto(`${config.origin}/?page=messages`);
  await page.getByLabel('昵称', { exact: true }).fill('测试账户');
  await page.getByLabel('用户名', { exact: true }).fill('frontend-fixture');
  await page.getByLabel('密码', { exact: true }).fill('frontend-fixture-password');
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await saveRecoveryCode(page);
  await expect(page.getByText('还没有聊天记录')).toBeVisible();
  const pair = store.mintPairing();
  await page.goto(`${config.origin}/#pair=${pair.code}&host=${host.identity.peerId}`);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '主要功能' })).toBeVisible();
  await expect(page.locator('.device-bar')).toHaveCount(0);
  await expect(page.getByText('清理缓存')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '添加电脑' })).toHaveCount(0);
  await screenshot('workbench');
  report.checks.quietWorkbench = true;
  await openChat();
  await expect(page.getByLabel('消息', { exact: true })).toBeEnabled({ timeout: 20000 });
  native.current.turnHistory.history.entitiesByKey.one.items.push({
    type: 'agentMessage',
    id: 'math-copy-fixture',
    text: mathCopyFixture,
  });
  native.revision++;
  native.snapshot();
  await page.setViewportSize({ width: 1440, height: 900 });
  await verifyMathCopy(page, page.locator('.message.assistant').filter({ hasText: '起始 前文' }));
  await page.setViewportSize({ width: 390, height: 844 });
  report.checks.mathCopy = true;
  await page.getByLabel('消息', { exact: true }).fill('draft-kept-between-modules');
  expect(new URL(page.url()).searchParams.get('host')).toBe(host.identity.peerId);
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as any).__peers.some((p: RTCPeerConnection) => p.connectionState === 'connected'),
        ),
      { timeout: 20000 },
    )
    .toBe(true);
  const peerCount = await page.evaluate(() => (window as any).__peers.length);
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await tab('消息');
  await expect(page.getByText('还没有聊天记录')).toBeVisible();
  await screenshot('messages');
  await tab('联系人');
  await page
    .getByRole('button', { name: '接入 Agent', exact: true })
    .filter({ hasText: '连接你的智能助手' })
    .click();
  await expect(page.getByText('让你的 Agent 加入聊天')).toBeVisible();
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await tab('我的');
  await screenshot('me');
  await expect(page.getByText(/\d+(\.\d+)? (MB|MiB|GB)/)).toHaveCount(0);
  await page.getByRole('button', { name: /个人资料/ }).click();
  await page.getByLabel('昵称').fill('测试用户');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page.getByRole('button', { name: /测试用户.*个人资料/ })).toBeVisible();
  report.checks.accountProfileAndMessagingNavigation = true;
  await tab('工作台');
  await openChat();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('draft-kept-between-modules');
  expect(await page.evaluate(() => (window as any).__peers.length)).toBe(peerCount);
  report.checks.moduleSwitchKeepsDraftAndConnection = true;
  await page.reload();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('draft-kept-between-modules');
  await expect(page.locator('.chat-head .dot')).toHaveClass(/online/, { timeout: 20000 });
  report.checks.refreshRestoresHostScopedChat = true;
  // Existing content above the old app budget must survive subsequent normal writes.
  await page.evaluate(async () => {
    const q = indexedDB.open('pocket-device-v2');
    const db = await new Promise<IDBDatabase>((resolve) => (q.onsuccess = () => resolve(q.result)));
    const tx = db.transaction('content', 'readwrite');
    tx.objectStore('content').put({
      key: 'qa-large-existing',
      value: 'retained',
      size: 320 * 1024 ** 2,
      touched: 1,
      kind: 'text',
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  native.current.turnHistory.history.entitiesByKey.one.items.push({
    type: 'agentMessage',
    id: 'normal-update',
    text: 'New content after large cache',
  });
  native.revision++;
  native.snapshot();
  await expect(page.getByText('New content after large cache', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await tab('我的');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('button', { name: /清理缓存/ })).toContainText(/320\./);
  await screenshot('settings');
  report.checks.noAppCacheBudgetOrEviction = true;
  const privateBefore = await page.evaluate(async () => {
    const q = indexedDB.open('pocket-device-v2');
    const db = await new Promise<IDBDatabase>((resolve) => (q.onsuccess = () => resolve(q.result)));
    const r = db.transaction('private').objectStore('private').getAll();
    const values = await new Promise<any[]>((resolve) => (r.onsuccess = () => resolve(r.result)));
    db.close();
    localStorage.setItem('pocket-pending:qa-protected', 'pending-id-only');
    return JSON.stringify(values);
  });
  await page.getByRole('button', { name: /清理缓存/ }).click();
  await expect(page.getByRole('status')).toContainText('缓存已清理');
  await expect(page.getByRole('button', { name: /清理缓存/ })).toContainText('0 KB');
  expect(
    await page.evaluate(async () => {
      const q = indexedDB.open('pocket-device-v2');
      const db = await new Promise<IDBDatabase>((resolve) => (q.onsuccess = () => resolve(q.result)));
      const r = db.transaction('private').objectStore('private').getAll();
      const values = await new Promise<any[]>((resolve) => (r.onsuccess = () => resolve(r.result)));
      db.close();
      return JSON.stringify(values);
    }),
  ).toBe(privateBefore);
  expect(await page.evaluate(() => localStorage.getItem('pocket-pending:qa-protected'))).toBe(
    'pending-id-only',
  );
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await tab('工作台');
  await openChat();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('draft-kept-between-modules');
  report.checks.clearOnlyContentPreservesIdentityDraftsAndOperations = true;
  // Browser storage exhaustion is not an application-level eviction or live-chat failure.
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    (window as any).__restorePut = () => (IDBObjectStore.prototype.put = original);
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'content') throw new DOMException('Simulated full disk', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  native.current.turnHistory.history.entitiesByKey.one.items.push({
    type: 'agentMessage',
    id: 'quota-update',
    text: 'Live chat still works with full cache',
  });
  native.revision++;
  native.snapshot();
  await expect(page.getByText('Live chat still works with full cache', { exact: true })).toBeVisible();
  await page.waitForTimeout(800); // Deliberately cross the coalesced cache write timer.
  await page.evaluate(() => (window as any).__restorePut());
  report.checks.storageWriteFailureKeepsLiveChat = report.errors.length === 0;
  const plan = {
    id: `implement-plan:${TURN}`,
    method: 'item/plan/requestImplementation',
    params: {
      threadId: THREAD,
      turnId: TURN,
      planContent: '# 实施计划\n\n1. 复用现有输入框。\n2. 增加模块导航。\n3. 检查草稿保留。',
    },
  };
  native.current.requests = [plan];
  native.revision++;
  native.snapshot();
  await expect(page.getByRole('button', { name: '批准并执行' })).toBeEnabled();
  await page.locator('.plan-request').scrollIntoViewIfNeeded();
  await expect(page.locator('.plan-content').getByRole('heading', { name: '实施计划' })).toBeVisible();
  await screenshot('plan');
  await page.getByRole('button', { name: '提出修改' }).click();
  await page.locator('.plan-request').getByLabel('消息', { exact: true }).fill('保留所有原有输入能力');
  await expect(page.getByRole('button', { name: '批准并执行' })).toBeDisabled();
  await page.locator('.plan-request').getByRole('button', { name: '发送 ↑', exact: true }).click();
  await expect
    .poll(
      () =>
        native.calls.filter((c) => c.method === 'thread-follower-start-turn').at(-1)?.params.turnStart.request
          .collaborationMode.mode,
    )
    .toBe('plan');
  expect(
    native.calls.filter((c) => c.method === 'thread-follower-start-turn').at(-1).params.turnStart.request
      .input[0].text,
  ).toBe('保留所有原有输入能力');
  report.checks.planRevisionUsesSharedComposerAndNativePlanMode = true;
  native.current.requests = [];
  native.revision++;
  native.snapshot();
  await expect(page.locator('.plan-request')).toHaveCount(0);
  native.current.requests = [
    { ...plan, params: { ...plan.params, planContent: plan.params.planContent + '\n4. 回归测试。' } },
  ];
  native.revision++;
  native.snapshot();
  await page.getByRole('button', { name: '批准并执行' }).click();
  await expect
    .poll(
      () =>
        native.calls.filter((c) => c.method === 'thread-follower-start-turn').at(-1)?.params.turnStart.request
          .collaborationMode.mode,
    )
    .toBe('default');
  const approved = native.calls.filter((c) => c.method === 'thread-follower-start-turn').at(-1).params
    .turnStart.request;
  expect(approved.input[0].text).toBe(
    'PLEASE IMPLEMENT THIS PLAN:\n' + native.current.requests[0].params.planContent,
  );
  expect(approved.clientUserMessageId).toMatch(/^[a-f0-9-]{36}$/);
  await expect(page.getByRole('button', { name: '批准并执行' })).toBeDisabled();
  report.checks.planApprovalUsesBoundPlanAndOperationId = true;
  native.current.requests = [];
  native.revision++;
  native.snapshot();
  await expect(page.locator('.plan-request')).toHaveCount(0);
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await screenshot('desktop');
  report.checks.responsiveNoHorizontalOverflow = true;
  report.checks.noUncaughtErrors = report.errors.length === 0;
  report.passed = Object.values(report.checks).every(Boolean);
} catch (e) {
  report.passed = false;
  report.error = (e as Error).message;
  await screenshot('failure').catch(() => {});
} finally {
  await browser.close();
  await close();
  await writeFile('.test-output/v3/results.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
