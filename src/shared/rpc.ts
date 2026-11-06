/** The only public business methods. Paths are a UI compatibility mapping, not an HTTP proxy. */
export const RPC_ROUTES = {
  'controls.read': ['GET', '/api/threads/:id/controls'],
  'control.execute': ['POST', '/api/threads/:id/control'],
  'log.export': ['POST', '/api/threads/:id/export'],
  'references.list': ['GET', '/api/threads/:id/references'],
  'backends.list': ['GET', '/api/backends'],
  'session.read': ['GET', '/api/session'],
  'device.revoke': ['POST', '/api/logout'],
  'status.read': ['GET', '/api/status'],
  'projects.list': ['GET', '/api/projects'],
  'threads.list': ['GET', '/api/threads'],
  'thread.read': ['GET', '/api/threads/:id'],
  'history.read': ['GET', '/api/threads/:id/history'],
  'content.read': ['GET', '/api/threads/:id/content'],
  'models.list': ['GET', '/api/models'],
  'skills.list': ['GET', '/api/threads/:id/skills'],
  'plugins.list': ['GET', '/api/threads/:id/plugins'],
  'creation.projects': ['GET', '/api/threads/:id/projects'],
  'thread.create': ['POST', '/api/threads/:id/create'],
  'thread.open': ['POST', '/api/threads/:id/open'],
  'message.send': ['POST', '/api/threads/:id/messages'],
  'turn.steer': ['POST', '/api/threads/:id/steer'],
  'turn.interrupt': ['POST', '/api/threads/:id/interrupt'],
  'request.respond': ['POST', '/api/threads/:id/responses'],
  'settings.update': ['POST', '/api/threads/:id/settings'],
  'queue.add': ['POST', '/api/threads/:id/queue'],
  'queue.remove': ['POST', '/api/threads/:id/queue-remove'],
  'operation.read': ['GET', '/api/operations/:id'],
  'operations.list': ['GET', '/api/threads/:id/operations'],
  'media.describe': ['POST', '/api/threads/:id/media'],
  'upload.begin': ['POST', '/api/threads/:id/uploads'],
  'upload.chunk': ['POST', '/api/threads/:id/uploads/:uploadId/chunk'],
  'upload.finish': ['POST', '/api/threads/:id/uploads/:uploadId/complete'],
} as const;
export type RpcMethod = keyof typeof RPC_ROUTES;
export interface RpcCall {
  backendId?: string;
  method: RpcMethod;
  params: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
}
export function apiCall(path: string, method = 'GET', body?: unknown): RpcCall {
  const url = new URL(path.startsWith('/api/') ? path : `/api${path}`, 'https://local.invalid');
  if (url.origin !== 'https://local.invalid') throw Error('External URL is not a business method');
  for (const [name, [verb, pattern]] of Object.entries(RPC_ROUTES)) {
    if (method.toUpperCase() !== verb) continue;
    const keys: string[] = [];
    const expression = pattern.replace(/:([a-zA-Z]+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    const match = new RegExp(`^${expression}$`).exec(url.pathname);
    if (match)
      return {
        method: name as RpcMethod,
        params: Object.fromEntries(keys.map((key, i) => [key, decodeURIComponent(match[i + 1])])),
        query: Object.fromEntries(url.searchParams),
        body,
      };
  }
  throw Error('Unsupported business method');
}
export class RpcError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
  }
}
