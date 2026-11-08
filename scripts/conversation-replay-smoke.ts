/** Historical operation replay must never override the user's conversation selection. */
import { chromium, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config, host, store, registry, close } from './v2-fixture.js';
import { THREAD } from '../test/helpers.js';
import type { Operation } from '../src/shared/types.js';

const output = process.env.TEST_OUTPUT ?? join(tmpdir(), 'pocket-conversation-replay');
await mkdir(output, { recursive: true });
const second = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const db = new DatabaseSync(join(config.codexHome, 'state_5.sqlite'));
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
  return { ...value, capabilities: { ...value.capabilities, newThread: true } };
};
backend.projects = async () => [];
let creations = 0,
  hold = false,
  creationId = '',
  release: (() => void) | undefined;
backend.execute = async (thread, command, requestId) => {
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
const errors: string[] = [],
  checks: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const title = page.locator('.chat-head h2');
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
