import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { WebSocketServer } from 'ws';
import { nodeSession } from '../../src/client/node-session.js';
import { buildRelay } from '../../src/server/relay.js';
import { apiCall } from '../../src/shared/rpc.js';
import { createIdentity } from '../../src/shared/secure-channel.js';

const state = await mkdtemp(join(tmpdir(), 'native-dsh-smoke-'));
const token = randomBytes(16).toString('hex');
const dsh = createServer(async (request, response) => {
  const path = new URL(request.url!, 'http://localhost');
  if (path.pathname === '/connect' && path.searchParams.get('token') === token) {
    response.writeHead(302, { Location: '/api/remote.mux', 'Set-Cookie': 'session=fixture' }).end();
  } else if (path.pathname === '/api/session/list' && request.headers.cookie === 'session=fixture') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(rpc.method, 'session/list');
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        type: 'server-response',
        rpcId: rpc.rpcId,
        result: {
          ok: true,
          value: {
            items: [
              { sessionId: 'shared', updatedAt: 123, projections: { values: { title: 'DSH fixture' } } },
            ],
          },
        },
      }),
    );
  } else response.writeHead(404).end();
});
const dshSocket = new WebSocketServer({ server: dsh, path: '/api/remote.mux' });
dshSocket.on('connection', (socket, request) => {
  assert.equal(request.headers.cookie, 'session=fixture');
  socket.on('message', (buffer) => {
    const frame = JSON.parse(buffer.toString());
    if (frame.type !== 'open') return;
    assert.equal(frame.endpoint, 'session/follow');
    assert.deepEqual(frame.payload.args.request.address, { kind: 'session', sessionId: 'shared' });
    socket.send(
      JSON.stringify({
        type: 'item',
        streamId: frame.streamId,
        value: {
          type: 'snapshot',
          header: { id: 'shared', version: 4, cwd: '/fixture', createdAt: 123 },
          projections: { values: { title: 'DSH fixture' } },
          cursor: 1,
          hasMore: false,
          records: [
            {
              event: {
                seq: 1,
                type: 'assistant/message',
                data: {
                  message: {
                    id: 'reply',
                    role: 'assistant',
                    content: [{ type: 'text', text: 'Rust DSH history' }],
                  },
                },
              },
            },
          ],
        },
      }),
    );
  });
});
const port = createServer().listen(0, '127.0.0.1');
await once(port, 'listening');
const address = port.address();
assert(address && typeof address !== 'string');
await new Promise<void>((done) => port.close(() => done()));
const origin = 'http://127.0.0.1:' + address.port;
const enrollment = randomBytes(32).toString('hex');
const relay = await buildRelay({
  origin,
  enrollmentSecret: enrollment,
  webRoot: join(state, 'no-web'),
  assetOrigin: null,
  uploadOrigins: [],
});
let child: ReturnType<typeof spawn> | undefined;
try {
  dsh.listen(0, '127.0.0.1');
  await once(dsh, 'listening');
  const carrier = dsh.address();
  assert(carrier && typeof carrier !== 'string');
  await writeFile(
    join(state, 'instances.json'),
    JSON.stringify(
      ['dsh-one', 'dsh-two'].map((id) => ({
        id,
        name: id,
        plugin: '@agent-remote/adapter-dsh',
        config: { url: 'http://127.0.0.1:' + carrier.port },
        secrets: { token: 'RUST_DSH_TEST_TOKEN' },
      })),
    ),
    { mode: 0o600 },
  );
  await relay.app.listen({ host: '127.0.0.1', port: address.port });
  child = spawn(resolve(process.argv[2]), ['--headless', '--print-pair'], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(POCKET_|CODEX_)/i.test(key))),
      CODEX_HOME: join(state, 'no-codex'),
      POCKET_NATIVE_STATE_DIR: state,
      POCKET_NATIVE_ORIGIN: origin,
      POCKET_NATIVE_ENROLLMENT: enrollment,
      POCKET_NATIVE_P2P: '0',
      RUST_DSH_TEST_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(child, 'close');
  const lines = createInterface({ input: child.stdout! });
  const timeout = setTimeout(() => child?.kill(), 30_000);
  try {
    let link;
    for await (const line of lines) {
      if (line.startsWith(origin)) {
        link = new URL(line);
        break;
      }
    }
    assert(link);
    const params = new URLSearchParams(link.hash.slice(1));
    const pair = params.get('pair')!;
    const host = params.get('host')!;
    const session = await nodeSession(
      origin,
      host,
      await createIdentity(),
      createHash('sha256').update(pair).digest('hex'),
      {
        type: 'pair',
        protocol: 2,
        sessionId: randomUUID(),
        code: pair,
        name: 'DSH fixture',
      },
    );
    try {
      const { backends } = await session.rpc<{ backends: { id: string; connected: boolean }[] }>(
        apiCall('/backends'),
      );
      assert.deepEqual(
        backends.map(({ id, connected }) => [id, connected]),
        [
          ['dsh-one', true],
          ['dsh-two', true],
        ],
      );
      for (const backendId of ['dsh-one', 'dsh-two']) {
        const rpc = <T>(path: string) => session.rpc<T>({ ...apiCall(path), backendId });
        const threads = await rpc<{ threads: { id: string }[] }>('/threads');
        assert.equal(threads.threads[0].id, 'shared');
        const history = await rpc<{ messages: { text: string }[] }>('/threads/shared/history');
        assert.equal(history.messages[0].text, 'Rust DSH history');
        await assert.rejects(
          session.rpc({ ...apiCall('/threads/shared/messages', 'POST', { text: 'never sent' }), backendId }),
        );
      }
    } finally {
      session.close();
    }
    console.log(
      'Rust DSH: two configured instances, native carrier authentication, list, history and write rejection passed.',
    );
  } finally {
    lines.close();
    clearTimeout(timeout);
    child.kill('SIGINT');
    await exited;
  }
} finally {
  for (const socket of dshSocket.clients) socket.terminate();
  dshSocket.close();
  dsh.close();
  await relay.app.close();
  await rm(state, { recursive: true, force: true });
}
