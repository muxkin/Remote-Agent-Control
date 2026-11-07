import Fastify from 'fastify';
import type { StorageAdapter } from './object-storage.js';
import { registerMessaging } from './messaging/service.js';
import staticFiles from '@fastify/static';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { peerIdFromString } from '@libp2p/peer-id';
import {
  hostIdSchema,
  laneSchema,
  hostProof,
  routeSchema,
  readRelayFrame,
  relayFrame,
  type RelayRoute,
} from '../shared/relay-protocol.js';
import { base64, unbase64, type Lane } from '../shared/secure-channel.js';
import { RelayAdmission, relayClientAddress } from './relay-admission.js';

export interface RelayConfig {
  origin: string;
  webRoot: string;
  database?: string;
  enrollmentSecret: string;
  assetOrigin: string | null;
  uploadOrigins: string[];
  trustedProxies?: string[];
  messaging?: { database?: string; registrationCode?: string; storage?: StorageAdapter };
}
const safeEqual = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
interface Host {
  control?: WebSocket;
  bulk?: WebSocket;
  routes: Map<string, RelayRoute>;
}
interface Client {
  socket: WebSocket;
  hostId: string;
  lane: Lane;
  identity: string;
}

/** Public edge: encrypted desktop routing plus an independent account/IM service. Never imports Desktop or file keys. */
export async function buildRelay(config: RelayConfig) {
  if (config.enrollmentSecret.length < 32)
    throw Error('Relay enrollment secret must contain at least 32 characters');
  const clientAddress = relayClientAddress(config.trustedProxies);
  const admission = new RelayAdmission();
  const app = Fastify({ logger: false, bodyLimit: 1024 });
  const db = new DatabaseSync(config.database ?? ':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, created INTEGER NOT NULL)');
  const hosts = new Map<string, Host>();
  const clients = new Map<string, Client>();
  const counters = { controlBytes: 0, bulkBytes: 0, rejected: 0 };
  const origin = new URL(config.origin);
  const allowedOrigins = config.uploadOrigins.map((value) => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value) throw Error('Invalid storage origin');
    return value;
  });
  const cspAsset = config.assetOrigin ? ` ${config.assetOrigin}` : '';
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'${cspAsset}; style-src 'self' 'unsafe-inline'${cspAsset}; font-src 'self'${cspAsset}; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self'${cspAsset}${allowedOrigins.map((v) => ` ${v}`).join('')}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
    if (req.headers.host !== origin.host) return reply.code(403).send({ error: 'Host 不匹配' });
  });
  await registerMessaging(app, {
    database: config.messaging?.database ?? (config.database ? `${config.database}.im.sqlite` : ':memory:'),
    origin: config.origin,
    registrationCode: config.messaging?.registrationCode,
    clientAddress,
    storage: config.messaging?.storage,
  });
  app.get('/health', async () => ({ ok: true, protocol: 2 }));
  // Version 1 cookies confer no authority and are deliberately retired at the new edge.
  app.get('/api/session', async (_req, reply) =>
    reply
      .code(401)
      .header('Set-Cookie', 'pocket_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict')
      .send({ error: '请使用新的设备配对' }),
  );
  if (existsSync(config.webRoot))
    await app.register(staticFiles, {
      root: config.webRoot,
      index: 'index.html',
      cacheControl: false,
      setHeaders(response, file) {
        response.setHeader(
          'Cache-Control',
          file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Not found' }));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  app.server.on('upgrade', (request, socket, head) => {
    if (
      request.url !== '/connect' ||
      request.headers.host !== origin.host ||
      request.headers.origin !== config.origin
    )
      return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    let ip: string;
    try {
      ip = clientAddress(request);
    } catch {
      return socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
    const lease = admission.acquire(ip);
    if (!lease) {
      counters.rejected++;
      return socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
    }
    // Reserve before upgrade and release even for malformed/aborted handshakes.
    socket.once('close', lease.release);
    wss.handleUpgrade(request, socket, head, (ws) => {
      const challenge = base64(randomBytes(32));
      let hostId: string | undefined, lane: Lane | undefined, clientId: string | undefined;
      let authenticated = false,
        authenticating = false,
        rejected = false,
        alive = true;
      const reject = (reason = 'Connection rejected') => {
        if (rejected || ws.readyState !== WebSocket.OPEN) return;
        rejected = true;
        counters.rejected++;
        if (!authenticated) lease.failed();
        ws.close(1008, reason);
      };
      const timer = setTimeout(() => reject('Authentication timeout'), 10000);
      const ping = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, 15000);
      ping.unref();
      ws.on('pong', () => {
        alive = true;
      });
      const send = (target: WebSocket | undefined, value: string | Uint8Array) => {
        if (!target || target.readyState !== WebSocket.OPEN) return false;
        if (target.bufferedAmount > 2 * 1024 * 1024) {
          target.close(1013, 'Relay backpressure');
          return false;
        }
        target.send(value);
        return true;
      };
      send(ws, JSON.stringify({ type: 'challenge', challenge, protocol: 2 }));
      ws.on('message', (raw, binary) => {
        void (async () => {
          if (rejected || ws.readyState !== WebSocket.OPEN) return;
          if (!authenticated) {
            if (authenticating || binary) throw Error();
            authenticating = true;
            const value = JSON.parse(raw.toString());
            if (value.type === 'host') {
              const parsed = z
                .object({
                  type: z.literal('host'),
                  hostId: hostIdSchema,
                  lane: laneSchema,
                  signature: z.string().max(256),
                  enrollment: z.string().max(512).optional(),
                })
                .strict()
                .parse(value);
              const key = peerIdFromString(parsed.hostId).publicKey;
              if (
                !key ||
                !(await key.verify(
                  hostProof(challenge, parsed.hostId, parsed.lane),
                  unbase64(parsed.signature),
                ))
              )
                throw Error();
              if (rejected || ws.readyState !== WebSocket.OPEN) return;
              if (!db.prepare('SELECT id FROM hosts WHERE id=?').get(parsed.hostId)) {
                if (!safeEqual(parsed.enrollment ?? '', config.enrollmentSecret)) throw Error();
                db.prepare('INSERT OR IGNORE INTO hosts VALUES (?,?)').run(parsed.hostId, Date.now());
              }
              hostId = parsed.hostId;
              lane = parsed.lane;
              const host: Host = hosts.get(hostId) ?? { routes: new Map() };
              const previous = host[lane];
              host[lane] = ws;
              hosts.set(hostId, host);
              previous?.close(1012, 'Host reconnected');
              send(ws, JSON.stringify({ type: 'registered', protocol: 2 }));
            } else {
              const parsed = z
                .object({
                  type: z.literal('join'),
                  hostId: hostIdSchema,
                  lane: laneSchema,
                  ticket: routeSchema.shape.ticket,
                })
                .strict()
                .parse(value);
              // QR creation and route advertisement are independent local processes.
              // Allow their bounded announcement delay without making the user rescan.
              const until = Date.now() + 1500;
              while (
                !hosts.get(parsed.hostId)?.routes.has(parsed.ticket) &&
                Date.now() < until &&
                ws.readyState === WebSocket.OPEN
              )
                await new Promise((resolve) => setTimeout(resolve, 100));
              if (rejected || ws.readyState !== WebSocket.OPEN) return;
              const host = hosts.get(parsed.hostId),
                route = host?.routes.get(parsed.ticket);
              if (
                !host ||
                !route ||
                route.expires <= Date.now() ||
                host[parsed.lane]?.readyState !== WebSocket.OPEN
              )
                throw Error('Host offline or expired route');
              // The authenticated host advertises device identity. Pairing routes
              // lack it, so their one-use ticket is the temporary quota identity.
              const identity = route.peerId ?? `pair:${parsed.ticket}`;
              if (
                [...clients.values()].filter((c) => c.hostId === parsed.hostId && c.identity === identity)
                  .length >= 8
              )
                throw Error();
              clientId = randomUUID();
              lane = parsed.lane;
              clients.set(clientId, { socket: ws, hostId: parsed.hostId, lane, identity });
              send(
                host[lane],
                JSON.stringify({
                  type: 'join',
                  id: clientId,
                  lane,
                  ticket: parsed.ticket,
                  peerId: route.peerId,
                }),
              );
              send(ws, JSON.stringify({ type: 'joined', id: clientId, protocol: 2 }));
            }
            authenticated = true;
            lease.authenticated();
            clearTimeout(timer);
            return;
          }
          if (binary) {
            const bytes = new Uint8Array(raw as Buffer);
            if (hostId) {
              const frame = readRelayFrame(bytes),
                client = clients.get(frame.id);
              if (!client || client.hostId !== hostId || client.lane !== lane) return;
              if (send(client.socket, frame.bytes))
                counters[lane === 'bulk' ? 'bulkBytes' : 'controlBytes'] += frame.bytes.length;
            } else if (clientId) {
              const client = clients.get(clientId)!;
              if (bytes.length > 65536) throw Error();
              if (!send(hosts.get(client.hostId)?.[client.lane], relayFrame(clientId, bytes)))
                ws.close(1013, 'Host offline');
              else counters[lane === 'bulk' ? 'bulkBytes' : 'controlBytes'] += bytes.length;
            }
          } else if (hostId) {
            const value = JSON.parse(raw.toString());
            if (value.type === 'routes' && lane === 'control') {
              const routes = z.array(routeSchema).max(256).parse(value.routes);
              hosts.get(hostId)!.routes = new Map(
                routes.filter((r) => r.expires > Date.now()).map((r) => [r.ticket, r]),
              );
              // Routing tickets authorize new sockets. The host owns ongoing authentication:
              // consuming a one-use pairing ticket must not tear down its authenticated channel.
            } else if (value.type === 'close' && typeof value.id === 'string') {
              const client = clients.get(value.id);
              if (client?.hostId === hostId && client.lane === lane)
                client.socket.close(1000, 'Host closed channel');
            } else throw Error();
          } else throw Error();
        })().catch(() => reject());
      });
      ws.on('error', () => {});
      ws.on('close', () => {
        clearTimeout(timer);
        clearInterval(ping);
        lease.release();
        if (clientId) {
          const client = clients.get(clientId);
          clients.delete(clientId);
          if (client)
            send(hosts.get(client.hostId)?.[client.lane], JSON.stringify({ type: 'leave', id: clientId }));
        }
        if (hostId && lane && hosts.get(hostId)?.[lane] === ws) {
          hosts.get(hostId)![lane] = undefined;
          for (const client of clients.values())
            if (client.hostId === hostId && client.lane === lane)
              client.socket.close(1012, 'Host reconnecting');
          const host = hosts.get(hostId)!;
          if (!host.control && !host.bulk) hosts.delete(hostId);
        }
      });
    });
  });
  app.addHook('preClose', async () => {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    db.close();
  });
  return { app, counters, connections: () => admission.snapshot() };
}
