import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma, PrismaClient, serializable } from '@kivro/database';
import { DEFAULT_SCHEDULE, getPriceTier } from '@kivro/contracts';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';
import { consumeBucket } from '../src/abuse.js';
import { expireJobContent, maintenance } from '../src/background.js';
import { deliverWebhooks, encryptSecret, webhookSignature } from '../src/webhooks.js';
import { reconcileWorkerHealth } from '../src/worker-health.js';
import { canonicalWorkerRequest } from '../src/worker.js';
import { creditWallet, reserveJob } from '@kivro/billing';
import { failJob } from '../src/jobs.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('operator controls and retention (isolated PostgreSQL)', () => {
  let db: PrismaClient, app: FastifyInstance;
  const schema = `operations_test_${randomBytes(8).toString('hex')}`, encryptionKey = randomBytes(32).toString('hex');
  const origin = 'http://localhost:3000';
  const fixture = async (isAdmin = false) => {
    const id = randomUUID(), token = randomUUID(), apiKey = randomUUID();
    await db.user.create({ data: { id, email: `${id}@operations.kivro.local`, name: 'Operator fixture', passwordHash: 'disabled', isAdmin,
      sessions: { create: { tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + 3600_000) } }, wallet: { create: {} },
      apiKeys: { create: { name: 'Fixture', prefix: apiKey.slice(0, 12), secretHash: hashSecret(apiKey), scopes: ['jobs:read'] } } } });
    return { id, token, apiKey, headers: { origin, cookie: `kivro_session=${token}` } };
  };
  type UserFixture = Awaited<ReturnType<typeof fixture>>;
  let buyer: UserFixture, seller: UserFixture, admin: UserFixture, stranger: UserFixture;
  let capabilityId: string, versionId: string;
  const price = getPriceTier('USD_99');
  const createJob = (ageDays = 0, retentionDays = 30) => db.job.create({ data: { buyerId: buyer.id, sellerId: seller.id, capabilityId, capabilityVersionId: versionId,
    state: 'SUCCEEDED', paymentState: 'SETTLED', input: { text: 'Private expired text' }, output: { text: 'Private result' }, priceSnapshot: price,
    buyerPriceMinor: price.buyerPriceMinor, platformFeeMinor: price.platformFeeMinor, sellerNetMinor: price.sellerNetMinor, executionMode: 'NOW',
    completedAt: new Date(Date.now() - ageDays * 86400_000), waitDeadline: new Date(), contentRetentionDays: retentionDays } });
  beforeAll(async () => {
    process.loadEnvFile('.env');
    const url = new URL(process.env.DATABASE_URL!);
    if (process.env.KIVRO_ENV !== 'development' || url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/kivro') throw new Error('Requires local development DB');
    url.searchParams.set('schema', schema);
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url.toString() } });
    db = new PrismaClient({ datasourceUrl: url.toString() });
    app = await createApp({ db, logger: false, env: { ...process.env, NODE_ENV: 'test', PAYMENT_MODE: 'fake', WEB_ORIGIN: origin, WEBHOOK_ENCRYPTION_KEY: encryptionKey,
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', PLATFORM_OPENAI_API_KEY: '', PLATFORM_ANTHROPIC_API_KEY: '', PLATFORM_INFERENCE_PROVIDER: '' } });
    buyer = await fixture(); seller = await fixture(); admin = await fixture(true); stranger = await fixture();
    const cap = await db.capability.create({ data: { sellerId: seller.id, slug: randomUUID(), visibility: 'PUBLIC', schedule: DEFAULT_SCHEDULE } });
    capabilityId = cap.id;
    const version = await db.capabilityVersion.create({ data: { capabilityId, version: 1, title: 'Policy fixture', summary: 'Synthetic fixture', description: '', category: 'Writing', tags: [], priceTierId: price.id,
      ioContract: { schemaVersion: 1, inputs: [], output: { type: 'TEXT', description: 'Result', required: true } },
      permissions: { schemaVersion: 1, tools: [], network: { mode: 'NONE', allowedDomains: [] }, resources: [], inference: { provider: 'openai-compatible', model: 'test' }, limits: { timeoutSeconds: 300, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 1024, maxOutputBytes: 1024, maxTokens: 1000 } },
      dependencies: [], internalInstructions: 'Synthetic fixture', manifestHash: 'a'.repeat(64), publishedAt: new Date() } });
    versionId = version.id;
    await db.capability.update({ where: { id: capabilityId }, data: { currentVersionId: versionId } });
    const terms = (await app.inject('/api/terms')).json();
    expect((await app.inject({ method: 'POST', url: '/api/account/terms', headers: buyer.headers, payload: { version: terms.version } })).statusCode).toBe(200);
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      if (!/^operations_test_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await db.$disconnect();
    }
  });
  it('requires admin sessions and compare-and-swap, then blocks purchase before funds move', async () => {
    const payload = { policy: { blockedCategories: ['Writing'] }, expectedRevision: 0, reason: 'Synthetic security restriction' };
    expect((await app.inject({ method: 'PUT', url: '/api/admin/security-policy', headers: buyer.headers, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/admin/security-policy', headers: { authorization: `Bearer ${admin.apiKey}` }, payload })).statusCode).toBe(403);
    const update = await app.inject({ method: 'PUT', url: '/api/admin/security-policy', headers: admin.headers, payload });
    expect(update.statusCode, update.body).toBe(200); expect(update.json().revision).toBe(1);
    expect((await app.inject({ method: 'PUT', url: '/api/admin/security-policy', headers: admin.headers, payload })).statusCode).toBe(409);
    const buy = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: { ...buyer.headers, 'idempotency-key': randomUUID() }, payload: { capabilityId, input: {}, executionMode: 'NOW' } });
    expect(buy.statusCode, buy.body).toBe(409); expect(buy.json().error.code).toBe('CATEGORY_BLOCKED');
    expect(await db.ledgerEntry.count({ where: { userId: buyer.id } })).toBe(0);
    expect((await app.inject({ method: 'PUT', url: '/api/admin/security-policy', headers: admin.headers,
      payload: { ...payload, expectedRevision: 1, policy: { blockedCategories: [] } } })).statusCode).toBe(200);
  });
  it('reuses buyer v1 scope and historical response contracts without exposing private Worker aliases', async () => {
    const job = await createJob();
    const response = await app.inject({ url: `/api/v1/jobs/${job.id}`, headers: { authorization: `Bearer ${buyer.apiKey}` } });
    expect(response.statusCode, response.body).toBe(200); expect(response.headers['x-kivro-api-version']).toBe('1');
    expect(response.json()).toMatchObject({ capabilityVersionNumber: 1, outputContract: { type: 'TEXT' }, pauseSupport: 'FULL_RESUME' });
    expect(response.json().contentExpiresAt).toBe(new Date(job.completedAt!.getTime() + 30 * 86400_000).toISOString());
    expect((await app.inject({ url: `/api/v1/jobs/${job.id}`, headers: stranger.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: { authorization: `Bearer ${buyer.apiKey}`, 'idempotency-key': randomUUID() }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject('/api/v1/worker/offers')).statusCode).toBe(404);
  });
  it('enforces an atomic shared hit/spend bucket under concurrent transactions', async () => {
    const key = randomUUID();
    const responses = await Promise.allSettled(Array.from({ length: 12 }, () => serializable(db, tx => consumeBucket(tx, key, 5, 3600_000, 20, 100))));
    expect(responses.filter(result => result.status === 'fulfilled')).toHaveLength(5);
    for (const result of responses) if (result.status === 'rejected') expect(result.reason.code).toBe('ACCOUNT_LIMIT');
    await expect(consumeBucket(db, randomUUID(), 5, 3600_000, 101, 100)).rejects.toMatchObject({ code: 'ACCOUNT_LIMIT' });
  });
  it('shares account limits across separate scoped API keys', async () => {
    const user = await fixture(), second = randomUUID(), oldLimit = app.kivro.config.accountRequestsPerMinute;
    await db.apiKey.create({ data: { userId: user.id, name: 'Second', prefix: second.slice(0, 12), secretHash: hashSecret(second), scopes: ['jobs:read'] } });
    app.kivro.config.accountRequestsPerMinute = 3;
    try {
      for (const key of [user.apiKey, second, user.apiKey]) expect((await app.inject({ url: '/api/v1/jobs', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(200);
      const blocked = await app.inject({ url: '/api/jobs', headers: { authorization: `Bearer ${second}` } });
      expect(blocked.statusCode).toBe(429); expect(blocked.json().error.code).toBe('ACCOUNT_LIMIT');
    } finally { app.kivro.config.accountRequestsPerMinute = oldLimit; }
  });
  it('rolls back rejected transactional daily spend and starts a separate UTC-day bucket', async () => {
    const identity = `daily-boundary:${randomUUID()}`, clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(Date.parse('2026-10-06T23:59:59.999Z'));
      await expect(serializable(db, async tx => { await consumeBucket(tx, identity, 1, 86400_000, 99, 99); throw new Error('Synthetic downstream rejection'); })).rejects.toThrow('downstream');
      await consumeBucket(db, identity, 1, 86400_000, 99, 99);
      await expect(consumeBucket(db, identity, 1, 86400_000, 1, 99)).rejects.toMatchObject({ code: 'ACCOUNT_LIMIT', details: { retryAt: '2026-10-07T00:00:00.000Z' } });
      clock.mockReturnValue(Date.parse('2026-10-07T00:00:00.000Z'));
      await consumeBucket(db, identity, 1, 86400_000, 99, 99);
      await expect(consumeBucket(db, identity, 1, 86400_000, 1, 99)).rejects.toMatchObject({ code: 'ACCOUNT_LIMIT', details: { retryAt: '2026-10-08T00:00:00.000Z' } });
    } finally { clock.mockRestore(); }
  });
  it('accepts all explicit UI agent constraints, requires scheduling consent and enforces the daily turn ceiling', async () => {
    const user = await fixture(), limit = app.kivro.config.agentTurnsPerDay;
    const body = { message: 'Find document processing', budgetMinor: 2000, maxPerJobSpendMinor: 500, maxJobs: 3, blockedSellers: [seller.id],
      noNetwork: true, maxQueueWaitSeconds: 60, minRating: 4, maxRuntimeSeconds: 300, outputTypes: ['TEXT'], timingMode: 'IMMEDIATE', mode: 'DISCOVERY' };
    app.kivro.config.agentTurnsPerDay = 1;
    try {
      const response = await app.inject({ method: 'POST', url: '/api/agent/chat', headers: user.headers, payload: body });
      expect(response.statusCode, response.body).toBe(200); expect(response.json().inferenceStatus).toBe('UNAVAILABLE');
      await app.kivro.initializeInferenceRouting!();
      const routing = await db.auditEvent.findMany({ where: { type: 'PLATFORM_INFERENCE_ROUTING_CHANGED' } });
      expect(routing).toHaveLength(1); expect(routing[0]?.metadata).toMatchObject({ source: 'OPERATOR_ENVIRONMENT', next: { profiles: {} } });
      expect(await db.agentConversation.count({ where: { userId: user.id } })).toBe(1);
      expect((await app.inject({ method: 'POST', url: '/api/agent/chat', headers: user.headers, payload: body })).statusCode).toBe(429);
      const other = await fixture();
      const denied = await app.inject({ method: 'POST', url: '/api/agent/chat', headers: other.headers, payload: { ...body, timingMode: 'EARLIEST_AVAILABLE_ALLOWED' } });
      expect(denied.statusCode).toBe(400); expect(denied.json().error.code).toBe('EXPLICIT_SCHEDULING_CONSENT_REQUIRED');
    } finally { app.kivro.config.agentTurnsPerDay = limit; }
  });
  it('scopes problem reports and moderation, with audit and conflict checks but no payment changes', async () => {
    const job = await createJob(), payload = { jobId: job.id, category: 'QUALITY', description: 'Synthetic quality issue description' };
    expect((await app.inject({ method: 'POST', url: '/api/reports', headers: stranger.headers, payload })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/reports', headers: { authorization: `Bearer ${buyer.apiKey}` }, payload })).statusCode).toBe(403);
    const created = await app.inject({ method: 'POST', url: '/api/reports', headers: buyer.headers, payload });
    expect(created.statusCode, created.body).toBe(201);
    expect((await app.inject({ url: '/api/reports', headers: stranger.headers })).json()).toEqual([]);
    expect((await app.inject({ url: '/api/admin/reports', headers: buyer.headers })).statusCode).toBe(403);
    const url = `/api/admin/reports/${created.json().id}`, resolution = { status: 'RESOLVED', resolution: 'Synthetic resolution for the reporter', expectedRevision: 0 };
    expect((await app.inject({ method: 'PUT', url, headers: admin.headers, payload: resolution })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url, headers: admin.headers, payload: resolution })).statusCode).toBe(409);
    expect((await app.inject({ url: '/api/reports', headers: buyer.headers })).json()[0]).toMatchObject({ status: 'RESOLVED', revision: 1 });
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).paymentState).toBe('SETTLED');
    expect(await db.auditEvent.count({ where: { type: 'PROBLEM_REPORT_REVIEWED' } })).toBe(1);
  });
  it('purges only expired terminal content using its immutable retention snapshot', async () => {
    const expired = await createJob(31), fresh = await createJob(1), extended = await createJob(31, 60);
    await expect(db.job.update({ where: { id: fresh.id }, data: { input: {}, output: Prisma.JsonNull, contentDeletedAt: new Date() } })).rejects.toThrow('immutable');
    await expect(db.job.update({ where: { id: expired.id }, data: { contentRetentionDays: 1 } })).rejects.toThrow('immutable');
    await expireJobContent(app.kivro); await expireJobContent(app.kivro);
    const purged = await db.job.findUniqueOrThrow({ where: { id: expired.id } });
    expect(purged).toMatchObject({ input: {}, output: null, paymentState: 'SETTLED', priceSnapshot: price });
    expect(purged.contentDeletedAt).not.toBeNull();
    for (const job of [fresh, extended]) expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).contentDeletedAt).toBeNull();
    await expect(db.job.update({ where: { id: expired.id }, data: { input: { text: 'Restore deleted content' } } })).rejects.toThrow('immutable');
  });
  it('queues a single owned signed webhook test and exposes terminal delivery failure', async () => {
    const secret = randomBytes(32).toString('hex');
    const endpoint = await db.webhookEndpoint.create({ data: { userId: buyer.id, url: 'https://webhook.example.test/events', events: ['job.completed'], secretEncrypted: encryptSecret(secret, encryptionKey) } });
    const url = `/api/v1/webhooks/${endpoint.id}/test`;
    expect((await app.inject({ method: 'POST', url, headers: stranger.headers, payload: {} })).statusCode).toBe(404);
    const response = await app.inject({ method: 'POST', url, headers: buyer.headers, payload: {} });
    expect(response.statusCode, response.body).toBe(200);
    let sends = 0;
    await deliverWebhooks(app.kivro, async (target, body, headers) => {
      sends++; expect(target).toBe(endpoint.url); expect(JSON.parse(body)).toMatchObject({ type: 'webhook.test', data: { test: true } });
      expect(headers['kivro-signature']).toBe(`v1=${webhookSignature(secret, headers['kivro-timestamp']!, body)}`); return 503;
    });
    expect(sends).toBe(1);
    await db.webhookDelivery.update({ where: { id: response.json().deliveryId }, data: { attempts: 6, nextAttemptAt: new Date(0) } });
    await deliverWebhooks(app.kivro, async () => 503);
    const list = (await app.inject({ url: '/api/v1/webhooks', headers: buyer.headers })).json();
    expect(list[0]).toMatchObject({ status: 'DEGRADED', deliveries: [{ status: 'FAILED', attempts: 7 }] });
    expect(list[0].deliveries[0].failedAt).not.toBeNull();
    await deliverWebhooks(app.kivro, async () => { throw new Error('Terminal delivery must not retry'); });
    expect(await db.webhookDelivery.count({ where: { endpointId: endpoint.id } })).toBe(1);
  });
  it('retains sanitized health transitions once and detects heartbeat expiry without receiving another heartbeat', async () => {
    const worker = await db.workerDevice.create({ data: { sellerId: seller.id, name: 'Health fixture', publicKey: `unused-${randomUUID()}`,
      version: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)', sandboxReady: true, lastSeenAt: new Date(), health: { privateValue: 'must-not-log-this' } } });
    await reconcileWorkerHealth(app.kivro); await reconcileWorkerHealth(app.kivro);
    expect(await db.auditEvent.count({ where: { workerId: worker.id, type: 'WORKER_HEALTH' } })).toBe(1);
    await db.workerDevice.update({ where: { id: worker.id }, data: { lastSeenAt: new Date(0) } });
    await reconcileWorkerHealth(app.kivro);
    const events = await db.auditEvent.findMany({ where: { workerId: worker.id, type: 'WORKER_HEALTH' }, orderBy: { createdAt: 'asc' } });
    expect(events.map(event => (event.metadata as { status: string }).status)).toEqual(['READY', 'OFFLINE']);
    expect(JSON.stringify(events)).not.toContain('must-not-log-this');
    const own = (await app.inject({ url: '/api/seller/workers', headers: seller.headers })).json().find((row: { id: string }) => row.id === worker.id);
    expect(own.healthHistory).toHaveLength(2); expect(own.minimumWorkerVersion).toBe('0.1.0');
    expect((await app.inject({ url: '/api/seller/workers', headers: stranger.headers })).json()).toEqual([]);
  });
  it('isolates a damaged reservation without rewriting money or starving unrelated maintenance', async () => {
    const damaged = await createJob();
    await db.job.update({ where: { id: damaged.id }, data: { state: 'QUEUED', paymentState: 'RESERVED', waitDeadline: new Date(0) } });
    const expired = await createJob(31), tick = app.kivro.tickPlans;
    app.kivro.tickPlans = async () => { throw new Error('Private simulated provider payload must never be logged'); };
    try {
      await maintenance(app.kivro); await maintenance(app.kivro);
      expect((await db.job.findUniqueOrThrow({ where: { id: damaged.id } }))).toMatchObject({ state: 'QUEUED', paymentState: 'RESERVED' });
      expect((await db.platformSetting.findUniqueOrThrow({ where: { key: `job-recovery-error:${damaged.id}` } })).value).toMatchObject({ code: 'LEDGER_INVARIANT', attempts: 1 });
      expect(await db.auditEvent.count({ where: { jobId: damaged.id, type: 'JOB_RECOVERY_REQUIRED' } })).toBe(1);
      expect((await db.job.findUniqueOrThrow({ where: { id: expired.id } })).contentDeletedAt).not.toBeNull();
      expect((await db.platformSetting.findUniqueOrThrow({ where: { key: 'maintenance-error:plans' } })).value).toMatchObject({ code: 'OPERATION_FAILED' });
      expect(await db.ledgerEntry.count({ where: { jobId: damaged.id } })).toBe(0);
    } finally { app.kivro.tickPlans = tick; }
  });
  it('versioned diagnostics disclose authenticated seller and environment while preserving the legacy shape', async () => {
    const keys = generateKeyPairSync('ed25519');
    const worker = await db.workerDevice.create({ data: { sellerId: seller.id, name: 'Diagnostic authority fixture', version: '0.1.0',
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } });
    const get = (url: string) => {
      const timestamp = String(Date.now()), nonce = randomUUID();
      return app.inject({ method: 'GET', url, headers: { 'x-worker-id': worker.id, 'x-worker-timestamp': timestamp, 'x-worker-nonce': nonce,
        'x-worker-signature': sign(null, Buffer.from(canonicalWorkerRequest('GET', url, timestamp, nonce, Buffer.alloc(0))), keys.privateKey).toString('base64') } });
    };
    const legacy = await get('/api/worker/diagnostics'), current = await get('/api/worker/diagnostics/v2');
    expect(legacy.statusCode, legacy.body).toBe(200); expect(current.statusCode, current.body).toBe(200);
    expect(current.json()).toMatchObject({ workerId: worker.id, sellerId: seller.id, deploymentEnvironment: app.kivro.config.deploymentEnvironment });
    expect(legacy.json()).not.toHaveProperty('sellerId'); expect(legacy.json()).not.toHaveProperty('deploymentEnvironment');
    expect(Object.keys(current.json()).sort()).toEqual([...Object.keys(legacy.json()), 'sellerId', 'deploymentEnvironment', 'securityWarnings'].sort());
    expect(current.json().securityWarnings).toMatchObject({ schemaVersion: 1, items: expect.any(Array) });
    expect(legacy.json()).not.toHaveProperty('securityWarnings');
    expect((await db.workerDevice.findUniqueOrThrow({ where: { id: worker.id } })).lastSeenAt).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/worker/diagnostics/v2', headers: seller.headers })).statusCode).toBe(400);
    await db.workerDevice.update({ where: { id: worker.id }, data: { revokedAt: new Date() } });
    const revoked = await get('/api/worker/diagnostics/v2');
    expect(revoked.statusCode).toBe(401); expect(revoked.json().error.code).toBe('WORKER_REVOKED');
  });
  it('stores only immutable signed own-attempt usage without changing payment or accepting secrets', async () => {
    const keys = generateKeyPairSync('ed25519'), job = await createJob();
    const worker = await db.workerDevice.create({ data: { sellerId: seller.id, name: 'Usage fixture', version: '0.1.0', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } });
    const attempt = await db.jobAttempt.create({ data: { jobId: job.id, workerId: worker.id, expiresAt: new Date(), nonce: randomUUID(), state: 'SUCCEEDED', acceptedAt: new Date(), finishedAt: new Date() } });
    const receipt = { attemptId: attempt.id, provider: 'openai-compatible', model: 'test', attemptedCalls: 2, successfulCalls: 1, unpricedCalls: 1,
      inputTokens: 100, outputTokens: 20, estimatedCostMicroUsd: 500, reservedCostMicroUsd: 1000, costBasis: 'WORKER_CONFIGURED_RATES' };
    const url = `/api/worker/jobs/${job.id}/usage`;
    const send = (payload: unknown, target = url) => {
      const timestamp = String(Date.now()), nonce = randomUUID(), raw = JSON.stringify(payload);
      return app.inject({ method: 'POST', url: target, payload: raw, headers: { 'content-type': 'application/json', 'x-worker-id': worker.id,
        'x-worker-timestamp': timestamp, 'x-worker-nonce': nonce, 'x-worker-signature': sign(null, Buffer.from(canonicalWorkerRequest('POST', target, timestamp, nonce, Buffer.from(raw))), keys.privateKey).toString('base64') } });
    };
    expect((await app.inject({ method: 'POST', url, headers: seller.headers, payload: receipt })).statusCode).not.toBe(200);
    expect((await send({ ...receipt, secret: 'forbidden' })).statusCode).toBe(400);
    expect((await send({ ...receipt, model: 'wrong-model' })).statusCode).toBe(400);
    expect((await send(receipt, `/api/worker/jobs/${randomUUID()}/usage`)).statusCode).toBe(404);
    const success = await send(receipt); expect(success.statusCode, success.body).toBe(200);
    expect((await send(receipt)).statusCode).toBe(200);
    expect((await send({ ...receipt, estimatedCostMicroUsd: 501 })).statusCode).toBe(409);
    expect(await db.auditEvent.count({ where: { jobId: job.id, type: 'WORKER_USAGE_RECORDED' } })).toBe(1);
    expect((await db.jobAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).usageReceipt).toEqual(receipt);
    await expect(db.jobAttempt.update({ where: { id: attempt.id }, data: { usageReceipt: Prisma.DbNull, usageReportedAt: null } })).rejects.toThrow('immutable');
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).paymentState).toBe('SETTLED');
    expect(await db.ledgerEntry.count({ where: { jobId: job.id } })).toBe(0);
    const unfinished = await db.jobAttempt.create({ data: { jobId: job.id, workerId: worker.id, expiresAt: new Date(), nonce: randomUUID() } });
    expect((await send({ ...receipt, attemptId: unfinished.id })).statusCode).toBe(409);
  });
  it.each([
    ['revokedWorkerVersions', ['0.1.0'], 'WORKER_VERSION_REVOKED'],
    ['revokedOpenClawVersions', ['2026.8.2'], 'OPENCLAW_VERSION_REVOKED'],
    ['blockedCategories', ['Writing'], 'CATEGORY_BLOCKED'],
  ])('rechecks %s at execution, private-data and upload boundaries before maintenance', async (field, values, code) => {
    const keys = generateKeyPairSync('ed25519');
    const worker = await db.workerDevice.create({ data: { sellerId: seller.id, name: 'Policy boundary fixture', version: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)',
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), sandboxReady: true, lastSeenAt: new Date() } });
    const signed = (method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const timestamp = String(Date.now()), nonce = randomUUID(), raw = payload === undefined ? '' : JSON.stringify(payload);
      return app.inject({ method, url, ...(payload === undefined ? {} : { payload: raw }), headers: { 'content-type': 'application/json', 'x-worker-id': worker.id,
        'x-worker-timestamp': timestamp, 'x-worker-nonce': nonce, 'x-worker-signature': sign(null, Buffer.from(canonicalWorkerRequest(method, url.split('?')[0]!, timestamp, nonce, Buffer.from(raw))), keys.privateKey).toString('base64') } });
    };
    await serializable(db, tx => creditWallet(tx, buyer.id, 10000, `policy-boundary:${randomUUID()}`));
    const jobs = [];
    for (const state of ['OFFERED', 'ACCEPTED', 'PAUSED', 'RUNNING'] as const) jobs.push(await serializable(db, async tx => {
      const job = await tx.job.create({ data: { buyerId: buyer.id, sellerId: seller.id, capabilityId, capabilityVersionId: versionId, state,
        input: {}, priceSnapshot: price, buyerPriceMinor: price.buyerPriceMinor, platformFeeMinor: price.platformFeeMinor, sellerNetMinor: price.sellerNetMinor,
        executionMode: 'NOW', waitDeadline: new Date(Date.now() + 60000) } });
      await reserveJob(tx, job);
      const attempt = await tx.jobAttempt.create({ data: { jobId: job.id, workerId: worker.id, state, expiresAt: new Date(Date.now() + 60000), nonce: randomUUID(),
        ...(state === 'OFFERED' ? {} : { acceptedAt: new Date() }) } });
      return tx.job.update({ where: { id: job.id }, data: { activeAttemptId: attempt.id } });
    }));
    const running = jobs[3]!, stored = await app.kivro.storage.put(Buffer.from('private fixture'), 'source.txt', 'text/plain');
    const asset = await db.asset.create({ data: { ownerId: buyer.id, filename: 'source.txt', mimeType: 'text/plain', sizeBytes: stored.sizeBytes, sha256: stored.sha256,
      objectKey: stored.key, expiresAt: new Date(Date.now() + 60000), scanStatus: 'DEVELOPMENT_ONLY', grants: { create: { jobId: running.id, expiresAt: new Date(Date.now() + 60000) } } } });
    const uploadResponse = await signed('POST', `/api/worker/jobs/${running.id}/uploads`, {
      attemptId: running.activeAttemptId, filename: 'source.txt', mimeType: 'text/plain', sizeBytes: stored.sizeBytes, sha256: stored.sha256,
    });
    expect(uploadResponse.statusCode, uploadResponse.body).toBe(201);
    const upload = uploadResponse.json();
    expect((await fetch(upload.uploadUrl, { method: 'PUT', headers: upload.headers, body: 'private fixture' })).status).toBe(200);
    const previous = (await app.inject({ url: '/api/admin/security-policy', headers: admin.headers })).json();
    try {
      const changed = await app.inject({ method: 'PUT', url: '/api/admin/security-policy', headers: admin.headers,
        payload: { expectedRevision: previous.revision, policy: { ...previous, [field as string]: values }, reason: 'Synthetic execution boundary restriction' } });
      expect(changed.statusCode, changed.body).toBe(200);
      expect((await signed('GET', '/api/worker/offers')).json().offers).toEqual([]);
      for (const [index, type] of [[0, 'ACCEPTED'], [1, 'RUNNING'], [2, 'RESUMING']] as const) {
        const job = jobs[index]!;
        const response = await signed('POST', `/api/worker/jobs/${job.id}/events`, { attemptId: job.activeAttemptId, type });
        expect(response.statusCode, response.body).toBe(409); expect(response.json().error.code).toBe(code);
      }
      const requests = [
        signed('GET', `/api/worker/jobs/${running.id}/payload?attemptId=${running.activeAttemptId}`),
        signed('GET', `/api/worker/assets/${asset.id}/download`),
        signed('POST', `/api/worker/jobs/${running.id}/uploads`, { attemptId: running.activeAttemptId, filename: 'out.txt', mimeType: 'text/plain', sizeBytes: 5, sha256: 'a'.repeat(64) }),
        signed('POST', `/api/worker/jobs/${running.id}/uploads/${upload.id}/finalize`, { attemptId: running.activeAttemptId }),
        signed('POST', `/api/worker/jobs/${running.id}/result`, { attemptId: running.activeAttemptId, output: { text: 'Must not settle' } }),
        app.inject({ method: 'POST', url: `/api/jobs/${jobs[2]!.id}/resume`, headers: seller.headers, payload: {} }),
      ];
      for (const response of await Promise.all(requests)) { expect(response.statusCode, response.body).toBe(409); expect(response.json().error.code).toBe(code); }
      expect(await db.ledgerEntry.count({ where: { jobId: { in: jobs.map(job => job.id) }, type: 'JOB_CAPTURE' } })).toBe(0);
      expect(await db.assetUpload.count({ where: { jobId: running.id } })).toBe(1);
      expect((await db.assetUpload.findUniqueOrThrow({ where: { id: upload.id } })).assetId).toBeNull();
    } finally {
      const current = (await app.inject({ url: '/api/admin/security-policy', headers: admin.headers })).json();
      await app.inject({ method: 'PUT', url: '/api/admin/security-policy', headers: admin.headers, payload: { expectedRevision: current.revision, policy: previous, reason: 'Restore synthetic test policy baseline' } });
      for (const job of jobs) await serializable(db, tx => failJob(tx, job, 'CANCELLED', 'Synthetic policy fixture cleanup'));
      await app.kivro.storage.delete(stored.key);
      await app.kivro.storage.delete(`quarantine/${upload.id}`);
    }
  });
});
