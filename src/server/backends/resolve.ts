import type { Config } from '../config.js';
import type { DesktopBackend } from '../desktop-backend.js';
import type { HistoryIndex } from '../history.js';
import type { AgentBackend } from './types.js';
import { CodexBackend } from './codex.js';
/** Transitional construction API for existing embedders. Runtime routing uses AgentBackend. */
export type BackendDependencies =
  { backend: AgentBackend } | { desktop: DesktopBackend; history: HistoryIndex };
export function resolveBackend(config: Config, deps: BackendDependencies): AgentBackend {
  return 'backend' in deps ? deps.backend : new CodexBackend(config, deps.desktop, deps.history);
}
