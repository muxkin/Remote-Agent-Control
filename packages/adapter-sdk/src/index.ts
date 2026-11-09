export * from './types.js';
export * from './backends.js';
export * from './controls.js';
export * from './usage.js';
export * from './backend.js';
export * from './commands.js';
export * from './delivery-error.js';
export * from './selection-error.js';
export const ADAPTER_SDK_VERSION = 1;
export interface AdapterContext {
  id: string;
  name: string;
  stateDirectory: string;
  readOnly: boolean;
  config: Record<string, unknown>;
}
/** Construct only; start() connects to an existing Agent. stop() disconnects only. */
export type AdapterFactory = (
  context: AdapterContext,
) => import('./backend.js').AgentBackend | Promise<import('./backend.js').AgentBackend>;
