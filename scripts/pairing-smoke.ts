/** Real HTTPS pairing only; never sends a message or controls a Desktop conversation. */
import { chromium, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { readConfig } from '../src/server/config.js';
import { Store } from '../src/server/store.js';

const config = readConfig();
const store = new Store(config.stateDir);
const deviceName = `临时扫码验收-${randomUUID()}`;
const output = '/tmp/codex-pocket-pairing-qa';
await mkdir(output, { recursive: true, mode: 0o700 });
const report = {
  date: new Date().toISOString(),
  checks: {} as Record<string, boolean>,
  errors: [] as string[],
};
const cli = execFileSync(
  process.execPath,
  ['--env-file-if-exists=.env', '--import', 'tsx', 'src/server/cli.ts', 'pair'],
  { encoding: 'utf8' },
);
if (!cli.includes('用手机相机扫码')) throw Error('CLI missing QR instructions');
const png = PNG.sync.read(await readFile(join(config.stateDir, 'pairing/qr.png')));
const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
if (!decoded || !decoded.data.startsWith(config.origin + '/#pair='))
  throw Error('CLI QR could not be decoded');
const code = new URLSearchParams(new URL(decoded.data).hash.slice(1)).get('pair')!;
report.checks.cliQrDecodesToConfiguredEntry = true;
const browser = await chromium.launch({ channel: process.env.POCKET_BROWSER_CHANNEL ?? 'chrome' });
const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const preview = await desktop.newPage();
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await mobile.newPage();
for (const target of [preview, page]) target.on('pageerror', (error) => report.errors.push(error.message));
try {
  await preview.goto(pathToFileURL(join(config.stateDir, 'pairing/index.html')).href);
  await expect(preview.getByRole('heading', { name: '扫码连接你的手机' })).toBeVisible();
  await expect(preview.getByRole('img', { name: '手机配对二维码' })).toBeVisible();
  await expect(preview.locator('#countdown')).toContainText(/剩余 [0-5]:[0-5]\d/);
  // Decode the QR at its actual rendered size, not just the source PNG.
  const rendered = PNG.sync.read(await preview.locator('#qr').screenshot());
  expect(jsQR(new Uint8ClampedArray(rendered.data), rendered.width, rendered.height)?.data).toBe(
    decoded.data,
  );
  report.checks.renderedDesktopQrDecodes = true;

  // Simulate opening the link decoded by the phone camera, without typing a code.
  let leakedCredential = false;
  page.on('request', (request) => {
    if (request.url().includes(code) || (request.headers().referer ?? '').includes(code))
      leakedCredential = true;
  });
  await page.goto(decoded.data);
  await expect(page.getByText('已读取配对链接，点击「连接电脑」即可。')).toBeVisible();
  await expect(page.getByLabel('一次性配对码')).toBeHidden();
  await expect(page).toHaveURL(config.origin + '/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(output, 'phone-ready.png') });
  report.checks.phoneScanNeedsNoManualCode = true;
  report.checks.noCredentialInUrlOrReferer = !leakedCredential;
  await page.getByLabel('设备名称').fill(deviceName);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  await expect(page.getByRole('heading', { name: '会话', exact: true })).toBeVisible();
  report.checks.scannedLinkPairsSuccessfully = true;

  const replay = await mobile.request.post(`${config.origin}/api/pair`, {
    headers: { Origin: config.origin },
    data: { code, name: 'scan replay' },
  });
  expect(replay.status()).toBe(401);
  report.checks.scannedLinkRemainsSingleUse = true;
  await page.getByRole('button', { name: '解除配对', exact: true }).click();
  await expect(page.getByLabel('一次性配对码')).toBeVisible();
  report.checks.manualFallbackAfterLogout = true;

  // Pairing codes are consumed; a fresh code allows checking the manual fallback.
  await page.getByLabel('设备名称').fill(deviceName);
  await page.getByLabel('一次性配对码').fill(store.mintPairing().code);
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  await expect(page.getByRole('heading', { name: '会话', exact: true })).toBeVisible();
  report.checks.manualPairingStillWorks = true;

  await preview.clock.install();
  await preview.clock.fastForward(301000);
  await expect(preview.getByText('二维码已过期', { exact: true })).toBeVisible();
  await expect(preview.locator('#qr')).toBeHidden();
  await expect(preview.locator('#link')).not.toHaveAttribute('href');
  await preview.screenshot({ path: join(output, 'expired.png') });
  report.checks.expiredPreviewHidesQrAndDisablesLink = true;
  expect(report.errors).toEqual([]);
  report.checks.noUncaughtBrowserErrors = true;
} finally {
  for (const device of store.devices()) if (device.name === deviceName) store.revoke(device.id);
  store.close();
  await browser.close();
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
