import { Queue, Worker } from 'bullmq';
import { Prisma, serializable } from '@kivro/database';
import { ScheduleSchema, PermissionManifestSchema } from '@kivro/contracts';
import { isScheduleOpen, nextScheduledTime } from '@kivro/policy-engine';
import type { ApiContext } from './context.js';
import { failJob, transition } from './jobs.js';
import { jobPauseExpired } from './job-timing.js';
import { activeStates, terminalStates, loadCapability } from './catalog.js';
import { lockCapacity, promoteScheduled } from './scheduling.js';
import { reconcileCapacityTelemetry } from './capacity-telemetry.js';
import { deliverWebhooks } from './webhooks.js';
import { deliverAccountEmails } from './account-mail.js';
import { expireAssetUploads } from './asset-uploads.js';
import { reconcilePayouts } from './billing.js';
import { reconcilePayments } from './payment-reconciliation.js';
import { reconcileWorkerHealth } from './worker-health.js';
import { cleanupExampleAssets } from './example-assets.js';
import { cleanupPendingObjects } from './pending-objects.js';
import { failureCode, recordJobRecovery } from './job-recovery.js';
import { categoryPolicyBlocked, loadSecurityPolicy, workerPolicyReason } from './security-policy.js';

export async function reconcileJobs(ctx: ApiContext): Promise<void> {
  const jobs = await ctx.db.$transaction(async tx => {
    const held = await tx.$queryRaw<{ held: boolean }[]>`SELECT pg_try_advisory_xact_lock(470419) AS held`;
    if (!held[0]?.held) return [];
    // Independent rotating batches keep future reservations from starving active
    // deadlines, and advance past long-lived jobs even across process restarts.
    const takeFairBatch = async (active: boolean) => {
      const key = active ? 'job-recovery-active-cursor' : 'job-recovery-waiting-cursor';
      const saved = await tx.platformSetting.findUnique({ where: { key } });
      const cursor = typeof saved?.value === 'string' ? saved.value : '';
      const where = { paymentState: 'RESERVED' as const, state: active ? { in: [...activeStates] } : { notIn: [...activeStates] } };
      const query = (after: string) => tx.job.findMany({ where: { ...where, ...(after ? { id: { gt: after } } : {}) },
        select: { id: true }, orderBy: { id: 'asc' }, take: 250 });
      let batch = await query(cursor);
      if (!batch.length && cursor) batch = await query('');
      const next = batch.length === 250 ? batch.at(-1)!.id : '';
      await tx.platformSetting.upsert({ where: { key }, create: { key, value: next }, update: { value: next } });
      return batch;
    };
    return [...await takeFairBatch(true), ...await takeFairBatch(false)];
  });
  // Keep financial transitions in short, per-job transactions. A large scan in
  // one serializable transaction conflicts with unrelated purchases/results.
  for (const selected of jobs) {
    const errorKey = `job-recovery-error:${selected.id}`;
    const prior = (await ctx.db.platformSetting.findUnique({ where: { key: errorKey } }))?.value as { firstSeenAt?: string; nextRetryAt?: number; attempts?: number } | undefined;
    if (prior?.nextRetryAt && prior.nextRetryAt > Date.now()) continue;
    try {
      await serializable(ctx.db, async tx => {
      const job = await tx.job.findUnique({ where: { id: selected.id }, include: { version: true, activeAttempt: { include: { worker: true } } } });
      if (!job || job.paymentState !== 'RESERVED') return;
      if (terminalStates.includes(job.state as typeof terminalStates[number])) {
        await failJob(tx, job, 'CANCELLED', 'Terminal job has an unresolved reservation'); return;
      }
      if (job.executionRevokedAt) { await failJob(tx, job, 'CANCELLED', 'Execution was revoked by an operator'); return; }
      const policy = await loadSecurityPolicy(tx);
      if (categoryPolicyBlocked(job.version.category, policy) || (job.activeAttempt && workerPolicyReason(job.activeAttempt.worker, policy))) {
        await failJob(tx, job, 'CANCELLED', 'Operator security policy no longer permits execution'); return;
      }
      const now = new Date();
      if (job.waitDeadline <= now && !job.startedAt) { await failJob(tx, job, 'TIMED_OUT', 'Maximum waiting period exceeded'); return; }
      if (jobPauseExpired(job, now.getTime())) { await failJob(tx, job, 'TIMED_OUT', 'Cumulative pause budget exceeded'); return; }
      if (job.state === 'PAUSE_REQUESTED' && now.getTime() - job.updatedAt.getTime() > ctx.config.reconnectGraceMs) {
        await failJob(tx, job, 'TIMED_OUT', 'Worker did not acknowledge the pause request'); return;
      }
      const currentPause = job.pausedAt ? now.getTime() - job.pausedAt.getTime() : 0;
      if (job.startedAt && now.getTime() - job.startedAt.getTime() - job.pausedDurationMs - currentPause > PermissionManifestSchema.parse(job.version.permissions).limits.timeoutSeconds * 1000 + ctx.config.reconnectGraceMs) {
        await failJob(tx, job, 'TIMED_OUT', 'Execution deadline exceeded'); return;
      }
      const attempt = job.activeAttempt;
      if (attempt && job.state === 'OFFERED' && attempt.expiresAt <= now) {
        await tx.jobAttempt.update({ where: { id: attempt.id }, data: { state: 'EXPIRED', finishedAt: now } });
        await tx.job.update({ where: { id: job.id }, data: { activeAttemptId: null } });
        await transition(tx, job, 'QUEUED', 'Worker offer expired; waiting for a new attempt');
        return;
      }
      if (attempt && activeStates.includes(job.state as typeof activeStates[number]) && (!attempt.worker.lastSeenAt || now.getTime() - attempt.worker.lastSeenAt.getTime() > ctx.config.reconnectGraceMs)) {
        await failJob(tx, job, 'FAILED', 'Worker did not reconnect within the recovery period'); return;
      }
      if (job.state === 'SCHEDULED' || job.state === 'QUEUED') {
        await lockCapacity(tx, job.capabilityId);
        const cap = await loadCapability(tx, job.capabilityId);
        const schedule = ScheduleSchema.parse(cap.schedule);
        if (!isScheduleOpen(schedule, now)) {
          const next = nextScheduledTime(schedule, now);
          if (!next || new Date(next) > job.waitDeadline) { await failJob(tx, job, 'CANCELLED', 'No eligible execution window remains within the waiting period'); return; }
          const proposed = new Date(Math.max(Date.parse(next), job.scheduledAt?.getTime() ?? 0));
          if (job.scheduledAt?.getTime() !== proposed.getTime()) {
            await tx.job.update({ where: { id: job.id }, data: { scheduledAt: proposed } });
            await tx.outboxEvent.create({ data: { userId: job.buyerId, type: 'job.schedule_changed', payload: { jobId: job.id, scheduledAt: proposed.toISOString() } } });
            await tx.jobEvent.create({ data: { jobId: job.id, type: 'SCHEDULE_CHANGED', message: `Execution eligibility moved to ${proposed.toISOString()}`,
              metadata: { previousScheduledAt: job.scheduledAt?.toISOString() ?? null, scheduledAt: proposed.toISOString(), originalScheduledAt: job.originalScheduledAt?.toISOString() ?? null } } });
          }
          if (job.state === 'QUEUED') await transition(tx, job, 'SCHEDULED', 'Waiting for the next execution window');
        } else if (job.state === 'SCHEDULED' && (!job.scheduledAt || job.scheduledAt <= now)) {
          await promoteScheduled(ctx, tx, cap, now);
        }
      }
      });
      await ctx.db.platformSetting.deleteMany({ where: { key: errorKey } });
    } catch (error) {
      // Preserve financial state for review without starving unrelated maintenance.
      await recordJobRecovery(ctx, selected.id, error);
    }
  }
  await ctx.db.$transaction(async tx => {
    const now = new Date();
    await tx.workerNonce.deleteMany({ where: { expiresAt: { lt: now } } });
    await tx.session.deleteMany({ where: { expiresAt: { lt: now } } });
    await tx.pairingCode.deleteMany({ where: { expiresAt: { lt: now } } });
    await tx.scheduleQuote.deleteMany({ where: { expiresAt: { lt: now } } });
    await tx.abuseBucket.deleteMany({ where: { expiresAt: { lt: now } } });
  });
}

export async function reconcileTransfers(ctx: ApiContext): Promise<void> {
  if (!ctx.billing) return;
  const transfers = await ctx.db.sellerTransfer.findMany({ where: { state: { in: ['PENDING', 'PROCESSING', 'REVERSAL_PENDING'] }, nextAttemptAt: { lte: new Date() } }, take: 20 });
  for (const transfer of transfers) {
    try {
      const claimed = await ctx.db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`transfer:${transfer.jobId}`}, 0))`;
        const current = await tx.sellerTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
        if (!['PENDING', 'PROCESSING', 'REVERSAL_PENDING'].includes(current.state) || current.nextAttemptAt > new Date()) return null;
        const job = await tx.job.findUniqueOrThrow({ where: { id: current.jobId } });
        const seller = await tx.user.findUniqueOrThrow({ where: { id: current.sellerId } });
        const reversing = current.state === 'REVERSAL_PENDING' || job.paymentState === 'REFUNDED';
        if (reversing && !current.startedAt && !current.stripeTransferId) {
          await tx.sellerTransfer.update({ where: { id: current.id }, data: { state: 'CANCELLED', lastError: null } });
          return null;
        }
        if (!current.stripeTransferId && current.startedAt && (!current.destinationAccountId || Date.now() - current.startedAt.getTime() > 23 * 3600_000)) {
          await tx.sellerTransfer.update({ where: { id: current.id }, data: { state: 'NEEDS_RECONCILIATION', lastError: 'TRANSFER_OUTCOME_UNKNOWN_AFTER_IDEMPOTENCY_WINDOW' } });
          await tx.auditEvent.create({ data: { sellerId: current.sellerId, jobId: current.jobId, type: 'TRANSFER_RECONCILIATION_REQUIRED',
            metadata: { transferId: current.id, reason: 'Provider outcome is unknown; automatic creation is no longer safe', startedAt: current.startedAt.toISOString() } } });
          return null;
        }
        if (!current.startedAt && !reversing) {
          if (job.paymentState !== 'SETTLED' || seller.suspendedAt || seller.connectStatus !== 'READY' || !seller.stripeConnectedAccountId) throw new Error('SELLER_NOT_READY');
        }
        return tx.sellerTransfer.update({ where: { id: current.id }, data: {
          state: reversing ? 'REVERSAL_PENDING' : 'PROCESSING', startedAt: current.startedAt ?? new Date(),
          destinationAccountId: current.destinationAccountId ?? seller.stripeConnectedAccountId, nextAttemptAt: new Date(Date.now() + 60_000),
        } });
      });
      if (!claimed) continue;
      // Persist intent before calling Stripe so a crash or concurrent refund can
      // recover the same transfer through its deterministic idempotency key.
      if (!claimed.stripeTransferId && (!claimed.destinationAccountId || Date.now() - claimed.startedAt!.getTime() > 23 * 3600_000)) throw new Error('TRANSFER_OUTCOME_REQUIRES_RECONCILIATION');
      const transferId = claimed.stripeTransferId ?? (await ctx.billing.transfer(claimed.jobId, claimed.destinationAccountId!, claimed.amountMinor)).id;
      const reverse = await ctx.db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`transfer:${claimed.jobId}`}, 0))`;
        const job = await tx.job.findUniqueOrThrow({ where: { id: claimed.jobId } });
        const current = await tx.sellerTransfer.findUniqueOrThrow({ where: { id: claimed.id } });
        const reversing = job.paymentState === 'REFUNDED' || current.state === 'REVERSAL_PENDING';
        await tx.sellerTransfer.update({ where: { id: claimed.id }, data: { stripeTransferId: transferId, state: reversing ? 'REVERSAL_PENDING' : 'TRANSFERRED', lastError: null } });
        if (!reversing) await tx.auditEvent.create({ data: { sellerId: claimed.sellerId, jobId: claimed.jobId, type: 'SELLER_TRANSFERRED', metadata: { transferId, amountMinor: claimed.amountMinor } } });
        return reversing;
      });
      if (reverse) {
        const reversal = await ctx.billing.reverseTransfer(claimed.jobId, transferId);
        await ctx.db.sellerTransfer.update({ where: { id: claimed.id }, data: { state: 'REVERSED', reversalId: reversal.id, lastError: null } });
      }
    } catch {
      await ctx.db.sellerTransfer.update({ where: { id: transfer.id }, data: { attempts: { increment: 1 }, lastError: 'TRANSFER_RECONCILIATION_FAILED', nextAttemptAt: new Date(Date.now() + Math.min(86400, 60 * 2 ** Math.min(transfer.attempts, 10)) * 1000) } });
    }
  }
}

export async function expireAssets(ctx: ApiContext): Promise<void> {
  const assets = await ctx.db.asset.findMany({ where: { deletedAt: null, expiresAt: { lte: new Date() },
    grants: { none: { job: { state: { in: [...activeStates] } } } } }, take: 100 });
  for (const asset of assets) {
    await ctx.storage.delete(asset.objectKey);
    await ctx.db.asset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } });
  }
}

export async function maintenance(ctx: ApiContext): Promise<void> {
  const tasks = { jobs: reconcileJobs, plans: async () => ctx.tickPlans?.(), webhooks: deliverWebhooks,
    transfers: reconcileTransfers, payments: reconcilePayments, payouts: reconcilePayouts, assets: expireAssets, uploads: expireAssetUploads,
    email: deliverAccountEmails, content: expireJobContent, health: reconcileWorkerHealth, capacity: reconcileCapacityTelemetry, examples: cleanupExampleAssets, pendingObjects: cleanupPendingObjects };
  for (const [name, task] of Object.entries(tasks)) {
    const key = `maintenance-error:${name}`;
    try { await task(ctx); await ctx.db.platformSetting.deleteMany({ where: { key } }); }
    catch (error) {
      const value = { code: failureCode(error), lastSeenAt: new Date().toISOString() };
      ctx.app.log.error({ task: name, ...value }, 'Maintenance task failed');
      await ctx.db.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } }).catch(() => undefined);
    }
  }
}

export async function expireJobContent(ctx: ApiContext): Promise<void> {
  const jobs = await ctx.db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Job" WHERE "contentDeletedAt" IS NULL
      AND "state" IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
      AND "completedAt" + make_interval(days => "contentRetentionDays") <= CURRENT_TIMESTAMP
    ORDER BY "completedAt" LIMIT 100`;
  if (jobs.length) await ctx.db.job.updateMany({ where: { id: { in: jobs.map(job => job.id) }, contentDeletedAt: null },
    data: { input: {}, output: Prisma.JsonNull, contentDeletedAt: new Date() } });
}

export function redisConnection(urlString: string) {
  const url = new URL(urlString);
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('Unsupported Redis URL');
  return { host: url.hostname, port: Number(url.port || 6379), username: url.username || undefined, password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number(url.pathname.slice(1) || 0), ...(url.protocol === 'rediss:' ? { tls: {} } : {}) };
}
export async function startBackground(ctx: ApiContext) {
  const connection = redisConnection(ctx.config.redisUrl);
  const queue = new Queue('kivro-maintenance', { connection, defaultJobOptions: { removeOnComplete: 100, removeOnFail: 100, attempts: 5, backoff: { type: 'exponential', delay: 1000 } } });
  const worker = new Worker('kivro-maintenance', async () => maintenance(ctx), { connection, concurrency: 1 });
  worker.on('failed', (_job, error) => ctx.app.log.error({ code: failureCode(error) }, 'Maintenance failed'));
  worker.on('error', error => ctx.app.log.error({ code: failureCode(error) }, 'Background worker connection failed'));
  queue.on('error', error => ctx.app.log.error({ code: failureCode(error) }, 'Background queue connection failed'));
  await queue.upsertJobScheduler('periodic-reconciliation', { every: 5000 }, { name: 'reconcile' });
  const wake = async () => { await queue.add('reconcile', {}, { jobId: `wake-${Math.floor(Date.now() / 1000)}` }); };
  await wake();
  return { wake, ready: () => queue.getJobCounts(), close: async () => { await worker.close(); await queue.close(); } };
}
