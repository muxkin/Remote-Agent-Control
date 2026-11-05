import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from '../src/server/config.js';
import type { RpcTransport } from '../src/server/transport.js';
export const THREAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TURN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export function fixtureConfig(): Config {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-test-'));
  mkdirSync(join(dir, 'resources'));
  writeFileSync(
    join(dir, 'resources/linux-package-metadata.json'),
    JSON.stringify({ version: '26.1029.61003' }),
  );
  return {
    port: 4317,
    origin: 'http://127.0.0.1:4317',
    stateDir: join(dir, 'private'),
    codexHome: join(dir, 'codex'),
    desktopRoot: dir,
    socketPath: join(dir, 'ipc.sock'),
    readOnly: false,
    webRoot: join(dir, 'web'),
    bridgePath: join(dir, 'bridge.py'),
    assetOrigin: null,
  };
}
export function state(overrides: any = {}) {
  return {
    id: THREAD,
    hostId: 'local',
    title: '测试会话',
    cwd: '/test',
    updatedAt: 100,
    latestModel: 'desktop-model',
    threadRuntimeStatus: { type: 'idle' },
    requests: [],
    turns: [],
    turnHistory: {
      kind: 'canonical',
      history: {
        islands: [{ entries: [{ value: 'one' }] }],
        entitiesByKey: {
          one: {
            turnId: TURN,
            status: 'completed',
            params: { input: [{ type: 'text', text: '你好' }], clientUserMessageId: 'client-one' },
            items: [
              { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: '你好' }] },
              { type: 'agentMessage', id: 'a1', text: '世界' },
            ],
          },
        },
      },
    },
    ...overrides,
  };
}
export class FakeTransport extends EventEmitter implements RpcTransport {
  connected = false;
  calls: any[] = [];
  broadcasts: any[] = [];
  current = state();
  owner = 'desktop-owner';
  revision = 1;
  autoSnapshot = true;
  response: any = { result: { result: { turn: { id: TURN } } } };
  connect = async () => {
    this.connected = true;
  };
  request = async (method: string, params: any, version = 0, target?: string) => {
    this.calls.push({ method, params, version, target });
    if (method === 'thread-owner-discovery')
      return { handledByClientId: this.owner, result: { supportsUntrustedAppInput: true } };
    return this.response;
  };
  broadcast(method: string, params: any, version: number, target: string) {
    this.broadcasts.push({ method, params, version, target });
    if (params.following && this.autoSnapshot) this.snapshot();
  }
  snapshot() {
    this.emit('broadcast', {
      method: 'thread-stream-state-changed',
      sourceClientId: this.owner,
      version: 11,
      params: {
        hostId: 'local',
        conversationId: THREAD,
        change: { type: 'snapshot', revision: this.revision, conversationState: this.current },
      },
    });
  }
  patches(baseRevision: number, revision: number, patches: any[]) {
    this.emit('broadcast', {
      method: 'thread-stream-state-changed',
      sourceClientId: this.owner,
      version: 11,
      params: {
        hostId: 'local',
        conversationId: THREAD,
        change: { type: 'patches', baseRevision, revision, patches },
      },
    });
  }
  close() {
    this.connected = false;
    this.emit('disconnect', 'closed');
  }
}
export function historyFixture(config: Config) {
  mkdirSync(join(config.codexHome, 'sessions'), { recursive: true });
  mkdirSync(join(config.codexHome, 'archived_sessions'));
  const file = join(config.codexHome, 'sessions', `rollout-${THREAD}.jsonl`);
  writeFileSync(
    file,
    JSON.stringify({
      ordinal: 1,
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'm1',
        role: 'user',
        content: [{ type: 'input_text', text: '历史消息' }],
      },
    }) + '\n',
  );
  const db = new DatabaseSync(join(config.codexHome, 'state_5.sqlite'));
  db.exec(
    'CREATE TABLE threads (id TEXT,name TEXT,title TEXT,cwd TEXT,updated_at_ms INTEGER,archived INTEGER,thread_source TEXT,rollout_path TEXT)',
  );
  db.prepare('INSERT INTO threads VALUES (?,NULL,?,?,?,?,?,?)').run(
    THREAD,
    '测试会话',
    '/test',
    100,
    0,
    'user',
    file,
  );
  db.exec(
    'ALTER TABLE threads ADD COLUMN project_id TEXT; CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT,position INTEGER)',
  );
  db.close();
  return file;
}
