import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CreateCapabilitySchema, IOContractSchema, PermissionManifestSchema, DependencySchema, ScheduleSchema,
  DEFAULT_SCHEDULE, getPriceTier, executionManifestHash, executionFileCompatibilityIssues, type CapabilityDTO } from '@kivro/contracts';
import { assertPublishable, evaluateAvailability, nextScheduledTime } from '@kivro/policy-engine';
import { assertWorkerPermissions } from '@kivro/openclaw-adapter';
import { json, serializable, type Prisma, type PrismaClient, type Transaction } from '@kivro/database';
import type { FastifyInstance } from 'fastify';
import type { ApiContext } from './context.js';
import { requireIdentity } from './auth.js';
import { ApiError, requireValue } from './errors.js';
import { assertLifecycleRevision, lockCapability, registerCapabilityLifecycle, requireDiffReview, versionReadiness } from './capability-lifecycle.js';
import { registerCatalogPages } from './catalog-page.js';
import { categoryPolicyBlocked, loadSecurityPolicy, workerPolicyReason, type SecurityPolicy } from './security-policy.js';
import { registerCatalogReviews } from './catalog-reviews.js';
import { exampleDtos, preserveExampleEvidence } from './example-assets.js';
import { pendingAdmission, pendingCapacity, type PendingCapacity } from './pending-capacity.js';
import { sellerCapabilityLiveState } from './capability-live-state.js';
import type { SellerCapabilityLiveState } from '@kivro/contracts/responses';
import { publicationEvidence } from './publication-evidence.js';

export const activeStates = ['OFFERED', 'ACCEPTED', 'RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'RESUMING', 'UPLOADING_RESULTS', 'VALIDATING_RESULTS'] as const;
export const terminalStates = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const;
export const capabilityInclude = { seller: true, currentVersion: true, draftVersion: true, versions: { orderBy: { version: 'desc' }, take: 1 } } satisfies Prisma.CapabilityInclude;
export type CapabilityRecord = Prisma.CapabilityGetPayload<{ include: typeof capabilityInclude }>;
type Db = PrismaClient | Transaction;

export function assertRuntimeContract(ioContract: unknown): void {
  const issues = executionFileCompatibilityIssues(IOContractSchema.parse(ioContract));
  if (issues.length) throw new ApiError(409, 'UNSUPPORTED_RUNTIME_CONTRACT', 'The current worker cannot process every declared file format', { issues });
}

export async function loadCapability(db: Db, idOrSlug: string): Promise<CapabilityRecord> {
  const where: Prisma.CapabilityWhereInput = z.string().uuid().safeParse(idOrSlug).success ? { OR: [{ id: idOrSlug }, { slug: idOrSlug }] } : { slug: idOrSlug };
  return requireValue(await db.capability.findFirst({ where, include: capabilityInclude }));
}
export async function assertCapabilityAccess(db: Db, capability: CapabilityRecord, userId?: string): Promise<void> {
  if (userId === capability.sellerId) return;
  if (capability.seller.suspendedAt || !capability.currentVersion || capability.visibility === 'DRAFT') throw new ApiError(404, 'NOT_FOUND', 'Capability not found');
  if (capability.visibility === 'PRIVATE' && (!userId || !await db.capabilityGrant.findUnique({ where: { capabilityId_userId: { capabilityId: capability.id, userId } } }))) throw new ApiError(404, 'NOT_FOUND', 'Capability not found');
}

type RuntimeEvidence = { bindings: Prisma.WorkerBindingGetPayload<{ include: { worker: true } }>[], runningJobs: number; queueDepth: number;
  occupiedWorkerIds?: string[]; securityPolicy?: SecurityPolicy };
export type AvailabilityEvidence = RuntimeEvidence & { pending?: PendingCapacity };
export async function runtimeAvailability(ctx: ApiContext, capability: CapabilityRecord, db: Db = ctx.db, evidence?: RuntimeEvidence) {
  const version = capability.currentVersion ?? capability.draftVersion;
  const securityPolicy = evidence?.securityPolicy ?? await loadSecurityPolicy(db);
  const bindings = evidence?.bindings ?? (version ? await db.workerBinding.findMany({ where: { capabilityVersionId: version.id, healthy: true, validationStatus: 'PASSED',
    validatedManifestHash: version.manifestHash, validatedAt: { gt: new Date(Date.now() - 24 * 3600_000) } }, include: { worker: true } }) : []);
  const workers = bindings.map(b => b.worker).filter(w => !w.revokedAt && w.lastSeenAt && w.lastSeenAt.getTime() > Date.now() - ctx.config.heartbeatTtlMs);
  const ready = workers.filter(w => w.sandboxReady && !w.paused && !w.localPaused && !workerPolicyReason(w, securityPolicy));
  const runningJobs = evidence?.runningJobs ?? await db.job.count({ where: { capabilityId: capability.id, state: { in: [...activeStates] } } });
  const queueDepth = evidence?.queueDepth ?? await db.job.count({ where: { capabilityId: capability.id, state: 'QUEUED' } });
  const readyIds = new Set(ready.map(worker => worker.id));
  const occupiedIds = evidence?.occupiedWorkerIds ?? (readyIds.size ? (await db.job.findMany({
    where: { state: { in: [...activeStates] }, activeAttempt: { workerId: { in: [...readyIds] } } },
    select: { activeAttempt: { select: { workerId: true } } },
  })).flatMap(job => job.activeAttempt ? [job.activeAttempt.workerId] : []) : []);
  const freeDeviceSlots = readyIds.size - new Set(occupiedIds.filter(id => readyIds.has(id))).size;
  const effectiveConcurrency = Math.min(capability.concurrency, readyIds.size);
  const immediateSlots = Math.min(Math.max(0, capability.concurrency - runningJobs), freeDeviceSlots);
  // Keep the UI's own-capability count intact. Policy load accounts for physical
  // slots held by any active attempt, including immutable historical versions.
  const capacityLoad = Math.max(0, effectiveConcurrency - immediateSlots) + Math.max(0, runningJobs - capability.concurrency);
  const dependencies = version ? z.array(DependencySchema).parse(version.dependencies) : [];
  let dependenciesHealthy = false;
  if (version) {
    try { assertPublishable(PermissionManifestSchema.parse(version.permissions), dependencies); assertWorkerPermissions(version.permissions); assertRuntimeContract(version.ioContract); dependenciesHealthy = executionManifestHash(version) === version.manifestHash; }
    catch { /* Unsupported or unapproved declarations cannot accept purchases. */ }
  }
  const schedule = ScheduleSchema.parse(capability.schedule);
  const policyContext = { schedule, workerOnline: workers.length > 0, sandboxReady: ready.length > 0,
    paused: capability.paused || (workers.length > 0 && ready.length === 0 && workers.every(w => w.paused || w.localPaused)),
    securityBlocked: capability.securityBlocked || !!capability.seller.suspendedAt || !!version && categoryPolicyBlocked(version.category, securityPolicy) || (ctx.config.paymentMode === 'stripe' && capability.seller.connectStatus !== 'READY'),
    runningJobs: capacityLoad, concurrency: effectiveConcurrency, queueDepth, maxQueue: capability.maxQueue,
    dependenciesHealthy,
  };
  const result = evaluateAvailability(policyContext);
  const estimatedQueueWaitSeconds = result.status === 'BUSY' && version ? Math.ceil((capacityLoad + queueDepth) / Math.max(1, effectiveConcurrency)) * version.estimatedDurationSeconds : 0;
  return { ...result, policyContext, estimatedQueueWaitSeconds, runningJobs, queueDepth, effectiveConcurrency, capacityLoad, readyWorkers: ready, nextWindow: nextScheduledTime(schedule, new Date()) };
}

export async function availability(ctx: ApiContext, capability: CapabilityRecord, db: Db = ctx.db, evidence?: AvailabilityEvidence) {
  const runtime = await runtimeAvailability(ctx, capability, db, evidence);
  if (!['ONLINE', 'BUSY'].includes(runtime.status)) return { ...runtime, pendingAdmissionAllowed: false, pendingAdmissionCreatedAt: undefined };
  const plan = evidence?.pending ?? await pendingCapacity(ctx, db, capability.sellerId);
  const admission = pendingAdmission(plan, capability, runtime.readyWorkers.map(worker => worker.id));
  const capacityLoad = Math.max(0, runtime.effectiveConcurrency - admission.freeSlots) + Math.max(0, runtime.runningJobs - capability.concurrency);
  // Matched pending jobs hold execution slots; only unmatched jobs use queue
  // allowance. Keep both actual UI counts independent from these policy inputs.
  const result = evaluateAvailability({ ...runtime.policyContext, runningJobs: capacityLoad, queueDepth: admission.waiting });
  const version = capability.currentVersion ?? capability.draftVersion;
  const estimatedQueueWaitSeconds = result.status === 'BUSY' && version
    ? Math.ceil((capacityLoad + admission.waiting) / Math.max(1, runtime.effectiveConcurrency)) * version.estimatedDurationSeconds : 0;
  return { ...runtime, ...result, canRunNow: result.canRunNow && admission.allowed, canQueue: result.canQueue === true && admission.allowed,
    capacityLoad, estimatedQueueWaitSeconds, pendingAdmissionAllowed: admission.allowed, pendingAdmissionCreatedAt: admission.createdAt };
}

export type CatalogMetrics = { availability: Awaited<ReturnType<typeof availability>>; rating: number | null; reviewCount: number; completedJobs: number; totalJobs: number; isFavorite: boolean };
export async function capabilityDto(ctx: ApiContext, capability: CapabilityRecord, viewerId?: string, sellerView = false, metrics?: CatalogMetrics): Promise<CapabilityDTO & { liveState?: SellerCapabilityLiveState }> {
  const version = requireValue((sellerView ? capability.draftVersion ?? capability.currentVersion : capability.currentVersion ?? capability.draftVersion) ?? capability.versions?.[0]);
  const avail = metrics?.availability ?? await availability(ctx, capability);
  const stats = metrics ? { _avg: { rating: metrics.rating }, _count: metrics.reviewCount } : await ctx.db.review.aggregate({ where: { capabilityId: capability.id }, _avg: { rating: true }, _count: true });
  const completedJobs = metrics?.completedJobs ?? await ctx.db.job.count({ where: { capabilityId: capability.id, state: 'SUCCEEDED' } });
  const totalJobs = metrics?.totalJobs ?? await ctx.db.job.count({ where: { capabilityId: capability.id, state: { in: [...terminalStates] } } });
  const permissions = PermissionManifestSchema.parse(version.permissions);
  if (!sellerView) {
    delete permissions.inference.credentialRef;
    permissions.resources = permissions.resources.map((resource, index) => ({ id: `resource-${index + 1}`,
      type: ['DATABASE', 'POSTGRES', 'DATASET', 'LOCAL_FILE', 'LOCAL_DIRECTORY', 'PRIVATE_API'].includes(resource.type.toUpperCase()) ? resource.type.toUpperCase() : 'READ_ONLY_RESOURCE', access: 'READ_ONLY' }));
  }
  const internalDependencies = z.array(DependencySchema).parse(version.dependencies);
  // Public consumers receive categories, never seller identifiers, graph edges,
  // content hashes, credential nodes or private implementation labels.
  const publicNames: Record<string, string> = { INFERENCE: 'AI inference', SKILL: 'Approved skills', RESOURCE: 'Read-only resources', NETWORK: 'Controlled network access', RUNTIME: 'Execution runtime', TOOL: 'Approved tools' };
  const groups = new Map<string, typeof internalDependencies>();
  for (const dependency of internalDependencies) {
    if (dependency.type.toUpperCase().includes('CREDENTIAL') || dependency.type.toUpperCase().includes('SECRET')) continue;
    const category = publicNames[dependency.type.toUpperCase()] ? dependency.type.toUpperCase() : 'RUNTIME';
    groups.set(category, [...groups.get(category) ?? [], dependency]);
  }
  const dependencies = sellerView ? internalDependencies : [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([type, nodes]) => ({
    id: `public-${type.toLowerCase()}`, name: publicNames[type]!, type, required: nodes.some(node => node.required), approved: nodes.every(node => node.approved),
    healthy: nodes.every(node => node.healthy), supported: nodes.every(node => node.supported === true), confidence: 'DECLARED' as const,
  }));
  const dto: CapabilityDTO & { liveState?: SellerCapabilityLiveState } = {
    id: capability.id, slug: capability.slug, title: version.title, summary: version.summary, description: version.description,
    category: version.category, tags: version.tags, seller: { id: capability.seller.id, name: capability.seller.name, ...(capability.seller.bio ? { bio: capability.seller.bio } : {}) },
    visibility: capability.visibility, version: version.version, versionId: version.id, priceTierId: version.priceTierId,
    ioContract: IOContractSchema.parse(version.ioContract), permissions, dependencies,
    availability: { status: avail.status, canRunNow: avail.canRunNow, canQueue: avail.canQueue, nextAvailableAt: avail.nextAvailableAt, reason: avail.reason,
      estimatedQueueWaitSeconds: avail.estimatedQueueWaitSeconds },
    pauseSupport: 'FULL_RESUME', dataProcessing: { assetRetentionDays: ctx.config.assetRetentionDays,
      jobContentRetentionDays: ctx.config.jobContentRetentionDays, inferenceProvider: permissions.inference.provider, inferenceModel: permissions.inference.model, privateSellerRuntime: true },
    executionFileLimits: { singleFileBytes: Math.min(ctx.config.fileLimits.workerFileBytes, ctx.config.maxUploadBytes),
      inputBytes: Math.min(ctx.config.fileLimits.inputBytes, permissions.limits.maxInputBytes), outputBytes: Math.min(ctx.config.fileLimits.outputBytes, permissions.limits.maxOutputBytes) },
    ...(sellerView ? { schedule: ScheduleSchema.parse(capability.schedule), lifecycleRevision: capability.lifecycleRevision,
      liveState: await sellerCapabilityLiveState(ctx.db, capability.sellerId, capability.id, { runningJobs: avail.runningJobs,
        queueDepth: avail.queueDepth, effectiveConcurrency: avail.effectiveConcurrency, capacityLoad: avail.capacityLoad }),
      concurrency: capability.concurrency, maxQueue: capability.maxQueue, maxScheduled: capability.maxScheduled,
      currentVersionId: capability.currentVersionId, draftVersionId: capability.draftVersionId } : {}),
    estimatedDurationSeconds: version.estimatedDurationSeconds, successRate: totalJobs ? completedJobs / totalJobs : null,
    completedJobs, rating: stats._avg.rating, reviewCount: stats._count,
    isFavorite: metrics?.isFavorite ?? (viewerId ? !!await ctx.db.favorite.findUnique({ where: { userId_capabilityId: { userId: viewerId, capabilityId: capability.id } } }) : false),
    examples: await exampleDtos(ctx, capability, version, sellerView),
  };
  return dto;
}

export function manifestHash(version: { ioContract: unknown; permissions: unknown; internalInstructions: string; dependencies: unknown }): string {
  return executionManifestHash(version);
}

export function registerCatalog(app: FastifyInstance, ctx: ApiContext) {
  registerCapabilityLifecycle(app, ctx);
  registerCatalogPages(app, ctx);
  registerCatalogReviews(app, ctx);
  app.get('/api/capabilities', async request => {
    if (request.identity?.kind === 'api-key') requireIdentity(request, 'capabilities:read');
    const query = z.object({ q: z.string().max(200).optional(), category: z.string().max(100).optional(), availability: z.string().optional(),
      maxPrice: z.coerce.number().int().nonnegative().optional(), favorites: z.enum(['true', 'false']).optional() }).parse(request.query);
    const userId = request.identity?.user.id;
    if (query.favorites === 'true' && !userId) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to see favorites');
    const where: Prisma.CapabilityWhereInput = {
      visibility: 'PUBLIC', currentVersionId: { not: null }, seller: { suspendedAt: null },
      ...(query.favorites === 'true' ? { favorites: { some: { userId } } } : {}),
      currentVersion: { is: { ...(query.category ? { category: query.category } : {}), ...(query.q ? { OR: [
        { title: { contains: query.q, mode: 'insensitive' } }, { summary: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } }, { tags: { has: query.q } },
      ] } : {}) } },
    };
    const records = await ctx.db.capability.findMany({ where, include: capabilityInclude, take: 100, orderBy: { createdAt: 'desc' } });
    const results = await Promise.all(records.map(c => capabilityDto(ctx, c, userId)));
    return results.filter(c => (!query.availability || query.availability === 'ALL' || c.availability.status === query.availability || (query.availability === 'NOW' && c.availability.canRunNow)) &&
      (query.maxPrice === undefined || getPriceTier(c.priceTierId).buyerPriceMinor <= query.maxPrice));
  });
  app.get('/api/capabilities/:idOrSlug', async request => {
    if (request.identity?.kind === 'api-key') requireIdentity(request, 'capabilities:read');
    const { idOrSlug } = request.params as { idOrSlug: string };
    const capability = await loadCapability(ctx.db, idOrSlug);
    await assertCapabilityAccess(ctx.db, capability, request.identity?.user.id);
    return capabilityDto(ctx, capability, request.identity?.user.id);
  });
  app.post('/api/capabilities/:id/favorite', async request => {
    const { user } = requireIdentity(request);
    const capability = await loadCapability(ctx.db, (request.params as { id: string }).id);
    await assertCapabilityAccess(ctx.db, capability, user.id);
    return serializable(ctx.db, async tx => {
      const key = { userId_capabilityId: { userId: user.id, capabilityId: capability.id } };
      if (await tx.favorite.findUnique({ where: key })) { await tx.favorite.delete({ where: key }); return { isFavorite: false }; }
      await tx.favorite.create({ data: { userId: user.id, capabilityId: capability.id } });
      return { isFavorite: true };
    });
  });
  app.get('/api/seller/capabilities', async request => {
    const { user } = requireIdentity(request);
    const caps = await ctx.db.capability.findMany({ where: { sellerId: user.id }, include: capabilityInclude, orderBy: { createdAt: 'desc' } });
    return Promise.all(caps.map(async c => ({ ...await capabilityDto(ctx, c, user.id, true),
      internalInstructions: (c.draftVersion ?? c.currentVersion)?.internalInstructions,
      manifestHash: (c.draftVersion ?? c.currentVersion)?.manifestHash,
      testPassedAt: (c.draftVersion ?? c.currentVersion)?.testPassedAt, paused: c.paused,
      concurrency: c.concurrency, maxQueue: c.maxQueue, maxScheduled: c.maxScheduled, currentVersionId: c.currentVersionId, draftVersionId: c.draftVersionId,
      lifecycleRevision: c.lifecycleRevision,
    })));
  });
  app.post('/api/seller/capabilities', async request => {
    const { user } = requireIdentity(request);
    const body = CreateCapabilitySchema.parse(request.body);
    if (body.workerId) requireValue(await ctx.db.workerDevice.findFirst({ where: { id: body.workerId, sellerId: user.id, revokedAt: null } }));
    const capability = await serializable(ctx.db, async tx => {
      const slug = `${body.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'capability'}-${randomUUID().slice(0, 8)}`;
      const cap = await tx.capability.create({ data: { sellerId: user.id, slug, schedule: json(body.schedule ?? DEFAULT_SCHEDULE),
        concurrency: body.concurrency, maxQueue: body.maxQueue, maxScheduled: body.maxScheduled } });
      const version = await tx.capabilityVersion.create({ data: {
        capabilityId: cap.id, version: 1, title: body.title, summary: body.summary, description: body.description,
        category: body.category, tags: body.tags, priceTierId: body.priceTierId, ioContract: json(body.ioContract), permissions: json(body.permissions),
        dependencies: json(body.dependencies), internalInstructions: body.internalInstructions, manifestHash: manifestHash(body),
        examples: json(body.examples ?? []), estimatedDurationSeconds: body.estimatedDurationSeconds,
      } });
      if (body.workerId) await tx.workerBinding.create({ data: { workerId: body.workerId, capabilityVersionId: version.id } });
      await tx.auditEvent.create({ data: { actorId: user.id, sellerId: user.id, type: 'CAPABILITY_CREATED', metadata: { capabilityId: cap.id, versionId: version.id } } });
      return tx.capability.update({ where: { id: cap.id }, data: { draftVersionId: version.id }, include: capabilityInclude });
    });
    return capabilityDto(ctx, capability, user.id, true);
  });
  app.put('/api/seller/capabilities/:id', async request => {
    const { user } = requireIdentity(request);
    const { expectedRevision, ...body } = CreateCapabilitySchema.partial().extend({ expectedRevision: z.number().int().nonnegative().optional() }).parse(request.body);
    const capacityKeys = ['concurrency', 'maxQueue', 'maxScheduled'] as const;
    const hasCapacity = capacityKeys.some(key => body[key] !== undefined);
    if (hasCapacity && expectedRevision === undefined) throw new ApiError(400, 'CAPACITY_REVISION_REQUIRED', 'Reload capacity settings and supply the current lifecycle revision');
    const capability = await serializable(ctx.db, async tx => {
      await lockCapability(tx, (request.params as { id: string }).id);
      const cap = await loadCapability(tx, (request.params as { id: string }).id);
      if (cap.sellerId !== user.id) throw new ApiError(404, 'NOT_FOUND', 'Capability not found');
      assertLifecycleRevision(cap, expectedRevision);
      const previousCapacity = { concurrency: cap.concurrency, maxQueue: cap.maxQueue, maxScheduled: cap.maxScheduled };
      const nextCapacity = { concurrency: body.concurrency ?? cap.concurrency, maxQueue: body.maxQueue ?? cap.maxQueue, maxScheduled: body.maxScheduled ?? cap.maxScheduled };
      const capacityChanged = capacityKeys.some(key => nextCapacity[key] !== previousCapacity[key]);
      if (capacityChanged) await tx.auditEvent.create({ data: { actorId: user.id, sellerId: user.id, type: 'CAPACITY_UPDATED',
        metadata: { capabilityId: cap.id, previous: previousCapacity, next: nextCapacity, previousRevision: cap.lifecycleRevision, lifecycleRevision: cap.lifecycleRevision + 1 } } });
      // Capacity is live scheduling policy, not a new execution definition. Existing jobs drain unchanged.
      if (hasCapacity && Object.keys(body).every(key => capacityKeys.some(field => field === key))) {
        return capacityChanged ? tx.capability.update({ where: { id: cap.id }, data: { ...nextCapacity, lifecycleRevision: { increment: 1 } }, include: capabilityInclude }) : cap;
      }
      const prior = requireValue(cap.draftVersion ?? cap.currentVersion ?? cap.versions[0]);
      const merged = CreateCapabilitySchema.parse({ title: prior.title, summary: prior.summary, description: prior.description,
        category: prior.category, tags: prior.tags, priceTierId: prior.priceTierId, ioContract: prior.ioContract, permissions: prior.permissions,
        dependencies: prior.dependencies, internalInstructions: prior.internalInstructions, examples: prior.examples,
        estimatedDurationSeconds: prior.estimatedDurationSeconds, ...body });
      const latest = await tx.capabilityVersion.aggregate({ where: { capabilityId: cap.id }, _max: { version: true } });
      const version = await tx.capabilityVersion.create({ data: {
        capabilityId: cap.id, version: (latest._max.version ?? 0) + 1, title: merged.title, summary: merged.summary,
        description: merged.description, category: merged.category, tags: merged.tags, priceTierId: merged.priceTierId,
        ioContract: json(merged.ioContract), permissions: json(merged.permissions), dependencies: json(merged.dependencies),
        internalInstructions: merged.internalInstructions, manifestHash: manifestHash(merged), examples: json(body.examples === undefined ? prior.examples : preserveExampleEvidence(prior.examples, merged.examples ?? [])), estimatedDurationSeconds: merged.estimatedDurationSeconds,
      } });
      const workers = body.workerId ? [requireValue(await tx.workerDevice.findFirst({ where: { id: body.workerId, sellerId: user.id, revokedAt: null } })).id]
        : (await tx.workerBinding.findMany({ where: { capabilityVersionId: prior.id } })).map(b => b.workerId);
      await tx.workerBinding.createMany({ data: workers.map(workerId => ({ workerId, capabilityVersionId: version.id, healthy: false })) });
      await tx.auditEvent.create({ data: { actorId: user.id, sellerId: user.id, type: 'CAPABILITY_VERSION_CREATED', metadata: { capabilityId: cap.id, versionId: version.id } } });
      if (body.schedule) await tx.auditEvent.create({ data: { actorId: user.id, sellerId: user.id, type: 'SCHEDULE_UPDATED', metadata: json({ capabilityId: cap.id, previous: cap.schedule, next: body.schedule, timezone: body.schedule.timezone }) } });
      return tx.capability.update({ where: { id: cap.id }, data: { draftVersionId: version.id, lifecycleRevision: { increment: 1 },
        ...(hasCapacity ? nextCapacity : {}), ...(body.schedule ? { schedule: json(body.schedule) } : {}) }, include: capabilityInclude });
    });
    return capabilityDto(ctx, capability, user.id, true);
  });
  app.post('/api/seller/capabilities/:id/publish', async request => {
    const { user } = requireIdentity(request);
    const { visibility, expectedRevision, versionId, reviewedDiffHash, localExecutionAcknowledged } = z.object({ visibility: z.enum(['PRIVATE', 'UNLISTED', 'PUBLIC']), localExecutionAcknowledged: z.boolean().optional(),
      expectedRevision: z.number().int().nonnegative().optional(), versionId: z.string().uuid().optional(), reviewedDiffHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(request.body);
    const result = await serializable(ctx.db, async tx => {
      await lockCapability(tx, (request.params as { id: string }).id);
      const cap = await loadCapability(tx, (request.params as { id: string }).id);
      if (cap.sellerId !== user.id) throw new ApiError(404, 'NOT_FOUND', 'Capability not found');
      assertLifecycleRevision(cap, expectedRevision);
      if (ctx.config.paymentMode === 'stripe' && cap.seller.connectStatus !== 'READY') throw new ApiError(409, 'SELLER_PAYMENT_NOT_READY', 'Complete Stripe Connect onboarding first');
      const version = requireValue(cap.draftVersion ?? cap.currentVersion);
      if (versionId && versionId !== version.id) throw new ApiError(409, 'CAPABILITY_CONFLICT', 'The selected draft changed; reload its current revision');
      assertPublishable(PermissionManifestSchema.parse(version.permissions), z.array(DependencySchema).parse(version.dependencies));
      try { assertWorkerPermissions(version.permissions); }
      catch { throw new ApiError(409, 'UNSUPPORTED_RUNTIME_CONTRACT', 'The current worker adapter cannot execute this permission contract'); }
      assertRuntimeContract(version.ioContract);
      getPriceTier(version.priceTierId);
      const ready = await tx.workerBinding.count({ where: { capabilityVersionId: version.id, healthy: true, validationStatus: 'PASSED',
        validatedManifestHash: version.manifestHash, validatedAt: { gt: new Date(Date.now() - 24 * 3600_000) },
        worker: { sellerId: user.id, revokedAt: null, paused: false, localPaused: false, sandboxReady: true, lastSeenAt: { gt: new Date(Date.now() - ctx.config.heartbeatTtlMs) } } } });
      if (!ready || executionManifestHash(version) !== version.manifestHash) throw new ApiError(409, 'CAPABILITY_NOT_VALIDATED', 'A ready bound worker must report a passing test for this manifest before publication');
      const readiness = await versionReadiness(ctx, tx, cap, version);
      if (!readiness.ready) throw new ApiError(409, 'CAPABILITY_NOT_VALIDATED', 'Publication checks failed', readiness);
      const diff = requireDiffReview(cap.currentVersion, version, reviewedDiffHash);
      if (!version.publishedAt) {
        if (localExecutionAcknowledged !== true) throw new ApiError(409, 'LOCAL_EXECUTION_ACK_REQUIRED', 'Confirm that this version runs on your computer using approved resources and seller-funded inference, separately from personal sessions and workspaces');
        const now = new Date();
        const evidence = await publicationEvidence(tx, version, user.id, ctx.config.heartbeatTtlMs, now);
        await tx.capabilityVersion.update({ where: { id: version.id }, data: { publishedAt: now, consentAt: now, publicationEvidence: json(evidence) } });
      }
      await tx.auditEvent.create({ data: { actorId: user.id, sellerId: user.id, type: 'CAPABILITY_PUBLISHED', metadata: { capabilityId: cap.id, versionId: version.id, visibility, manifestHash: version.manifestHash, diffHash: diff.diffHash } } });
      return tx.capability.update({ where: { id: cap.id }, data: { currentVersionId: version.id, draftVersionId: null, visibility, lifecycleRevision: { increment: 1 } }, include: capabilityInclude });
    });
    return { ...await capabilityDto(ctx, result, user.id, true), lifecycleRevision: result.lifecycleRevision, currentVersionId: result.currentVersionId, draftVersionId: result.draftVersionId };
  });
  app.post('/api/seller/capabilities/:id/pause', async request => {
    const { user } = requireIdentity(request);
    const { paused } = z.object({ paused: z.boolean().default(true) }).parse(request.body ?? {});
    const cap = await loadCapability(ctx.db, (request.params as { id: string }).id);
    if (cap.sellerId !== user.id) throw new ApiError(404, 'NOT_FOUND', 'Capability not found');
    await ctx.db.capability.update({ where: { id: cap.id }, data: { paused } });
    await ctx.db.auditEvent.create({ data: { actorId: user.id, sellerId: user.id, type: paused ? 'CAPABILITY_PAUSED' : 'CAPABILITY_RESUMED', metadata: { capabilityId: cap.id } } });
    return { paused };
  });
  app.put('/api/seller/capabilities/:id/schedule', async request => {
    const { user } = requireIdentity(request);
    const schedule = ScheduleSchema.parse((request.body as { schedule?: unknown })?.schedule ?? request.body);
    await serializable(ctx.db, async tx => {
      const cap = await loadCapability(tx, (request.params as { id: string }).id);
      if (cap.sellerId !== user.id) throw new ApiError(404, 'NOT_FOUND', 'Capability not found');
      await tx.capability.update({ where: { id: cap.id }, data: { schedule: json(schedule) } });
      await tx.auditEvent.create({ data: { actorId: user.id, sellerId: user.id, type: 'SCHEDULE_UPDATED', metadata: json({ capabilityId: cap.id, previous: cap.schedule, next: schedule, timezone: schedule.timezone }) } });
    });
    await ctx.wake();
    return { schedule };
  });
  app.post('/api/seller/capabilities/:id/grants', async request => {
    const { user } = requireIdentity(request);
    const body = z.object({ email: z.string().email(), allowed: z.boolean().default(true) }).strict().parse(request.body);
    const cap = await loadCapability(ctx.db, (request.params as { id: string }).id);
    if (cap.sellerId !== user.id) throw new ApiError(404, 'NOT_FOUND', 'Capability not found');
    const buyer = requireValue(await ctx.db.user.findUnique({ where: { email: body.email.toLowerCase() } }));
    if (body.allowed) await ctx.db.capabilityGrant.upsert({ where: { capabilityId_userId: { capabilityId: cap.id, userId: buyer.id } }, update: {}, create: { capabilityId: cap.id, userId: buyer.id } });
    else await ctx.db.capabilityGrant.deleteMany({ where: { capabilityId: cap.id, userId: buyer.id } });
    return { ok: true };
  });
}
