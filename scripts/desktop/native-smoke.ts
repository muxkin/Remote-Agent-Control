import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { Config } from '../../src/server/config.js';
import { FileService } from '../../src/server/file-service.js';
import { Store } from '../../src/server/store.js';
import { Uploads } from '../../src/server/uploads.js';
import { hostIdentity } from '../../src/server/device-identity.js';
import { buildRelay } from '../../src/server/relay.js';
import { platformRuntime } from '../../src/server/platform.js';
import { createIdentity, type Identity } from '../../src/shared/secure-channel.js';
import type { BackendAppearanceDocument, BackendInfo } from '../../src/shared/backends.js';
import { DeviceLink } from '../../src/shared/device-link.js';
import { nodeSession } from '../../src/client/node-session.js';
import { apiCall } from '../../src/shared/rpc.js';
import { BLOCK_SIZE, encryptBlock, decryptBlock, type FileManifest } from '../../src/shared/files.js';
import { uploadToStorage } from '../../src/web/storage-upload.js';
import { historyFixture, THREAD } from '../../test/helpers.js';
import { FrameReader, encodeFrame } from '../../packages/adapter-codex/src/framing.js';

const executable = resolve(process.argv[2] ?? 'desktop/native/target/release/agent-space-native');
const codexPackage = process.argv[3] && resolve(process.argv[3]);
const storageFixture = process.env.POCKET_NATIVE_TEST_STORAGE_PLUGIN;
const bundled = process.env.POCKET_NATIVE_TEST_BUNDLED_PLUGINS === '1';
assert(bundled || codexPackage, 'Supply the Codex plugin directory or test an installer with bundled plugins');
const directory = await mkdtemp(
  join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'native-adapter-smoke-'),
);
const state = join(directory, 'state');
const legacyState = join(directory, 'legacy');
const adapter = (...args: string[]) =>
  promisify(execFile)(executable, ['--adapter', ...args], {
    env: { ...process.env, POCKET_NATIVE_STATE_DIR: state },
  });
const codexHome = join(directory, 'codex');
const secondaryId = 'codex-secondary';
const legacyOperation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
await mkdir(legacyState, { mode: 0o700 });
const host = await hostIdentity(legacyState);
const existingPhone = await createIdentity();
const store = new Store(legacyState);
const old = store.pair(store.mintPairing().code, 'Existing phone', existingPhone.peerId);
assert(old?.routeTicket);
store.updateBackendAppearance('codex-local', {
  description: '旧版显示说明',
  icon: { kind: 'builtin', value: 'monitor' },
});
if (codexPackage) {
  store.beginOperation(legacyOperation, old.deviceId, THREAD, 'rename', JSON.stringify({ title: '旧操作' }), secondaryId);
  store.updateOperation(legacyOperation, 'completed', null, null, secondaryId);
}
store.close();
const rollout = historyFixture({ codexHome } as Parameters<typeof historyFixture>[0]);
const legacyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const legacyName = '旧附件.txt';
const legacyPath = join(legacyState, 'uploads', legacyId, legacyName);
const legacyBytes = Buffer.from('旧附件校验数据');
const migratedDraftId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const migratedDraftPath = join(legacyState, 'uploads', migratedDraftId, legacyName);
const migratedNativeId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const migratedNativeDir = join(legacyState, 'native-uploads', migratedNativeId);
const migratedNativePath = join(migratedNativeDir, 'attachment.txt');
const inlineBytes = Buffer.alloc(420_000, 37);
const inlineSource = 'data:image/png;base64,' + inlineBytes.toString('base64');
const inlineRef = 'pocket-inline:' + createHash('sha256').update(inlineSource).digest('hex') + '.png';
const projectPath = join(directory, 'project');
const projectFile = join(projectPath, 'report.txt');
const projectPdf = 'main.pdf';
const projectPng = 'wphase-ce-search-page-5.png';
const pdfObjects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>',
];
let pdf = '%PDF-1.4\n';
const offsets = pdfObjects.map((body, index) => {
  const start = pdf.length;
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  return String(start).padStart(10, '0') + ' 00000 n \n';
});
const xref = pdf.length;
pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const pdfBytes = Buffer.from(pdf);
const pngBytes = await readFile('src/web/public/app-icon-32.png');
const unrelatedFile = join(projectPath, 'unrelated.txt');
const outsidePng = join(directory, 'outside-settings.png');
await mkdir(projectPath, { recursive: true });
await writeFile(projectFile, 'project attachment');
await writeFile(join(projectPath, projectPdf), pdfBytes);
await writeFile(join(projectPath, projectPng), pngBytes);
await writeFile(unrelatedFile, 'unmentioned file');
await writeFile(outsidePng, pngBytes);
await mkdir(join(legacyState, 'uploads', legacyId), { mode: 0o700, recursive: true });
await writeFile(legacyPath, legacyBytes, { mode: 0o600 });
if (process.platform === 'win32') platformRuntime().privateFile(legacyPath);
await mkdir(join(migratedDraftPath, '..'), { mode: 0o700 });
await writeFile(migratedDraftPath, legacyBytes, { mode: 0o600 });
const migratedReceipt = join(legacyState, 'uploads', migratedDraftId + '.json');
const migratedDigest = createHash('sha256').update(legacyBytes).digest('hex');
await writeFile(migratedReceipt, JSON.stringify({
  id: migratedDraftId, device: old.deviceId, thread: THREAD, name: legacyName, file: migratedDraftPath,
  size: legacyBytes.length, sha256: migratedDigest, complete: true,
}), { mode: 0o600 });
await mkdir(migratedNativeDir, { mode: 0o700, recursive: true });
await writeFile(migratedNativePath, legacyBytes, { mode: 0o600 });
if (process.platform === 'win32') {
  const runtime = platformRuntime();
  for (const dir of [join(legacyState, 'native-uploads'), migratedNativeDir]) runtime.privateDirectory(dir);
  for (const path of [migratedReceipt, migratedDraftPath, migratedNativePath]) runtime.privateFile(path);
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const legacyBlocks = [Buffer.alloc(BLOCK_SIZE, 43), Buffer.alloc(BLOCK_SIZE, 92), Buffer.from('最后一块')];
const legacyBlockBytes = Buffer.concat(legacyBlocks);
const legacyRawBytes = Buffer.from('old upload in three pieces');
const legacyConfig = { stateDir: legacyState } as Config;
const legacyUploads = new Uploads(legacyConfig);
const legacyFiles = new FileService(legacyConfig, legacyUploads);
const legacyManifest = await legacyFiles.begin({
  name: 'old-blocks.bin', size: legacyBlockBytes.length, sha256: digest(legacyBlockBytes),
  hashes: legacyBlocks.map(digest),
}, old.deviceId, THREAD);
for (const index of [0, 1]) {
  await legacyFiles.handle('write', {
    threadId: THREAD, fileId: legacyManifest.id, index,
  }, old.deviceId, legacyBlocks[index]);
}
legacyFiles.close();
const legacyBlockUpload = await legacyUploads.get(legacyManifest.id, old.deviceId, THREAD);
const legacyBlockPart = legacyBlockUpload.file + '.part';
const corruptBlock = await open(legacyBlockPart, 'r+');
try {
  await corruptBlock.write(Buffer.from([0]), 0, 1, BLOCK_SIZE);
} finally {
  await corruptBlock.close();
}
const legacyRawUpload = await legacyUploads.begin({
  name: 'old-offset.txt', size: legacyRawBytes.length, sha256: digest(legacyRawBytes),
}, old.deviceId, THREAD);
await legacyUploads.chunk(legacyRawUpload.id, old.deviceId, THREAD, 0, legacyRawBytes.subarray(0, 4));
const legacyRawPart = (await legacyUploads.get(legacyRawUpload.id, old.deviceId, THREAD)).file + '.part';
const legacyRenamedUpload = await legacyUploads.begin({
  name: 'old-renamed.txt', size: legacyRawBytes.length, sha256: digest(legacyRawBytes),
}, old.deviceId, THREAD);
await legacyUploads.chunk(legacyRenamedUpload.id, old.deviceId, THREAD, 0, legacyRawBytes);
const legacyRenamedPath = (await legacyUploads.get(legacyRenamedUpload.id, old.deviceId, THREAD)).file;
await rename(legacyRenamedPath + '.part', legacyRenamedPath);
const transfersDir = join(legacyState, 'transfers-v2');
const legacyUploadSources = [
  legacyBlockPart, legacyRawPart, legacyRenamedPath, join(transfersDir, legacyManifest.id + '.json'),
  ...[legacyManifest.id, legacyRawUpload.id, legacyRenamedUpload.id]
    .map((id) => join(legacyState, 'uploads', id + '.json')),
];
if (process.platform === 'win32') {
  const runtime = platformRuntime();
  runtime.privateDirectory(transfersDir);
  for (const path of [legacyBlockPart, legacyRawPart, legacyRenamedPath])
    runtime.privateDirectory(join(path, '..'));
  for (const path of legacyUploadSources) runtime.privateFile(path);
}
const legacyUploadSnapshots = await Promise.all(legacyUploadSources.map((path) => readFile(path)));
const legacyTransfer = { backendId: 'codex-local', threadId: THREAD, fileId: legacyManifest.id };
const legacyMissing = { ...legacyTransfer, action: 'missing' };
const rawChunk = (offset: number) =>
  apiCall(`/threads/${THREAD}/uploads/${legacyRawUpload.id}/chunk?offset=${offset}`, 'POST');
const rawFinish = apiCall(`/threads/${THREAD}/uploads/${legacyRawUpload.id}/complete`, 'POST');
const legacyNativeDb = new DatabaseSync(join(legacyState, 'state.sqlite'));
try {
  legacyNativeDb.exec(`CREATE TABLE native_uploads (
    id TEXT PRIMARY KEY, device TEXT NOT NULL, thread TEXT NOT NULL, manifest TEXT NOT NULL,
    present TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL
  )`);
  legacyNativeDb.prepare('INSERT INTO native_uploads VALUES (?,?,?,?,?,1,0)').run(
    migratedNativeId, old.deviceId, THREAD, JSON.stringify({
      id: migratedNativeId, name: legacyName, size: legacyBytes.length, sha256: migratedDigest,
      hashes: [migratedDigest], version: migratedNativeId, storage: false,
      key: randomBytes(32).toString('base64'), nonce: randomBytes(8).toString('base64'),
    }), '[0]',
  );
} finally {
  legacyNativeDb.close();
}
const legacyRecord = JSON.parse(await readFile(rollout, 'utf8'));
legacyRecord.payload.content[0].text +=
  '\n\n手机上传的附件（保留原始文件）：\n' + JSON.stringify({ name: legacyName, path: legacyPath });
const historicalReply =
  ':codex-file-citation{path="./report.txt" purpose="open"}\n' +
  `[${projectPdf}](sandbox:./${projectPdf})\n![${projectPng}](sandbox:./${projectPng})\n` +
  `[临时目录截图](<${outsidePng}>)\n` +
  '`:codex-file-citation{path="./unrelated.txt"}`\n' +
  'Earlier history. '.repeat(800);
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
const viewed = await Promise.all(
  [32, 192].map(async (width, index) => ({
    path: pathToFileURL(join(directory, `removed-page-${5 + index}.png`)).href,
    bytes: await readFile(`src/web/public/app-icon-${width}.png`),
    width,
  })),
);
const unpaired = pathToFileURL(join(directory, 'unpaired.png')).href;
const activityEvent = (item: Record<string, unknown>) => ({
  type: 'event_msg',
  payload: { type: 'item_completed', thread_id: THREAD, turn_id: 'earlier-turn', item },
});
const imageCall = (id: string, paths: string[], outputs: Buffer[]) => [
  { type: 'response_item', payload: { type: 'custom_tool_call', call_id: id } },
  ...paths.map((path) => activityEvent({ type: 'ImageView', path })),
  {
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: id,
      output: [
        { type: 'input_text', text: 'test fixture' },
        ...outputs.map((bytes) => ({
          type: 'input_image',
          image_url: 'data:image/png;base64,' + bytes.toString('base64'),
        })),
      ],
    },
  },
];
const historicalTool = activityEvent({
  type: 'CommandExecution',
  command: ['printf', 'historical tool'],
  status: 'completed',
  aggregated_output: 'historical output',
  exit_code: 0,
});
await writeFile(
  rollout + '.zst',
  zstdCompressSync(
    Buffer.from(
      [
        legacyRecord,
        historicalTool,
        ...imageCall(
          'viewed',
          viewed.map((item) => item.path),
          viewed.map((item) => item.bytes),
        ),
        ...imageCall(
          'unpaired',
          [unpaired],
          viewed.map((item) => item.bytes),
        ),
        assistantRecord,
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    ),
  ),
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
const secondaryTitle = '第二个 Codex 会话';
const secondaryRename = '第二个 Codex 已改名';
const secondaryIpc = ipc && codexPackage ? await desktopFixture(secondaryId, secondaryTitle, secondaryRename) : undefined;
const secondaryHome = join(directory, secondaryId);
const secondaryUploads = join(legacyState, 'backends', secondaryId, 'uploads');
const secondaryPath = join(secondaryUploads, legacyId, legacyName);
const secondaryBytes = Buffer.from('第二个实例的附件');
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

async function launch(useSaved = false, extraEnvironment: NodeJS.ProcessEnv = {}) {
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
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        key.toUpperCase() !== 'POCKET_NATIVE_LEGACY_STATE' &&
        (!codexPackage || !/^POCKET_NATIVE_CODEX_/i.test(key)),
    ),
  );
  const child = spawn(executable, ['--headless', '--print-pair'], {
    env: {
      ...inherited,
      POCKET_NATIVE_ORIGIN: useSaved ? '' : origin,
      POCKET_NATIVE_ENROLLMENT: useSaved ? '' : enrollment,
      POCKET_NATIVE_STATE_DIR: state,
      POCKET_NATIVE_P2P: '1',
      ...(!codexPackage ? { POCKET_NATIVE_CODEX_HOME: codexHome } : {}),
      POCKET_NATIVE_READ_ONLY: ipc ? '0' : '1',
      ...(ipc && !codexPackage
        ? {
            POCKET_NATIVE_CODEX_SOCKET: ipc.path,
            POCKET_NATIVE_CODEX_APP_TOOLS: ipc.path,
            POCKET_NATIVE_CODEX_EXECUTABLE: process.execPath,
            ...(forkCli ? { POCKET_NATIVE_CODEX_CLI: forkCli } : {}),
          }
        : {}),
      ...extraEnvironment,
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

async function desktopFixture(id = 'default', initialTitle = '测试会话', renameTitle = '已改名') {
  const path =
    process.platform === 'win32'
      ? '\\\\.\\pipe\\agent-space-native-test-' + crypto.randomUUID()
      : join(directory, 'ipc', id + '.sock');
  if (process.platform !== 'win32') await mkdir(join(directory, 'ipc'), { mode: 0o700, recursive: true });
  const sockets = new Set<import('node:net').Socket>();
  const expected = { send: 0, steer: 0, interrupt: 0 };
  const turn = crypto.randomUUID();
  let publishTurn = () => {};
  let holdStart = false;
  let heldStart: (() => void) | undefined;
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
  let title = initialTitle;
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
        items: [
          { id: 'earlier-message', type: 'agentMessage', text: 'earlier response '.repeat(1000) },
          {
            id: 'live-command',
            type: 'commandExecution',
            command: 'printf live',
            status: 'completed',
            aggregatedOutput: 'live output',
            exitCode: 0,
            accessToken: 'fixture-secret',
          },
          { id: 'live-image', type: 'imageView', path: viewed[0].path },
          { id: 'second-live-image', type: 'imageView', path: viewed[1].path },
        ],
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
                assert.deepEqual(args, { source: 'codex', threadId: THREAD, title: renameTitle });
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
            assert(value.params.turnStart.request.input[0].text.endsWith('native smoke'));
            assert.deepEqual(value.params.turnStart.context.attachments, [
              { label: legacyName, path: legacyPath, fsPath: legacyPath },
            ]);
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
            const acknowledge = () => response({ result: { turn: { id: turn } } });
            if (holdStart) heldStart = acknowledge;
            else acknowledge();
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
    holdStart: () => {
      holdStart = true;
      return () => {
        holdStart = false;
        heldStart?.();
        heldStart = undefined;
      };
    },
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
  const wait = async (check: () => boolean | Promise<boolean>, timeout = 6_000) => {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 65));
    }
    throw Error('Native Codex control did not reach the expected state');
  };
  const operation = (id: string) =>
    session.rpc<{ state: string; error?: string; resultThreadId?: string; turnId?: string }>(apiCall(`/operations/${id}`));
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
      let observed = await operation(requestId);
      try {
        // The native CLI-backed fork may legitimately take up to 15 seconds.
        await wait(async () => {
          if (observed.state === state) return true;
          observed = await operation(requestId);
          return observed.state === state;
        }, suffix === 'fork' && 'lastTurnId' in input && forkCli ? 20_000 : undefined);
      } catch (cause) {
        throw Error(`Codex ${suffix} expected ${state}, received ${observed.state}${observed.error ? ' (' + observed.error + ')' : ''}`, { cause });
      }
      return { request, operation: observed };
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
    const activity = update.changed.find((message: any) => message.id === 'live-command');
    assert.equal(activity.text, '命令 · printf live · completed');
    assert.equal(activity.deferred, true);
    assert(!JSON.stringify(activity).includes('live output'));
    assert.equal(update.changed.find((message: any) => message.id === 'live-image').role, 'tool');
    const details = await session.rpc<{ message: Record<string, unknown> }>(
      apiCall(`/threads/${THREAD}/content?messageId=live-command`),
    );
    assert.equal(details.message.output, 'live output');
    assert.equal(details.message.details, 'printf live\n退出码：0');
    assert.equal(details.message.deferred, false);
    assert(!JSON.stringify(details).includes('fixture-secret'));
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
      uploadIds: [legacyId],
      skillIds: [skills[0].id],
      pluginIds: [plugins[0].id],
    });
    const releaseStart = codexPackage ? ipc.holdStart() : undefined;
    try {
      await session.rpc(call);
      if (releaseStart) {
        await wait(() => ipc.expected.send === 1);
        ipc.publishTurn();
        await wait(() => view?.activeTurnId === ipc.turn);
      }
    } finally {
      releaseStart?.();
    }
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
      const oldClient = await session.rpc(apiCall(
        `/threads/${THREAD}/uploads/${upload.id}/complete`, 'POST',
      ));
      assert.deepEqual(oldClient, done.value);
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
      const qa = ((window as any).__nativeQa = {
        direct: 0, relay: 0, peers: [] as RTCPeerConnection[], pdfs: new Map<string, Blob>(),
      });
      const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (object) => {
        const url = createObjectURL(object);
        if (object instanceof Blob && object.type === 'application/pdf') qa.pdfs.set(url, object);
        return url;
      };
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
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.goto(origin + '/#pair=' + code + '&host=' + host.peerId);
    await expect(page).toHaveTitle('Agent 空间');
    await page.getByRole('button', { name: '连接电脑', exact: true }).click();
    await page.getByRole('tab', { name: '最近', exact: true }).click();
    await page.getByRole('button', { name: /测试会话/ }).click();
    assert.equal(new URL(page.url()).origin, origin);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    const evidence = process.env.POCKET_NATIVE_TEST_BROWSER_MEDIA_DIR;
    const pdfTrigger = page.getByRole('button', { name: projectPdf, exact: true });
    await pdfTrigger.click({ timeout: 15000 });
    const pdf = page.getByRole('dialog', { name: projectPdf, exact: true });
    const openPdf = pdf.getByRole('link', { name: '打开 PDF', exact: true });
    await expect(openPdf).toHaveAttribute('href', /^blob:/);
    const pdfUrl = await openPdf.getAttribute('href');
    assert.deepEqual(await openPdf.evaluate(async (link: HTMLAnchorElement) => {
      const resource: Blob | undefined = (window as any).__nativeQa.pdfs.get(link.href);
      if (!resource) throw Error('PDF viewer did not receive an object URL');
      const bytes = await resource.arrayBuffer();
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return {
        mime: resource.type,
        size: bytes.byteLength,
        sha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join(''),
      };
    }), { mime: 'application/pdf', size: pdfBytes.length, sha256: digest(pdfBytes) });
    if (evidence) await page.screenshot({ path: join(evidence, 'pdf-mobile.png') });
    const opened = page.waitForEvent('popup');
    await openPdf.click();
    const pdfTab = await opened;
    await pdfTab.waitForURL((url) => url.href === pdfUrl);
    await pdfTab.close();
    await page.keyboard.press('Escape');
    await expect(pdf).toBeHidden();
    await expect(pdfTrigger).toBeFocused();

    const thumbnail = page.getByRole('button', { name: `放大预览：${projectPng}`, exact: true });
    await thumbnail.click({ timeout: 15000 });
    const image = page.getByRole('dialog', { name: projectPng, exact: true });
    const preview = image.getByRole('img');
    await expect(preview).toBeVisible();
    assert.equal(await preview.evaluate(async (element: HTMLImageElement) => {
      await element.decode();
      return element.naturalWidth;
    }), 32);
    if (evidence) await page.screenshot({ path: join(evidence, 'png-mobile.png') });
    await image.getByRole('button', { name: '关闭图片预览', exact: true }).click();
    await expect(image).toBeHidden();

    await page.setViewportSize({ width: 1280, height: 800 });
    await pdfTrigger.click();
    await expect(openPdf).toBeVisible();
    if (evidence) await page.screenshot({ path: join(evidence, 'pdf-desktop.png') });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.deepEqual(consoleErrors, []);
    console.log('Chromium opened the historical PDF and decoded the PNG through the Rust adapter.');

    await page.getByRole('button', { name: '继续此会话', exact: true }).click();
    await expect(page.getByLabel('消息', { exact: true })).toBeEnabled({ timeout: 15000 });
    const activities = page.locator('.activity-group').filter({ hasText: '查看 3 项工具活动' });
    await activities.locator('summary').first().click();
    await expect(activities.getByText('命令 · printf live · completed', { exact: true })).toBeVisible();
    await activities.getByRole('button', { name: '展开活动详情', exact: true }).click();
    await activities.getByText('命令输出', { exact: true }).click();
    await expect(activities.getByText('live output', { exact: true })).toBeVisible();
    for (const [index, { width }] of viewed.entries()) {
      const card = activities.locator('[data-media-type=image]').nth(index);
      await card.scrollIntoViewIfNeeded();
      await expect
        .poll(() => card.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
        .toBe(width);
    }
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

async function installCodexVariants(folder: string) {
  const manifest: { name: string; version: string; entry: string } = JSON.parse(
    await readFile(join(folder, 'adapter.json'), 'utf8'),
  );
  assert.equal(manifest.name, '@agent-remote/adapter-codex');
  await adapter('install', folder);
  const replacement = join(directory, 'codex-plugin-replacement');
  await mkdir(replacement);
  await copyFile(join(folder, manifest.entry), join(replacement, manifest.entry));
  const next = { ...manifest, version: manifest.version + '-qa.1' };
  await writeFile(join(replacement, 'adapter.json'), JSON.stringify(next));
  await adapter('install', replacement);
  const secondaryRollout = historyFixture({ codexHome: secondaryHome } as Parameters<typeof historyFixture>[0]);
  const secondaryDb = new DatabaseSync(join(secondaryHome, 'state_5.sqlite'));
  secondaryDb.prepare('UPDATE threads SET title = ?, cwd = ? WHERE id = ?').run(secondaryTitle, directory, THREAD);
  secondaryDb.close();
  const record = JSON.parse(await readFile(secondaryRollout, 'utf8'));
  record.payload.content[0].text =
    '第二个实例的历史' + '\n\n手机上传的附件（保留原始文件）：\n' +
    [secondaryPath, legacyPath].map((path) => JSON.stringify({ name: legacyName, path })).join('\n');
  await writeFile(secondaryRollout, JSON.stringify(record) + '\n');
  await mkdir(join(secondaryUploads, legacyId), { mode: 0o700, recursive: true });
  await writeFile(secondaryPath, secondaryBytes, { mode: 0o600 });
  if (process.platform === 'win32') platformRuntime().privateFile(secondaryPath);
  const configPath = join(state, 'instances.json');
  await writeFile(
    configPath,
    JSON.stringify([
      {
        id: 'codex-local',
        name: 'Codex fixture',
        plugin: manifest.name,
        version: manifest.version,
        config: {
          home: codexHome,
          socket: ipc?.path,
          appTools: ipc?.path,
          executable: ipc ? process.execPath : undefined,
          cli: forkCli,
        },
      },
      {
        id: secondaryId,
        name: 'Codex secondary',
        plugin: manifest.name,
        version: manifest.version,
        config: {
          home: secondaryHome,
          socket: secondaryIpc?.path,
          appTools: secondaryIpc?.path,
          executable: secondaryIpc ? process.execPath : undefined,
        },
      },
    ]),
    { mode: 0o600 },
  );
  if (process.platform === 'win32') platformRuntime().privateFile(configPath);
  return { initial: manifest.version, next: next.version, name: manifest.name };
}

async function verifyCodexInstances(session: Awaited<ReturnType<typeof nodeSession>>, device: string) {
  const call = (path: string, method?: string, body?: unknown) => ({
    ...apiCall(path, method, body),
    backendId: secondaryId,
  });
  const backends = await session.rpc<{ backends: { id: string; name: string; profile: string }[] }>(apiCall('/backends'));
  const backend = backends.backends.find(({ id }) => id === secondaryId);
  assert.equal(backend?.name, 'Codex secondary');
  assert.equal(backend?.profile, 'rust-native-plugin');
  const list = await session.rpc<{ threads: { id: string; title: string }[] }>(call('/threads'));
  assert.deepEqual(list.threads.map(({ id, title }) => [id, title]), [[THREAD, secondaryTitle]]);
  const history = await session.rpc<{ messages: { text: string; attachments: { path: string }[] }[] }>(
    call(`/threads/${THREAD}/history`),
  );
  assert.equal(history.messages[0].text, '第二个实例的历史');
  assert.equal(history.messages[0].attachments[0].path, secondaryPath);
  const metadata = join(secondaryUploads, legacyId + '.json');
  await writeFile(metadata, JSON.stringify({
    id: legacyId, device, thread: THREAD, name: legacyName, file: secondaryPath,
    complete: true, size: secondaryBytes.length, sha256: createHash('sha256').update(secondaryBytes).digest('hex'),
  }), { mode: 0o600 });
  if (process.platform === 'win32') platformRuntime().privateFile(metadata);
  const media = `/threads/${THREAD}/media`;
  const manifest = await session.rpc<FileManifest>(call(media, 'POST', { path: secondaryPath }));
  await assert.rejects(session.rpc(call(media, 'POST', { path: legacyPath })));
  await assert.rejects(session.rpc(apiCall(media, 'POST', { path: secondaryPath })));
  const read = { threadId: THREAD, fileId: manifest.id, action: 'read', index: 0 };
  await assert.rejects(session.request('file', { ...read, backendId: 'codex-local' }));
  assert.deepEqual(Buffer.from((await session.request('file', { ...read, backendId: secondaryId })).bytes!), secondaryBytes);
}

async function verifyLiveCodexInstances(
  session: Awaited<ReturnType<typeof nodeSession>>,
  main: Awaited<ReturnType<typeof desktopFixture>>,
  secondary: Awaited<ReturnType<typeof desktopFixture>>,
  versions: Awaited<ReturnType<typeof installCodexVariants>>,
) {
  const views = new Map<string, { epoch: string; synchronized: boolean }>();
  const remove = session.onEvent((event) => {
    if (event.type !== 'sync' || !event.backendId) return;
    const view = event.updates.find((update: { kind: string }) => update.kind === 'manifest');
    if (view) views.set(event.backendId, { epoch: view.epoch, synchronized: view.thread.synchronized === true });
  });
  const waitFor = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 120; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    assert.fail('Both Codex instances did not reach the expected state');
  };
  try {
    const backends = ['codex-local', secondaryId];
    for (const backendId of backends) await session.request('watch', { backendId, threadId: THREAD });
    await session.rpc({ ...apiCall(`/threads/${THREAD}/open`, 'POST', { requestId: crypto.randomUUID() }), backendId: secondaryId });
    await waitFor(() => backends.every((id) => views.get(id)?.synchronized === true));
    const secondaryEpoch = views.get(secondaryId)?.epoch;
    assert.notEqual(views.get('codex-local')?.epoch, secondaryEpoch);

    const digest = createHash('sha256').update(secondaryBytes).digest('hex');
    const upload = await session.rpc<FileManifest>({
      ...apiCall(`/threads/${THREAD}/uploads`, 'POST', {
        name: 'isolated.txt', size: secondaryBytes.length, sha256: digest, hashes: [digest],
      }),
      backendId: secondaryId,
    });
    const file = { fileId: upload.id, threadId: THREAD, backendId: secondaryId };
    await assert.rejects(session.request('file', { ...file, backendId: 'codex-local', action: 'missing' }));
    await session.request('file', { ...file, action: 'write', index: 0 }, secondaryBytes);
    await session.request('file', { ...file, action: 'finish' });
    const read = { ...file, action: 'read', index: 0 };
    await assert.rejects(session.request('file', { ...read, backendId: 'codex-local' }));
    assert.deepEqual(Buffer.from((await session.request('file', read)).bytes!), secondaryBytes);

    const requestId = crypto.randomUUID();
    const actions = [main, secondary].map((fixture) => fixture.actions.filter((name) => name === 'set_thread_title').length);
    const rename = backends.map((backendId, index) => ({
      ...apiCall(`/threads/${THREAD}/rename`, 'POST', { requestId, title: index === 0 ? '已改名' : secondaryRename }),
      backendId,
    }));
    await Promise.all(rename.map((request) => session.rpc(request)));
    await waitFor(async () => {
      const results = await Promise.all(backends.map((backendId) =>
        session.rpc<{ backendId: string; state: string }>({ ...apiCall(`/operations/${requestId}`), backendId }),
      ));
      return results.every((result, index) => result.backendId === backends[index] && result.state === 'completed');
    });
    await Promise.all(rename.map((request) => session.rpc(request)));
    for (const [index, fixture] of [main, secondary].entries())
      assert.equal(fixture.actions.filter((name) => name === 'set_thread_title').length, actions[index] + 1);

    await verifyCodexSwitch(session, versions);
    assert.equal(views.get(secondaryId)?.epoch, secondaryEpoch);
    assert.equal(views.get(secondaryId)?.synchronized, true);
  } finally {
    remove();
  }
}

async function verifyCodexSwitch(
  session: Awaited<ReturnType<typeof nodeSession>>,
  versions: Awaited<ReturnType<typeof installCodexVariants>>,
) {
  let current: { epoch: string; synchronized: boolean } | undefined;
  const remove = session.onEvent((event) => {
    if (event.type === 'sync' && event.backendId === 'codex-local') {
      const view = event.updates.find((update: { kind: string }) => update.kind === 'manifest');
      if (view) current = { epoch: view.epoch, synchronized: view.thread.synchronized === true };
    }
  });
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 120 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 80));
    assert(check(), 'Codex did not recover its live subscription after a plugin switch');
  };
  try {
    await session.request('watch', { threadId: THREAD, backendId: 'codex-local' });
    await waitFor(() => current?.synchronized === true);
    for (const [command, version] of [
      ['upgrade', versions.next],
      ['rollback', versions.initial],
    ] as const) {
      const previous = current!.epoch;
      const target = `${versions.name}@${version}`;
      await adapter(command, 'codex-local', ...(command === 'upgrade' ? [target] : []));
      const { stdout } = await adapter('list');
      const rows = JSON.parse(stdout).instances as { instance: string; current: string }[];
      assert.equal(rows.find(({ instance }) => instance === 'codex-local')?.current, target);
      await waitFor(() => current?.synchronized === true && current.epoch !== previous);
      const result = await session.rpc<{ threads: { id: string }[] }>(apiCall('/threads'));
      assert.equal(result.threads[0].id, THREAD);
    }
  } finally {
    remove();
  }
}

async function seedBundledUpgrade() {
  const root = join(state, 'native-plugins');
  const db = new DatabaseSync(join(root, 'registry.sqlite'));
  try {
    const row = db.prepare(`
      SELECT p.key, p.directory, p.manifest FROM bindings b JOIN packages p ON b.current = p.key
      WHERE b.instance = 'codex-local'
    `).get() as { key: string; directory: string; manifest: string };
    const manifest = JSON.parse(row.manifest);
    const old = { ...manifest, version: '0.0.1' };
    const directory = join(state, 'old-official-fixture');
    await mkdir(directory, { mode: 0o700 });
    await copyFile(join(root, 'packages', row.directory, manifest.entry), join(directory, manifest.entry));
    await writeFile(join(directory, 'adapter.json'), JSON.stringify(old));
    await adapter('install', directory);
    const previous = old.name + '@' + old.version;
    db.prepare("UPDATE bindings SET current=?,previous=NULL WHERE instance='codex-local'").run(previous);
    return { current: row.key, previous };
  } finally {
    db.close();
  }
}

async function waitForBundledBinding(current: string, previous: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { stdout } = await adapter('list');
    const binding = JSON.parse(stdout).instances.find(({ instance }: { instance: string }) => instance === 'codex-local');
    if (binding?.current === current && binding.previous === previous) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Bundled Codex binding did not reach ${current} with rollback to ${previous}`);
}

async function installStorageFixture(fixture: string) {
  const directory = join(state, 'storage-fixture');
  await mkdir(directory, { mode: 0o700 });
  const entry = process.platform === 'win32' ? 'fixture.exe' : 'fixture';
  await copyFile(resolve(fixture), join(directory, entry));
  const sha256 = digest(await readFile(join(directory, entry)));
  await writeFile(join(directory, 'adapter.json'), JSON.stringify({
    sdk: 1, name: 'native-storage-fixture', version: '1.0.0', product: 'object-storage',
    stateVersion: 1, entry, sha256,
  }), { mode: 0o600 });
  await adapter('install', directory);
  const config = join(state, 'storage-config.json');
  const profile = join(state, 'transport.env');
  await writeFile(config, '{"token":"fixture-only"}', { mode: 0o600 });
  await writeFile(profile, [
    'POCKET_NATIVE_STORAGE_PLUGIN=native-storage-fixture@1.0.0',
    'POCKET_NATIVE_STORAGE_PLUGIN_CONFIG=' + JSON.stringify(config),
    'POCKET_MEDIA_PREFIX=fixture',
  ].join('\n'), { mode: 0o600 });
  if (process.platform === 'win32') {
    platformRuntime().privateFile(config);
    platformRuntime().privateFile(profile);
  }
}

async function verifyStorageFixture(session: DeviceLink, downloaded: FileManifest) {
  const download = { backendId: 'codex-local', threadId: THREAD, fileId: downloaded.id };
  const { value: plan } = await session.request('file', { ...download, action: 'storage-plan', indices: [0] });
  assert.equal(plan.url, `https://objects.example.org/${plan.objectId}?signed=fixture`);
  const plugin = join(state, 'native-storage-plugin');
  const stored = join(plugin, plan.objectId);
  const encrypted = await readFile(stored);
  assert.equal(encrypted.length, legacyBytes.length + 16);
  assert.deepEqual(Buffer.from(await decryptBlock(downloaded, 0, encrypted)), legacyBytes);
  await session.request('file', { ...download, action: 'storage-done', objectId: plan.objectId });
  assert(!existsSync(stored));
  for (const [index, encoding] of [[1, 'raw'], [2, 'multipart']] as const) {
    const { value } = await session.request('file', {
      ...legacyTransfer, action: 'storage-plan', indices: [index],
    });
    assert.equal(value.upload.encoding, encoding);
    assert.equal(new URL(value.upload.url).origin, 'https://uploads.example.org');
  }
  console.log('Native storage plugin verified encrypted put, signed download, both upload grant types, and cleanup.');
}

try {
  const legacyDesktop = join(directory, 'old-desktop-settings.json');
  if (bundled) {
    const work = join(directory, 'old-working-directory');
    const environment = join(directory, 'old-external.env');
    const instances = join(work, 'configured-instances.json');
    await mkdir(work, { mode: 0o700 });
    await writeFile(environment, 'POCKET_ADAPTERS_FILE=configured-instances.json\n', { mode: 0o600 });
    await writeFile(instances, JSON.stringify([{
      id: 'codex-local', name: 'Migrated Codex fixture', plugin: '@agent-remote/adapter-codex',
    }]), { mode: 0o600 });
    await writeFile(legacyDesktop, JSON.stringify({
      origin, legacyGateway: { environmentFile: environment, workingDirectory: work },
    }), { mode: 0o600 });
    if (process.platform === 'win32') {
      platformRuntime().privateFile(environment);
      platformRuntime().privateFile(instances);
    }
  }
  const importer = () =>
    promisify(execFile)(executable, ['--import-node-state', legacyState, ...(bundled ? [] : ['--origin', origin])], {
      env: {
        ...process.env, POCKET_NATIVE_STATE_DIR: state,
        ...(bundled ? { POCKET_NATIVE_LEGACY_DESKTOP_SETTINGS: legacyDesktop } : {}),
      },
    });
  const supervisor = join(legacyState, 'adapters', 'supervisor.json');
  await mkdir(join(legacyState, 'adapters'), { mode: 0o700 });
  await writeFile(supervisor, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  await assert.rejects(importer(), /监督器记录/);
  assert(!existsSync(state), 'An active legacy gateway created a partial destination');
  await rm(supervisor);
  const identityBefore = await readFile(join(legacyState, 'device-identity-v2.json'));
  const databaseBefore = await readFile(join(legacyState, 'state.sqlite'));
  await importer();
  assert.equal(await readFile(join(state, 'service-origin'), 'utf8'), origin);
  assert.deepEqual(await readFile(join(state, 'device-identity-v2.json')), identityBefore);
  assert.deepEqual(await readFile(join(legacyState, 'state.sqlite')), databaseBefore);
  await assert.rejects(importer(), /目标状态目录已存在/);
  if (storageFixture) await installStorageFixture(storageFixture);
  await verifyTlsClient();
  await relay.listen();
  if (codexPackage && !bundled) {
    const withoutPlugin = await launch(false, { POCKET_NATIVE_CODEX_HOME: codexHome });
    try {
      const session = await reconnect(existingPhone, old.routeTicket);
      try {
        const ready = await session.ready;
        assert.equal(ready.status.reason, '尚未安装 Codex 插件');
        assert.equal(ready.status.writesEnabled, false);
        assert.equal(ready.p2p.enabled, true);
        const { backends } = await session.rpc<{ backends: { id: string }[] }>(apiCall('/backends'));
        assert(!backends.some(({ id }) => id === 'codex-local'), 'Codex opened local history without a plugin');
      } finally {
        session.close();
      }
    } finally {
      await withoutPlugin.stop();
    }
  }
  const versions = codexPackage ? await installCodexVariants(codexPackage) : undefined;
  let gateway = await launch();
  try {
    if (bundled) {
      const { stdout } = await adapter('list');
      const { packages, instances } = JSON.parse(stdout) as {
        packages: string[]; instances: { instance: string; current: string; previous: string | null }[];
      };
      const official = packages.filter((key) => /^@agent-remote\/adapter-(codex|dsh)@/.test(key));
      assert.equal(official.length, 2);
      const [codex, dsh] = official;
      assert(codex.startsWith('@agent-remote/adapter-codex@') && dsh.startsWith('@agent-remote/adapter-dsh@'));
      assert.equal(codex.split('@').at(-1), dsh.split('@').at(-1));
      assert.deepEqual(instances, [{ instance: 'codex-local', current: codex, previous: null }]);
      console.log('Installed desktop adapter automatically registered both official plugins and bound Codex.');
    }
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
    const restoreDraft = apiCall(`/threads/${THREAD}/uploads/${migratedDraftId}/complete`, 'POST');
    assert.deepEqual(await existing.rpc(restoreDraft), {
      id: migratedDraftId, name: legacyName, path: migratedDraftPath,
    });
    for (const path of [migratedDraftPath, migratedNativePath]) {
      const manifest = await existing.rpc<FileManifest>(apiCall(`/threads/${THREAD}/media`, 'POST', { path }));
      if (path === migratedNativePath) {
        assert.equal(manifest.id, migratedNativeId);
        if (storageFixture) await verifyStorageFixture(existing, manifest);
      }
      const bytes = await existing.request('file', {
        backendId: 'codex-local', threadId: THREAD, fileId: manifest.id, action: 'read', index: 0,
      });
      assert.deepEqual(Buffer.from(bytes.bytes!), legacyBytes);
    }
    const importedTransfer = (await existing.request('file', legacyMissing)).value;
    assert.deepEqual(importedTransfer.missing, [1, 2]);
    for (const field of ['id', 'version', 'key', 'nonce'] as const)
      assert.equal(importedTransfer.manifest[field], legacyManifest[field]);
    await existing.request('file', { ...legacyTransfer, action: 'write', index: 1 }, legacyBlocks[1]);
    await assert.rejects(existing.rpc(rawChunk(0), legacyRawBytes.subarray(4, 9)));
    assert.deepEqual(await existing.rpc(rawChunk(4), legacyRawBytes.subarray(4, 9)), { offset: 9 });
    await assert.rejects(existing.rpc(rawFinish));
    const corruptedDraft = Buffer.from(legacyBytes);
    corruptedDraft[0] ^= 1;
    await writeFile(migratedDraftPath, corruptedDraft);
    try {
      await assert.rejects(
        existing.rpc(apiCall(`/threads/${THREAD}/media`, 'POST', { path: migratedDraftPath })),
        { status: 400 },
      );
    } finally {
      await writeFile(migratedDraftPath, legacyBytes);
    }
    const appearancePath = '/backends/codex-local/appearance';
    const getAppearance = (session: typeof existing) =>
      session.rpc<BackendAppearanceDocument>(apiCall(appearancePath));
    const updateAppearance = (revision: number, patch: unknown) =>
      existing.rpc<BackendAppearanceDocument>(apiCall(appearancePath, 'POST', { revision, patch }));
    const importedAppearance = await getAppearance(existing);
    assert.equal(importedAppearance.revision, 1);
    assert.equal(importedAppearance.values.description, '旧版显示说明');
    assert.deepEqual(importedAppearance.values.icon, { kind: 'builtin', value: 'monitor' });
    const changedAppearance = await updateAppearance(1, {
      description: ' Rust 保存的说明 ',
      icon: { kind: 'emoji', value: '👩🏽‍💻' },
    });
    assert.equal(changedAppearance.revision, 2);
    assert.equal(changedAppearance.values.description, 'Rust 保存的说明');
    assert.deepEqual(changedAppearance.values.icon, { kind: 'emoji', value: '👩🏽‍💻' });
    await assert.rejects(updateAppearance(1, { description: '过期修改' }), { status: 409 });
    await assert.rejects(
      existing.rpc(apiCall('/backends/nonexistent/appearance', 'POST', { revision: 0, patch: { name: 'X' } })),
      { status: 404 },
    );
    await assert.rejects(updateAppearance(2, {
      icon: { kind: 'image', value: 'data:image/svg+xml;base64,PHN2Zz4=' },
    }), { status: 400 });
    const png = await readFile('src/web/public/app-icon-32.png');
    const raster = await updateAppearance(2, {
      icon: { kind: 'image', value: 'data:image/png;base64,' + png.toString('base64') },
    });
    assert.equal(raster.revision, 3);
    assert.equal(raster.values.icon.kind, 'image');
    assert.match(raster.values.icon.value, /^data:image\/webp;base64,/);
    const appearanceList = await existing.rpc<{ backends: BackendInfo[] }>(apiCall('/backends'));
    const appearedCodex = appearanceList.backends.find(({ id }) => id === 'codex-local');
    assert.deepEqual(appearedCodex?.appearance, raster.values);
    if (bundled) assert.equal(appearedCodex?.name, 'Migrated Codex fixture');
    const resetAppearance = await updateAppearance(3, { icon: null });
    assert.deepEqual(resetAppearance.values.icon, importedAppearance.defaults.icon);
    const cliAppearance = (...args: string[]) =>
      promisify(execFile)(executable, ['--instance', ...args], {
        env: { ...process.env, POCKET_NATIVE_STATE_DIR: state },
      });
    const { stdout: cliSaved } = await cliAppearance(
      'set', 'codex-local', '--description', '命令行同步说明', '--revision', '4',
    );
    assert.deepEqual(JSON.parse(cliSaved), { id: 'codex-local', revision: 5, saved: true });
    await assert.rejects(updateAppearance(4, { description: '旧网页副本' }), { status: 409 });
    const savedAppearance = await getAppearance(existing);
    assert.equal(savedAppearance.values.description, '命令行同步说明');
    const { stdout: cliCurrent } = await cliAppearance('show', 'codex-local');
    assert.equal(JSON.parse(cliCurrent).overrides.description, savedAppearance.values.description);
    const { stdout: cliList } = await cliAppearance('list');
    assert(JSON.parse(cliList).some((entry: { id: string; revision: number }) =>
      entry.id === 'codex-local' && entry.revision === 5,
    ));
    if (versions) {
      const operation = apiCall(`/operations/${legacyOperation}`);
      await assert.rejects(existing.rpc(operation));
      const prior = await existing.rpc<{ backendId: string; state: string }>({ ...operation, backendId: secondaryId });
      assert.equal(prior.backendId, secondaryId);
      assert.equal(prior.state, 'completed');
    }
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
    await assert.rejects(session.rpc(restoreDraft));
    await assert.rejects(session.request('file', legacyMissing));
    await assert.rejects(session.rpc(rawChunk(9), legacyRawBytes.subarray(9)));
    await assert.rejects(session.rpc(apiCall(`/threads/${THREAD}/media`, 'POST', { path: migratedNativePath })));
    assert.equal(ready.status.writesEnabled, !!ipc);
    assert.equal(ready.status.capabilities.openThread, !!ipc);
    if (versions) {
      const { backends } = await session.rpc<{
        backends: { id: string; name: string; profile: string; adapterVersion?: string }[];
      }>(apiCall('/backends'));
      const codex = backends.find(({ id }) => id === 'codex-local');
      assert.equal(codex?.profile, 'rust-native-plugin');
      assert.equal(codex?.name, 'Codex fixture');
      assert.equal(codex?.adapterVersion, versions.initial);
    }
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
      messages: {
        id: string;
        text: string;
        deferred?: boolean;
        truncated: boolean;
        attachments: { path: string }[];
      }[];
    }>(apiCall(`/threads/${THREAD}/history`));
    assert.deepEqual(history.messages.map(({ text }) => text).filter(Boolean), [
      '历史消息',
      '命令 · printf historical tool · completed',
      Buffer.from(historicalReply).subarray(0, 12_000).toString(),
    ]);
    assert.equal(history.messages[0].attachments[0].path, legacyPath);
    const historicalActivity = history.messages[1];
    assert.equal(historicalActivity.deferred, true);
    const historicalDetails = await session.rpc<{ message: Record<string, unknown> }>(
      apiCall(`/threads/${THREAD}/content?messageId=${historicalActivity.id}`),
    );
    assert.equal(historicalDetails.message.output, 'historical output');
    assert.equal(historicalDetails.message.deferred, false);
    const earlierReply = history.messages.at(-1)!;
    assert.equal(earlierReply.truncated, true);
    const historic = await session.rpc<{ message: { text: string } }>(
      apiCall(`/threads/${THREAD}/content?messageId=${earlierReply.id}`),
    );
    assert.equal(historic.message.text, historicalReply);
    assert.equal(earlierReply.attachments[0].path, inlineRef);
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
    const completeOldDraft = apiCall(`/threads/${THREAD}/uploads/${legacyId}/complete`, 'POST');
    assert.deepEqual(await session.rpc(completeOldDraft), {
      id: legacyId, name: legacyName, path: legacyPath,
    });
    await assert.rejects(session.rpc(apiCall(`/threads/${FORK_REPLY}/uploads/${legacyId}/complete`, 'POST')));
    const describe = (path: string) =>
      session.rpc<FileManifest>(apiCall(`/threads/${THREAD}/media`, 'POST', { path }));
    await assert.rejects(describe(unpaired), /没有可恢复的数据/);
    for (const [path, expected, mime] of [
      [legacyPath, legacyBytes],
      [inlineRef, inlineBytes],
      [projectFile, Buffer.from('project attachment')],
      [`sandbox:./${projectPdf}`, pdfBytes, 'application/pdf'],
      [`sandbox:./${projectPng}`, pngBytes, 'image/png'],
      [outsidePng, pngBytes, 'image/png'],
      ...viewed.map(({ path, bytes }) => [path, bytes] as const),
    ] as const) {
      const manifest = await describe(path);
      if (mime) assert.equal(manifest.mime, mime);
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
        if (path === legacyPath) {
          await assert.rejects(other.rpc(apiCall(`/threads/${THREAD}/media`, 'POST', { path })));
          await assert.rejects(other.rpc(completeOldDraft));
        }
      } finally {
        other.close();
      }
    }
    await assert.rejects(describe(unrelatedFile));
    await assert.rejects(session.rpc(apiCall(`/threads/${THREAD}/messages`, 'POST', { text: 'blocked' })));
    if (versions) await verifyCodexInstances(session, ready.device.id);
    if (ipc) {
      await testLive(session, ipc, phone);
      if (versions && secondaryIpc) await verifyLiveCodexInstances(session, ipc, secondaryIpc, versions);
    }
    session.close();
    await assert.rejects(pair(), 'Pairing code was not single-use');

    await gateway.stop();
    gateway = await launch(true);
    const resumedLegacy = await reconnect(existingPhone, old.routeTicket);
    assert.deepEqual((await resumedLegacy.request('file', legacyMissing)).value.missing, [2]);
    await resumedLegacy.request('file', { ...legacyTransfer, action: 'write', index: 2 }, legacyBlocks[2]);
    const blockResult = await resumedLegacy.request('file', { ...legacyTransfer, action: 'finish' });
    assert.deepEqual(await readFile(blockResult.value.path), legacyBlockBytes);
    assert.deepEqual(await resumedLegacy.rpc(rawChunk(9), legacyRawBytes.subarray(9)), {
      offset: legacyRawBytes.length,
    });
    const rawResult = await resumedLegacy.rpc<{ path: string }>(rawFinish);
    assert.deepEqual(await readFile(rawResult.path), legacyRawBytes);
    assert.deepEqual(await resumedLegacy.rpc(rawFinish), rawResult);
    const recovered = await resumedLegacy.rpc<{ path: string }>(
      apiCall(`/threads/${THREAD}/uploads/${legacyRenamedUpload.id}/complete`, 'POST'),
    );
    assert.deepEqual(await readFile(recovered.path), legacyRawBytes);
    assert.deepEqual(await Promise.all(legacyUploadSources.map((path) => readFile(path))), legacyUploadSnapshots);
    resumedLegacy.close();
    const resumed = await reconnect(phone, ready.ticket);
    assert.equal((await resumed.ready).device.id, ready.device.id);
    assert.equal((await resumed.rpc<{ path: string }>(completeOldDraft)).path, legacyPath);
    assert.deepEqual(await getAppearance(resumed), savedAppearance);
    await cliAppearance('reset', 'codex-local', '--revision', '5');
    const restored = await getAppearance(resumed);
    assert.equal(restored.revision, 6);
    assert.deepEqual(restored.overrides, {});
    assert.deepEqual(restored.values, restored.defaults);
    resumed.close();
    if (bundled) {
      await gateway.stop();
      const { current, previous } = await seedBundledUpgrade();
      gateway = await launch(true);
      await waitForBundledBinding(current, previous);
      await adapter('rollback', 'codex-local');
      await waitForBundledBinding(previous, current);
      await gateway.stop();
      gateway = await launch(true);
      await waitForBundledBinding(previous, current);
      console.log('The bundled Codex upgrade used the plugin supervisor and a rollback survived restart.');
    }
  } finally {
    await gateway.stop();
  }
  console.log(
    `Native gateway (${cloudflare ? 'Cloudflare' : 'Node'} relay): TLS startup, pairing, history, legacy draft recovery and upload resumption, replay rejection, appearance settings and restart passed${ipc ? ', including native Codex live controls' : ''}${versions ? ' with two isolated instances of the independently installed Codex plugin' : ''}.`,
  );
} finally {
  await relay.close();
  await secondaryIpc?.close();
  await ipc?.close();
  await rm(directory, { recursive: true, force: true });
}
