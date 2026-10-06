import { z } from 'zod';
import { hashManifest } from '@kivro/contracts';
import type { WorkerState } from './state.ts';

export const DEFAULT_DAILY_JOB_LIMIT = 100;
export const WorkerJobLimitsSchema = z.object({ dailyJobLimit: z.number().int().min(1).max(10000) }).strict();
export type WorkerJobLimits = z.infer<typeof WorkerJobLimitsSchema>;

export function validateJobLimits(value: unknown): WorkerJobLimits {
  const parsed = WorkerJobLimitsSchema.safeParse(value);
  if (!parsed.success) throw new Error('INVALID_WORKER_JOB_LIMITS');
  return parsed.data;
}

export function approveJobLimits(state: WorkerState, input: unknown, approval?: string) {
  const config = validateJobLimits(input), approvalHash = hashManifest(config);
  if (approval === undefined) return { config, approvalHash, approved: false, timeZone: 'UTC',
    consent: 'Maximum accepted jobs per UTC day across all capabilities. Failed and cancelled jobs still count. Changes do not reset usage.' };
  if (approval !== approvalHash) throw new Error('JOB_LIMITS_APPROVAL_MISMATCH');
  return state.transaction(() => {
    state.set('jobLimits', config);
    state.audit('JOB_LIMITS_APPROVED', 'LOCAL');
    return { config, approvalHash, approved: true, ...state.dailyJobs() };
  });
}
