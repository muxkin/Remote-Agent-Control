import { Console } from 'node:console';
import { pathToFileURL } from 'node:url';
import { getCancelSignal } from 'execa';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  ResponseError,
} from 'vscode-jsonrpc/node';
import { infoSchema, statusSchema, threadSchema, observationSchema } from './validation.js';
import { readAdapterPackage } from './package.js';
import {
  METHODS,
  initialize,
  checkPackage,
  snapshot,
  event,
  fatal,
  request,
  type RemoteError,
  type Calls,
} from './protocol.js';
import type { AgentBackend } from '../backends/types.js';
import type { AdapterFactory } from '../../../packages/adapter-sdk/src/index.js';

process.umask(0o077);
// Product libraries may log during import. Keep diagnostics away from RPC framing.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
let backend: AgentBackend | undefined,
  generation = 0,
  stopping = false,
  initialized = false;
const subscriptions = new Map<string, () => void>();
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    for (const release of subscriptions.values()) release();
    subscriptions.clear();
    await backend?.stop();
  } finally {
    connection.dispose();
    process.exit(0);
  }
}
const cancelSignal = await getCancelSignal();
cancelSignal.addEventListener('abort', () => void stop(), { once: true });
if (cancelSignal.aborted) await stop();
process.on('disconnect', () => void stop());
connection.onClose(() => void stop());
async function loadFactory(): Promise<AdapterFactory> {
  const pack = readAdapterPackage(process.argv[2]);
  const module = await import(pathToFileURL(pack.entry).href);
  if (typeof module.createAdapter !== 'function') throw Error('Adapter must export createAdapter');
  return module.createAdapter;
}
const checked = () => {
  const info = backend!.info(),
    status = backend!.status();
  infoSchema.parse(info);
  statusSchema.parse(status);
  return { generation, info, status };
};
function fail(message: string) {
  void connection.sendNotification(fatal, { generation, error: message }).finally(() => stop());
}
function publish() {
  if (!backend || stopping) return;
  try {
    void connection.sendNotification(snapshot, checked()).catch(() => stop());
  } catch {
    fail('Adapter returned an invalid status');
  }
}
function remoteError(error: unknown) {
  const e = error as Error & { notSent?: boolean; outcome?: 'failed' };
  const data: RemoteError = {
    message: e?.message || 'Adapter request failed',
    kind:
      typeof e?.notSent === 'boolean'
        ? 'delivery'
        : e?.constructor?.name === 'SelectionError'
          ? 'selection'
          : 'error',
    ...(typeof e?.notSent === 'boolean' ? { notSent: e.notSent, outcome: e.outcome } : {}),
  };
  return new ResponseError(-32000, data.message, data);
}
if (process.argv.includes('--check')) {
  connection.onRequest(checkPackage, async () => {
    try {
      await loadFactory();
      return { sdk: 1 };
    } catch (error) {
      throw remoteError(error);
    }
  });
} else {
  connection.onRequest(initialize, async (input) => {
    if (initialized || stopping) throw new ResponseError(-32600, 'Adapter already initialized or stopping');
    initialized = true;
    generation = input.generation;
    try {
      if (input.sdk !== 1) throw Error('Unsupported adapter SDK protocol');
      backend = await (await loadFactory())(input.context);
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
      if (backend.id !== input.context.id) throw Error('Adapter returned a different instance ID');
      for (const name of ['thread', 'observations', 'created'] as const)
        backend.on(name, (...args: unknown[]) => {
          if (stopping) return;
          try {
            if (name === 'thread') threadSchema.parse(args[0]);
            else if (name === 'observations') {
              if (typeof args[0] !== 'string') throw Error();
              observationSchema.parse(args[1]);
            } else if (args.length !== 2 || args.some((a) => typeof a !== 'string')) throw Error();
            JSON.stringify(args);
            void connection.sendNotification(event, { generation, event: name, args }).catch(() => stop());
          } catch {
            fail('Adapter emitted an invalid normalized event');
          }
        });
      backend.on('status', publish);
      await backend.start();
      return {
        ...checked(),
        maxUploadBytes: backend.maxUploadBytes,
        optionalMethods: (['controls', 'exportLog', 'fileReferences', 'attachment'] as const).filter(
          (name) => typeof backend![name] === 'function',
        ),
      };
    } catch (error) {
      throw remoteError(error);
    }
  });
  for (const method of METHODS)
    connection.onRequest(request(method), async (input) => {
      if (input.generation !== generation || !backend || stopping || !Array.isArray(input.args))
        throw new ResponseError(-32600, 'Adapter instance is not ready');
      // SDK top-level arguments are required values or optional, never nullable.
      // JSON encodes omitted array positions as null; restore JS default arguments.
      // Nulls inside settings/messages remain untouched.
      const a = input.args.map((value) => (value === null ? undefined : value)) as any[];
      try {
        // The registration itself is a whitelist; arbitrary upstream methods are never exposed.
        switch (method) {
          case 'ping':
            publish();
            return null;
          case 'subscribe': {
            if (subscriptions.has(a[0])) throw Error('Duplicate subscription');
            const release = await backend.acquire(a[1]);
            if (stopping) {
              release();
              return null;
            }
            subscriptions.set(a[0], release);
            return backend.view(a[1]);
          }
          case 'unsubscribe':
            subscriptions.get(a[0])?.();
            subscriptions.delete(a[0]);
            return null;
          case 'history.get':
            return await backend.history.get(a[0]);
          case 'history.list':
            return await backend.history.list(a[0], a[1], a[2], a[3]);
          case 'history.page':
            return await backend.history.page(a[0], a[1]);
          case 'history.projects':
            return await backend.history.projects();
          default: {
            const fn = backend[method];
            if (typeof fn !== 'function') throw Error(`Adapter does not implement ${method}`);
            return ((await (fn as (...args: any[]) => unknown).apply(backend, a)) ??
              null) as Calls[typeof method]['result'];
          }
        }
      } catch (error) {
        throw remoteError(error);
      }
    });
}
connection.listen();
