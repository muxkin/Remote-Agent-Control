import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote';
import questionRemote from '@deepseek-ai/dsh-user-questions/remote';
import { EventEmitter } from 'node:events';
import type { DshConnection } from '../src/server/connectors/dsh-web.js';
export class DshFixtureConnection extends EventEmitter implements DshConnection {
  constructor(
    readonly sessionId = 'shared',
    readonly name = 'same ID',
  ) {
    super();
  }
  connected = false;
  generation = 1;
  calls: any[] = [];
  hideInitial = false;
  created = new Map<string, string>();
  streams = new Map<string, (frame: any) => void>();
  opens = 0;
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
    const method = ({ ...sessionRemote.methods, ...questionRemote.methods } as Record<string, any>)[endpoint];
    method?.input({ strict: true }).create().parse(args);
    this.calls.push({ endpoint, args });
    if (endpoint === 'session/create') this.created.set(args.request.sessionId, '新会话');
    if (endpoint === 'session/rename') this.created.set(args.request.sessionId, args.request.title);
    return ({
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
      'workspace/list': { items: [] },
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
  projections: { asOfSeq: -1, values: { title: name, inbox: { 'next-turn': [], 'next-step': [] } } },
});
