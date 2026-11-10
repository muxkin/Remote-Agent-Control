import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket } from 'werift';
import { AccountClient } from '../../src/client/account.ts';
import { AgentCallsClient } from '../../src/client/calls.ts';
import { EncryptedMessagingClient } from '../../src/client/encrypted-messaging.ts';
import { buildRelay } from '../../src/server/relay.ts';
import { registerAgentFixture } from '../lib/messaging-smoke.ts';

const root = resolve(process.argv[2] ?? 'dist/desktop-payload');
const { superviseIndependentAgents } = await import(pathToFileURL(join(root, 'scripts/native-im.mjs')));
const directory = await mkdtemp(join(tmpdir(), 'native-independent-agent-'));
const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const relay = await buildRelay({
  origin,
  webRoot: join(directory, 'web'),
  enrollmentSecret: 'isolated-desktop-im-agent-fixture',
  assetOrigin: null,
  uploadOrigins: [],
});
let manager, peer;
const wait = async (check, label) => {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await check()) return;
    await delay(125);
  }
  throw Error('Timed out waiting for ' + label);
};

try {
  await relay.app.listen({ host: '127.0.0.1', port });
  let token;
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
  await account.register('managedhuman', 'Fixture Human', 'isolated-im-fixture-password');
  const human = new EncryptedMessagingClient(origin, token);
  human.account.activate(account.user, account.secrets);
  const { invitation } = await human.raw('/agent-invitations', 'POST');
  const agent = await registerAgentFixture(origin, {
    invitation,
    username: 'managedagent',
    displayName: 'Fixture Agent',
  });
  const { conversation } = await human.direct(agent.user.id);
  const state = join(directory, 'state.json');
  const handler = join(directory, 'handler.mjs');
  const started = join(directory, 'message-started');
  const released = join(directory, 'message-released');
  const heard = join(directory, 'agent-heard');
  const werift = pathToFileURL(createRequire(import.meta.url).resolve('werift')).href;
  await writeFile(
    state,
    JSON.stringify({ origin, token: agent.token, user: agent.user, secrets: agent.secrets }),
    { mode: 0o600 },
  );
  await writeFile(
    handler,
    `
import { writeFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaStreamTrack } from ${JSON.stringify(werift)};
export const capabilities = { audio: true };
export async function onMessage(event, { messaging, signal }) {
  await writeFile(${JSON.stringify(started)}, 'started');
  while (!(await access(${JSON.stringify(released)}).then(() => true, () => false))) await delay(25, undefined, { signal });
  await messaging.send(event.message.conversationId, 'fixture reply', 'desktop-test-' + event.message.id);
}
export function onCall({ peer }) {
  const output = new MediaStreamTrack({ kind: 'audio' });
  peer.addTrack(output);
  peer.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((packet) => {
    void writeFile(${JSON.stringify(heard)}, 'audio').catch(() => {});
    output.writeRtp(packet.clone());
  }));
}
`,
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, 'im-agents.json'),
    JSON.stringify([
      {
        id: 'fixture',
        state,
        messageHandler: handler,
        callHandler: handler,
        cursor: 0,
      },
    ]),
    { mode: 0o600 },
  );
  manager = superviseIndependentAgents(root, directory, () => {});
  const calls = new AgentCallsClient(human);
  await wait(async () => (await calls.capabilities(conversation.id)).audio, 'call receiver readiness');
  await human.send(conversation.id, 'fixture inbound message', 'desktop-fixture-inbound');
  await wait(
    () =>
      readFile(started).then(
        () => true,
        () => false,
      ),
    'message handler',
  );
  await assert.rejects(manager.prepare(), /正在处理消息或通话/);
  await writeFile(released, 'go');
  await wait(
    async () => (await human.history(conversation.id)).messages.some((m) => m.text === 'fixture reply'),
    'encrypted reply',
  );

  const { call } = await calls.create(conversation.id, 'audio');
  peer = new RTCPeerConnection();
  const outbound = new MediaStreamTrack({ kind: 'audio' });
  peer.addTrack(outbound);
  let incoming = 0;
  peer.onTrack.subscribe((track) => track.onReceiveRtp.subscribe(() => incoming++));
  await peer.setLocalDescription(await peer.createOffer());
  await calls.send(call, { type: 'description', description: peer.localDescription });
  let cursor = 0;
  await wait(async () => {
    const result = await calls.poll(call.id, cursor);
    cursor = result.cursor;
    for (const item of result.signals) {
      if (item.senderId !== call.agentId) continue;
      const payload = await calls.decode(call, item);
      if (payload.type === 'description') await peer.setRemoteDescription(payload.description);
      else if (peer.remoteDescription) await peer.addIceCandidate(payload.candidate);
    }
    return peer.connectionState === 'connected';
  }, 'WebRTC connection');
  await assert.rejects(manager.prepare(), /正在处理消息或通话/);
  for (let i = 1; i <= 50 && !incoming; i++) {
    outbound.writeRtp(
      new RtpPacket(
        new RtpHeader({
          payloadType: 111,
          sequenceNumber: i,
          timestamp: i * 960,
          ssrc: 1234,
        }),
        Buffer.from([0xf8, 0xff, 0xfe]),
      ),
    );
    await delay(20);
  }
  assert(incoming > 0, 'No return RTP');
  assert.equal(await readFile(heard, 'utf8'), 'audio');
  await calls.update(call.id, 'end');
  await wait(() => manager.idle(), 'call cleanup');
  await manager.prepare();
  manager.stop();
  await wait(async () => !(await calls.capabilities(conversation.id)).audio, 'call presence cleanup');
  console.log(
    'Independent Agent: encrypted text, bidirectional synthetic audio, busy update gate and presence cleanup passed.',
  );
} finally {
  manager?.stop();
  await peer?.close();
  await relay.app.close();
  await rm(directory, { recursive: true, force: true });
}
