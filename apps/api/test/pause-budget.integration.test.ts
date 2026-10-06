import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient, json, serializable } from '@kivro/database';
import { DEFAULT_SCHEDULE, executionManifestHash, getPriceTier } from '@kivro/contracts';
import { creditWallet, reserveJob } from '@kivro/billing';
import { ADAPTER_POLICY_VERSION } from '@kivro/openclaw-adapter';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';
import { canonicalWorkerRequest } from '../src/worker.js';
import { reconcileJobs } from '../src/background.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('immutable pause policy and financial expiry (isolated PostgreSQL)', () => {
  let db: PrismaClient, app: FastifyInstance;
  const schema = `pause_budget_${randomBytes(8).toString('hex')}`, origin = 'http://localhost:3000';
  beforeAll(async () => {
    process.loadEnvFile('.env'); const url = new URL(process.env.DATABASE_URL!);
    if (process.env.KIVRO_ENV !== 'development' || url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/kivro') throw new Error('Requires local development DB');
    url.searchParams.set('schema', schema);
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url.toString() } });
    db = new PrismaClient({ datasourceUrl: url.toString() });
    app = await createApp({ db, logger: false, mailer: null, env: { ...process.env, NODE_ENV: 'test', PAYMENT_MODE: 'fake', WEB_ORIGIN: origin,
      KIVRO_MAX_JOB_PAUSE_MS: '120000', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', PLATFORM_OPENAI_API_KEY: '', PLATFORM_ANTHROPIC_API_KEY: '', PLATFORM_INFERENCE_PROVIDER: '' } });
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      if (!/^pause_budget_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe test schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await db.$disconnect();
    }
  });
  async function fixture() {
    const sellerId = randomUUID(), buyerId = randomUUID(), token = randomUUID(), buyerToken = randomUUID(), keys = generateKeyPairSync('ed25519');
    for (const [id, session] of [[sellerId, token], [buyerId, buyerToken]]) await db.user.create({ data: { id, email: `${id}@pause.kivro.local`, name: 'Pause fixture', passwordHash: 'disabled', wallet: { create: {} },
      sessions: { create: { tokenHash: hashSecret(session!), expiresAt: new Date(Date.now() + 600000) } } } });
    await serializable(db, tx => creditWallet(tx, buyerId, 1000, `pause-funding:${buyerId}`));
    const worker = await db.workerDevice.create({ data: { sellerId, name: 'Pause fixture', version: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)', sandboxReady: true, lastSeenAt: new Date(),
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } });
    const cap = await db.capability.create({ data: { sellerId, slug: randomUUID(), visibility: 'PUBLIC', schedule: DEFAULT_SCHEDULE } });
    const manifest = { ioContract: { schemaVersion: 1, inputs: [{ key: 'originalField', label: 'Original field', type: 'SHORT_TEXT', required: false, order: 0, constraints: { maxLength: 20 } }], output: { type: 'TEXT', description: 'Result', required: true } },
      permissions: { schemaVersion: 1, tools: [], network: { mode: 'NONE', allowedDomains: [] }, resources: [], inference: { provider: 'openai-compatible', model: 'test' },
        limits: { timeoutSeconds: 300, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 1024, maxOutputBytes: 1024, maxTokens: 1000 } },
      dependencies: [{ id: 'inference', name: 'Dedicated inference', type: 'INFERENCE', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { inferenceProviders: ['openai-compatible'] } }], internalInstructions: 'Synthetic pause fixture' };
    const version = await db.capabilityVersion.create({ data: { capabilityId: cap.id, version: 1, title: 'Pause fixture', summary: 'Synthetic timing case', description: '', category: 'Writing & documents', tags: [], priceTierId: 'USD_99',
      ...manifest, ioContract: json(manifest.ioContract), permissions: json(manifest.permissions), dependencies: json(manifest.dependencies), manifestHash: executionManifestHash(manifest), publishedAt: new Date() } });
    await db.capability.update({ where: { id: cap.id }, data: { currentVersionId: version.id } });
    await db.workerBinding.create({ data: { workerId: worker.id, capabilityVersionId: version.id, healthy: true, validationStatus: 'PASSED', validatedManifestHash: version.manifestHash, validatedAt: new Date(),
      validationProof: { sandbox: { imageId: `sha256:${'a'.repeat(64)}`, policyVersion: ADAPTER_POLICY_VERSION, testedAt: Date.now() }, inference: { configHash: 'b'.repeat(64), testedAt: Date.now() } } } });
    const headers = { origin, cookie: `kivro_session=${token}` }, buyerHeaders = { origin, cookie: `kivro_session=${buyerToken}` };
    const terms = (await app.inject('/api/terms')).json();
    expect((await app.inject({ method: 'POST', url: '/api/account/terms', headers: buyerHeaders, payload: { version: terms.version } })).statusCode).toBe(200);
    const signed = (method: 'GET' | 'POST', url: string, body?: unknown) => {
      const timestamp = String(Date.now()), nonce = randomUUID(), raw = body === undefined ? '' : JSON.stringify(body);
      return app.inject({ method, url, ...(body === undefined ? {} : { payload: raw }), headers: { 'content-type': 'application/json', 'x-worker-id': worker.id, 'x-worker-timestamp': timestamp,
        'x-worker-nonce': nonce, 'x-worker-signature': sign(null, Buffer.from(canonicalWorkerRequest(method, url.split('?')[0]!, timestamp, nonce, Buffer.from(raw))), keys.privateKey).toString('base64') } });
    };
    const makeJob = async (patch: { pausedAt?: Date | null; pausedDurationMs?: number; state?: 'PAUSED' | 'RUNNING' } = {}) => serializable(db, async tx => {
      const price = getPriceTier('USD_99');
      const job = await tx.job.create({ data: { buyerId, sellerId, capabilityId: cap.id, capabilityVersionId: version.id, state: 'PAUSED', input: {}, priceSnapshot: price, maxPauseMs: 120000,
        buyerPriceMinor: 99, platformFeeMinor: 19, sellerNetMinor: 80, executionMode: 'NOW', waitDeadline: new Date(Date.now() + 600000),
        startedAt: new Date(Date.now() - 110000), pausedAt: new Date(Date.now() - 45000), pausedDurationMs: 45000, ...patch } });
      await reserveJob(tx, job);
      const attempt = await tx.jobAttempt.create({ data: { jobId: job.id, workerId: worker.id, state: job.state, acceptedAt: new Date(), expiresAt: new Date(Date.now() + 600000), nonce: randomUUID() } });
      return tx.job.update({ where: { id: job.id }, data: { activeAttemptId: attempt.id } });
    });
    return { worker, cap, version, manifest, buyerId, sellerId, headers, buyerHeaders, signed, makeJob };
  }
  async function released(id: string) {
    expect(await db.job.findUniqueOrThrow({ where: { id } })).toMatchObject({ state: 'TIMED_OUT', paymentState: 'RELEASED' });
    expect(await db.ledgerEntry.count({ where: { jobId: id, type: 'JOB_RELEASE' } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { jobId: id, type: { in: ['JOB_CAPTURE', 'SELLER_EARNING', 'PLATFORM_FEE'] } } })).toBe(0);
    expect(await db.workerCommand.count({ where: { jobId: id, type: 'CANCEL_JOB' } })).toBe(1);
  }
  it('snapshots configured policy on purchase and signs that exact value without buyer overrides', async () => {
    const f = await fixture(); app.kivro.config.maxPauseMs = 75000;
    try {
      const create = (extra = {}) => app.inject({ method: 'POST', url: '/api/jobs', headers: { ...f.buyerHeaders, 'idempotency-key': randomUUID() }, payload: { capabilityId: f.cap.id, input: {}, executionMode: 'NOW', ...extra } });
      expect((await create({ maxPauseMs: 900000 })).statusCode).toBe(400);
      const response = await create(); expect(response.statusCode, response.body).toBe(201); const job = response.json();
      expect(job.maxPauseMs).toBe(75000);
      app.kivro.config.maxPauseMs = 1000;
      const offers = await f.signed('GET', '/api/worker/offers'); expect(offers.statusCode, offers.body).toBe(200);
      expect(offers.json().offers[0].payload.maxPauseMs).toBe(75000);
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).maxPauseMs).toBe(75000);
      await expect(db.job.update({ where: { id: job.id }, data: { maxPauseMs: 900000 } })).rejects.toThrow('pause budget is immutable');
      expect((await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: f.buyerHeaders, payload: {} })).statusCode).toBe(200);
    } finally { app.kivro.config.maxPauseMs = 120000; }
  });
  it('retains funds within the original budget, resumes once, and expires the combined second pause', async () => {
    const f = await fixture(), job = await f.makeJob();
    app.kivro.config.maxPauseMs = 1000;
    try {
      await reconcileJobs(app.kivro);
      expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ state: 'PAUSED', paymentState: 'RESERVED', pausedAt: job.pausedAt });
      expect(await db.ledgerEntry.count({ where: { jobId: job.id, type: { in: ['JOB_RELEASE', 'JOB_CAPTURE', 'SELLER_EARNING'] } } })).toBe(0);
      const event = (type: string) => f.signed('POST', `/api/worker/jobs/${job.id}/events`, { attemptId: job.activeAttemptId, type });
      expect((await event('PAUSED')).statusCode).toBe(200);
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).pausedAt).toEqual(job.pausedAt);
      expect((await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/resume`, headers: f.headers, payload: {} })).statusCode).toBe(200);
      expect((await event('RUNNING')).statusCode).toBe(200);
      const resumed = await db.job.findUniqueOrThrow({ where: { id: job.id } }); expect(resumed.pausedDurationMs).toBeGreaterThanOrEqual(90000); expect(resumed.pausedAt).toBeNull();
      expect((await event('RUNNING')).statusCode).toBe(200);
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).pausedDurationMs).toBe(resumed.pausedDurationMs);
      await expect(db.job.update({ where: { id: job.id }, data: { pausedDurationMs: 0 } })).rejects.toThrow('cannot decrease');
      expect((await event('PAUSED')).statusCode).toBe(200);
      await db.job.update({ where: { id: job.id }, data: { pausedAt: new Date(Date.now() - 40000) } });
      await reconcileJobs(app.kivro); await reconcileJobs(app.kivro); await released(job.id);
    } finally { app.kivro.config.maxPauseMs = 120000; }
  });
  it('rejects pause before RUNNING without changing an accepted job, funds, or commands', async () => {
    const f = await fixture();
    const created = await app.inject({ method: 'POST', url: '/api/jobs', headers: { ...f.buyerHeaders, 'idempotency-key': randomUUID() },
      payload: { capabilityId: f.cap.id, input: {}, executionMode: 'NOW' } });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    const offers = await f.signed('GET', '/api/worker/offers');
    expect(offers.statusCode, offers.body).toBe(200);
    const attemptId = offers.json().offers[0].payload.attemptId;
    const accepted = await f.signed('POST', `/api/worker/jobs/${id}/events`, { attemptId, type: 'ACCEPTED' });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const before = await db.job.findUniqueOrThrow({ where: { id } });
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } });
    const ledger = await db.ledgerEntry.findMany({ where: { jobId: id } });
    const events = await db.jobEvent.count({ where: { jobId: id } });
    for (let replay = 0; replay < 2; replay++) {
      const response = await app.inject({ method: 'POST', url: `/api/jobs/${id}/pause`, headers: f.headers, payload: {} });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe('PAUSE_NOT_SUPPORTED_IN_CURRENT_STAGE');
    }
    expect(before.state).toBe('ACCEPTED');
    expect(await db.job.findUniqueOrThrow({ where: { id } })).toEqual(before);
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } })).toEqual(wallet);
    expect(await db.ledgerEntry.findMany({ where: { jobId: id } })).toEqual(ledger);
    expect(await db.jobEvent.count({ where: { jobId: id } })).toBe(events);
    expect(await db.workerCommand.count({ where: { jobId: id } })).toBe(0);
  });
  it.each(['resume-control', 'RUNNING', 'RESUMING', 'PAUSED', 'result'] as const)('commits expiry and release for %s without waiting for maintenance', async action => {
    const f = await fixture(), job = await f.makeJob(action === 'result' ? { state: 'RUNNING', pausedAt: null, pausedDurationMs: 120001 } : { pausedDurationMs: 90000, pausedAt: new Date(Date.now() - 31000) });
    const response = action === 'resume-control'
      ? await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/resume`, headers: f.headers, payload: {} })
      : action === 'result' ? await f.signed('POST', `/api/worker/jobs/${job.id}/result`, { attemptId: job.activeAttemptId, output: { text: 'Must not settle' } })
      : await f.signed('POST', `/api/worker/jobs/${job.id}/events`, { attemptId: job.activeAttemptId, type: action });
    expect(response.statusCode, response.body).toBe(action === 'resume-control' ? 200 : 409);
    if (action !== 'resume-control') expect(response.json().error.code).toBe('PAUSE_BUDGET_EXCEEDED');
    await released(job.id); await reconcileJobs(app.kivro); await released(job.id);
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } })).toMatchObject({ availableMinor: 1000, reservedMinor: 0, spentMinor: 0 });
  });
  it('blocks accepted payload and output-ticket access after pause expiry, even before maintenance', async () => {
    const f = await fixture(), job = await f.makeJob({ state: 'RUNNING', pausedAt: null, pausedDurationMs: 120001 });
    for (const response of [await f.signed('GET', `/api/worker/jobs/${job.id}/payload?attemptId=${job.activeAttemptId}`),
      await f.signed('POST', `/api/worker/jobs/${job.id}/uploads`, { attemptId: job.activeAttemptId, filename: 'proof.txt', mimeType: 'text/plain', sizeBytes: 3, sha256: 'a'.repeat(64) })]) {
      expect(response.statusCode, response.body).toBe(409); expect(response.json().error.code).toBe('PAUSE_BUDGET_EXCEEDED');
    }
    expect(await db.assetUpload.count({ where: { jobId: job.id } })).toBe(0);
    await reconcileJobs(app.kivro); await released(job.id);
  });
  it('requires explicit existing-job confirmation without reopening a globally paused Worker', async () => {
    const f = await fixture(), job = await f.makeJob();
    await db.workerDevice.update({ where: { id: f.worker.id }, data: { paused: true, localPaused: true } });
    const resume = (confirmGlobalPause?: boolean, headers = f.headers) => app.inject({ method: 'POST', url: `/api/jobs/${job.id}/resume`, headers, payload: { ...(confirmGlobalPause === undefined ? {} : { confirmGlobalPause }) } });
    for (const flag of [undefined, false]) {
      const response = await resume(flag); expect(response.statusCode, response.body).toBe(409); expect(response.json().error.code).toBe('GLOBAL_PAUSE_CONFIRMATION_REQUIRED');
    }
    expect((await resume(true, f.buyerHeaders)).statusCode).toBe(403);
    expect(await db.workerCommand.count({ where: { jobId: job.id } })).toBe(0);
    for (let replay = 0; replay < 2; replay++) expect((await resume(true)).statusCode).toBe(200);
    const commands = await db.workerCommand.findMany({ where: { jobId: job.id, type: 'RESUME_JOB' } });
    expect(commands).toHaveLength(1); expect(commands[0]!.resumeWhilePaused).toBe(true);
    const heartbeat = await f.signed('POST', '/api/worker/heartbeat', { version: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)', sandboxReady: true, paused: true, capabilities: [f.version.id], runningJobIds: [job.id], health: { ready: true } });
    expect(heartbeat.statusCode, heartbeat.body).toBe(200); expect(heartbeat.json().commands).toContainEqual({ id: commands[0]!.id, jobId: job.id, type: 'RESUME_JOB', resumeWhilePaused: true });
    expect((await f.signed('GET', '/api/worker/offers')).json().offers).toEqual([]);
    expect((await f.signed('POST', `/api/worker/jobs/${job.id}/events`, { attemptId: job.activeAttemptId, type: 'RUNNING' })).statusCode).toBe(200);
    const resumed = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect((await resume()).json().state).toBe('RUNNING');
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).pausedDurationMs).toBe(resumed.pausedDurationMs);
    expect(await db.workerCommand.count({ where: { jobId: job.id, type: 'RESUME_JOB' } })).toBe(1);
    expect(await db.workerDevice.findUniqueOrThrow({ where: { id: f.worker.id } })).toMatchObject({ paused: true, localPaused: true });
    const audit = await db.auditEvent.findMany({ where: { jobId: job.id, type: 'JOB_STATE_CHANGED' }, orderBy: { createdAt: 'asc' } });
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ actorId: f.sellerId, metadata: { previousState: 'PAUSED', newState: 'RESUMING', attemptId: job.activeAttemptId, source: 'ACCOUNT_API' } });
    expect(audit[1]).toMatchObject({ workerId: f.worker.id, metadata: { previousState: 'RESUMING', newState: 'RUNNING', attemptId: job.activeAttemptId, source: 'WORKER' } });
  });
  it('cannot use global-pause confirmation to bypass a security revocation', async () => {
    const f = await fixture(), job = await f.makeJob();
    await db.workerDevice.update({ where: { id: f.worker.id }, data: { paused: true, revokedAt: new Date() } });
    const response = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/resume`, headers: f.headers, payload: { confirmGlobalPause: true } });
    expect(response.statusCode).toBe(403); expect(await db.workerCommand.count({ where: { jobId: job.id, type: 'RESUME_JOB' } })).toBe(0);
  });
  it('keeps the historical input contract after publishing a different current version', async () => {
    const f = await fixture(), job = await f.makeJob();
    const changed = { ...f.manifest, ioContract: { ...f.manifest.ioContract, inputs: [{ key: 'newField', label: 'New required field', type: 'SHORT_TEXT', required: true, order: 0, constraints: { maxLength: 80 } }] } };
    const next = await db.capabilityVersion.create({ data: { capabilityId: f.cap.id, version: 2, title: 'Changed', summary: 'Different contract', description: '', category: f.version.category, tags: [], priceTierId: 'USD_99',
      ...changed, ioContract: json(changed.ioContract), permissions: json(changed.permissions), dependencies: json(changed.dependencies), manifestHash: executionManifestHash(changed), publishedAt: new Date() } });
    await db.capability.update({ where: { id: f.cap.id }, data: { currentVersionId: next.id } });
    const response = await app.inject({ url: `/api/jobs/${job.id}`, headers: f.buyerHeaders });
    expect(response.statusCode, response.body).toBe(200); expect(response.json()).toMatchObject({ capabilityVersionId: f.version.id, capabilityVersionNumber: 1, inputContract: f.manifest.ioContract.inputs, outputContract: f.manifest.ioContract.output });
  });
});
