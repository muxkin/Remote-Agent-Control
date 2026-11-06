import { z } from 'zod';
const ref = z.object({ id: z.string().min(1).max(200), revision: z.number().int().nonnegative() }).strict();
export const controlAction = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('permission'),
      value: z.string().min(1).max(200),
      expected: z.string().max(200).nullable(),
      expectedRevision: z.string().length(64).optional(),
    })
    .strict(),
  z.object({ action: z.literal('preset'), value: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('plan'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('compact') }).strict(),
  z.object({ action: z.literal('feedback'), text: z.string().trim().min(1).max(16000) }).strict(),
  z
    .object({
      action: z.literal('goal'),
      operation: z.enum(['create', 'edit', 'pause', 'resume', 'complete', 'clear']),
      ref: ref.optional(),
      objective: z.string().trim().min(1).max(16000).optional(),
    })
    .strict(),
]);
export type ControlAction = z.infer<typeof controlAction>;
export interface ControlState {
  permission: string | null;
  permissionRevision?: string;
  permissionDescription?: string;
  preset?: string | null;
  presetLocked?: boolean;
  plan?: boolean;
}
export interface ControlCatalog {
  product: string;
  permissions: { id: string; name: string; description?: string }[];
  presets: { id: string; name: string; description?: string }[];
  actions: ControlAction['action'][];
  state: ControlState;
  goal?: {
    ref: { id: string; revision: number };
    objective: string;
    phase: string;
    activation?: string;
  } | null;
}
