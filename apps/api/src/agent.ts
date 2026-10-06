import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getPriceTier, hashManifest } from '@kivro/contracts';
import { json, serializable } from '@kivro/database';
import { MarketplaceAgent, OrchestrationService, PlatformInferenceRouter, createInferenceConfiguration, createDevelopmentInferenceDebug, planApprovalHash,
  PlanRepairBodySchema, PlanReplanBodySchema, AgentChatBodySchema, AgentSynthesisBodySchema, AgentPolicyError,
  type MarketplaceCatalog, type ConversationRepository, type PlanRepository, type PurchaseExecutor, type OrchestrationPlan,
  type ConversationMessage, type InferenceAccounting } from '@kivro/marketplace-agent';
import type { FastifyInstance } from 'fastify';
import type { ApiContext } from './context.js';
import { requireIdentity } from './auth.js';
import { consumeBucket } from './abuse.js';
import { ApiError, requireValue } from './errors.js';
import { capabilityInclude, loadCapability, assertCapabilityAccess, capabilityDto, availability, terminalStates } from './catalog.js';
import { createJob, getJob } from './jobs.js';
import { lockCapacity, scheduledAdmission } from './scheduling.js';
import { resolveAgentInputAssets } from './agent-assets.js';

export async function quoteAgentCapability(ctx: ApiContext, request: Parameters<MarketplaceCatalog['quote']>[0]) {
  const { userId, capabilityId, capabilityVersionId, executionMode, scheduledAt } = request;
  return serializable(ctx.db, async tx => {
    await lockCapacity(tx, capabilityId);
    const cap = await loadCapability(tx, capabilityId);
    await assertCapabilityAccess(tx, cap, userId);
    const version = requireValue(cap.currentVersion);
    if (version.id !== capabilityVersionId) throw new ApiError(409, 'VERSION_CHANGED', 'Capability version changed');
    const available = await availability(ctx, cap, tx);
    if (executionMode === 'NOW' && !available.canRunNow && !available.canQueue) throw new ApiError(409, 'NOT_IMMEDIATELY_AVAILABLE', 'Capability cannot start or accept queued work');
    if (['OFFLINE', 'PAUSED', 'SECURITY_BLOCKED'].includes(available.status)) throw new ApiError(409, 'CAPABILITY_UNAVAILABLE', 'Capability is unavailable');
    const earliest = executionMode === 'NOW' ? new Date(Date.now() + available.estimatedQueueWaitSeconds * 1000)
      : await scheduledAdmission(ctx, tx, cap, available, scheduledAt ? new Date(scheduledAt) : new Date());
    const price = getPriceTier(version.priceTierId);
    const quote = await tx.scheduleQuote.create({ data: { buyerId: userId, capabilityId, capabilityVersionId, executionMode, priceSnapshot: json(price),
      earliestStartAt: earliest, estimatedDeliveryAt: new Date(earliest.getTime() + version.estimatedDurationSeconds * 1000), expiresAt: new Date(Date.now() + 300_000) } });
    return { id: quote.id, capabilityId, capabilityVersionId, amountMinor: price.buyerPriceMinor, expiresAt: quote.expiresAt.toISOString(), earliestStartAt: quote.earliestStartAt.toISOString(), estimatedDeliveryAt: quote.estimatedDeliveryAt.toISOString() };
  });
}

export function registerAgent(app: FastifyInstance, ctx: ApiContext, env: NodeJS.ProcessEnv) {
  const dailyUserBudget = z.coerce.number().int().nonnegative().max(1_000_000_000_000).parse(env.PLATFORM_INFERENCE_DAILY_USER_MICRO_USD ?? 1_000_000);
  const dailyGlobalBudget = z.coerce.number().int().nonnegative().max(1_000_000_000_000).parse(env.PLATFORM_INFERENCE_DAILY_GLOBAL_MICRO_USD ?? 100_000_000);
  const conversations: ConversationRepository = {
    async create(userId) {
      const row = await ctx.db.agentConversation.create({ data: { userId } });
      return { id: row.id, userId, createdAt: row.createdAt.toISOString(), messages: [] };
    },
    async get(id, userId) {
      const row = await ctx.db.agentConversation.findFirst({ where: { id, userId } });
      return row ? { id, userId, createdAt: row.createdAt.toISOString(), messages: row.messages as unknown as ConversationMessage[] } : null;
    },
    async list(userId) {
      const rows = await ctx.db.agentConversation.findMany({ where: { userId }, take: 100, orderBy: { updatedAt: 'desc' } });
      return rows.map(row => ({ id: row.id, userId, createdAt: row.createdAt.toISOString(), messages: row.messages as unknown as ConversationMessage[] }));
    },
    async append(id, userId, messages) {
      await serializable(ctx.db, async tx => {
        const row = requireValue(await tx.agentConversation.findFirst({ where: { id, userId } }));
        const prior = row.messages as unknown as ConversationMessage[];
        await tx.agentConversation.update({ where: { id }, data: { messages: json([...prior, ...messages].slice(-200)) } });
      });
    },
  };
  const plans: PlanRepository = {
    async create(plan) { await ctx.db.agentPlan.create({ data: { id: plan.id, userId: plan.userId, conversationId: plan.conversationId, plan: json(plan), state: plan.status, jobIds: [] } }); },
    async get(id, userId) { const row = await ctx.db.agentPlan.findFirst({ where: { id, userId } }); return row ? row.plan as unknown as OrchestrationPlan : null; },
    async compareAndSwap(plan, expectedRevision) {
      return serializable(ctx.db, async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`plan:${plan.id}`}, 0))`;
        const record = await tx.agentPlan.findFirst({ where: { id: plan.id, userId: plan.userId } });
        if (!record) return false;
        const retainedJobs = [...plan.steps, ...(plan.retiredSteps ?? [])].flatMap(step => step.jobId ? [step.jobId] : []);
        // A repair racing the job commit must first recover that purchased step.
        if (await tx.job.count({ where: { id: { in: record.jobIds.filter(id => !retainedJobs.includes(id)) }, paymentState: { in: ['RESERVED', 'SETTLED'] } } })) return false;
        const changed = await tx.agentPlan.updateMany({ where: { id: plan.id, userId: plan.userId, plan: { path: ['revision'], equals: expectedRevision } }, data: { plan: json(plan), state: plan.status } });
        return changed.count === 1;
      });
    },
    async compareAndSwapQuiescent(plan, expectedRevision, expectedJobIds) {
      return serializable(ctx.db, async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`plan:${plan.id}`}, 0))`;
        const record = await tx.agentPlan.findFirst({ where: { id: plan.id, userId: plan.userId } });
        if (!record || (record.plan as { revision?: number }).revision !== expectedRevision) return false;
        const retainedJobs = [...plan.steps, ...(plan.retiredSteps ?? [])].flatMap(step => step.jobId ? [step.jobId] : []);
        const expected = [...new Set(expectedJobIds)].sort();
        if (expected.length !== expectedJobIds.length || JSON.stringify([...record.jobIds].sort()) !== JSON.stringify(expected) ||
          JSON.stringify([...retainedJobs].sort()) !== JSON.stringify(expected)) return false;
        const jobs = await tx.job.findMany({ where: { id: { in: expected }, buyerId: plan.userId }, select: { id: true, state: true, paymentState: true } });
        if (jobs.length !== expected.length || jobs.some(job => !terminalStates.includes(job.state as typeof terminalStates[number]) || job.paymentState === 'RESERVED')) return false;
        const changed = await tx.agentPlan.updateMany({ where: { id: plan.id, userId: plan.userId, plan: { path: ['revision'], equals: expectedRevision } }, data: { plan: json(plan), state: plan.status } });
        if (changed.count) await tx.auditEvent.create({ data: { actorId: plan.userId, type: 'PLAN_REPAIRED', metadata: json({ planId: plan.id, previousRevision: expectedRevision, revision: plan.revision, jobIds: expected, repair: plan.repairHistory?.at(-1) }) } });
        return changed.count === 1;
      });
    },
  };
  const catalog: MarketplaceCatalog = {
    async search({ userId, cursor, limit }) {
      const caps = await ctx.db.capability.findMany({ where: { visibility: 'PUBLIC', currentVersionId: { not: null }, seller: { suspendedAt: null } },
        include: capabilityInclude, take: limit + 1, orderBy: { id: 'asc' }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      return { capabilities: await Promise.all(caps.slice(0, limit).map(cap => capabilityDto(ctx, cap, userId))), ...(caps.length > limit ? { nextCursor: caps[limit - 1]!.id } : {}) };
    },
    async get(capabilityId, userId) {
      try { const cap = await loadCapability(ctx.db, capabilityId); await assertCapabilityAccess(ctx.db, cap, userId); return capabilityDto(ctx, cap, userId); }
      catch (error) { if (error instanceof ApiError && error.statusCode === 404) return null; throw error; }
    },
    quote: request => quoteAgentCapability(ctx, request),
  };
  const executor: PurchaseExecutor = {
    async lookupCreatedJob(request) {
      if (request.idempotencyKey !== `orchestration:${request.planId}:${request.stepId}`) throw new ApiError(400, 'INVALID_PLAN_OPERATION', 'Invalid orchestration operation identity');
      const record = requireValue(await ctx.db.agentPlan.findFirst({ where: { id: request.planId, userId: request.userId } }));
      const plan = record.plan as unknown as OrchestrationPlan;
      const step = requireValue([...plan.steps, ...(plan.retiredSteps ?? [])].find(candidate => candidate.id === request.stepId));
      const prior = await ctx.db.idempotencyRecord.findUnique({ where: { userId_endpoint_key: { userId: request.userId, endpoint: 'jobs', key: request.idempotencyKey } } });
      if (!prior) return null;
      const { jobId } = z.object({ jobId: z.string().uuid() }).parse(prior.response);
      if (!record.jobIds.includes(jobId)) throw new ApiError(409, 'JOB_OWNERSHIP_MISMATCH', 'Job is not part of this plan');
      requireValue(await ctx.db.job.findFirst({ where: { id: jobId, buyerId: request.userId, capabilityId: step.capabilityId, capabilityVersionId: step.capabilityVersionId } }));
      return { jobId };
    },
    async createJob(request) {
      if (request.idempotencyKey !== `orchestration:${request.planId}:${request.stepId}`) throw new ApiError(400, 'INVALID_PLAN_OPERATION', 'Invalid orchestration operation identity');
      const job = await createJob(ctx, request.userId, { capabilityId: request.capabilityId, input: request.input,
        executionMode: request.executionMode, quoteId: request.quote.id, ...(request.scheduledAt ? { scheduledAt: request.scheduledAt } : {}) }, request.idempotencyKey, {
        async beforeReserve(tx, amount, versionId) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`plan:${request.planId}`}, 0))`;
          const record = requireValue(await tx.agentPlan.findFirst({ where: { id: request.planId, userId: request.userId } }));
          const plan = record.plan as unknown as OrchestrationPlan;
          if (plan.revision !== request.expectedPlanRevision) throw new ApiError(409, 'PLAN_CONFLICT', 'Plan changed before purchase; reload the current revision');
          const step = plan.steps.find(s => s.id === request.stepId);
          if (!['APPROVED', 'RUNNING'].includes(record.state) || !plan.approval || plan.approval.userId !== request.userId || plan.approval.planHash !== request.approvalHash || planApprovalHash(plan) !== request.approvalHash || !step || step.status !== 'PLANNED' || step.jobId || step.capabilityId !== request.capabilityId || step.capabilityVersionId !== versionId || step.quote.id !== request.quote.id) throw new ApiError(409, 'APPROVAL_REQUIRED', 'The current plan and quote must be approved before purchasing');
          const prior = await tx.job.aggregate({ where: { id: { in: record.jobIds }, paymentState: { in: ['RESERVED', 'SETTLED'] } }, _sum: { buyerPriceMinor: true } });
          if ((prior._sum.buyerPriceMinor ?? 0) + amount > Math.min(plan.constraints.maxTotalSpendMinor, request.maxBudgetMinor)) throw new ApiError(409, 'PLAN_BUDGET_EXCEEDED', 'The purchase would exceed the approved plan budget');
        },
        async afterCreate(tx, jobId) { await tx.agentPlan.update({ where: { id: request.planId }, data: { jobIds: { push: jobId } } }); },
      });
      return { jobId: job.id };
    },
    async getJob(jobId, userId) {
      const job = await getJob(ctx, jobId, userId);
      if (job.buyerId !== userId) throw new ApiError(404, 'NOT_FOUND', 'Job not found');
      return { id: job.id, state: job.state === 'SUCCEEDED' ? 'SUCCEEDED' : job.state === 'CANCELLED' ? 'CANCELLED' : ['FAILED', 'TIMED_OUT'].includes(job.state) ? 'FAILED' : 'PENDING', ...(job.output ? { output: job.output } : {}) };
    },
    async authorizeAssetTransfer({ userId, planId, sourceJobId, targetStepId, assetId }) {
      const record = requireValue(await ctx.db.agentPlan.findFirst({ where: { id: planId, userId } }));
      const plan = record.plan as unknown as OrchestrationPlan;
      const sourceStep = plan.steps.find(s => s.jobId === sourceJobId);
      const target = plan.steps.find(s => s.id === targetStepId);
      if (!sourceStep || !target?.dependsOn.includes(sourceStep.id)) throw new ApiError(403, 'ASSET_TRANSFER_NOT_APPROVED', 'Asset transfer is not part of this plan');
      requireValue(await ctx.db.asset.findFirst({ where: { id: assetId, ownerId: userId, jobId: sourceJobId, kind: 'OUTPUT', deletedAt: null, expiresAt: { gt: new Date() }, job: { state: 'SUCCEEDED' } } }));
      // The exact target job grant is created atomically by createJob after ownership validation.
    },
  };
  const accounting: InferenceAccounting = {
    async reserve(request) {
      const date = new Date().toISOString().slice(0, 10);
      return serializable(ctx.db, async tx => {
        const budgetKey = `platform-inference:${date}:${request.metadata.userId}`;
        const budgetKeys = [`platform-inference:${date}:global`, budgetKey];
        for (const [index, key] of budgetKeys.entries()) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
          const prior = await tx.platformSetting.findUnique({ where: { key } });
          const spent = typeof prior?.value === 'number' ? prior.value : 0;
          if (spent + request.maxCostMicroUsd > (index === 0 ? dailyGlobalBudget : dailyUserBudget)) throw new ApiError(429, 'INFERENCE_BUDGET_EXCEEDED', 'Daily platform inference budget reached');
          await tx.platformSetting.upsert({ where: { key }, create: { key, value: spent + request.maxCostMicroUsd }, update: { value: spent + request.maxCostMicroUsd } });
        }
        const id = randomUUID();
        await tx.platformSetting.create({ data: { key: `inference-request:${id}`, value: json({ ...request, budgetKey, budgetKeys, state: 'RESERVED' }) } });
        return id;
      });
    },
    async finish(id, result) {
      await serializable(ctx.db, async tx => {
        const row = requireValue(await tx.platformSetting.findUnique({ where: { key: `inference-request:${id}` } }));
        const record = row.value as { state: string; budgetKey: string; budgetKeys?: string[]; maxCostMicroUsd: number;
          metadata: Parameters<InferenceAccounting['reserve']>[0]['metadata']; task: string; provider: string; model: string };
        if (record.state !== 'RESERVED') return;
        const charged = Math.min(record.maxCostMicroUsd, Math.max(0, result.costMicroUsd));
        for (const key of record.budgetKeys ?? [record.budgetKey]) {
          const budget = await tx.platformSetting.findUniqueOrThrow({ where: { key } });
          await tx.platformSetting.update({ where: { key }, data: { value: Number(budget.value) - record.maxCostMicroUsd + charged } });
        }
        await tx.platformSetting.update({ where: { key: row.key }, data: { value: json({ ...record, ...result, state: 'FINISHED' }) } });
        await tx.auditEvent.create({ data: { actorId: record.metadata.userId, type: 'PLATFORM_INFERENCE', metadata: json({ requestId: id, task: record.task, provider: record.provider, model: record.model,
          conversationId: record.metadata.conversationId ?? null, orchestrationId: record.metadata.orchestrationId ?? null, ...result }) } });
      });
    },
  };
  const configuration = createInferenceConfiguration(env);
  let routingRecorded = false;
  ctx.initializeInferenceRouting = async () => {
    if (routingRecorded) return;
    const snapshot = { profiles: configuration.profiles, dailyUserBudget, dailyGlobalBudget };
    const fingerprint = hashManifest(snapshot), key = 'platform-inference-routing';
    await serializable(ctx.db, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      const previous = await tx.platformSetting.findUnique({ where: { key } });
      if ((previous?.value as { fingerprint?: string } | undefined)?.fingerprint === fingerprint) return;
      await tx.platformSetting.upsert({ where: { key }, create: { key, value: json({ fingerprint, ...snapshot }) }, update: { value: json({ fingerprint, ...snapshot }) } });
      await tx.auditEvent.create({ data: { type: 'PLATFORM_INFERENCE_ROUTING_CHANGED', metadata: json({ source: 'OPERATOR_ENVIRONMENT', previous: previous?.value ?? null, next: snapshot, fingerprint }) } });
    });
    routingRecorded = true;
  };
  const debug = createDevelopmentInferenceDebug(env, event => {
    if (event.event === 'DEVELOPMENT_INFERENCE_DEBUG_ENABLED') ctx.app.log.warn(event, 'Inference debug enabled');
    else ctx.app.log.info(event, 'Redacted inference diagnostics');
  });
  const inference = new PlatformInferenceRouter({ ...configuration, accounting, debug });
  const orchestration = new OrchestrationService({ catalog, plans, executor });
  const agent = new MarketplaceAgent({ catalog, conversations, orchestration, inference });
  ctx.tickPlans = async () => {
    const pending = await ctx.db.$transaction(async tx => {
      const key = 'agent-plan-poll-cursor';
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      const saved = await tx.platformSetting.findUnique({ where: { key } });
      const cursor = typeof saved?.value === 'string' ? saved.value : '';
      const query = (after: string) => tx.agentPlan.findMany({ where: { state: { in: ['APPROVED', 'RUNNING'] }, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 20 });
      let batch = await query(cursor);
      if (!batch.length && cursor) batch = await query('');
      const next = batch.length === 20 ? batch.at(-1)!.id : '';
      await tx.platformSetting.upsert({ where: { key }, create: { key, value: next }, update: { value: next } });
      return batch;
    });
    for (const plan of pending) {
      try { await orchestration.execute({ planId: plan.id, userId: plan.userId }); }
      catch (error) { ctx.app.log.warn({ planId: plan.id, code: error instanceof Error && /^[A-Z0-9_]{2,80}$/.test(error.message) ? error.message : 'PLAN_EXECUTION_FAILED' }, 'Plan needs reconciliation'); }
    }
  };
  app.post('/api/agent/chat', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const { user } = requireIdentity(request);
    const body = AgentChatBodySchema.parse(request.body);
    const inputAssets = await resolveAgentInputAssets(ctx, user.id, body.inputAssetIds ?? []);
    await ctx.initializeInferenceRouting!();
    await consumeBucket(ctx.db, `agent-turns:${user.id}`, ctx.config.agentTurnsPerDay, 86400_000);
    return agent.chat({ ...body, inputAssets, userId: user.id });
  });
  app.get('/api/agent/conversations', async request => conversations.list(requireIdentity(request).user.id));
  app.get('/api/agent/plans/:id', async request => orchestration.get(z.string().uuid().parse((request.params as { id: string }).id), requireIdentity(request).user.id));
  app.get('/api/agent/plans/:id/synthesis-preview', async request => {
    const { user } = requireIdentity(request);
    const planId = z.string().uuid().parse((request.params as { id: string }).id);
    return agent.getSynthesisPreview({ planId, userId: user.id });
  });
  app.post('/api/agent/plans/:id/synthesize', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    const { user } = requireIdentity(request);
    const planId = z.string().uuid().parse((request.params as { id: string }).id);
    const body = AgentSynthesisBodySchema.parse(request.body);
    await ctx.initializeInferenceRouting!();
    await consumeBucket(ctx.db, `agent-turns:${user.id}`, ctx.config.agentTurnsPerDay, 86400_000);
    try { return await agent.synthesize({ ...body, planId, userId: user.id }); }
    catch (error) {
      if (error instanceof AgentPolicyError && error.code === 'SYNTHESIS_CONSENT_STALE') throw new ApiError(409, error.code, 'Review the updated sources and consent again');
      throw error;
    }
  });
  app.post('/api/agent/plans/:id/repair', async request => {
    const { user } = requireIdentity(request);
    const planId = z.string().uuid().parse((request.params as { id: string }).id);
    return orchestration.repair({ ...PlanRepairBodySchema.parse(request.body), planId, userId: user.id });
  });
  app.post('/api/agent/plans/:id/replan', async request => {
    const { user } = requireIdentity(request);
    const planId = z.string().uuid().parse((request.params as { id: string }).id);
    return orchestration.replan({ ...PlanReplanBodySchema.parse(request.body), planId, userId: user.id });
  });
  app.post('/api/agent/plans/:id/approve', async request => {
    const { user } = requireIdentity(request);
    const planId = z.string().uuid().parse((request.params as { id: string }).id);
    const body = z.object({ expectedRevision: z.number().int().nonnegative() }).strict().parse(request.body);
    const approved = await orchestration.approve({ planId, userId: user.id, expectedRevision: body.expectedRevision });
    await ctx.wake();
    return approved;
  });
}
