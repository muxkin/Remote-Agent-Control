import { privateOutput } from './private-output.js';
await privateOutput('.test-output');
/** Opt-in native command approvals; permission changes are confined to the dedicated test chat. */
import { chromium, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { readConfig } from './legacy-config.js';
import { DesktopAdapter } from '../packages/adapter-codex/src/desktop.js';
import { DesktopTransport } from '../packages/adapter-codex/src/transport.js';
import { Store } from '../src/server/store.js';
const id = process.argv[2];
if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? '') ||
  !process.argv.includes('--allow-control')
)
  throw Error('Dedicated test chat and --allow-control required');
const config = readConfig(),
  transport = new DesktopTransport(config);
const desktop = new DesktopAdapter(config, () => transport);
let raw: any;
desktop.on('state', (threadId, state) => {
  if (threadId === id) raw = state;
});
await desktop.start();
const release = await desktop.acquire(id);
const initial = await desktop.waitForView(id);
if (!initial?.canSend) throw Error('Test chat must be idle');
const original = structuredClone(raw.latestThreadSettings);
const owner = (await transport.request('thread-owner-discovery', { hostId: 'local', conversationId: id }, 1))
  .handledByClientId;
const store = new Store(config.stateDir),
  name = `临时审批验收-${randomUUID()}`;
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const report: any = { date: new Date().toISOString(), checks: {}, errors: [] };
page.on('pageerror', (e) => report.errors.push(e.message));
async function settings(threadSettings: any) {
  const reply = await transport.request(
    'thread-follower-update-thread-settings',
    { conversationId: id, threadSettings },
    2,
    owner,
    15000,
  );
  if (!reply.result?.applied) throw Error('Settings not applied');
}
try {
  await page.goto(config.origin);
  await page.getByLabel('设备名称').fill(name);
  await page.getByLabel('一次性配对码').fill(store.mintPairing().code);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  await expect(page.getByRole('heading', { name: '会话', exact: true })).toBeVisible();
  const button = page.getByRole('button', { name: initial.title, exact: false });
  for (let i = 0; i < 20 && (await button.count()) === 0; i++)
    await page.getByRole('button', { name: '加载更多会话', exact: true }).click();
  await button.first().click();
  await settings({
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'readOnly' },
    activePermissionProfile: null,
    permissions: null,
    model: 'gpt-6.1-sol',
    effort: 'low',
    collaborationMode: {
      mode: 'default',
      settings: { model: 'gpt-6.1-sol', reasoning_effort: 'low', developer_instructions: null },
    },
  });
  for (const decision of ['accept', 'decline']) {
    const marker = `POCKET_APPROVAL_${decision}_${randomUUID().slice(0, 8)}`;
    await desktop.control(
      id,
      'send',
      `执行手机审批验收。只调用一次 exec_command，cmd 为 "printf '${marker}\\n'"，sandbox_permissions 明确设为 require_escalated，justification 为“验证手机审批，仅打印测试标记”。必须先发起权限审批，不得改为普通执行。批准则汇报命令结果，拒绝则立即停止，不重试、不修改文件。`,
      randomUUID(),
    );
    console.log('Waiting for native command request:', decision);
    await expect
      .poll(() => desktop.view(id)?.requests?.some((r) => r.kind === 'command'), { timeout: 120000 })
      .toBe(true);
    const request = desktop.view(id)!.requests!.find((r) => r.kind === 'command')!;
    report[`${decision}Decisions`] = request.decisions;
    report.checks[`${decision}RequestHasCommandAndTurn`] =
      request.description.includes(marker) && !!request.turnId;
    const card = page.locator('[data-request-kind=command]');
    await expect(card).toBeVisible();
    await expect(card).toContainText(marker);
    await card
      .getByRole('button', { name: decision === 'accept' ? '允许本次' : '拒绝', exact: true })
      .click();
    await expect(card).toHaveCount(0, { timeout: 15000 });
    await expect.poll(() => desktop.view(id)?.activeTurnId, { timeout: 120000 }).toBeNull();
    report.checks[`${decision}NativeResolved`] = true;
    // Output is recorded separately from the command/arguments, so only tool text is inspected here.
    report[decision] = desktop
      .view(id)!
      .messages.filter((m) => m.turnId === request.turnId && m.role !== 'user')
      .map((m) => ({ role: m.role, text: m.text.slice(0, 300) }));
    console.log('Native request resolved:', decision);
  }
} catch (error) {
  report.error = (error as Error).message;
  report.operations = store
    .recent(store.devices().find((d) => d.name === name)?.id, id)
    .map((o) => ({ kind: o.kind, state: o.state, error: o.error }));
  report.pendingKinds = desktop.view(id)?.requests?.map((r) => r.kind);
  process.exitCode = 1;
} finally {
  const active = desktop.view(id)?.activeTurnId;
  if (active) await desktop.control(id, 'interrupt', active, randomUUID()).catch(() => {});
  await expect.poll(() => desktop.view(id)?.activeTurnId, { timeout: 15000 }).toBeNull();
  const { sandboxPolicy, permissions, activePermissionProfile, ...restoredSettings } = original;
  await settings({
    ...restoredSettings,
    ...(activePermissionProfile?.id
      ? { permissions: activePermissionProfile.id }
      : { sandboxPolicy, permissions: null }),
  });
  await expect
    .poll(() =>
      JSON.stringify([
        raw.latestThreadSettings.approvalPolicy,
        raw.latestThreadSettings.model,
        raw.latestThreadSettings.sandboxPolicy.type,
        raw.latestThreadSettings.activePermissionProfile,
      ]),
    )
    .toBe(
      JSON.stringify([
        original.approvalPolicy,
        original.model,
        original.sandboxPolicy.type,
        original.activePermissionProfile,
      ]),
    );
  report.checks.settingsRestored =
    raw.latestThreadSettings.model === original.model &&
    raw.latestThreadSettings.sandboxPolicy.type === original.sandboxPolicy.type;
  report.checks.permissionProfileRestored =
    JSON.stringify(raw.latestThreadSettings.activePermissionProfile) ===
    JSON.stringify(original.activePermissionProfile);
  report.checks.noBrowserErrors = !report.errors.length;
  for (const d of store.devices()) if (d.name === name) store.revoke(d.id);
  await browser.close();
  release();
  desktop.stop();
  store.close();
  report.passed = !report.error && Object.values(report.checks).every(Boolean);
  if (!report.passed) process.exitCode = 1;
  await mkdir('.test-output', { recursive: true, mode: 0o700 });
  await writeFile('.test-output/approval-results.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
