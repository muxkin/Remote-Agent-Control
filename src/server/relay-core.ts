import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { peerIdFromString } from '@libp2p/peer-id';
import { z } from 'zod';
import {
  hostIdSchema,
  laneSchema,
  hostProof,
  routeSchema,
  relayFrame,
  readRelayFrame,
  type RelayRoute,
} from '../shared/relay-protocol.js';
import type { Lane } from '../shared/secure-channel.js';
import type { RelayAccount } from '../shared/resources.js';
import { ResourceError } from './resources/service.js';

export const relayLimits = {
  connections: 1024,
  pending: 256,
  pendingPerIp: 64,
  attemptsPerMinute: 240,
  failuresPerMinute: 64,
  trackedIps: 8192,
};
const bufferLimit = 2 * 1024 * 1024;
export interface RelaySession {
  id: string;
  ip: string;
  deadline: number;
  challenge: string;
  kind: 'pending' | 'host' | 'client';
  authenticating?: boolean;
  closed?: boolean;
  hostId?: string;
  lane?: Lane;
  identity?: string;
  account?: RelayAccount;
}
export interface RelayStorage {
  hasHost(id: string): boolean;
  enrollHost(id: string): void;
  route(host: string, ticket: string): RelayRoute | undefined;
  replaceRoutes(host: string, routes: RelayRoute[]): void;
  clearRoutes(host: string): void;
}
export interface RelayResources {
  redeemRelay(token: string, host: string, route: string, lane: string): Promise<RelayAccount>;
  consumeRelay(account: RelayAccount, bytes: number): Promise<{ ok: true } | { ok: false; reason: string }>;
}
/** Runtime adapters own I/O and state persistence; all protocol decisions live in RelayCore. */
export interface RelayRuntime<S> {
  sockets(): S[];
  data(socket: S): RelaySession;
  save(socket: S, session: RelaySession): void;
  isOpen(socket: S): boolean;
  send(socket: S, data: string | Uint8Array): boolean;
  close(socket: S, code: number, reason: string): void;
  authenticated?(socket: S): void;
  rejected?(socket: S): void;
  forwarded?(lane: Lane, bytes: number): void;
}
const hostAuth = z
  .object({
    type: z.literal('host'),
    hostId: hostIdSchema,
    lane: laneSchema,
    signature: z.string().max(256),
    enrollment: z.string().max(512).optional(),
  })
  .strict();
const joinAuth = z
  .object({
    type: z.literal('join'),
    hostId: hostIdSchema,
    lane: laneSchema,
    ticket: routeSchema.shape.ticket,
    resourceToken: z.string().max(128).optional(),
  })
  .strict();
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export const relayResourceFailure = (error: unknown) =>
  error instanceof ResourceError ? error.message : '资源服务暂不可用';

export class RelayCore<S> {
  private queues = new Map<string, { work: Promise<void>; bytes: number }>();
  constructor(
    private runtime: RelayRuntime<S>,
    private storage: RelayStorage,
    private enrollment: string,
    private resources?: RelayResources,
  ) {}
  createSession(ip: string): RelaySession {
    return {
      id: randomUUID(),
      kind: 'pending',
      ip,
      deadline: Date.now() + 10000,
      challenge: randomBytes(32).toString('base64'),
    };
  }
  sockets() {
    return this.runtime.sockets().filter((s) => !this.runtime.data(s).closed && this.runtime.isOpen(s));
  }
  private host(id: string, lane: Lane) {
    return this.sockets().find((s) => {
      const a = this.runtime.data(s);
      return a.kind === 'host' && a.hostId === id && a.lane === lane;
    });
  }
  private send(socket: S | undefined, value: string | Uint8Array) {
    if (!socket || this.runtime.data(socket).closed || !this.runtime.isOpen(socket)) return false;
    if (this.runtime.send(socket, value)) return true;
    this.close(socket, 1013, 'Relay backpressure');
    return false;
  }
  private json(socket: S | undefined, value: unknown) {
    return this.send(socket, JSON.stringify(value));
  }
  challenge(socket: S) {
    this.json(socket, {
      type: 'challenge',
      challenge: this.runtime.data(socket).challenge,
      protocol: 2,
      ...(this.resources ? { resources: true } : {}),
    });
  }
  close(socket: S, code: number, reason: string) {
    this.detach(socket);
    this.runtime.close(socket, code, reason);
  }
  detach(socket: S) {
    const a = this.runtime.data(socket);
    if (a.closed) return;
    this.runtime.save(socket, { ...a, closed: true });
    if (a.kind === 'client') this.json(this.host(a.hostId!, a.lane!), { type: 'leave', id: a.id });
    if (a.kind === 'host' && !this.host(a.hostId!, a.lane!)) {
      for (const client of this.sockets()) {
        const c = this.runtime.data(client);
        if (c.kind === 'client' && c.hostId === a.hostId && c.lane === a.lane)
          this.close(client, 1012, 'Host reconnecting');
      }
      if (!this.host(a.hostId!, 'control') && !this.host(a.hostId!, 'bulk'))
        this.storage.clearRoutes(a.hostId!);
    }
  }
  reject(socket: S, reason = 'Connection rejected') {
    if (this.runtime.data(socket).closed) return;
    this.runtime.rejected?.(socket);
    this.close(socket, 1008, reason);
  }
  expire() {
    for (const socket of this.sockets()) {
      const a = this.runtime.data(socket);
      if (a.kind === 'pending' && a.deadline <= Date.now()) this.reject(socket, 'Authentication timeout');
    }
  }
  private validPending(socket: S) {
    const a = this.runtime.data(socket);
    return !a.closed && this.runtime.isOpen(socket) && a.deadline > Date.now();
  }
  private async charge(socket: S, bytes: number) {
    if (!this.resources) return true;
    const account = this.runtime.data(socket).account;
    if (!account) {
      this.close(socket, 1008, '请重新登录后连接中转');
      return false;
    }
    try {
      const result = await this.resources.consumeRelay(account, bytes);
      if (!result.ok) {
        this.close(socket, 1008, result.reason);
        return false;
      }
    } catch (error) {
      this.close(socket, 1008, relayResourceFailure(error));
      return false;
    }
    return !this.runtime.data(socket).closed && this.runtime.isOpen(socket);
  }
  async message(socket: S, message: string | Uint8Array) {
    const id = this.runtime.data(socket).id,
      size = typeof message === 'string' ? new TextEncoder().encode(message).length : message.byteLength;
    const queue = this.queues.get(id) ?? { work: Promise.resolve(), bytes: 0 };
    if (queue.bytes + size > bufferLimit) return this.close(socket, 1013, 'Relay backpressure');
    queue.bytes += size;
    this.queues.set(id, queue);
    queue.work = queue.work
      .then(() => this.handle(socket, message))
      .finally(() => {
        queue.bytes -= size;
        if (!queue.bytes) this.queues.delete(id);
      });
    await queue.work;
  }
  private async handle(socket: S, message: string | Uint8Array) {
    try {
      let a = this.runtime.data(socket);
      if (a.closed || !this.runtime.isOpen(socket)) return;
      if (
        (typeof message === 'string' ? new TextEncoder().encode(message).length : message.byteLength) >
        128 * 1024
      )
        throw Error();
      if (a.kind === 'pending') {
        if (typeof message !== 'string' || a.authenticating || !this.validPending(socket)) throw Error();
        this.runtime.save(socket, { ...a, authenticating: true });
        const input = JSON.parse(message);
        if (input.type === 'host') {
          const parsed = hostAuth.parse(input),
            key = peerIdFromString(parsed.hostId).publicKey;
          if (
            !key ||
            !(await key.verify(
              hostProof(a.challenge, parsed.hostId, parsed.lane),
              Buffer.from(parsed.signature, 'base64'),
            ))
          )
            throw Error();
          if (!this.validPending(socket)) return this.reject(socket);
          if (!this.storage.hasHost(parsed.hostId)) {
            if (!equal(parsed.enrollment ?? '', this.enrollment)) throw Error();
            this.storage.enrollHost(parsed.hostId);
          }
          const previous = this.host(parsed.hostId, parsed.lane);
          a = { ...a, kind: 'host', hostId: parsed.hostId, lane: parsed.lane };
          this.runtime.save(socket, a);
          if (previous) this.close(previous, 1012, 'Host reconnected');
          this.json(socket, { type: 'registered', protocol: 2 });
        } else {
          const parsed = joinAuth.parse(input),
            until = Date.now() + 1500;
          const lookup = () => this.storage.route(parsed.hostId, parsed.ticket);
          while (!lookup() && Date.now() < until && this.validPending(socket))
            await new Promise((r) => setTimeout(r, 100));
          if (!this.validPending(socket)) return this.reject(socket);
          let route = lookup(),
            host = this.host(parsed.hostId, parsed.lane);
          if (!route || route.expires <= Date.now() || !host) throw Error();
          const identity = route.peerId ?? `pair:${parsed.ticket}`;
          const account = this.resources
            ? await this.resources.redeemRelay(
                parsed.resourceToken ?? '',
                parsed.hostId,
                parsed.ticket,
                parsed.lane,
              )
            : undefined;
          if (!this.validPending(socket)) return this.reject(socket);
          // Recheck after the asynchronous grant: parallel joins cannot exceed the device limit.
          route = lookup();
          host = this.host(parsed.hostId, parsed.lane);
          if (
            !route ||
            route.expires <= Date.now() ||
            !host ||
            (route.peerId ?? `pair:${parsed.ticket}`) !== identity
          )
            throw Error();
          if (
            this.sockets().filter((s) => {
              const c = this.runtime.data(s);
              return c.kind === 'client' && c.hostId === parsed.hostId && c.identity === identity;
            }).length >= 8
          )
            throw Error();
          a = { ...a, kind: 'client', hostId: parsed.hostId, lane: parsed.lane, identity, account };
          this.runtime.save(socket, a);
          if (
            !this.json(host, {
              type: 'join',
              id: a.id,
              lane: a.lane,
              ticket: parsed.ticket,
              peerId: route.peerId,
            })
          )
            throw Error();
          this.json(socket, { type: 'joined', id: a.id, protocol: 2 });
        }
        if (!this.runtime.data(socket).closed) this.runtime.authenticated?.(socket);
        return;
      }
      if (typeof message !== 'string') {
        if (a.kind === 'host') {
          const frame = readRelayFrame(message),
            client = this.sockets().find((s) => {
              const c = this.runtime.data(s);
              return c.kind === 'client' && c.id === frame.id && c.hostId === a.hostId && c.lane === a.lane;
            });
          if (client && (await this.charge(client, frame.bytes.length)) && this.send(client, frame.bytes))
            this.runtime.forwarded?.(a.lane!, frame.bytes.length);
        } else {
          if (message.length > 65536) throw Error();
          if (!(await this.charge(socket, message.length))) return;
          if (!this.send(this.host(a.hostId!, a.lane!), relayFrame(a.id, message)))
            this.close(socket, 1013, 'Host offline');
          else this.runtime.forwarded?.(a.lane!, message.length);
        }
      } else if (a.kind === 'host') {
        const value = JSON.parse(message);
        if (value.type === 'routes' && a.lane === 'control') {
          const routes = z.array(routeSchema).max(256).parse(value.routes);
          this.storage.replaceRoutes(
            a.hostId!,
            routes.filter((r) => r.expires > Date.now()),
          );
        } else if (value.type === 'close' && typeof value.id === 'string') {
          for (const client of this.sockets()) {
            const c = this.runtime.data(client);
            if (c.kind === 'client' && c.id === value.id && c.hostId === a.hostId && c.lane === a.lane)
              this.close(client, 1000, 'Host closed channel');
          }
        } else throw Error();
      } else throw Error();
    } catch (error) {
      this.reject(socket, error instanceof ResourceError ? error.message : 'Connection rejected');
    }
  }
}
