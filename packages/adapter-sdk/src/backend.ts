import type { BackendCommand } from './commands.js';
import type { EventEmitter } from 'node:events';
import type { BackendInfo } from './backends.js';
import type {
  GatewayStatus,
  ThreadView,
  ThreadSummary,
  Message,
  Operation,
  OperationState,
  SkillChoice,
  PluginChoice,
} from './types.js';

import type { ModelCatalog } from './backends.js';
export type { ModelCatalog, ModelChoice } from './backends.js';
export interface HistoryPage {
  messages: Message[];
  nextCursor: string | null;
}
export interface BackendHistory {
  get(id: string): ThreadSummary | null | Promise<ThreadSummary | null>;
  list(
    cursor?: string,
    limit?: number,
    project?: string,
    query?: string,
  ):
    | { threads: ThreadSummary[]; nextCursor: string | null }
    | Promise<{ threads: ThreadSummary[]; nextCursor: string | null }>;
  page(id: string, cursor?: string): Promise<HistoryPage>;
  projects():
    | { projects: { id: string; name: string; count: number }[]; total: number; ungrouped: number }
    | Promise<{ projects: { id: string; name: string; count: number }[]; total: number; ungrouped: number }>;
}
export interface OperationObservation {
  requestIds: string[];
  turnId: string;
  state: Extract<OperationState, 'accepted' | 'completed' | 'interrupted' | 'failed'>;
}
export interface LocalAttachment {
  name: string;
  path: string;
}
/** Product semantics only. Native RPC payloads never cross this interface. */
export interface AgentBackend extends EventEmitter {
  readonly id: string;
  readonly history: BackendHistory;
  info(): BackendInfo;
  start(): Promise<void>;
  stop(): void;
  status(): GatewayStatus;
  acquire(id: string): Promise<() => void>;
  view(id: string): ThreadView | null;
  waitForView(id: string, timeout?: number): Promise<ThreadView | null>;
  projects(id: string): Promise<{ id: string; name: string; path: string }[]>;
  openThread(id: string): Promise<void>;
  execute(id: string, command: BackendCommand, requestId: string): Promise<string | null>;
  inlineMedia(id: string, reference: string): string | null | Promise<string | null>;
  fullMessage(id: string, messageId: string): Message | null | Promise<Message | null>;
  controls?(id: string): Promise<import('./controls.js').ControlCatalog>;
  exportLog?(id: string): Promise<string>;
  fileReferences?(id: string, query: string): Promise<{ path: string; name: string }[]>;
  models(): Promise<ModelCatalog>;
  skills(id: string): Promise<SkillChoice[]>;
  plugins(id: string): Promise<PluginChoice[]>;
  validateSelection(id: string, skills: string[], plugins: string[]): Promise<void>;
  validateSettings(value: { model: string; effort: string; serviceTier?: string }): Promise<void>;
  validateCreation(value: { model?: string; thinking?: string }): Promise<void>;
  /** Authorizes and materializes a native reference, never arbitrary upstream URLs. */
  attachment?(id: string, reference: string): Promise<string>;
  readonly maxUploadBytes?: number;
}
