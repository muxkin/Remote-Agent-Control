import { z } from 'zod';
const names = [
  'history',
  'send',
  'steer',
  'interrupt',
  'respond',
  'settings',
  'queue',
  'create',
  'open',
  'attachments',
  'skills',
  'plugins',
] as const;
const capability = z.object({
  state: z.enum(['supported', 'experimental', 'unsupported', 'unavailable']),
  reason: z.string().optional(),
});
export const infoSchema = z
  .object({
    id: z.string(),
    product: z.string(),
    name: z.string(),
    connected: z.boolean(),
    version: z.string().nullable(),
    profile: z.string(),
    capabilities: z.object(Object.fromEntries(names.map((k) => [k, capability]))),
  })
  .passthrough();
export const statusSchema = z.object({
  connected: z.boolean(),
  desktopVersion: z.string().nullable(),
  supportedVersion: z.boolean(),
  writesEnabled: z.boolean(),
  reason: z.string().nullable(),
  capabilities: z.object({
    send: z.boolean(),
    steer: z.boolean(),
    interrupt: z.boolean(),
    modelSettings: z.boolean(),
    questions: z.boolean(),
    approvals: z.boolean(),
    permissionRequests: z.union([z.literal(false), z.literal('experimental')]),
    openThread: z.boolean(),
    elicitationForms: z.union([z.literal(false), z.literal('experimental')]),
    newThread: z.boolean(),
    renameThread: z.boolean().optional(),
    forkThread: z.boolean().optional(),
    forkFromTurn: z.boolean().optional(),
    queue: z.boolean(),
  }),
});
const message = z
  .object({ id: z.string(), role: z.enum(['user', 'assistant', 'tool']), text: z.string() })
  .passthrough();
export const threadSchema = z
  .object({
    id: z.string(),
    revision: z.number().finite(),
    synchronized: z.boolean(),
    messages: z.array(message),
    requests: z.array(z.object({ id: z.string(), kind: z.string() }).passthrough()),
    canSend: z.boolean(),
    canInterrupt: z.boolean(),
    reason: z.string().nullable(),
  })
  .passthrough();
export const observationSchema = z.array(
  z.object({
    requestIds: z.array(z.string()),
    turnId: z.string(),
    state: z.enum(['accepted', 'completed', 'interrupted', 'failed']),
  }),
);
