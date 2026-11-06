import { EventEmitter } from 'node:events';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export function createAdapter(context) {
  if (context.config.fail) throw Error('Fixture rejected startup');
  if (context.config.noisy) console.log('Fixture diagnostic on stdout');
  const backend = new EventEmitter(),
    file = join(context.stateDirectory, 'dispatches.jsonl');
  const messages = () => {
    try {
      return readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const r = JSON.parse(line);
          return { id: r.requestId, role: 'user', text: r.text ?? r.kind, clientMessageId: r.requestId };
        });
    } catch {
      return [];
    }
  };
  const summary = { id: 'shared', title: 'Fixture conversation', cwd: context.stateDirectory, updatedAt: 1 };
  const view = () => ({
    id: 'shared',
    revision: messages().length + 1,
    synchronized: true,
    title: summary.title,
    cwd: summary.cwd,
    messages: messages(),
    requests: [],
    pendingRequests: 0,
    activeTurnId: null,
    canSend: true,
    canInterrupt: false,
    reason: null,
    model: 'fixture',
    reasoningEffort: 'high',
    mode: 'default',
    controls: { permission: 'workspace-write' },
  });
  const status = () => ({
    connected: true,
    desktopVersion: 'fixture',
    supportedVersion: true,
    writesEnabled: true,
    reason: null,
    capabilities: {
      send: true,
      steer: true,
      interrupt: true,
      modelSettings: true,
      questions: true,
      approvals: true,
      permissionRequests: false,
      openThread: true,
      elicitationForms: false,
      newThread: true,
      queue: true,
    },
  });
  return Object.assign(backend, {
    id: context.id,
    history: {
      get: async (id) => (id === 'shared' ? summary : null),
      list: async (cursor, limit = 25) => {
        if (typeof limit !== 'number') throw Error('Optional list limit lost its default');
        return { threads: [summary], nextCursor: null };
      },
      page: async () => ({ messages: messages(), nextCursor: null }),
      projects: async () => ({ projects: [], total: 1, ungrouped: 1 }),
    },
    info: () => ({
      id: context.id,
      product: 'fixture',
      name: context.name,
      connected: true,
      version: 'fixture',
      profile: 'test',
      capabilities: Object.fromEntries(
        [
          'history',
          'send',
          'steer',
          'interrupt',
          'respond',
          'settings',
          'queue',
          'create',
          'open',
          'attachments',
          'skills',
          'plugins',
        ].map((k) => [k, { state: 'supported' }]),
      ),
    }),
    status,
    start: async () => {},
    stop: async () => {
      if (context.config.stopDelay) {
        await new Promise((resolve) => setTimeout(resolve, context.config.stopDelay));
        appendFileSync(
          join(context.stateDirectory, 'stopped.jsonl'),
          JSON.stringify({ pid: process.pid }) + '\n',
        );
      }
    },
    acquire: async () => {
      backend.emit('thread', view());
      return () => {};
    },
    view,
    waitForView: async (id, timeout = 1000) => {
      if (typeof timeout !== 'number') throw Error('Optional view timeout lost its default');
      return view();
    },
    projects: async () => [],
    openThread: async () => {},
    execute: async (id, command, requestId) => {
      appendFileSync(file, JSON.stringify({ requestId, kind: command.kind, text: command.text }) + '\n');
      if (command.text === 'crash' || context.config.crashKind === command.kind) process.exit(19);
      if (command.text === 'hang') while (true) {}
      if (command.text === 'delay') await new Promise((r) => setTimeout(r, 700));
      if (command.kind === 'create') backend.emit('created', requestId, 'shared');
      backend.emit('thread', view());
      backend.emit('observations', 'shared', [
        { requestIds: [requestId], turnId: requestId, state: 'completed' },
      ]);
      return command.kind === 'create' ? 'shared' : requestId;
    },
    inlineMedia: async () => null,
    fullMessage: async (id, messageId) => messages().find((m) => m.id === messageId) ?? null,
    controls: async () => ({
      product: 'fixture',
      permissions: [{ id: 'workspace-write', name: '工作区' }],
      presets: [],
      actions: ['permission'],
      state: { permission: 'workspace-write' },
    }),
    models: async () => ({
      models: [
        { id: 'fixture', name: 'Fixture model', efforts: ['high'], defaultEffort: 'high', speeds: [] },
      ],
      source: 'fixture',
      fetchedAt: null,
    }),
    skills: async () => [],
    plugins: async () => [],
    validateSelection: async () => {},
    validateSettings: async () => {},
    validateCreation: async () => {},
    attachment: async () => join(context.stateDirectory, 'authorized-file.txt'),
    fileReferences: async () => Object.keys(process.env).map((name) => ({ name, path: name })),
  });
}
