import type { Job } from '@kivro/database';

export function jobPauseExpired(job: Pick<Job, 'maxPauseMs' | 'pausedDurationMs' | 'pausedAt'>, now = Date.now()): boolean {
  const used = job.pausedDurationMs + (job.pausedAt ? Math.max(0, now - job.pausedAt.getTime()) : 0);
  return job.pausedAt ? used >= job.maxPauseMs : used > job.maxPauseMs;
}
