import { Readable } from 'node:stream';
import type { CallIceConfig } from './messaging/calls.js';
import { desktopRelease } from '../shared/desktop-releases.js';
import { fileReleaseStore } from './desktop-releases.js';
import Fastify from 'fastify';
import { edgeSecurityHeaders } from './edge-policy.js';
import type { StorageAdapter } from './object-storage.js';
import { registerMessaging } from './messaging/service.js';
import staticFiles from '@fastify/static';
import { WebSocketServer, WebSocket } from 'ws';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RelayRoute } from '../shared/relay-protocol.js';
import { RelayAdmission, relayClientAddress } from './relay-admission.js';
import { RelayCore, relayResourceFailure, type RelaySession } from './relay-core.js';
import { DesktopEnrollmentStore } from './desktop-authorization.js';
import type { ResourcePolicyProvider } from '../shared/resources.js';

export interface RelayConfig {
  origin: string;
  webRoot: string;
  releaseRoot?: string;
  releaseDownloadBase?: string;
  database?: string;
  enrollmentSecret: string;
  assetOrigin: string | null;
  uploadOrigins: string[];
  trustedProxies?: string[];
  messaging?: {
    database?: string;
    registrationCode?: string;
    humanContacts?: boolean;
    callIce?: CallIceConfig;
    storage?: StorageAdapter;
    resourcePolicy?: ResourcePolicyProvider;
  };
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
  const counters = { controlBytes: 0, bulkBytes: 0, rejected: 0 };
  const origin = new URL(config.origin);
  const desktops = new DesktopEnrollmentStore(db, origin.origin);
  const headers = edgeSecurityHeaders(config.assetOrigin, config.uploadOrigins);
  app.addHook('onRequest', async (req, reply) => {
    for (const [key, value] of Object.entries(headers)) reply.header(key, value);
    if (req.headers.host !== origin.host) return reply.code(403).send({ error: 'Host 不匹配' });
  });
  const messagingStore = await registerMessaging(app, {
    database: config.messaging?.database ?? (config.database ? `${config.database}.im.sqlite` : ':memory:'),
    origin: config.origin,
    registrationCode: config.messaging?.registrationCode,
    humanContacts: config.messaging?.humanContacts,
    callIce: config.messaging?.callIce,
    clientAddress,
    storage: config.messaging?.storage,
    resourcePolicy: config.messaging?.resourcePolicy,
    desktops: {
      approve: (account, request) => desktops.approve(account, request),
      list: (account) => desktops.list(account),
      ready: (account, id, ticket) =>
        desktops.ownsRequest(account, id, ticket) && core.desktopReady(id, ticket),
      revoke: (account, id) => {
        if (!desktops.revoke(account, id)) return false;
        core.revokeDesktop(id);
        return true;
      },
    },
  });
  const releases = fileReleaseStore(config.releaseRoot ?? join(config.webRoot, '..'));
  app.route({
    method: ['GET', 'HEAD'],
    url: '/downloads/desktop/*',
    handler: async (req, reply) => {
      const request = new Request(new URL(req.url, config.origin), {
        method: req.method,
        headers: req.headers as Record<string, string>,
      });
      const result = await desktopRelease(request, releases, config.releaseDownloadBase);
      reply.code(result.status);
      result.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(result.body ? Readable.fromWeb(result.body as any) : undefined);
    },
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
  const sessions = new WeakMap<WebSocket, RelaySession>();
  const routes = new Map<string, Map<string, RelayRoute>>();
  const controls = new WeakMap<
    WebSocket,
    {
      lease: NonNullable<ReturnType<RelayAdmission['acquire']>>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const core = new RelayCore<WebSocket>(
    {
      sockets: () => [...wss.clients].filter((ws) => sessions.has(ws)),
      data: (ws) => sessions.get(ws)!,
      save: (ws, value) => {
        sessions.set(ws, value);
      },
      isOpen: (ws) => ws.readyState === WebSocket.OPEN,
      send: (ws, value) => {
        if (ws.bufferedAmount > 2 * 1024 * 1024) return false;
        try {
          ws.send(value);
          return true;
        } catch {
          return false;
        }
      },
      close: (ws, code, reason) => {
        try {
          ws.close(code, reason);
        } catch {}
      },
      authenticated: (ws) => {
        const control = controls.get(ws)!;
        control.lease.authenticated();
        clearTimeout(control.timer);
      },
      rejected: (ws) => {
        counters.rejected++;
        controls.get(ws)?.lease.failed();
      },
      forwarded: (lane, bytes) => {
        counters[lane === 'bulk' ? 'bulkBytes' : 'controlBytes'] += bytes;
      },
    },
    {
      desktopStatus: (id) => desktops.status(id),
      hasHost: (id) => !!db.prepare('SELECT id FROM hosts WHERE id=?').get(id),
      enrollHost: (id) => {
        db.prepare('INSERT OR IGNORE INTO hosts VALUES (?,?)').run(id, Date.now());
      },
      route: (host, ticket) => routes.get(host)?.get(ticket),
      replaceRoutes: (host, values) => {
        routes.set(host, new Map(values.map((r) => [r.ticket, r])));
      },
      clearRoutes: (host) => {
        routes.delete(host);
      },
    },
    config.enrollmentSecret,
    messagingStore.resources
      ? {
          redeemRelay: (...args) => messagingStore.resources!.redeemRelay(...args),
          consumeRelay: async (account, bytes) => {
            try {
              await messagingStore.resources!.consumeRelay(account, bytes);
              return { ok: true };
            } catch (error) {
              return { ok: false, reason: relayResourceFailure(error) };
            }
          },
        }
      : undefined,
  );
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
    socket.once('close', lease.release);
    wss.handleUpgrade(request, socket, head, (ws) => {
      sessions.set(ws, core.createSession(ip));
      const timer = setTimeout(() => core.reject(ws, 'Authentication timeout'), 10000);
      controls.set(ws, { lease, timer });
      let alive = true;
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
      core.challenge(ws);
      ws.on('message', (raw, binary) => {
        const bytes = Array.isArray(raw) ? Buffer.concat(raw) : new Uint8Array(raw as ArrayBuffer);
        void core.message(ws, binary ? bytes : Buffer.from(bytes).toString());
      });
      ws.on('error', () => {});
      ws.on('close', () => {
        clearTimeout(timer);
        clearInterval(ping);
        lease.release();
        core.detach(ws);
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
