import { infoSchema, statusSchema, threadSchema, observationSchema } from './validation.js';
import { pathToFileURL } from 'node:url';
import { readAdapterPackage } from './package.js';
import { METHODS, type FromHost, type ToHost, type RemoteError } from './protocol.js';
import type { AgentBackend } from '../backends/types.js';
import type { AdapterFactory } from '../../../packages/adapter-sdk/src/index.js';
process.umask(0o077);
let backend: AgentBackend | undefined,
  generation = 0,
  stopping = false,
  initialized = false;
const subscriptions = new Map<string, () => void>();
const send = (message: FromHost) => {
  if (process.connected) process.send!(message, () => {});
};
const pack = readAdapterPackage(process.argv[2]);
const module = await import(pathToFileURL(pack.entry).href);
if (typeof module.createAdapter !== 'function') throw Error('Adapter must export createAdapter');
if (process.argv.includes('--check')) {
  process.send?.({ type: 'validated', sdk: 1 });
  process.disconnect?.();
} else {
  const checked = () => {
    infoSchema.parse(backend!.info());
    statusSchema.parse(backend!.status());
    return { info: backend!.info(), status: backend!.status() };
  };
  const snapshot = () => {
    if (backend)
      try {
        send({ type: 'snapshot', generation, ...checked() });
      } catch {
        send({ type: 'fatal', generation, error: 'Adapter returned an invalid status' });
        void stop();
      }
  };
  async function stop() {
    if (stopping) return;
    stopping = true;
    for (const release of subscriptions.values()) release();
    subscriptions.clear();
    try {
      backend?.stop();
    } finally {
      process.exit(0);
    }
  }
  process.on('disconnect', () => void stop());
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
  process.on('message', async (raw: ToHost) => {
    if (!raw || typeof raw !== 'object') return;
    if (raw.type === 'init') {
      if (initialized) return;
      initialized = true;
      generation = raw.generation;
      try {
        if (raw.sdk !== 1) throw Error('Unsupported adapter SDK protocol');
        backend = await (module.createAdapter as AdapterFactory)(raw.context);
        for (const name of [
          'info',
          'status',
          'start',
          'stop',
          'acquire',
          'view',
          'waitForView',
          'projects',
          'openThread',
          'execute',
          'inlineMedia',
          'fullMessage',
          'models',
          'skills',
          'plugins',
          'validateSelection',
          'validateSettings',
          'validateCreation',
          'on',
        ] as const)
          if (typeof backend[name] !== 'function') throw Error(`Adapter contract missing ${name}`);
        for (const name of ['get', 'list', 'page', 'projects'] as const)
          if (typeof backend.history?.[name] !== 'function')
            throw Error(`Adapter contract missing history.${name}`);
        if (backend.id !== raw.context.id) throw Error('Adapter returned a different instance ID');
        for (const event of ['thread', 'observations', 'created'] as const)
          backend.on(event, (...args: unknown[]) => {
            try {
              if (event === 'thread') threadSchema.parse(args[0]);
              else if (event === 'observations') {
                if (typeof args[0] !== 'string') throw Error();
                observationSchema.parse(args[1]);
              } else if (args.length !== 2 || args.some((a) => typeof a !== 'string')) throw Error();
              JSON.stringify(args);
              send({ type: 'event', generation, event, args });
            } catch {
              send({ type: 'fatal', generation, error: 'Adapter emitted an invalid normalized event' });
              void stop();
            }
          });
        backend.on('status', snapshot);
        await backend.start();
        send({
          type: 'ready',
          generation,
          ...checked(),
          maxUploadBytes: backend.maxUploadBytes,
          optionalMethods: (['controls', 'exportLog', 'fileReferences', 'attachment'] as const).filter(
            (name) => typeof backend![name] === 'function',
          ),
        });
      } catch (error) {
        send({
          type: 'fatal',
          generation,
          error: error instanceof Error ? error.message : 'Adapter initialization failed',
        });
        await stop();
      }
      return;
    }
    if (raw.generation !== generation || !backend || stopping) return;
    if (raw.type === 'stop') return stop();
    if (raw.type !== 'call' || !METHODS.includes(raw.method) || !Array.isArray(raw.args)) return;
    try {
      const a = raw.args as any[];
      let value: unknown;
      // Explicit dispatch table. No property paths or arbitrary upstream methods.
      switch (raw.method) {
        case 'ping':
          snapshot();
          break;
        case 'subscribe': {
          if (subscriptions.has(a[0])) throw Error('Duplicate subscription');
          const release = await backend.acquire(a[1]);
          subscriptions.set(a[0], release);
          value = backend.view(a[1]);
          break;
        }
        case 'unsubscribe':
          subscriptions.get(a[0])?.();
          subscriptions.delete(a[0]);
          break;
        case 'history.get':
          value = await backend.history.get(a[0]);
          break;
        case 'history.list':
          value = await backend.history.list(a[0], a[1], a[2], a[3]);
          break;
        case 'history.page':
          value = await backend.history.page(a[0], a[1]);
          break;
        case 'history.projects':
          value = await backend.history.projects();
          break;
        default: {
          const method = backend[raw.method];
          if (typeof method !== 'function') throw Error(`Adapter does not implement ${raw.method}`);
          value = await (method as (...args: any[]) => unknown).apply(backend, a);
        }
      }
      send({ type: 'reply', generation, id: raw.id, value });
    } catch (error) {
      const e = error as Error & { notSent?: boolean; outcome?: 'failed' };
      const serialized: RemoteError = {
        message: e.message || 'Adapter request failed',
        kind:
          typeof e.notSent === 'boolean'
            ? 'delivery'
            : e.constructor?.name === 'SelectionError'
              ? 'selection'
              : 'error',
        ...(typeof e.notSent === 'boolean' ? { notSent: e.notSent, outcome: e.outcome } : {}),
      };
      send({ type: 'reply', generation, id: raw.id, error: serialized });
    }
  });
}
