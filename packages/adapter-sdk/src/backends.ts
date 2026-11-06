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
  product: string;
  presentation?: BackendPresentation;
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

/** Data only. The browser never executes plugin code. */
export interface BackendPresentation {
  description?: string;
  creation: {
    empty: boolean;
    permission: 'native' | 'select';
    preset: boolean;
    plan: boolean;
    notice?: string;
  };
  plan: 'settings' | 'control' | 'none';
  fileReferences: boolean;
  exportLog: boolean;
  nativeCommands: boolean;
}
