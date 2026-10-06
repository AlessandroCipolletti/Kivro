import semver from 'semver';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { json, serializable, type PrismaClient, type Transaction, type WorkerDevice } from '@kivro/database';
import type { ApiContext } from './context.js';
import { requireAdmin } from './auth.js';
import { ApiError, requireValue } from './errors.js';
import { containJobExecution, releaseContainedJobs } from './job-containment.js';
import { jobPauseExpired } from './job-timing.js';

const version = z.string().max(100).refine(value => !!semver.valid(value), 'A valid semantic version is required');
export const SecurityPolicySchema = z.object({ revision: z.number().int().nonnegative().default(0),
  minimumWorkerVersion: version.default('0.1.0'), minimumOpenClawVersion: version.default('2026.8.2'),
  revokedWorkerVersions: z.array(version).max(100).default([]), revokedOpenClawVersions: z.array(version).max(100).default([]),
  blockedCategories: z.array(z.string().trim().min(1).max(100)).max(100).default([]) }).strict();
export type SecurityPolicy = z.infer<typeof SecurityPolicySchema>;
export const securityPolicyKey = 'operatorSecurityPolicy';
export async function loadSecurityPolicy(db: PrismaClient | Transaction): Promise<SecurityPolicy> {
  return SecurityPolicySchema.parse((await db.platformSetting.findUnique({ where: { key: securityPolicyKey } }))?.value ?? {});
}
export function workerPolicyReason(worker: Pick<WorkerDevice, 'version' | 'openclawVersion'>, policy: SecurityPolicy): string | null {
  const runtime = /^(?:OpenClaw )?(\d+\.\d+\.\d+)(?: \([a-f0-9]{7,40}\))?$/.exec(worker.openclawVersion ?? '')?.[1];
  if (!semver.valid(worker.version) || semver.lt(worker.version, policy.minimumWorkerVersion)) return 'WORKER_UPDATE_REQUIRED';
  if (policy.revokedWorkerVersions.includes(worker.version)) return 'WORKER_VERSION_REVOKED';
  if (!runtime || !semver.valid(runtime) || semver.lt(runtime, policy.minimumOpenClawVersion)) return 'OPENCLAW_UPDATE_REQUIRED';
  if (policy.revokedOpenClawVersions.includes(runtime)) return 'OPENCLAW_VERSION_REVOKED';
  return null;
}
export function categoryPolicyBlocked(category: string, policy: SecurityPolicy) {
  return policy.blockedCategories.some(blocked => blocked.toLowerCase() === category.toLowerCase());
}
export async function assertExecutionPolicy(db: PrismaClient | Transaction, category: string, worker?: Pick<WorkerDevice, 'version' | 'openclawVersion'>) {
  const policy = await loadSecurityPolicy(db);
  const reason = categoryPolicyBlocked(category, policy) ? 'CATEGORY_BLOCKED' : worker ? workerPolicyReason(worker, policy) : null;
  if (reason) throw new ApiError(409, reason, 'Operator security policy blocks this execution');
}

export async function assertWorkerJobDataPolicy(db: PrismaClient | Transaction, jobId: string, workerId: string) {
  const job = requireValue(await db.job.findUnique({ where: { id: jobId }, select: {
    executionRevokedAt: true, maxPauseMs: true, pausedDurationMs: true, pausedAt: true, buyer: { select: { suspendedAt: true } },
    version: { select: { category: true } }, capability: { select: { securityBlocked: true } },
    activeAttempt: { select: { workerId: true, worker: { include: { seller: { select: { suspendedAt: true } } } } } },
  } }));
  const worker = job.activeAttempt?.worker;
  if (!worker || job.activeAttempt!.workerId !== workerId || job.executionRevokedAt || job.buyer.suspendedAt || worker.revokedAt || worker.seller.suspendedAt || job.capability.securityBlocked) {
    throw new ApiError(403, 'EXECUTION_ACCESS_REVOKED', 'Execution data access was revoked');
  }
  if (jobPauseExpired(job)) throw new ApiError(409, 'PAUSE_BUDGET_EXCEEDED', 'Cumulative pause budget exceeded');
  await assertExecutionPolicy(db, job.version.category, worker);
}

export function registerSecurityPolicy(app: FastifyInstance, ctx: ApiContext) {
  app.get('/api/admin/security-policy', async request => { requireAdmin(request); return loadSecurityPolicy(ctx.db); });
  app.put('/api/admin/security-policy', async request => {
    const user = requireAdmin(request);
    const body = z.object({ policy: SecurityPolicySchema, expectedRevision: z.number().int().nonnegative(), reason: z.string().trim().min(10).max(1000) }).strict().parse(request.body);
    const result = await serializable(ctx.db, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${securityPolicyKey}, 0))`;
      const previous = await loadSecurityPolicy(tx);
      if (previous.revision !== body.expectedRevision) throw new ApiError(409, 'POLICY_CHANGED', 'Security policy changed; reload before editing');
      const next = SecurityPolicySchema.parse({ ...body.policy, revision: previous.revision + 1 });
      await tx.platformSetting.upsert({ where: { key: securityPolicyKey }, create: { key: securityPolicyKey, value: json(next) }, update: { value: json(next) } });
      await tx.auditEvent.create({ data: { actorId: user.id, type: 'SECURITY_POLICY_CHANGED', metadata: json({ previous, next, reason: body.reason }) } });
      return next;
    });
    await ctx.wake(); return result;
  });
  app.get('/api/admin/workers', async request => {
    requireAdmin(request);
    const policy = await loadSecurityPolicy(ctx.db);
    const workers = await ctx.db.workerDevice.findMany({ take: 200, orderBy: { lastSeenAt: 'desc' },
      select: { id: true, sellerId: true, name: true, version: true, openclawVersion: true, revokedAt: true, paused: true, localPaused: true, sandboxReady: true, lastSeenAt: true } });
    return workers.map(worker => ({ ...worker, policyReason: workerPolicyReason(worker, policy), minimumWorkerVersion: policy.minimumWorkerVersion, minimumOpenClawVersion: policy.minimumOpenClawVersion }));
  });
  app.get('/api/admin/capabilities', async request => {
    requireAdmin(request);
    return ctx.db.capability.findMany({ take: 200, orderBy: { updatedAt: 'desc' }, select: { id: true, sellerId: true, paused: true, securityBlocked: true,
      visibility: true, currentVersion: { select: { title: true, category: true, version: true } } } });
  });
  app.post('/api/admin/capabilities/:id/security', async request => {
    const user = requireAdmin(request), id = z.string().uuid().parse((request.params as { id: string }).id);
    const { blocked, reason } = z.object({ blocked: z.boolean(), reason: z.string().trim().min(10).max(1000) }).strict().parse(request.body);
    const affected = await serializable(ctx.db, async tx => {
      const cap = requireValue(await tx.capability.findUnique({ where: { id } }));
      await tx.capability.update({ where: { id }, data: { securityBlocked: blocked, lifecycleRevision: { increment: 1 } } });
      const jobs = blocked ? await containJobExecution(tx, { capabilityId: id }, 'Operator blocked this capability') : [];
      await tx.auditEvent.create({ data: { actorId: user.id, sellerId: cap.sellerId, type: 'CAPABILITY_SECURITY_CHANGED', metadata: { capabilityId: id, blocked, reason } } });
      return jobs;
    });
    await releaseContainedJobs(ctx, affected);
    await ctx.wake(); return { ok: true };
  });
  app.post('/api/admin/workers/:id/revoke', async request => {
    const user = requireAdmin(request), id = z.string().uuid().parse((request.params as { id: string }).id);
    const { reason } = z.object({ reason: z.string().trim().min(10).max(1000) }).strict().parse(request.body);
    const affected = await serializable(ctx.db, async tx => {
      const worker = requireValue(await tx.workerDevice.findUnique({ where: { id } }));
      await tx.workerDevice.update({ where: { id }, data: { revokedAt: worker.revokedAt ?? new Date(), paused: true, sandboxReady: false } });
      await tx.workerBinding.updateMany({ where: { workerId: id }, data: { healthy: false } });
      const jobs = await containJobExecution(tx, { activeAttempt: { workerId: id } }, 'Operator revoked this Worker device');
      await tx.auditEvent.create({ data: { actorId: user.id, sellerId: worker.sellerId, workerId: id, type: 'WORKER_ADMIN_REVOKED', metadata: { reason } } });
      return jobs;
    });
    await releaseContainedJobs(ctx, affected);
    await ctx.wake(); return { ok: true };
  });
}
