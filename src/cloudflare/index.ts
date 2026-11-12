import { desktopRelease } from '../shared/desktop-releases.js';
import type { Env } from './env.js';
import { originFor, securityHeaders } from './security.js';
export { RelayHub } from './relay.js';
export { MessagingHub } from './messaging.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== originFor(env)) return Response.json({ error: 'Host 不匹配' }, { status: 403 });
    let response: Response;
    if (url.pathname === '/connect') {
      // No client-supplied routing header can select a different hub.
      return env.RELAY.get(env.RELAY.idFromName('relay-v2')).fetch(request);
    } else if (url.pathname.startsWith('/downloads/desktop/')) {
      const bucket = env.DESKTOP_RELEASES ?? env.IM_MEDIA;
      response = await desktopRelease(
        request,
        {
          head: async (key) => {
            const object = await bucket.head(key);
            return object ? { size: object.size, etag: object.httpEtag } : null;
          },
          read: async (key, range) => (await bucket.get(key, range ? { range } : undefined))?.body ?? null,
        },
        env.POCKET_DESKTOP_DOWNLOAD_BASE,
      );
    } else if (url.pathname.startsWith('/api/im/')) {
      response = await env.MESSAGING.get(env.MESSAGING.idFromName('accounts-v1')).fetch(request);
    } else if (url.pathname === '/health') {
      response = Response.json({ ok: true, protocol: 2 });
    } else if (url.pathname === '/api/session') {
      response = Response.json(
        { error: '请使用新的设备配对' },
        {
          status: 401,
          headers: { 'Set-Cookie': 'pocket_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict' },
        },
      );
    } else if (url.pathname.startsWith('/api/')) {
      response = Response.json({ error: 'Not found' }, { status: 404 });
    } else {
      response = await env.ASSETS.fetch(request);
      response = new Response(response.body, response);
      const immutable =
        response.ok &&
        url.pathname.startsWith('/assets/') &&
        !response.headers.get('Content-Type')?.includes('text/html');
      response.headers.set('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
    const result = new Response(response.body, response);
    for (const [key, value] of Object.entries(securityHeaders(env)))
      if (!result.headers.has(key)) result.headers.set(key, value);
    return result;
  },
};
