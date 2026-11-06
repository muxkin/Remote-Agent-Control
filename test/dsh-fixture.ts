import commandRemote from '@deepseek-ai/dsh-commands/remote';
import permissionRemote from '@deepseek-ai/dsh-permission-presets/remote';
import presetRemote from '@deepseek-ai/dsh-agent-preset-registry/remote';
import goalRemote from '@deepseek-ai/dsh-goal/remote';
import feedbackRemote from '@deepseek-ai/dsh-command-feedback/remote';
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote';
import questionRemote from '@deepseek-ai/dsh-user-questions/remote';
import workspaceRemote from '@deepseek-ai/dsh-api-workspace-controller/remote';
import { EventEmitter } from 'node:events';
import type { DshConnection } from '../src/server/connectors/dsh-web.js';
export class DshFixtureConnection extends EventEmitter implements DshConnection {
  constructor(
    readonly sessionId = 'shared',
    readonly name = 'same ID',
  ) {
    super();
  }
  permission = 'workspace-write';
  plan = false;
  projectionRevision = 0;
  connected = false;
  generation = 1;
  calls: any[] = [];
  hideInitial = false;
  created = new Map<string, string>();
  streams = new Map<string, (frame: any) => void>();
  opens = 0;
  workspaces: any[] = [];
  async start() {
    this.connected = true;
    this.emit('connected');
    this.streams.get('$events')?.({
      type: 'ready',
      clientId: `client-${this.generation}`,
      host: { home: '/home/fixture' },
    });
  }
  stop() {
    this.connected = false;
    this.emit('disconnected');
  }
  async call<T = any>(endpoint: string, args: any): Promise<T> {
    const method = (
      {
        ...commandRemote.methods,
        ...permissionRemote.methods,
        ...presetRemote.methods,
        ...goalRemote.methods,
        ...feedbackRemote.methods,
        ...sessionRemote.methods,
        ...questionRemote.methods,
        ...workspaceRemote.methods,
      } as Record<string, any>
    )[endpoint];
    if (!method && endpoint !== '$events/result') throw Error(`Unknown DSH endpoint: ${endpoint}`);
    method?.input({ strict: true }).create().parse(args);
    this.calls.push({ endpoint, args });
    if (endpoint === 'commands/execute') {
      if (args.line.startsWith('/permission ')) this.permission = args.line.split(' ')[1];
      if (args.line.startsWith('/plan')) this.plan = args.line === '/plan';
      this.streams.get('session/control')?.({
        type: 'projection',
        sessionId: args.agentId,
        key: 'permissions',
        seq: ++this.projectionRevision,
        value: { currentValue: this.permission },
      });
      this.streams.get('session/control')?.({
        type: 'projection',
        sessionId: args.agentId,
        key: 'plan',
        seq: ++this.projectionRevision,
        value: { active: this.plan, pending: false },
      });
      return { commandId: 'fixture-command', result: { kind: 'success' } } as T;
    }
    if (endpoint === 'session/create') this.created.set(args.request.sessionId, '新会话');
    if (endpoint === 'session/rename') this.created.set(args.request.sessionId, args.request.title);
    return ({
      'permissionPresets/catalog': {
        options: [
          { value: 'read-only', name: '只读' },
          { value: 'workspace-write', name: '工作区内修改' },
        ],
        defaultPreset: 'workspace-write',
      },
      'agentPresets/list': { presets: [{ id: 'standard', name: '标准模式', isDefault: true }] },
      'commands/list': ['permission', 'plan', 'goal', 'compact', 'feedback'].map((name) => ({
        name,
        description: name,
      })),
      'goals/get': null,
      'sessionFeedback/record': { ok: true, value: { recorded: true } },
      'fileReferences/list': [{ path: 'README.md', kind: 'file' }],
      'session/list': {
        items: [
          ...(this.hideInitial
            ? []
            : [
                {
                  sessionId: this.sessionId,
                  updatedAt: 1,
                  blank: false,
                  running: false,
                  agentAvailable: true,
                  cwd: '/fixture',
                  projections: { values: { title: this.name } },
                },
              ]),
          ...[...this.created].map(([sessionId, title]) => ({
            sessionId,
            updatedAt: 2,
            blank: false,
            running: false,
            agentAvailable: true,
            cwd: '/fixture',
            projections: { values: { title } },
          })),
        ],
      },
      'session/modelCatalog': {
        groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model' }] }],
      },
      'skills/list': { skills: [] },
      'session/create': { sessionId: args.request?.sessionId ?? 'created' },
      'session/prompt': { accepted: true },
      'userQuestions/answer': true,
    }[endpoint] ?? {}) as T;
  }
  stream(endpoint: string, args: any, item: (frame: any) => void) {
    if (endpoint === 'workspace/follow') {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled)
          item({
            type: 'baseline',
            value: { items: this.workspaces, archivedSessionIds: [], pinnedSessionIds: [] },
          });
      });
      return () => {
        cancelled = true;
      };
    }
    const key = endpoint === 'session/follow' ? args.request.address.sessionId : endpoint;
    this.streams.set(key, item);
    if (endpoint === 'session/follow') {
      this.opens++;
      queueMicrotask(() => item(snapshot(key, this.created.get(key) ?? this.name)));
    }
    return () => this.streams.delete(key);
  }
  async fetch() {
    throw Error('Not expected');
    return new Response();
  }
  push(frame: any) {
    this.streams.get(this.sessionId)!(frame);
  }
  event(frame: any) {
    this.streams.get('$events')!(frame);
  }
}
export const snapshot = (id: string, name: string) => ({
  type: 'snapshot',
  header: { id, version: 4, createdAt: 0, cwd: '/fixture', isSeeded: false },
  cursor: -1,
  records: [],
  hasMore: false,
  projections: {
    asOfSeq: -1,
    values: {
      title: name,
      permissions: { currentValue: 'workspace-write' },
      agentPreset: 'standard',
      plan: { active: false, pending: false },
      turnOutline: [],
      goal: null,
      inbox: { 'next-turn': [], 'next-step': [] },
    },
  },
});
