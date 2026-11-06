import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';

it('keeps an offline gateway alive for retries and exits after stop', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // No stdin, IPC channel, or referenced watchdog may keep the child alive.
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { HostRelay } from './src/server/host-relay.ts';
    import { createIdentity } from './src/shared/secure-channel.ts';
    const relay = new HostRelay('http://127.0.0.1:${port}', await createIdentity(), '', () => [], () => {});
    relay.start();
    setTimeout(() => { relay.stop(); console.log('stopped'); }, 1400).unref();
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '',
    errors = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (errors += chunk));
  const watchdog = setTimeout(() => child.kill(), 8000);
  try {
    const [code] = await once(child, 'close');
    expect(code, errors).toBe(0);
    expect(output).toContain('stopped');
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill();
  }
}, 10000);
