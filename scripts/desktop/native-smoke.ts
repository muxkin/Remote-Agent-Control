import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Store } from '../../src/server/store.js';
import { hostIdentity } from '../../src/server/device-identity.js';
import { buildRelay } from '../../src/server/relay.js';
import { platformRuntime } from '../../src/server/platform.js';
import { createIdentity, type Identity } from '../../src/shared/secure-channel.js';
import { DeviceLink } from '../../src/shared/device-link.js';
import { nodeSession } from '../../src/client/node-session.js';
import { apiCall } from '../../src/shared/rpc.js';
import { BLOCK_SIZE, encryptBlock, decryptBlock, type FileManifest } from '../../src/shared/files.js';
import { uploadToStorage } from '../../src/web/storage-upload.js';
import { historyFixture, THREAD } from '../../test/helpers.js';
import { FrameReader, encodeFrame } from '../../packages/adapter-codex/src/framing.js';

const executable = resolve(process.argv[2] ?? 'desktop/native/target/release/agent-space-native');
const directory = await mkdtemp(join(tmpdir(), 'native-adapter-smoke-'));
const state = join(directory, 'state');
const codexHome = join(directory, 'codex');
await mkdir(state, { mode: 0o700 });
const host = await hostIdentity(state);
const existingPhone = await createIdentity();
const store = new Store(state);
const old = store.pair(store.mintPairing().code, 'Existing phone', existingPhone.peerId);
store.close();
assert(old?.routeTicket);
const rollout = historyFixture({ codexHome } as Parameters<typeof historyFixture>[0]);
const legacyState = join(directory, 'legacy');
const legacyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const legacyName = '旧附件.txt';
const legacyPath = join(legacyState, 'uploads', legacyId, legacyName);
const legacyBytes = Buffer.from('旧附件校验数据');
const inlineBytes = Buffer.alloc(420_000, 37);
const inlineSource = 'data:image/png;base64,' + inlineBytes.toString('base64');
const inlineRef = 'pocket-inline:' + createHash('sha256').update(inlineSource).digest('hex') + '.png';
const projectPath = join(directory, 'project');
const projectFile = join(projectPath, 'report.txt');
const unrelatedFile = join(projectPath, 'unrelated.txt');
await mkdir(projectPath, { recursive: true });
await writeFile(projectFile, 'project attachment');
await writeFile(unrelatedFile, 'unmentioned file');
await mkdir(join(legacyState, 'uploads', legacyId), { mode: 0o700, recursive: true });
await writeFile(legacyPath, legacyBytes, { mode: 0o600 });
if (process.platform === 'win32') platformRuntime().privateFile(legacyPath);
const legacyRecord = JSON.parse(await readFile(rollout, 'utf8'));
legacyRecord.payload.content[0].text +=
  '\n\n手机上传的附件（保留原始文件）：\n' + JSON.stringify({ name: legacyName, path: legacyPath });
const historicalReply = '[附件](report.txt)\n' + 'Earlier history. '.repeat(800);
const assistantRecord = {
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'output_text', text: historicalReply },
      { type: 'input_image', image_url: inlineSource },
    ],
  },
};
await writeFile(
  rollout + '.zst',
  zstdCompressSync(Buffer.from(JSON.stringify(legacyRecord) + '\n' + JSON.stringify(assistantRecord) + '\n')),
);
const historyDb = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
historyDb.exec("INSERT INTO projects VALUES ('native-project','材料研究',0),('empty-project','空项目',1)");
historyDb
  .prepare('UPDATE threads SET rollout_path=?,cwd=? WHERE id=?')
  .run(rollout + '.zst', projectPath, THREAD);
historyDb.close();
const globalPath = join(codexHome, '.codex-global-state.json');
const globalFixture = {
  'app-server-project-id-by-legacy-project-id-by-host': {
    ['local:' + codexHome]: { 'legacy-project': 'native-project' },
  },
  'thread-project-assignments': { [THREAD]: { projectKind: 'local', projectId: 'legacy-project' } },
  'queued-follow-ups': {} as Record<string, any[]>,
};
await writeFile(globalPath, JSON.stringify(globalFixture));
const FORK = 'ed2a5874-cf9b-44d6-a2d6-fb9351af8ccc';
const CREATED = 'ed2a5874-cf9b-44d6-a2d6-fb9351af8ddd';
await writeFile(
  join(codexHome, 'models_cache.codex_work_desktop.json'),
  JSON.stringify({
    models: [
      {
        slug: 'fixture-model',
        display_name: 'Fixture Model',
        visibility: 'list',
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }],
        service_tiers: [{ id: 'fast', name: '快速' }],
      },
      { slug: 'hidden-model', visibility: 'hide' },
    ],
  }),
);
const skillRoot = join(codexHome, 'skills', 'fixture');
const pluginRoot = join(codexHome, 'plugins', 'cache', 'fixture-market', 'fixture-plugin');
await mkdir(skillRoot, { recursive: true });
await mkdir(join(pluginRoot, '1.0.0', '.codex-plugin'), { recursive: true });
await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: fixture\ndescription: a native skill\n---\n');
await writeFile(join(pluginRoot, '.codex-remote-plugin-install.json'), '{"remote_plugin_id":"fixture"}');
await writeFile(join(pluginRoot, '1.0.0', '.codex-plugin', 'plugin.json'), '{"name":"Fixture Plugin"}');
const FORK_REPLY = 'ed2a5874-cf9b-44d6-a2d6-fb9351af8eee';
const forkCli = process.platform === 'win32' ? undefined : join(directory, 'fixture-codex');
if (forkCli) {
  await writeFile(
    forkCli,
    `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  console.log('codex-cli 0.167.0-alpha.3.2');
} else {
  const lines = require('node:readline').createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const call = JSON.parse(line);
    if (call.id === 1) console.log(JSON.stringify({ id: 1, result: { userAgent: 'pocket_reply_fork/0.167.0-alpha.3.2 fixture' } }));
    if (call.id === 2) {
      require('node:assert/strict').deepEqual(call.params, {
        threadId: '${THREAD}', lastTurnId: 'earlier-turn', excludeTurns: true, threadSource: 'user',
      });
      console.log(JSON.stringify({ id: 2, result: { thread: { id: '${FORK_REPLY}', forkedFromId: '${THREAD}' } } }));
    }
  });
}
`,
    { mode: 0o700 },
  );
}
const useIpc = process.env.POCKET_NATIVE_TEST_IPC === '1';
const browserExecutable = process.env.POCKET_NATIVE_TEST_BROWSER_EXECUTABLE;
const testStorage = process.env.POCKET_NATIVE_TEST_STORAGE === '1';
const ipc = useIpc ? await desktopFixture() : undefined;
const portProbe = createServer().listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const port = portProbe.address();
assert(port && typeof port !== 'string');
await new Promise<void>((resolve) => portProbe.close(() => resolve()));
const origin = `http://127.0.0.1:${port.port}`;
const enrollment = randomBytes(32).toString('hex');
const cloudflare = process.env.POCKET_NATIVE_TEST_RELAY === 'cloudflare';
const relay = cloudflare
  ? await cloudflareRelay(port.port)
  : await buildRelay({
      origin,
      enrollmentSecret: enrollment,
      webRoot: browserExecutable
        ? resolve('.implementation/deployment-parity/node-web')
        : join(directory, 'no-web'),
      assetOrigin: null,
      uploadOrigins: [],
    }).then(({ app }) => ({
      listen: () => app.listen({ host: '127.0.0.1', port: port.port }),
      close: () => app.close(),
    }));

async function cloudflareRelay(port: number) {
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  // The Worker bundle is produced by npm run check:deployments.
  const worker = new Miniflare({
    ...convertV4MiniflareOptions({
      name: 'native-relay-smoke',
      modules: true,
      scriptPath: '.implementation/cloudflare/index.js',
      compatibilityDate: '2026-11-04',
      compatibilityFlags: ['nodejs_compat'],
      host: '127.0.0.1',
      port,
      bindings: {
        POCKET_PUBLIC_ORIGIN: origin,
        POCKET_RELAY_ENROLLMENT: enrollment,
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

async function launch(useSaved = false) {
  if (process.platform === 'win32') {
    // The hosted runner is elevated. Node-created fixture files and SQLite's
    // sidecars can inherit Administrators as owner even in a private directory.
    // Normalize the fixture just as the legacy Windows adapter does on reopen.
    const runtime = platformRuntime();
    for (const name of [
      'device-identity-v2.json',
      'state.sqlite-wal',
      'state.sqlite-shm',
      'state.sqlite-journal',
    ]) {
      const file = join(state, name);
      if (existsSync(file)) runtime.privateFile(file);
    }
  }
  const child = spawn(executable, ['--headless', '--print-pair'], {
    env: {
      ...process.env,
      POCKET_NATIVE_ORIGIN: useSaved ? '' : origin,
      POCKET_NATIVE_ENROLLMENT: useSaved ? '' : enrollment,
      POCKET_NATIVE_STATE_DIR: state,
      POCKET_NATIVE_CODEX_HOME: codexHome,
      POCKET_NATIVE_LEGACY_STATE: legacyState,
      POCKET_NATIVE_READ_ONLY: ipc ? '0' : '1',
      ...(ipc
        ? {
            POCKET_NATIVE_CODEX_SOCKET: ipc.path,
            POCKET_NATIVE_CODEX_APP_TOOLS: ipc.path,
            POCKET_NATIVE_CODEX_EXECUTABLE: process.execPath,
            ...(forkCli ? { POCKET_NATIVE_CODEX_CLI: forkCli } : {}),
          }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout });
  const closed = once(child, 'close');
  void closed.catch(() => {});
  const stop = async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed.catch(() => {});
  };
  const readPair = async () => {
    const alarm = setTimeout(() => lines.close(), 20_000);
    try {
      for await (const line of lines) {
        if (!line.startsWith(origin)) continue;
        const url = new URL(line);
        const args = new URLSearchParams(url.hash.slice(1));
        assert.equal(args.get('host'), host.peerId, 'Native adapter changed the existing host identity');
        const code = args.get('pair');
        assert(code);
        return code;
      }
      throw Error('Native adapter did not advertise a pairing code');
    } finally {
      clearTimeout(alarm);
    }
  };
  try {
    return { code: await readPair(), stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function desktopFixture() {
  const path =
    process.platform === 'win32'
      ? '\\\\.\\pipe\\agent-space-native-test-' + crypto.randomUUID()
      : join(directory, 'ipc', 'codex.sock');
  if (process.platform !== 'win32') await mkdir(join(directory, 'ipc'), { mode: 0o700 });
  const sockets = new Set<import('node:net').Socket>();
  const expected = { send: 0, steer: 0, interrupt: 0 };
  const turn = crypto.randomUUID();
  let publishTurn = () => {};
  let opened = false;
  const tools = [
    'navigate_to_codex_page',
    'get_usage_limits',
    'list_projects',
    'set_thread_title',
    'fork_thread',
    'create_thread',
  ];
  const actions: string[] = [];
  let title = '测试会话';
  let effort = 'medium';
  let mode = 'default';
  let serviceTier: string | null = null;
  let permission = ':workspace';
  let sandbox = 'workspaceWrite';
  let pending: any[] = [];
  let publish = () => {};
  let addAsyncQuestion = () => {};
  let responseCount = 0;
  const applyQueue = (rows: any[]) => {
    globalFixture['queued-follow-ups'][THREAD] = rows;
    writeFileSync(globalPath, JSON.stringify(globalFixture));
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const frames = new FrameReader();
    let revision = 0;
    const nativeTurns: Record<string, unknown>[] = [
      {
        turnId: 'earlier-turn',
        status: 'completed',
        items: [{ id: 'earlier-message', type: 'agentMessage', text: 'earlier response '.repeat(1000) }],
      },
    ];
    const send = (value: unknown) => socket.write(encodeFrame(value));
    const snapshot = () =>
      send({
        type: 'broadcast',
        sourceClientId: 'fixture-owner',
        method: 'thread-stream-state-changed',
        version: 11,
        params: {
          hostId: 'local',
          conversationId: THREAD,
          change: {
            type: 'snapshot',
            revision: ++revision,
            conversationState: {
              id: THREAD,
              hostId: 'local',
              title,
              latestModel: 'fixture-model',
              latestReasoningEffort: effort,
              latestCollaborationMode: { mode },
              latestThreadSettings: {
                serviceTier,
                activePermissionProfile: { id: permission },
                sandboxPolicy: { type: sandbox },
                approvalPolicy: 'on-request',
                approvalsReviewer: 'user',
              },
              cwd: projectPath,
              turns: nativeTurns,
              requests: pending,
            },
          },
        },
      });
    socket.on('data', (chunk) =>
      frames.push(chunk, (value) => {
        const response = (result: unknown, extra = {}) =>
          send({
            type: 'response',
            requestId: value.requestId,
            resultType: 'success',
            result,
            ...extra,
          });
        switch (value.method) {
          case 'tools/list':
            send({
              id: value.id,
              result: { tools: tools.map((name) => ({ namespace: 'codex_app', name })) },
            });
            break;
          case 'tools/call': {
            const { tool, arguments: args, threadId } = value.params;
            assert.equal(threadId, THREAD);
            actions.push(tool);
            let result: unknown;
            switch (tool) {
              case 'navigate_to_codex_page':
                assert.deepEqual(args, { threadId: THREAD });
                opened = true;
                break;
              case 'list_projects':
                result = {
                  projects: [
                    { hostId: 'local', projectKind: 'local', projectId: 'legacy-project', label: '材料研究' },
                    { hostId: 'remote', projectKind: 'local', projectId: 'remote', label: '远程项目' },
                  ],
                };
                break;
              case 'get_usage_limits':
                result = {
                  accountId: 'private-id',
                  rateLimits: {
                    primary: { usedPercent: 27, windowDurationMins: 300, resetsAt: 1_800_000_000 },
                  },
                };
                break;
              case 'set_thread_title':
                assert.deepEqual(args, { source: 'codex', threadId: THREAD, title: '已改名' });
                title = args.title;
                break;
              case 'fork_thread':
                assert.deepEqual(args, { threadId: THREAD, environment: { type: 'same-directory' } });
                result = { hostId: 'local', threadId: FORK };
                break;
              case 'create_thread':
                assert.deepEqual(args, {
                  title: '新建测试',
                  prompt: '第一条消息',
                  model: 'fixture-model',
                  thinking: 'high',
                  target: { type: 'project', projectId: 'legacy-project', environment: { type: 'local' } },
                });
                result = { hostId: 'local', threadId: CREATED };
                break;
              default:
                assert.fail('Unexpected Codex tool');
            }
            send({
              id: value.id,
              result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] },
            });
            break;
          }
          case 'initialize':
            response({ clientId: 'rust-fixture-client' });
            break;
          case 'thread-owner-discovery':
            response({}, opened ? { handledByClientId: 'fixture-owner' } : {});
            break;
          case 'thread-stream-following-changed':
            if (value.params.following) {
              publish = snapshot;
              addAsyncQuestion = () => {
                (nativeTurns.at(-1)!.items as any[]).push({
                  id: 'fixture-async-question',
                  type: 'agentMessage',
                  text: '请回答一个可选问题',
                  questions: [{ title: '你选择什么', options: ['测试'] }],
                });
                snapshot();
              };
              snapshot();
            }
            break;
          case 'thread-follower-update-thread-settings': {
            const { threadSettings, condition } = value.params;
            if (threadSettings.permissions) {
              assert.equal(threadSettings.permissions, ':read-only');
              assert.equal(threadSettings.approvalPolicy, 'on-request');
              permission = ':read-only';
              sandbox = 'readOnly';
            } else {
              assert.deepEqual(condition, { ifModelEquals: 'fixture-model', ifEffortEquals: 'medium' });
              assert.equal(threadSettings.model, 'fixture-model');
              effort = threadSettings.effort;
              serviceTier = threadSettings.serviceTier;
              mode = threadSettings.collaborationMode.mode;
            }
            response({ applied: true });
            snapshot();
            break;
          }
          case 'thread-follower-read-model-settings':
            response({ settings: { model: 'fixture-model', reasoningEffort: effort } });
            break;
          case 'thread-follower-set-queued-follow-ups-state':
            assert.equal(value.params.state[THREAD].at(-1).submission.queueModeOverride, 'queue-only');
            applyQueue(value.params.state[THREAD]);
            response({ ok: true });
            break;
          case 'thread-follower-remove-queued-message':
            applyQueue(
              globalFixture['queued-follow-ups'][THREAD].filter((row) => row.id !== value.params.messageId),
            );
            response({ removed: true });
            break;
          case 'thread-follower-command-approval-decision':
          case 'thread-follower-file-approval-decision':
          case 'thread-follower-permissions-request-approval-response':
          case 'thread-follower-submit-user-input':
          case 'thread-follower-submit-mcp-server-elicitation-response':
            assert.equal(value.params.requestId, pending[0].id);
            if (value.method === 'thread-follower-permissions-request-approval-response') {
              assert.deepEqual(value.params.response, {
                permissions: { fileSystem: { read: ['/allowed'] } },
                scope: 'turn',
              });
            } else if (value.method === 'thread-follower-submit-mcp-server-elicitation-response') {
              assert.deepEqual(value.params.response, { action: 'accept', content: { confirmed: true } });
            } else if (value.method === 'thread-follower-submit-user-input') {
              assert.deepEqual(value.params.response, { answers: { answer: { answers: ['测试'] } } });
            } else assert.equal(value.params.decision, 'decline');
            responseCount++;
            pending = [];
            response({ ok: true });
            snapshot();
            break;
          case 'thread-follower-start-turn': {
            const text = value.params.turnStart.request.input[0].text;
            if (
              text.startsWith('PLEASE IMPLEMENT THIS PLAN:') ||
              text.startsWith('<send_user_message_question_reply>')
            ) {
              if (text.startsWith('PLEASE')) {
                assert.equal(value.params.turnStart.request.collaborationMode.mode, 'default');
                assert.equal(text, 'PLEASE IMPLEMENT THIS PLAN:\n测试计划');
              } else assert(text.includes('"answer":"测试"'));
              pending = [];
              const id = crypto.randomUUID();
              nativeTurns.push({
                turnId: id,
                status: 'completed',
                params: value.params.turnStart.request,
                items: [],
              });
              response({ result: { turn: { id } } });
              snapshot();
              break;
            }
            expected.send++;
            assert.equal(value.targetClientId, 'fixture-owner');
            assert.equal(value.params.turnStart.request.input[0].text, 'native smoke');
            assert.deepEqual(
              value.params.turnStart.request.input.slice(1).map((item: any) => [item.type, item.name]),
              [
                ['skill', 'fixture'],
                ['mention', 'Fixture Plugin'],
              ],
            );
            nativeTurns.push({
              turnId: turn,
              status: 'inProgress',
              params: value.params.turnStart.request,
              items: [],
            });
            response({ result: { turn: { id: turn } } });
            publishTurn = snapshot;
            break;
          }
          case 'thread-follower-steer-turn':
            expected.steer++;
            assert(value.params.input[0].text.endsWith('follow up'));
            assert.equal(value.params.attachments[0].label, 'native-attachment.txt');
            response({});
            break;
          case 'thread-follower-interrupt-turn':
            expected.interrupt++;
            assert.equal(value.params.expectedTurnId, turn);
            nativeTurns.at(-1)!.status = 'interrupted';
            response({ interruptedTurnId: turn });
            snapshot();
            break;
        }
      }),
    );
  });
  server.listen(path);
  await once(server, 'listening');
  if (process.platform !== 'win32') await chmod(path, 0o600);
  return {
    path,
    turn,
    expected,
    actions,
    setRequest: (id: string | number, method: string, params: Record<string, unknown>) => {
      pending = [{ id, method, params }];
      publish();
    },
    asyncQuestion: () => addAsyncQuestion(),
    responseCount: () => responseCount,
    closeConversation: () => {
      opened = false;
      responseCount = 0;
    },
    publishTurn: () => publishTurn(),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function testLive(
  session: Awaited<ReturnType<typeof nodeSession>>,
  ipc: Awaited<ReturnType<typeof desktopFixture>>,
  phone: Identity,
) {
  let view: any;
  let update: any;
  const unsubscribe = session.onEvent((event) => {
    if (event.type === 'sync') {
      update = event.updates[0];
      view = update?.thread;
    }
  });
  const wait = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 90; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 65));
    }
    throw Error('Native Codex control did not reach the expected state');
  };
  const operation = (id: string) =>
    session.rpc<{ state: string; resultThreadId?: string; turnId?: string }>(apiCall(`/operations/${id}`));
  let step = 'subscribing to Codex';
  try {
    await session.request('watch', { threadId: THREAD, backendId: 'codex-local' });
    await wait(() => view?.runtimeStatus === 'notLoaded');
    assert.equal(view.canSend, false);
    assert.equal(ipc.actions.filter((name) => name === 'navigate_to_codex_page').length, 0);
    const submit = async (suffix: string, input = {}, anchor = THREAD, state = 'completed') => {
      const requestId = crypto.randomUUID();
      const request = apiCall(`/threads/${anchor}/${suffix}`, 'POST', { requestId, ...input });
      await session.rpc(request);
      await wait(async () => (await operation(requestId)).state === state);
      return { request, operation: await operation(requestId) };
    };
    const open = await submit('open');
    await session.rpc(open.request);
    assert.equal(ipc.actions.filter((name) => name === 'navigate_to_codex_page').length, 1);
    await wait(() => view?.synchronized && view?.canSend);
    const full = await session.rpc<{ message: { text: string; truncated: boolean } }>(
      apiCall(`/threads/${THREAD}/content?messageId=earlier-message`),
    );
    assert.equal(full.message.truncated, false);
    assert.equal(full.message.text, 'earlier response '.repeat(1000));
    assert.equal(view.projectName, '材料研究');
    const usage = await session.rpc<{ available: boolean; buckets: unknown[] }>(apiCall('/usage'));
    assert.equal(usage.available, true);
    assert.deepEqual(usage.buckets, [
      {
        id: 'codex',
        name: 'codex',
        windows: [
          {
            label: '5 小时用量',
            usedPercent: 27,
            durationMinutes: 300,
            resetsAt: 1_800_000_000_000,
          },
        ],
      },
    ]);
    assert(!JSON.stringify(usage).includes('private-id'));
    step = 'managing conversations and settings';
    assert.deepEqual(await session.rpc(apiCall('/threads/new/projects')), {
      projects: [{ id: 'native-project', name: '材料研究' }],
    });
    const created = await submit(
      'create',
      {
        title: '新建测试',
        prompt: '第一条消息',
        projectId: 'native-project',
        model: 'fixture-model',
        thinking: 'high',
      },
      'new',
    );
    await session.rpc(created.request);
    assert.equal(created.operation.resultThreadId, CREATED);
    assert.equal(ipc.actions.filter((name) => name === 'create_thread').length, 1);
    assert.equal(
      (await submit('fork', { lastTurnId: 'earlier-turn' }, THREAD, forkCli ? 'completed' : 'rejected'))
        .operation.resultThreadId,
      forkCli ? FORK_REPLY : undefined,
    );
    await submit('fork', { lastTurnId: 'not-a-reply' }, THREAD, 'rejected');
    assert.equal((await submit('fork')).operation.resultThreadId, FORK);
    await submit('rename', { title: '已改名' });
    const models = await session.rpc<{ models: { id: string }[] }>(apiCall('/models'));
    assert.deepEqual(
      models.models.map(({ id }) => id),
      ['fixture-model'],
    );
    const settings = {
      model: 'fixture-model',
      effort: 'high',
      serviceTier: 'fast',
      mode: 'plan',
      expectedModel: 'fixture-model',
      expectedEffort: 'medium',
      expectedServiceTier: null,
      expectedMode: 'default',
    };
    await submit('settings', settings);
    await wait(
      () => view?.reasoningEffort === 'high' && view?.mode === 'plan' && view?.serviceTier === 'fast',
    );
    await submit('settings', settings, THREAD, 'rejected');
    const controls = await session.rpc<{ state: { permission: string; permissionRevision: string } }>(
      apiCall(`/threads/${THREAD}/controls`),
    );
    assert.equal(controls.state.permission, ':workspace');
    await submit('control', {
      control: {
        action: 'permission',
        value: ':read-only',
        expected: ':workspace',
        expectedRevision: controls.state.permissionRevision,
      },
    });
    await wait(() => view?.controls?.permission === ':read-only');
    const { skills } = await session.rpc<{ skills: { id: string; name: string }[] }>(
      apiCall(`/threads/${THREAD}/skills`),
    );
    const { plugins } = await session.rpc<{ plugins: { id: string; name: string }[] }>(
      apiCall(`/threads/${THREAD}/plugins`),
    );
    assert.equal(skills[0]?.name, 'fixture');
    assert.equal(plugins[0]?.name, 'Fixture Plugin');
    step = 'sending and deduplicating messages';
    const id = crypto.randomUUID();
    const call = apiCall(`/threads/${THREAD}/messages`, 'POST', {
      requestId: id,
      text: 'native smoke',
      skillIds: [skills[0].id],
      pluginIds: [plugins[0].id],
    });
    await session.rpc(call);
    await wait(async () => (await operation(id)).state === 'accepted');
    const early = crypto.randomUUID();
    await session.rpc(
      apiCall(`/threads/${THREAD}/messages`, 'POST', { requestId: early, text: 'too early' }),
    );
    await wait(async () => (await operation(early)).state === 'rejected');
    ipc.publishTurn();
    await wait(() => view?.activeTurnId === ipc.turn);
    assert(update.order.includes('earlier-message'));
    assert(!update.changed.some((message: { id: string }) => message.id === 'earlier-message'));
    await session.rpc(call);
    await assert.rejects(session.rpc({ ...call, body: { requestId: id, text: 'different operation' } }));
    step = 'synchronizing the native queue';
    await wait(() => !!view?.queueFingerprint);
    const emptyQueue = view.queueFingerprint;
    const queued = await submit('queue', { text: '队列测试', expectedQueueFingerprint: emptyQueue });
    await wait(() => view?.queuedMessages?.length === 1);
    const queuedId = (queued.request.body as { requestId: string }).requestId;
    assert.equal(view.queuedMessages[0].id, queuedId);
    await submit('queue', { text: '过期队列', expectedQueueFingerprint: emptyQueue }, THREAD, 'rejected');
    await submit('queue-remove', { messageId: queuedId, expectedQueueFingerprint: view.queueFingerprint });
    await wait(() => view?.queuedMessages?.length === 0);
    step = 'responding to Codex approvals, questions and forms';
    const request = async (
      id: string | number,
      method: string,
      params: Record<string, unknown>,
      kind: string,
    ) => {
      ipc.setRequest(id, method, params);
      await wait(() => view?.requests?.find((request: any) => request.id === String(id))?.actionable);
      const pending = view.requests.find((request: any) => request.id === String(id));
      assert.equal(pending.kind, kind);
      return {
        targetRequestId: String(id),
        expectedTurnId: params.turnId,
        expectedFingerprint: pending.fingerprint,
      };
    };
    const command = await request(
      123,
      'item/commandExecution/requestApproval',
      { turnId: ipc.turn, command: 'echo fixture', availableDecisions: ['decline'] },
      'command',
    );
    await submit('responses', { ...command, decision: 'accept' }, THREAD, 'rejected');
    await submit(
      'responses',
      { ...command, decision: 'decline', expectedFingerprint: '0'.repeat(64) },
      THREAD,
      'rejected',
    );
    assert.equal(ipc.responseCount(), 0);
    await submit('responses', { ...command, decision: 'decline' });
    await wait(() => view?.pendingRequests === 0);
    const file = await request(
      'file',
      'item/fileChange/requestApproval',
      { turnId: ipc.turn, changes: [{ path: 'fixture.txt', kind: { type: 'update' }, diff: '+fixture' }] },
      'file',
    );
    await submit('responses', { ...file, decision: 'decline' });
    const permissionRequest = await request(
      'permission',
      'item/permissions/requestApproval',
      { turnId: ipc.turn, permissions: { fileSystem: { read: ['/allowed'], write: ['/write'] } } },
      'permissions',
    );
    await submit(
      'responses',
      { ...permissionRequest, permissionIds: ['fileSystem.read.9'] },
      THREAD,
      'rejected',
    );
    await submit('responses', { ...permissionRequest, permissionIds: ['fileSystem.read.0'] });
    const question = await request(
      'question',
      'item/tool/requestUserInput',
      { turnId: ipc.turn, questions: [{ id: 'answer', question: '请回答', options: [{ label: '测试' }] }] },
      'question',
    );
    await submit('responses', { ...question, answers: { answer: ['测试'] } });
    const form = await request(
      'form',
      'mcpServer/elicitation/request',
      {
        turnId: ipc.turn,
        mode: 'form',
        requestedSchema: {
          type: 'object',
          required: ['confirmed'],
          properties: { confirmed: { type: 'boolean' } },
        },
      },
      'elicitation',
    );
    await submit(
      'responses',
      { ...form, action: 'accept', content: { confirmed: 'invalid' } },
      THREAD,
      'rejected',
    );
    await submit('responses', { ...form, action: 'accept', content: { confirmed: true } });
    assert.equal(ipc.responseCount(), 5);
    step = 'uploading and downloading an attachment';
    const bytes = Buffer.alloc(1024 * 1024 + 43, 42);
    const blocks = [bytes.subarray(0, 1024 * 1024), bytes.subarray(1024 * 1024)];
    const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const upload = await session.rpc<{ id: string }>(
      apiCall(`/threads/${THREAD}/uploads`, 'POST', {
        name: 'native-attachment.txt',
        size: bytes.length,
        sha256: digest(bytes),
        hashes: blocks.map(digest),
      }),
    );
    const ready = await session.ready;
    const bulk = await nodeSession(
      origin,
      host.peerId,
      phone,
      ready.ticket,
      {
        type: 'authenticate',
        protocol: 2,
        sessionId: ready.sessionId,
      },
      'bulk',
    );
    try {
      const data = { fileId: upload.id, threadId: THREAD, backendId: 'codex-local' };
      await assert.rejects(bulk.rpc(apiCall('/threads')));
      await assert.rejects(bulk.request('file', { ...data, action: 'write', index: 0 }, Uint8Array.of(0)));
      await bulk.request('file', { ...data, action: 'write', index: 0 }, blocks[0]);
      assert.deepEqual((await bulk.request('file', { ...data, action: 'missing' })).value.missing, [1]);
      await bulk.request('file', { ...data, action: 'write', index: 1 }, blocks[1]);
      const done = await bulk.request('file', { ...data, action: 'finish' });
      assert.deepEqual(await readFile(done.value.path), bytes);
      const described = await session.rpc<{ id: string }>(
        apiCall(`/threads/${THREAD}/media`, 'POST', { path: done.value.path }),
      );
      assert.equal(described.id, upload.id);
      const fetched = await bulk.request('file', { ...data, action: 'read', index: 0 });
      assert.deepEqual(Buffer.from(fetched.bytes!), blocks[0]);
      await assert.rejects(
        session.rpc(
          apiCall(`/threads/${THREAD}/media`, 'POST', { path: join(directory, 'state', 'state.sqlite') }),
        ),
      );
    } finally {
      bulk.close();
    }
    if (testStorage) await exerciseStorage(session);
    step = 'steering and interrupting the active turn';
    const steer = crypto.randomUUID();
    await session.rpc(
      apiCall(`/threads/${THREAD}/steer`, 'POST', {
        requestId: steer,
        expectedTurnId: ipc.turn,
        text: 'follow up',
        uploadIds: [upload.id],
      }),
    );
    await wait(async () => (await operation(steer)).state === 'accepted');
    const stale = crypto.randomUUID();
    await session.rpc(
      apiCall(`/threads/${THREAD}/interrupt`, 'POST', { requestId: stale, expectedTurnId: 'stale-turn' }),
    );
    await wait(async () => (await operation(stale)).state === 'rejected');
    const stop = crypto.randomUUID();
    await session.rpc(
      apiCall(`/threads/${THREAD}/interrupt`, 'POST', { requestId: stop, expectedTurnId: ipc.turn }),
    );
    await wait(async () => (await operation(stop)).state === 'interrupted' && !view?.activeTurnId);
    step = 'replying to optional questions and approving plans';
    ipc.asyncQuestion();
    await wait(() => view?.requests?.some((row: any) => row.kind === 'async-question'));
    const optional = view.requests.find((row: any) => row.kind === 'async-question');
    const reply = async (body: Record<string, unknown>) => {
      const id = crypto.randomUUID();
      await session.rpc(apiCall(`/threads/${THREAD}/responses`, 'POST', { requestId: id, ...body }));
      await wait(async () => ['accepted', 'completed'].includes((await operation(id)).state));
      return operation(id);
    };
    const answered = await reply({
      targetRequestId: optional.id,
      expectedTurnId: optional.turnId,
      expectedFingerprint: optional.fingerprint,
      answers: { [optional.questions[0].id]: ['测试'] },
    });
    await wait(() => !view?.requests?.some((row: any) => row.kind === 'async-question'));
    const planTurn = answered.turnId;
    assert(planTurn);
    const plan = await request(
      'plan',
      'item/plan/requestImplementation',
      { threadId: THREAD, turnId: planTurn, planContent: '测试计划' },
      'plan',
    );
    await reply({ ...plan, planDecision: 'implement' });
    await wait(() => view?.pendingRequests === 0);
    assert.deepEqual(ipc.expected, { send: 1, steer: 1, interrupt: 1 });
  } catch (cause) {
    throw new Error(`Native IPC smoke test failed while ${step}`, { cause });
  } finally {
    unsubscribe();
  }
}

async function exerciseStorage(session: DeviceLink) {
  const data = Buffer.alloc(38_513_257, 0x4a);
  const blocks = Array.from({ length: Math.ceil(data.length / BLOCK_SIZE) }, (_, index) =>
    data.subarray(index * BLOCK_SIZE, (index + 1) * BLOCK_SIZE),
  );
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const manifest = await session.rpc<FileManifest>(
    apiCall(`/threads/${THREAD}/uploads`, 'POST', {
      name: 'synthetic-storage.mp4',
      size: data.length,
      sha256: hash(data),
      hashes: blocks.map(hash),
    }),
  );
  assert.equal(manifest.mime, 'video/mp4');
  assert.equal(manifest.storage, true);
  assert.equal(manifest.storageBatchBlocks, 25);
  const file = { backendId: 'codex-local', threadId: THREAD, fileId: manifest.id };
  let objects = 0;
  for (let first = 0; first < blocks.length; first += manifest.storageBatchBlocks) {
    const indices = blocks
      .slice(first, first + manifest.storageBatchBlocks)
      .map((_, offset) => first + offset);
    const { value: plan } = await session.request('file', { ...file, action: 'storage-plan', indices });
    const parts = await Promise.all(indices.map((index) => encryptBlock(manifest, index, blocks[index])));
    await uploadToStorage(
      plan.upload,
      new File(parts as Uint8Array<ArrayBuffer>[], 'data', { type: 'application/octet-stream' }),
    );
    await session.request(
      'file',
      { ...file, action: 'storage-import', objectId: plan.objectId },
      undefined,
      120_000,
    );
    objects++;
  }
  const completed = await session.request('file', { ...file, action: 'finish' });
  assert.deepEqual(await readFile(completed.value.path), data);
  assert.equal(objects, 2);
  const { value: download } = await session.request('file', {
    ...file,
    action: 'storage-plan',
    indices: [0],
  });
  const response = await fetch(download.url, { headers: { Range: `bytes=0-${BLOCK_SIZE + 15}` } });
  assert.equal(response.status, 206);
  assert.deepEqual(
    Buffer.from(await decryptBlock(manifest, 0, new Uint8Array(await response.arrayBuffer()))),
    blocks[0],
  );
  await session.request('file', { ...file, action: 'storage-done', objectId: download.objectId });
  const db = new DatabaseSync(join(state, 'state.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS count FROM native_storage_objects').get()?.count, 0);
  db.close();
  console.log(
    'Private object storage round trip: 36.7 MiB in two uploads, byte verification and object cleanup passed.',
  );
}

async function browserDirect(
  code: string,
  executablePath: string,
  fixture: Awaited<ReturnType<typeof desktopFixture>>,
) {
  const { chromium, expect } = await import('@playwright/test');
  const browser = await chromium.launch({ executablePath });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await context.addInitScript(() => {
      const qa = ((window as any).__nativeQa = { direct: 0, relay: 0, peers: [] as RTCPeerConnection[] });
      const Peer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Peer {
        constructor(config?: RTCConfiguration) {
          super(config);
          qa.peers.push(this);
        }
        createDataChannel(label: string, config?: RTCDataChannelInit) {
          const channel = super.createDataChannel(label, config);
          if (label === 'pocket-bulk-v2') {
            const send = channel.send.bind(channel) as (data: ArrayBuffer) => void;
            channel.send = ((data: ArrayBuffer) => {
              qa.direct += data.byteLength;
              send(data);
            }) as typeof channel.send;
          }
          return channel;
        }
      };
      const Socket = window.WebSocket;
      window.WebSocket = class extends Socket {
        private bulk = false;
        send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          if (typeof data === 'string') {
            const message = JSON.parse(data);
            this.bulk ||= message.type === 'join' && message.lane === 'bulk';
          } else if (this.bulk) {
            qa.relay += data instanceof Blob ? data.size : data.byteLength;
          }
          super.send(data);
        }
      };
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin + '/#pair=' + code + '&host=' + host.peerId);
    await expect(page).toHaveTitle('Agent 空间');
    await page.getByRole('button', { name: '连接电脑', exact: true }).click();
    await page.getByRole('tab', { name: '最近', exact: true }).click();
    await page.getByRole('button', { name: /测试会话/ }).click();
    await page.getByRole('button', { name: '继续此会话', exact: true }).click();
    await expect(page.getByLabel('消息', { exact: true })).toBeEnabled({ timeout: 15000 });
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await expect(page.getByText('Fixture Model', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    fixture.setRequest('browser-approval', 'item/commandExecution/requestApproval', {
      turnId: null,
      command: 'echo fixture',
      availableDecisions: ['decline'],
    });
    const approval = page.locator('[data-request-kind="command"]');
    await expect(approval).toContainText('echo fixture');
    await approval.getByRole('button', { name: '拒绝', exact: true }).click();
    await expect(approval).toHaveCount(0);
    assert.equal(fixture.responseCount(), 1);
    const connected = () =>
      page.evaluate(() =>
        (window as any).__nativeQa.peers.some((p: RTCPeerConnection) => p.connectionState === 'connected'),
      );
    await expect.poll(connected, { timeout: 20000 }).toBe(true);
    const size = 5 * 1024 * 1024;
    await page.locator('input[type=file]').setInputFiles({
      name: 'native-direct.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(size, 35),
    });
    await expect
      .poll(() => page.evaluate(() => (window as any).__nativeQa.direct), { timeout: 25000 })
      .toBeGreaterThan(size);
    await expect(page.locator('.upload-chip')).toContainText('native-direct.bin', { timeout: 25000 });
    assert.equal(await page.evaluate(() => (window as any).__nativeQa.relay), 0);
    assert.deepEqual(errors, []);
    if (process.env.POCKET_NATIVE_TEST_BROWSER_SCREENSHOT)
      await page.screenshot({ path: process.env.POCKET_NATIVE_TEST_BROWSER_SCREENSHOT });
    console.log(
      'Chromium confirmed a desktop approval response and uploaded 5 MiB through WebRTC without relay bulk payload.',
    );
  } finally {
    await browser.close();
  }
}

function reconnect(phone: Identity, ticket: string) {
  return nodeSession(origin, host.peerId, phone, ticket, {
    type: 'authenticate',
    protocol: 2,
    sessionId: crypto.randomUUID(),
  });
}

async function verifyTlsClient() {
  const probe = createServer();
  const hello = new Promise<Buffer>((resolve) => {
    probe.on('connection', (socket) => {
      socket.once('data', (bytes) => {
        resolve(bytes);
        socket.destroy();
      });
    });
  });
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert(address && typeof address !== 'string');
  const child = spawn(executable, ['--headless'], {
    env: {
      ...process.env,
      POCKET_NATIVE_STATE_DIR: join(directory, 'tls-probe'),
      POCKET_NATIVE_ORIGIN: `https://127.0.0.1:${address.port}`,
      POCKET_NATIVE_ENROLLMENT: '',
      POCKET_NATIVE_CODEX_HOME: codexHome,
      POCKET_NATIVE_READ_ONLY: '1',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const closed = once(child, 'close');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bytes = await Promise.race([
      hello,
      closed.then(() => {
        throw Error('Native gateway exited before sending a TLS ClientHello');
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Native gateway did not send a TLS ClientHello')), 5000);
      }),
    ]);
    assert.equal(bytes[0], 0x16, 'Expected a TLS handshake record');
  } finally {
    clearTimeout(timer);
    child.kill();
    await closed.catch(() => {});
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
}

try {
  await verifyTlsClient();
  await relay.listen();
  let gateway = await launch();
  try {
    if (browserExecutable) {
      assert(ipc && !cloudflare, 'Browser smoke requires the Node relay and desktop fixture');
      await browserDirect(gateway.code, browserExecutable, ipc);
      await gateway.stop();
      ipc.closeConversation();
      ipc.actions.length = 0;
      gateway = await launch(true);
    }
    const existing = await reconnect(existingPhone, old.routeTicket);
    assert.equal((await existing.ready).device.id, old.deviceId);
    existing.close();

    const phone = await createIdentity();
    const route = createHash('sha256').update(gateway.code).digest('hex');
    const pair = () =>
      nodeSession(origin, host.peerId, phone, route, {
        type: 'pair',
        protocol: 2,
        sessionId: crypto.randomUUID(),
        name: 'Native smoke phone',
        code: gateway.code,
      });
    const session = await pair();
    const ready = await session.ready;
    assert.equal(ready.status.writesEnabled, !!ipc);
    assert.equal(ready.status.capabilities.openThread, !!ipc);
    const list = await session.rpc<{ threads: { id: string; title: string }[] }>(apiCall('/threads'));
    assert.deepEqual(
      list.threads.map(({ id, title }) => [id, title]),
      [[THREAD, '测试会话']],
    );
    const projects = await session.rpc<{ projects: { id: string; name: string; count: number }[] }>(
      apiCall('/projects'),
    );
    assert.deepEqual(projects.projects, [
      { id: 'native-project', name: '材料研究', count: 1 },
      { id: 'empty-project', name: '空项目', count: 0 },
    ]);
    const searched = await session.rpc<{ threads: { projectName: string }[] }>(
      apiCall('/threads?q=材料研究&project=native-project'),
    );
    assert.equal(searched.threads[0]?.projectName, '材料研究');
    const history = await session.rpc<{
      messages: { id: string; text: string; truncated: boolean; attachments: { path: string }[] }[];
    }>(apiCall(`/threads/${THREAD}/history`));
    assert.deepEqual(
      history.messages.map(({ text }) => text),
      ['历史消息', Buffer.from(historicalReply).subarray(0, 12_000).toString()],
    );
    assert.equal(history.messages[0].attachments[0].path, legacyPath);
    assert.equal(history.messages[1].truncated, true);
    const historic = await session.rpc<{ message: { text: string } }>(
      apiCall(`/threads/${THREAD}/content?messageId=${history.messages[1].id}`),
    );
    assert.equal(historic.message.text, historicalReply);
    assert.equal(history.messages[1].attachments[0].path, inlineRef);
    await writeFile(
      join(legacyState, 'uploads', legacyId + '.json'),
      JSON.stringify({
        id: legacyId,
        device: ready.device.id,
        thread: THREAD,
        name: legacyName,
        file: legacyPath,
        complete: true,
        size: legacyBytes.length,
        sha256: createHash('sha256').update(legacyBytes).digest('hex'),
      }),
      { mode: 0o600 },
    );
    if (process.platform === 'win32')
      platformRuntime().privateFile(join(legacyState, 'uploads', legacyId + '.json'));
    const describe = (path: string) =>
      session.rpc<FileManifest>(apiCall(`/threads/${THREAD}/media`, 'POST', { path }));
    for (const [path, expected] of [
      [legacyPath, legacyBytes],
      [inlineRef, inlineBytes],
      [projectFile, Buffer.from('project attachment')],
    ] as const) {
      const manifest = await describe(path);
      const data = await session.request('file', {
        backendId: 'codex-local',
        threadId: THREAD,
        fileId: manifest.id,
        action: 'read',
        index: 0,
      });
      assert.deepEqual(Buffer.from(data.bytes!), expected);
      const other = await reconnect(existingPhone, old.routeTicket);
      try {
        await assert.rejects(
          other.request('file', {
            backendId: 'codex-local',
            threadId: THREAD,
            fileId: manifest.id,
            action: 'read',
            index: 0,
          }),
        );
        if (path === legacyPath)
          await assert.rejects(other.rpc(apiCall(`/threads/${THREAD}/media`, 'POST', { path })));
      } finally {
        other.close();
      }
    }
    await assert.rejects(describe(unrelatedFile));
    await assert.rejects(session.rpc(apiCall(`/threads/${THREAD}/messages`, 'POST', { text: 'blocked' })));
    if (ipc) await testLive(session, ipc, phone);
    session.close();
    await assert.rejects(pair(), 'Pairing code was not single-use');

    await gateway.stop();
    gateway = await launch(true);
    const resumed = await reconnect(phone, ready.ticket);
    assert.equal((await resumed.ready).device.id, ready.device.id);
    resumed.close();
  } finally {
    await gateway.stop();
  }
  console.log(
    `Native gateway (${cloudflare ? 'Cloudflare' : 'Node'} relay): TLS startup, pairing, history, replay rejection and restart passed${ipc ? ', including native Codex live controls' : ''}.`,
  );
} finally {
  await relay.close();
  await ipc?.close();
  await rm(directory, { recursive: true, force: true });
}
