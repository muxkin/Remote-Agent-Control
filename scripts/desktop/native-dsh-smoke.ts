import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { nodeSession } from '../../src/client/node-session.js';
import { buildRelay } from '../../src/server/relay.js';
import { apiCall } from '../../src/shared/rpc.js';
import { createIdentity } from '../../src/shared/secure-channel.js';

const state = await mkdtemp(join(tmpdir(), 'native-dsh-smoke-'));
const legacy = join(state, 'legacy');
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const png = await readFile('src/web/public/app-icon-32.png');
const workspacePdf = Buffer.from('%PDF-1.7\nfixture document\n');
const modelId = (model: string) => JSON.stringify(['fixture', model]);
const defaultProjections = () => ({
  modelSelection: { next: { provider: 'fixture', model: 'base' } },
  permissions: { currentValue: 'ask' },
  agentPreset: 'standard',
  plan: { active: false },
  turnOutline: [],
});
const instances = ['dsh-one', 'dsh-two'].map((id) => ({
  id,
  token: randomBytes(16).toString('hex'),
  title: id,
  created: new Map<string, string>(),
  inbox: [] as { id: string; content: { type: string; text: string }[] }[],
  followers: new Map<WebSocket, string>(),
  controls: new Map<WebSocket, string>(),
  eventClients: new Map<WebSocket, { stream: string; peer: string; client: string }>(),
  eventSessions: 0,
  eventReplies: [] as { clientId: string; eventId: string; outcome: any }[],
  timed: new Map<string, number>(),
  releasedWaits: [] as string[],
  lostEvents: new Set<string>(),
  competingEvents: new Set<string>(),
  receipts: new Map<string, { attachmentId: string; name: string; bytes: number }>(),
  images: new Map<string, { attachment: object; data: string }>(),
  projections: new Map<string, Record<string, unknown>>([['shared', defaultProjections()]]),
  projectionSeq: 1,
  pageWindow: 100,
  calls: [] as { method: string; request: any }[],
  records: [
    {
      event: {
        seq: 1,
        time: 123,
        type: 'assistant/message',
        data: {
          message: { id: 'reply', role: 'assistant', content: [{ type: 'text', text: 'Rust DSH history' }] },
        },
      },
    },
  ] as { event: Record<string, unknown> }[],
  opens: 0,
}));
const [one, two] = instances;
const cookie = (value?: string) => instances.find(({ id }) => value?.split('; ')[0] === 'session=' + id);
const answerPeer = (value?: string) =>
  value
    ?.split('; ')
    .find((part) => part.startsWith('answer='))
    ?.slice(7);
const dsh = createServer(async (request, response) => {
  const path = new URL(request.url!, 'http://localhost');
  if (path.pathname === '/connect') {
    const instance = instances.find(({ token }) => path.searchParams.get('token') === token);
    if (!instance) return response.writeHead(403).end();
    const mode = path.searchParams.get('interactions');
    assert(mode === 'none' || mode === 'answer');
    const cookies = ['session=' + instance.id];
    if (mode === 'answer') {
      instance.eventSessions++;
      cookies.push('answer=' + randomUUID());
    }
    return response.writeHead(302, { Location: '/api/remote.mux', 'Set-Cookie': cookies }).end();
  }
  const instance = cookie(request.headers.cookie);
  if (!instance) return response.writeHead(403).end();
  if (path.pathname === '/api/file') {
    assert.equal(instance, one);
    assert.equal(path.searchParams.get('path'), '/fixture/report copy.pdf');
    assert.equal(request.method, 'GET');
    instance.calls.push({ method: '/api/file', request: path.searchParams.get('path') });
    return response.end(workspacePdf);
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  if (path.pathname === '/api/session/uploadFileBinary') {
    assert.equal(request.headers['content-type'], 'application/octet-stream');
    assert.equal(Number(request.headers['content-length']), body.length);
    assert.equal(path.searchParams.get('sessionId'), 'shared');
    const name = path.searchParams.get('name')!;
    const file = { attachmentId: 'sha256:' + hash(body), name, bytes: body.length };
    const receiptId = randomUUID();
    instance.receipts.set(receiptId, file);
    if (name === 'race.txt') {
      record(instance, 'turn/start', { turn: 21 });
      await delay(300);
    }
    instance.calls.push({ method: 'session/uploadFileBinary', request: file });
    return response.end(JSON.stringify({ ok: true, value: { receiptId, file } }));
  }
  const rpc = JSON.parse(body.toString());
  assert.equal(path.pathname, '/api/' + rpc.method);
  const args = rpc.payload.args.request ?? rpc.payload.args;
  let value;
  switch (rpc.method) {
    case '$events/result':
      assert(
        [...instance.eventClients.values()].some(
          (binding) =>
            binding.client === args.clientId && binding.peer === answerPeer(request.headers.cookie),
        ),
      );
      instance.eventReplies.push(args);
      if (instance.lostEvents.delete(args.eventId)) return response.destroy();
      if (instance.competingEvents.delete(args.eventId)) {
        eventFrame(instance, { type: 'cancel', eventId: args.eventId });
        await delay(250);
      }
      break;
    case 'userQuestions/answer': {
      assert.equal(args.agentId, 'shared');
      assert(answerPeer(request.headers.cookie));
      const question = instance.projections.get('shared')?.userQuestions as { active: { callId: string }[] };
      const active = question.active.filter((entry) => entry.callId !== args.callId);
      value = active.length !== question.active.length;
      if (value) project(instance, 'shared', 'userQuestions', { active, settled: [] });
      break;
    }
    case 'session/page': {
      assert.deepEqual(args.address, { kind: 'session', sessionId: 'shared' });
      const earlier = instance.records.filter(
        ({ event }) => Number(event.seq) < args.beforeSeq && Number(event.seq) <= args.throughSeq,
      );
      value = { records: earlier.slice(-instance.pageWindow), hasMore: earlier.length > instance.pageWindow };
      break;
    }
    case 'fileReferences/list':
      assert.deepEqual(args, { agentId: 'shared', query: 'report' });
      value = [{ path: 'report copy.pdf' }];
      break;
    case 'session/attachment':
      assert.equal(args.sessionId, 'shared');
      value = instance.images.get(args.attachmentId);
      if (!value)
        return response.end(
          JSON.stringify({
            type: 'server-response',
            rpcId: rpc.rpcId,
            result: { ok: false, error: { code: 'session/attachment-invalid' } },
          }),
        );
      break;
    case 'session/list':
      value = {
        items: [
          { sessionId: 'shared', updatedAt: 123, projections: { values: { title: instance.title } } },
          ...[...instance.created].map(([sessionId, title]) => ({
            sessionId,
            updatedAt: 124,
            projections: { values: { title } },
          })),
        ],
      };
      break;
    case 'session/create': {
      assert.equal(args.workspaceId, 'work-' + instance.id);
      const id = 'created-' + args.sessionId;
      instance.created.set(id, '新会话');
      instance.projections.set(id, { ...defaultProjections(), agentPreset: args.agentPreset ?? 'standard' });
      value = { sessionId: id };
      break;
    }
    case 'session/projections':
      assert(instance.projections.has(args.sessionId));
      value = { kind: 'sequenced', ...baseline(instance, args.sessionId) };
      break;
    case 'session/modelCatalog':
      assert.deepEqual(args, {});
      value = {
        groups: [
          {
            id: 'fixture',
            name: 'Fixture',
            models: [
              { id: 'base', name: 'Base' },
              {
                id: 'advanced',
                name: 'Advanced',
                reasoning: { efforts: [{ id: 'high' }], defaultEffort: 'high' },
              },
              { id: 'drop', name: 'Drop response' },
            ],
          },
        ],
      };
      break;
    case 'session/selectModel': {
      const { sessionId, ...selected } = args;
      assert.equal(selected.provider, 'fixture');
      project(instance, sessionId, 'modelSelection', { next: selected });
      if (selected.model === 'drop') {
        instance.calls.push({ method: rpc.method, request: args });
        return response.destroy();
      }
      value = { selected };
      break;
    }
    case 'permissionPresets/catalog':
      assert.deepEqual(args, {});
      value = {
        defaultPreset: 'ask',
        options: [
          { value: 'ask', name: 'Ask' },
          { value: 'restricted', name: 'Restricted' },
          { value: 'ask\n/plan', name: 'Invalid preset identifier' },
        ],
      };
      break;
    case 'agentPresets/list':
      value = {
        presets: [
          { id: 'standard', isDefault: true },
          { id: 'custom', isDefault: false },
          { id: 'broken', isDefault: false, broken: 'unavailable' },
        ],
      };
      break;
    case 'agentPresets/select':
      assert.equal(args.agentPreset, 'custom');
      project(instance, args.agentId, 'agentPreset', args.agentPreset);
      value = args.agentPreset;
      break;
    case 'commands/list':
      assert(instance.projections.has(args.agentId));
      value = [{ name: 'permission' }, { name: 'plan' }];
      break;
    case 'commands/execute':
      assert.deepEqual(args.submittedAttachments, []);
      if (args.line === '/permission restricted' || args.line === '/permission ask') {
        project(instance, args.agentId, 'permissions', { currentValue: args.line.split(' ')[1] });
      } else {
        assert(['/plan', '/plan off'].includes(args.line));
        project(instance, args.agentId, 'plan', { active: args.line === '/plan' });
      }
      value = { commandId: randomUUID(), result: { kind: 'success' } };
      break;
    case 'session/prompt':
      assert(args.sessionId === 'shared' || instance.created.has(args.sessionId));
      if (['lost response', 'lost initial response'].includes(args.content[0].text)) {
        instance.calls.push({ method: rpc.method, request: args });
        return response.destroy();
      }
      if (args.content[0].text === 'queued') {
        const queued = { id: 'queue-' + args.requestId, content: args.content };
        const start = instance.inbox.length;
        instance.inbox.push(queued);
        record(instance, 'agent/inbox/spliced', { target: 'next-turn', start, inserted: [queued] });
      }
      if (args.content.some((part: any) => part.type === 'file' || part.type === 'image')) {
        const content = args.content.map((part: any) => {
          if (part.type === 'file') {
            const attachment = instance.receipts.get(part.receiptId);
            assert(attachment);
            return { type: 'file', attachment };
          }
          if (part.type === 'image') {
            assert.equal(part.mediaType, 'image/png');
            assert.deepEqual(Buffer.from(part.data, 'base64'), png);
            const attachment = {
              attachmentId: 'sha256:' + hash(png),
              mediaType: 'image/png',
              bytes: png.length,
              name: part.name,
            };
            instance.images.set(attachment.attachmentId, { attachment, data: part.data });
            return { type: 'image', attachment };
          }
          return part;
        });
        record(instance, 'assistant/message', {
          message: { id: args.requestId, role: 'assistant', content },
        });
      }
      value = { accepted: true };
      break;
    case 'session/updateQueue': {
      assert.deepEqual(args.action, { kind: 'remove' });
      const start = instance.inbox.findIndex((item) => item.id === args.itemId);
      assert(start >= 0);
      instance.inbox.splice(start, 1);
      record(instance, 'agent/inbox/spliced', {
        target: 'next-turn',
        start,
        removedCount: 1,
        inserted: [],
        outcome: 'canceled',
      });
      value = { accepted: true };
      break;
    }
    case 'session/cancel':
      assert.deepEqual(args, { sessionId: 'shared' });
      record(instance, 'turn/end', { turn: 8, reason: { kind: 'interrupted' } });
      await delay(300); // The event can reach the relay before the acknowledgement.
      value = { accepted: true };
      break;
    case 'session/rename':
      if (args.sessionId === 'shared') {
        instance.title = args.title;
        record(instance, 'session/title', { title: args.title });
      } else {
        assert(instance.created.has(args.sessionId));
        instance.created.set(args.sessionId, args.title);
      }
      value = { title: args.title, seq: instance.records.length };
      break;
    default:
      assert.fail('Unexpected DSH RPC ' + rpc.method);
  }
  instance.calls.push({ method: rpc.method, request: args });
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ type: 'server-response', rpcId: rpc.rpcId, result: { ok: true, value } }));
});
const dshSocket = new WebSocketServer({ server: dsh, path: '/api/remote.mux' });
dshSocket.on('connection', (socket, request) => {
  const instance = cookie(request.headers.cookie);
  assert(instance);
  const waits = new Map<string, string>();
  socket.on('message', (buffer) => {
    const frame = JSON.parse(buffer.toString());
    if (frame.type === 'cancel' && waits.has(frame.streamId)) {
      instance.releasedWaits.push(waits.get(frame.streamId)!);
      waits.delete(frame.streamId);
      return;
    }
    if (frame.type !== 'open') return;
    if (frame.endpoint === '$events') {
      const peer = answerPeer(request.headers.cookie);
      assert(peer);
      assert.deepEqual(frame.payload, { args: {} });
      const client = randomUUID();
      instance.eventClients.set(socket, { stream: frame.streamId, peer, client });
      socket.send(
        JSON.stringify({
          type: 'item',
          streamId: frame.streamId,
          value: {
            type: 'ready',
            clientId: client,
            host: { home: '/fixture' },
          },
        }),
      );
      return;
    }
    if (frame.endpoint === 'userQuestions/attachWait') {
      assert(instance.eventClients.has(socket));
      const { agentId, callId } = frame.payload.args;
      assert.equal(agentId, 'shared');
      const remainingMs = instance.timed.get(callId);
      assert(remainingMs !== undefined);
      waits.set(frame.streamId, callId);
      socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { remainingMs } }));
      return;
    }
    if (frame.endpoint === 'workspace/follow') {
      socket.send(
        JSON.stringify({
          type: 'item',
          streamId: frame.streamId,
          value: {
            type: 'baseline',
            value: {
              items: [
                {
                  workspaceId: 'work-' + instance.id,
                  title: 'Workspace ' + instance.id,
                  path: '/fixture',
                  sessionIds: ['shared', ...instance.created.keys()],
                },
              ],
            },
          },
        }),
      );
      return;
    }
    if (frame.endpoint === 'session/control') {
      assert.deepEqual(frame.payload.args, {});
      instance.controls.set(socket, frame.streamId);
      socket.send(
        JSON.stringify({
          type: 'item',
          streamId: frame.streamId,
          value: {
            type: 'baseline',
            value: {
              projections: Object.fromEntries(
                [...instance.projections.keys()].map((id) => [id, baseline(instance, id)]),
              ),
            },
          },
        }),
      );
      return;
    }
    assert.equal(frame.endpoint, 'session/follow');
    const id = frame.payload.args.request.address.sessionId;
    const isShared = id === 'shared';
    assert(isShared || instance.created.has(id));
    assert.equal(frame.payload.args.request.address.kind, 'session');
    socket.send(
      JSON.stringify({
        type: 'item',
        streamId: frame.streamId,
        value: {
          type: 'snapshot',
          header: { id, version: 4, cwd: '/fixture', createdAt: 123 },
          projections: {
            ...baseline(instance, id),
            values: {
              ...instance.projections.get(id),
              title: isShared ? instance.title : instance.created.get(id),
              inbox: { 'next-turn': isShared ? instance.inbox : [], 'next-step': [] },
            },
          },
          cursor: isShared ? instance.records.length : -1,
          hasMore: isShared && instance.records.length > instance.pageWindow,
          records: isShared ? instance.records.slice(-instance.pageWindow) : [],
        },
      }),
    );
    if (frame.payload.args.request.assistantStream) {
      instance.opens++;
      instance.followers.set(socket, frame.streamId);
    }
  });
  socket.once('close', () => {
    instance.followers.delete(socket);
    instance.controls.delete(socket);
    instance.eventClients.delete(socket);
  });
});
function eventFrame(instance: typeof one, value: object) {
  for (const [socket, { stream }] of instance.eventClients)
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: 'item', streamId: stream, value }));
}
function interaction(instance: typeof one, event: string, request: object, agentId = 'shared') {
  const eventId = randomUUID();
  eventFrame(instance, { type: 'waterfall', event, eventId, agentId, request });
  return eventId;
}
function baseline(instance: typeof one, id: string) {
  return {
    values: instance.projections.get(id),
    asOfSeq: Math.max(instance.records.length, instance.projectionSeq),
  };
}
function projectionFrame(instance: typeof one, value: object) {
  for (const [socket, streamId] of instance.controls)
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'item', streamId, value }));
}
function project(instance: typeof one, sessionId: string, key: string, value: unknown, publish = true) {
  const projections = instance.projections.get(sessionId);
  assert(projections);
  projections[key] = value;
  instance.projectionSeq = Math.max(instance.records.length, instance.projectionSeq) + 1;
  if (publish)
    projectionFrame(instance, { type: 'projection', sessionId, key, value, seq: instance.projectionSeq });
}
function push(instance: typeof one, value: object) {
  for (const [socket, streamId] of instance.followers)
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'item', streamId, value }));
}
function record(instance: typeof one, type: string, data: object, publish = true) {
  const event = { type, data, seq: instance.records.length + 1, time: Date.now() };
  instance.records.push({ event });
  if (publish) push(instance, { type: 'event', event });
}
function user(instance: typeof one, turn: number, requestId: string, text: string) {
  record(instance, 'user/message', {
    turn,
    id: requestId,
    role: 'user',
    source: { kind: 'user', rpcId: requestId },
    content: [{ type: 'text', text }],
  });
}
async function wait<T>(test: () => T | Promise<T>) {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const result = await test();
    if (result) return result;
    await delay(30);
  }
  assert.fail('Expected DSH state did not arrive');
}

const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const address = probe.address();
assert(address && typeof address !== 'string');
await new Promise<void>((done) => probe.close(() => done()));
const origin = 'http://127.0.0.1:' + address.port;
const enrollment = randomBytes(32).toString('hex');
const relay = await buildRelay({
  origin,
  enrollmentSecret: enrollment,
  webRoot: join(state, 'no-web'),
  assetOrigin: null,
  uploadOrigins: [],
});
const phone = await createIdentity();
let child: ReturnType<typeof spawn> | undefined;

async function launch() {
  child = spawn(resolve(process.argv[2]), ['--headless', '--print-pair'], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(POCKET_|CODEX_)/i.test(key))),
      CODEX_HOME: join(state, 'no-codex'),
      POCKET_NATIVE_STATE_DIR: state,
      POCKET_NATIVE_LEGACY_STATE: legacy,
      POCKET_NATIVE_ORIGIN: origin,
      POCKET_NATIVE_ENROLLMENT: enrollment,
      POCKET_NATIVE_P2P: '0',
      ...Object.fromEntries(instances.map(({ token }, index) => ['RUST_DSH_TEST_TOKEN_' + index, token])),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout! });
  const timeout = setTimeout(() => child?.kill(), 15000);
  try {
    for await (const line of lines) {
      if (line.startsWith(origin)) return new URL(line);
    }
    assert.fail('Rust adapter did not expose a fixture pairing link');
  } finally {
    lines.close();
    clearTimeout(timeout);
  }
}
async function stop() {
  if (!child) return;
  const exited = once(child, 'close');
  child.kill('SIGINT');
  await exited;
  child = undefined;
}

try {
  dsh.listen(0, '127.0.0.1');
  await once(dsh, 'listening');
  const carrier = dsh.address();
  assert(carrier && typeof carrier !== 'string');
  await writeFile(
    join(state, 'instances.json'),
    JSON.stringify(
      instances.map(({ id }, index) => ({
        id,
        name: id,
        plugin: '@agent-remote/adapter-dsh',
        config: { url: 'http://127.0.0.1:' + carrier.port, version: '0.2.1-rc.5' },
        secrets: { token: 'RUST_DSH_TEST_TOKEN_' + index },
      })),
    ),
    { mode: 0o600 },
  );
  await relay.app.listen({ host: '127.0.0.1', port: address.port });
  const link = await launch();
  const params = new URLSearchParams(link.hash.slice(1));
  const pair = params.get('pair')!;
  const host = params.get('host')!;
  let session = await nodeSession(origin, host, phone, createHash('sha256').update(pair).digest('hex'), {
    type: 'pair',
    protocol: 2,
    sessionId: randomUUID(),
    code: pair,
    name: 'DSH fixture',
  });
  const ready = await session.ready;
  const views = new Map<string, { thread: any; messages: Map<string, any>; order: string[] }>();
  function listen() {
    return session.onEvent((value) => {
      if (value.type !== 'sync' || value.threadId !== 'shared') return;
      for (const update of value.updates) {
        const messages = views.get(value.backendId)?.messages ?? new Map();
        for (const msg of update.changed) messages.set(msg.id, msg);
        views.set(value.backendId, { thread: update.thread, messages, order: update.order });
      }
    });
  }
  let remove = listen();
  const rpc = <T>(backendId: string, path: string, method = 'GET', body?: unknown) =>
    session.rpc<T>({ ...apiCall(path, method, body), backendId });
  const operation = (id: string, state: string, backendId = one.id) =>
    wait(async () => {
      const op = await rpc<{ state: string }>(backendId, '/operations/' + id);
      return op.state === state && op;
    });
  const watch = async (backendId: string) => {
    await session.request('watch', { backendId, threadId: 'shared' });
    await wait(() => views.get(backendId)?.thread.synchronized === true);
  };
  try {
    const { backends } = await session.rpc<{ backends: { id: string; connected: boolean }[] }>(
      apiCall('/backends'),
    );
    assert.deepEqual(
      backends.map(({ id, connected }) => [id, connected]),
      instances.map(({ id }) => [id, true]),
    );
    for (const instance of instances) {
      const { threads } = await rpc<{ threads: { id: string; title: string }[] }>(instance.id, '/threads');
      assert.deepEqual([threads[0].id, threads[0].title], ['shared', instance.id]);
      const history = await rpc<{ messages: { text: string }[] }>(instance.id, '/threads/shared/history');
      assert.equal(history.messages[0].text, 'Rust DSH history');
      await watch(instance.id);
    }

    const attachment = Buffer.from('staged DSH attachment');
    const digest = createHash('sha256').update(attachment).digest('hex');
    const uploadSpec = { name: 'scope.txt', size: attachment.length, sha256: digest, hashes: [digest] };
    const upload = await rpc<{ id: string }>(one.id, '/threads/shared/uploads', 'POST', uploadSpec);
    const file = { fileId: upload.id, backendId: one.id, threadId: 'shared' };
    await assert.rejects(session.request('file', { ...file, action: 'missing', backendId: two.id }));
    await assert.rejects(session.request('file', { ...file, action: 'missing', threadId: 'different' }));
    await assert.rejects(session.request('file', { ...file, action: 'write', index: 0 }, Uint8Array.of(0)));
    await session.request('file', { ...file, action: 'write', index: 0 }, attachment);
    assert.deepEqual((await session.request('file', { ...file, action: 'missing' })).value.missing, []);
    await session.request('file', { ...file, action: 'finish' });
    assert.deepEqual(
      Buffer.from((await session.request('file', { ...file, action: 'read', index: 0 })).bytes!),
      attachment,
    );
    await assert.rejects(session.request('file', { ...file, action: 'read', index: 0, backendId: two.id }));

    const requestId = randomUUID();
    const send = { requestId, text: 'first' };
    await rpc(one.id, '/threads/shared/messages', 'POST', send);
    await operation(requestId, 'accepted');
    await rpc(one.id, '/threads/shared/messages', 'POST', send);
    await assert.rejects(rpc(one.id, '/threads/shared/messages', 'POST', { ...send, text: 'different' }), {
      status: 409,
    });
    assert.equal(one.calls.filter((call) => call.method === 'session/prompt').length, 1);
    assert.equal(two.calls.filter((call) => call.method === 'session/prompt').length, 0);
    await rpc(two.id, '/threads/shared/messages', 'POST', { requestId, text: 'second instance' });
    await operation(requestId, 'accepted', two.id);
    assert.equal(two.calls.filter((call) => call.method === 'session/prompt').length, 1);
    record(one, 'turn/start', { turn: 8 });
    user(one, 8, requestId, 'first');
    push(one, {
      type: 'assistant-stream',
      frame: { type: 'start', revision: 1, attemptId: 'attempt', turn: 8, step: 1 },
    });
    push(one, {
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        revision: 2,
        attemptId: 'attempt',
        index: 0,
        chunk: { type: 'text-delta', index: 0, text: 'streaming' },
      },
    });
    await wait(() => views.get(one.id)?.messages.get('stream-attempt')?.text === 'streaming');
    assert.equal(views.get(two.id)?.thread.activeTurnId, null);

    const stale = randomUUID();
    await rpc(one.id, '/threads/shared/steer', 'POST', {
      requestId: stale,
      expectedTurnId: '7',
      text: 'old',
    });
    await operation(stale, 'rejected');
    const steer = randomUUID();
    await rpc(one.id, '/threads/shared/steer', 'POST', {
      requestId: steer,
      expectedTurnId: '8',
      text: 'steer',
    });
    await operation(steer, 'accepted');
    user(one, 8, steer, 'steer');
    const queued = randomUUID();
    const beforeQueue = views.get(one.id)?.thread.queueFingerprint;
    assert.equal(typeof beforeQueue, 'string');
    await rpc(one.id, '/threads/shared/queue', 'POST', {
      requestId: queued,
      text: 'queued',
      expectedQueueFingerprint: beforeQueue,
    });
    await operation(queued, 'accepted');
    await wait(() =>
      views.get(one.id)?.thread.queuedMessages.some((item: any) => item.id === 'queue-' + queued),
    );
    const staleRemoval = randomUUID();
    await rpc(one.id, '/threads/shared/queue-remove', 'POST', {
      requestId: staleRemoval,
      messageId: 'queue-' + queued,
      expectedQueueFingerprint: beforeQueue,
    });
    await operation(staleRemoval, 'rejected');
    assert(!one.calls.some((call) => call.method === 'session/updateQueue'));
    const removed = randomUUID();
    await rpc(one.id, '/threads/shared/queue-remove', 'POST', {
      requestId: removed,
      messageId: 'queue-' + queued,
      expectedQueueFingerprint: views.get(one.id)?.thread.queueFingerprint,
    });
    await operation(removed, 'completed');
    await wait(() => views.get(one.id)?.thread.queuedMessages.length === 0);
    const cancel = randomUUID();
    await rpc(one.id, '/threads/shared/interrupt', 'POST', { requestId: cancel, expectedTurnId: '8' });
    await operation(cancel, 'interrupted');
    await operation(steer, 'interrupted');
    await operation(requestId, 'interrupted');
    await wait(
      () =>
        views.get(one.id)?.thread.canSend === true && !views.get(one.id)?.order.includes('stream-attempt'),
    );

    const reopen = one.opens;
    record(one, 'turn/start', { turn: 9 }, false);
    record(one, 'turn/end', { turn: 9, reason: { kind: 'completed' } });
    await wait(() => one.opens > reopen && views.get(one.id)?.thread.synchronized === true);
    const rename = randomUUID();
    await rpc(one.id, '/threads/shared/rename', 'POST', { requestId: rename, title: 'renamed' });
    await operation(rename, 'completed');

    await wait(() => views.get(one.id)?.thread.title === 'renamed');
    const stage = async (name: string, data: Buffer) => {
      const digest = hash(data);
      const { id } = await rpc<{ id: string }>(one.id, '/threads/shared/uploads', 'POST', {
        name,
        size: data.length,
        sha256: digest,
        hashes: [digest],
      });
      const file = { fileId: id, backendId: one.id, threadId: 'shared' };
      await session.request('file', { ...file, action: 'write', index: 0 }, data);
      await session.request('file', { ...file, action: 'finish' });
      return id;
    };
    const describe = (backendId: string, path: string) =>
      rpc<{ id: string; mime: string }>(backendId, '/threads/shared/media', 'POST', { path });
    const download = async (path: string, mime: string) => {
      const manifest = await describe(one.id, path);
      assert.equal(manifest.mime, mime);
      const reply = await session.request('file', { ...file, fileId: manifest.id, action: 'read', index: 0 });
      return Buffer.from(reply.bytes!);
    };
    const fileRef = 'dsh-file:sha256:' + digest;
    const imageRef = 'dsh-image:sha256:' + hash(png);
    await assert.rejects(describe(one.id, fileRef), { status: 404 });
    await assert.rejects(describe(two.id, imageRef), { status: 404 });
    const imageUpload = await stage('image.png', png);
    const mediaSend = { requestId: randomUUID(), text: '', uploadIds: [upload.id, imageUpload] };
    await assert.rejects(rpc(two.id, '/threads/shared/messages', 'POST', mediaSend));
    await rpc(one.id, '/threads/shared/messages', 'POST', mediaSend);
    await operation(mediaSend.requestId, 'accepted');
    await rpc(one.id, '/threads/shared/messages', 'POST', mediaSend);
    assert.equal(one.calls.filter((call) => call.method === 'session/uploadFileBinary').length, 1);
    assert.equal(one.calls.filter((call) => call.request.requestId === mediaSend.requestId).length, 1);
    await wait(() => views.get(one.id)?.messages.get(mediaSend.requestId)?.attachments?.length === 2);
    assert.deepEqual(views.get(one.id)?.messages.get(mediaSend.requestId)?.attachments, [
      { path: fileRef, name: 'scope.txt' },
      { path: imageRef, name: 'image.png' },
    ]);
    assert.deepEqual(await download(fileRef, 'text/plain'), attachment);
    assert.deepEqual(await download(imageRef, 'image/png'), png);
    await assert.rejects(describe(two.id, fileRef), { status: 404 });
    assert.deepEqual(await rpc(one.id, '/threads/shared/references?q=report'), {
      files: [{ name: 'report copy.pdf', path: 'report copy.pdf' }],
    });
    record(one, 'assistant/message', {
      message: {
        id: 'workspace-link',
        role: 'assistant',
        content: [
          { type: 'text', text: '[Document](./notes/../report%20copy.pdf) and `[private](secret.pdf)`' },
        ],
      },
    });
    await assert.rejects(describe(two.id, 'report%20copy.pdf'), { status: 404 });
    await assert.rejects(describe(one.id, 'secret.pdf'), { status: 404 });
    assert.deepEqual(await download('report%20copy.pdf', 'application/pdf'), workspacePdf);
    assert.equal(one.calls.filter(({ method }) => method === '/api/file').length, 1);

    const legacyData = Buffer.from('original DSH file from the Node adapter');
    const legacyDigest = 'sha256:' + hash(legacyData);
    const oldPath = join(legacy, 'uploads', randomUUID(), 'old.txt');
    const receiptDir = join(legacy, 'backends', one.id, 'receipts');
    await mkdir(join(oldPath, '..'), { recursive: true, mode: 0o700 });
    await mkdir(receiptDir, { recursive: true, mode: 0o700 });
    await writeFile(oldPath, legacyData, { mode: 0o600 });
    await writeFile(
      join(receiptDir, hash(JSON.stringify(['shared', legacyDigest])) + '.json'),
      JSON.stringify({ path: oldPath }),
      { mode: 0o600 },
    );
    record(one, 'assistant/message', {
      message: {
        id: 'legacy-media',
        role: 'assistant',
        content: [
          {
            type: 'file',
            attachment: { attachmentId: legacyDigest, bytes: legacyData.length, name: 'old.txt' },
          },
        ],
      },
    });
    record(one, 'assistant/message', {
      message: { id: 'later', role: 'assistant', content: [{ type: 'text', text: 'Newer record' }] },
    });
    one.pageWindow = 1;
    assert.deepEqual(await download('dsh-file:' + legacyDigest, 'text/plain'), legacyData);
    assert.deepEqual(await download('report%20copy.pdf', 'application/pdf'), workspacePdf);
    assert(one.calls.some(({ method }) => method === 'session/page'));
    one.pageWindow = 100;
    await writeFile(oldPath, Buffer.alloc(legacyData.length, 0x01), { mode: 0o600 });
    await assert.rejects(describe(one.id, 'dsh-file:' + legacyDigest));

    const raceUpload = await stage('race.txt', Buffer.from('changed turn'));
    const race = { requestId: randomUUID(), text: '', uploadIds: [raceUpload] };
    await rpc(one.id, '/threads/shared/messages', 'POST', race);
    await operation(race.requestId, 'rejected');
    assert(!one.calls.some((call) => call.request.requestId === race.requestId));
    record(one, 'turn/end', { turn: 21, reason: { kind: 'completed' } });
    await wait(() => views.get(one.id)?.thread.canSend === true);

    const cards = () => (views.get(one.id)?.thread.requests ?? []) as any[];
    const cardFor = (eventId: string) => wait(() => cards().find((card) => card.id.endsWith(':' + eventId)));
    const responseTo = (card: any, reply: object, requestId = randomUUID()) => ({
      requestId,
      targetRequestId: card.id,
      expectedTurnId: card.turnId,
      expectedFingerprint: card.fingerprint,
      ...reply,
    });
    const respond = async (body: ReturnType<typeof responseTo>, state: string) => {
      await rpc(one.id, '/threads/shared/responses', 'POST', body);
      await operation(body.requestId, state);
    };
    const outcome = (id: string) =>
      wait(() => one.eventReplies.find((entry) => entry.eventId === id)?.outcome);
    const approval = { toolName: 'fixture-tool', reason: 'Isolated approval' };
    const questions = [
      {
        id: 'mode',
        question: 'Select mode',
        multiSelect: true,
        options: [{ label: 'A', description: 'Fixture choice' }, { label: 'B' }],
      },
    ];
    await wait(() => one.eventClients.size === 1 && two.eventClients.size === 1);
    const unwatched = interaction(one, 'approval/request', approval, 'not-watched');
    assert.deepEqual(await outcome(unwatched), { kind: 'next' });
    const unknown = interaction(one, 'unsupported/event', {});
    assert.deepEqual(await outcome(unknown), { kind: 'next' });
    record(one, 'turn/start', { turn: 22 });
    await wait(() => views.get(one.id)?.thread.activeTurnId === '22');
    const asked = interaction(one, 'approval/request', approval);
    const card = await cardFor(asked);
    assert.deepEqual(card.decisions, ['accept', 'decline', 'cancel']);
    assert.equal(card.turnId, '22');
    assert.deepEqual(views.get(two.id)?.thread.requests, []);
    await respond(responseTo(card, { decision: 'accept', expectedTurnId: '21' }), 'rejected');
    await respond(responseTo(card, { decision: 'acceptForSession' }), 'rejected');
    await respond(responseTo(card, { decision: 'decline', expectedFingerprint: '0'.repeat(64) }), 'rejected');
    const decision = responseTo(card, { decision: 'accept' });
    await respond(decision, 'completed');
    assert.deepEqual(await outcome(asked), { kind: 'result', value: 'allowed-once' });
    await respond(decision, 'completed');
    assert.equal(one.eventReplies.filter((entry) => entry.eventId === asked).length, 1);
    await wait(() => !cards().length);

    const cancelled = interaction(one, 'approval/request', approval);
    const obsolete = await cardFor(cancelled);
    eventFrame(one, { type: 'cancel', eventId: cancelled });
    await wait(() => !cards().length);
    await respond(responseTo(obsolete, { decision: 'accept' }), 'rejected');
    assert(!one.eventReplies.some((entry) => entry.eventId === cancelled));

    const concurrent = interaction(one, 'approval/request', approval);
    const competingCard = await cardFor(concurrent);
    one.competingEvents.add(concurrent);
    await respond(responseTo(competingCard, { decision: 'decline' }), 'rejected');
    await wait(() => !cards().length);

    const question = interaction(one, 'user-questions/request', { questions });
    const pending = await cardFor(question);
    assert.equal(pending.kind, 'question');
    await respond(responseTo(pending, { answers: { other: ['A'] } }), 'rejected');
    await respond(responseTo(pending, { answers: { mode: ['A', 'Other'] } }), 'completed');
    assert.deepEqual(await outcome(question), {
      kind: 'result',
      value: { answers: [{ id: 'mode', selected: ['A'], custom: 'Other' }] },
    });
    one.timed.set('call-timed', 900);
    const timed = interaction(one, 'user-questions/request', {
      questions,
      wait: { timed: true, callId: 'call-timed' },
    });
    const timedCard = await cardFor(timed);
    assert.deepEqual(await outcome(timed), { kind: 'next' });
    await wait(() => one.releasedWaits.includes('call-timed') && !cards().length);
    await respond(responseTo(timedCard, { answers: { mode: ['B'] } }), 'rejected');
    project(one, 'shared', 'userQuestions', {
      active: [{ state: 'continued', callId: 'call-timed', questions }],
      settled: [],
    });
    const late = await wait(() => cards().find((card) => card.kind === 'async-question'));
    assert.equal(late.turnId, null);
    await respond(responseTo(late, { answers: { mode: ['B'] } }), 'completed');
    await wait(() => !cards().length);

    const uncertainEvent = interaction(one, 'approval/request', approval);
    const uncertainCard = await cardFor(uncertainEvent);
    one.lostEvents.add(uncertainEvent);
    const uncertainResponse = responseTo(uncertainCard, { decision: 'decline' });
    await respond(uncertainResponse, 'uncertain');
    await respond(uncertainResponse, 'uncertain');
    assert.equal(one.eventReplies.filter((entry) => entry.eventId === uncertainEvent).length, 1);

    const beforeDisconnect = interaction(one, 'approval/request', approval);
    const disconnectedCard = await cardFor(beforeDisconnect);
    const [eventSocket, binding] = [...one.eventClients][0];
    eventSocket.terminate();
    await wait(
      () => !cards().length && [...one.eventClients.values()].some(({ client }) => client !== binding.client),
    );
    await respond(responseTo(disconnectedCard, { decision: 'accept' }), 'rejected');
    assert(!one.eventReplies.some((entry) => entry.eventId === beforeDisconnect));
    assert.equal(views.get(one.id)?.thread.synchronized, true);

    const noWatcher = interaction(one, 'approval/request', approval);
    await cardFor(noWatcher);
    await session.request('unwatch', { backendId: one.id, threadId: 'shared' });
    assert.deepEqual(await outcome(noWatcher), { kind: 'next' });
    await wait(() => one.eventClients.size === 0);
    views.delete(one.id);
    await watch(one.id);
    record(one, 'turn/end', { turn: 22, reason: { kind: 'completed' } });
    await wait(() => views.get(one.id)?.thread.canSend === true);
    const models = await rpc<{ models: { id: string; efforts: string[] }[] }>(one.id, '/models');
    assert.deepEqual(
      models.models.map(({ id, efforts }) => [id, efforts]),
      [
        [modelId('base'), ['default']],
        [modelId('advanced'), ['high']],
        [modelId('drop'), ['default']],
      ],
    );
    const controls = await rpc<{ actions: string[]; presets: { id: string }[] }>(
      one.id,
      '/threads/shared/controls',
    );
    assert.deepEqual(controls.actions, ['permission', 'preset', 'plan']);
    assert.deepEqual(
      controls.presets.map(({ id }) => id),
      ['standard', 'custom'],
    );
    await wait(() => views.get(one.id)?.thread.model === modelId('base'));
    const modelChange = {
      requestId: randomUUID(),
      model: modelId('advanced'),
      effort: 'high',
      mode: 'default',
      expectedMode: 'default',
      serviceTier: 'default',
      expectedServiceTier: null,
      expectedModel: modelId('base'),
      expectedEffort: 'default',
    };
    await rpc(one.id, '/threads/shared/settings', 'POST', modelChange);
    await operation(modelChange.requestId, 'completed');
    await wait(() => views.get(one.id)?.thread.reasoningEffort === 'high');
    await rpc(one.id, '/threads/shared/settings', 'POST', modelChange);
    assert.equal(one.calls.filter((call) => call.method === 'session/selectModel').length, 1);
    assert.equal(views.get(two.id)?.thread.model, modelId('base'));
    projectionFrame(one, {
      type: 'projection',
      sessionId: 'shared',
      key: 'modelSelection',
      seq: one.projectionSeq - 1,
      value: defaultProjections().modelSelection,
    });
    project(one, 'shared', 'plan', { active: true }, false);
    const staleModel = {
      ...modelChange,
      requestId: randomUUID(),
      expectedModel: modelId('advanced'),
      expectedEffort: 'high',
    };
    await rpc(one.id, '/threads/shared/settings', 'POST', staleModel);
    await operation(staleModel.requestId, 'rejected');
    assert.equal(one.calls.filter((call) => call.method === 'session/selectModel').length, 1);
    assert.equal(views.get(one.id)?.thread.model, modelId('advanced'));

    const control = async (value: object, expected = 'completed') => {
      const requestId = randomUUID();
      await rpc(one.id, '/threads/shared/control', 'POST', { requestId, control: value });
      await operation(requestId, expected);
    };
    const permissionRevision = views.get(one.id)?.thread.controls.permissionRevision;
    assert.equal(typeof permissionRevision, 'string');
    await control({ action: 'permission', expected: 'ask', value: 'ask\n/plan' }, 'rejected');
    await control({ action: 'permission', expected: 'restricted', value: 'ask' }, 'rejected');
    assert(!one.calls.some((call) => call.method === 'commands/execute'));
    await control({
      action: 'permission',
      expected: 'ask',
      expectedRevision: permissionRevision,
      value: 'restricted',
    });
    await wait(() => views.get(one.id)?.thread.controls.permission === 'restricted');
    await control({ action: 'plan', enabled: false });
    await wait(() => views.get(one.id)?.thread.controls.plan === false);
    await control({ action: 'plan', enabled: true });
    await wait(() => views.get(one.id)?.thread.mode === 'plan');
    project(one, 'shared', 'turnOutline', [{ turn: 8 }], false);
    await control({ action: 'preset', value: 'custom' }, 'rejected');
    project(one, 'shared', 'turnOutline', []);
    await control({ action: 'preset', value: 'custom' });
    await wait(() => views.get(one.id)?.thread.controls.preset === 'custom');
    const lostSetting = {
      ...staleModel,
      requestId: randomUUID(),
      model: modelId('drop'),
      effort: 'default',
      mode: 'plan',
      expectedMode: 'plan',
    };
    await rpc(one.id, '/threads/shared/settings', 'POST', lostSetting);
    await operation(lostSetting.requestId, 'uncertain');
    await wait(() => views.get(one.id)?.thread.model === modelId('drop'));

    const grouped = await rpc<{ threads: { id: string; projectId: string }[] }>(
      one.id,
      '/threads?project=work-dsh-one',
    );
    assert.equal(grouped.threads[0].projectId, 'work-dsh-one');
    assert.deepEqual(await rpc(one.id, '/projects'), {
      projects: [{ id: 'work-dsh-one', name: 'Workspace dsh-one', count: 1 }],
      total: 1,
      ungrouped: 0,
    });
    const create = randomUUID();
    await rpc(one.id, '/threads/new/create', 'POST', {
      requestId: create,
      title: 'new session',
      prompt: 'initial',
      projectId: 'work-dsh-one',
      model: modelId('advanced'),
      thinking: 'high',
      permission: 'restricted',
      agentPreset: 'custom',
      plan: true,
    });
    const completed = (await operation(create, 'completed')) as { resultThreadId?: string };
    assert.equal(completed.resultThreadId, 'created-' + create);
    assert.equal(one.created.get('created-' + create), 'new session');
    assert.deepEqual(one.projections.get('created-' + create), {
      modelSelection: { next: { provider: 'fixture', model: 'advanced', reasoningEffort: 'high' } },
      permissions: { currentValue: 'restricted' },
      agentPreset: 'custom',
      plan: { active: true },
      turnOutline: [],
    });
    const createOrder = one.calls
      .filter(
        ({ request }) => request.sessionId === 'created-' + create || request.agentId === 'created-' + create,
      )
      .map(({ method }) => method);
    assert.equal(createOrder.at(-1), 'session/prompt');
    assert(createOrder.indexOf('session/selectModel') < createOrder.indexOf('session/prompt'));
    const partial = randomUUID();
    await rpc(one.id, '/threads/new/create', 'POST', {
      requestId: partial,
      title: 'partial',
      prompt: 'lost initial response',
      projectId: 'work-dsh-one',
    });
    const incomplete = (await operation(partial, 'uncertain')) as { resultThreadId?: string };
    assert.equal(incomplete.resultThreadId, 'created-' + partial);
    assert(!two.created.size);

    const lost = randomUUID();
    await rpc(one.id, '/threads/shared/messages', 'POST', { requestId: lost, text: 'lost response' });
    await operation(lost, 'uncertain');
    const restartCount = one.calls.length;
    remove();
    session.close();
    await stop();
    await launch();
    views.clear();
    session = await nodeSession(origin, host, phone, ready.ticket, {
      type: 'authenticate',
      protocol: 2,
      sessionId: randomUUID(),
    });
    remove = listen();
    await watch(one.id);
    assert.deepEqual(await download(fileRef, 'text/plain'), attachment);
    await rpc(one.id, '/threads/shared/settings', 'POST', lostSetting);
    await operation(lostSetting.requestId, 'uncertain');
    assert.equal(
      one.calls.filter(({ method, request }) => method === 'session/selectModel' && request.model === 'drop')
        .length,
      1,
    );
    await rpc(one.id, '/threads/shared/messages', 'POST', { requestId: lost, text: 'lost response' });
    await operation(lost, 'uncertain');
    assert.equal(one.calls.length, restartCount);
    record(one, 'turn/start', { turn: 10 });
    user(one, 10, lost, 'lost response');
    record(one, 'turn/end', { turn: 10, reason: { kind: 'completed' } });
    await operation(lost, 'completed');

    remove();
    session.close();
    await stop();
    await writeFile(join(state, 'gateway.env'), 'POCKET_READ_ONLY=1\n', { mode: 0o600 });
    const beforeReadOnly = one.eventSessions;
    await launch();
    views.clear();
    session = await nodeSession(origin, host, phone, ready.ticket, {
      type: 'authenticate',
      protocol: 2,
      sessionId: randomUUID(),
    });
    remove = listen();
    await watch(one.id);
    assert.equal(one.eventSessions, beforeReadOnly);
    assert.equal(views.get(one.id)?.thread.canSend, false);
    assert.equal((await rpc<{ writesEnabled: boolean }>(one.id, '/status')).writesEnabled, false);
    assert.deepEqual((await rpc<{ actions: string[] }>(one.id, '/threads/shared/controls')).actions, []);
    await assert.rejects(rpc(one.id, '/threads/shared/uploads', 'POST', uploadSpec));
    await assert.rejects(session.request('file', { ...file, action: 'finish' }));
    assert.deepEqual(
      Buffer.from((await session.request('file', { ...file, action: 'read', index: 0 })).bytes!),
      attachment,
    );
    const blocked = randomUUID();
    const before = one.calls.length;
    await rpc(one.id, '/threads/shared/messages', 'POST', {
      requestId: blocked,
      text: 'blocked by migrated read-only config',
    });
    await operation(blocked, 'rejected');
    assert.equal(one.calls.length, before);
    await control({ action: 'plan', enabled: false }, 'rejected');
    assert.equal(one.calls.length, before);
  } finally {
    remove();
    session.close();
  }
  console.log(
    'Rust DSH: scoped media, settings, approvals and questions, timed delegation and late answers, recovery, replay and read-only policy passed.',
  );
} finally {
  await stop();
  for (const socket of dshSocket.clients) socket.terminate();
  dshSocket.close();
  dsh.close();
  await relay.app.close();
  await rm(state, { recursive: true, force: true });
}
