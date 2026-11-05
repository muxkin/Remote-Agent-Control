import { z } from 'zod';
export const uuid = z.string().uuid();
export const params = z.object({ id: uuid });
export const pageQuery = z.object({ cursor: z.string().max(512).optional() });
export const sendBody = z
  .object({
    requestId: uuid,
    text: z.string().trim().max(16000),
    uploadIds: z.array(uuid).max(10).optional(),
    pluginIds: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .max(10)
      .optional(),
    skillIds: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .max(10)
      .optional(),
  })
  .strict()
  .refine((v) => !!v.text || !!v.uploadIds?.length);
export const queueBody = z
  .object({
    requestId: uuid,
    text: z.string().trim().min(1).max(16000),
    expectedQueueFingerprint: z.string().length(64),
  })
  .strict();
export const removeQueueBody = z
  .object({ requestId: uuid, messageId: uuid, expectedQueueFingerprint: z.string().length(64) })
  .strict();
export const stopBody = z.object({ requestId: uuid, expectedTurnId: z.string().min(1).max(200) }).strict();
export const steerBody = z
  .object({
    requestId: uuid,
    expectedTurnId: z.string().min(1).max(200),
    text: z.string().trim().max(16000),
    uploadIds: z.array(uuid).max(10).optional(),
  })
  .strict()
  .refine((v) => !!v.text || !!v.uploadIds?.length);
export const pairingBody = z
  .object({ code: z.string().min(20).max(128), name: z.string().trim().min(1).max(80) })
  .strict();
export const settingsBody = z
  .object({
    requestId: uuid,
    model: z.string().min(1).max(100),
    effort: z.string().min(1).max(20),
    mode: z.enum(['default', 'plan']).optional(),
    serviceTier: z.string().min(1).max(40).optional(),
    expectedServiceTier: z.string().nullable().optional(),
    expectedMode: z.enum(['default', 'plan']).optional(),
    expectedModel: z.string().nullable(),
    expectedEffort: z.string().nullable(),
  })
  .strict();
