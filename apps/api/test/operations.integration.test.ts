import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma, PrismaClient, type JobState } from '@kivro/database';
import { DEFAULT_SCHEDULE, type WorkerUsageReceipt } from '@kivro/contracts';
import { adminOperationsResponseSchema, sellerOperationsResponseSchema, operationsResponseRoutes } from '../../../packages/contracts/src/response-operations.js';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';
import { operationsSnapshot, registerOperations, type OperationsDTO } from '../src/operations.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('operations metrics from isolated real DB fixtures', () => {
  let db: PrismaClient, app: FastifyInstance;
  const sellerId = randomUUID(), buyerId = randomUUID(), otherSellerId = randomUUID(), adminId = randomUUID();
  const sellerToken = randomUUID(), otherToken = randomUUID(), adminToken = randomUUID(), apiKey = randomUUID();
  const users = [sellerId, buyerId, otherSellerId, adminId];
  const capId = randomUUID(), foreignCapId = randomUUID(), versionId = randomUUID(), versionTwoId = randomUUID(), foreignVersionId = randomUUID();
  const capabilityIds = [capId, foreignCapId];
  const now = new Date(), ago = (seconds: number) => new Date(now.getTime() - seconds * 1000), future = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  const periodDate = ago(7200), oldDate = ago(40 * 86400), provider = `operations-fixture-${randomUUID()}`;
  const secrets = 'operations-private-content-must-not-leak';
  const jobs: Record<string, string> = {}, workerIds: string[] = [], assetIds: string[] = [], settingKeys: string[] = [];
  const headers = (token = sellerToken) => ({ cookie: `kivro_session=${token}` });
  const read = async (path = '/api/seller/operations', token = sellerToken) => {
    const response = await app.inject({ url: path, headers: headers(token) });
    expect(response.statusCode, response.body).toBe(200);
    const value = response.json<OperationsDTO>();
    const schema = path.startsWith('/api/admin/') ? adminOperationsResponseSchema : sellerOperationsResponseSchema;
    expect(schema.parse(value)).toEqual(value);
    return value;
  };
  const job = async (name: string, state: JobState, data: Record<string, unknown> = {}) => {
    const id = randomUUID(); jobs[name] = id;
    await db.job.create({ data: { id, buyerId, sellerId, capabilityId: capId, capabilityVersionId: versionId, state,
      paymentState: state === 'SUCCEEDED' ? 'SETTLED' : ['SCHEDULED', 'QUEUED'].includes(state) ? 'RESERVED' : 'RELEASED',
      input: { privateText: secrets }, output: { text: secrets }, error: secrets, priceSnapshot: { fixture: true },
      buyerPriceMinor: 99, sellerNetMinor: 80, platformFeeMinor: 19, executionMode: state === 'SCHEDULED' ? 'SCHEDULED' : 'NOW',
      waitDeadline: future(86400), createdAt: periodDate, ...data } });
    return id;
  };
  const entries = async (jobId: string, at: Date, reversal = false, ownerId = sellerId) => {
    const transactionId = randomUUID(), prefix = `operations-fixture:${randomUUID()}`;
    await db.ledgerEntry.createMany({ data: [
      { operationKey: `${prefix}:buyer`, transactionId, jobId, userId: buyerId, type: reversal ? 'REFUND' : 'JOB_CAPTURE', amountMinor: reversal ? 99 : -99, createdAt: at },
      { operationKey: `${prefix}:seller`, transactionId, jobId, userId: ownerId, type: reversal ? 'SELLER_EARNING_REVERSAL' : 'SELLER_EARNING', amountMinor: reversal ? -80 : 80, createdAt: at },
      { operationKey: `${prefix}:fee`, transactionId, jobId, type: reversal ? 'PLATFORM_FEE_REVERSAL' : 'PLATFORM_FEE', amountMinor: reversal ? -19 : 19, createdAt: at },
    ] });
  };
  const usageReceipt = (attemptId: string, overrides: Partial<WorkerUsageReceipt> = {}): WorkerUsageReceipt => ({ attemptId,
    provider: 'openai-compatible', model: 'operations-usage-fixture', attemptedCalls: 1, successfulCalls: 1, unpricedCalls: 0,
    inputTokens: 100, outputTokens: 20, estimatedCostMicroUsd: 100, reservedCostMicroUsd: 1000, costBasis: 'WORKER_CONFIGURED_RATES', ...overrides });
  const costFixture = async () => {
    const ownerId = randomUUID(), token = randomUUID(), capabilityId = randomUUID(), capabilityVersionId = randomUUID(), workerId = randomUUID();
    users.push(ownerId); capabilityIds.push(capabilityId); workerIds.push(workerId);
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@operations.kivro.local`, name: 'Synthetic usage fixture',
      passwordHash: 'disabled-test-user', emailVerifiedAt: now, sessions: { create: { tokenHash: hashSecret(token), expiresAt: future(3600) } } } });
    await db.capability.create({ data: { id: capabilityId, sellerId: ownerId, slug: `operations-${capabilityId}`, schedule: DEFAULT_SCHEDULE } });
    await db.capabilityVersion.create({ data: { id: capabilityVersionId, capabilityId, version: 1, title: 'Synthetic usage fixture', summary: 'Not execution proof',
      description: '', category: 'operations-test', tags: [], priceTierId: 'USD_99', ioContract: {}, permissions: {}, dependencies: [], internalInstructions: secrets,
      manifestHash: 'a'.repeat(64), estimatedDurationSeconds: 60 } });
    await db.workerDevice.create({ data: { id: workerId, sellerId: ownerId, publicKey: `synthetic-operations-${workerId}`,
      name: 'Synthetic usage fixture', version: '0.1.0', runningJobIds: [], sandboxReady: false } });
    return { ownerId, token,
      job: (data: Record<string, unknown> = {}) => job(`usage-${randomUUID()}`, 'FAILED', { sellerId: ownerId, capabilityId, capabilityVersionId,
        completedAt: ago(10), ...data }),
      attempt: async (jobId: string, data: Partial<Prisma.JobAttemptUncheckedCreateInput> = {}) => {
        const id = randomUUID();
        return db.jobAttempt.create({ data: { id, jobId, workerId, state: 'FAILED', nonce: randomUUID(), expiresAt: future(3600),
          acceptedAt: ago(20), finishedAt: ago(10), createdAt: ago(30), usageReportedAt: ago(5), usageReceipt: usageReceipt(id), ...data } });
      },
      snapshot: async () => {
        const value = await operationsSnapshot(app.kivro, ownerId, 30, now);
        expect(sellerOperationsResponseSchema.parse(value)).toEqual(value);
        return value;
      },
    };
  };
  beforeAll(async () => {
    process.loadEnvFile('.env');
    if (process.env.KIVRO_ENV !== 'development' || !process.env.DATABASE_URL?.includes(':55432/kivro')) throw new Error('Requires isolated local development services');
    db = new PrismaClient();
    for (const [id, token] of [[sellerId, sellerToken], [buyerId, randomUUID()], [otherSellerId, otherToken], [adminId, adminToken]]) {
      await db.user.create({ data: { id, email: `${id}@operations.kivro.local`, name: 'Synthetic operations fixture', passwordHash: 'disabled-test-user',
        emailVerifiedAt: now, isAdmin: id === adminId, createdAt: periodDate, sessions: { create: { tokenHash: hashSecret(token!), expiresAt: future(3600) } } } });
    }
    await db.apiKey.create({ data: { userId: adminId, name: 'Operations denied key', prefix: 'ops-test', secretHash: hashSecret(apiKey), scopes: ['jobs:read', 'capabilities:read'] } });
    for (const [id, owner] of [[capId, sellerId], [foreignCapId, otherSellerId]]) {
      await db.capability.create({ data: { id, sellerId: owner!, slug: `operations-${id}`, schedule: DEFAULT_SCHEDULE } });
    }
    for (const [id, capabilityId, duration] of [[versionId, capId, 60], [versionTwoId, capId, 120], [foreignVersionId, foreignCapId, 60]] as const) {
      await db.capabilityVersion.create({ data: { id, capabilityId, version: id === versionTwoId ? 2 : 1, title: 'Synthetic operations fixture', summary: 'Not execution proof', description: '',
        category: 'operations-test', tags: [], priceTierId: 'USD_99', ioContract: {}, permissions: {}, dependencies: [], internalInstructions: secrets,
        manifestHash: 'a'.repeat(64), estimatedDurationSeconds: duration } });
    }
    await job('success', 'SUCCEEDED', { startedAt: ago(4320), completedAt: ago(4200), pausedDurationMs: 30000 });
    await job('refunded', 'SUCCEEDED', { paymentState: 'REFUNDED', startedAt: ago(3660), completedAt: ago(3600) });
    await job('failed', 'FAILED', { startedAt: ago(2730), completedAt: ago(2700) });
    await job('timeout', 'TIMED_OUT', { startedAt: ago(1900), completedAt: ago(1800) });
    await job('cancelled', 'CANCELLED', { completedAt: ago(1200) });
    await job('old', 'FAILED', { createdAt: oldDate, startedAt: oldDate, completedAt: oldDate });
    await job('scheduled1', 'SCHEDULED', { scheduledAt: future(3600) });
    await job('scheduled2', 'SCHEDULED', { scheduledAt: future(3600), waitDeadline: ago(10), capabilityVersionId: versionTwoId,
      buyerPriceMinor: 299, sellerNetMinor: 240, platformFeeMinor: 59 });
    await job('queued', 'QUEUED');
    await job('foreign', 'SUCCEEDED', { sellerId: otherSellerId, capabilityId: foreignCapId, capabilityVersionId: foreignVersionId, completedAt: ago(5) });
    await entries(jobs.success!, periodDate); await entries(jobs.refunded!, periodDate); await entries(jobs.refunded!, periodDate, true);
    await entries(jobs.old!, oldDate); await entries(jobs.foreign!, periodDate, false, otherSellerId);
    for (const asset of [
      { ownerId: sellerId, sizeBytes: 100, expiresAt: future(3600), deletedAt: null },
      { ownerId: buyerId, jobId: jobs.success!, kind: 'OUTPUT', sizeBytes: 500, expiresAt: ago(10), deletedAt: null },
      { ownerId: sellerId, sizeBytes: 200, expiresAt: ago(10), deletedAt: ago(5) },
      { ownerId: buyerId, sizeBytes: 9999, expiresAt: future(3600), deletedAt: null },
    ]) {
      const id = randomUUID(); assetIds.push(id);
      await db.asset.create({ data: { id, filename: secrets, mimeType: 'text/plain', sha256: 'b'.repeat(64), objectKey: `operations-fixture/${id}`,
        scanStatus: 'CLEAN', createdAt: periodDate, ...asset } });
    }
    for (const fields of [
      { sellerId, lastSeenAt: ago(1), sandboxReady: true },
      { sellerId, lastSeenAt: oldDate, sandboxReady: true, localPaused: true },
      { sellerId, lastSeenAt: ago(1), sandboxReady: true, revokedAt: ago(1) },
      { sellerId: otherSellerId, lastSeenAt: ago(1), sandboxReady: true },
    ]) {
      const id = randomUUID(); workerIds.push(id);
      await db.workerDevice.create({ data: { id, publicKey: `synthetic-operations-${id}`, name: secrets, version: '0.1.0', createdAt: periodDate, health: { private: secrets }, runningJobIds: [], ...fields } });
    }
    for (const event of [
      { actorId: buyerId, jobId: jobs.success, bytesGranted: 500 }, { actorId: sellerId, bytesGranted: 100 },
      { actorId: sellerId, bytesGranted: 'invalid' }, { actorId: buyerId, jobId: jobs.foreign, bytesGranted: 9999 },
    ]) {
      await db.auditEvent.create({ data: { actorId: event.actorId, jobId: event.jobId, type: 'ASSET_DOWNLOAD_GRANTED', createdAt: periodDate,
        metadata: { bytesGranted: event.bytesGranted, delivery: 'PRESIGNED_OBJECT_STORE', confirmedBytesTransferred: null, private: secrets } } });
    }
    for (const record of [
      { state: 'FINISHED', outcome: 'SUCCEEDED', costMicroUsd: 30, updatedAt: periodDate },
      { state: 'FINISHED', outcome: 'FAILED', costMicroUsd: 70, updatedAt: periodDate },
      { state: 'RESERVED', maxCostMicroUsd: 50, updatedAt: oldDate },
      { state: 'FINISHED', outcome: 'SUCCEEDED', costMicroUsd: 99999, updatedAt: oldDate },
    ]) {
      const key = `inference-request:${randomUUID()}`; settingKeys.push(key);
      const { updatedAt, ...value } = record;
      await db.platformSetting.create({ data: { key, updatedAt, value: { ...value, provider, model: 'operations-fixture', metadata: { userId: buyerId, private: secrets } } } });
    }
    const key = `platform-inference:${now.toISOString().slice(0, 10)}:operations-fixture-${randomUUID()}`; settingKeys.push(key);
    await db.platformSetting.create({ data: { key, value: 99999999 } });
    app = await createApp({ db, env: { ...process.env, PAYMENT_MODE: 'fake' }, logger: false });
    if (!app.hasRoute({ method: 'GET', url: '/api/seller/operations' })) registerOperations(app, app.kivro);
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.job.updateMany({ where: { id: { in: Object.values(jobs) }, paymentState: 'RESERVED' }, data: { paymentState: 'RELEASED', state: 'CANCELLED', completedAt: new Date() } });
      await db.platformSetting.deleteMany({ where: { key: { in: settingKeys } } });
      await db.session.deleteMany({ where: { userId: { in: users } } });
      await db.apiKey.updateMany({ where: { userId: { in: users } }, data: { revokedAt: new Date() } });
      await db.workerDevice.updateMany({ where: { id: { in: workerIds } }, data: { revokedAt: new Date(), paused: true, sandboxReady: false } });
      await db.asset.updateMany({ where: { id: { in: assetIds } }, data: { deletedAt: new Date() } });
      await db.user.updateMany({ where: { id: { in: users } }, data: { suspendedAt: new Date() } });
      await db.capability.updateMany({ where: { id: { in: capabilityIds } }, data: { paused: true, visibility: 'PRIVATE' } });
      await db.$disconnect();
    }
  });
  it('enforces session ownership, admin role and a strict bounded query', async () => {
    expect((await app.inject('/api/seller/operations')).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/admin/operations', headers: headers() })).statusCode).toBe(403);
    for (const path of ['/api/seller/operations', '/api/admin/operations']) {
      expect((await app.inject({ url: path, headers: { authorization: `Bearer ${apiKey}` } })).statusCode).toBe(403);
    }
    for (const query of ['days=0', 'days=91', 'days=bad', `sellerId=${otherSellerId}`]) {
      expect((await app.inject({ url: `/api/seller/operations?${query}`, headers: headers() })).statusCode).toBe(400);
    }
    const other = await read('/api/seller/operations', otherToken);
    expect(other.jobs.succeededCount).toBe(1); expect(other.scheduled.jobCount).toBe(0);
    expect(other.jobs.lastSuccess?.id).toBe(jobs.foreign);
  });
  it('uses completed outcomes, excludes cancellations from rates and subtracts persisted pauses', async () => {
    const result = await read();
    expect(result.jobs).toMatchObject({ createdCount: 8, terminalCount: 5, succeededCount: 2, failedCount: 2, timedOutCount: 1, cancelledCount: 1,
      failureRate: 0.5, successRate: 0.5, runtime: { sampleCount: 4, totalSeconds: 280, averageSeconds: 70 } });
    expect(result.jobs.lastSuccess?.id).toBe(jobs.refunded); expect(result.jobs.lastFailure?.id).toBe(jobs.timeout);
    expect(result.sellerCosts).toMatchObject({ providerCostMicroUsd: null, infrastructureCostMicroUsd: null, marginMicroUsd: null,
      estimatedContributionMarginMicroUsd: null, reason: 'INCOMPLETE_USAGE_COVERAGE', coverage: { acceptedAttempts: 0, earningsJobsOutsideCohort: 2, complete: false } });
    expect(result.platformInference).toBeNull(); expect(JSON.stringify(result)).not.toContain(secrets);
  });
  it('validates complete wire DTOs strictly without disguising unknown costs or exposing admin-only data', async () => {
    const value = await read(), admin = await read('/api/admin/operations', adminToken);
    expect(operationsResponseRoutes.map(({ method, path }) => [method, path])).toEqual([
      ['GET', '/api/seller/operations'], ['GET', '/api/admin/operations'],
    ]);
    expect(sellerOperationsResponseSchema.safeParse(admin).success).toBe(false);
    expect(adminOperationsResponseSchema.safeParse(value).success).toBe(false);
    for (const patch of [
      { unexpected: 'private payload' },
      { finance: { ...value.finance, rawLedger: [] } },
      { assets: { ...value.assets, egressBytes: 0 } },
      { sellerCosts: { ...value.sellerCosts, providerBilledCostMicroUsd: 0 } },
      { sellerCosts: { ...value.sellerCosts, coverage: { ...value.sellerCosts.coverage, guessedCost: 0 } } },
      { jobs: { ...value.jobs, failureRate: 2 } },
      { workers: { ...value.workers, registeredCount: Number.MAX_SAFE_INTEGER + 1 } },
      { scheduled: { ...value.scheduled, groups: [{ ...value.scheduled.groups[0], rawInput: 'private' }] } },
      { capabilityAnalytics: { ...value.capabilityAnalytics, items: [{ ...value.capabilityAnalytics!.items[0], uptime: 'precise' }] } },
    ]) expect(sellerOperationsResponseSchema.safeParse({ ...value, ...patch }).success).toBe(false);
    expect(adminOperationsResponseSchema.safeParse({ ...admin,
      platformInference: { ...admin.platformInference, byProvider: [{ ...admin.platformInference!.byProvider[0], apiKey: 'private' }] },
    }).success).toBe(false);
    expect(adminOperationsResponseSchema.safeParse({ ...admin,
      manualRecoveryRequired: { count: 1, truncated: false, items: [{ jobId: null, code: 'INVALID_RECOVERY_RECORD', payload: 'private' }] },
    }).success).toBe(false);
  });
  it('counts UTC calendar-day and lifetime jobs independently of the selected period and seller', async () => {
    const owner = await costFixture(), foreign = await costFixture();
    const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
    for (const createdAt of [oldDate, new Date(start.getTime() - 1), start, now, future(1)]) await owner.job({ createdAt });
    await foreign.job({ createdAt: start });
    for (const days of [1, 30, 90]) {
      const result = await operationsSnapshot(app.kivro, owner.ownerId, days, now);
      expect(result.jobs).toMatchObject({ todayCount: 2, totalCount: 4, todayTimeZone: 'UTC' });
    }
    expect((await operationsSnapshot(app.kivro, foreign.ownerId, 30, now)).jobs).toMatchObject({ todayCount: 1, totalCount: 1 });
  });
  it('reports posted settlement/reversal values separately from reserved scheduled demand', async () => {
    const result = await read();
    expect(result.finance).toEqual({ currency: 'USD', buyerCapturedMinor: 198, buyerRefundedMinor: 99, sellerEarningsMinor: 160, sellerEarningsReversedMinor: 80,
      netSellerEarningsMinor: 80, platformFeesMinor: 38, platformFeeReversalsMinor: 19, netPlatformFeesMinor: 19 });
    expect(result.scheduled).toMatchObject({ jobCount: 2, estimatedWorkSeconds: 180, reservedBuyerValueMinor: 398, estimatedSellerEarningsMinor: 320,
      totalGroups: 1, truncated: false, expiredReservationCount: 1 });
    expect(result.scheduled.groups).toEqual([{ capabilityId: capId, capabilityTitle: 'Synthetic operations fixture', scheduledAt: future(3600).toISOString(),
      jobCount: 2, estimatedWorkSeconds: 180, reservedBuyerValueMinor: 398, estimatedSellerEarningsMinor: 320, expiredReservationCount: 1 }]);
  });
  it('derives stored asset bytes and access grants without fabricating egress or provider costs', async () => {
    const result = await read();
    expect(result.assets).toEqual({ retainedAssetCount: 2, retainedAssetBytes: 600, expiredUndeletedCount: 1, uploadedCount: 3, uploadedBytes: 800,
      downloadGrantCount: 3, downloadGrantedBytes: 600, downloadGrantUnknownSizeCount: 1, storageCostMicroUsd: null, egressBytes: null, egressCostMicroUsd: null });
    const snapshot = await operationsSnapshot(app.kivro, sellerId, 30, now);
    expect(snapshot.workers).toMatchObject({ registeredCount: 3, revokedCount: 1, freshHeartbeatCount: 1, staleHeartbeatCount: 1, pausedCount: 1, sandboxReadyFreshCount: 1 });
  });
  it('returns complete admin aggregates and keeps inference reservations distinct from finished costs', async () => {
    const result = await read('/api/admin/operations', adminToken);
    expect(result.jobs.succeededCount).toBeGreaterThanOrEqual(3);
    expect(result.platformInference?.costBasis).toBe('CONFIGURED_RATES_AND_FAILURE_BUDGETS');
    expect(result.platformInference?.providerBilledCostMicroUsd).toBeNull();
    const group = result.platformInference?.byProvider.find(item => item.provider === provider);
    expect(group).toEqual({ provider, model: 'operations-fixture', finishedCalls: 2, succeededCalls: 1, failedCalls: 1, unsettledCalls: 1, invalidRecordCount: 0,
      recordedCostMicroUsd: 100, successfulUsageCostMicroUsd: 30, failedCallBudgetChargeMicroUsd: 70, reservedBudgetMicroUsd: 50 });
    expect(JSON.stringify(result)).not.toContain(secrets);
  });
  it('represents no samples with null rates and zero observed counts, not unknown-cost zeroes', async () => {
    const result = await operationsSnapshot(app.kivro, adminId, 30, now);
    expect(result.jobs.failureRate).toBeNull(); expect(result.jobs.successRate).toBeNull(); expect(result.jobs.runtime.averageSeconds).toBeNull();
    expect(result.jobs.runtime.sampleCount).toBe(0); expect(result.jobs.lastSuccess).toBeNull(); expect(result.jobs.lastFailure).toBeNull();
    expect(result.finance.netSellerEarningsMinor).toBe(0); expect(result.sellerCosts.providerCostMicroUsd).toBeNull();
  });
  it('keeps complete totals across inference pages and explicitly truncates scheduled groups', async () => {
    const jobRows = Array.from({ length: 201 }, (_, index) => {
      const id = randomUUID(); jobs[`bulk-${index}`] = id;
      return { id, sellerId: otherSellerId, buyerId, capabilityId: foreignCapId, capabilityVersionId: foreignVersionId,
        state: 'SCHEDULED' as const, paymentState: 'RESERVED' as const, input: {}, priceSnapshot: { fixture: true },
        buyerPriceMinor: 99, sellerNetMinor: 80, platformFeeMinor: 19, executionMode: 'SCHEDULED', scheduledAt: future(3600 + index), waitDeadline: future(86400) };
    });
    await db.job.createMany({ data: jobRows });
    const rows = Array.from({ length: 201 }, () => {
      const key = `inference-request:${randomUUID()}`; settingKeys.push(key);
      return { key, value: { state: 'FINISHED', provider, model: 'pagination-fixture', outcome: 'SUCCEEDED', costMicroUsd: 1 } };
    });
    await db.platformSetting.createMany({ data: rows });
    const result = await read('/api/seller/operations', otherToken);
    expect(result.scheduled).toMatchObject({ jobCount: 201, totalGroups: 201, truncated: true, reservedBuyerValueMinor: 201 * 99,
      estimatedSellerEarningsMinor: 201 * 80, estimatedWorkSeconds: 201 * 60 });
    expect(result.scheduled.groups).toHaveLength(200);
    const admin = await read('/api/admin/operations', adminToken);
    expect(admin.platformInference?.byProvider.find(item => item.provider === provider && item.model === 'pagination-fixture'))
      .toMatchObject({ finishedCalls: 201, succeededCalls: 201, recordedCostMicroUsd: 201, successfulUsageCostMicroUsd: 201, reservedBudgetMicroUsd: 0 });
  });
  it('exposes bounded current financial-recovery and maintenance holds to administrators only', async () => {
    const recoveryId = randomUUID(), task = `operations-test-${randomUUID()}`;
    for (const [key, value] of [
      [`job-recovery-error:${recoveryId}`, { code: 'LEDGER_INVARIANT', firstSeenAt: periodDate.toISOString(), lastSeenAt: now.toISOString(), attempts: 3, nextRetryAt: future(60).toISOString(), private: secrets }],
      [`maintenance-error:${task}`, { code: 'STORAGE_UNAVAILABLE', lastSeenAt: now.toISOString(), private: secrets }],
      [`maintenance-error:${task}-sql`, { code: '40001', lastSeenAt: now.toISOString(), private: secrets }],
    ] as const) {
      settingKeys.push(key); await db.platformSetting.create({ data: { key, value } });
    }
    const seller = await read(); expect(seller.manualRecoveryRequired).toBeNull(); expect(seller.maintenanceErrors).toBeNull();
    const admin = await read('/api/admin/operations', adminToken);
    expect(admin.manualRecoveryRequired?.count).toBeGreaterThanOrEqual(1);
    expect(admin.manualRecoveryRequired?.items).toContainEqual({ jobId: recoveryId, code: 'LEDGER_INVARIANT' });
    expect(admin.maintenanceErrors?.items).toContainEqual({ task, code: 'STORAGE_UNAVAILABLE', lastSeenAt: now.toISOString() });
    expect(admin.maintenanceErrors?.items).toContainEqual({ task: `${task}-sql`, code: '40001', lastSeenAt: now.toISOString() });
    expect(admin.manualRecoveryRequired!.items.length).toBeLessThanOrEqual(200);
    expect(admin.maintenanceErrors!.items.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(admin)).not.toContain(secrets);
    const recoveryKey = `job-recovery-error:${recoveryId}`;
    await db.platformSetting.delete({ where: { key: recoveryKey } });
    expect((await read('/api/admin/operations', adminToken)).manualRecoveryRequired?.items.some(item => item.jobId === recoveryId)).toBe(false);
  });
  it('aggregates seller-owned receipts across retries and both acceptance/completion period boundaries', async () => {
    const fixture = await costFixture(), foreign = await costFixture(), paid = await fixture.job({ state: 'SUCCEEDED', paymentState: 'SETTLED' });
    await entries(paid, ago(5), false, fixture.ownerId);
    await fixture.attempt(paid);
    const retryId = randomUUID();
    await fixture.attempt(paid, { id: retryId, acceptedAt: oldDate, usageReceipt: usageReceipt(retryId, { estimatedCostMicroUsd: 200 }) });
    const failed = await fixture.job(), failedId = randomUUID();
    await fixture.attempt(failed, { id: failedId, usageReceipt: usageReceipt(failedId, { provider: 'anthropic', attemptedCalls: 2, successfulCalls: 2, estimatedCostMicroUsd: 300 }) });
    await fixture.attempt(failed, { acceptedAt: null, finishedAt: null, usageReceipt: Prisma.DbNull, usageReportedAt: null });
    await fixture.attempt(failed, { acceptedAt: oldDate, finishedAt: oldDate, usageReportedAt: oldDate });
    await fixture.attempt(failed, { acceptedAt: future(10), finishedAt: future(20), usageReportedAt: future(30) });
    await foreign.attempt(await foreign.job());
    const result = await read('/api/seller/operations', fixture.token);
    expect(result.finance.netSellerEarningsMinor).toBe(80);
    expect(result.sellerCosts).toMatchObject({ costBasis: 'WORKER_CONFIGURED_RATES', reportedAttempts: 3, attemptedCalls: 4, successfulCalls: 4,
      unpricedCalls: 0, inputTokens: 300, outputTokens: 60, estimatedProviderCostMicroUsd: 600, reservedCostMicroUsd: 3000,
      estimatedContributionMarginMicroUsd: 799400, providerCostMicroUsd: null, providerBilledCostMicroUsd: null, infrastructureCostMicroUsd: null, marginMicroUsd: null,
      reason: 'WORKER_RATE_ESTIMATE_ONLY', totalGroups: 2, truncated: false,
      coverage: { acceptedAttempts: 3, finishedAttempts: 3, unfinishedAttempts: 0, missingReceiptAttempts: 0, invalidReceiptAttempts: 0,
        unpricedAttempts: 0, earningsJobsOutsideCohort: 0, receiptRate: 1, complete: true } });
    expect(result.sellerCosts.byProvider.find(group => group.provider === 'openai-compatible')).toMatchObject({ reportedAttempts: 2, estimatedProviderCostMicroUsd: 300 });
    expect(JSON.stringify(result.sellerCosts)).not.toMatch(new RegExp(`${fixture.ownerId}|${foreign.ownerId}|${paid}|${secrets}`));
  });
  it('exposes missing, invalid, unfinished and unpriced attempts without fabricating failed-call cost or a margin', async () => {
    const fixture = await costFixture(), jobId = await fixture.job();
    await fixture.attempt(jobId, { usageReceipt: Prisma.DbNull, usageReportedAt: null });
    await fixture.attempt(jobId, { usageReceipt: usageReceipt(randomUUID(), { estimatedCostMicroUsd: 999, reservedCostMicroUsd: 999 }) });
    await fixture.attempt(jobId, { finishedAt: null, usageReceipt: Prisma.DbNull, usageReportedAt: null });
    const partialId = randomUUID(), unknownId = randomUUID(), zeroId = randomUUID();
    await fixture.attempt(jobId, { id: partialId, usageReceipt: usageReceipt(partialId, { attemptedCalls: 2, unpricedCalls: 1, estimatedCostMicroUsd: 30 }) });
    await fixture.attempt(jobId, { id: unknownId, usageReceipt: usageReceipt(unknownId, { successfulCalls: 0, unpricedCalls: 1,
      inputTokens: 0, outputTokens: 0, estimatedCostMicroUsd: 0 }) });
    await fixture.attempt(jobId, { id: zeroId, usageReceipt: usageReceipt(zeroId, { attemptedCalls: 0, successfulCalls: 0,
      inputTokens: 0, outputTokens: 0, estimatedCostMicroUsd: 0, reservedCostMicroUsd: 0 }) });
    expect((await fixture.snapshot()).sellerCosts).toMatchObject({ reportedAttempts: 3, attemptedCalls: 3, successfulCalls: 1, unpricedCalls: 2,
      inputTokens: 100, outputTokens: 20, estimatedProviderCostMicroUsd: 30, reservedCostMicroUsd: 2000, estimatedContributionMarginMicroUsd: null,
      reason: 'INCOMPLETE_USAGE_COVERAGE', coverage: { acceptedAttempts: 6, finishedAttempts: 5, unfinishedAttempts: 1,
        missingReceiptAttempts: 2, invalidReceiptAttempts: 1, unpricedAttempts: 2, receiptRate: 0.5, complete: false } });
  });
  it('does not equate a received receipt with priced-call coverage', async () => {
    const fixture = await costFixture(), jobId = await fixture.job(), id = randomUUID();
    await fixture.attempt(jobId, { id, usageReceipt: usageReceipt(id, { successfulCalls: 0, unpricedCalls: 1,
      inputTokens: 0, outputTokens: 0, estimatedCostMicroUsd: 0 }) });
    expect((await fixture.snapshot()).sellerCosts).toMatchObject({ estimatedProviderCostMicroUsd: 0, unpricedCalls: 1, estimatedContributionMarginMicroUsd: null,
      coverage: { receiptRate: 1, unpricedAttempts: 1, complete: false } });
  });
  it('permits negative estimated contribution after reversal but never calls it final margin', async () => {
    const fixture = await costFixture(), jobId = await fixture.job({ state: 'SUCCEEDED', paymentState: 'REFUNDED' }), id = randomUUID();
    await fixture.attempt(jobId, { id, usageReceipt: usageReceipt(id, { estimatedCostMicroUsd: 1_000_000, reservedCostMicroUsd: 1_000_000 }) });
    await entries(jobId, ago(8), false, fixture.ownerId); await entries(jobId, ago(7), true, fixture.ownerId);
    const result = await fixture.snapshot();
    expect(result.finance.netSellerEarningsMinor).toBe(0);
    expect(result.sellerCosts).toMatchObject({ estimatedContributionMarginMicroUsd: -1_000_000, marginMicroUsd: null, providerBilledCostMicroUsd: null,
      infrastructureCostMicroUsd: null, coverage: { complete: true } });
  });
  it('withholds contribution for legacy or prior-period earnings outside the attempt cost cohort', async () => {
    const fixture = await costFixture(), current = await fixture.job(), legacy = await fixture.job(), prior = await fixture.job();
    await fixture.attempt(current);
    await fixture.attempt(prior, { acceptedAt: oldDate, finishedAt: oldDate, usageReportedAt: oldDate });
    await entries(prior, ago(7), true, fixture.ownerId); await entries(legacy, ago(7), false, fixture.ownerId);
    const result = await fixture.snapshot();
    expect(result.finance.netSellerEarningsMinor).toBe(0);
    expect(result.sellerCosts).toMatchObject({ estimatedProviderCostMicroUsd: 100, estimatedContributionMarginMicroUsd: null,
      coverage: { acceptedAttempts: 1, receiptRate: 1, earningsJobsOutsideCohort: 2, complete: false } });
  });
  it('treats late receipts as unknown until their server report time and keeps no-sample estimates null', async () => {
    const fixture = await costFixture();
    expect((await fixture.snapshot()).sellerCosts).toMatchObject({ reason: 'NO_ACCEPTED_ATTEMPTS', estimatedProviderCostMicroUsd: 0,
      estimatedContributionMarginMicroUsd: null, coverage: { acceptedAttempts: 0, receiptRate: null, complete: false } });
    await fixture.attempt(await fixture.job(), { usageReportedAt: future(10) });
    expect((await fixture.snapshot()).sellerCosts).toMatchObject({ reportedAttempts: 0, estimatedProviderCostMicroUsd: 0,
      estimatedContributionMarginMicroUsd: null, coverage: { acceptedAttempts: 1, missingReceiptAttempts: 1, complete: false } });
    expect((await operationsSnapshot(app.kivro, fixture.ownerId, 30, future(20))).sellerCosts).toMatchObject({ reportedAttempts: 1,
      estimatedProviderCostMicroUsd: 100, estimatedContributionMarginMicroUsd: -100, coverage: { complete: true } });
  });
  it('includes exact reporting boundaries once and excludes attempts entirely before or after them', async () => {
    const fixture = await costFixture(), jobId = await fixture.job(), from = ago(30 * 86400), before = new Date(from.getTime() - 1);
    await fixture.attempt(jobId, { acceptedAt: from });
    await fixture.attempt(jobId, { acceptedAt: before, finishedAt: from });
    await fixture.attempt(jobId, { acceptedAt: now, finishedAt: now, usageReportedAt: now });
    await fixture.attempt(jobId, { acceptedAt: before, finishedAt: before, usageReportedAt: before });
    await fixture.attempt(jobId, { acceptedAt: future(1), finishedAt: future(1), usageReportedAt: future(1) });
    expect((await fixture.snapshot()).sellerCosts).toMatchObject({ reportedAttempts: 3, estimatedProviderCostMicroUsd: 300, coverage: { acceptedAttempts: 3, complete: true } });
  });
  it('keeps full usage totals across receipt pages with explicitly bounded provider/model groups', async () => {
    const fixture = await costFixture(), jobId = await fixture.job();
    const first = await fixture.attempt(jobId), prefix = `ops-${randomUUID()}`;
    const rows = Array.from({ length: 200 }, (_, index) => {
      const id = randomUUID();
      return { id, workerId: first.workerId, jobId, state: 'FAILED', nonce: randomUUID(), expiresAt: future(3600),
        acceptedAt: ago(20), finishedAt: ago(10), usageReportedAt: ago(5), usageReceipt: usageReceipt(id, { model: `${prefix}-${index}` }) };
    });
    await db.jobAttempt.createMany({ data: rows });
    const costs = (await fixture.snapshot()).sellerCosts;
    expect(costs).toMatchObject({ reportedAttempts: 201, attemptedCalls: 201, estimatedProviderCostMicroUsd: 20100, inputTokens: 20100,
      outputTokens: 4020, totalGroups: 201, truncated: true, estimatedContributionMarginMicroUsd: -20100,
      coverage: { acceptedAttempts: 201, receiptRate: 1, complete: true } });
    expect(costs.byProvider).toHaveLength(200);
    const admin = await read('/api/admin/operations', adminToken);
    expect(admin.sellerCosts.reportedAttempts).toBeGreaterThanOrEqual(201);
    expect(admin.sellerCosts.estimatedProviderCostMicroUsd).toBeGreaterThanOrEqual(20100);
  });
});
