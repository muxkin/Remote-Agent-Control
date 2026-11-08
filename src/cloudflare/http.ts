import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { parseCookie, stringifySetCookie } from 'cookie';
import type { SerializeOptions } from '@fastify/cookie';
import type {
  MessageHandler,
  MessageRoute,
  MessagingHttp,
  MessagingReply,
  MessagingRequest,
} from '../server/messaging/http.js';

const fail = (statusCode: number) => Object.assign(Error('Invalid request'), { statusCode });
class Reply implements MessagingReply {
  raw = new EventEmitter();
  headers = new Headers();
  status = 200;
  value: unknown;
  sent = false;
  header(name: string, value: string) {
    this.headers.set(name, value);
    return this;
  }
  code(status: number) {
    this.status = status;
    return this;
  }
  type(mime: string) {
    return this.header('Content-Type', mime);
  }
  send(value?: unknown) {
    this.sent = true;
    this.value = value;
    return this;
  }
  redirect(url: string) {
    return this.code(302).header('Location', url).send();
  }
  setCookie(name: string, value: string, options: SerializeOptions) {
    const { encode, ...attributes } = options;
    this.headers.append('Set-Cookie', stringifySetCookie({ ...attributes, name, value }, { encode }));
    return this;
  }
  clearCookie(name: string, options: SerializeOptions) {
    return this.setCookie(name, '', { ...options, expires: new Date(0), maxAge: 0 });
  }
  response(head: boolean) {
    let body: BodyInit | null = null;
    if (this.value !== undefined) {
      if (this.value instanceof Uint8Array) body = new Uint8Array(this.value);
      else if (typeof this.value === 'string') body = this.value;
      else {
        body = JSON.stringify(this.value);
        if (!this.headers.has('Content-Type')) this.type('application/json; charset=utf-8');
      }
    }
    return new Response(head || [204, 304].includes(this.status) ? null : body, {
      status: this.status,
      headers: this.headers,
    });
  }
}

/** Fetch adapter for the shared route handlers, without Node HTTP or runtime code generation. */
export class WorkerMessagingHttp implements MessagingHttp {
  private routes: { method: string; path: string[]; limit: number; handler: MessageHandler }[] = [];
  private hooks: MessageHandler[] = [];
  private error!: Parameters<MessagingHttp['setErrorHandler']>[0];
  private route(method: string): MessageRoute {
    return (path, options: { bodyLimit: number } | MessageHandler, handler?: MessageHandler) => {
      this.routes.push({
        method,
        path: `/api/im${path}`.split('/'),
        limit: typeof options === 'function' ? 1024 : options.bodyLimit,
        handler: typeof options === 'function' ? options : handler!,
      });
    };
  }
  get = this.route('GET');
  post = this.route('POST');
  put = this.route('PUT');
  patch = this.route('PATCH');
  delete = this.route('DELETE');
  addHook(name: 'onRequest' | 'onClose' | 'preClose', handler: MessageHandler | (() => unknown)) {
    if (name === 'onRequest') this.hooks.push(handler);
    // Durable Objects own storage lifetime and expiry alarms; there is no Node server to close.
  }
  setErrorHandler(handler: Parameters<MessagingHttp['setErrorHandler']>[0]) {
    this.error = handler;
  }
  async fetch(input: Request) {
    const reply = new Reply(),
      url = new URL(input.url),
      parts = url.pathname.split('/');
    const req: MessagingRequest = {
      url: url.pathname + url.search,
      method: input.method,
      headers: Object.fromEntries(input.headers),
      cookies: parseCookie(input.headers.get('Cookie') ?? ''),
      params: {},
      query: Object.fromEntries(url.searchParams),
      body: undefined,
      clientAddress: () => input.headers.get('CF-Connecting-IP')!,
    };
    const aborted = () => reply.raw.emit('close');
    input.signal.addEventListener('abort', aborted, { once: true });
    try {
      for (const hook of this.hooks) await hook(req, reply);
      const route = this.routes.find(
        (r) =>
          r.method === (req.method === 'HEAD' ? 'GET' : req.method) &&
          r.path.length === parts.length &&
          r.path.every((p, i) => p.startsWith(':') || p === parts[i]),
      );
      if (!route) throw fail(404);
      try {
        req.params = Object.fromEntries(
          route.path.flatMap((p, i) =>
            p.startsWith(':') ? [[p.slice(1), decodeURIComponent(parts[i])]] : [],
          ),
        );
      } catch {
        throw fail(400);
      }
      if (Number(input.headers.get('Content-Length') ?? 0) > route.limit) throw fail(413);
      if (input.body) {
        const reader = input.body.getReader(),
          chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > route.limit) {
            await reader.cancel();
            throw fail(413);
          }
          chunks.push(value);
        }
        const body = Buffer.concat(chunks),
          mime = input.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
        if (mime === 'application/octet-stream') req.body = body;
        else if (mime === 'application/json') {
          try {
            req.body = JSON.parse(body.toString('utf8'));
          } catch {
            throw fail(400);
          }
        } else if (size) throw fail(415);
      }
      if (input.signal.aborted) throw fail(400);
      const value = await route.handler(req, reply);
      if (!reply.sent) reply.send(value);
    } catch (error) {
      const value = await this.error(error, req, reply);
      if (!reply.sent) reply.send(value);
    } finally {
      input.signal.removeEventListener('abort', aborted);
    }
    return reply.response(req.method === 'HEAD');
  }
}
