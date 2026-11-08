import type { FastifyInstance, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import cookie from '@fastify/cookie';
import type { StorageAdapter } from '../object-storage.js';
import { MessagingStore } from './store.js';
import { MessagingObjects } from './objects.js';
import { registerMessaging as registerCore } from './service-core.js';
import type { MessageHandler, MessageRoute, MessagingHttp, MessagingRequest } from './http.js';
import type { ResourcePolicyProvider } from '../../shared/resources.js';
import { ResourceService } from '../resources/service.js';

export interface MessagingConfig {
  database: string;
  origin: string;
  registrationCode?: string;
  storage?: StorageAdapter;
  resourcePolicy?: ResourcePolicyProvider;
  clientAddress: (request: FastifyRequest['raw']) => string;
}
export async function registerMessaging(parent: FastifyInstance, config: MessagingConfig) {
  const store = new MessagingStore(config.database, new URL(config.origin).host.toLowerCase());
  if (config.resourcePolicy) {
    if (config.storage && !config.storage.remove)
      throw Error('Managed storage requires an adapter with remove()');
    store.resources = new ResourceService(store, config.resourcePolicy);
  }
  await parent.register(
    async (app) => {
      await app.register(cookie);
      app.addContentTypeParser(
        'application/octet-stream',
        { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 + 16 },
        (_req, body, done) => done(null, body),
      );
      const request = (req: FastifyRequest): MessagingRequest => ({
        url: req.url,
        method: req.method,
        headers: req.headers,
        cookies: req.cookies,
        params: req.params,
        query: req.query,
        body: req.body,
        clientAddress: () => config.clientAddress(req.raw),
      });
      const route =
        (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'): MessageRoute =>
        (url, options: { bodyLimit: number } | MessageHandler, handler?: MessageHandler) => {
          const run = typeof options === 'function' ? options : handler!;
          app.route({
            method,
            url,
            ...(typeof options === 'function' ? {} : options),
            handler: async (req, reply) => run(request(req), reply),
          });
        };
      const http: MessagingHttp = {
        get: route('GET'),
        post: route('POST'),
        put: route('PUT'),
        patch: route('PATCH'),
        delete: route('DELETE'),
        addHook(name, handler) {
          if (name === 'onRequest')
            app.addHook(name, async (req, reply) => {
              await handler(request(req), reply);
            });
          else
            app.addHook(name, async () => {
              await (handler as () => unknown)();
            });
        },
        setErrorHandler(handler) {
          app.setErrorHandler((error, req, reply) => handler(error, request(req), reply));
        },
      };
      await registerCore(http, {
        ...config,
        store,
        storage: !!config.storage,
        objects: new MessagingObjects(store, config.storage, config.origin),
        avatar: (data) =>
          sharp(data, { limitInputPixels: 20_000_000 })
            .rotate()
            .resize(256, 256, { fit: 'cover' })
            .webp({ quality: 85 })
            .toBuffer(),
      });
    },
    { prefix: '/api/im' },
  );
  return store;
}
