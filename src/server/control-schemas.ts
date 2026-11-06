import { z } from 'zod';
export const uuid = z.string().uuid();
export const conversationId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\x00-\x1f/\\]+$/);
export const params = z.object({ id: conversationId });
export const pageQuery = z.object({ cursor: z.string().max(512).optional() });
export const sendBody = z
  .object({
    requestId: uuid,
    text: z.string().trim().max(16000),
    uploadIds: z.array(uuid).max(10).optional(),
    pluginIds: z.array(z.string().min(1).max(200)).max(10).optional(),
    skillIds: z.array(z.string().min(1).max(200)).max(10).optional(),
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
  .object({ requestId: uuid, messageId: conversationId, expectedQueueFingerprint: z.string().length(64) })
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
    model: z.string().min(1).max(500),
    effort: z.string().min(1).max(40),
    mode: z.enum(['default', 'plan']).optional(),
    serviceTier: z.string().min(1).max(40).optional(),
    expectedServiceTier: z.string().nullable().optional(),
    expectedMode: z.enum(['default', 'plan']).optional(),
    expectedModel: z.string().nullable(),
    expectedEffort: z.string().nullable(),
  })
  .strict();

export const creationBody = z
  .object({
    requestId: z.string().uuid(),
    title: z.string().trim().max(160).optional(),
    prompt: z.string().trim().min(1).max(16000),
    projectId: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(500).optional(),
    thinking: z.string().min(1).max(40).optional(),
  })
  .strict();

export const responseBody = z
  .object({
    requestId: z.string().uuid(),
    targetRequestId: z.string().min(1).max(500),
    expectedTurnId: z.string().max(200).nullable(),
    expectedFingerprint: z.string().length(64).optional(),
    planDecision: z.enum(['implement', 'revise']).optional(),
    feedback: z.string().trim().min(1).max(16000).optional(),
    decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']).optional(),
    answers: z.record(z.string().max(200), z.array(z.string().max(16000)).max(20)).optional(),
    permissionIds: z.array(z.string().max(200)).max(100).optional(),
    scope: z.enum(['turn', 'session']).optional(),
    action: z.enum(['accept', 'decline', 'cancel']).optional(),
    content: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      [value.decision, value.answers, value.permissionIds, value.action, value.planDecision].filter(
        (value) => value !== undefined,
      ).length === 1,
  )
  .refine((value) =>
    value.planDecision
      ? !!value.expectedFingerprint &&
        (value.planDecision === 'revise' ? !!value.feedback : value.feedback === undefined)
      : value.feedback === undefined,
  );
