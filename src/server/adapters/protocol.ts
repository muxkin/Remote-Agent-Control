import type { AgentBackend, BackendHistory } from '../backends/types.js';
import type { AdapterContext } from '../../../packages/adapter-sdk/src/index.js';
import type { BackendInfo } from '../../shared/backends.js';
import type { GatewayStatus, ThreadView } from '../../shared/types.js';
import { NotificationType, RequestType, RequestType0 } from 'vscode-jsonrpc/node';
type Method<F> = F extends (...args: infer A) => infer R ? { args: A; result: Awaited<R> } : never;
type RemoteMethods =
  | 'waitForView'
  | 'projects'
  | 'openThread'
  | 'execute'
  | 'inlineMedia'
  | 'fullMessage'
  | 'controls'
  | 'usage'
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
  'usage',
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
  code?: 'ENOENT';
}
export interface HostSnapshot {
  generation: number;
  info: BackendInfo;
  status: GatewayStatus;
}
export interface Ready extends HostSnapshot {
  maxUploadBytes?: number;
  optionalMethods: ('controls' | 'exportLog' | 'fileReferences' | 'attachment' | 'usage')[];
}
export const initialize = new RequestType<
  { generation: number; sdk: 1; context: AdapterContext },
  Ready,
  RemoteError
>('adapter/initialize');
export const checkPackage = new RequestType0<{ sdk: 1 }, void>('adapter/check');
export const snapshot = new NotificationType<HostSnapshot>('adapter/snapshot');
export const event = new NotificationType<{
  generation: number;
  event: 'thread' | 'observations' | 'created';
  args: unknown[];
}>('adapter/event');
export const fatal = new NotificationType<{ generation: number; error: string }>('adapter/fatal');
export function request<K extends keyof Calls>(method: K) {
  return new RequestType<{ generation: number; args: Calls[K]['args'] }, Calls[K]['result'], RemoteError>(
    `adapter/${method}`,
  );
}
