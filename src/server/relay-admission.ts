import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import proxyaddr from '@fastify/proxy-addr';
import ipaddr from 'ipaddr.js';

/** Only explicitly trusted network peers may supply forwarding information. */
export function relayClientAddress(trustedProxies: string[] = []) {
  const trust = proxyaddr.compile(trustedProxies);
  return (request: IncomingMessage) => {
    // Walk from the socket towards the client; stop at the first untrusted hop.
    const address = proxyaddr(request, trust);
    if (!isIP(address)) throw Error('Invalid client address');
    return ipaddr.process(address).toString();
  };
}

export const relayLimits = {
  connections: 1024,
  pending: 256,
  pendingPerIp: 64,
  attemptsPerMinute: 240,
  failuresPerMinute: 64,
  trackedIps: 8192,
};
interface Source {
  pending: number;
  attempts: number;
  failures: number;
  resetAt: number;
}

/** IP quotas protect admission, not the lifetime of authenticated device sockets. */
export class RelayAdmission {
  private sources = new Map<string, Source>();
  private connections = 0;
  private pending = 0;
  constructor(
    private limits = relayLimits,
    private now = Date.now,
  ) {}

  acquire(ip: string) {
    const now = this.now();
    let source = this.sources.get(ip);
    if (source && now >= source.resetAt) {
      source.attempts = source.failures = 0;
      source.resetAt = now + 60_000;
    }
    if (!source) {
      // Bound memory even when many distinct source addresses probe the edge.
      if (this.sources.size >= this.limits.trackedIps)
        for (const [key, value] of this.sources)
          if (!value.pending && now >= value.resetAt) this.sources.delete(key);
      if (this.sources.size >= this.limits.trackedIps) return;
      source = { pending: 0, attempts: 0, failures: 0, resetAt: now + 60_000 };
      this.sources.set(ip, source);
    }
    if (source.attempts >= this.limits.attemptsPerMinute) return;
    source.attempts++;
    if (
      source.failures >= this.limits.failuresPerMinute ||
      source.pending >= this.limits.pendingPerIp ||
      this.pending >= this.limits.pending ||
      this.connections >= this.limits.connections
    )
      return;
    this.connections++;
    this.pending++;
    source.pending++;
    let released = false,
      pending = true,
      failed = false;
    const finishPending = () => {
      if (!pending) return;
      pending = false;
      source.pending--;
      this.pending--;
    };
    return {
      authenticated: () => {
        if (released || failed) return false;
        finishPending();
        return true;
      },
      failed: () => {
        if (released || failed || !pending) return;
        failed = true;
        // Count an asynchronous failure in the window in which it happens.
        const now = this.now();
        if (now >= source.resetAt) {
          source.attempts = source.failures = 0;
          source.resetAt = now + 60_000;
        }
        source.failures++;
      },
      release: () => {
        if (released) return;
        released = true;
        finishPending();
        this.connections--;
      },
    };
  }

  snapshot() {
    return { connections: this.connections, pending: this.pending, trackedIps: this.sources.size };
  }
}
