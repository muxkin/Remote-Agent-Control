import { privateOutput } from './private-output.js';
await privateOutput('.test-output');
/** Isolated browser acceptance: projects, model/speed/plan, multi-skill native input. */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:net';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixtureConfig, historyFixture, FakeTransport, THREAD, TURN, state } from '../test/helpers.js';
import { Store } from '../src/server/store.js';
import { HistoryIndex } from '../src/server/history.js';
import { DesktopAdapter } from '../src/server/desktop.js';
import { buildGateway } from '../test/legacy/gateway.js';
const c = fixtureConfig();
historyFixture(c);
const db = new DatabaseSync(join(c.codexHome, 'state_5.sqlite'));
const project = '11111111-1111-4111-8111-111111111111';
db.prepare('INSERT INTO projects VALUES (?,?,?)').run(project, '手机控制项目', 0);
db.prepare('UPDATE threads SET project_id=?,cwd=?').run(project, c.desktopRoot);
db.close();
await writeFile(
  join(c.codexHome, 'models_cache.codex_work_desktop.json'),
  JSON.stringify({
    models: ['desktop-model', 'fast-model'].map((slug) => ({
      slug,
      display_name: slug,
      visibility: 'list',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
      default_reasoning_level: 'low',
      service_tiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }],
    })),
  }),
);
for (const name of ['inspect', 'report']) {
  const path = join(c.codexHome, 'skills', name);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 手机测试技能 ${name}\n---\nFixture only.\n`,
  );
}
const pluginRoot = join(c.codexHome, 'plugins/cache/remote/sample');
await mkdir(join(pluginRoot, '1.0/.codex-plugin'), { recursive: true });
await writeFile(
  join(pluginRoot, '.codex-remote-plugin-install.json'),
  JSON.stringify({ remote_plugin_id: 'sample-remote' }),
);
await writeFile(
  join(pluginRoot, '1.0/.codex-plugin/plugin.json'),
  JSON.stringify({ name: 'sample', description: '只用于隔离测试', interface: { displayName: '测试插件' } }),
);
await writeFile(join(c.codexHome, '.codex-global-state.json'), JSON.stringify({ 'queued-follow-ups': {} }));
const native = new FakeTransport();
native.current = state({
  cwd: c.desktopRoot,
  latestReasoningEffort: 'low',
  latestThreadSettings: { serviceTier: 'default' },
  latestCollaborationMode: { mode: 'default' },
});
const originalRequest = native.request;
native.request = async (...args) => {
  if (args[0] === 'thread-follower-update-thread-settings') {
    native.calls.push({ method: args[0], params: args[1] });
    const s = args[1].threadSettings;
    native.current.latestModel = s.model;
    native.current.latestReasoningEffort = s.effort;
    native.current.latestThreadSettings = s;
    native.current.latestCollaborationMode = s.collaborationMode;
    native.revision++;
    native.snapshot();
    return { result: { applied: true } };
  }
  if (args[0] === 'thread-follower-read-model-settings')
    return {
      result: {
        settings: {
          model: native.current.latestModel,
          reasoningEffort: native.current.latestReasoningEffort,
        },
      },
    };
  if (args[0] === 'thread-follower-start-turn') {
    native.calls.push({ method: args[0], params: args[1] });
    const request = args[1].turnStart.request;
    native.current.turnHistory.history.entitiesByKey.one = {
      turnId: TURN,
      status: 'completed',
      params: request,
      items: [
        {
          type: 'userMessage',
          id: 'skill-message',
          content: request.input,
          clientUserMessageId: request.clientUserMessageId,
        },
        { type: 'agentMessage', id: 'skill-result', text: '技能已收到' },
      ],
    };
    native.revision++;
    native.snapshot();
    return { result: { result: { turn: { id: TURN } } } };
  }
  if (args[0] === 'thread-follower-set-queued-follow-ups-state') {
    native.calls.push({ method: args[0], params: args[1] });
    await writeFile(
      join(c.codexHome, '.codex-global-state.json'),
      JSON.stringify({ 'queued-follow-ups': args[1].state }),
    );
    return { result: { applied: true } };
  }
  if (args[0] === 'thread-follower-interrupt-turn') {
    native.calls.push({ method: args[0], params: args[1] });
    native.current.threadRuntimeStatus = { type: 'idle' };
    native.current.turnHistory.history.entitiesByKey.one.status = 'interrupted';
    native.revision++;
    native.snapshot();
    return { result: { interruptedTurnId: TURN } };
  }
  return originalRequest(...args);
};
const socket = createServer();
await new Promise<void>((r) => socket.listen(0, '127.0.0.1', r));
c.port = (socket.address() as any).port;
await new Promise<void>((r) => socket.close(() => r()));
c.origin = `http://127.0.0.1:${c.port}`;
c.webRoot = resolve(process.env.POCKET_TEST_WEB_ROOT ?? '.test-output/settings-web');
c.p2p = { enabled: false, stunUrls: [] };
const store = new Store(c.stateDir),
  history = new HistoryIndex(c.codexHome),
  desktop = new DesktopAdapter(c, () => native);
await desktop.start();
const app = await buildGateway(c, { store, history, desktop });
await app.listen({ host: '127.0.0.1', port: c.port });
const browser = await chromium.launch({ channel: process.env.POCKET_BROWSER_CHANNEL ?? 'chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
const report: any = {
  fixture: true,
  browser: 'Playwright regression suite; BrowserAct separate page inspection',
  checks: {},
  errors: [],
};
page.on('pageerror', (e) => report.errors.push(e.message));
const output = resolve(process.env.POCKET_TEST_OUTPUT ?? '/tmp/pocket-v2-ui');
await privateOutput(output);
try {
  await page.goto(c.origin);
  await page.getByLabel('一次性配对码').fill(store.mintPairing().code);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await expect(page.getByRole('heading', { name: '会话', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '手机控制项目 1' }).click();
  await expect(page.locator('.thread-button')).toHaveCount(1);
  await page.getByRole('button', { name: '未分类 0' }).click();
  await expect(page.getByText('此项目暂无会话')).toBeVisible();
  await page.getByRole('button', { name: '未分类 0' }).click();
  await page.getByLabel('搜索项目或会话').fill('手机控制');
  await expect(page.locator('.thread-button')).toHaveCount(1);
  await page.getByLabel('搜索项目或会话').fill('不存在的会话');
  await expect(page.getByText('没有匹配的项目或会话')).toBeVisible();
  await page.getByLabel('搜索项目或会话').fill('');
  await expect(page.locator('.project-group').first()).toBeVisible();
  report.checks.projectHierarchyAndSearch = true;
  await page.screenshot({ path: join(output, 'projects.png') });
  await page.locator('.thread-button').click();
  await expect(page.getByRole('button', { name: '工具', exact: true })).toBeVisible();
  await expect(page.locator('.composer-options')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '工具', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: '取消计划模式' })).toHaveCount(0);
  await page.getByRole('button', { name: '工具', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '工具', exact: true })).toBeVisible();
  await page.getByRole('switch', { name: '计划模式' }).click();
  await expect(page.getByRole('switch', { name: '计划模式' })).toBeChecked();
  await expect(page.getByRole('button', { name: '取消计划模式' })).toBeVisible();
  expect(native.current.latestCollaborationMode.mode).toBe('plan');
  await page.screenshot({ path: join(output, 'tools.png') });
  await page.getByRole('button', { name: '关闭工具', exact: true }).click();
  await page.getByRole('button', { name: '取消计划模式' }).click();
  await expect(page.getByRole('button', { name: '取消计划模式' })).toHaveCount(0);
  report.checks.unifiedToolsAndConfirmedPlan = true;
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择模型' })).toBeEnabled();
  await page.getByRole('button', { name: '选择模型' }).click();
  await page.getByLabel('搜索模型').fill('fast');
  await page.getByRole('radio', { name: 'fast-model fast-model' }).click();
  await page.getByRole('radio', { name: '高', exact: true }).click();
  await page.getByRole('radio', { name: '快速 · Fast', exact: true }).check();
  await page.screenshot({ path: join(output, 'settings.png') });
  await page.getByRole('button', { name: '应用到下一轮', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '模型设置' })).toHaveCount(0);
  expect(native.current.latestThreadSettings.serviceTier).toBe('priority');
  expect(native.current.latestCollaborationMode.mode).toBe('default');
  expect(native.current.latestReasoningEffort).toBe('high');
  report.checks.nativeSettingsConfirmed = true;
  await page.getByRole('button', { name: '工具', exact: true }).click();
  await page.getByRole('button', { name: '技能 选择本次使用的技能' }).click();
  await page.getByLabel('搜索技能').fill('手机测试');
  await expect(page.locator('.skill-options input')).toHaveCount(2);
  await page.locator('.skill-options input').nth(0).check();
  await page.locator('.skill-options input').nth(1).check();
  await page.screenshot({ path: join(output, 'skills.png') });
  await page.getByRole('button', { name: '关闭添加技能' }).click();
  await expect(page.locator('.composer .skill-chip')).toHaveCount(0);
  await page.getByRole('button', { name: '工具', exact: true }).click();
  await page.getByRole('button', { name: '技能 选择本次使用的技能' }).click();
  await page.getByLabel('搜索技能').fill('手机测试');
  await page.locator('.skill-options input').nth(0).check();
  await page.locator('.skill-options input').nth(1).check();
  await page.getByRole('button', { name: '添加到消息', exact: true }).click();
  await expect(page.locator('.composer .skill-chip')).toHaveCount(2);
  report.checks.multiselectAndCancel = true;
  await page.getByRole('button', { name: '工具', exact: true }).click();
  await page.getByRole('button', { name: '插件 浏览与选择插件' }).click();
  await page.getByLabel('搜索插件').fill('测试插件');
  await page.getByRole('checkbox', { name: '测试插件' }).check();
  await page.getByRole('button', { name: '添加到消息', exact: true }).click();
  await expect(page.locator('.composer .skill-chip')).toHaveCount(3);
  await page.getByLabel('消息', { exact: true }).fill('检查测试');
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await page.locator('.thread-button').click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('检查测试');
  await expect(page.locator('.composer .skill-chip')).toHaveCount(3);
  report.checks.navigationDraft = true;
  await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
  await expect(page.getByText('技能已收到', { exact: true })).toBeVisible();
  await expect(page.locator('.composer .skill-chip')).toHaveCount(0);
  const call = native.calls.findLast((c) => c.method === 'thread-follower-start-turn');
  expect(call.params.turnStart.request.input.filter((i: any) => i.type === 'skill')).toHaveLength(2);
  expect(call.params.turnStart.request.input.filter((i: any) => i.type === 'mention')).toEqual([
    { type: 'mention', name: '测试插件', path: 'plugin://sample@remote' },
  ]);
  await expect(page.getByLabel('本条消息使用的技能').locator('.skill-chip')).toHaveCount(2);
  await expect(page.getByLabel('本条消息使用的插件').locator('.skill-chip')).toHaveCount(1);
  report.checks.nativeSkillsPluginsAndReceipt = true;
  await page.screenshot({ path: join(output, 'chat.png') });
  for (const viewport of [
    { width: 360, height: 740 },
    { width: 390, height: 430 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: '工具', exact: true }).click();
    await expect(page.getByRole('switch', { name: '计划模式' })).toBeVisible();
    const popover = await page.getByRole('dialog', { name: '工具', exact: true }).boundingBox();
    const box = await page.locator('.composer-box').boundingBox();
    expect(popover!.y + popover!.height).toBeLessThanOrEqual(box!.y);
    await page.getByRole('button', { name: '关闭工具', exact: true }).click();
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    const apply = page.getByRole('button', { name: '应用到下一轮', exact: true });
    await expect(apply).toBeVisible();
    const footer = await apply.boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(viewport.height);
    await page.getByRole('button', { name: '关闭模型设置' }).click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  native.current.threadRuntimeStatus = { type: 'active' };
  native.current.turnHistory.history.entitiesByKey.one.status = 'inProgress';
  native.revision++;
  native.snapshot();
  await expect(page.getByRole('button', { name: '中断任务', exact: true })).toBeVisible();
  await expect(page.locator('.running-actions')).toHaveCount(0);
  await page.getByLabel('消息', { exact: true }).fill('长按排队测试');
  const send = page.getByRole('button', { name: '追加指令 ↑', exact: true });
  const rect = (await send.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('');
  expect(native.calls.filter((c) => c.method === 'thread-follower-set-queued-follow-ups-state')).toHaveLength(
    1,
  );
  expect(native.calls.filter((c) => c.method === 'thread-follower-steer-turn')).toHaveLength(0);
  await page.getByLabel('消息', { exact: true }).fill('移动手指应取消长按');
  const rect2 = (await send.boundingBox())!;
  await page.mouse.move(rect2.x + 20, rect2.y + 20);
  await page.mouse.down();
  await page.mouse.move(rect2.x - 30, rect2.y - 30);
  await page.waitForTimeout(750);
  await page.mouse.up();
  expect(native.calls.filter((c) => c.method === 'thread-follower-set-queued-follow-ups-state')).toHaveLength(
    1,
  );
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('移动手指应取消长按');
  await page.getByLabel('消息', { exact: true }).fill('点击直接发送');
  await send.click();
  await expect
    .poll(() => native.calls.filter((c) => c.method === 'thread-follower-steer-turn').length)
    .toBe(1);
  expect(native.calls.filter((c) => c.method === 'thread-follower-set-queued-follow-ups-state')).toHaveLength(
    1,
  );
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '中断任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送 ↑', exact: true })).toBeVisible();
  expect(native.calls.filter((c) => c.method === 'thread-follower-interrupt-turn')).toHaveLength(1);
  report.checks.tapSteersHoldQueuesAndPauseInterrupts = true;
  report.checks.narrowKeyboardDesktop = true;
  expect(report.errors).toEqual([]);
  report.checks.noBrowserErrors = true;
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await app.close();
  desktop.stop();
  store.close();
  history.close();
  await rm(c.desktopRoot, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
