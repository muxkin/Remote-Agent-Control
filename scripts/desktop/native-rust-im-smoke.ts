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
const relay = await buildRelay({
  origin,
  webRoot: join(directory, 'web'),
  enrollmentSecret,
  assetOrigin: null,
  uploadOrigins: [],
});
const stateDirectory = join(directory, 'adapter');
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(POCKET_|CODEX_)/i.test(key))),
  POCKET_NATIVE_STATE_DIR: stateDirectory,
  POCKET_NATIVE_ORIGIN: origin,
  POCKET_NATIVE_ENROLLMENT: enrollmentSecret,
  POCKET_NATIVE_P2P: '0',
  CODEX_HOME: join(directory, 'no-codex'),
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

try {
  await relay.app.listen({ host: '127.0.0.1', port: address.port });
  let token: string | undefined;
  const account = new AccountClient(async (path, method, body, signal) => {
    const response = await fetch(origin + '/api/im' + path, {
      method,
      signal,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
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
  await privateJson(join(stateDirectory, 'im-agents.json'), [
    { id: 'fixture', state: credentials, messageHandler: handler, callHandler: handler, cursor: 0 },
  ]);
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
    'Rust independent Agent: existing identity and cursor, encrypted text and signaling, replay, and bidirectional audio/video RTP passed.',
  );
} finally {
  await stop();
  await peer?.close();
  await relay.app.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
