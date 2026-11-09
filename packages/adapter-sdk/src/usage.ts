export interface AgentUsage {
  available: boolean;
  updatedAt: number;
  reason?: string;
  buckets: {
    id: string;
    name: string;
    plan?: string;
    windows: { label: string; usedPercent: number; durationMinutes?: number; resetsAt?: number }[];
  }[];
}
