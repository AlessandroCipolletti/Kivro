import type { JobDTO } from "./types";

type PauseSnapshot = Pick<JobDTO, "state" | "maxPauseMs" | "pausedDurationMs" | "pausedAt" | "completedAt">;

export function canPauseJob(job: Pick<JobDTO, "state" | "pauseSupport">, seller: boolean): boolean {
  return seller && job.pauseSupport !== "NOT_SUPPORTED" && job.state === "RUNNING";
}

export function pauseTime(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const minutes = Math.floor(seconds / 60), remainder = seconds % 60;
  return minutes ? `${minutes} min${remainder ? ` ${remainder} sec` : ""}` : `${seconds} sec`;
}

export function pauseBudgetText(job: PauseSnapshot, now: number): string {
  if (job.maxPauseMs === undefined) return "The cumulative pause limit was not supplied for this job. Pauses are not unlimited; the server enforces the purchased job policy.";
  const policy = `Cumulative pause budget: ${pauseTime(job.maxPauseMs)} for the entire job, shared across all pauses. Resuming does not reset it.`;
  if (job.pausedDurationMs === undefined) return `${policy} Recorded pause usage is unavailable.`;
  const activeSince = job.pausedAt ? Date.parse(job.pausedAt) : NaN;
  const end = job.completedAt ? Date.parse(job.completedAt) : now;
  const hasInterval = Number.isFinite(activeSince) && Number.isFinite(end);
  const used = job.pausedDurationMs + (hasInterval ? Math.max(0, end - activeSince) : 0);
  const current = hasInterval && !job.completedAt;
  return `${policy} ${current ? "Estimated total used" : "Recorded total used"}: ${pauseTime(used)}; ${current ? "estimated remaining" : "remaining"}: ${pauseTime(Math.max(0, job.maxPauseMs - used))}.${current ? " Includes the current pause; the server clock determines enforcement." : ""} Budget exhaustion times out the job.`;
}
