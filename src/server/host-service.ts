import { DEFAULT_BACKEND, conversationKey } from '../shared/backends.js';
import { BackendRegistry } from './backends/registry.js';
import { resolveBackend, type BackendDependencies } from './backends/resolve.js';
import { conversationId } from './control-schemas.js';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Store } from './store.js';
import { hostIdentity } from './device-identity.js';
import { HostRelay } from './host-relay.js';
import { createGatewayCore } from './gateway-core.js';
import {
  SecureChannel,
  type CipherWire,
  type Identity,
  type Lane,
  type SecurePacket,
} from '../shared/secure-channel.js';
import { RPC_ROUTES, RpcError, type RpcCall } from '../shared/rpc.js';
import { checkpoint, contentVersion, type SyncCheckpoint } from '../shared/sync.js';
import { SyncJournal } from './sync-journal.js';
import type { ThreadView, Operation } from '../shared/types.js';
import { DevicePeer } from './device-peer.js';

type Path = 'relay' | 'direct';
interface Subscription {
  backendId: string;
  threadId: string;
  known?: SyncCheckpoint;
  release?: () => void;
  cancelled: boolean;
  timer?: NodeJS.Timeout;
}
interface Session {
  id: string;
  peerId: string;
  device: { id: string; name: string };
  channels: Map<string, SecureChannel>;
  subscriptions: Map<string, Subscription>;
  peer?: DevicePeer;
  expire?: NodeJS.Timeout;
}
const checkpointSchema = z
  .object({
    epoch: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    versions: z
      .record(z.string().max(500), z.string().regex(/^[a-f0-9]{64}$/))
      .refine((v) => Object.keys(v).length <= 5000),
  })
  .strict();
const idSchema = z.string().uuid();

/** Owns authenticated device sessions independently of individual chats and relay sockets. */
export class HostService {
  readonly core;
  readonly journal = new SyncJournal();
  readonly registry: BackendRegistry;
  private cores = new Map<string, ReturnType<typeof createGatewayCore>>();
  private journals = new Map<string, SyncJournal>();
  private detach: (() => void)[] = [];
  private coreFor(backendId = DEFAULT_BACKEND) {
    this.registry.get(backendId);
    return this.cores.get(backendId)!;
  }
  readonly metrics = { relayBytes: 0, directBytes: 0, resyncs: 0, connections: 0, directConnections: 0 };
  private sessions = new Map<string, Session>();
  private relay?: HostRelay;
  private sweep?: NodeJS.Timeout;
  private readonly onThread = (view: ThreadView, backendId = DEFAULT_BACKEND) => {
    for (const session of this.sessions.values()) {
      const sub = session.subscriptions.get(conversationKey(backendId, view.id));
      if (sub && !sub.cancelled) {
        clearTimeout(sub.timer);
        sub.timer = setTimeout(() => this.publish(session, view, backendId), 60);
      }
    }
  };
  private readonly onStatus = () => {
    for (const backend of this.registry.all())
      for (const session of this.sessions.values())
        this.send(session, {
          type: 'event',
          backendId: backend.id,
          event: { type: 'status', status: this.coreFor(backend.id).status() },
        });
  };
  private readonly onOperation = (operation: Operation) => {
    for (const session of this.sessions.values())
      if (this.deps.store.operation(operation.id, session.device.id, operation.backendId))
        this.send(session, {
          type: 'event',
          backendId: operation.backendId,
          event: { type: 'operation', operation },
        });
  };
  constructor(
    readonly config: Config,
    readonly identity: Identity,
    private deps: { store: Store } & ({ registry: BackendRegistry } | BackendDependencies),
  ) {
    this.registry =
      'registry' in deps ? deps.registry : new BackendRegistry().register(resolveBackend(config, deps));
    for (const backend of this.registry.all()) {
      const core = createGatewayCore(config, { store: deps.store, backend });
      core.router.get('/api/backends', () => ({ backends: this.registry.list() }));
      this.cores.set(backend.id, core);
      this.journals.set(backend.id, backend.id === DEFAULT_BACKEND ? this.journal : new SyncJournal());
      const thread = (view: ThreadView) => this.onThread(view, backend.id);
      backend.on('thread', thread);
      backend.on('status', this.onStatus);
      core.operations.on('operation', this.onOperation);
      this.detach.push(() => {
        backend.off('thread', thread);
        backend.off('status', this.onStatus);
        core.operations.off('operation', this.onOperation);
        core.close();
      });
    }
    this.core = this.coreFor();
  }
  static async create(
    config: Config,
    deps: { store: Store } & ({ registry: BackendRegistry } | BackendDependencies),
  ) {
    return new HostService(config, await hostIdentity(config.stateDir, config.platform), deps);
  }
  start() {
    this.relay = new HostRelay(
      this.config.relay?.origin ?? this.config.origin,
      this.identity,
      this.config.relay?.enrollment ?? '',
      () => this.deps.store.relayRoutes(),
      (wire, lane, ticket) => {
        const route = this.deps.store.relayRoutes().find((r) => r.ticket === ticket);
        if (!route || (lane === 'bulk' && !route.peerId)) {
          void wire.close();
          return;
        }
        void this.accept(wire, lane, 'relay', ticket, route.peerId);
      },
    );
    this.relay.start();
    this.sweep = setInterval(() => {
      for (const session of this.sessions.values())
        if (!this.deps.store.peer(session.peerId)) this.drop(session);
      this.onStatus();
    }, 5000);
    this.sweep.unref();
  }
  private async accept(
    wire: CipherWire,
    lane: Lane,
    path: Path,
    ticket: string,
    peerId?: string,
    expectedSession?: string,
  ) {
    let channel: SecureChannel;
    try {
      channel = await SecureChannel.open(wire, this.identity, false, lane, peerId);
    } catch {
      return;
    }
    let session: Session | undefined,
      started = false;
    const timeout = setTimeout(() => channel.close(), 10000);
    let inFlight = 0;
    const dispatch = async (packet: SecurePacket) => {
      const value = packet.message;
      if (!session) {
        if (started) throw Error('Authentication in progress');
        started = true;
        const parsed = z
          .object({
            type: z.enum(['pair', 'authenticate']),
            protocol: z.literal(2),
            sessionId: idSchema,
            code: z.string().min(20).max(128).optional(),
            name: z.string().trim().min(1).max(80).optional(),
          })
          .strict()
          .parse(value);
        if (expectedSession && parsed.sessionId !== expectedSession) throw Error('Session mismatch');
        if (parsed.type === 'pair') {
          if (
            path !== 'relay' ||
            lane !== 'control' ||
            !parsed.code ||
            !parsed.name ||
            createHash('sha256').update(parsed.code).digest('hex') !== ticket
          )
            throw Error('Invalid pairing');
          if (!this.deps.store.pair(parsed.code, parsed.name, channel.remotePeer))
            throw Error('Pairing expired');
          this.relay?.announce();
        }
        const device = this.deps.store.peer(channel.remotePeer);
        if (!device || (parsed.type !== 'pair' && device.ticket !== ticket)) throw Error('Device revoked');
        const key = `${channel.remotePeer}:${parsed.sessionId}`;
        session = this.sessions.get(key);
        if (!session) {
          const previousSessions = [...this.sessions.values()].filter((s) => s.peerId === channel.remotePeer);
          if (previousSessions.length >= 4) {
            // Keep the reconnect grace period while there is room. A page reload creates
            // a new session ID, so disconnected pages must not consume all live-tab slots.
            // Reclaim only this authenticated device's inactive sessions; live tabs stay intact.
            for (const previous of previousSessions) if (!previous.channels.size) this.drop(previous);
            if (previousSessions.filter((s) => s.channels.size > 0).length >= 4)
              throw Error('Device session limit');
          }
          session = {
            id: parsed.sessionId,
            peerId: channel.remotePeer,
            device,
            channels: new Map(),
            subscriptions: new Map(),
          };
          this.sessions.set(key, session);
          this.metrics.connections++;
        }
        clearTimeout(timeout);
        clearTimeout(session.expire);
        const channelKey = `${path}:${lane}`,
          previous = session.channels.get(channelKey);
        session.channels.set(channelKey, channel);
        previous?.close();
        await channel.send({
          type: 'ready',
          protocol: 2,
          sessionId: session.id,
          device: { id: device.id, name: device.name },
          ticket: device.ticket,
          hostName: hostname(),
          status: this.core.status(),
          p2p: this.config.p2p ?? { enabled: false, stunUrls: [] },
        });
        return;
      }
      if (!this.deps.store.peer(session.peerId)) {
        this.drop(session);
        return;
      }
      const requestId = idSchema.parse(value.id);
      let result: unknown, responseBytes: Uint8Array | undefined;
      try {
        if (value.type === 'rpc') {
          if (!Object.hasOwn(RPC_ROUTES, value.call?.method ?? '')) throw new RpcError('不支持此操作', 404);
          result = await this.coreFor(value.call.backendId).router.call(
            value.call as RpcCall,
            session.device,
            packet.bytes,
          );
          if (
            RPC_ROUTES[value.call.method as keyof typeof RPC_ROUTES][0] === 'GET' &&
            value.knownHash === contentVersion(result)
          )
            result = { cacheHit: true };
          if (value.call.method === 'device.revoke') setTimeout(() => this.drop(session!), 20);
        } else if (value.type === 'file') {
          const response = await this.coreFor(value.backendId).files.handle(
            value.action,
            value,
            session.device.id,
            packet.bytes,
          );
          result = response.value;
          responseBytes = response.bytes;
        } else if (value.type === 'watch') {
          const threadId = conversationId.parse(value.threadId);
          const known = value.known === undefined ? undefined : checkpointSchema.parse(value.known);
          await this.watch(session, threadId, known, value.backendId ?? DEFAULT_BACKEND);
          result = { ok: true };
        } else if (value.type === 'unwatch') {
          this.unwatch(
            session,
            conversationKey(value.backendId ?? DEFAULT_BACKEND, conversationId.parse(value.threadId)),
          );
          result = { ok: true };
        } else if (value.type === 'offer') {
          if (!this.config.p2p?.enabled) throw new RpcError('直连未启用', 400);
          session.peer?.close();
          const current = session;
          const device = this.deps.store.peer(session.peerId)!;
          session.peer = new DevicePeer(
            this.config.p2p.stunUrls,
            (candidate) => this.send(current, { type: 'candidate', candidate }),
            (directWire, directLane) => {
              this.metrics.directConnections++;
              void this.accept(directWire, directLane, 'direct', device.ticket, current.peerId, current.id);
            },
            () => {},
          );
          result = { sdp: await session.peer.answer(z.string().max(100000).parse(value.sdp)) };
        } else if (value.type === 'candidate') {
          await session.peer?.candidate(value.candidate);
          result = { ok: true };
        } else if (value.type === 'ping') result = { ok: true };
        else throw new RpcError('不支持此操作', 400);
        await channel.send({ type: 'response', id: requestId, result }, responseBytes);
      } catch (error) {
        await channel.send({
          type: 'response',
          id: requestId,
          status: error instanceof RpcError ? error.status : error instanceof z.ZodError ? 400 : 503,
          error: error instanceof RpcError ? error.message : '请求未完成，请重新核对当前状态',
        });
      }
    };
    channel.onPacket((packet) => {
      if (++inFlight > (lane === 'bulk' ? 8 : 64)) {
        channel.close();
        return;
      }
      void dispatch(packet)
        .catch(() => channel.close())
        .finally(() => {
          inFlight--;
        });
    });
    channel.onClose(() => {
      clearTimeout(timeout);
      if (!session) return;
      const key = `${path}:${lane}`;
      if (session.channels.get(key) === channel) session.channels.delete(key);
      if (!session.channels.size) {
        session.expire = setTimeout(() => this.drop(session!), 120000);
        session.expire.unref();
      }
    });
  }
  private send(session: Session, message: Record<string, any>) {
    const direct = session.channels.get('direct:control');
    const channel = direct ?? session.channels.get('relay:control');
    if (channel) {
      this.metrics[direct ? 'directBytes' : 'relayBytes'] += Buffer.byteLength(JSON.stringify(message));
      void channel.send(message).catch(() => {});
    }
  }
  private publish(session: Session, view: ThreadView, backendId = DEFAULT_BACKEND) {
    const subscription = session.subscriptions.get(conversationKey(backendId, view.id));
    if (!subscription || subscription.cancelled || !session.channels.size) return;
    const journal = this.journals.get(backendId)!;
    const updates = journal.resume(view, subscription.known);
    const state = journal.update(view);
    subscription.known = checkpoint({ epoch: state.epoch, view: state.view });
    this.send(session, { type: 'sync', backendId, threadId: view.id, updates });
  }
  private async watch(
    session: Session,
    threadId: string,
    known?: SyncCheckpoint,
    backendId = DEFAULT_BACKEND,
  ) {
    const backend = this.registry.get(backendId),
      key = conversationKey(backendId, threadId);
    const thread = await backend.history.get(threadId);
    if (!thread) throw new RpcError('找不到此会话', 404);
    const existing = session.subscriptions.get(key);
    if (existing) {
      existing.known = known;
      const current = backend.view(threadId);
      if (current) this.publish(session, current, backendId);
      this.metrics.resyncs++;
      return;
    }
    if (session.subscriptions.size >= 8) throw new RpcError('订阅数量过多', 429);
    const sub: Subscription = { known, cancelled: false, backendId, threadId };
    session.subscriptions.set(key, sub);
    const preview = async () => {
      if (sub.cancelled || backend.view(threadId)?.synchronized) return;
      const summary = thread;
      const page = await backend.history.page(threadId);
      if (sub.cancelled || backend.view(threadId)?.synchronized) return;
      this.publish(
        session,
        {
          ...summary,
          messages: page.messages,
          revision: -1,
          owner: false,
          synchronized: false,
          activeTurnId: null,
          runtimeStatus: 'notLoaded',
          model: null,
          pendingRequests: 0,
          canSend: false,
          canInterrupt: false,
          reason: '已加载历史记录；在电脑打开此会话后可继续对话',
        },
        backendId,
      );
    };
    sub.timer = setTimeout(() => {
      void preview().catch(() => {});
    }, 700);
    void (async () => {
      sub.release = await backend.acquire(threadId);
      if (sub.cancelled) {
        sub.release();
        return;
      }
      const view = await backend.waitForView(threadId);
      if (sub.cancelled) return;
      if (view) this.publish(session, view, backendId);
      else await preview();
      for (const operation of this.deps.store.recent(session.device.id, threadId, backendId))
        this.send(session, { type: 'event', backendId, event: { type: 'operation', operation } });
    })().catch(async () => {
      // Native ownership may be unavailable for old chats; history remains independently readable.
      try {
        await preview();
      } catch (error) {
        if (sub.cancelled || backend.view(threadId)?.synchronized) return;
        this.send(session, {
          type: 'event',
          backendId,
          threadId,
          event: {
            type: 'error',
            message: `无法读取此会话：${error instanceof Error ? error.message : '请重试'}`,
          },
        });
      }
    });
  }
  private unwatch(session: Session, threadId: string) {
    const sub = session.subscriptions.get(threadId);
    if (sub) {
      sub.cancelled = true;
      clearTimeout(sub.timer);
      sub.release?.();
      session.subscriptions.delete(threadId);
    }
  }
  private drop(session: Session) {
    clearTimeout(session.expire);
    this.sessions.delete(`${session.peerId}:${session.id}`);
    for (const threadId of session.subscriptions.keys()) this.unwatch(session, threadId);
    session.peer?.close();
    for (const channel of session.channels.values()) channel.close();
    session.channels.clear();
    clearTimeout(session.expire);
  }
  stop() {
    this.relay?.stop();
    clearInterval(this.sweep);
    for (const session of this.sessions.values()) this.drop(session);
    for (const detach of this.detach) detach();
  }
}
