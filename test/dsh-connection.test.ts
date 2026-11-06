import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { DshWebConnection } from '../src/server/connectors/dsh-web.js';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
it('uses the external API cookie for both carriers and renews the peer after disconnect', async () => {
  let exchanges = 0;
  const headers: string[] = [];
  const frames: any[] = [];
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/connect?')) {
      const url = new URL(req.url, 'http://local');
      expect(url.searchParams.get('interactions')).toBe('answer');
      exchanges++;
      res.writeHead(302, {
        'Set-Cookie': `api=peer-${exchanges}; HttpOnly; SameSite=Strict; Path=/`,
        Location: './api/remote.mux',
      });
      res.end();
      return;
    }
    headers.push(req.headers.cookie ?? '');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    frames.push(request);
    expect(request.payload).toEqual({ args: { _request: {} } });
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: { items: [] } },
      }),
    );
  });
  const sockets = new WebSocketServer({ server, path: '/api/remote.mux' });
  sockets.on('connection', (socket, req) => {
    headers.push(req.headers.cookie ?? '');
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'open')
        socket.send(
          JSON.stringify({
            type: 'item',
            streamId: frame.streamId,
            value: { type: 'ready', clientId: 'client', host: { home: '/home/test' } },
          }),
        );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  const connection = new DshWebConnection({
    id: 'dsh-one',
    name: 'DSH',
    url: `http://127.0.0.1:${port}`,
    token: 'fixture',
    version: '0.2.1-rc.5',
  });
  cleanup.push(() => {
    connection.stop();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.close();
  });
  await connection.start();
  expect(connection.connected).toBe(true);
  expect(await connection.call('session/list', { _request: {} })).toEqual({ items: [] });
  const items: any[] = [];
  connection.stream('$events', {}, (value) => items.push(value));
  await expect.poll(() => items.length).toBe(1);
  for (const socket of sockets.clients) socket.close();
  await expect.poll(() => exchanges, { timeout: 6000 }).toBe(2);
  await expect.poll(() => connection.connected).toBe(true);
  await connection.call('session/list', { _request: {} });
  expect(headers).toEqual(['api=peer-1', 'api=peer-1', 'api=peer-2', 'api=peer-2']);
  expect(frames).toHaveLength(2);
  await expect(connection.call('session/list', { request: {} })).rejects.toThrow();
  await expect(connection.call('credentials/read', {})).rejects.toThrow();
});
