import type { AgentBackend, BackendHistory } from '../backends/types.js';
import type { AdapterContext } from '../../../packages/adapter-sdk/src/index.js';
import type { BackendInfo } from '../../shared/backends.js';
import type { GatewayStatus, ThreadView } from '../../shared/types.js';
type Method<F> = F extends (...args: infer A) => infer R ? { args: A; result: Awaited<R> } : never;
type RemoteMethods =
  | 'waitForView'
  | 'projects'
  | 'openThread'
  | 'execute'
  | 'inlineMedia'
  | 'fullMessage'
  | 'controls'
  | 'exportLog'
  | 'fileReferences'
  | 'models'
  | 'skills'
  | 'plugins'
  | 'validateSelection'
  | 'validateSettings'
  | 'validateCreation'
  | 'attachment';
export type Calls = { [K in RemoteMethods]: Method<NonNullable<AgentBackend[K]>> } & {
  [K in keyof BackendHistory as `history.${K}`]: Method<BackendHistory[K]>;
} & {
  subscribe: { args: [string, string]; result: ThreadView | null };
  unsubscribe: { args: [string]; result: void };
  ping: { args: []; result: void };
};
export const METHODS = [
  'waitForView',
  'projects',
  'openThread',
  'execute',
  'inlineMedia',
  'fullMessage',
  'controls',
  'exportLog',
  'fileReferences',
  'models',
  'skills',
  'plugins',
  'validateSelection',
  'validateSettings',
  'validateCreation',
  'attachment',
  'history.get',
  'history.list',
  'history.page',
  'history.projects',
  'subscribe',
  'unsubscribe',
  'ping',
] as const;
export interface RemoteError {
  message: string;
  kind: 'delivery' | 'selection' | 'error';
  notSent?: boolean;
  outcome?: 'failed';
}
export type ToHost =
  | { type: 'init'; generation: number; sdk: 1; context: AdapterContext }
  | { type: 'call'; generation: number; id: number; method: keyof Calls; args: unknown[] }
  | { type: 'stop'; generation: number };
export type FromHost = { generation: number } & (
  | {
      type: 'ready';
      info: BackendInfo;
      status: GatewayStatus;
      maxUploadBytes?: number;
      optionalMethods: ('controls' | 'exportLog' | 'fileReferences' | 'attachment')[];
    }
  | { type: 'snapshot'; info: BackendInfo; status: GatewayStatus }
  | { type: 'reply'; id: number; value?: unknown; error?: RemoteError }
  | { type: 'event'; event: 'thread' | 'observations' | 'created'; args: unknown[] }
  | { type: 'fatal'; error: string }
);
