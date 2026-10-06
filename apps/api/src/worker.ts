import { createPublicKey, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { z } from 'zod';
import { getWorkerWarnings, publicWorkerHealth, recordWorkerHealth } from './worker-health.js';
import { assertExecutionPolicy, assertWorkerJobDataPolicy, categoryPolicyBlocked, loadSecurityPolicy, workerPolicyReason } from './security-policy.js';
import { IOContractSchema, PermissionManifestSchema, DependencySchema, ScheduleSchema, JobOfferSchema, JobNoticeSchema, JobOutputSchema, WorkerWarningSignalsSchema, validateOutput, stableStringify, hashManifest, executionManifestHash } from '@kivro/contracts';
import { isScheduleOpen, assertPublishable } from '@kivro/policy-engine';
import { assertWorkerPermissions, isSupportedVersion, ADAPTER_POLICY_VERSION } from '@kivro/openclaw-adapter';
import { json, serializable, Prisma, type Transaction, type WorkerDevice } from '@kivro/database';
import { settleJob } from '@kivro/billing';
import { sha256 } from '@kivro/storage';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiContext } from './context.js';
import { hashSecret, requireIdentity } from './auth.js';
import { ApiError, requireValue } from './errors.js';
import { runtimeAvailability, activeStates, terminalStates, loadCapability, assertRuntimeContract } from './catalog.js';
import { transition, failJob, assetDto } from './jobs.js';
import { containJobExecution, releaseContainedJobs } from './job-containment.js';
import { jobPauseExpired } from './job-timing.js';
import { lockCapacity, promoteSellerScheduled } from './scheduling.js';
import { lockSellerCapacity } from './pending-capacity.js';

export const WorkerValidationSchema = z.discriminatedUnion('passed', [
  z.object({ manifestHash: z.string().regex(/^[a-f0-9]{64}$/), passed: z.literal(false) }).strict(),
  z.object({ manifestHash: z.string().regex(/^[a-f0-9]{64}$/), passed: z.literal(true),
    proof: z.object({
      sandbox: z.object({ imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), policyVersion: z.literal(ADAPTER_POLICY_VERSION), testedAt: z.number().int().positive() }).strict(),
      inference: z.object({ configHash: z.string().regex(/^[a-f0-9]{64}$/), testedAt: z.number().int().positive() }).strict(),
    }).strict(),
  }).strict(),
]);
export const VALIDATION_TTL_MS = 24 * 3600_000;

export function canonicalWorkerRequest(method: string, pathname: string, timestamp: string, nonce: string, rawBody: Buffer): string {
  if (!['GET', 'POST'].includes(method) || !pathname.startsWith('/api/worker/') || /[?\r\n#]/.test(pathname) || !/^\d{13}$/.test(timestamp) || !z.string().uuid().safeParse(nonce).success) throw new ApiError(401, 'INVALID_WORKER_SIGNATURE', 'Malformed signature metadata');
  return `${method}\n${pathname}\n${timestamp}\n${nonce}\n${sha256(rawBody)}`;
}

export async function serverKeys(ctx: ApiContext) {
  let privateKey = ctx.config.signingPrivateKey;
  if (!privateKey) {
    if (!ctx.config.development) throw new Error('WORKER_SIGNING_PRIVATE_KEY is required');
    const generated = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const saved = await ctx.db.platformSetting.upsert({ where: { key: 'developmentWorkerSigningKey' }, update: {}, create: { key: 'developmentWorkerSigningKey', value: generated } });
    privateKey = z.string().parse(saved.value);
  }
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Worker signing key must be Ed25519');
  return { privateKey, publicKey: createPublicKey(key).export({ format: 'pem', type: 'spki' }).toString() };
}

export async function authenticateWorker(ctx: ApiContext, request: FastifyRequest): Promise<WorkerDevice> {
  const workerId = z.string().uuid().parse(request.headers['x-worker-id']);
  const timestamp = z.string().parse(request.headers['x-worker-timestamp']);
  const nonce = z.string().uuid().parse(request.headers['x-worker-nonce']);
  const signature = z.string().max(128).parse(request.headers['x-worker-signature']);
  if (!/^\d{13}$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp)) || Math.abs(Date.now() - Number(timestamp)) > 60_000) throw new ApiError(401, 'WORKER_TIMESTAMP_EXPIRED', 'Worker timestamp is outside the permitted clock skew');
  const worker = await ctx.db.workerDevice.findUnique({ where: { id: workerId }, include: { seller: true } });
  if (!worker || worker.revokedAt || worker.seller.suspendedAt) throw new ApiError(401, 'WORKER_REVOKED', 'Worker identity is unavailable');
  const pathname = new URL(request.url, 'http://api.invalid').pathname;
  const canonical = canonicalWorkerRequest(request.method, pathname, timestamp, nonce, request.method === 'GET' ? Buffer.alloc(0) : request.rawBody);
  if (!verify(null, Buffer.from(canonical), worker.publicKey, Buffer.from(signature, 'base64'))) throw new ApiError(401, 'INVALID_WORKER_SIGNATURE', 'Worker signature did not verify');
  try { await ctx.db.workerNonce.create({ data: { workerId, nonce, expiresAt: new Date(Date.now() + 120_000) } }); }
  catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ApiError(409, 'WORKER_REPLAY', 'This worker nonce has already been consumed');
    throw error;
  }
  request.worker = worker;
  return worker;
}

export async function ownedAttempt(tx: Transaction, workerId: string, jobId: string, attemptId: string) {
  const job = requireValue(await tx.job.findUnique({ where: { id: jobId }, include: { activeAttempt: true, version: true } }));
  if (!job.activeAttempt || job.activeAttemptId !== attemptId || job.activeAttempt.workerId !== workerId) throw new ApiError(409, 'STALE_ATTEMPT', 'Worker does not own the active job attempt');
  return { ...job, activeAttempt: job.activeAttempt };
}

export async function dispatchForWorker(ctx: ApiContext, worker: WorkerDevice) {
  return serializable(ctx.db, async tx => {
    await lockSellerCapacity(tx, worker.sellerId);
    const lock = `worker:${worker.id}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
    const fresh = requireValue(await tx.workerDevice.findUnique({ where: { id: worker.id }, include: { seller: true } }));
    const policy = await loadSecurityPolicy(tx);
    if (workerPolicyReason(fresh, policy)) return [];
    const kill = await tx.platformSetting.findUnique({ where: { key: 'dispatchEnabled' } });
    if (kill?.value === false || fresh.revokedAt || fresh.paused || fresh.localPaused || fresh.seller.suspendedAt || !fresh.sandboxReady || !fresh.lastSeenAt || fresh.lastSeenAt.getTime() < Date.now() - ctx.config.heartbeatTtlMs) return [];
    const existing = await tx.job.findMany({ where: { activeAttempt: { workerId: fresh.id }, state: { in: [...activeStates] } }, include: { activeAttempt: true, version: true } });
    if (existing.length) return existing.filter(j => !j.executionRevokedAt && j.state === 'OFFERED' && j.activeAttempt!.expiresAt > new Date() && !categoryPolicyBlocked(j.version.category, policy));
    const now = new Date();
    const plan = await promoteSellerScheduled(ctx, tx, fresh.sellerId, now);
    const assignedId = [...plan.assignments].find(([, workerId]) => workerId === fresh.id)?.[0];
    if (assignedId) {
      const job = requireValue(await tx.job.findUnique({ where: { id: assignedId }, include: { version: true } }));
      await lockCapacity(tx, job.capabilityId);
      const cap = await loadCapability(tx, job.capabilityId);
      if (categoryPolicyBlocked(job.version.category, policy)) return [];
      const available = await runtimeAvailability(ctx, { ...cap, currentVersion: job.version }, tx);
      if (!['ONLINE', 'BUSY'].includes(available.status) || !available.readyWorkers.some(device => device.id === fresh.id) ||
        available.capacityLoad >= available.effectiveConcurrency || !isScheduleOpen(ScheduleSchema.parse(cap.schedule)) || job.waitDeadline < new Date()) return [];
      if (job.scheduledAt && job.scheduledAt > new Date()) return [];
      const grants = await tx.assetGrant.findMany({ where: { jobId: job.id }, include: { asset: true } });
      if (grants.some(g => g.expiresAt <= new Date() || g.asset.expiresAt <= new Date() || g.asset.deletedAt)) {
        await failJob(tx, job, 'FAILED', 'An input asset expired before execution'); return [];
      }
      const attempt = await tx.jobAttempt.create({ data: { jobId: job.id, workerId: fresh.id, expiresAt: new Date(Date.now() + ctx.config.offerTtlMs), nonce: randomUUID() } });
      await tx.job.update({ where: { id: job.id }, data: { activeAttemptId: attempt.id } });
      await transition(tx, job, 'OFFERED', 'Offered to a verified worker');
      return [requireValue(await tx.job.findUnique({ where: { id: job.id }, include: { activeAttempt: true, version: true } }))];
    }
    return [];
  });
}

async function fullOffer(ctx: ApiContext, jobId: string) {
  const job = requireValue(await ctx.db.job.findUnique({ where: { id: jobId }, include: { activeAttempt: true, version: true } }));
  const attempt = requireValue(job.activeAttempt);
  await assertWorkerJobDataPolicy(ctx.db, job.id, attempt.workerId);
  const grants = await ctx.db.assetGrant.findMany({ where: { jobId: job.id }, include: { asset: true }, orderBy: { assetId: 'asc' } });
  if (grants.some(g => g.expiresAt <= new Date() || g.asset.deletedAt || g.asset.expiresAt <= new Date())) throw new ApiError(409, 'ASSET_EXPIRED', 'An input asset is no longer available');
  return JobOfferSchema.parse({ protocolVersion: 1, jobId: job.id, attemptId: attempt.id, workerId: attempt.workerId, sellerId: job.sellerId, maxPauseMs: job.maxPauseMs,
    capabilityVersionId: job.capabilityVersionId, expiresAt: attempt.expiresAt.toISOString(), paymentSecured: true, nonce: attempt.nonce,
    manifestHash: job.version.manifestHash, input: job.input, ioContract: job.version.ioContract, permissions: job.version.permissions, dependencies: job.version.dependencies,
    internalInstructions: job.version.internalInstructions, assets: grants.map(g => ({ ...assetDto(g.asset), downloadUrl: `/api/worker/assets/${g.asset.id}/download` })) });
}

export function registerWorker(app: FastifyInstance, ctx: ApiContext) {
  app.post('/api/seller/pairing-code', async request => {
    const { user } = requireIdentity(request);
    const code = randomBytes(12).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await ctx.db.pairingCode.create({ data: { sellerId: user.id, codeHash: hashSecret(code), expiresAt } });
    return { code, expiresAt: expiresAt.toISOString() };
  });
  app.post('/api/worker/pair', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const body = z.object({ code: z.string().min(8).max(100), publicKey: z.string().max(1000), name: z.string().trim().min(1).max(100), version: z.string().min(1).max(100) }).strict().parse(request.body);
    let publicKey: string;
    try {
      const key = createPublicKey(body.publicKey);
      if (key.asymmetricKeyType !== 'ed25519') throw new Error();
      publicKey = key.export({ type: 'spki', format: 'pem' }).toString();
    } catch { throw new ApiError(400, 'INVALID_DEVICE_KEY', 'An Ed25519 SPKI public key is required'); }
    const worker = await serializable(ctx.db, async tx => {
      const pairing = await tx.pairingCode.findUnique({ where: { codeHash: hashSecret(body.code.toUpperCase()) } });
      if (!pairing || pairing.usedAt || pairing.expiresAt <= new Date()) throw new ApiError(401, 'PAIRING_CODE_INVALID', 'Pairing code is invalid or expired');
      const user = requireValue(await tx.user.findUnique({ where: { id: pairing.sellerId } }));
      if (user.suspendedAt) throw new ApiError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended');
      await tx.pairingCode.update({ where: { id: pairing.id }, data: { usedAt: new Date() } });
      const created = await tx.workerDevice.create({ data: { sellerId: pairing.sellerId, publicKey, name: body.name, version: body.version, runningJobIds: [] } });
      await tx.auditEvent.create({ data: { actorId: user.id, sellerId: user.id, workerId: created.id, type: 'WORKER_PAIRED' } });
      return created;
    });
    return { workerId: worker.id, serverPublicKey: (await serverKeys(ctx)).publicKey };
  });
  app.post('/api/worker/heartbeat', async request => {
    const worker = requireValue(request.worker);
    const body = z.object({ version: z.string().max(100), openclawVersion: z.string().max(100).nullable(), sandboxReady: z.boolean(), paused: z.boolean(),
      capabilities: z.array(z.string().uuid()).max(100), runningJobIds: z.array(z.string().uuid()).max(100), health: z.record(z.unknown()),
      warningSignals: WorkerWarningSignalsSchema.optional(), acknowledgedCommandIds: z.array(z.string().uuid()).max(100).optional() }).strict().parse(request.body);
    const health = Object.fromEntries(Object.entries(body.health).filter(([key, value]) => key !== 'warningSignals' && /^[a-zA-Z0-9_]{1,50}$/.test(key) &&
      (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && ['READY', 'FAILED', 'UNKNOWN', 'HEALTHY', 'UNHEALTHY', 'ONLINE', 'OFFLINE'].includes(value)))));
    if (body.warningSignals !== undefined) health.warningSignals = body.warningSignals;
    const runtimeReady = body.sandboxReady && body.health.ready === true && body.version === '0.1.0' && isSupportedVersion(body.openclawVersion ?? '') && !workerPolicyReason(body, await loadSecurityPolicy(ctx.db));
    const commands = await serializable(ctx.db, async tx => {
      const fresh = await tx.workerDevice.update({ where: { id: worker.id }, data: { version: body.version, openclawVersion: body.openclawVersion, sandboxReady: runtimeReady,
        localPaused: body.paused, lastSeenAt: new Date(), runningJobIds: body.runningJobIds, health: json(health) } });
      await tx.workerBinding.updateMany({ where: { workerId: worker.id }, data: { healthy: false } });
      const versions = await tx.capabilityVersion.findMany({ where: { capability: { sellerId: worker.sellerId }, id: { in: body.capabilities } } });
      for (const version of versions) {
        let supported = false;
        try { assertWorkerPermissions(version.permissions); assertRuntimeContract(version.ioContract); assertPublishable(PermissionManifestSchema.parse(version.permissions), z.array(DependencySchema).parse(version.dependencies)); supported = executionManifestHash(version) === version.manifestHash; } catch { /* Remain unready. */ }
        const binding = await tx.workerBinding.findUnique({ where: { workerId_capabilityVersionId: { workerId: worker.id, capabilityVersionId: version.id } } });
        const validated = binding?.validationStatus === 'PASSED' && binding.validatedManifestHash === version.manifestHash && binding.validatedAt && binding.validatedAt.getTime() > Date.now() - VALIDATION_TTL_MS;
        await tx.workerBinding.upsert({ where: { workerId_capabilityVersionId: { workerId: worker.id, capabilityVersionId: version.id } },
          update: { healthy: runtimeReady && supported && !!validated }, create: { workerId: worker.id, capabilityVersionId: version.id, healthy: false } });
      }
      await recordWorkerHealth(tx, fresh, await loadSecurityPolicy(tx), ctx.config.heartbeatTtlMs);
      const acknowledgements = body.acknowledgedCommandIds ?? z.array(z.string().uuid()).max(100).catch([]).parse(body.health.commands);
      if (acknowledgements.length) await tx.workerCommand.updateMany({ where: { workerId: worker.id, id: { in: acknowledgements } }, data: { ackedAt: new Date() } });
      await tx.workerCommand.updateMany({ where: { workerId: worker.id, jobId: null, type: body.paused ? 'PAUSE_ALL' : 'RESUME_ALL' }, data: { ackedAt: new Date() } });
      const pending = await tx.workerCommand.findMany({ where: { workerId: worker.id, ackedAt: null }, orderBy: { createdAt: 'asc' }, take: 100 });
      return pending.map(c => ({ id: c.id, ...(c.jobId ? { jobId: c.jobId } : {}), type: c.type, ...(c.resumeWhilePaused ? { resumeWhilePaused: true } : {}) }));
    });
    return { commands };
  });
  for (const extended of [false, true]) app.get(extended ? '/api/worker/diagnostics/v2' : '/api/worker/diagnostics', async request => {
    const worker = requireValue(request.worker), policy = await loadSecurityPolicy(ctx.db);
    return { serverTime: new Date().toISOString(), workerId: worker.id,
      ...(extended ? { sellerId: worker.sellerId, deploymentEnvironment: ctx.config.deploymentEnvironment,
        securityWarnings: await getWorkerWarnings(ctx, { workerId: worker.id, sellerId: worker.sellerId }) } : {}), minimumWorkerVersion: policy.minimumWorkerVersion,
      minimumOpenClawVersion: policy.minimumOpenClawVersion, revokedWorkerVersions: policy.revokedWorkerVersions,
      revokedOpenClawVersions: policy.revokedOpenClawVersions, policyReason: workerPolicyReason(worker, policy) };
  });
  app.post('/api/worker/capabilities/:versionId/validation', async request => {
    const worker = requireValue(request.worker);
    const versionId = z.string().uuid().parse((request.params as { versionId: string }).versionId);
    const body = WorkerValidationSchema.parse(request.body);
    await serializable(ctx.db, async tx => {
      const version = requireValue(await tx.capabilityVersion.findFirst({ where: { id: versionId, capability: { sellerId: worker.sellerId } } }));
      if (version.manifestHash !== body.manifestHash || executionManifestHash(version) !== version.manifestHash) throw new ApiError(409, 'MANIFEST_MISMATCH', 'Validation is for a different manifest');
      if (body.passed) {
        const fresh = requireValue(await tx.workerDevice.findUnique({ where: { id: worker.id } }));
        await assertExecutionPolicy(tx, version.category, fresh);
        if (!fresh.sandboxReady || fresh.revokedAt || !fresh.lastSeenAt || fresh.lastSeenAt.getTime() <= Date.now() - ctx.config.heartbeatTtlMs) throw new ApiError(409, 'SANDBOX_NOT_READY', 'A fresh verified sandbox heartbeat is required before capability validation');
        assertWorkerPermissions(version.permissions);
        assertRuntimeContract(version.ioContract);
        assertPublishable(PermissionManifestSchema.parse(version.permissions), z.array(DependencySchema).parse(version.dependencies));
        const timestamps = [body.proof.sandbox.testedAt, body.proof.inference.testedAt];
        if (timestamps.some(time => time > Date.now() + 60_000 || time <= Date.now() - VALIDATION_TTL_MS)) throw new ApiError(409, 'TEST_EVIDENCE_EXPIRED', 'Sandbox and dedicated inference must have passed tests within 24 hours');
      }
      if (!version.publishedAt) await tx.capabilityVersion.update({ where: { id: version.id }, data: { testPassedAt: body.passed ? new Date() : null } });
      const validation = { healthy: body.passed, validationStatus: body.passed ? 'PASSED' : 'FAILED', validatedManifestHash: body.manifestHash,
        validatedAt: body.passed ? new Date(Math.min(body.proof.sandbox.testedAt, body.proof.inference.testedAt)) : null,
        validationProof: body.passed ? json(body.proof) : Prisma.JsonNull };
      await tx.workerBinding.upsert({ where: { workerId_capabilityVersionId: { workerId: worker.id, capabilityVersionId: version.id } }, update: validation, create: { workerId: worker.id, capabilityVersionId: version.id, ...validation } });
      await tx.auditEvent.create({ data: { sellerId: worker.sellerId, workerId: worker.id, type: 'CAPABILITY_VALIDATED', metadata: json({ versionId, ...body }) } });
    });
    return { ok: true };
  });
  app.get('/api/worker/offers', async request => {
    const worker = requireValue(request.worker);
    const jobs = await dispatchForWorker(ctx, worker);
    const keys = await serverKeys(ctx);
    const offers = [];
    for (const job of jobs) {
      const payload = await fullOffer(ctx, job.id);
      const notice = JobNoticeSchema.parse({ ...Object.fromEntries(Object.entries(payload).filter(([key]) => !['input', 'assets', 'internalInstructions'].includes(key))), payloadHash: hashManifest(payload) });
      offers.push({ payload: notice, signature: sign(null, Buffer.from(stableStringify(notice)), keys.privateKey).toString('base64') });
    }
    return { offers };
  });
  app.get('/api/worker/jobs/:id/payload', async request => {
    const worker = requireValue(request.worker);
    const jobId = z.string().uuid().parse((request.params as { id: string }).id);
    const { attemptId } = z.object({ attemptId: z.string().uuid() }).strict().parse(request.query);
    const job = requireValue(await ctx.db.job.findUnique({ where: { id: jobId }, include: { activeAttempt: true } }));
    if (job.activeAttemptId !== attemptId || job.activeAttempt?.workerId !== worker.id || !job.activeAttempt.acceptedAt ||
      job.activeAttempt.expiresAt <= new Date() || !['ACCEPTED', 'RUNNING', 'RESUMING', 'UPLOADING_RESULTS'].includes(job.state) || job.paymentState !== 'RESERVED') {
      throw new ApiError(403, 'PAYLOAD_NOT_AUTHORIZED', 'The worker must accept the active paid attempt before accessing buyer data');
    }
    const payload = await fullOffer(ctx, job.id);
    const keys = await serverKeys(ctx);
    const authorized = await ctx.db.job.count({ where: { id: job.id, activeAttemptId: attemptId, paymentState: 'RESERVED', state: { in: ['ACCEPTED', 'RUNNING', 'RESUMING', 'UPLOADING_RESULTS'] },
      activeAttempt: { workerId: worker.id, acceptedAt: { not: null }, expiresAt: { gt: new Date() }, worker: { revokedAt: null, seller: { suspendedAt: null } } } } });
    if (!authorized) throw new ApiError(403, 'PAYLOAD_NOT_AUTHORIZED', 'Execution access was revoked');
    await assertWorkerJobDataPolicy(ctx.db, job.id, worker.id);
    return { payload, signature: sign(null, Buffer.from(stableStringify(payload)), keys.privateKey).toString('base64') };
  });
  app.post('/api/worker/jobs/:id/events', async request => {
    const worker = requireValue(request.worker);
    const body = z.object({ attemptId: z.string().uuid(), type: z.enum(['ACCEPTED', 'RUNNING', 'PAUSED', 'RESUMING', 'FAILED', 'CANCELLED', 'TIMED_OUT']), message: z.string().max(500).optional(), error: z.unknown().optional() }).strict().parse(request.body);
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const expired = await serializable(ctx.db, async tx => {
      let job = await ownedAttempt(tx, worker.id, id, body.attemptId);
      if (!terminalStates.includes(job.state as typeof terminalStates[number]) && jobPauseExpired(job)) {
        await failJob(tx, job, 'TIMED_OUT', 'Cumulative pause budget exceeded'); return true;
      }
      if (['ACCEPTED', 'RUNNING', 'RESUMING'].includes(body.type)) await assertWorkerJobDataPolicy(tx, job.id, worker.id);
      if (job.state === body.type || (body.type === 'ACCEPTED' && job.activeAttempt.acceptedAt)) return;
      if (terminalStates.includes(job.state as typeof terminalStates[number])) throw new ApiError(409, 'JOB_TERMINAL', 'Job is already terminal');
      if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(body.type)) {
        await failJob(tx, job, body.type as 'FAILED' | 'CANCELLED' | 'TIMED_OUT', body.type === 'FAILED' ? 'Worker execution failed' : body.type === 'TIMED_OUT' ? 'Worker execution timed out' : 'Worker cancelled execution', { source: 'WORKER', workerId: worker.id });
        return;
      }
      if (['ACCEPTED', 'RUNNING', 'RESUMING'].includes(body.type)) {
        const fresh = requireValue(await tx.workerDevice.findUnique({ where: { id: worker.id } }));
        await assertExecutionPolicy(tx, job.version.category, fresh);
      }
      if (body.type === 'ACCEPTED') {
        if (job.activeAttempt.expiresAt <= new Date() || job.paymentState !== 'RESERVED') throw new ApiError(409, 'OFFER_EXPIRED', 'Offer has expired or its payment is no longer reserved');
        assertRuntimeContract(job.version.ioContract);
        const fresh = requireValue(await tx.workerDevice.findUnique({ where: { id: worker.id } }));
        const cap = await loadCapability(tx, job.capabilityId);
        const kill = await tx.platformSetting.findUnique({ where: { key: 'dispatchEnabled' } });
        const binding = await tx.workerBinding.findUnique({ where: { workerId_capabilityVersionId: { workerId: fresh.id, capabilityVersionId: job.capabilityVersionId } } });
        const validationCurrent = binding?.healthy && binding.validationStatus === 'PASSED' && binding.validatedManifestHash === job.version.manifestHash &&
          binding.validatedAt && binding.validatedAt.getTime() > Date.now() - VALIDATION_TTL_MS && executionManifestHash(job.version) === job.version.manifestHash;
        if (kill?.value === false || fresh.revokedAt || fresh.paused || fresh.localPaused || !fresh.sandboxReady || !fresh.lastSeenAt || fresh.lastSeenAt.getTime() <= Date.now() - ctx.config.heartbeatTtlMs ||
          !validationCurrent || (ctx.config.paymentMode === 'stripe' && cap.seller.connectStatus !== 'READY') || cap.paused || cap.securityBlocked || cap.seller.suspendedAt || !isScheduleOpen(ScheduleSchema.parse(cap.schedule))) throw new ApiError(409, 'ACCEPTANCE_BLOCKED', 'Current execution policy blocks acceptance');
        await tx.jobAttempt.update({ where: { id: body.attemptId }, data: { acceptedAt: new Date() } });
      }
      if (body.type === 'PAUSED' && job.state === 'RUNNING') {
        await transition(tx, job, 'PAUSE_REQUESTED', 'Worker reported local pause', { source: 'WORKER', workerId: worker.id });
        job = await ownedAttempt(tx, worker.id, id, body.attemptId);
      }
      await transition(tx, job, body.type, body.type === 'PAUSED' ? 'Worker confirmed execution is paused' : undefined, { source: 'WORKER', workerId: worker.id });
      await tx.jobAttempt.update({ where: { id: body.attemptId }, data: { state: body.type } });
      const command = body.type === 'PAUSED' ? 'PAUSE_JOB' : body.type === 'RUNNING' ? 'RESUME_JOB' : null;
      if (command) await tx.workerCommand.updateMany({ where: { workerId: worker.id, jobId: id, type: command }, data: { ackedAt: new Date() } });
    });
    if (expired) throw new ApiError(409, 'PAUSE_BUDGET_EXCEEDED', 'Cumulative pause budget exceeded');
    return { ok: true };
  });
  app.post('/api/worker/jobs/:id/result', async request => {
    const worker = requireValue(request.worker);
    const body = z.object({ attemptId: z.string().uuid(), output: JobOutputSchema }).strict().parse(request.body);
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const resultHash = hashManifest(body.output);
    const expired = await serializable(ctx.db, async tx => {
      let job = await ownedAttempt(tx, worker.id, id, body.attemptId);
      if (job.state === 'SUCCEEDED') {
        if (job.activeAttempt.resultHash !== resultHash) throw new ApiError(409, 'RESULT_CONFLICT', 'This attempt already finalized a different result');
        return;
      }
      if (!terminalStates.includes(job.state as typeof terminalStates[number]) && jobPauseExpired(job)) {
        await failJob(tx, job, 'TIMED_OUT', 'Cumulative pause budget exceeded'); return true;
      }
      if (!['RUNNING', 'UPLOADING_RESULTS'].includes(job.state)) throw new ApiError(409, 'INVALID_JOB_STATE', 'Results require an active running attempt');
      await assertWorkerJobDataPolicy(tx, job.id, worker.id);
      await assertExecutionPolicy(tx, job.version.category, requireValue(await tx.workerDevice.findUnique({ where: { id: worker.id } })));
      const contract = IOContractSchema.parse(job.version.ioContract);
      const namedAssetIds = (contract.output.fields ?? []).filter(field => ['FILE', 'FILES'].includes(field.type)).flatMap(field => {
        const value = body.output.fields?.[field.key];
        return (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(id => z.string().uuid().parse(id));
      });
      const assetIds = [...new Set([...(body.output.assets?.map(a => a.id) ?? []), ...namedAssetIds])];
      const assets = await tx.asset.findMany({ where: { id: { in: assetIds }, jobId: id, attemptId: body.attemptId, kind: 'OUTPUT', ownerId: job.buyerId,
        deletedAt: null, expiresAt: { gt: new Date() }, scanStatus: { in: ctx.config.development ? ['CLEAN', 'DEVELOPMENT_ONLY'] : ['CLEAN'] } } });
      if (assets.length !== assetIds.length) throw new ApiError(400, 'INVALID_OUTPUT_ASSETS', 'Results include an unavailable or unauthorized asset');
      const trustedOutput = { ...body.output, assets: assetIds.map(assetId => assetDto(requireValue(assets.find(a => a.id === assetId)))) };
      const output = validateOutput(contract, trustedOutput);
      const permissions = PermissionManifestSchema.parse(job.version.permissions);
      if (assets.some(asset => asset.sizeBytes > ctx.config.fileLimits.workerFileBytes) || Buffer.byteLength(JSON.stringify(output)) + assets.reduce((n, a) => n + a.sizeBytes, 0) > Math.min(ctx.config.fileLimits.outputBytes, permissions.limits.maxOutputBytes)) throw new ApiError(413, 'OUTPUT_TOO_LARGE', 'Result exceeds the effective execution output limit');
      for (const asset of assets) {
        const bytes = await ctx.storage.get(asset.objectKey);
        if (bytes.length !== asset.sizeBytes || sha256(bytes) !== asset.sha256) throw new ApiError(409, 'OUTPUT_INTEGRITY_FAILED', 'Stored result failed its integrity check');
      }
      await transition(tx, job, 'VALIDATING_RESULTS', 'Validating required results and stored files');
      job = await ownedAttempt(tx, worker.id, id, body.attemptId);
      await tx.job.update({ where: { id }, data: { output: json(output) } });
      if (!await settleJob(tx, job, ctx.config.paymentMode === 'stripe')) throw new ApiError(409, 'PAYMENT_NOT_RESERVED', 'Job payment cannot be settled');
      await transition(tx, job, 'SUCCEEDED', 'Results validated and payment settled');
      await tx.jobAttempt.update({ where: { id: body.attemptId }, data: { state: 'SUCCEEDED', resultHash, finishedAt: new Date() } });
      await tx.auditEvent.create({ data: { sellerId: worker.sellerId, workerId: worker.id, jobId: id, type: 'JOB_SETTLED', metadata: { attemptId: body.attemptId, outputAssetCount: assets.length } } });
    });
    if (expired) throw new ApiError(409, 'PAUSE_BUDGET_EXCEEDED', 'Cumulative pause budget exceeded');
    await ctx.wake();
    return { ok: true };
  });
  app.get('/api/seller/workers', async request => {
    const { user } = requireIdentity(request);
    const policy = await loadSecurityPolicy(ctx.db);
    const workers = await ctx.db.workerDevice.findMany({ where: { sellerId: user.id }, select: { id: true, name: true, version: true, openclawVersion: true, sandboxReady: true, paused: true, localPaused: true, revokedAt: true, lastSeenAt: true, health: true, healthStatus: true, runningJobIds: true, createdAt: true, bindings: { select: { capabilityVersionId: true, healthy: true } } } });
    return Promise.all(workers.map(async worker => ({ ...worker, health: publicWorkerHealth(worker.health),
      securityWarnings: await getWorkerWarnings(ctx, { workerId: worker.id, sellerId: user.id }),
      minimumWorkerVersion: policy.minimumWorkerVersion, minimumOpenClawVersion: policy.minimumOpenClawVersion,
      latestSupportedWorkerVersion: '0.1.0', latestSupportedOpenClawVersion: '2026.8.2', policyReason: workerPolicyReason(worker, policy),
      healthHistory: await ctx.db.auditEvent.findMany({ where: { workerId: worker.id, sellerId: user.id, type: 'WORKER_HEALTH' },
        select: { id: true, createdAt: true, metadata: true }, orderBy: { createdAt: 'desc' }, take: 50 }) })));
  });
  for (const action of ['pause', 'resume', 'revoke'] as const) app.post(`/api/seller/workers/:id/${action}`, async request => {
    const { user } = requireIdentity(request);
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const affected = await serializable(ctx.db, async tx => {
      const worker = requireValue(await tx.workerDevice.findFirst({ where: { id, sellerId: user.id } }));
      if (worker.revokedAt && action !== 'revoke') throw new ApiError(409, 'WORKER_REVOKED', 'Re-pair this device before use');
      if (worker.revokedAt) return [];
      await tx.workerDevice.update({ where: { id }, data: action === 'revoke' ? { revokedAt: new Date(), paused: true, sandboxReady: false } : { paused: action === 'pause' } });
      await tx.workerCommand.updateMany({ where: { workerId: id, jobId: null, ackedAt: null }, data: { ackedAt: new Date() } });
      await tx.workerCommand.create({ data: { workerId: id, type: action === 'resume' ? 'RESUME_ALL' : 'PAUSE_ALL' } });
      const jobs = action === 'revoke' ? await containJobExecution(tx, { activeAttempt: { workerId: id } }, 'Seller revoked this Worker device') : [];
      if (action === 'revoke') await tx.workerBinding.updateMany({ where: { workerId: id }, data: { healthy: false } });
      await tx.auditEvent.create({ data: { actorId: user.id, sellerId: user.id, workerId: id, type: `WORKER_${action.toUpperCase()}` } });
      return jobs;
    });
    await releaseContainedJobs(ctx, affected);
    await ctx.wake();
    return { ok: true };
  });
}
