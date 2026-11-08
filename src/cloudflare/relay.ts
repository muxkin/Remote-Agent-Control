import { DurableObject } from 'cloudflare:workers';
import { RelayCore, relayLimits, type RelaySession } from '../server/relay-core.js';
import type { Env } from './env.js';
import { originFor } from './security.js';
import type { MessagingHub } from './messaging.js';

/** One hub per deployment preserves the v2 /connect handshake and global admission limits. */
export class RelayHub extends DurableObject<Env> {
  private core: RelayCore<WebSocket>;
  private billing() {
    return this.env.MESSAGING.get(
      this.env.MESSAGING.idFromName('accounts-v1'),
    ) as DurableObjectStub<MessagingHub>;
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS hosts(id TEXT PRIMARY KEY, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS routes(host TEXT NOT NULL, ticket TEXT NOT NULL, expires INTEGER NOT NULL, peer TEXT, PRIMARY KEY(host,ticket));
      CREATE TABLE IF NOT EXISTS sources(ip TEXT PRIMARY KEY, attempts INTEGER NOT NULL, failures INTEGER NOT NULL, reset INTEGER NOT NULL);
    `);
    if (!ctx.getWebSockets().length) ctx.storage.sql.exec('DELETE FROM routes');
    this.core = new RelayCore<WebSocket>(
      {
        sockets: () => this.ctx.getWebSockets(),
        data: (ws) => this.data(ws),
        save: (ws, value) => ws.serializeAttachment(value),
        isOpen: (ws) => ws.readyState === 1,
        send: (ws, value) => {
          try {
            ws.send(typeof value === 'string' ? value : value.slice().buffer);
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
        rejected: (ws) => {
          const a = this.data(ws);
          if (a.kind !== 'pending') return;
          const now = Date.now();
          this.ctx.storage.sql.exec(
            `UPDATE sources SET failures=CASE WHEN reset<=? THEN 1 ELSE failures+1 END,
          attempts=CASE WHEN reset<=? THEN 0 ELSE attempts END, reset=CASE WHEN reset<=? THEN ? ELSE reset END WHERE ip=?`,
            now,
            now,
            now,
            now + 60_000,
            a.ip,
          );
        },
      },
      {
        hasHost: (id) => !!ctx.storage.sql.exec('SELECT id FROM hosts WHERE id=?', id).toArray().length,
        enrollHost: (id) => {
          ctx.storage.sql.exec('INSERT OR IGNORE INTO hosts VALUES (?,?)', id, Date.now());
        },
        route: (host, ticket) => {
          const r = ctx.storage.sql
            .exec('SELECT * FROM routes WHERE host=? AND ticket=?', host, ticket)
            .toArray()[0];
          return r
            ? {
                ticket: String(r.ticket),
                expires: Number(r.expires),
                peerId: r.peer ? String(r.peer) : undefined,
              }
            : undefined;
        },
        replaceRoutes: (host, routes) =>
          ctx.storage.transactionSync(() => {
            ctx.storage.sql.exec('DELETE FROM routes WHERE host=?', host);
            for (const r of routes)
              ctx.storage.sql.exec(
                'INSERT OR REPLACE INTO routes VALUES (?,?,?,?)',
                host,
                r.ticket,
                r.expires,
                r.peerId ?? null,
              );
          }),
        clearRoutes: (host) => {
          ctx.storage.sql.exec('DELETE FROM routes WHERE host=?', host);
        },
      },
      env.POCKET_RELAY_ENROLLMENT,
      env.POCKET_LAGO_URL
        ? {
            redeemRelay: (...args) => this.billing().redeemRelay(...args),
            consumeRelay: (account, bytes) => this.billing().consumeRelay(account, bytes),
          }
        : undefined,
    );
  }
  private sockets() {
    return this.core.sockets();
  }
  private data(ws: WebSocket): RelaySession {
    return ws.deserializeAttachment() as RelaySession;
  }
  private async schedule() {
    const pending = this.sockets()
      .map((ws) => this.data(ws))
      .filter((a) => a.kind === 'pending');
    if (!pending.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...pending.map((a) => a.deadline)));
  }
  async fetch(request: Request) {
    const origin = originFor(this.env),
      url = new URL(request.url);
    if (
      url.origin !== origin ||
      url.pathname !== '/connect' ||
      url.search ||
      request.headers.get('Origin') !== origin
    )
      return new Response('Forbidden', { status: 403 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response('Expected WebSocket', { status: 426 });
    if ((this.env.POCKET_RELAY_ENROLLMENT ?? '').length < 32)
      return new Response('Relay is not configured', { status: 503 });
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return new Response('Missing client address', { status: 400 });
    const now = Date.now(),
      sockets = this.sockets(),
      pending = sockets.filter((ws) => this.data(ws).kind === 'pending');
    // Keep quota windows through hibernation. Active pending IPs must retain their failure counts.
    for (const row of this.ctx.storage.sql.exec('SELECT ip FROM sources WHERE reset<=?', now)) {
      if (!pending.some((ws) => this.data(ws).ip === row.ip))
        this.ctx.storage.sql.exec('DELETE FROM sources WHERE ip=?', row.ip);
    }
    const sql = this.ctx.storage.sql;
    let source = sql.exec('SELECT * FROM sources WHERE ip=?', ip).toArray()[0];
    if (!source) {
      if (Number(sql.exec('SELECT count(*) AS n FROM sources').one().n) >= relayLimits.trackedIps)
        return new Response('Too many sources', { status: 429 });
      sql.exec('INSERT INTO sources VALUES (?,0,0,?)', ip, now + 60_000);
      source = { attempts: 0, failures: 0, reset: now + 60_000 };
    } else if (Number(source.reset) <= now) {
      sql.exec('UPDATE sources SET attempts=0, failures=0, reset=? WHERE ip=?', now + 60_000, ip);
      source.attempts = source.failures = 0;
    }
    if (Number(source.attempts) >= relayLimits.attemptsPerMinute)
      return new Response('Rate limited', { status: 429 });
    sql.exec('UPDATE sources SET attempts=attempts+1 WHERE ip=?', ip);
    if (
      Number(source.failures) >= relayLimits.failuresPerMinute ||
      sockets.length >= relayLimits.connections ||
      pending.length >= relayLimits.pending ||
      pending.filter((ws) => this.data(ws).ip === ip).length >= relayLimits.pendingPerIp
    )
      return new Response('Too many connections', { status: 429 });
    const pair = new WebSocketPair(),
      client = pair[0],
      server = pair[1];
    server.serializeAttachment(this.core.createSession(ip));
    this.ctx.acceptWebSocket(server);
    this.core.challenge(server);
    await this.schedule();
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const pending = this.data(ws).kind === 'pending';
    try {
      await this.core.message(ws, typeof message === 'string' ? message : new Uint8Array(message));
    } finally {
      if (pending) await this.schedule();
    }
  }
  async webSocketClose(ws: WebSocket) {
    this.core.detach(ws);
    await this.schedule();
  }
  async webSocketError(ws: WebSocket) {
    this.core.close(ws, 1011, 'Transport error');
    await this.schedule();
  }
  async alarm() {
    this.core.expire();
    await this.schedule();
  }
}
