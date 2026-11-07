import { z } from 'zod';
import { USER_ID_PATTERN } from '../../shared/account-identity.js';

const question = z
  .object({
    id: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .refine((v) => !['__proto__', 'constructor', 'prototype'].includes(v)),
    header: z.string().max(80).default(''),
    question: z.string().trim().min(1).max(2000),
    detail: z.string().max(8000).optional(),
    multiSelect: z.boolean().optional(),
    options: z
      .array(
        z.object({ label: z.string().trim().min(1).max(200), description: z.string().max(1000).default('') }),
      )
      .max(12)
      .default([]),
  })
  .refine((q) => new Set(q.options.map((o) => o.label)).size === q.options.length, '选项不能重复');
export const interactionInput = z
  .object({
    kind: z.enum(['question', 'approval']),
    recipientId: z.string().regex(USER_ID_PATTERN),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(12000),
    questions: z.array(question).min(1).max(10).optional(),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .refine(
    (v) => (v.kind === 'question' ? !!v.questions?.length : !v.questions),
    '问题需要题目，授权不接受问题字段',
  )
  .refine(
    (v) => !v.questions || new Set(v.questions.map((q) => q.id)).size === v.questions.length,
    '问题 ID 不能重复',
  );
export const interactionResponse = z.union([
  z
    .object({ decision: z.enum(['approve', 'reject']), comment: z.string().trim().max(2000).optional() })
    .strict(),
  z
    .object({
      answers: z.record(z.string().max(80), z.array(z.string().trim().min(1).max(8000)).min(1).max(12)),
    })
    .strict(),
]);
