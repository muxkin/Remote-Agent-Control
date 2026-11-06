import type { Config } from '../config.js';
import type { AgentBackend } from './types.js';
export type BackendDependencies = { backend: AgentBackend };
export function resolveBackend(_config: Config, deps: BackendDependencies): AgentBackend {
  return deps.backend;
}
