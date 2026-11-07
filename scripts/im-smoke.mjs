import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { PNG } from 'pngjs';
import { buildRelay } from '../src/server/relay.ts';
import { saveRecoveryCode, registerAgentFixture, messagingFixtureRequest } from './lib/messaging-smoke.ts';
// Isolated accounts and local relay; no live desktop or personal IM state is touched.
const bind = process.env.TEST_BIND ?? '127.0.0.1',
  port = Number(process.env.TEST_PORT ?? 18931);
const origin = `http://${bind}:${port}`,
  out = process.env.TEST_OUTPUT ?? '/tmp/pocket-im-uid-qa';
await mkdir(out, { recursive: true });
const state = await mkdtemp(join(tmpdir(), 'pocket-im-smoke-'));
const relay = await buildRelay({
  origin,
  webRoot: resolve(process.env.TEST_WEB_ROOT ?? 'dist/web'),
  database: join(state, 'relay.sqlite'),
  assetOrigin: null,
  uploadOrigins: [],
  enrollmentSecret: 'isolated-messaging-fixture-secret',
});
await relay.app.listen({ host: bind, port });
const browser = await chromium.launch({
  channel: 'chrome',
  args: [
    `--unsafely-treat-insecure-origin-as-secure=${origin}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
});
const context = await browser.newContext({ viewport: { width: 1487, height: 1058 } }),
  page = await context.newPage();
const suffix = Date.now().toString().slice(-7),
  username = `qing${suffix}`,
  friend = `lin${suffix}`;
const errors = [],
  checks = {};
page.on('pageerror', (e) => errors.push(e.message));
const agentClients = new Map();
async function api(path, method = 'GET', data, token) {
  const client = agentClients.get(token);
  if (!client) throw Error('Missing encrypted fixture client');
  return messagingFixtureRequest(client, path, method, data);
}
async function humanAPI(path, method = 'GET', data) {
  const r = await page.request.fetch(origin + '/api/im' + path, {
    method,
    headers: { Origin: origin },
    ...(data ? { data } : {}),
  });
  if (!r.ok()) throw Error(`${path}: ${r.status()} ${await r.text()}`);
  return r.json();
}
async function nav(name) {
  await page.getByRole('navigation', { name: '主要功能' }).getByRole('button', { name, exact: true }).click();
}
async function noOverflow() {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
try {
  await page.goto(origin + '/?page=messages');
  await page.getByLabel('昵称', { exact: true }).fill('小青');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill('isolated-qa-password-123');
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await saveRecoveryCode(page);
  await expect(page.getByText('还没有聊天记录', { exact: true })).toBeVisible();
  const registered = (await humanAPI('/me')).user;
  expect(registered.id).toBe('10000000');
  expect(registered.address).toBe(registered.id + '@' + new URL(origin).host);
  checks.register = true;
  await nav('联系人');
  await page.getByRole('button', { name: '接入 Agent', exact: true }).click();
  await page.getByRole('button', { name: '生成一次性邀请', exact: true }).click();
  const instructions = await page.getByLabel('Agent 注册说明').inputValue();
  const invitation = instructions.match(/一次性邀请：([^\s]+)/)?.[1];
  expect(invitation).toBeTruthy();
  const agent = await registerAgentFixture(origin, {
    invitation,
    username: `agent${suffix}`,
    displayName: '研究助手',
  });
  agentClients.set(agent.token, agent.client);
  await expect(page.locator('.im-agent-row')).toContainText('研究助手');
  // Keep invitation/credentials out of screenshots.
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: '接入 Agent', exact: true }).click();
  await expect(page.locator('.im-agent-row')).toContainText('研究助手');
  await page.screenshot({ path: out + '/desktop-agent.png' });
  await page.getByRole('button', { name: '返回', exact: true }).click();
  const friendContext = await browser.newContext(),
    friendPage = await friendContext.newPage();
  await friendPage.goto(origin + '/?page=messages');
  await friendPage.getByLabel('昵称', { exact: true }).fill('林同学');
  await friendPage.getByLabel('用户名', { exact: true }).fill(friend);
  await friendPage.getByLabel('密码', { exact: true }).fill('isolated-friend-password');
  await friendPage.getByRole('button', { name: '创建账户', exact: true }).click();
  await saveRecoveryCode(friendPage);
  await expect(friendPage.getByText('还没有聊天记录', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加联系人', exact: true }).click();
  await page.getByLabel('UID 或用户名').fill('@' + friend);
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByRole('heading', { name: '林同学', exact: true })).toBeVisible();
  await page.getByLabel('备注', { exact: true }).fill('同组的林同学');
  await page.getByRole('button', { name: '保存备注' }).click();
  await expect(page.locator('.im-person-row').filter({ hasText: '同组的林同学' })).toHaveCount(1);
  await noOverflow();
  await page.screenshot({ path: out + '/desktop-contacts.png' });
  checks.contacts = true;
  await nav('消息');
  await page.getByRole('button', { name: '新建聊天' }).click();
  await page.getByRole('button', { name: '新建群聊', exact: true }).click();
  await page.getByLabel('群名称', { exact: true }).fill('研究讨论组');
  await page.getByRole('checkbox', { name: /同组的林同学/ }).check();
  await page.getByRole('checkbox', { name: /研究助手/ }).check();
  await page.getByRole('button', { name: '创建群聊（3 人）', exact: true }).click();
  await expect(page.getByRole('heading', { name: '研究讨论组', exact: true })).toBeVisible();
  const group = (await api('/conversations', 'GET', undefined, agent.token)).conversations.find(
    (c) => c.kind === 'group',
  );
  const id = group.id;
  await page.getByLabel('聊天消息').fill('请整理这批演示数据，给出检查思路。');
  await page.locator('input[type=file]').setInputFiles({
    name: '计算结果.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('sample,energy\ndemo_a,-0.31\ndemo_b,-0.29\n'),
  });
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('请整理这批演示数据，给出检查思路。', { exact: true })).toBeVisible();
  await expect(page.locator('.im-message .file-attachment-card')).toBeVisible();
  let stream = (
    await api(
      `/conversations/${id}/messages`,
      'POST',
      { clientId: 'stream-' + suffix, state: 'streaming', text: '已收到文件，正在检查…' },
      agent.token,
    )
  ).message;
  await expect(page.getByText('正在回复…', { exact: true }).last()).toBeVisible();
  const text =
    '已收到计算结果文件。这是一组演示数据，下面展示整理流程。\n\n### 检查思路\n\n1. 核对样本名称、单位与缺失值。\n2. 汇总能量分布，保留来源标识。\n\n```python\nimport pandas as pd\n\ndf = pd.read_csv("计算结果.csv")\nsummary = df["energy"].describe()\nprint(summary)\n```';
  stream = (
    await api(
      `/conversations/${id}/messages/${stream.id}`,
      'PATCH',
      { revision: 1, text, state: 'streaming' },
      agent.token,
    )
  ).message;
  await expect(page.getByRole('heading', { name: '检查思路', exact: true })).toBeVisible();
  await expect(page.locator('.im-message pre')).toContainText('import pandas');
  await noOverflow();
  await page.screenshot({ path: out + '/desktop-chat.png' });
  checks.groupAndStreaming = true;
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByText('回复已停止', { exact: true })).toBeVisible();
  const stop = await api(`/conversations/${id}/messages/${stream.id}`, 'GET', undefined, agent.token);
  expect(stop.message.state).toBe('cancelled');
  checks.stop = true;
  const target = page.locator(`[data-message-id="${stream.id}"]`);
  await target.hover();
  await target.getByRole('button', { name: '引用回复', exact: true }).click();
  await page.getByLabel('提及成员').selectOption(agent.user.username);
  await page.getByLabel('聊天消息').fill(`@${agent.user.username} 请继续核对来源。`);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.im-message.mine .im-quote')).toHaveCount(1);
  const messages = (await api(`/conversations/${id}/messages`, 'GET', undefined, agent.token)).messages;
  expect(messages.at(-1)).toMatchObject({ replyTo: stream.id, mentions: [agent.user.id] });
  checks.replyAndMention = true;
  await page.getByRole('button', { name: '搜索聊天记录', exact: true }).click();
  await page.getByLabel('搜索关键词').fill('核对');
  await page
    .getByRole('dialog', { name: '搜索聊天记录' })
    .getByRole('button', { name: '搜索', exact: true })
    .click();
  await expect(page.locator('.im-search-results>button')).toHaveCount(2);
  await page.locator('.im-search-results>button').first().click();
  await expect(page.getByRole('dialog', { name: '消息详情' })).toBeVisible();
  await page.getByRole('dialog', { name: '消息详情' }).getByRole('button', { name: '关闭' }).click();
  await page.getByRole('dialog', { name: '搜索聊天记录' }).getByRole('button', { name: '关闭' }).click();
  checks.search = true;
  await page.getByRole('button', { name: '成员', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '群资料与成员' }).locator('.im-member')).toHaveCount(3);
  await page.screenshot({ path: out + '/desktop-members.png' });
  await page.getByRole('dialog', { name: '群资料与成员' }).getByRole('button', { name: '关闭' }).click();
  await friendPage.getByRole('button', { name: /研究讨论组/ }).click();
  await expect(friendPage.getByText('请整理这批演示数据，给出检查思路。', { exact: true })).toBeVisible();
  await friendPage.getByLabel('聊天消息').fill('收到，我会补充样本说明。');
  await friendPage.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('log').getByText('收到，我会补充样本说明。', { exact: true })).toBeVisible();
  checks.humanGroupDelivery = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow();
  await page.screenshot({ path: out + '/mobile-chat.png' });
  await expect(page.getByRole('navigation', { name: '主要功能' })).not.toBeVisible();
  await page.getByLabel('聊天消息').fill('保留的草稿');
  await page.getByRole('button', { name: '返回消息列表' }).click();
  await expect(page.getByRole('navigation', { name: '主要功能' })).toBeVisible();
  await page.getByRole('button', { name: /研究讨论组/ }).click();
  await expect(page.getByLabel('聊天消息')).toHaveValue('保留的草稿');
  await page.getByLabel('聊天消息').fill('');
  await page.setViewportSize({ width: 320, height: 740 });
  await noOverflow();
  await page.screenshot({ path: out + '/mobile-320.png' });
  checks.mobileAndDraft = true;
  await page.setViewportSize({ width: 1487, height: 1058 });
  await nav('我的');
  await page.getByRole('button', { name: /个人资料/ }).click();
  await expect(page.getByLabel('UID', { exact: true })).toHaveText(registered.id);
  await expect(page.getByLabel('完整账号', { exact: true })).toHaveText(registered.address);
  await page.getByLabel('昵称', { exact: true }).fill('小青研究室');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  await page.screenshot({ path: out + '/desktop-account.png' });
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  await page.getByLabel('当前密码', { exact: true }).fill('isolated-qa-password-123');
  await page.getByLabel('新密码', { exact: true }).fill('updated-qa-password-123');
  await page.getByLabel('确认新密码', { exact: true }).fill('updated-qa-password-123');
  await page.getByRole('button', { name: '更新密码', exact: true }).click();
  await saveRecoveryCode(page);
  await expect(page.getByRole('heading', { name: '账户设置', exact: true })).toBeVisible();
  checks.accountSettings = true;
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: /设置/ }).click();
  await page.getByRole('button', { name: /外观/ }).click();
  await page.getByLabel('深色', { exact: true }).check();
  await nav('消息');
  await page.getByRole('button', { name: /研究讨论组/ }).click();
  await expect(page.getByRole('log').getByText('收到，我会补充样本说明。', { exact: true })).toBeVisible();
  await page.screenshot({ path: out + '/desktop-dark.png' });
  await noOverflow();
  checks.darkTheme = true;

  // Shared image preview and byte-exact download use IM member authorization.
  const pic = new PNG({ width: 64, height: 48 });
  for (let i = 0; i < pic.data.length; i += 4) {
    pic.data[i] = 34;
    pic.data[i + 1] = 140;
    pic.data[i + 2] = 113;
    pic.data[i + 3] = 255;
  }
  const png = PNG.sync.write(pic);
  let imageDownloads = 0;
  page.on('request', (request) => {
    const u = new URL(request.url());
    if (u.pathname.includes('/files/') && !u.search && request.method() === 'GET') imageDownloads++;
  });
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: '演示图片.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.im-compose-wrap img')).toBeVisible();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const image = page.locator('.im-message img[alt="演示图片.png"]');
  await expect(image).toBeVisible();
  await image.click();
  await expect(page.getByRole('button', { name: '关闭图片预览' })).toBeVisible();
  await page.getByRole('button', { name: '关闭图片预览' }).click();
  const csv = page.locator('.im-message').filter({ hasText: '请整理这批演示数据，给出检查思路。' });
  await csv.getByRole('button', { name: '附件操作：计算结果.csv', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '下载文件', exact: true }).click(),
  ]);
  expect(await readFile(await download.path(), 'utf8')).toBe('sample,energy\ndemo_a,-0.31\ndemo_b,-0.29\n');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  checks.imageAndDownload = true;
  const downloadsBefore = imageDownloads;
  await page.reload();
  await expect(page.locator('.im-message img[alt="演示图片.png"]')).toBeVisible();
  expect(imageDownloads).toBeGreaterThan(downloadsBefore);
  checks.encryptedImageReload = true;
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    csv.getByRole('button', { name: '计算结果.csv 电子表格 · 预览', exact: true }).click(),
  ]);
  await expect(popup.locator('body')).toContainText('demo_a,-0.31');
  await popup.close();
  checks.textPreview = true;
  // Questions reuse the workspace answer panel; authorization remains recipient-scoped.
  const asked = (
    await api(
      `/conversations/${id}/messages`,
      'POST',
      {
        clientId: 'question-card',
        interaction: {
          kind: 'question',
          recipientId: registered.id,
          title: '确认交付方案',
          description: '请选择交付格式，并补充需要说明的事项。',
          questions: [
            {
              id: 'format',
              header: '格式',
              question: '希望使用哪种格式？',
              options: [
                { label: 'Markdown', description: '便于后续修改' },
                { label: 'PDF', description: '便于分享' },
              ],
            },
            { id: 'notes', header: '补充', question: '还有哪些要求？', options: [] },
          ],
        },
      },
      agent.token,
    )
  ).message;
  const questionCard = page.locator(`[data-message-id="${asked.id}"]`);
  await questionCard.getByRole('button', { name: '回答问题（2 题）' }).click();
  await page.getByRole('radio', { name: /Markdown/ }).check();
  await page.getByRole('button', { name: '下一题', exact: true }).click();
  await page.getByLabel('你的回答').fill('保留图表和来源说明');
  await page.getByRole('button', { name: '核对答案', exact: true }).click();
  await page.getByRole('button', { name: '提交全部回答（2 题）', exact: true }).click();
  await expect(questionCard).toContainText('已回答');
  const answered = (await api(`/conversations/${id}/messages/${asked.id}`, 'GET', undefined, agent.token))
    .message;
  expect(answered.interaction.response.answers).toEqual({
    format: ['Markdown'],
    notes: ['保留图表和来源说明'],
  });
  checks.questionCards = true;
  const approval = (
    await api(
      `/conversations/${id}/messages`,
      'POST',
      {
        clientId: 'approve-card',
        interaction: {
          kind: 'approval',
          recipientId: registered.id,
          title: '导出研究摘要',
          description: '将已核对的摘要导出为 PDF 文件。本次仅创建附件，不修改原始研究数据。',
        },
      },
      agent.token,
    )
  ).message;
  const approvalCard = page.locator(`[data-message-id="${approval.id}"]`);
  await approvalCard.getByRole('button', { name: '查看并确认' }).click();
  await expect(page.getByRole('dialog', { name: '核对授权' })).toContainText('本次仅创建附件');
  await page.screenshot({ path: out + '/desktop-approval-review.png' });
  await page.getByRole('button', { name: '允许本次', exact: true }).click();
  await expect(approvalCard).toContainText('已允许本次');
  expect(
    (await api(`/conversations/${id}/messages/${approval.id}`, 'GET', undefined, agent.token)).message
      .interaction.respondedBy,
  ).toBe(registered.id);
  const declined = (
    await api(
      `/conversations/${id}/messages`,
      'POST',
      {
        clientId: 'decline-card',
        interaction: {
          kind: 'approval',
          recipientId: registered.id,
          title: '另一个操作',
          description: '请拒绝这项测试操作。',
        },
      },
      agent.token,
    )
  ).message;
  await page
    .locator(`[data-message-id="${declined.id}"]`)
    .getByRole('button', { name: '查看并确认' })
    .click();
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.locator(`[data-message-id="${declined.id}"]`)).toContainText('已拒绝');
  checks.approvals = true;
  await page.getByRole('button', { name: '发起交互请求', exact: true }).click();
  await page.getByLabel('请求标题').fill('补充信息');
  await page.getByLabel('问题说明').fill('请确认样本编号');
  await page.getByRole('button', { name: '发送请求', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '发起交互请求' })).toHaveCount(0);
  const humanCard = page.locator('.im-interaction').filter({ hasText: '补充信息' });
  await expect(humanCard).toContainText('等待 UID');
  await humanCard.getByRole('button', { name: '撤回请求' }).click();
  await expect(humanCard).toContainText('已撤回');
  checks.createAndWithdrawRequest = true;
  await page.getByLabel('聊天消息').fill('AB');
  await page.getByLabel('聊天消息').evaluate((el) => el.setSelectionRange(1, 1));
  await page.getByRole('button', { name: '表情与 Emoji', exact: true }).click();
  await expect(page.getByRole('region', { name: '表情与 Emoji' })).toBeVisible();
  expect(await page.locator('dialog[open]').count()).toBe(0);
  await page.getByLabel('聊天消息').click();
  await expect(page.getByRole('region', { name: '表情与 Emoji' })).toHaveCount(0);
  await page.getByLabel('聊天消息').evaluate((el) => el.setSelectionRange(1, 1));
  await page.getByRole('button', { name: '表情与 Emoji', exact: true }).click();
  await page.getByLabel('搜索 Emoji').fill('微笑');
  checks.nonModalEmojiPanel = true;
  await page.getByRole('button', { name: '微笑 😊', exact: true }).click();
  await expect(page.getByLabel('聊天消息')).toHaveValue('A😊B');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(friendPage.getByRole('log').getByText('A😊B', { exact: true })).toBeVisible();
  checks.emoji = true;
  await page.getByRole('button', { name: '收藏表情 演示图片.png' }).click();
  await page.getByRole('button', { name: '表情与 Emoji', exact: true }).click();
  await page.getByRole('tab', { name: '收藏', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送表情 演示图片.png' })).toBeVisible();
  await page.getByLabel('导入表情包').setInputFiles({
    name: '挥手.gif',
    mimeType: 'image/gif',
    buffer: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
  });
  await expect(page.getByRole('button', { name: '发送表情 挥手.gif' })).toBeVisible();
  await page.getByRole('button', { name: '发送表情 挥手.gif' }).click();
  await expect(page.locator('.is-sticker img[alt="挥手.gif"]')).toBeVisible();
  await friendPage.locator('.is-sticker').last().scrollIntoViewIfNeeded();
  await expect(friendPage.locator('.is-sticker img[alt="挥手.gif"]')).toBeVisible();
  checks.stickerFavoritesAndGif = true;
  // The browser records its synthetic microphone through the real MediaRecorder API.
  await page.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await original(...args);
      window.__qaTracks = stream.getTracks();
      return stream;
    };
  });
  await page.getByRole('button', { name: '语音消息', exact: true }).click();
  await page.getByRole('button', { name: '也可以点击录音', exact: true }).click();
  await expect(page.locator('.im-voice-time')).toHaveText('0:02 / 2:00');
  await page.getByRole('button', { name: '停止录音', exact: true }).click();
  await expect(page.getByLabel('试听语音')).toBeVisible();
  expect(await page.evaluate(() => window.__qaTracks.every((t) => t.readyState === 'ended'))).toBe(true);
  await page.getByLabel('试听语音').evaluate((el) => el.play());
  await expect.poll(() => page.getByLabel('试听语音').evaluate((el) => el.currentTime)).toBeGreaterThan(0);
  await page.screenshot({ path: out + '/desktop-voice-preview.png' });
  await page.getByRole('button', { name: '发送语音', exact: true }).click();
  await expect(page.getByRole('region', { name: '语音消息' })).toHaveCount(0);
  await friendPage.locator('.im-message [data-media-type=audio]').last().scrollIntoViewIfNeeded();
  const audio = friendPage.locator('.im-message audio').last();
  await expect(audio).toBeVisible();
  await audio.evaluate((el) => el.play());
  await expect.poll(() => audio.evaluate((el) => el.currentTime)).toBeGreaterThan(0);
  checks.voiceRecordPreviewSendPlayback = true;
  await page.getByRole('button', { name: '语音消息', exact: true }).click();
  await page.getByRole('button', { name: '也可以点击录音', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止录音' })).toBeVisible();
  await page
    .getByRole('region', { name: '语音消息' })
    .getByRole('button', { name: '关闭语音', exact: true })
    .click();
  expect(await page.evaluate(() => window.__qaTracks.every((t) => t.readyState === 'ended'))).toBe(true);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Denied for QA', 'NotAllowedError');
    };
  });
  await page.getByRole('button', { name: '语音消息', exact: true }).click();
  await page.getByRole('button', { name: '也可以点击录音', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('麦克风权限未开启');
  await page
    .getByRole('region', { name: '语音消息' })
    .getByRole('button', { name: '关闭语音', exact: true })
    .click();
  checks.voiceCancelAndPermissionFailure = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow();
  await page.screenshot({ path: out + '/mobile-interactions.png' });
  await page.getByRole('button', { name: '表情与 Emoji', exact: true }).click();
  await noOverflow();
  await page.screenshot({ path: out + '/mobile-emoji.png' });
  await page.getByRole('tab', { name: '收藏', exact: true }).click();
  await noOverflow();
  await page.screenshot({ path: out + '/mobile-stickers.png' });
  await page
    .getByRole('region', { name: '表情与 Emoji' })
    .getByRole('button', { name: '关闭表情', exact: true })
    .click();
  await page.setViewportSize({ width: 320, height: 740 });
  await noOverflow();
  await expect(page.getByRole('button', { name: '语音消息', exact: true })).toBeVisible();
  await page.screenshot({ path: out + '/mobile-tools-320.png' });
  await page.setViewportSize({ width: 1487, height: 1058 });
  checks.mobileTools = true;

  // Offline gaps larger than one history page, followed by loading older messages.
  await context.setOffline(true);
  for (let i = 0; i < 65; i++)
    await api(
      `/conversations/${id}/messages`,
      'POST',
      { clientId: `offline-${suffix}-${i}`, text: `离线进度 ${i + 1}` },
      agent.token,
    );
  await context.setOffline(false);
  await expect(page.getByRole('log').getByText('离线进度 65', { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByRole('log').getByText('离线进度 1', { exact: true })).toHaveCount(1);
  checks.reconnect = true;
  await page.reload();
  await expect(page.getByRole('log').getByText('离线进度 65', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '加载更早消息', exact: true }).click();
  await expect(page.getByRole('log').getByText('离线进度 1', { exact: true })).toHaveCount(1);
  checks.historyPagination = true;
  await page.locator('.im-transcript').evaluate((el) => (el.scrollTop = 0));
  const scrollBefore = await page.locator('.im-transcript').evaluate((el) => el.scrollTop);
  const extraStream = (
    await api(
      `/conversations/${id}/messages`,
      'POST',
      { clientId: `scroll-stream-${suffix}`, state: 'streaming', text: 'scroll test' },
      agent.token,
    )
  ).message;
  await api(
    `/conversations/${id}/messages/${extraStream.id}`,
    'PATCH',
    { revision: 1, text: 'scroll test updated', state: 'complete' },
    agent.token,
  );
  await expect(page.getByRole('log').getByText('scroll test updated', { exact: true })).toHaveCount(1);
  expect(await page.locator('.im-transcript').evaluate((el) => el.scrollTop)).toBe(scrollBefore);
  checks.scrollStaysWhileReading = true;
  // The CLI exercises group mutation, files and ordered streaming against the same fixture.
  const credentials = join(state, 'agent.json');
  await writeFile(
    credentials,
    JSON.stringify({ origin, token: agent.token, user: agent.user, secrets: agent.secrets }),
    { mode: 0o600 },
  );
  const execute = promisify(execFile);
  async function cli(...args) {
    const { stdout } = await execute(process.execPath, [
      '--import',
      'tsx',
      'scripts/im-agent.ts',
      ...args,
      '--state',
      credentials,
    ]);
    expect(stdout).not.toContain(agent.token);
    return JSON.parse(stdout);
  }
  expect((await stat(credentials)).mode & 0o777).toBe(0o600);
  const cliGroup = (await cli('group', '--name', 'CLI 测试群', '--members', agent.owner.id)).conversation;
  await cli('group-update', '--conversation', cliGroup.id, '--name', 'CLI 已改名');
  const started = (await cli('stream-start', '--conversation', cliGroup.id, '--request-id', 'cli-stream'))
    .message;
  await cli(
    'stream-update',
    '--conversation',
    cliGroup.id,
    '--message',
    started.id,
    '--revision',
    '1',
    '--text',
    'CLI 回复',
    '--status',
    'complete',
  );
  expect((await cli('search', '--conversation', cliGroup.id, '--query', '回复')).messages).toHaveLength(1);
  const path = join(state, 'binary.dat');
  await writeFile(path, Buffer.from([0, 1, 2, 255]));
  const uploaded = (await cli('upload', '--conversation', cliGroup.id, '--file', path)).file;
  await cli('send', '--conversation', cliGroup.id, '--attachments', uploaded.id, '--request-id', 'cli-file');
  checks.cli = true;
  // Owner/member management is exercised through the rendered dialog.
  await page.getByRole('button', { name: '成员', exact: true }).click();
  await page.getByLabel('群名称', { exact: true }).fill('研究讨论组 · 已更新');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: '研究讨论组 · 已更新', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '移除成员 林同学', exact: true }).click();
  await page
    .getByRole('dialog', { name: '移除成员', exact: true })
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: '群资料与成员' }).locator('.im-member')).toHaveCount(2);
  await expect(
    friendPage.getByRole('log').getByText('收到，我会补充样本说明。', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('dialog', { name: '群资料与成员' }).getByRole('button', { name: '关闭' }).click();
  checks.groupRemove = true;
  await nav('联系人');
  await page.locator('.im-person-row').filter({ hasText: '同组的林同学' }).click();
  await page.getByRole('button', { name: '屏蔽私聊', exact: true }).click();
  await page
    .getByRole('dialog', { name: '屏蔽私聊' })
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '发消息', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '解除屏蔽', exact: true }).click();
  await page
    .getByRole('dialog', { name: '解除屏蔽' })
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '发消息', exact: true })).toBeEnabled();
  checks.contactBlock = true;
  const otherTab = await context.newPage();
  await otherTab.goto(origin + '/?page=messages');
  await expect(otherTab.getByRole('button', { name: /研究讨论组/ })).toBeVisible();
  await nav('我的');
  await page.getByRole('button', { name: /个人资料/ }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(otherTab.getByRole('heading', { name: '一个账号，连接你的设备' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async (uid) => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('pocket-im-media');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return await new Promise((resolve, reject) => {
          const request = db.transaction('blobs').objectStore('blobs').index('account').count(uid);
          request.onsuccess = () => {
            db.close();
            resolve(request.result);
          };
          request.onerror = () => reject(request.error);
        });
      }, registered.id),
    )
    .toBe(0);
  checks.logoutClearsPrivateImageCache = true;
  checks.crossTabLogout = true;
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('UID 或用户名', { exact: true }).fill(registered.id);
  await page.getByLabel('密码', { exact: true }).fill('updated-qa-password-123');
  await page.getByRole('button', { name: '登录账户', exact: true }).click();
  await expect(page.getByRole('button', { name: /研究讨论组/ }).first()).toBeVisible();
  checks.uidLogin = true;
  await otherTab.close();
  await friendContext.close();
  expect(errors).toEqual([]);
  await writeFile(out + '/result.json', JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (e) {
  await page.screenshot({ path: out + '/failure.png' });
  console.error(e);
  console.log(JSON.stringify({ checks, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
  await relay.app.close();
  await rm(state, { recursive: true, force: true });
}
