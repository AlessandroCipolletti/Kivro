import { MAX_JOB_PAUSE_MS } from '@kivro/contracts';
export { MAX_JOB_PAUSE_MS } from '@kivro/contracts';
export const TIMING_POLICY_VERSION = 2;

// Worker and reviewed runner timing policy. The host charges acceptance,
// execution and upload time; only confirmed, drained Docker pauses are exempt.
export function pauseBudget(maxPauseMs: unknown): number {
  if (typeof maxPauseMs !== 'number' || !Number.isSafeInteger(maxPauseMs) || maxPauseMs < 1000 || maxPauseMs > MAX_JOB_PAUSE_MS) throw new Error('INVALID_PAUSE_BUDGET');
  return maxPauseMs;
}

export function sandboxWallTimeoutSeconds(timeoutSeconds: number, maxPauseMs: number): number {
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 3600) throw new Error('INVALID_EXECUTION_TIMEOUT');
  // The supported CLI accepts integer seconds. Host accounting and runner
  // containment use exact milliseconds; only this inner ceiling rounds up.
  return timeoutSeconds + Math.ceil(pauseBudget(maxPauseMs) / 1000);
}

export function attemptDeadline(attempt: { deadline: number; pausedAt: number | null; pausedDurationMs: number; maxPauseMs: number }): number {
  const budget = pauseBudget(attempt.maxPauseMs);
  if (!Number.isSafeInteger(attempt.pausedDurationMs) || attempt.pausedDurationMs < 0) throw new Error('INVALID_PAUSE_ACCOUNTING');
  const remaining = Math.max(0, budget - attempt.pausedDurationMs);
  const containment = attempt.deadline - attempt.pausedDurationMs + budget;
  return Math.min(containment, attempt.pausedAt === null ? attempt.deadline : attempt.pausedAt + remaining);
}
