import type { PrismaClient, Transaction } from '@kivro/database';
import type { ApiContext } from './context.js';
import { activeStates, capabilityInclude, runtimeAvailability, type CapabilityRecord } from './catalog.js';
import { loadSecurityPolicy } from './security-policy.js';

type Db = PrismaClient | Transaction;
export type PendingJob = { id: string; capabilityId: string; createdAt: Date; workerIds: string[] };
type Limit = { concurrency: number; maxQueue: number; active: number };
const order = (a: Pick<PendingJob, 'createdAt' | 'id'>, b: Pick<PendingJob, 'createdAt' | 'id'>) =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Oldest feasible prefixes win. Augmenting paths move devices, never evict a selected job. */
export function assignPendingJobs(jobs: PendingJob[], limits: Map<string, Limit>): Map<string, string> {
  const assignments = new Map<string, string>(), occupants = new Map<string, PendingJob>(), counts = new Map<string, number>(), blocked = new Set<string>();
  for (const job of [...jobs].sort(order)) {
    const limit = limits.get(job.capabilityId)!;
    if (blocked.has(job.capabilityId)) continue;
    if ((counts.get(job.capabilityId) ?? 0) >= Math.max(0, limit.concurrency - limit.active)) { blocked.add(job.capabilityId); continue; }
    const queue = [job], visitedJobs = new Set([job.id]), parents = new Map<string, PendingJob>();
    let free: string | undefined;
    for (let i = 0; i < queue.length && free === undefined; i++) {
      const candidate = queue[i]!;
      for (const workerId of [...candidate.workerIds].sort()) {
        if (parents.has(workerId)) continue;
        parents.set(workerId, candidate);
        const occupant = occupants.get(workerId);
        if (!occupant) { free = workerId; break; }
        if (!visitedJobs.has(occupant.id)) { visitedJobs.add(occupant.id); queue.push(occupant); }
      }
    }
    if (free === undefined) { blocked.add(job.capabilityId); continue; }
    while (free !== undefined) {
      const candidate = parents.get(free)!, previous = assignments.get(candidate.id);
      assignments.set(candidate.id, free); occupants.set(free, candidate); free = previous;
    }
    counts.set(job.capabilityId, (counts.get(job.capabilityId) ?? 0) + 1);
  }
  return assignments;
}

export function waitingJobs(jobs: PendingJob[], assignments: Map<string, string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const job of jobs) if (!assignments.has(job.id)) counts.set(job.capabilityId, (counts.get(job.capabilityId) ?? 0) + 1);
  return counts;
}

// Existing over-limit work drains after readiness/configuration changes. A new
// reservation may neither exceed its queue bound nor worsen another draining queue.
export function appendPendingJob(jobs: PendingJob[], assignments: Map<string, string>, job: PendingJob, limits: Map<string, Limit>) {
  const nextJobs = [...jobs, job], next = assignPendingJobs(nextJobs, limits);
  const beforeWaiting = waitingJobs(jobs, assignments), afterWaiting = waitingJobs(nextJobs, next);
  for (const [capabilityId, limit] of limits) {
    const excessActive = Math.max(0, limit.active - limit.concurrency);
    const before = (beforeWaiting.get(capabilityId) ?? 0) + excessActive;
    const after = (afterWaiting.get(capabilityId) ?? 0) + excessActive;
    const ceiling = capabilityId === job.capabilityId ? limit.maxQueue : Math.max(limit.maxQueue, before);
    if (after > ceiling) return null;
  }
  return { jobs: nextJobs, assignments: next };
}

export async function lockSellerCapacity(tx: Transaction, sellerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`seller-capacity:${sellerId}`}, 0))`;
}

export async function pendingCapacity(ctx: ApiContext, db: Db, sellerId: string, now = new Date()) {
  const policy = await loadSecurityPolicy(db);
  const active = await db.job.findMany({ where: { sellerId, state: { in: [...activeStates] } },
    select: { capabilityId: true, activeAttempt: { select: { workerId: true } } } });
  const occupied = new Set(active.flatMap(job => job.activeAttempt ? [job.activeAttempt.workerId] : []));
  const activeCounts = new Map<string, number>();
  for (const job of active) activeCounts.set(job.capabilityId, (activeCounts.get(job.capabilityId) ?? 0) + 1);
  const pending = await db.job.findMany({ where: { sellerId, state: { in: ['QUEUED', 'SCHEDULED'] }, paymentState: 'RESERVED', executionRevokedAt: null,
    waitDeadline: { gt: now }, OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { capability: { include: capabilityInclude }, version: true } });
  const versions = [...new Set(pending.map(job => job.capabilityVersionId))];
  const bindings = versions.length ? await db.workerBinding.findMany({ where: { capabilityVersionId: { in: versions }, healthy: true,
    validationStatus: 'PASSED', validatedAt: { gt: new Date(now.getTime() - 24 * 3600_000) } }, include: { worker: true } }) : [];
  const runtimes = new Map<string, Awaited<ReturnType<typeof runtimeAvailability>>>(), limits = new Map<string, Limit>();
  const prepared = new Map<string, PendingJob>(), barriers = new Map<string, { id: string; createdAt: Date }>();
  for (const job of pending) {
    limits.set(job.capabilityId, { concurrency: job.capability.concurrency, maxQueue: job.capability.maxQueue, active: activeCounts.get(job.capabilityId) ?? 0 });
    if (!runtimes.has(job.capabilityVersionId)) runtimes.set(job.capabilityVersionId, await runtimeAvailability(ctx, { ...job.capability, currentVersion: job.version }, db, {
      securityPolicy: policy, bindings: bindings.filter(binding => binding.capabilityVersionId === job.capabilityVersionId && binding.validatedManifestHash === job.version.manifestHash),
      runningJobs: activeCounts.get(job.capabilityId) ?? 0, queueDepth: 0, occupiedWorkerIds: [...occupied],
    }));
    const runtime = runtimes.get(job.capabilityVersionId)!;
    const executable = ['ONLINE', 'BUSY'].includes(runtime.status);
    prepared.set(job.id, { id: job.id, capabilityId: job.capabilityId, createdAt: job.createdAt,
      workerIds: executable ? runtime.readyWorkers.map(worker => worker.id).filter(id => !occupied.has(id)) : [] });
    if (job.state === 'SCHEDULED' && !executable && !barriers.has(job.capabilityId)) barriers.set(job.capabilityId, job);
  }
  let jobs = pending.filter(job => job.state === 'QUEUED').map(job => {
    const barrier = barriers.get(job.capabilityId), value = prepared.get(job.id)!;
    return barrier && order(barrier, job) < 0 ? { ...value, workerIds: [] } : value;
  });
  let assignments = assignPendingJobs(jobs, limits);
  const promotions: typeof pending = [], remainingDue = new Set<string>(), blocked = new Set<string>();
  for (const job of pending.filter(job => job.state === 'SCHEDULED')) {
    const runtime = runtimes.get(job.capabilityVersionId)!;
    const next = blocked.has(job.capabilityId) || !['ONLINE', 'BUSY'].includes(runtime.status) ? null : appendPendingJob(jobs, assignments, prepared.get(job.id)!, limits);
    if (!next) { remainingDue.add(job.capabilityId); blocked.add(job.capabilityId); continue; }
    jobs = next.jobs; assignments = next.assignments; promotions.push(job);
  }
  return { jobs, assignments, limits, activeCounts, occupied, promotions, remainingDue, policy, now };
}
export type PendingCapacity = Awaited<ReturnType<typeof pendingCapacity>>;

export function pendingAdmission(plan: PendingCapacity, capability: CapabilityRecord, readyWorkerIds: string[]) {
  const limits = new Map(plan.limits);
  limits.set(capability.id, { concurrency: capability.concurrency, maxQueue: capability.maxQueue, active: plan.activeCounts.get(capability.id) ?? 0 });
  const workers = readyWorkerIds.filter(id => !plan.occupied.has(id));
  // Probes are later than every existing acceptance, including synthetic future
  // fixture timestamps. They cannot buy priority through an identifier or clock tie.
  const createdAt = new Date(Math.max(plan.now.getTime(), ...plan.jobs.map(job => job.createdAt.getTime())) + 1);
  const probe: PendingJob = { id: 'pending-admission:0', capabilityId: capability.id, createdAt, workerIds: workers };
  const waiting = waitingJobs(plan.jobs, plan.assignments).get(capability.id) ?? 0;
  const allowed = !plan.remainingDue.has(capability.id) && !!appendPendingJob(plan.jobs, plan.assignments, probe, limits);
  let jobs = [...plan.jobs], freeSlots = 0;
  if (!plan.remainingDue.has(capability.id)) for (let i = 0; i < Math.min(capability.concurrency, workers.length); i++) {
    const candidate = { ...probe, id: `pending-admission:${i}` };
    const next = assignPendingJobs([...jobs, candidate], limits);
    if (!next.has(candidate.id)) break;
    freeSlots++; jobs = [...jobs, candidate];
  }
  return { allowed, freeSlots, waiting, createdAt };
}
