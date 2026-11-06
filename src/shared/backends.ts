export const DEFAULT_BACKEND = 'codex-local';
export type CapabilityState = 'supported' | 'experimental' | 'unsupported' | 'unavailable';
export type CapabilityName =
  | 'history'
  | 'send'
  | 'steer'
  | 'interrupt'
  | 'respond'
  | 'settings'
  | 'queue'
  | 'create'
  | 'open'
  | 'attachments'
  | 'skills'
  | 'plugins';
export interface Capability {
  state: CapabilityState;
  reason?: string;
}
export interface BackendInfo {
  id: string;
  product: 'codex' | 'dsh';
  name: string;
  connected: boolean;
  version: string | null;
  profile: string;
  capabilities: Record<CapabilityName, Capability>;
}
/** JSON tuple prevents collisions even when native conversation IDs contain separators. */
export const conversationKey = (backendId: string, conversationId: string) =>
  JSON.stringify([backendId, conversationId]);

export interface ModelChoice {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort: string | null;
  speeds: { id: string; name: string; description: string }[];
}
export interface ModelCatalog {
  models: ModelChoice[];
  fetchedAt: string | null;
  source: string;
}
