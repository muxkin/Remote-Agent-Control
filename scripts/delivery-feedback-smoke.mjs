/** Deterministic delivery faults against an isolated host, never a real conversation. */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config, host, store, registry, close } from './v2-fixture.js';
import { DeliveryError } from '../src/server/delivery-error.js';
import { RpcError } from '../src/shared/rpc.js';

const output = process.env.TEST_OUTPUT ?? join(tmpdir(), 'pocket-delivery-qa');
await mkdir(output, { recursive: true });
const backend = registry.get();
const execute = backend.execute;
const call = host.core.router.call;
let mode = 'hold',
  release,
  lastId,
  executions = 0;
backend.execute = async (_thread, _command, requestId) => {
  executions++;
  lastId = requestId;
  if (mode === 'hold') await new Promise((resolve) => (release = resolve));
  if (mode === 'uncertain') throw new DeliveryError('Fixture response lost');
  if (mode === 'rejected') throw new DeliveryError('测试拒绝：本次消息未发送', true);
  return `fixture-turn-${executions}`;
};
host.core.router.call = async function (...args) {
  const result = await call.apply(this, args);
  if (args[0].method === 'message.send' && ['late-error', 'late-receipt'].includes(mode)) {
    await expect.poll(() => store.operation(result.id)?.state).toBe('accepted');
    // Let the event reach the browser before returning the stale RPC response.
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (mode === 'late-error') throw new RpcError('Fixture lost acknowledgement', 503);
  }
  return result;
};
const browser = await chromium.launch({
  channel: 'chrome',
  args: [`--unsafely-treat-insecure-origin-as-secure=${config.origin}`],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const checks = [],
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const outgoing = page.locator('.transcript .outgoing-message');
const feedback = outgoing.locator('.delivery-feedback');
const send = page.locator('.composer .send-button');
const draft = page.getByLabel('消息', { exact: true });
async function submit(text, nextMode) {
  mode = nextMode;
  await draft.fill(text);
  await expect(send).toBeEnabled();
  const count = executions;
  await send.click();
  await expect.poll(() => executions).toBe(count + 1);
}
async function noPendingJournal() {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys(localStorage)
            .filter((key) => key.startsWith('pocket-pending:'))
            .flatMap((key) => JSON.parse(localStorage.getItem(key) || '[]')).length,
      ),
    )
    .toBe(0);
}
try {
  const pair = store.mintPairing();
  await page.goto(`${config.origin}/#pair=${pair.code}&host=${host.identity.peerId}`);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('button', { name: /测试会话/ }).click();
  await expect(draft).toBeEnabled({ timeout: 20000 });
  await submit('slow delivery fixture', 'hold');
  await expect(send).toHaveAttribute('aria-busy', 'true');
  await expect(send).toBeDisabled();
  await expect(feedback).toHaveCount(0);
  await expect(page.locator('.composer-activity')).toHaveCount(0);
  await expect(outgoing).toContainText('slow delivery fixture');
  await expect(outgoing.getByRole('status')).toContainText('正在发送');
  await expect(draft).toHaveValue('');
  await expect(draft).toBeEditable();
  await draft.fill('new draft typed while sending');
  await page.screenshot({ path: join(output, 'sending-mobile.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await send.locator('.sending-spinner').evaluate((el) => getComputedStyle(el).animationName)).toBe(
    'none',
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  release();
  await expect(send).toHaveAttribute('aria-busy', 'false');
  await expect(draft).toHaveValue('new draft typed while sending');
  await expect(feedback).toHaveCount(0);
  checks.push('slow sends move into the transcript, preserve a new draft and respect reduced motion');

  await submit('unknown outcome fixture', 'uncertain');
  await expect(feedback).toHaveClass(/waiting/);
  await expect(draft).toHaveValue('');
  await page.reload();
  await expect(feedback).toHaveClass(/waiting/);
  await expect(outgoing).toContainText('unknown outcome fixture');
  await expect(draft).toHaveValue('');
  await expect(feedback.getByRole('alert')).toHaveCount(0);
  await expect(feedback.getByRole('button', { name: '发送草稿' })).toHaveCount(0);
  const count = executions;
  await feedback.getByRole('button', { name: '核对状态', exact: true }).click();
  await expect(feedback.getByRole('button', { name: '核对状态', exact: true })).toBeEnabled();
  expect(executions).toBe(count);
  await page.screenshot({ path: join(output, 'waiting-mobile.png') });
  store.updateOperation(lastId, 'accepted', 'fixture-confirmed');
  await feedback.getByRole('button', { name: '核对状态', exact: true }).click();
  await expect(draft).toHaveValue('');
  await noPendingJournal();
  checks.push('uncertain keeps draft, only queries original ID and never resends');

  await submit('known rejection fixture', 'rejected');
  await expect(feedback).toHaveClass(/failed/);
  await expect(feedback.getByRole('alert')).toContainText('本次消息未发送');
  await expect(outgoing).toContainText('known rejection fixture');
  await expect(draft).toHaveValue('');
  await draft.fill('keep while retrying');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(feedback.getByRole('button', { name: '发送草稿', exact: true })).toBeInViewport();
  }
  mode = 'accepted';
  await feedback.getByRole('button', { name: '发送草稿', exact: true }).click();
  await expect(feedback).toHaveCount(0);
  await expect(draft).toHaveValue('keep while retrying');
  checks.push('known rejection has one actionable error and safe retry at 320/390/1440 widths');

  for (const nextMode of ['late-error', 'late-receipt']) {
    await submit(`delivery ${nextMode} fixture`, nextMode);
    await expect(draft).toHaveValue('');
    await expect(send).toHaveAttribute('aria-busy', 'false');
    await page.waitForTimeout(700);
    await expect(page.locator('.composer .error, .composer .delivery-feedback.failed')).toHaveCount(0);
    await noPendingJournal();
    checks.push(`${nextMode} does not regress accepted delivery or resurrect its pending journal`);
  }
  await page.reload();
  await expect(draft).toBeEnabled({ timeout: 20000 });
  await expect(feedback.filter({ hasText: '待确认' })).toHaveCount(0);
  await noPendingJournal();
  expect(errors).toEqual([]);
} catch (error) {
  errors.push(error.message);
  process.exitCode = 1;
} finally {
  release?.();
  backend.execute = execute;
  host.core.router.call = call;
  const result = { checks, errors, physicalPhone: false, viewports: [320, 390, 1440] };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await browser.close();
  await close();
}
