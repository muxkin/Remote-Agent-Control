import { temporaryRuntime } from './temporary-runtime.js';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DshFixtureConnection, snapshot } from '../packages/adapter-dsh/test/fixture.js';
import { DshBackend } from '../packages/adapter-dsh/src/backend.js';
import { Store } from '../src/server/store.js';
import { Operations } from '../src/server/operations.js';
import { controlAction } from '../src/shared/controls.js';
import { codexPermissionState } from '../packages/adapter-codex/src/codex-permissions.js';
import { apiCall } from '../src/shared/rpc.js';
class ControlConnection extends DshFixtureConnection {
  permission = 'workspace-write';
  plan = false;
  goal: any = null;
  seq = 0;
  update(id = 'shared') {
    const frame = snapshot(id, 'fixture');
    frame.projections.asOfSeq = ++this.seq;
    frame.cursor = this.seq;
    Object.assign(frame.projections.values, {
      permissions: { currentValue: this.permission },
      agentPreset: 'standard',
      plan: { active: this.plan, pending: false },
      turnOutline: [],
      goal: this.goal,
    });
    this.streams.get(id)?.(frame);
  }
  override stream(endpoint: string, args: any, item: (f: any) => void) {
    const close = super.stream(endpoint, args, item);
    if (endpoint === 'session/follow') queueMicrotask(() => this.update(args.request.address.sessionId));
    return close;
  }
  override async call<T = any>(endpoint: string, args: any): Promise<T> {
    if (
      ![
        'permissionPresets/catalog',
        'agentPresets/list',
        'commands/list',
        'commands/execute',
        'goals/get',
        'goals/create',
        'goals/pause',
        'sessionFeedback/record',
      ].includes(endpoint)
    )
      return super.call(endpoint, args);
    this.calls.push({ endpoint, args });
    let result: any;
    if (endpoint === 'permissionPresets/catalog')
      result = {
        options: [
          { value: 'read-only', name: '只读' },
          { value: 'workspace-write', name: '工作区' },
        ],
        defaultPreset: 'workspace-write',
      };
    if (endpoint === 'agentPresets/list') result = { presets: [{ id: 'standard', isDefault: true }] };
    if (endpoint === 'commands/list')
      result = ['permission', 'plan', 'compact', 'goal', 'feedback'].map((name) => ({
        name,
        description: name,
      }));
    if (endpoint === 'goals/get') result = this.goal;
    if (endpoint === 'goals/create') {
      this.goal = { id: 'goal', revision: 1, objective: args.request.objective, phase: 'active' };
      result = { ref: { id: 'goal', revision: 1 } };
    }
    if (endpoint === 'goals/pause') {
      if (args.ref.revision !== this.goal.revision) throw Error('revision mismatch');
      this.goal = { ...this.goal, revision: 2, phase: 'paused' };
      result = this.goal;
    }
    if (endpoint === 'sessionFeedback/record') result = { ok: true, value: { recorded: true } };
    if (endpoint === 'commands/execute') {
      if (args.line.startsWith('/permission ')) this.permission = args.line.split(' ')[1];
      if (args.line.startsWith('/plan')) this.plan = args.line === '/plan';
      this.update(args.agentId);
      result = { commandId: randomUUID(), result: { kind: 'success' } };
    }
    return result as T;
  }
}
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'controls-'));
  const connection = new ControlConnection();
  const backend = new DshBackend(
    { id: 'dsh', name: 'DSH', url: 'http://localhost:3080', version: 'unknown', token: 'fixture' },
    dir,
    false,
    connection,
  );
  const store = new Store(join(dir, 'store'), temporaryRuntime);
  const operations = new Operations(backend, store, 'dsh');
  cleanup.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => store.close(),
    () => backend.stop(),
    () => operations.close(),
  );
  await backend.start();
  await backend.history.list();
  await backend.acquire('shared');
  await backend.waitForView('shared');
  return { connection, backend, store, operations };
}
it('separates permission policy from request approvals and confirms native state', async () => {
  const { backend, connection } = await setup();
  await backend.execute(
    'shared',
    { kind: 'control', control: { action: 'permission', value: 'read-only', expected: 'workspace-write' } },
    randomUUID(),
  );
  expect(backend.view('shared')?.controls?.permission).toBe('read-only');
  expect(connection.calls.some((c) => c.endpoint === 'session/prompt')).toBe(false);
  await expect(
    backend.execute(
      'shared',
      {
        kind: 'control',
        control: { action: 'permission', value: 'workspace-write', expected: 'workspace-write' },
      },
      randomUUID(),
    ),
  ).rejects.toThrow('已变化');
});
it('applies creation permissions and plan before submitting the first prompt', async () => {
  const { backend, connection } = await setup();
  await backend.execute(
    'new',
    { kind: 'create', prompt: 'hello', permission: 'read-only', plan: true, agentPreset: 'standard' },
    randomUUID(),
  );
  const calls = connection.calls;
  expect(
    calls.findIndex((c) => c.endpoint === 'commands/execute' && c.args.line === '/permission read-only'),
  ).toBeLessThan(calls.findIndex((c) => c.endpoint === 'session/prompt'));
  expect(calls.find((c) => c.endpoint === 'session/create').args.request.agentPreset).toBe('standard');
  expect(connection.plan).toBe(true);
});
it('deduplicates native commands and persists creation identity if configuration fails', async () => {
  const { backend, store, operations, connection } = await setup();
  const id = randomUUID();
  const input = JSON.stringify({ control: { action: 'compact' } });
  operations.submit('device', 'shared', id, 'control', input);
  await expect.poll(() => store.operation(id, undefined, 'dsh')?.state).toBe('completed');
  operations.submit('device', 'shared', id, 'control', input);
  expect(connection.calls.filter((c) => c.endpoint === 'commands/execute')).toHaveLength(1);
  const create = randomUUID();
  operations.submit(
    'device',
    'new',
    create,
    'create',
    JSON.stringify({ prompt: 'never send', permission: 'invalid' }),
  );
  await expect.poll(() => store.operation(create, undefined, 'dsh')?.state).toBe('uncertain');
  expect(store.operation(create, undefined, 'dsh')?.resultThreadId).toBe(create);
  expect(connection.calls.some((c) => c.endpoint === 'session/prompt')).toBe(false);
});
it('uses goal revision and dedicated feedback API', async () => {
  const { backend, connection } = await setup();
  await backend.execute(
    'shared',
    { kind: 'control', control: { action: 'goal', operation: 'create', objective: 'test' } },
    randomUUID(),
  );
  const c = await backend.controls('shared');
  await backend.execute(
    'shared',
    { kind: 'control', control: { action: 'goal', operation: 'pause', ref: c.goal!.ref } },
    randomUUID(),
  );
  expect((await backend.controls('shared')).goal?.phase).toBe('paused');
  await backend.execute(
    'shared',
    { kind: 'control', control: { action: 'feedback', text: 'fixture only' } },
    randomUUID(),
  );
  expect(connection.calls.at(-1)?.endpoint).toBe('sessionFeedback/record');
});
it('only exposes typed control routes and fingerprints effective Codex permissions', () => {
  expect(() => controlAction.parse({ action: 'rpc', method: 'exec' })).toThrow();
  expect(apiCall('/api/threads/chat/control', 'POST').method).toBe('control.execute');
  const a = codexPermissionState({ activePermissionProfile: { id: ':workspace' }, approvalPolicy: 'never' });
  const b = codexPermissionState({
    activePermissionProfile: { id: ':workspace' },
    approvalPolicy: 'on-request',
  });
  expect(a.permission).toBe(b.permission);
  expect(a.permissionRevision).not.toBe(b.permissionRevision);
});
it('reports a settled native command error as failed rather than an unknown delivery', async () => {
  const { connection, operations, store } = await setup();
  const call = connection.call.bind(connection);
  connection.call = async (endpoint, args) =>
    endpoint === 'commands/execute'
      ? ({ commandId: 'native-failure', result: { kind: 'error', text: 'Native compaction refused' } } as any)
      : call(endpoint, args);
  const id = randomUUID();
  operations.submit('device', 'shared', id, 'control', JSON.stringify({ control: { action: 'compact' } }));
  await expect.poll(() => store.operation(id, undefined, 'dsh')?.state).toBe('failed');
  expect(store.operation(id, undefined, 'dsh')?.error).toBe('Native compaction refused');
});
