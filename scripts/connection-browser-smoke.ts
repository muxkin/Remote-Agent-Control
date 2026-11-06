/** Browser plugin not available; isolated Playwright transport/update regression. */
import { DEFAULT_BACKEND } from '../src/shared/backends.js';
import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config, host, store, native, close, registry } from './v2-fixture.js';

const output = join(tmpdir(), 'pocket-connection-regression');
await mkdir(output, { recursive: true });
const published = JSON.parse(await readFile(join(config.webRoot, 'version.json'), 'utf8')).buildId;
let version = published;
// An older gateway may still send its own local build. New clients must ignore it.
const backend = registry.get(DEFAULT_BACKEND),
  status = backend.status.bind(backend);
backend.status = () => ({ ...status(), webBuildId: 'ffffffffffffffff' });
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
  const state = ((window as any).__connectionTest = {
    sockets: [] as WebSocket[],
    peers: [] as RTCPeerConnection[],
    blockRelay: false,
  });
  const WS = window.WebSocket,
    PC = window.RTCPeerConnection;
  window.WebSocket = class extends WS {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      state.sockets.push(this);
      this.addEventListener('open', () => {
        if (state.blockRelay) this.close();
      });
    }
  };
  window.RTCPeerConnection = class extends PC {
    constructor(configuration?: RTCConfiguration) {
      super(configuration);
      state.peers.push(this);
    }
  };
});
const page = await context.newPage(),
  errors: string[] = [],
  checks: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
await page.route('**/version.json', (route) =>
  route.fulfill({ json: { buildId: version }, headers: { 'Cache-Control': 'no-store' } }),
);
const input = page.getByLabel('消息', { exact: true }),
  notice = page.getByRole('status', { name: '网页更新提示' });
function update(text: string) {
  native.current.turnHistory.history.entitiesByKey.one.items.push({ type: 'agentMessage', id: text, text });
  native.revision++;
  native.snapshot();
}
try {
  await page.goto(`${config.origin}/#pair=${store.mintPairing().code}&host=${host.identity.peerId}`);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('button', { name: /测试会话/ }).click();
  await expect(input).toBeEnabled({ timeout: 20000 });
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(input).toBeEnabled({ timeout: 20000 });
  await expect(notice).toHaveCount(0);
  checks.push('local gateway build mismatch does not request a refresh, including after reload');
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as any).__connectionTest.peers.some(
            (p: RTCPeerConnection) => p.connectionState === 'connected',
          ),
        ),
      { timeout: 20000 },
    )
    .toBe(true);
  await page.evaluate(() => {
    const state = (window as any).__connectionTest;
    state.blockRelay = true;
    state.sockets.forEach((s: WebSocket) => s.close());
  });
  update('Direct channel still delivers live text');
  await expect(page.getByText('Direct channel still delivers live text', { exact: true })).toBeVisible();
  await expect(input).toBeEnabled();
  await expect(page.getByText('连接中断，正在恢复；控制暂不可用', { exact: true })).toHaveCount(0);
  checks.push('relay loss preserves live direct messages and online controls');
  await input.fill('draft survives transport recovery');
  await page.evaluate(() =>
    (window as any).__connectionTest.peers.forEach((p: RTCPeerConnection) => p.close()),
  );
  await expect(input).toBeDisabled({ timeout: 15000 });
  await expect(page.getByText('连接中断，正在恢复；控制暂不可用', { exact: true })).toBeVisible();
  checks.push('loss of both channels disables controls and shows recovery');
  await page.evaluate(() => {
    (window as any).__connectionTest.blockRelay = false;
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('pageshow'));
  });
  await expect(input).toBeEnabled({ timeout: 20000 });
  await expect(input).toHaveValue('draft survives transport recovery');
  update('Recovered live stream');
  await expect(page.getByText('Recovered live stream', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-head .dot')).toHaveClass(/online/);
  checks.push('reconnection restores live messages and controls without losing draft');
  version = 'eeeeeeeeeeeeeeee';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(notice).toBeVisible();
  await expect(notice.getByRole('button', { name: '刷新页面' })).toBeDisabled();
  await input.fill('');
  await expect(notice.getByRole('button', { name: '刷新页面' })).toBeEnabled();
  checks.push('published version change shows refresh notice and protects unsent draft');
  version = published;
  await notice.getByRole('button', { name: '刷新页面' }).click();
  await expect(input).toBeEnabled({ timeout: 20000 });
  await expect(notice).toHaveCount(0);
  checks.push('refresh rechecks the served version and retains pairing');
  await expect(page).toHaveTitle('Agent 空间');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: join(output, 'mobile-recovered.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(input).toBeEnabled();
  await page.screenshot({ path: join(output, 'desktop-recovered.png') });
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify({ checks, errors, fixture: true, viewports: ['390x844', '1440x900'] }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors, evidence: output }));
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') });
  console.error(JSON.stringify({ errors, checks }));
  throw error;
} finally {
  await browser.close();
  await close();
}
