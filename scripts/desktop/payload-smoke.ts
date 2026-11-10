import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { on, once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildRelay } from '../../src/server/relay.js';

// Use an isolated state directory and a temporary relay. No real Agent or account is used.
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const address = probe.address();
assert(address && typeof address !== 'string');
await new Promise<void>((done) => probe.close(() => done()));
const origin = `http://127.0.0.1:${address.port}`;
const enrollment = randomBytes(32).toString('hex');
const root = resolve(process.argv[2] ?? 'dist/desktop-payload');
const state = await mkdtemp(join(tmpdir(), 'agent-space-desktop-'));
const relay = await buildRelay({
  origin,
  enrollmentSecret: enrollment,
  webRoot: join(state, 'no-web'),
  assetOrigin: null,
  uploadOrigins: [],
});
try {
  await relay.app.listen({ host: '127.0.0.1', port: address.port });
  const child = spawn(
    join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
    ['--import', './scripts/env.mjs', join(root, 'dist/server/main.js')],
    {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([k]) => !/^(POCKET_|CODEX_|NODE_)/i.test(k)),
        ),
        POCKET_ENV_FILE: devNull,
        POCKET_STATE_DIR: state,
        POCKET_PUBLIC_ORIGIN: origin,
        POCKET_RELAY_ENROLLMENT: enrollment,
        POCKET_DESKTOP_MANAGED: '1',
        POCKET_P2P: '0',
        POCKET_CODEX_ROOT: join(state, 'no-desktop'),
        CODEX_HOME: join(state, 'no-codex-home'),
        POCKET_PYTHON: join(root, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
      },
    },
  );
  const exited = once(child, 'close');
  // Handle an early spawn failure even if no status message was received.
  void exited.catch(() => {});
  const deadline = setTimeout(() => child.kill(), 60000);
  try {
    let request: string | undefined;
    let paired = false;
    for await (const [message] of on(child, 'message', { close: ['close'] })) {
      if (message.type === 'desktop-status' && message.relayConnected && !request) {
        assert(message.agents.some((agent: { name: string }) => agent.name === 'Codex'));
        request = randomUUID();
        child.send({ type: 'desktop-pair', id: request });
      } else if (request && message.id === request) {
        assert(!message.error, message.error);
        assert.match(message.value.image, /^data:image\/png;base64,/);
        assert(message.value.expiresAt > Date.now());
        paired = true;
        break;
      }
    }
    assert(paired, 'Gateway exited before accepting a desktop pairing request');
    const registry = JSON.parse(await readFile(join(state, 'adapters/registry.json'), 'utf8'));
    for (const product of ['codex', 'dsh'])
      assert(
        Object.keys(registry.packages).some((key) => key.startsWith(`@agent-remote/adapter-${product}@`)),
      );
    child.send({ type: 'desktop-stop' });
    assert.equal((await exited)[0], 0);
    console.log(
      'Desktop payload: official adapters unpacked, relay registered, QR generated and gateway stopped.',
    );
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null && child.pid) child.kill();
    await exited.catch(() => {});
  }
} finally {
  await relay.app.close();
  await rm(state, { recursive: true, force: true });
}
