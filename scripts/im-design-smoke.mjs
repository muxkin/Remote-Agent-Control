import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildRelay } from '../src/server/relay.ts';
import { mathCopyFixture, verifyMathCopy } from './lib/math-copy-smoke.ts';
import {
  saveRecoveryCode,
  registerAgentFixture,
  browserAccountFixture,
  messagingFixtureRequest,
} from './lib/messaging-smoke.ts';
// Synthetic artwork keeps this check reproducible without personal files.
const artwork = new PNG({ width: 64, height: 64 });
for (let i = 0; i < artwork.data.length; i += 4) artwork.data.set([22, 120, 102, i % 128 ? 255 : 0], i);
const image = PNG.sync.write(artwork);
const host = process.env.TEST_BIND ?? '127.0.0.1',
  port = Number(process.env.TEST_PORT ?? 18937),
  origin = `http://${host}:${port}`,
  out = process.env.TEST_OUTPUT ?? join(tmpdir(), 'pocket-im-design-qa');
await mkdir(out, { recursive: true });
const dir = await mkdtemp(join(tmpdir(), 'im-design-'));
const relay = await buildRelay({
  messaging: { humanContacts: true }, // Explicit optional social-mode fixture.
  origin,
  webRoot: resolve(process.env.TEST_WEB_ROOT ?? 'dist/web'),
  assetOrigin: null,
  uploadOrigins: [],
  database: join(dir, 'relay.sqlite'),
  enrollmentSecret: 'isolated-design-validation-secret',
});
await relay.app.listen({ host, port });
const browser = await chromium.launch({
  channel: 'chrome',
  args: [`--unsafely-treat-insecure-origin-as-secure=${origin}`],
});
const context = await browser.newContext({ viewport: { width: 1488, height: 1056 } }),
  page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (message) => {
  // The fixture and browser can pin the same contact concurrently; the client retries this CAS conflict.
  const pinConflict =
    /\/api\/im\/crypto\/items\//.test(message.location().url) && /409 \(Conflict\)/.test(message.text());
  if (message.type() === 'error' && !pinConflict) errors.push(message.text());
});
let agentClient, humanClient;
async function req(p, body) {
  return messagingFixtureRequest(agentClient, p, body ? 'POST' : 'GET', body);
}
async function human(p, body) {
  return messagingFixtureRequest(humanClient, p, 'POST', body);
}
try {
  await page.goto(origin + '/?page=messages');
  await page.getByLabel('昵称', { exact: true }).fill('小青');
  await page.getByLabel('用户名', { exact: true }).fill('qing-design');
  await page.getByLabel('密码', { exact: true }).fill('design-test-password');
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await saveRecoveryCode(page);
  humanClient = await browserAccountFixture(page, origin, 'design-test-password');
  await expect(page.getByText('还没有聊天记录', { exact: true })).toBeVisible();
  const invitation = await human('/agent-invitations', {}),
    agent = await registerAgentFixture(origin, {
      invitation: invitation.invitation,
      username: 'assistant-design',
      displayName: '研究助手',
    });
  agentClient = agent.client;
  const { conversation } = await human('/conversations', { userId: agent.user.id }),
    cid = conversation.id;
  const avatar = image;
  const ar = await fetch(origin + '/api/im/me/avatar', {
    method: 'POST',
    headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/octet-stream' },
    body: avatar,
  });
  expect(ar.status).toBe(200);
  await human(`/conversations/${cid}/messages`, {
    clientId: '1',
    text: '早上好，今天一起把聊天体验再完善一点吧。',
  });
  await req(
    `/conversations/${cid}/messages`,
    {
      clientId: '2',
      text: '早上好！可以呀，我们从图片和表情开始。\n\n图片可以直接放大查看，也能保留原图下载。',
    },
    agent.token,
  );
  const sticker = image;
  const { file } = await agentClient.upload(cid, '开心.png', sticker);
  const saved = await agentClient.saveSticker(cid, file.id);
  await req(
    `/conversations/${cid}/messages`,
    { clientId: '3', stickerId: saved.stickers[0].id },
    agent.token,
  );
  await human(`/conversations/${cid}/messages`, { clientId: '4', text: '这样舒服多了 😊' });
  await page.reload();
  await page
    .getByRole('button', { name: /研究助手/ })
    .first()
    .click();
  await expect(page.locator('.is-sticker img')).toBeVisible();
  await expect(page.locator('.im-message .im-avatar img').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '更多功能', exact: true })).toHaveCount(0);
  await expect(page.locator('.im-compose-wrap .upload-button')).toBeVisible();
  await expect(page.getByRole('button', { name: '语音消息', exact: true })).toBeVisible();
  const removed = await fetch(origin + '/api/im/me/avatar', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${agent.token}` },
  });
  if (!removed.ok) throw Error('avatar removal failed');
  await expect(page.locator('.im-message .im-avatar img')).toHaveCount(0);
  await fetch(origin + '/api/im/me/avatar', {
    method: 'POST',
    headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/octet-stream' },
    body: avatar,
  });
  await expect(page.locator('.im-message .im-avatar img').first()).toBeVisible();
  await page.screenshot({ path: out + '/desktop-chat.png' });
  await page.getByRole('button', { name: '表情与表情包', exact: true }).click();
  await expect(page.getByRole('region', { name: '表情与 Emoji' })).toBeVisible();
  await page.screenshot({ path: out + '/desktop-emoji.png' });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const panel = await page.locator('.im-expression-panel').boundingBox();
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: out + `/mobile-${width}.png` });
  }

  await page.getByRole('button', { name: '关闭表情', exact: true }).click();
  const formula = await agentClient.send(
    cid,
    String.raw`> Defect energy:
>
> \[
> E_{\mathrm d}^{\mathrm{sc}} = E_D^{\mathrm{sc}} - E_0^{\mathrm{sc}} - \sum_i \Delta N_i\mu_i.
> \]
>
> Al₇Cu₅Sc–Al₂Cu–Al₃Sc

\[
\int_0^\infty \frac{a_1+b_2+c_3+d_4+e_5+f_6+g_7+h_8+i_9+j_{10}+k_{11}+l_{12}}{1+x^2}\,dx \tag{2}
\]`,
    'formula-layout',
  );
  const mathMessage = page.locator(`[data-message-id="${formula.message.id}"]`);
  await expect(mathMessage.locator('.katex-display')).toHaveCount(2);
  for (const width of [1488, 420, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await mathMessage.evaluate(async (el) => {
      await document.fonts.ready;
      const formula = el.querySelector('.katex');
      const script = formula.querySelector('.katex-sizing.size3');
      const displays = [...el.querySelectorAll('.katex-display')];
      return {
        scriptRatio:
          parseFloat(getComputedStyle(script).fontSize) / parseFloat(getComputedStyle(formula).fontSize),
        chemistry: el.querySelectorAll('.chemical-formula sub').length,
        legacy: el.querySelectorAll('.sizing').length,
        overflow: document.documentElement.scrollWidth > innerWidth,
        reachable: displays.every(
          (display) =>
            display.querySelector('.katex').getBoundingClientRect().left >=
            display.getBoundingClientRect().left - 1,
        ),
        fonts: [...document.fonts]
          .filter((font) => font.family.startsWith('KaTeX') && font.status === 'loaded')
          .map((font) => font.family),
      };
    });
    expect(metrics.scriptRatio).toBeCloseTo(0.7, 2);
    expect(metrics.chemistry).toBe(4);
    expect(metrics.legacy).toBe(0);
    expect(metrics.overflow).toBe(false);
    expect(metrics.reachable).toBe(true);
    expect(metrics.fonts).toContain('KaTeX_Main');
    if (width === 320) {
      const display = mathMessage.locator('.katex-display').last();
      expect(await display.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      expect(
        await display.evaluate((el) => {
          el.scrollLeft = el.scrollWidth;
          return el.scrollLeft;
        }),
      ).toBeGreaterThan(0);
    }
  }
  await expect(page.getByRole('navigation', { name: '会话提问导航' })).toHaveCount(0);
  await page.screenshot({ path: out + '/mobile-math.png' });
  await page.setViewportSize({ width: 1488, height: 1056 });
  const copyFixture = await agentClient.send(cid, mathCopyFixture, 'formula-copy');
  await verifyMathCopy(page, page.locator(`[data-message-id="${copyFixture.message.id}"]`));
  expect(errors).toEqual([]);
  await writeFile(
    out + '/result.json',
    JSON.stringify(
      {
        avatar: true,
        borderlessSticker: true,
        nonModal: true,
        emptyInteractionHidden: true,
        responsive: [390, 320],
        mathTypography: true,
        mathCopy: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log('Visual fixtures and avatar/panel checks passed');
} finally {
  await browser.close();
  await relay.app.close();
  await rm(dir, { recursive: true, force: true });
}
