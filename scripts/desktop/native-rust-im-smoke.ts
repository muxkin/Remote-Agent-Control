import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MediaStream,
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
  useOPUS,
  useVP8,
} from 'werift';
import { AccountClient } from '../../src/client/account.js';
import { AgentCallsClient } from '../../src/client/calls.js';
import { EncryptedMessagingClient } from '../../src/client/encrypted-messaging.js';
import { platformRuntime } from '../../src/server/platform.js';
import { buildRelay } from '../../src/server/relay.js';
import type { ChatConversation, ChatMessage } from '../../src/shared/messaging.js';
import { registerAgentFixture } from '../lib/messaging-smoke.js';

const [binary, handler] = process.argv.slice(2).map((path) => resolve(path));
assert(binary && handler, 'Usage: native-rust-im-smoke.ts ADAPTER HANDLER');
const directory = await mkdtemp(join(tmpdir(), 'rust-im-agent-'));
const privateDir = (path: string) => {
  if (process.platform === 'win32') platformRuntime().privateDirectory(path);
};
const privateJson = async (path: string, value: unknown) => {
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  if (process.platform === 'win32') platformRuntime().privateFile(path);
};
privateDir(directory);
const portProbe = createServer().listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const address = portProbe.address();
assert(address && typeof address !== 'string');
await new Promise<void>((done) => portProbe.close(() => done()));
const origin = 'http://127.0.0.1:' + address.port;
const enrollmentSecret = randomBytes(32).toString('hex');
const cloudflare = process.env.POCKET_NATIVE_TEST_RELAY === 'cloudflare';
const relay = cloudflare
  ? await cloudflareRelay(address.port)
  : await buildRelay({
      origin,
      webRoot: join(directory, 'web'),
      enrollmentSecret,
      assetOrigin: null,
      uploadOrigins: [],
    }).then(({ app }) => ({
      listen: () => app.listen({ host: '127.0.0.1', port: address.port }),
      close: () => app.close(),
    }));
const stateDirectory = join(directory, 'adapter');
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(POCKET_|CODEX_)/i.test(key))),
  POCKET_NATIVE_STATE_DIR: stateDirectory,
  POCKET_NATIVE_ORIGIN: origin,
  POCKET_NATIVE_ENROLLMENT: enrollmentSecret,
  POCKET_NATIVE_P2P: '0',
  CODEX_HOME: join(directory, 'no-codex'),
  HTTP_PROXY: 'http://127.0.0.1:9',
  NO_PROXY: '',
};
let child: ReturnType<typeof spawn> | undefined;
let peer: RTCPeerConnection | undefined;
const start = () => {
  child = spawn(binary, ['--headless'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
};
const stop = async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'close');
    child.kill('SIGINT');
    await exit;
  }
};
const until = async (check: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (await check()) return;
    await delay(100);
  }
  assert.fail('Rust independent Agent did not reach the expected state');
};

async function cloudflareRelay(port: number) {
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const worker = new Miniflare({
    ...convertV4MiniflareOptions({
      name: 'native-agent-im-smoke',
      modules: true,
      scriptPath: '.implementation/cloudflare/index.js',
      compatibilityDate: '2026-11-04',
      compatibilityFlags: ['nodejs_compat'],
      host: '127.0.0.1',
      port,
      bindings: {
        POCKET_PUBLIC_ORIGIN: origin,
        POCKET_RELAY_ENROLLMENT: enrollmentSecret,
        POCKET_IM_HUMAN_CONTACTS: 'true',
      },
      durableObjects: {
        RELAY: { className: 'RelayHub', useSQLite: true },
        MESSAGING: { className: 'MessagingHub', useSQLite: true },
      },
      r2Buckets: ['IM_MEDIA'],
      images: { binding: 'IMAGES' },
      serviceBindings: { ASSETS: () => new Response(null, { status: 404 }) },
    }),
  });
  return { listen: () => worker.ready, close: () => worker.dispose() };
}

try {
  await relay.listen();
  let token: string | undefined;
  const account = new AccountClient(async (path, method, body, signal) => {
    const response = await fetch(origin + '/api/im' + path, {
      method,
      signal,
      headers: { 'Content-Type': 'application/json', Origin: origin, ...(token && { Authorization: 'Bearer ' + token }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cookie = response.headers.getSetCookie().find((item) => item.startsWith('pocket_im_session='));
    if (cookie) token = cookie.split(';', 1)[0].slice('pocket_im_session='.length);
    assert(response.ok);
    return response.json();
  });
  await account.register('rustfixtureowner', 'Fixture Owner', 'isolated-rust-im-fixture-password');
  const human = new EncryptedMessagingClient(origin, token);
  human.account.activate(account.user!, account.secrets!);
  const { invitation } = await human.raw<{ invitation: string }>('/agent-invitations', 'POST');
  const agent = await registerAgentFixture(origin, {
    invitation,
    username: 'rustfixtureagent',
    displayName: 'Fixture Agent',
  });
  const legacy = new EncryptedMessagingClient(origin, agent.token);
  legacy.account.activate(agent.user, agent.secrets);
  await legacy.account.publicKeys(account.user!.id);
  const { conversation } = await human.direct(agent.user.id);
  const archived = await human.send(conversation.id, '迁移前的旧消息', 'pre-migration-message');
  const { cursor } = await legacy.raw<{ cursor: number }>('/bootstrap');
  assert(cursor >= archived.message.sequence);
  const credentials = join(directory, 'agent.json');
  await privateJson(credentials, { origin, token: agent.token, user: agent.user, secrets: agent.secrets });
  const progressDir = join(stateDirectory, 'im-agent-progress');
  await mkdir(stateDirectory, { mode: 0o700 });
  privateDir(stateDirectory);
  await mkdir(progressDir, { mode: 0o700 });
  privateDir(progressDir);
  const progress = join(progressDir, 'fixture.json');
  const original = { origin, user: agent.user.id, cursor };
  await privateJson(progress, original);
  const manifest = join(stateDirectory, 'im-agents.json');
  const profile = { id: 'fixture', state: credentials, messageHandler: handler, cursor: 0 };
  await privateJson(manifest, [profile]);
  const incoming = await human.send(conversation.id, '从旧客户端发来的加密消息 👋', 'rust-message');
  start();
  const countReplies = async () =>
    (await human.history(conversation.id)).messages.filter((message) => message.text === 'Rust 回复 🔒')
      .length;
  const readCursor = async () => JSON.parse(await readFile(progress, 'utf8')).cursor as number;
  await until(async () => (await countReplies()) === 1 && (await readCursor()) > cursor);
  assert((await readCursor()) >= incoming.message.sequence);
  await stop();
  await privateJson(progress, original);
  start();
  await until(async () => (await readCursor()) >= incoming.message.sequence);
  assert.equal(await countReplies(), 1, 'Replay duplicated the encrypted reply');
  await stop();

  const replayCursor = await readCursor();
  await privateJson(manifest, [{ ...profile, messageProtocol: 'rpc' }]);
  start();
  const streamFor = async (promptId: string) =>
    (await human.history(conversation.id)).messages.find(
      (message) => message.senderId === agent.user.id && message.replyTo === promptId,
    );
  const prompt = (text: string, clientId: string) => human.send(conversation.id, text, clientId);
  const completing = await prompt('启动 Rust 流式回复', 'rust-stream-complete');
  await until(async () => (await streamFor(completing.message.id))?.revision === 1);
  const partial = (await streamFor(completing.message.id))!;
  assert.equal(partial.text, 'Rust 部分回复 🔒');
  assert.equal(partial.state, 'streaming');
  assert.deepEqual(partial.activities, [{ kind: 'search', status: 'in_progress' }]);
  assert.deepEqual(partial.mentions, [account.user!.id]);
  const raw = await human.raw<{ message: { text: string } }>(`/conversations/${conversation.id}/messages/${partial.id}`);
  assert(raw.message.text.startsWith('pocket-e2ee:1:'));
  assert(!raw.message.text.includes('Rust 部分回复'));
  await prompt('继续流式回复', 'rust-stream-continue');
  await until(async () => (await streamFor(completing.message.id))?.state === 'complete');
  const complete = (await streamFor(completing.message.id))!;
  assert.equal(complete.id, partial.id);
  assert.equal(complete.revision, 2);
  assert.equal(complete.text, 'Rust 完整回复 🔒');
  assert.deepEqual(complete.activities, partial.activities);

  await until(async () => (await readCursor()) >= completing.message.sequence);
  await stop();
  const cancelling = await prompt('等待用户取消', 'rust-stream-user-cancel');
  const oldStream = await legacy.send(conversation.id, '', 'fixture-stream-' + cancelling.message.id, {
    state: 'streaming',
    replyTo: cancelling.message.id,
    mentions: [account.user!.id],
  });
  start();
  await until(async () => (await streamFor(cancelling.message.id))?.revision === 1);
  const active = (await streamFor(cancelling.message.id))!;
  assert.equal(active.id, oldStream.message.id, 'The Rust Agent did not resume the Node stream');
  await human.cancel(conversation.id, active.id);
  await until(async () => (await readCursor()) >= cancelling.message.sequence);
  const cancelled = (await streamFor(cancelling.message.id))!;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.revision, 2);
  assert.equal(cancelled.text, active.text);
  const selfCancel = await prompt('Agent 自行取消', 'rust-stream-self-cancel');
  await until(async () => (await streamFor(selfCancel.message.id))?.state === 'cancelled');
  const failing = await prompt('模拟流式失败', 'rust-stream-fail');
  await until(async () => (await streamFor(failing.message.id))?.state === 'failed');
  await until(async () => (await readCursor()) >= failing.message.sequence);

  await stop();
  await privateJson(progress, { ...original, cursor: replayCursor });
  start();
  await until(async () => (await readCursor()) >= failing.message.sequence);
  const replayed = (await human.history(conversation.id)).messages.filter(
    (message) => message.senderId === agent.user.id && message.clientId.startsWith('fixture-stream-'),
  );
  assert.equal(replayed.length, 4, 'Replay created duplicate stream messages');
  assert.equal((await streamFor(completing.message.id))?.id, complete.id);

  await stop();
  const media = join(directory, 'media');
  const environmentFile = join(directory, 'handler.env');
  await mkdir(media, { mode: 0o700 });
  privateDir(media);
  // Dotenv single quotes preserve Windows path separators.
  await writeFile(environmentFile, `RUST_IM_FIXTURE_MEDIA='${media}'\n`, { mode: 0o600 });
  if (process.platform === 'win32') platformRuntime().privateFile(environmentFile);
  await privateJson(manifest, [{ ...profile, messageProtocol: 'rpc', environmentFile }]);
  const mediaCursor = await readCursor();
  const contents = Buffer.alloc(1_100_000, 37);
  contents.write('%PDF-1.7\nRust IM attachment fixture');
  const { file } = await human.upload(conversation.id, '旧 Node 附件.pdf', contents);
  const attachment = await human.send(conversation.id, '验证加密附件', 'rust-file-roundtrip', {
    attachmentIds: [file.id],
  });
  const attachedEvent = (await legacy.sync(mediaCursor, 0)).events.find(
    (event) => event.message?.id === attachment.message.id,
  );
  assert(attachedEvent);
  start();
  await until(async () => (await readCursor()) >= attachedEvent.sequence);
  const roundtrip = (await streamFor(attachment.message.id))!;
  assert.equal(roundtrip.attachments.length, 1);
  assert.equal(roundtrip.attachments[0].id, attachment.message.id);
  assert.equal(roundtrip.attachments[0].name, 'Rust 回传.pdf');
  const downloaded = await human.download(roundtrip.attachments[0].url);
  assert.equal(downloaded.mime, 'application/pdf');
  assert.deepEqual(Buffer.from(downloaded.data), contents);
  assert.deepEqual(await readFile(join(media, attachment.message.id + '.pdf')), contents);
  const rawMeta = await human.raw<{ name: string; size: number; encrypted: string }>(
    `/conversations/${conversation.id}/files/${roundtrip.attachments[0].id}/encrypted.pocket?meta=1`,
  );
  assert.equal(rawMeta.name, 'encrypted.pocket');
  assert.equal(rawMeta.size, contents.length + 16);
  assert(rawMeta.encrypted.startsWith('pocket-e2ee:1:'));
  assert(!rawMeta.encrypted.includes('Rust 回传.pdf'));
  await stop();
  await privateJson(progress, { ...original, cursor: mediaCursor });
  const rpcProfile = { ...profile, messageProtocol: 'rpc', environmentFile };
  await privateJson(manifest, [rpcProfile]);
  start();
  await until(async () => (await readCursor()) >= attachedEvent.sequence);
  const fileReplies = (await human.history(conversation.id)).messages.filter(
    (message) => message.senderId === agent.user.id && message.replyTo === attachment.message.id,
  );
  assert.equal(fileReplies.length, 1, 'Replay created another attachment reply');
  assert.equal(fileReplies[0].attachments[0].id, roundtrip.attachments[0].id);

  const { conversation: other } = await human.group('另一个附件会话', [agent.user.id]);
  await human.send(other.id, '跨会话附件验证 ' + file.id, 'rust-file-cross-conversation');
  await until(async () => (await human.history(other.id)).messages.some((message) => message.text === '跨会话读取已拒绝'));

  await stop();
  const cardsCursor = await readCursor();
  const oldCardPrompt = await prompt('验证旧版卡片', 'rust-card-legacy');
  const { message: oldCard } = await legacy.send(
    conversation.id, 'Rust 交互卡片', `fixture-card-${oldCardPrompt.message.id}-legacy`, {
      replyTo: oldCardPrompt.message.id,
      interaction: {
        kind: 'approval', recipientId: account.user!.id, title: '旧 Node 审批',
        description: '私密说明 · only recipients 🔒', expiresAt: oldCardPrompt.message.createdAt + 3_600_000,
      },
    },
  );
  const cardPrompt = await prompt('验证加密交互', 'rust-card-new');
  start();
  const cardsFor = async (id: string) => (await human.history(conversation.id)).messages.filter(
    (message) => message.senderId === agent.user.id && message.replyTo === id && message.interaction,
  );
  await until(async () => (await cardsFor(cardPrompt.message.id)).length === 4);
  await until(async () => (await cardsFor(cardPrompt.message.id)).some(
    (message) => message.interaction?.status === 'cancelled',
  ));
  assert.deepEqual((await cardsFor(oldCardPrompt.message.id)).map(({ id }) => id), [oldCard.id]);
  const cards = await cardsFor(cardPrompt.message.id);
  const find = (kind: string) => {
    const card = cards.find((message) => message.clientId.endsWith('-' + kind));
    assert(card?.interaction);
    return card;
  };
  const allow = find('allow');
  const deny = find('deny');
  const question = find('question');
  const revoked = find('cancel');
  assert.equal(allow.interaction?.title, 'Rust 允许审批');
  assert.equal(allow.interaction?.description, '私密说明 · only recipients 🔒');
  assert.deepEqual(question.interaction?.questions?.[0], {
    id: 'single', header: '', question: '单选问题',
    options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
  });
  assert.equal(question.interaction?.questions?.[1].detail, '仅成员可见');
  assert.deepEqual(question.interaction?.questions?.[2].options, []);
  const rawMessage = async (message: ChatMessage) => (await human.raw<{ message: ChatMessage }>(
    `/conversations/${conversation.id}/messages/${message.id}`,
  )).message;
  for (const card of [allow, question]) {
    const raw = await rawMessage(card);
    assert.equal(raw.interaction?.title, '加密请求');
    assert.equal(raw.interaction?.description, '请使用支持加密的客户端读取');
    assert(raw.text.startsWith('pocket-e2ee:1:'));
    assert(!JSON.stringify(raw).includes('only recipients'));
  }
  assert.deepEqual((await rawMessage(question)).interaction?.questions, [
    { id: 'encrypted', header: '', question: '加密问题', options: [] },
  ]);
  const approve = { decision: 'approve', comment: '允许 · 私密备注' } as const;
  assert.equal((await human.respond(conversation.id, allow.id, approve)).message.interaction?.status, 'approved');
  assert.equal((await human.respond(conversation.id, oldCard.id, approve)).message.interaction?.status, 'approved');
  assert.equal((await human.respond(conversation.id, deny.id, {
    decision: 'reject', comment: '拒绝 · 私密备注',
  })).message.interaction?.status, 'rejected');
  const answers = { single: ['A'], multiple: ['甲', '乙'], text: ['只在签名密文里'] };
  assert.deepEqual((await human.respond(conversation.id, question.id, { answers })).message.interaction?.response, { answers });
  assert(!JSON.stringify(await rawMessage(question)).includes('只在签名密文里'));
  await assert.rejects(human.respond(conversation.id, revoked.id, approve), /已处理或已失效/);
  const outcomes = new Map([
    [allow.id, 'approved'], [oldCard.id, 'approved'], [deny.id, 'rejected'],
    [question.id, 'answered'], [revoked.id, 'cancelled'],
  ]);
  const acknowledgements = async () => (await human.history(conversation.id)).messages.filter(
    (message) => message.replyTo && outcomes.has(message.replyTo) && message.clientId.startsWith('fixture-card-ack-'),
  );
  await until(async () => (await acknowledgements()).length === outcomes.size);
  for (const item of await acknowledgements()) assert.equal(item.text, '已读取 ' + outcomes.get(item.replyTo!));
  const finalCardEvent = (await legacy.sync(cardsCursor, 0)).events.filter(
    (event) => event.message && outcomes.has(event.message.id) && event.type === 'message.updated',
  ).at(-1);
  assert(finalCardEvent);
  await until(async () => (await readCursor()) >= finalCardEvent.sequence);
  await stop();
  await privateJson(progress, { ...original, cursor: cardsCursor });
  await privateJson(manifest, [rpcProfile]);
  start();
  await until(async () => (await readCursor()) >= finalCardEvent.sequence);
  assert.deepEqual((await cardsFor(oldCardPrompt.message.id)).map(({ id }) => id), [oldCard.id]);
  assert.deepEqual(new Set((await cardsFor(cardPrompt.message.id)).map(({ id }) => id)), new Set(cards.map(({ id }) => id)));
  assert.equal((await acknowledgements()).length, outcomes.size, 'Replaying signed answers duplicated the acknowledgements');

  await stop();
  const { invitation: secondaryInvite } = await human.raw<{ invitation: string }>('/agent-invitations', 'POST');
  const secondary = await registerAgentFixture(origin, {
    invitation: secondaryInvite, username: 'rustfixturesecondary', displayName: 'Secondary Agent',
  });
  const { conversation: searchRoom } = await human.group('加密搜索测试', [agent.user.id]);
  for (let index = 0; index < 52; index++)
    await human.send(searchRoom.id, 'Ångström ' + index, 'rust-search-fixture-' + index);
  const oldSearch = await human.search(searchRoom.id, 'ÅNGSTRÖM');
  assert.equal(oldSearch.messages.length, 50);
  assert.deepEqual((await human.search(searchRoom.id, 'ångström', oldSearch.before)).messages.map(({ text }) => text),
    ['Ångström 1', 'Ångström 0']);
  const rawSearch = await human.raw<{ messages: ChatMessage[] }>(
    `/conversations/${searchRoom.id}/search?q=${encodeURIComponent('Ångström')}`,
  );
  assert.equal(rawSearch.messages.length, 0, 'Encrypted search fixture leaked plaintext to the service');
  const { cursor: directoryCursor } = await legacy.raw<{ cursor: number }>('/bootstrap');
  await privateJson(progress, { ...original, cursor: directoryCursor });
  await privateJson(manifest, [{ ...rpcProfile, callHandler: handler }]);
  const directoryCheck = await prompt(
    '验证会话目录 ' + JSON.stringify({ peer: secondary.user.id, search: searchRoom.id, cursor: directoryCursor }),
    'rust-directory',
  );
  start();
  await until(async () => (await streamFor(directoryCheck.message.id))?.text === '目录接口已验证');
  const verifiedChats = (await human.conversations()).conversations;
  assert.equal(verifiedChats.find(({ id }) => id === conversation.id)?.peerReadSequence, directoryCheck.message.sequence);
  assert.equal(verifiedChats.find(({ id }) => id === conversation.id)?.peer?.displayName, 'Rust 原生 Agent');
  const closed = verifiedChats.find(({ name }) => name === '改名后的测试群');
  assert(closed?.closed);
  assert.deepEqual(closed.members.map(({ id }) => id).sort(), [agent.user.id, account.user!.id].sort());
  assert.equal(verifiedChats.find(({ name }) => name === '群主转让测试')?.ownerId, account.user!.id);
  assert(!(await legacy.contacts()).users.some(({ id }) => id === secondary.user.id));
  const { conversation: secondaryChat } = await secondary.client.raw<{ conversation: ChatConversation }>(
    '/conversations', 'POST', { userId: agent.user.id },
  );
  assert.equal(secondaryChat.kind, 'direct');

  const calls = new AgentCallsClient(human);
  await until(async () => (await calls.capabilities(conversation.id)).video);
  for (const mode of ['audio', 'video'] as const) {
    const { call } = await calls.create(conversation.id, mode);
    peer = new RTCPeerConnection({ codecs: { audio: [useOPUS()], video: [useVP8()] } });
    const audio = new MediaStreamTrack({ kind: 'audio' });
    const video = mode === 'video' ? new MediaStreamTrack({ kind: 'video' }) : undefined;
    const stream = new MediaStream(video ? [audio, video] : [audio]);
    peer.addTrack(audio, stream);
    if (video) peer.addTrack(video, stream);
    const received = { audio: 0, video: 0 };
    peer.onTrack.subscribe((track) =>
      track.onReceiveRtp.subscribe(() => received[track.kind as keyof typeof received]++),
    );
    await peer.setLocalDescription(await peer.createOffer());
    let sdp = peer.localDescription!.sdp;
    if (mode === 'audio') {
      const candidates = sdp.split(/\r?\n/).filter((line) => line.startsWith('a=candidate:'));
      assert(candidates.length > 0, 'The audio offer has no ICE candidates');
      for (const candidate of candidates) {
        await calls.send(call, {
          type: 'candidate',
          candidate: { candidate: candidate.slice(2), sdpMid: '0', sdpMLineIndex: 0 },
        });
      }
      sdp = sdp.replace(/^a=(?:candidate:.*|end-of-candidates)\r?\n/gm, '');
    }
    await calls.send(call, { type: 'description', description: { type: 'offer', sdp } });
    let after = 0;
    await until(async () => {
      const result = await calls.poll(call.id, after);
      assert.notEqual(result.call.state, 'ended', 'The Rust Agent ended media negotiation');
      after = result.cursor;
      for (const signal of result.signals) {
        if (signal.senderId !== call.agentId) continue;
        const payload = await calls.decode(call, signal);
        if (payload.type === 'description') await peer!.setRemoteDescription(payload.description);
        else if (peer!.remoteDescription) await peer!.addIceCandidate(payload.candidate);
      }
      return peer!.connectionState === 'connected';
    });
    for (let sequence = 1; sequence <= 80 && !(received.audio && (!video || received.video)); sequence++) {
      audio.writeRtp(
        new RtpPacket(
          new RtpHeader({
            payloadType: 111,
            sequenceNumber: sequence,
            timestamp: sequence * 960,
            ssrc: 1234,
          }),
          Buffer.from([0xf8, 0xff, 0xfe]),
        ),
      );
      video?.writeRtp(
        new RtpPacket(
          new RtpHeader({
            payloadType: 96,
            marker: true,
            sequenceNumber: sequence,
            timestamp: sequence * 3000,
            ssrc: 5678,
          }),
          Buffer.from([0x10, 0x00, 0x01, 0x02]),
        ),
      );
      await delay(25);
    }
    assert(received.audio > 0, 'Rust handler did not return audio RTP');
    if (video) assert(received.video > 0, 'Rust handler did not return video RTP');
    await calls.update(call.id, 'end');
    await peer.close();
    peer = undefined;
  }
  await stop();
  if (process.platform !== 'win32') {
    await until(async () => !(await calls.capabilities(conversation.id)).audio);
  }
  console.log(
    `Rust independent Agent (${cloudflare ? 'Cloudflare' : 'Node'}): encrypted messaging, streaming, attachments, interactions, contacts, groups, local search, read receipts, replay, and bidirectional audio/video RTP passed.`,
  );
} finally {
  await stop();
  await peer?.close();
  await relay.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
