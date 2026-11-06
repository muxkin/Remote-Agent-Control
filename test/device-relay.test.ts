import { temporaryRuntime } from './temporary-runtime.js';
import { BackendRegistry } from '../src/server/backends/registry.js';
import { CodexBackend } from '../packages/adapter-codex/src/backend.js';
import { DshBackend } from '../packages/adapter-dsh/src/backend.js';
import { DshFixtureConnection } from '../packages/adapter-dsh/test/fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { RTCPeerConnection } from 'werift';
import { buildRelay } from '../src/server/relay.js';
import { HostService } from '../src/server/host-service.js';
import { Store } from '../src/server/store.js';
import { DesktopAdapter } from '../packages/adapter-codex/src/desktop.js';
import { HistoryIndex } from '../packages/adapter-codex/src/history.js';
import {
  CipherWire,
  SecureChannel,
  createIdentity,
  type Identity,
  type Lane,
} from '../src/shared/secure-channel.js';
import { DeviceLink } from '../src/shared/device-link.js';
import { apiCall } from '../src/shared/rpc.js';
import { applySync, checkpoint } from '../src/shared/sync.js';
import { FakeTransport, fixtureConfig, historyFixture, THREAD, TURN } from './helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function port() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const n = (socket.address() as any).port;
  await new Promise<void>((r) => socket.close(() => r()));
  return n;
}
async function setup(direct = false, multiple = false) {
  const config = fixtureConfig();
  historyFixture(config);
  config.port = await port();
  config.origin = `http://127.0.0.1:${config.port}`;
  config.p2p = { enabled: direct, stunUrls: [] };
  config.relay = { origin: config.origin, enrollment: 'fixture-enrollment-secret-32-characters' };
  const store = new Store(config.stateDir, temporaryRuntime),
    history = new HistoryIndex(config.codexHome);
  const transport = new FakeTransport(),
    desktop = new DesktopAdapter(config, () => transport);
  const identity = await createIdentity();
  const relay = await buildRelay({
    origin: config.origin,
    webRoot: config.webRoot,
    assetOrigin: null,
    uploadOrigins: [],
    enrollmentSecret: config.relay.enrollment,
  });
  await relay.app.listen({ host: '127.0.0.1', port: config.port });
  const pairing = store.mintPairing();
  const registry = new BackendRegistry().register(new CodexBackend(config, desktop, history));
  if (multiple)
    for (const id of ['dsh-one', 'dsh-two'])
      registry.register(
        new DshBackend(
          { id, name: id, url: 'http://127.0.0.1:7777', token: 'fixture', version: '0.2.1-rc.5' },
          join(config.stateDir, id),
          false,
          new DshFixtureConnection(THREAD, id),
        ),
      );
  const host = new HostService(config, identity, { store, registry });
  cleanups.push(async () => {
    host.stop();
    registry.stop();
    store.close();
    await relay.app.close();
    rmSync(config.desktopRoot, { recursive: true, force: true });
  });
  await registry.start();
  host.start();
  // Wait for host registration without opening any unencrypted business API.
  await new Promise((resolve) => setTimeout(resolve, 80));
  return { config, store, host, pairing, relay, transport, identity, desktop, registry };
}

/** Real RTC transport; the business suite below is identical for both paths. */
async function directLink(relay: DeviceLink, phone: Identity, hostId: string, sessionId: string) {
  const pc = new RTCPeerConnection({ iceServers: [], maxMessageSize: 65536 });
  cleanups.push(() => pc.close());
  const dc = pc.createDataChannel('pocket-control-v2', { ordered: true });
  const wire = new CipherWire(
    async (bytes) => {
      dc.send(Buffer.from(bytes));
    },
    () => dc.close(),
  );
  const opened = new Promise<void>((resolve) => {
    dc.onopen = () => resolve();
  });
  dc.onmessage = ({ data }) => {
    if (typeof data !== 'string') wire.onData(data);
  };
  dc.onclose = () => wire.onTransportClosed();
  await pc.setLocalDescription(await pc.createOffer());
  const { value: answer } = await relay.request('offer', { sdp: pc.localDescription!.sdp });
  await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  await opened;
  const channel = await SecureChannel.open(wire, phone, true, 'control', hostId);
  const link = await DeviceLink.authenticate(channel, { type: 'authenticate', protocol: 2, sessionId });
  return { link, close: () => pc.close() };
}
async function connect(
  origin: string,
  hostId: string,
  phone: Identity,
  ticket: string,
  auth: any,
  lane: Lane = 'control',
) {
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/connect', { headers: { Origin: origin } });
  let joined!: () => void, failed!: (error: Error) => void;
  const ready = new Promise<void>((r, j) => {
    joined = r;
    failed = j;
  });
  const wire = new CipherWire(
    (bytes) => new Promise<void>((r, j) => socket.send(bytes, (e) => (e ? j(e) : r()))),
    () => socket.close(),
  );
  socket.on('message', (data, binary) => {
    if (binary) wire.onData(new Uint8Array(data as Buffer));
    else {
      const message = JSON.parse(data.toString());
      if (message.type === 'challenge') socket.send(JSON.stringify({ type: 'join', hostId, lane, ticket }));
      else if (message.type === 'joined') joined();
    }
  });
  socket.on('error', failed);
  socket.on('close', () => {
    wire.onTransportClosed();
    failed(Error('Relay rejected connection'));
  });
  cleanups.push(() => socket.terminate());
  await ready;
  const channel = await SecureChannel.open(wire, phone, true, lane, hostId);
  return DeviceLink.authenticate(channel, auth);
}
describe('device relay and shared business dispatcher', () => {
  it('notifies a late subscriber when a just-authenticated link has closed', async () => {
    const { config, pairing, identity } = await setup();
    const link = await connect(
      config.origin,
      identity.peerId,
      await createIdentity(),
      createHash('sha256').update(pairing.code).digest('hex'),
      { type: 'pair', protocol: 2, sessionId: crypto.randomUUID(), code: pairing.code, name: 'late-close' },
    );
    link.close();
    await vi.waitFor(() => expect(link.closed).toBe(true));
    const closed = vi.fn();
    link.onClose(closed);
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
  });

  it.each(['relay', 'direct', 'switch'] as const)(
    'preserves the complete business contract over %s',
    async (path) => {
      const { config, pairing, identity, desktop, store, host } = await setup(path !== 'relay');
      // Native behavior is covered by desktop/operations suites; here verify validation,
      // arguments, durable receipts and deduplication through each encrypted network path.
      const realStatus = desktop.status.bind(desktop);
      vi.spyOn(desktop, 'status').mockImplementation(() => {
        const status = realStatus();
        return { ...status, capabilities: { ...status.capabilities, newThread: true } };
      });
      const control = vi.spyOn(desktop, 'control').mockResolvedValue(TURN);
      const projects = vi.spyOn(desktop, 'projects').mockResolvedValue([]);
      writeFileSync(
        join(config.codexHome, 'models_cache.codex_work_desktop.json'),
        JSON.stringify({
          models: [
            { slug: 'desktop-model', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] },
          ],
        }),
      );
      const phone = await createIdentity(),
        sessionId = crypto.randomUUID();
      const relay = await connect(
        config.origin,
        identity.peerId,
        phone,
        createHash('sha256').update(pairing.code).digest('hex'),
        { type: 'pair', protocol: 2, sessionId, code: pairing.code, name: 'contract-phone' },
      );
      const direct =
        path === 'relay' ? undefined : await directLink(relay, phone, identity.peerId, sessionId);
      let active = direct?.link ?? relay;
      expect((await active.ready).status).not.toHaveProperty('webBuildId');
      expect(await active.rpc(apiCall('/status'))).not.toHaveProperty('webBuildId');
      expect((await active.rpc<any>(apiCall('/projects'))).total).toBe(1);
      expect((await active.rpc<any>(apiCall(`/threads/${THREAD}/history`))).thread.id).toBe(THREAD);
      expect((await active.rpc<any>(apiCall(`/threads/${THREAD}/projects`))).projects).toEqual([]);
      expect(projects).toHaveBeenCalledOnce();
      await expect(active.rpc({ method: 'arbitrary', params: {}, query: {} } as any)).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        active.rpc(
          apiCall(`/threads/${THREAD}/messages`, 'POST', {
            requestId: crypto.randomUUID(),
            text: 'fixture',
            model: 'unexpected-override',
          }),
        ),
      ).rejects.toMatchObject({ status: 400 });
      const device = (await active.ready).device.id;
      const bytes = Buffer.from('attachment for active turn');
      const spec = {
        name: 'notes.txt',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      const upload = await host.core.uploads.begin(spec, device, THREAD);
      await host.core.uploads.chunk(upload.id, device, THREAD, 0, bytes);
      await host.core.uploads.finish(upload.id, device, THREAD);
      for (const [owner, thread] of [
        ['another-device', THREAD],
        [device, crypto.randomUUID()],
      ]) {
        const other = await host.core.uploads.begin(spec, owner, thread);
        await host.core.uploads.chunk(other.id, owner, thread, 0, bytes);
        await host.core.uploads.finish(other.id, owner, thread);
        await expect(
          active.rpc(
            apiCall(`/threads/${THREAD}/steer`, 'POST', {
              requestId: crypto.randomUUID(),
              expectedTurnId: TURN,
              text: '',
              uploadIds: [other.id],
            }),
          ),
        ).rejects.toThrow();
      }
      expect(control).not.toHaveBeenCalled();
      const writes = [
        ['messages', { text: 'fixture' }, 'send'],
        ['steer', { text: 'fixture', expectedTurnId: TURN }, 'steer'],
        ['steer', { text: '', expectedTurnId: TURN, uploadIds: [upload.id] }, 'steer'],
        ['interrupt', { expectedTurnId: TURN }, 'interrupt'],
        ['responses', { targetRequestId: 'approval', expectedTurnId: TURN, decision: 'decline' }, 'respond'],
        [
          'responses',
          { targetRequestId: 'question', expectedTurnId: TURN, answers: { color: ['blue'] } },
          'respond',
        ],
        ['queue', { text: 'queued', expectedQueueFingerprint: 'a'.repeat(64) }, 'queue'],
        [
          'queue-remove',
          { messageId: crypto.randomUUID(), expectedQueueFingerprint: 'b'.repeat(64) },
          'queue-remove',
        ],
        [
          'settings',
          { model: 'desktop-model', effort: 'low', expectedModel: 'desktop-model', expectedEffort: null },
          'settings',
        ],
        ['create', { prompt: 'fixture without a title' }, 'create'],
      ] as const;
      for (const [route, body, kind] of writes) {
        const requestId = crypto.randomUUID();
        const call = apiCall(`/threads/${THREAD}/${route}`, 'POST', { requestId, ...body });
        await active.rpc(call);
        const expected =
          kind === 'interrupt' ? 'interrupted' : ['send', 'steer'].includes(kind) ? 'accepted' : 'completed';
        await expect.poll(() => store.operation(requestId)?.state).toBe(expected);
        expect(control.mock.calls.at(-1)).toMatchObject([THREAD, kind, expect.any(String), requestId]);
        if ('uploadIds' in body) {
          expect(JSON.parse(control.mock.calls.at(-1)![2])).toMatchObject({
            text: '',
            attachments: [{ name: 'notes.txt', path: expect.stringContaining(upload.id) }],
          });
        }
        const count = control.mock.calls.length;
        if (path === 'switch' && route === 'messages') {
          await direct!.close();
          active = relay;
        }
        // Same ID, including a result lookup after path migration, must never dispatch again.
        expect(await active.rpc(apiCall(`/operations/${requestId}`))).toMatchObject({
          id: requestId,
          state: expected,
        });
        await active.rpc(call);
        expect(control).toHaveBeenCalledTimes(count);
      }
      expect(control).toHaveBeenCalledTimes(writes.length);
      expect(host.metrics.connections).toBe(1);
      active.close();
      relay.close();
    },
    30000,
  );
  it('pairs inside Noise, reuses a device session and resumes a cached chat without resending content', async () => {
    const { config, host, pairing, identity, relay, store } = await setup();
    const phone = await createIdentity(),
      sessionId = crypto.randomUUID();
    const link = await connect(
      config.origin,
      identity.peerId,
      phone,
      createHash('sha256').update(pairing.code).digest('hex'),
      { type: 'pair', protocol: 2, sessionId, code: pairing.code, name: 'phone' },
    );
    const ready = await link.ready;
    expect(ready.status.connected).toBe(true);
    expect((await link.rpc<any>(apiCall('/projects'))).total).toBe(1);
    expect(
      (await relay.app.inject({ url: '/api/projects', headers: { host: new URL(config.origin).host } }))
        .statusCode,
    ).toBe(404);
    const events: any[] = [];
    link.onEvent((event) => events.push(event));
    await link.request('watch', { threadId: THREAD });
    await expect.poll(() => events.filter((e) => e.type === 'sync').length).toBeGreaterThan(0);
    const first = events.find((e) => e.type === 'sync');
    const cache = first.updates.reduce((old: any, update: any) => applySync(old, update), null);
    await link.request('unwatch', { threadId: THREAD });
    events.length = 0;
    await link.request('watch', { threadId: THREAD, known: checkpoint(cache) });
    await expect.poll(() => events.filter((e) => e.type === 'sync').length).toBeGreaterThan(0);
    expect(events.find((e) => e.type === 'sync').updates[0].changed).toEqual([]);
    expect(host.metrics.connections).toBe(1);
    expect(store.peer(phone.peerId)?.id).toBe(ready.device.id);
    link.close();
  });
  it('rejects reusing a pairing secret and a revoked device ticket', async () => {
    const { config, pairing, identity, store, host } = await setup();
    const phone = await createIdentity(),
      sessionId = crypto.randomUUID();
    const ticket = createHash('sha256').update(pairing.code).digest('hex');
    const link = await connect(config.origin, identity.peerId, phone, ticket, {
      type: 'pair',
      protocol: 2,
      sessionId,
      code: pairing.code,
      name: 'phone',
    });
    const ready = await link.ready;
    expect(store.pair(pairing.code, 'replay')).toBeNull();
    store.revoke(ready.device.id);
    await expect(link.rpc(apiCall('/projects'))).rejects.toThrow();
  });
  it('deduplicates a write across a reconnect with the original operation ID', async () => {
    const { config, pairing, identity, store, transport } = await setup();
    const phone = await createIdentity(),
      sessionId = crypto.randomUUID();
    const first = await connect(
      config.origin,
      identity.peerId,
      phone,
      createHash('sha256').update(pairing.code).digest('hex'),
      { type: 'pair', protocol: 2, sessionId, code: pairing.code, name: 'phone' },
    );
    const ready = await first.ready;
    const requestId = crypto.randomUUID(),
      call = apiCall(`/threads/${THREAD}/messages`, 'POST', { requestId, text: 'single-delivery-marker' });
    await first.rpc(call);
    await expect.poll(() => store.operation(requestId)?.state).toBe('accepted');
    const count = transport.calls.length;
    first.close();
    const second = await connect(config.origin, identity.peerId, phone, ready.ticket, {
      type: 'authenticate',
      protocol: 2,
      sessionId,
    });
    await second.rpc(call);
    expect(transport.calls.length).toBe(count);
    expect(await second.rpc<any>(apiCall(`/operations/${requestId}`))).toMatchObject({
      id: requestId,
      state: 'accepted',
    });
    await expect(
      second.rpc(apiCall(`/threads/${THREAD}/messages`, 'POST', { requestId, text: 'changed-body' })),
    ).rejects.toMatchObject({ status: 409 });
    second.close();
  });
});

it('routes Codex and two DSH instances with colliding native conversation and request IDs over Noise', async () => {
  const { config, identity, pairing, host, store, registry } = await setup(false, true);
  const phone = await createIdentity();
  const link = await connect(
    config.origin,
    identity.peerId,
    phone,
    createHash('sha256').update(pairing.code).digest('hex'),
    { type: 'pair', protocol: 2, sessionId: crypto.randomUUID(), code: pairing.code, name: 'phone' },
  );
  const events: any[] = [];
  link.onEvent((event) => events.push(event));
  const backends = await link.rpc<any>(apiCall('/backends'));
  expect(backends.backends.map((b: any) => b.id)).toEqual(['codex-local', 'dsh-one', 'dsh-two']);
  expect(JSON.stringify(backends)).not.toContain('fixture');
  expect(JSON.stringify(backends)).not.toContain('127.0.0.1');
  const id = crypto.randomUUID();
  for (const backendId of ['codex-local', 'dsh-one', 'dsh-two']) {
    const listed = await link.rpc<any>({ ...apiCall('/threads'), backendId });
    expect(listed.threads[0].id).toBe(THREAD);
    await link.request('watch', { threadId: THREAD, backendId });
    await expect.poll(() => events.some((e) => e.type === 'sync' && e.backendId === backendId)).toBe(true);
    if (backendId !== 'codex-local') {
      const call = {
        ...apiCall(`/threads/${THREAD}/messages`, 'POST', { requestId: id, text: backendId }),
        backendId,
      };
      await link.rpc(call);
      await link.rpc(call);
      await expect.poll(() => store.operation(id, undefined, backendId)?.state).toBe('accepted');
    }
  }
  expect(store.operation(id)).toBeNull();
  const original = await link.rpc<any>(apiCall(`/threads/${THREAD}`));
  expect(original.thread.title).toBe('测试会话');
  const first = await link.rpc<any>({ ...apiCall(`/threads/${THREAD}/history`), backendId: 'dsh-one' });
  expect(first.thread.title).toBe('dsh-one');
  const second = await link.rpc<any>({ ...apiCall(`/threads/${THREAD}/history`), backendId: 'dsh-two' });
  expect(second.thread.title).toBe('dsh-two');
  const checksum = createHash('sha256').update('x').digest('hex');
  const spec = { name: 'isolated.txt', size: 1, sha256: checksum, hashes: [checksum] };
  const file = await link.rpc<any>({
    ...apiCall(`/threads/${THREAD}/uploads`, 'POST', spec),
    backendId: 'dsh-one',
  });
  await expect(
    link.request('file', { action: 'missing', threadId: THREAD, fileId: file.id, backendId: 'dsh-two' }),
  ).rejects.toThrow();
  await expect(link.rpc({ ...apiCall('/threads'), backendId: 'missing' })).rejects.toMatchObject({
    status: 404,
  });
  expect(host.metrics.connections).toBe(1);
  registry.get('dsh-one').stop();
  const status = await link.rpc<any>(apiCall('/backends'));
  expect(status.backends.find((b: any) => b.id === 'dsh-one').connected).toBe(false);
  expect(status.backends.find((b: any) => b.id === 'dsh-two').connected).toBe(true);
  expect((await link.rpc<any>({ ...apiCall('/threads'), backendId: 'dsh-two' })).threads[0].title).toBe(
    'dsh-two',
  );
  expect((await link.rpc<any>(apiCall('/threads'))).threads[0].title).toBe('测试会话');
  link.close();
});
