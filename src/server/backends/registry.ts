import { EventEmitter } from 'node:events';
import { DEFAULT_BACKEND, type CapabilityName } from '../../shared/backends.js';
import { RpcError } from '../../shared/rpc.js';
import type { AgentBackend } from './types.js';

export class BackendRegistry extends EventEmitter {
  private entries = new Map<string, AgentBackend>();
  register(backend: AgentBackend) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(backend.id) || this.entries.has(backend.id))
      throw Error('Invalid or duplicate backend ID');
    this.entries.set(backend.id, backend);
    return this;
  }
  get(id = DEFAULT_BACKEND): AgentBackend {
    const backend = this.entries.get(id);
    if (!backend) throw new RpcError('找不到此 Agent 实例', 404);
    return backend;
  }
  all() {
    return [...this.entries.values()];
  }
  list() {
    return this.all().map((b) => b.info());
  }
  async start() {
    await Promise.allSettled(this.all().map((b) => b.start()));
  }
  stop() {
    for (const backend of this.all()) backend.stop();
  }
}
export function requireCapability(backend: AgentBackend, name: CapabilityName) {
  const capability = backend.info().capabilities[name];
  if (!['supported', 'experimental'].includes(capability?.state ?? ''))
    throw new RpcError(capability?.reason ?? '此实例暂不支持该操作', 409);
}
