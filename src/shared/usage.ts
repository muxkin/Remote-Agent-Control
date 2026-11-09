import type { AgentUsage } from '../../packages/adapter-sdk/src/usage.js';

export interface UsageSnapshot {
  state: 'loading' | 'current' | 'stale' | 'unavailable';
  value?: AgentUsage;
}
