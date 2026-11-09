import { beforeAll, afterAll } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { AccountClient } from '../../src/client/account.js';
import { EncryptedMessagingClient } from '../../src/client/encrypted-messaging.js';
import { agentCallsContract } from '../contracts/agent-calls.js';
let mf: Miniflare, origin: string;
beforeAll(async () => {
  const root = '.implementation/cloudflare-call-test';
  mkdirSync(`${root}/assets`, { recursive: true });
  writeFileSync(`${root}/assets/index.html`, '<html>test</html>');
  execFileSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'deploy',
      '--dry-run',
      '--outdir',
      root,
      '--assets',
      `${root}/assets`,
    ],
    { stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  );
  const portServer = createServer().listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  origin = `http://127.0.0.1:${port}`;
  mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'calls-test',
      modules: true,
      scriptPath: `${root}/index.js`,
      compatibilityDate: '2026-11-04',
      compatibilityFlags: ['nodejs_compat'],
      host: '127.0.0.1',
      port,
      bindings: {
        POCKET_PUBLIC_ORIGIN: origin,
        POCKET_RELAY_ENROLLMENT: 'isolated-calls-contract-enrollment',
      },
      durableObjects: {
        RELAY: { className: 'RelayHub', useSQLite: true },
        MESSAGING: { className: 'MessagingHub', useSQLite: true },
      },
      r2Buckets: ['IM_MEDIA'],
      images: { binding: 'IMAGES' },
      serviceBindings: { ASSETS: async () => new Response('test') },
    }),
  );
  await mf.ready;
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
agentCallsContract(() => ({
  origin,
  session() {
    let cookie = '';
    const account = new AccountClient(async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
      const r = await fetch(`${origin}/api/im${path}`, {
        method,
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const next = r.headers.get('set-cookie');
      if (next) cookie = next.split(';')[0];
      const value = await r.json();
      if (!r.ok) throw Error(value.error);
      return value;
    });
    return {
      account,
      client() {
        const c = new EncryptedMessagingClient(origin, cookie.split('=')[1]);
        c.account.activate(account.user!, account.secrets!, account.vault, account.revision);
        return c;
      },
    };
  },
}));
