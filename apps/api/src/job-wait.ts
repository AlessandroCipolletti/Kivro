import { ScheduleSchema, type JobWaitReason } from '@kivro/contracts';
import { isScheduleOpen } from '@kivro/policy-engine';
import type { ApiContext } from './context.js';
import type { JobRecord } from './jobs.js';
import { capabilityInclude, runtimeAvailability, type CapabilityRecord } from './catalog.js';
import { pendingCapacity, type PendingCapacity } from './pending-capacity.js';
import { loadSecurityPolicy, workerPolicyReason } from './security-policy.js';

const waitingStates = new Set(['CREATED', 'PAYMENT_RESERVED', 'SCHEDULED', 'QUEUED', 'OFFERED', 'ACCEPTED']);

/** Read-only, owner-authorized projection. Never expose provider diagnostics as a wait reason. */
export async function jobWaitReasons(ctx: ApiContext, jobs: JobRecord[], now = new Date()): Promise<Map<string, JobWaitReason | null>> {
  const result = new Map<string, JobWaitReason | null>(jobs.map(job => [job.id, null]));
  const waiting = jobs.filter(job => !job.startedAt && job.paymentState === 'RESERVED' && waitingStates.has(job.state));
  if (!waiting.length) return result;
  const capabilities = await ctx.db.capability.findMany({ where: { id: { in: [...new Set(waiting.map(job => job.capabilityId))] } }, include: capabilityInclude });
  const caps = new Map(capabilities.map(cap => [cap.id, cap]));
  const bindings = await ctx.db.workerBinding.findMany({ where: { capabilityVersionId: { in: [...new Set(waiting.map(job => job.capabilityVersionId))] } }, include: { worker: true } });
  const securityPolicy = await loadSecurityPolicy(ctx.db);
  const dispatchEnabled = (await ctx.db.platformSetting.findUnique({ where: { key: 'dispatchEnabled' } }))?.value !== false;
  const runtimes = new Map<string, Awaited<ReturnType<typeof runtimeAvailability>>>(), plans = new Map<string, PendingCapacity>();
  for (const job of waiting) {
    const reason = await describe(job, caps.get(job.capabilityId));
    result.set(job.id, reason);
  }
  return result;

  async function describe(job: JobRecord, cap: CapabilityRecord | undefined): Promise<JobWaitReason> {
    if (job.waitDeadline <= now) return 'WAIT_LIMIT_REACHED';
    if (!cap || job.executionRevokedAt) return 'PROVIDER_UNAVAILABLE';
    const versionBindings = bindings.filter(binding => binding.capabilityVersionId === job.capabilityVersionId);
    if (!runtimes.has(job.capabilityVersionId)) {
      runtimes.set(job.capabilityVersionId, await runtimeAvailability(ctx, { ...cap, currentVersion: job.version }, ctx.db, {
        securityPolicy, bindings: versionBindings.filter(binding => binding.healthy && binding.validationStatus === 'PASSED'
          && binding.validatedManifestHash === job.version.manifestHash && binding.validatedAt && binding.validatedAt.getTime() > now.getTime() - 24 * 3600_000),
        runningJobs: 0, queueDepth: 0, occupiedWorkerIds: [],
      }));
    }
    const runtime = runtimes.get(job.capabilityVersionId)!;
    const deviceBindings = job.activeAttempt ? versionBindings.filter(binding => binding.workerId === job.activeAttempt!.workerId) : versionBindings;
    const devices = deviceBindings.map(binding => binding.worker).filter(worker => !worker.revokedAt);
    const connected = devices.filter(worker => worker.lastSeenAt && worker.lastSeenAt.getTime() > now.getTime() - ctx.config.heartbeatTtlMs);
    if (runtime.policyContext.securityBlocked) return 'PROVIDER_UNAVAILABLE';
    // Acceptance ends new-dispatch gating; a later global pause does not stop an accepted job.
    if (job.state === 'ACCEPTED') {
      if (!devices.length || devices.every(worker => workerPolicyReason(worker, securityPolicy))) return 'PROVIDER_UNAVAILABLE';
      return connected.length ? 'WAITING_FOR_WORKER_START' : 'ELIGIBLE_BUT_WORKER_OFFLINE';
    }
    if (!dispatchEnabled) return 'DISPATCH_PAUSED';
    const schedule = ScheduleSchema.parse(cap.schedule);
    if (cap.paused || schedule.mode === 'MANUAL') return 'PROVIDER_PAUSED';
    if (job.scheduledAt && job.scheduledAt > now || !isScheduleOpen(schedule, now)) return 'WAITING_FOR_SCHEDULE';
    if (!connected.length) return devices.length ? 'ELIGIBLE_BUT_WORKER_OFFLINE' : 'PROVIDER_UNAVAILABLE';
    if (connected.every(worker => worker.paused || worker.localPaused)) return 'PROVIDER_PAUSED';
    if (!['ONLINE', 'BUSY'].includes(runtime.status)) return 'PROVIDER_UNAVAILABLE';
    if (job.state === 'OFFERED') return 'WAITING_FOR_WORKER_ACCEPTANCE';
    if (!plans.has(job.sellerId)) plans.set(job.sellerId, await pendingCapacity(ctx, ctx.db, job.sellerId, now));
    return plans.get(job.sellerId)!.assignments.has(job.id) ? 'WAITING_FOR_WORKER_ACCEPTANCE' : 'WAITING_FOR_CAPACITY';
  }
}
