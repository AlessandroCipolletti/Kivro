import { z } from 'zod';
import { getPriceTier, FinancialBreakdownSchema, prepaidFinancialBreakdown, IOContractSchema, PermissionManifestSchema, ScheduleSchema, validateInput, hashManifest, type JobDTO, type AssetDTO } from '@kivro/contracts';
import { assertTransition, isScheduleOpen } from '@kivro/policy-engine';
import { json, serializable, type Transaction, type Job, type JobState, type Asset, type Prisma } from '@kivro/database';
import { reserveJob, releaseJob } from '@kivro/billing';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiContext } from './context.js';
import { requireIdentity } from './auth.js';
import { requireAcceptedTerms } from './account-terms.js';
import { assertExecutionPolicy, assertWorkerJobDataPolicy } from './security-policy.js';
import { consumeBucket } from './abuse.js';
import { ApiError, requireValue } from './errors.js';
import { jobPauseExpired } from './job-timing.js';
import { loadCapability, assertCapabilityAccess, availability, terminalStates } from './catalog.js';
import { lockCapacity, promoteScheduled, scheduledAdmission } from './scheduling.js';
import { recordQueueFullRejection } from './capacity-telemetry.js';
import { jobWaitReasons } from './job-wait.js';

const jobInclude = { version: true, activeAttempt: { select: { acceptedAt: true, workerId: true } }, events: { orderBy: { createdAt: 'asc' as const } } } satisfies Prisma.JobInclude;
export type JobRecord = Prisma.JobGetPayload<{ include: typeof jobInclude }>;
export const assetDto = (asset: Asset): AssetDTO => ({ id: asset.id, filename: asset.filename, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, sha256: asset.sha256, expiresAt: asset.expiresAt.toISOString() });
export function jobDto(job: JobRecord, discloseContent = true, waitReason: JobDTO['waitReason'] = null): JobDTO {
  return { id: job.id, correlationId: job.id, capabilityId: job.capabilityId, capabilityVersionId: job.capabilityVersionId, capabilityTitle: job.version.title,
    capabilityVersionNumber: job.version.version, inputContract: IOContractSchema.parse(job.version.ioContract).inputs, outputContract: IOContractSchema.parse(job.version.ioContract).output,
    buyerId: job.buyerId, sellerId: job.sellerId, sellerName: job.sellerNameSnapshot, state: job.state, paymentState: job.paymentState,
    input: discloseContent ? job.input as Record<string, unknown> : {}, output: discloseContent ? job.output as JobDTO['output'] : null, priceSnapshot: job.priceSnapshot as JobDTO['priceSnapshot'],
    financialBreakdown: FinancialBreakdownSchema.parse(job.financialBreakdown),
    maxPauseMs: job.maxPauseMs, pausedDurationMs: job.pausedDurationMs, pausedAt: job.pausedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString(), scheduledAt: job.scheduledAt?.toISOString() ?? null,
    originalScheduledAt: job.originalScheduledAt?.toISOString() ?? null, eligibleAt: job.eligibleAt?.toISOString() ?? null, queuedAt: job.queuedAt?.toISOString() ?? null,
    waitDeadline: job.waitDeadline.toISOString(), waitReason,
    contentDeletedAt: job.contentDeletedAt?.toISOString() ?? null, pauseSupport: 'FULL_RESUME',
    contentExpiresAt: job.completedAt ? new Date(job.completedAt.getTime() + job.contentRetentionDays * 86400_000).toISOString() : null,
    startedAt: job.startedAt?.toISOString() ?? null, completedAt: job.completedAt?.toISOString() ?? null, error: job.error,
    events: job.events.map(e => ({ id: e.id, type: e.type, message: e.message, createdAt: e.createdAt.toISOString(), metadata: e.metadata as Record<string, unknown> })),
  };
}
export async function getJob(ctx: ApiContext, id: string, userId: string, admin = false) {
  const job = requireValue(await ctx.db.job.findUnique({ where: { id }, include: jobInclude }));
  if (!admin && job.buyerId !== userId && job.sellerId !== userId) throw new ApiError(404, 'NOT_FOUND', 'Job not found');
  return jobDto(job, admin || job.buyerId === userId || !!job.activeAttempt?.acceptedAt, (await jobWaitReasons(ctx, [job])).get(job.id));
}

const eventTypes: Partial<Record<JobState, string>> = { SCHEDULED: 'job.scheduled', QUEUED: 'job.eligible', RUNNING: 'job.started', SUCCEEDED: 'job.completed', FAILED: 'job.failed', CANCELLED: 'job.cancelled', TIMED_OUT: 'job.expired', PAUSED: 'job.paused', RESUMING: 'job.resuming' };
type TransitionActor = { source: 'ACCOUNT_API' | 'WORKER' | 'PLATFORM'; actorId?: string; workerId?: string };
export async function transition(tx: Transaction, job: Job, state: JobState, message?: string, actor: TransitionActor = { source: 'PLATFORM' }): Promise<Job> {
  assertTransition(job.state, state);
  if (job.state === state) return job;
  const final = terminalStates.includes(state as typeof terminalStates[number]);
  const changed = await tx.job.updateMany({ where: { id: job.id, state: job.state }, data: {
    state, ...(final ? { completedAt: new Date() } : {}), ...(state === 'RUNNING' && !job.startedAt ? { startedAt: new Date() } : {}),
    ...(state === 'QUEUED' ? { ...(!job.queuedAt ? { queuedAt: new Date() } : {}), ...(!job.eligibleAt ? { eligibleAt: new Date() } : {}) } : {}),
    ...(state === 'PAUSED' ? { pausedAt: new Date() } : {}), ...(state === 'RUNNING' ? { pausedAt: null,
      ...(job.pausedAt ? { pausedDurationMs: { increment: Math.max(0, Date.now() - job.pausedAt.getTime()) } } : {}) } : {}),
  } });
  if (!changed.count) throw new ApiError(409, 'JOB_STATE_CHANGED', 'Job changed; retry the request');
  const updated = requireValue(await tx.job.findUnique({ where: { id: job.id } }));
  const metadata = { previousState: job.state, newState: state, attemptId: updated.activeAttemptId, source: actor.source };
  await tx.jobEvent.create({ data: { jobId: job.id, type: state, message: message ?? state.toLowerCase().replaceAll('_', ' '), metadata } });
  await tx.auditEvent.create({ data: { actorId: actor.actorId, workerId: actor.workerId, sellerId: job.sellerId, jobId: job.id, type: 'JOB_STATE_CHANGED', metadata } });
  const eventType = eventTypes[state];
  if (eventType) await tx.outboxEvent.create({ data: { userId: job.buyerId, type: eventType,
    payload: { jobId: job.id, capabilityId: job.capabilityId, capabilityVersionId: job.capabilityVersionId, status: state } } });
  return updated;
}

export async function failJob(tx: Transaction, job: Job, state: 'FAILED' | 'CANCELLED' | 'TIMED_OUT', reason: string, actor?: TransitionActor): Promise<Job> {
  if (terminalStates.includes(job.state as typeof terminalStates[number])) {
    if (job.paymentState === 'RESERVED') throw new ApiError(409, 'LEDGER_INVARIANT', 'Terminal job has an unresolved reservation');
    return job;
  }
  let updated = await transition(tx, job, state, reason, actor);
  await tx.job.update({ where: { id: job.id }, data: { error: state === 'CANCELLED' ? null : reason } });
  await releaseJob(tx, updated);
  if (job.activeAttemptId) {
    const attempt = await tx.jobAttempt.update({ where: { id: job.activeAttemptId }, data: { state, finishedAt: new Date() } });
    if (!job.executionRevokedAt) await tx.workerCommand.create({ data: { workerId: attempt.workerId, jobId: job.id, type: 'CANCEL_JOB' } });
  }
  updated = requireValue(await tx.job.findUnique({ where: { id: job.id } }));
  return updated;
}

export const CreateJobSchema = z.object({ capabilityId: z.string().uuid(), input: z.record(z.unknown()), executionMode: z.enum(['NOW', 'SCHEDULED']),
  scheduledAt: z.string().datetime().optional(), quoteId: z.string().uuid().optional() }).strict();
export type CreateJob = z.infer<typeof CreateJobSchema>;
export function idempotencyKey(request: FastifyRequest): string {
  return z.string().min(8).max(200).regex(/^[\x21-\x7e]+$/).parse(request.headers['idempotency-key']);
}

export async function createJob(ctx: ApiContext, buyerId: string, inputBody: CreateJob, key: string, hooks?: {
  beforeReserve: (tx: Transaction, buyerPriceMinor: number, versionId: string) => Promise<void>;
  afterCreate: (tx: Transaction, jobId: string) => Promise<void>;
}): Promise<JobDTO> {
  const body = CreateJobSchema.parse(inputBody);
  const fingerprint = hashManifest(body);
  const jobId = await serializable(ctx.db, async tx => {
    const operation = `${buyerId}:jobs:${key}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${operation}, 0))`;
    const prior = await tx.idempotencyRecord.findUnique({ where: { userId_endpoint_key: { userId: buyerId, endpoint: 'jobs', key } } });
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key was used with different input');
      return (prior.response as { jobId: string }).jobId;
    }
    const buyer = requireValue(await tx.user.findUnique({ where: { id: buyerId } }));
    if (buyer.suspendedAt) throw new ApiError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended');
    requireAcceptedTerms(buyer, ctx);
    const cap = await loadCapability(tx, body.capabilityId);
    await assertCapabilityAccess(tx, cap, buyerId);
    const version = requireValue(cap.currentVersion, 'CAPABILITY_NOT_PUBLISHED', 'Capability is not published');
    await assertExecutionPolicy(tx, version.category);
    await lockCapacity(tx, cap.id);
    const setting = await tx.platformSetting.findUnique({ where: { key: 'dispatchEnabled' } });
    if (setting?.value === false) throw new ApiError(503, 'DISPATCH_DISABLED', 'The platform has temporarily paused dispatch');
    await promoteScheduled(ctx, tx, cap);
    const available = await availability(ctx, cap, tx);
    const now = new Date();
    let scheduledAt: Date | null = null;
    if (body.executionMode === 'NOW') {
      if (body.scheduledAt) throw new ApiError(400, 'INVALID_SCHEDULE', 'NOW cannot include a scheduled time');
      if (!['ONLINE', 'BUSY'].includes(available.status)) throw new ApiError(409, `CAPABILITY_${available.status}`, available.reason ?? 'Capability is not available');
      if (!available.pendingAdmissionAllowed) throw new ApiError(409, 'CAPABILITY_QUEUE_FULL', 'Execution and queue capacity is full');
      if (await tx.job.count({ where: { capabilityId: cap.id, state: 'SCHEDULED', paymentState: 'RESERVED', executionRevokedAt: null, waitDeadline: { gt: now },
        OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }] } })) throw new ApiError(409, 'CAPABILITY_QUEUE_FULL', 'Earlier eligible reservations are awaiting execution');
    } else {
      if (!['ONLINE', 'BUSY', 'SCHEDULED_OFFLINE'].includes(available.status)) throw new ApiError(409, `CAPABILITY_${available.status}`, available.reason ?? 'Capability cannot accept a scheduled job');
      scheduledAt = await scheduledAdmission(ctx, tx, cap, available, body.scheduledAt ? new Date(body.scheduledAt) : now, now);
    }
    const price = getPriceTier(version.priceTierId);
    await consumeBucket(tx, `account-purchases:${buyerId}`, ctx.config.accountJobsPerDay, 86400_000, price.buyerPriceMinor, ctx.config.accountJobSpendMinorPerDay);
    await hooks?.beforeReserve(tx, price.buyerPriceMinor, version.id);
    if (body.quoteId) {
      const quote = requireValue(await tx.scheduleQuote.findFirst({ where: { id: body.quoteId, buyerId, capabilityId: cap.id } }));
      if (quote.expiresAt <= now || quote.capabilityVersionId !== version.id || quote.executionMode !== body.executionMode || hashManifest(quote.priceSnapshot) !== hashManifest(price)) throw new ApiError(409, 'QUOTE_EXPIRED', 'The quote changed or expired; request a new quote');
      if (scheduledAt && Math.abs(scheduledAt.getTime() - quote.earliestStartAt.getTime()) > 60_000) throw new ApiError(409, 'QUOTE_CHANGED', 'The scheduled start changed; request a new quote');
    }
    const contract = IOContractSchema.parse(version.ioContract);
    const permissions = PermissionManifestSchema.parse(version.permissions);
    const assetIds = [...new Set(contract.inputs.filter(f => ['FILE', 'FILES'].includes(f.type)).flatMap(f => {
      const value = body.input[f.key]; return (Array.isArray(value) ? value : value ? [value] : []).filter((id): id is string => typeof id === 'string');
    }))];
    if (assetIds.some(id => !z.string().uuid().safeParse(id).success)) throw new ApiError(400, 'INVALID_ASSET', 'File fields must contain uploaded asset IDs');
    const assets = await tx.asset.findMany({ where: { id: { in: assetIds }, ownerId: buyerId, deletedAt: null,
      expiresAt: { gt: scheduledAt ?? now }, scanStatus: { in: ctx.config.development ? ['CLEAN', 'DEVELOPMENT_ONLY'] : ['CLEAN'] },
      OR: [{ kind: 'INPUT' }, { kind: 'OUTPUT', job: { state: 'SUCCEEDED' } }] } });
    if (assets.length !== assetIds.length) throw new ApiError(403, 'ASSET_NOT_AVAILABLE', 'An input asset is unavailable, expired, or not owned by you');
    const normalized = validateInput(contract, body.input, assets.map(assetDto));
    const totalBytes = Buffer.byteLength(JSON.stringify(normalized)) + assets.reduce((n, a) => n + a.sizeBytes, 0);
    if (assets.some(asset => asset.sizeBytes > ctx.config.fileLimits.workerFileBytes) || totalBytes > Math.min(ctx.config.fileLimits.inputBytes, permissions.limits.maxInputBytes)) throw new ApiError(413, 'INPUT_TOO_LARGE', 'Inputs exceed the effective platform and capability limits');
    let job = await tx.job.create({ data: {
      createdAt: body.executionMode === 'NOW' ? available.pendingAdmissionCreatedAt ?? now : now,
      buyerId, sellerId: cap.sellerId, sellerNameSnapshot: cap.seller.name, capabilityId: cap.id, capabilityVersionId: version.id,
      input: json(normalized), priceSnapshot: json(price), financialBreakdown: json(prepaidFinancialBreakdown(price)), buyerPriceMinor: price.buyerPriceMinor,
      platformFeeMinor: price.platformFeeMinor, sellerNetMinor: price.sellerNetMinor, executionMode: body.executionMode,
      scheduledAt, originalScheduledAt: scheduledAt, maxPauseMs: ctx.config.maxPauseMs, contentRetentionDays: ctx.config.jobContentRetentionDays, waitDeadline: new Date(now.getTime() + ctx.config.maxWaitMs),
    } });
    await reserveJob(tx, job);
    job = await transition(tx, job, 'PAYMENT_RESERVED', 'Payment secured', { source: 'ACCOUNT_API', actorId: buyerId });
    job = await transition(tx, job, body.executionMode === 'SCHEDULED' ? 'SCHEDULED' : 'QUEUED', body.executionMode === 'SCHEDULED' ? 'Waiting for the agreed execution window' : 'Waiting for worker acceptance', { source: 'ACCOUNT_API', actorId: buyerId });
    await tx.assetGrant.createMany({ data: assets.map(a => ({ assetId: a.id, jobId: job.id, expiresAt: new Date(Math.min(a.expiresAt.getTime(), job.waitDeadline.getTime() + 3600_000)) })) });
    await tx.idempotencyRecord.create({ data: { userId: buyerId, endpoint: 'jobs', key, fingerprint, response: { jobId: job.id } } });
    await hooks?.afterCreate(tx, job.id);
    await tx.auditEvent.create({ data: { actorId: buyerId, sellerId: cap.sellerId, jobId: job.id, type: 'JOB_CREATED', metadata: { versionId: version.id, priceTierId: price.id } } });
    return job.id;
  }).catch(async error => {
    if (error instanceof ApiError && error.code === 'CAPABILITY_QUEUE_FULL') {
      try { await recordQueueFullRejection(ctx, buyerId, body.capabilityId, key); }
      catch { ctx.app.log.warn({ code: 'CAPACITY_REJECTION_TELEMETRY_FAILED' }, 'Could not record a queue-full rejection'); }
    }
    throw error;
  });
  await ctx.wake();
  return getJob(ctx, jobId, buyerId);
}

export function registerJobs(app: FastifyInstance, ctx: ApiContext) {
  app.get('/api/jobs', async request => {
    const { user } = requireIdentity(request, 'jobs:read');
    const jobs = await ctx.db.job.findMany({ where: { buyerId: user.id }, include: jobInclude, take: 100, orderBy: { createdAt: 'desc' } });
    const reasons = await jobWaitReasons(ctx, jobs);
    return jobs.map(job => jobDto(job, true, reasons.get(job.id)));
  });
  app.get('/api/seller/jobs', async request => {
    const { user } = requireIdentity(request);
    const jobs = await ctx.db.job.findMany({ where: { sellerId: user.id }, include: jobInclude, take: 100, orderBy: { createdAt: 'desc' } });
    const reasons = await jobWaitReasons(ctx, jobs);
    return jobs.map(job => jobDto(job, job.buyerId === user.id || !!job.activeAttempt?.acceptedAt, reasons.get(job.id)));
  });
  app.get('/api/jobs/:id', async request => {
    const { user, kind } = requireIdentity(request, 'jobs:read');
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const job = await getJob(ctx, id, user.id, user.isAdmin && kind === 'session');
    if (kind === 'api-key' && job.buyerId !== user.id) throw new ApiError(404, 'NOT_FOUND', 'Job not found');
    return job;
  });
  app.post('/api/jobs', async (request, reply) => {
    const { user } = requireIdentity(request, 'jobs:create');
    const job = await createJob(ctx, user.id, CreateJobSchema.parse(request.body), idempotencyKey(request));
    reply.code(201); return job;
  });
  app.post('/api/capabilities/:id/quote', async request => {
    const { user } = requireIdentity(request, 'jobs:create');
    const { executionMode } = z.object({ executionMode: z.enum(['NOW', 'SCHEDULED']) }).strict().parse(request.body);
    const cap = await loadCapability(ctx.db, (request.params as { id: string }).id);
    await assertCapabilityAccess(ctx.db, cap, user.id);
    const version = requireValue(cap.currentVersion);
    const available = await availability(ctx, cap);
    if (executionMode === 'NOW' && !available.canRunNow && !available.canQueue) throw new ApiError(409, `CAPABILITY_${available.status}`, available.reason ?? 'Unavailable');
    if (['PAUSED', 'SECURITY_BLOCKED', 'OFFLINE'].includes(available.status)) throw new ApiError(409, `CAPABILITY_${available.status}`, available.reason ?? 'Unavailable');
    const earliest = executionMode === 'NOW' ? new Date(Date.now() + available.estimatedQueueWaitSeconds * 1000).toISOString()
      : (await serializable(ctx.db, async tx => {
        await lockCapacity(tx, cap.id);
        const current = await loadCapability(tx, cap.id);
        return scheduledAdmission(ctx, tx, current, await availability(ctx, current, tx), new Date());
      })).toISOString();
    if (!earliest) throw new ApiError(409, 'NO_EXECUTION_WINDOW', 'No execution window is available');
    const quote = await ctx.db.scheduleQuote.create({ data: { buyerId: user.id, capabilityId: cap.id, capabilityVersionId: version.id,
      executionMode, priceSnapshot: json(getPriceTier(version.priceTierId)), earliestStartAt: new Date(earliest),
      estimatedDeliveryAt: new Date(Date.parse(earliest) + version.estimatedDurationSeconds * 1000), expiresAt: new Date(Date.now() + 5 * 60_000) } });
    return { id: quote.id, priceSnapshot: quote.priceSnapshot, earliestStartAt: quote.earliestStartAt.toISOString(), estimatedDeliveryAt: quote.estimatedDeliveryAt.toISOString(), expiresAt: quote.expiresAt.toISOString() };
  });
  for (const action of ['cancel', 'pause', 'resume'] as const) app.post(`/api/jobs/:id/${action}`, async request => {
    const { user, kind } = requireIdentity(request, action === 'cancel' ? 'jobs:create' : undefined);
    const control = z.object({ confirmGlobalPause: z.boolean().optional() }).strict().parse(request.body ?? {});
    if (action !== 'resume' && control.confirmGlobalPause !== undefined) throw new ApiError(400, 'INVALID_JOB_CONTROL', 'Pause confirmation only applies to resuming an existing job');
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    await serializable(ctx.db, async tx => {
      const job = requireValue(await tx.job.findUnique({ where: { id }, include: { activeAttempt: true, capability: true } }));
      const seller = kind === 'session' && job.sellerId === user.id;
      const admin = kind === 'session' && user.isAdmin;
      if (!seller && !admin && job.buyerId !== user.id) throw new ApiError(404, 'NOT_FOUND', 'Job not found');
      if (action === 'cancel') {
        if (!seller && !admin && job.startedAt) throw new ApiError(409, 'JOB_ALREADY_STARTED', 'Contact support to cancel a job that has started');
        if (job.state === 'CANCELLED') return;
        if (terminalStates.includes(job.state as typeof terminalStates[number])) throw new ApiError(409, 'JOB_TERMINAL', 'Completed jobs cannot be cancelled');
        await failJob(tx, job, 'CANCELLED', 'Job cancelled', { source: 'ACCOUNT_API', actorId: user.id });
      } else {
        if (!seller && !admin) throw new ApiError(403, 'FORBIDDEN', 'Only the seller or administrator can control execution');
        if (!terminalStates.includes(job.state as typeof terminalStates[number]) && jobPauseExpired(job)) {
          await failJob(tx, job, 'TIMED_OUT', 'Cumulative pause budget exceeded'); return;
        }
        const desired = action === 'pause' ? 'PAUSE_REQUESTED' : 'RESUMING';
        if (job.state === desired || (action === 'pause' && job.state === 'PAUSED') || (action === 'resume' && job.state === 'RUNNING')) return;
        if (action === 'pause' && job.state !== 'RUNNING') throw new ApiError(409, 'PAUSE_NOT_SUPPORTED_IN_CURRENT_STAGE', 'Pausing is supported only while the job is running');
        if (!job.activeAttempt) throw new ApiError(409, 'NO_ACTIVE_EXECUTION', 'Job has no active worker execution');
        if (action === 'resume') {
          await assertWorkerJobDataPolicy(tx, job.id, job.activeAttempt.workerId);
          const worker = requireValue(await tx.workerDevice.findUnique({ where: { id: job.activeAttempt.workerId } }));
          const version = await tx.capabilityVersion.findUniqueOrThrow({ where: { id: job.capabilityVersionId } });
          await assertExecutionPolicy(tx, version.category, worker);
          if (worker.revokedAt || job.capability.securityBlocked || !isScheduleOpen(ScheduleSchema.parse(job.capability.schedule))) throw new ApiError(409, 'RESUME_BLOCKED', 'Worker, security policy, or execution schedule blocks resuming');
          if ((worker.paused || worker.localPaused) && control.confirmGlobalPause !== true) throw new ApiError(409, 'GLOBAL_PAUSE_CONFIRMATION_REQUIRED', 'Worker is paused for new jobs. Confirm resuming this existing job only.');
        }
        await transition(tx, job, desired, action === 'pause' ? 'Waiting for worker to confirm pause' : 'Waiting for worker to resume execution', { source: 'ACCOUNT_API', actorId: user.id });
        await tx.workerCommand.create({ data: { workerId: job.activeAttempt.workerId, jobId: job.id, type: action === 'pause' ? 'PAUSE_JOB' : 'RESUME_JOB', resumeWhilePaused: action === 'resume' && control.confirmGlobalPause === true } });
      }
      await tx.auditEvent.create({ data: { actorId: user.id, sellerId: job.sellerId, jobId: job.id, type: `JOB_${action.toUpperCase()}_REQUESTED`, metadata: { resumeWhilePaused: action === 'resume' && control.confirmGlobalPause === true } } });
    });
    await ctx.wake();
    return getJob(ctx, id, user.id, user.isAdmin);
  });
}
