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
  const profile = { id: 'fixture', state: credentials, messageHandler: handler, callHandler: handler, cursor: 0 };
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
    `Rust independent Agent (${cloudflare ? 'Cloudflare' : 'Node'}): existing identity and cursor, encrypted text and streaming, revision replay, cancellation and failure, encrypted signaling, and bidirectional audio/video RTP passed.`,
  );
} finally {
  await stop();
  await peer?.close();
  await relay.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
