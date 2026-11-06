import { DshFixtureConnection as Connection, snapshot } from './dsh-fixture.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DshBackend } from '../src/server/backends/dsh.js';
import { Store } from '../src/server/store.js';
import { Operations } from '../src/server/operations.js';
import { randomUUID } from 'node:crypto';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
async function setup(id = 'dsh-one') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-test-')),
    conn = new Connection(),
    backend = new DshBackend(
      { id, name: id, url: 'http://127.0.0.1:7777', token: 'fixture', version: '0.2.1-rc.5' },
      dir,
      false,
      conn,
    );
  const store = new Store(join(dir, 'state'));
  const operations = new Operations(backend, store, id);
  cleanup.push(() => {
    operations.close();
    backend.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await backend.start();
  await backend.history.list();
  const release = await backend.acquire('shared');
  await backend.waitForView('shared');
  return { dir, conn, backend, store, operations, release };
}
it('maps native durable events to shared messages and operation completion without starting an Agent', async () => {
  const { conn, backend, store, operations } = await setup();
  const id = randomUUID();
  operations.submit('device', 'shared', id, 'send', JSON.stringify({ text: 'hello' }));
  await expect.poll(() => conn.calls.filter((c) => c.endpoint === 'session/prompt').length).toBe(1);
  conn.push({ type: 'event', event: { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } });
  conn.push({
    type: 'event',
    event: {
      type: 'user/message',
      seq: 1,
      time: 1,
      surfaceOp: 'append',
      data: {
        id: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user', rpcId: id },
      },
    },
  });
  conn.push({
    type: 'event',
    event: { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  });
  expect(store.operation(id, undefined, backend.id)?.state).toBe('completed');
  expect(backend.view('shared')?.messages[0].text).toBe('hello');
  operations.submit('device', 'shared', id, 'send', JSON.stringify({ text: 'hello' }));
  expect(conn.calls.filter((c) => c.endpoint === 'session/prompt')).toHaveLength(1);
  expect(conn.calls.some((c) => /launch|start|shutdown|dispose/.test(c.endpoint))).toBe(false);
});
it('reads workspace baselines and refreshes grouping without a fabricated list RPC', async () => {
  const { conn, backend } = await setup();
  conn.workspaces = [
    {
      workspaceId: 'workspace',
      title: 'Project',
      path: '/fixture',
      sessionIds: ['shared'],
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  expect(await backend.projects('shared')).toEqual([{ id: 'workspace', name: 'Project', path: '/fixture' }]);
  expect((await backend.history.list()).threads[0].projectId).toBe('workspace');
  expect(await backend.history.projects()).toMatchObject({
    projects: [{ id: 'workspace', count: 1 }],
    ungrouped: 0,
  });
  conn.workspaces = [];
  expect((await backend.history.list()).threads[0].projectId).toBeNull();
  expect(conn.calls.some((c) => c.endpoint === 'workspace/list')).toBe(false);
});
it('preserves injected context as collapsed activity rather than impersonating user messages', async () => {
  const { conn, backend } = await setup();
  conn.push({
    type: 'event',
    event: {
      seq: 0,
      time: 1,
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        id: 'context',
        role: 'user',
        source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
        content: [{ type: 'text', text: 'Runtime instructions' }],
      },
    },
  });
  expect(backend.view('shared')!.messages).toMatchObject([
    { role: 'tool', text: 'DSH 上下文 · runtime-context', details: 'Runtime instructions' },
  ]);
});
it('withdraws native answers, delegates unknown interactions and rejects replies from old connections', async () => {
  const { conn, backend } = await setup();
  const event = {
    type: 'waterfall',
    event: 'approval/request',
    eventId: 'same',
    agentId: 'shared',
    request: { toolName: 'shell', reason: 'fixture' },
  };
  conn.event(event);
  let card = backend.view('shared')!.requests![0];
  const response = () =>
    JSON.stringify({
      targetRequestId: card.id,
      expectedFingerprint: card.fingerprint,
      expectedTurnId: card.turnId,
      decision: 'accept',
    });
  conn.event({ type: 'cancel', eventId: 'same' });
  expect(backend.view('shared')!.requests).toEqual([]);
  await expect(backend.control('shared', 'respond', response(), randomUUID())).rejects.toThrow();
  conn.event(event);
  expect(backend.view('shared')!.requests).toEqual([]);
  event.eventId = 'replacement';
  conn.event(event);
  card = backend.view('shared')!.requests![0];
  const old = response();
  conn.stop();
  conn.generation++;
  await conn.start();
  await backend.waitForView('shared');
  conn.event(event);
  await expect(backend.control('shared', 'respond', old, randomUUID())).rejects.toThrow();
  card = backend.view('shared')!.requests![0];
  await backend.control('shared', 'respond', response(), randomUUID());
  expect(conn.calls.at(-1)).toMatchObject({
    endpoint: '$events/result',
    args: {
      clientId: 'client-2',
      eventId: 'replacement',
      outcome: { kind: 'result', value: 'allowed-once' },
    },
  });
  conn.event({ ...event, eventId: 'unknown', event: 'unknown/request' });
  expect(conn.calls.at(-1).args.outcome).toEqual({ kind: 'next' });
});
it('ignores repeated native events and reacquires a snapshot on a gap', async () => {
  const { conn, backend } = await setup();
  const event = { type: 'event', event: { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } };
  conn.push(event);
  const revision = backend.view('shared')!.revision;
  conn.push(event);
  expect(backend.view('shared')!.revision).toBe(revision);
  conn.push({ ...event, event: { ...event.event, seq: 3 } });
  expect(backend.view('shared')!.synchronized).toBe(false);
  await expect.poll(() => conn.opens).toBe(2);
});
it('isolates operation identity, history and backend capabilities', async () => {
  const { store, backend } = await setup();
  const id = randomUUID();
  store.beginOperation(id, 'device', 'shared', 'send', 'a', 'dsh-one');
  store.beginOperation(id, 'device', 'shared', 'send', 'b', 'dsh-two');
  store.updateOperation(id, 'completed', null, null, 'dsh-one');
  expect(store.operation(id, undefined, 'dsh-two')?.state).toBe('received');
  expect(store.recent('device', 'shared', 'codex-local')).toEqual([]);
  expect(backend.info().capabilities.plugins.state).toBe('unsupported');
});

it('merges native projection watermarks and retires streamed text exactly once', async () => {
  const { conn, backend } = await setup();
  const projection = (seq: number, value: string) =>
    conn.streams.get('session/control')!({
      type: 'projection',
      sessionId: 'shared',
      key: 'title',
      value,
      seq,
    });
  projection(5, 'new');
  projection(4, 'old');
  conn.push({ ...snapshot('shared', 'baseline'), projections: { asOfSeq: 3, values: { title: 'stale' } } });
  expect(backend.view('shared')?.title).toBe('new');
  conn.push({ type: 'event', event: { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } });
  conn.push({
    type: 'assistant-stream',
    frame: { type: 'start', attemptId: 'attempt', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 },
  });
  expect(backend.view('shared')?.messages.map((m) => m.id)).toEqual(['stream-attempt']);
  conn.push({
    type: 'event',
    event: {
      type: 'assistant/message',
      seq: 1,
      time: 2,
      surfaceOp: { op: 'append' },
      data: {
        turn: 1,
        step: 1,
        message: { id: 'committed', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      },
    },
  });
  expect(backend.view('shared')?.messages.map((m) => m.id)).toEqual(['committed']);
  conn.push({
    type: 'assistant-stream',
    frame: {
      type: 'end',
      attemptId: 'attempt',
      revision: 2,
      index: 0,
      outcome: { kind: 'committed', seq: 1, eventType: 'assistant/message' },
    },
  });
  conn.push({
    type: 'assistant-stream',
    frame: { type: 'start', attemptId: 'attempt', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 },
  });
  expect(backend.view('shared')?.messages.map((m) => m.id)).toEqual(['committed']);
  conn.stop();
  conn.generation++;
  await conn.start();
  await backend.waitForView('shared');
  expect(backend.view('shared')?.title).toBe('same ID');
});
it('uses native file receipts and image parts, and rejects stale queue/settings controls', async () => {
  const { conn, backend, dir } = await setup();
  const file = join(dir, 'file.txt'),
    image = join(dir, 'image.png');
  writeFileSync(file, 'fixture file');
  writeFileSync(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let uploads = 0;
  conn.fetch = async (path?: string) => {
    expect(path).toContain('api/session/uploadFileBinary?');
    uploads++;
    return Response.json({
      ok: true,
      value: { receiptId: 'receipt', file: { attachmentId: 'file-ref', name: 'file.txt', bytes: 12 } },
    });
  };
  await backend.execute(
    'shared',
    {
      kind: 'send',
      text: 'hello',
      attachments: [
        { name: 'file.txt', path: file },
        { name: 'image.png', path: image },
      ],
      skillIds: [],
      pluginIds: [],
    },
    randomUUID(),
  );
  expect(uploads).toBe(1);
  expect(conn.calls.at(-1)).toMatchObject({
    endpoint: 'session/prompt',
    args: {
      request: {
        mode: 'queue',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'file', receiptId: 'receipt' },
          { type: 'image', mediaType: 'image/png' },
        ],
      },
    },
  });
  const before = conn.calls.length;
  await expect(
    backend.execute(
      'shared',
      { kind: 'queue', text: 'later', expectedQueueFingerprint: 'stale' },
      randomUUID(),
    ),
  ).rejects.toThrow('队列已变化');
  await expect(
    backend.execute(
      'shared',
      {
        kind: 'settings',
        model: '["provider","model"]',
        effort: 'default',
        expectedModel: 'old',
        expectedEffort: 'default',
      },
      randomUUID(),
    ),
  ).rejects.toThrow('设置已变化');
  expect(conn.calls.length).toBe(before);
  conn.push({
    type: 'event',
    event: {
      type: 'user/message',
      seq: 0,
      time: 1,
      surfaceOp: { op: 'append' },
      data: {
        id: 'file-message',
        role: 'user',
        content: [{ type: 'file', attachment: { attachmentId: 'file-ref', name: 'file.txt', bytes: 12 } }],
      },
    },
  });
  expect(await backend.attachment('shared', 'dsh-file:file-ref')).toBe(file);
  await expect(backend.attachment('shared', 'dsh-file:another-session')).rejects.toThrow();
});
it('retains a created conversation when the subsequent native prompt fails without replaying create', async () => {
  const { conn, backend, operations, store } = await setup();
  const original = conn.call.bind(conn);
  conn.call = async (endpoint, args) => {
    if (endpoint === 'session/prompt') throw Error('response lost');
    return original(endpoint, args);
  };
  const id = randomUUID();
  const input = JSON.stringify({
    prompt: 'hello',
    title: 'new',
    model: '["provider","model"]',
    thinking: 'default',
  });
  operations.submit('device', 'new', id, 'create', input);
  await expect.poll(() => store.operation(id, undefined, backend.id)?.state).toBe('uncertain');
  expect(store.operation(id, undefined, backend.id)?.resultThreadId).toBe(id);
  expect(conn.calls.find((c) => c.endpoint === 'session/selectModel').args.request).not.toHaveProperty(
    'reasoningEffort',
  );
  operations.submit('device', 'new', id, 'create', input);
  expect(conn.calls.filter((c) => c.endpoint === 'session/create')).toHaveLength(1);
});
it('releases timed question claims and withdraws continued questions answered by the native UI', async () => {
  const { conn, backend } = await setup();
  const questions = [{ id: 'q', question: 'Choose', options: [{ label: 'yes', description: '' }] }];
  conn.event({
    type: 'waterfall',
    event: 'user-questions/request',
    eventId: 'question-event',
    agentId: 'shared',
    request: { questions, wait: { timed: true, callId: 'q-call' } },
  });
  expect(conn.streams.has('userQuestions/attachWait')).toBe(true);
  conn.event({ type: 'cancel', eventId: 'question-event' });
  expect(conn.streams.has('userQuestions/attachWait')).toBe(false);
  const update = (seq: number, active: any[]) =>
    conn.streams.get('session/control')!({
      type: 'projection',
      sessionId: 'shared',
      key: 'userQuestions',
      seq,
      value: { active },
    });
  update(1, [{ state: 'continued', callId: 'q-call', questions }]);
  const card = backend.view('shared')!.requests![0];
  update(2, []);
  update(1, [{ state: 'continued', callId: 'q-call', questions }]);
  expect(backend.view('shared')!.requests).toEqual([]);
  await expect(
    backend.execute(
      'shared',
      {
        kind: 'respond',
        response: {
          targetRequestId: card.id,
          expectedFingerprint: card.fingerprint,
          expectedTurnId: null,
          answers: { q: ['yes'] },
        },
      },
      randomUUID(),
    ),
  ).rejects.toThrow();
});

it('hands unanswered interactions back when the last viewer leaves', async () => {
  const { conn, backend, release } = await setup();
  conn.event({
    type: 'waterfall',
    event: 'approval/request',
    eventId: 'unanswered',
    agentId: 'shared',
    request: { toolName: 'shell', reason: 'fixture' },
  });
  const card = backend.view('shared')!.requests![0];
  const late = conn.streams.get('shared')!;
  release();
  expect(conn.calls.at(-1)).toMatchObject({
    endpoint: '$events/result',
    args: { eventId: 'unanswered', outcome: { kind: 'next' } },
  });
  late(snapshot('shared', 'late snapshot'));
  expect(backend.view('shared')).toBeNull();
  await backend.acquire('shared');
  await backend.waitForView('shared');
  conn.event({
    type: 'waterfall',
    event: 'approval/request',
    eventId: 'unanswered',
    agentId: 'shared',
    request: { toolName: 'shell', reason: 'fixture' },
  });
  expect(backend.view('shared')?.requests).toEqual([]);
  await expect(
    backend.execute(
      'shared',
      {
        kind: 'respond',
        response: {
          targetRequestId: card.id,
          expectedFingerprint: card.fingerprint,
          expectedTurnId: null,
          decision: 'accept',
        },
      },
      randomUUID(),
    ),
  ).rejects.toThrow();
});

it('maps model, queue, steer, cancel and question commands through generated native contracts', async () => {
  const { conn, backend } = await setup();
  await backend.execute(
    'shared',
    {
      kind: 'settings',
      model: '["provider","model"]',
      effort: 'default',
      expectedModel: null,
      expectedEffort: 'default',
    },
    randomUUID(),
  );
  expect(conn.calls.at(-1)).toMatchObject({
    endpoint: 'session/selectModel',
    args: { request: { sessionId: 'shared', provider: 'provider', model: 'model' } },
  });
  await backend.execute(
    'shared',
    { kind: 'queue', text: 'later', expectedQueueFingerprint: backend.view('shared')!.queueFingerprint! },
    randomUUID(),
  );
  expect(conn.calls.at(-1)).toMatchObject({
    endpoint: 'session/prompt',
    args: { request: { mode: 'queue' } },
  });
  conn.streams.get('session/control')!({
    type: 'projection',
    sessionId: 'shared',
    key: 'inbox',
    seq: 1,
    value: {
      'next-turn': [{ id: 'queued-id', content: [{ type: 'text', text: 'later' }] }],
      'next-step': [],
    },
  });
  await backend.execute(
    'shared',
    {
      kind: 'queue-remove',
      messageId: 'queued-id',
      expectedQueueFingerprint: backend.view('shared')!.queueFingerprint!,
    },
    randomUUID(),
  );
  expect(conn.calls.at(-1)).toMatchObject({
    endpoint: 'session/updateQueue',
    args: { request: { itemId: 'queued-id', action: { kind: 'remove' } } },
  });
  conn.push({ type: 'event', event: { type: 'turn/start', seq: 0, time: 1, data: { turn: 2 } } });
  await backend.execute('shared', { kind: 'steer', text: 'adjust', expectedTurnId: '2' }, randomUUID());
  expect(conn.calls.at(-1)).toMatchObject({
    endpoint: 'session/prompt',
    args: { request: { mode: 'steer' } },
  });
  await backend.execute('shared', { kind: 'interrupt', expectedTurnId: '2' }, randomUUID());
  expect(conn.calls.at(-1)).toMatchObject({
    endpoint: 'session/cancel',
    args: { request: { sessionId: 'shared' } },
  });
  const questions = [{ id: 'q', question: 'Choice?', options: [{ label: 'yes' }] }];
  conn.event({
    type: 'waterfall',
    event: 'user-questions/request',
    eventId: 'question',
    agentId: 'shared',
    request: { questions },
  });
  let card = backend.view('shared')!.requests![0];
  const respond = () =>
    backend.execute(
      'shared',
      {
        kind: 'respond',
        response: {
          targetRequestId: card.id,
          expectedFingerprint: card.fingerprint,
          expectedTurnId: card.turnId,
          answers: { q: ['yes', 'custom'] },
        },
      },
      randomUUID(),
    );
  await respond();
  expect(conn.calls.at(-1)).toMatchObject({
    endpoint: '$events/result',
    args: {
      outcome: { kind: 'result', value: { answers: [{ id: 'q', selected: ['yes'], custom: 'custom' }] } },
    },
  });
  conn.streams.get('session/control')!({
    type: 'projection',
    sessionId: 'shared',
    key: 'userQuestions',
    seq: 2,
    value: { active: [{ callId: 'continued-call', state: 'continued', questions }] },
  });
  card = backend.view('shared')!.requests![0];
  await respond();
  expect(conn.calls.at(-1)).toMatchObject({
    endpoint: 'userQuestions/answer',
    args: { agentId: 'shared', callId: 'continued-call' },
  });
  expect(backend.view('shared')!.requests).toEqual([]);
});
