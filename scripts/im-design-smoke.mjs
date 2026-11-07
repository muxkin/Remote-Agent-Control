import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildRelay } from '../src/server/relay.ts';
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
async function req(p, body, token) {
  const r = await fetch(origin + '/api/im' + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw Error(`fixture ${r.status}`);
  return r.json();
}
async function human(p, body) {
  const r = await page.request.post(origin + '/api/im' + p, { data: body, headers: { Origin: origin } });
  return r.json();
}
try {
  await page.goto(origin + '/?page=messages');
  await page.getByLabel('昵称', { exact: true }).fill('小青');
  await page.getByLabel('用户名', { exact: true }).fill('qing-design');
  await page.getByLabel('密码', { exact: true }).fill('design-test-password');
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await expect(page.getByText('还没有聊天记录', { exact: true })).toBeVisible();
  const invitation = await human('/agent-invitations', {}),
    agent = await req('/agents/register', {
      invitation: invitation.invitation,
      username: 'assistant-design',
      displayName: '研究助手',
    });
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
  const upload = await fetch(origin + `/api/im/conversations/${cid}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${agent.token}`,
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('开心.png'),
    },
    body: sticker,
  });
  const file = (await upload.json()).file;
  const saved = await req('/stickers', { conversationId: cid, fileId: file.id }, agent.token);
  await req(
    `/conversations/${cid}/messages`,
    { clientId: '3', stickerId: saved.stickers[0].id },
    agent.token,
  );
  await human(`/conversations/${cid}/messages`, { clientId: '4', text: '这样舒服多了 😊' });
  await page.reload();
  await page.getByRole('button', { name: /研究助手/ }).first().click();
  await expect(page.locator('.is-sticker img')).toBeVisible();
  await expect(page.locator('.im-message .im-avatar img').first()).toBeVisible();
  expect(await page.getByRole('button', { name: '发起交互请求', exact: true }).count()).toBe(0);
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
  await page.getByRole('button', { name: '表情与 Emoji', exact: true }).click();
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
