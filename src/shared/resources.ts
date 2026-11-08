/** Resource names are application capabilities; membership names and amounts live in the policy provider. */
export interface ResourcePolicy {
  label: string;
  storageBytes: number;
  relayBytes: number;
  timeZone: string;
}
export interface ResourcePolicyProvider {
  resolve(subject: string): Promise<ResourcePolicy>;
}
export interface ResourceStatus {
  managed: boolean;
  label: string;
  storage: { used: number; limit: number | null };
  relay: { used: number; limit: number | null; resetsAt: number; timeZone: string };
}
export type ResourceKind = 'file' | 'sticker' | 'avatar';
export interface ResourceFile {
  kind: ResourceKind;
  id: string;
  userId: string;
  name: string;
  mime: string;
  size: number;
  encrypted?: string;
  context?: string;
  url: string;
}
export interface RelayAccount {
  ownerId: string;
  sessionHash: string;
}
