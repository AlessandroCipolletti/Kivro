import { z } from 'zod';

const calls = z.number().int().min(0).max(32);
export const WorkerUsageReceiptSchema = z.object({
  attemptId: z.string().uuid(),
  provider: z.enum(['openai-compatible', 'anthropic']),
  model: z.string().regex(/^[A-Za-z0-9_./:@-]{1,200}$/),
  attemptedCalls: calls,
  successfulCalls: calls,
  unpricedCalls: calls,
  inputTokens: z.number().int().min(0).max(10_000_000),
  outputTokens: z.number().int().min(0).max(200_000),
  estimatedCostMicroUsd: z.number().int().min(0).max(100_000_000),
  reservedCostMicroUsd: z.number().int().min(0).max(100_000_000),
  costBasis: z.literal('WORKER_CONFIGURED_RATES'),
}).strict().superRefine((value, ctx) => {
  if (value.successfulCalls + value.unpricedCalls !== value.attemptedCalls) ctx.addIssue({ code: 'custom', message: 'Call accounting must balance' });
  if (value.estimatedCostMicroUsd > value.reservedCostMicroUsd) ctx.addIssue({ code: 'custom', message: 'Recorded cost exceeds reserved limit' });
  if (!value.successfulCalls && (value.inputTokens || value.outputTokens || value.estimatedCostMicroUsd)) ctx.addIssue({ code: 'custom', message: 'Usage requires a successful response' });
});
export type WorkerUsageReceipt = z.infer<typeof WorkerUsageReceiptSchema>;
