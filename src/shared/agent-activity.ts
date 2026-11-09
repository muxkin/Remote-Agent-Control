import { z } from 'zod';

export const agentActivities = z
  .array(
    z.object({
      kind: z.enum(['read', 'search', 'fetch', 'execute', 'edit', 'other']),
      status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
    }),
  )
  .max(8);

export type AgentActivity = z.infer<typeof agentActivities>[number];
