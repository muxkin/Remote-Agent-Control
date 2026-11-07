import { expect, it } from 'vitest';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { buildRelay } from '../src/server/relay.js';
import { Store } from '../src/server/store.js';
import { HostService } from '../src/server/host-service.js';
import { BackendRegistry } from '../src/server/backends/registry.js';
import { DesktopAdapter } from '../packages/adapter-codex/src/desktop.js';
import { HistoryIndex } from '../packages/adapter-codex/src/history.js';
import { CodexBackend } from '../packages/adapter-codex/src/backend.js';
import { fixtureConfig, historyFixture, FakeTransport } from './helpers.js';
import { temporaryRuntime } from './temporary-runtime.js';
import { createIdentity } from '../src/shared/secure-channel.js';
import { nodeSession } from '../src/client/node-session.js';
import { AccountClient } from '../src/client/account.js';
import { apiCall } from '../src/shared/rpc.js';
import { DEFAULT_BACKEND } from '../src/shared/backends.js';

it('restores a paired Codex on a second device using only account login and the encrypted cloud record', async () => {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((r) => socket.close(() => r()));
  const config = fixtureConfig();
  historyFixture(config);
  config.origin = `http://127.0.0.1:${port}`;
  config.p2p = { enabled: false, stunUrls: [] };
  config.relay = { origin: config.origin, enrollment: 'account-workspace-fixture-enrollment-key' };
  const relay = await buildRelay({
    origin: config.origin,
    webRoot: config.webRoot,
    assetOrigin: null,
    uploadOrigins: [],
    enrollmentSecret: config.relay.enrollment,
  });
  await relay.app.listen({ host: '127.0.0.1', port });
  const store = new Store(config.stateDir, temporaryRuntime);
  const registry = new BackendRegistry().register(
    new CodexBackend(
      config,
      new DesktopAdapter(config, () => new FakeTransport()),
      new HistoryIndex(config.codexHome),
    ),
  );
  const hostIdentity = await createIdentity(),
    host = new HostService(config, hostIdentity, { store, registry });
  const links: Awaited<ReturnType<typeof nodeSession>>[] = [];
  const account = () => {
    let cookie = '';
    return new AccountClient(async <T>(path: string, method = 'GET', body?: unknown) => {
      const res = await relay.app.inject({
        method: method as 'GET',
        url: `/api/im${path}`,
        headers: { host: `127.0.0.1:${port}`, origin: config.origin, cookie },
        payload: body as object,
      });
      if (res.cookies.length) cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      if (res.statusCode >= 400) throw Error(res.json().error);
      return res.json() as T;
    });
  };
  try {
    await registry.start();
    host.start();
    const first = account();
    await first.register('workspaceowner', 'Owner', 'workspace-owner-password');
    const pairing = store.mintPairing(),
      phone = await createIdentity();
    const link = await nodeSession(
      config.origin,
      hostIdentity.peerId,
      phone,
      createHash('sha256').update(pairing.code).digest('hex'),
      { type: 'pair', protocol: 2, sessionId: randomUUID(), code: pairing.code, name: 'Account owner' },
    );
    links.push(link);
    const ready = await link.ready;
    await first.writeItem(`host:${hostIdentity.peerId}`, {
      hostId: hostIdentity.peerId,
      ticket: ready.ticket,
      identity: { ...phone, privateKey: Array.from(phone.privateKey) },
    });
    link.close();
    const second = account();
    await second.login('workspaceowner', 'workspace-owner-password');
    const restored = await second.readItem<any>(`host:${hostIdentity.peerId}`);
    const next = await nodeSession(
      config.origin,
      restored.hostId,
      { ...restored.identity, privateKey: new Uint8Array(restored.identity.privateKey) },
      restored.ticket,
      { type: 'authenticate', protocol: 2, sessionId: randomUUID() },
    );
    links.push(next);
    await next.ready;
    const response = await next.request('rpc', { call: apiCall('/backends') });
    expect(response.value.backends[0].id).toBe(DEFAULT_BACKEND);
  } finally {
    for (const link of links) link.close();
    host.stop();
    registry.stop();
    store.close();
    await relay.app.close();
    rmSync(config.desktopRoot, { recursive: true, force: true });
  }
});
