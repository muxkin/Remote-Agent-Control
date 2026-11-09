/** Historical operation replay must never override the user's conversation selection. */
import { chromium, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config, host, store, registry, native, close } from './v2-fixture.js';
import { THREAD, TURN } from '../test/helpers.js';
import type { Operation } from '../src/shared/types.js';

const output = process.env.TEST_OUTPUT ?? join(tmpdir(), 'pocket-conversation-replay');
await mkdir(output, { recursive: true });
const second = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const branch = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const replyBranch = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const nextTurn = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const live = native.current.turnHistory.history;
live.entitiesByKey.one.items.find((item: { id: string }) => item.id === 'a1').phase = 'final_answer';
for (const item of live.entitiesByKey.one.items.filter((item: { id: string }) =>
  ['attachment', 'audio'].includes(item.id),
))
  item.phase = 'commentary';
live.islands[0].entries.push({ value: 'two' });
const completeText = '较长的回复。公式 $x^2$。\n\n' + '测试条目 '.repeat(21000) + '\n全文结束';
live.entitiesByKey.two = {
  turnId: nextTurn,
  status: 'completed',
  items: [{ type: 'agentMessage', id: 'a2', text: completeText, phase: 'final_answer' }],
};
const dbFile = join(config.codexHome, 'state_5.sqlite');
const db = new DatabaseSync(dbFile);
db.prepare(
  'INSERT INTO threads SELECT ?,name,?,cwd,updated_at_ms-1,archived,thread_source,rollout_path,project_id FROM threads WHERE id=?',
).run(second, '另一个会话', THREAD);
db.close();
const historical: Operation = {
  id: crypto.randomUUID(),
  threadId: THREAD,
  kind: 'create',
  state: 'completed',
  resultThreadId: second,
  turnId: null,
  error: null,
  createdAt: Date.now() - 86400000,
  updatedAt: Date.now() - 86400000,
};
const recent = store.recent.bind(store);
let replays = 0;
store.recent = (device, thread, backend) => {
  if (thread === THREAD) replays++;
  return [...recent(device, thread, backend), ...(thread === THREAD ? [historical] : [])];
};
const backend = registry.get(),
  execute = backend.execute.bind(backend);
const status = backend.status.bind(backend);
backend.status = () => {
  const value = status();
  return {
    ...value,
    capabilities: {
      ...value.capabilities,
      newThread: true,
      renameThread: true,
      forkThread: true,
      forkFromTurn: true,
    },
  };
};
backend.projects = async () => [];
let creations = 0,
  hold = false,
  creationId = '',
  forkTurnId: string | undefined,
  release: (() => void) | undefined;
backend.execute = async (thread, command, requestId) => {
  if (command.kind === 'rename' || command.kind === 'fork') {
    const db = new DatabaseSync(dbFile);
    try {
      if (command.kind === 'rename') {
        db.prepare('UPDATE threads SET name=? WHERE id=?').run(command.title, thread);
        return null;
      }
      forkTurnId = command.lastTurnId;
      const result = forkTurnId ? replyBranch : branch;
      db.prepare(
        'INSERT INTO threads SELECT ?,?,title,cwd,updated_at_ms+1,archived,thread_source,rollout_path,project_id FROM threads WHERE id=?',
      ).run(result, forkTurnId ? '回复分支' : '分支会话', thread);
      return result;
    } finally {
      db.close();
    }
  }
  if (command.kind !== 'create') return execute(thread, command, requestId);
  creations++;
  creationId = requestId;
  if (hold)
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  return second;
};
const browser = await chromium.launch({
  channel: 'chrome',
  args: [`--unsafely-treat-insecure-origin-as-secure=${config.origin}`],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
const errors: string[] = [],
  checks: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const title = page.locator('.chat-head .conversation-title');
const draft = page.getByLabel('消息', { exact: true });
const current = () => new URL(page.url()).searchParams.get('thread');
async function openFirst() {
  await page.getByRole('button', { name: /测试会话/ }).click();
  await expect(title).toContainText('测试会话');
  await expect(draft).toBeEnabled({ timeout: 20000 });
  expect(current()).toBe(THREAD);
}
async function create() {
  await page.getByRole('button', { name: '新会话', exact: true }).click();
  const sheet = page.locator('.new-conversation-sheet');
  await sheet.getByLabel('消息', { exact: true }).fill('isolated creation fixture');
  await sheet.locator('.send-button').click();
}
try {
  const pair = store.mintPairing();
  await page.goto(`${config.origin}/#pair=${pair.code}&host=${host.identity.peerId}`);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await openFirst();
  await expect.poll(() => replays).toBeGreaterThan(0);
  await expect(page.getByText('世界', { exact: true })).toBeVisible();
  const firstReply = page.locator('.message.assistant').filter({ hasText: '世界' });
  const copyReply = firstReply.getByRole('button', { name: '复制回复' });
  await firstReply.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expect(copyReply).toBeInViewport();
  await firstReply.screenshot({ path: join(output, 'reply-actions-desktop.png') });
  await copyReply.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('世界');
  const longReply = page.locator('.message.assistant').filter({ hasText: '较长的回复' });
  await longReply.getByRole('button', { name: '复制回复' }).click();
  await expect
    .poll(() => page.evaluate(async (full) => (await navigator.clipboard.readText()) === full, completeText))
    .toBe(true);
  await expect(page.locator('.message.user .codex-reply-actions')).toHaveCount(0);
  checks.push('completed Codex replies copy their full Markdown, including when the transcript is truncated');
  await page.reload();
  await expect(draft).toBeEnabled({ timeout: 20000 });
  expect(current()).toBe(THREAD);
  await page.getByRole('button', { name: /另一个会话/ }).click();
  await openFirst();
  await expect.poll(() => replays).toBeGreaterThanOrEqual(3);
  expect(current()).toBe(THREAD);
  checks.push('historical creation replay cannot navigate on open, reload or reselection');

  await page
    .locator('input[type=file][aria-label="添加附件"]')
    .setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('isolated attachment') });
  await expect(page.locator('.upload-chip')).toHaveCount(1);
  await expect(page.locator('.upload-progress-panel')).toHaveCount(0);
  await expect(page.getByText('附件已就绪', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: join(output, 'attachment-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, 'attachment-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '移除 note.txt', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  checks.push('completed attachments leave only their attachment chip on desktop and mobile');

  await create();
  await expect.poll(current).toBe(second);
  await expect(title).toContainText('另一个会话');
  await openFirst();
  expect(current()).toBe(THREAD);
  checks.push('a newly requested creation opens its result once, then replay stays inert');

  hold = true;
  await create();
  await expect.poll(() => creations).toBe(2);
  await page.getByRole('button', { name: '关闭新会话', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
  release!();
  await expect.poll(() => store.operation(creationId)?.state).toBe('completed');
  await page.waitForTimeout(800);
  expect(current()).toBeNull();
  checks.push('a creation finishing after the user leaves does not reopen a conversation');
  await openFirst();
  const tools = page.getByRole('button', { name: '会话工具', exact: true });
  await tools.click();
  await page.getByRole('button', { name: '会话改名', exact: true }).click();
  await page.getByLabel('会话名称').fill('已改名的测试会话');
  await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(title).toHaveText('已改名的测试会话');
  await tools.click();
  await page.getByRole('button', { name: '创建会话分支', exact: true }).click();
  await page.getByRole('button', { name: '创建分支', exact: true }).click();
  await expect.poll(current).toBe(branch);
  await expect(title).toHaveText('分支会话');
  await page.goBack();
  await expect(title).toHaveText('已改名的测试会话');
  await expect.poll(current).toBe(THREAD);
  checks.push('mobile workbench renames the original and opens a separate fork with a back entry');
  const forkReply = firstReply.getByRole('button', { name: '从这里创建分支' });
  await expect(forkReply).toBeEnabled();
  expect((await forkReply.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await firstReply.screenshot({ path: join(output, 'reply-actions-mobile.png') });
  await forkReply.click();
  await expect(page.getByText('保留截至这条回复的历史', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '创建分支', exact: true }).click();
  await expect.poll(current).toBe(replyBranch);
  expect(forkTurnId).toBe(TURN);
  await expect(title).toHaveText('回复分支');
  checks.push('mobile reply actions send the selected earlier turn as the inclusive fork boundary');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
} catch (error) {
  errors.push((error as Error).message);
  await page.screenshot({ path: join(output, 'failure.png') });
  process.exitCode = 1;
} finally {
  release?.();
  backend.execute = execute;
  store.recent = recent;
  await writeFile(join(output, 'result.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }));
  await browser.close();
  await close();
}
