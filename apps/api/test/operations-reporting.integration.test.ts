import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient, type Prisma } from '@kivro/database';
import { DEFAULT_SCHEDULE } from '@kivro/contracts';
import { adminOperationsResponseSchema, sellerOperationsResponseSchema } from '@kivro/contracts/responses';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';
import { operationsSnapshot } from '../src/operations.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('operations reporting cohorts (isolated PostgreSQL)', () => {
  let db: PrismaClient, app: FastifyInstance;
  const schema = `operations_reporting_${randomBytes(8).toString('hex')}`;
  const now = new Date(), at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  const from = at(-30 * 86400), old = at(-40 * 86400), privateText = 'private buyer input and credential must not escape';
  beforeAll(async () => {
    process.loadEnvFile('.env'); const url = new URL(process.env.DATABASE_URL!);
    if (process.env.KIVRO_ENV !== 'development' || url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/kivro') throw new Error('Requires local development DB');
    url.searchParams.set('schema', schema);
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url.toString() } });
    db = new PrismaClient({ datasourceUrl: url.toString() });
    app = await createApp({ db, logger: false, env: { ...process.env, NODE_ENV: 'test', PAYMENT_MODE: 'fake',
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', PLATFORM_OPENAI_API_KEY: '', PLATFORM_ANTHROPIC_API_KEY: '', PLATFORM_INFERENCE_PROVIDER: '' } });
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      if (!/^operations_reporting_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe test schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await db.$disconnect();
    }
  });
  async function owner(isAdmin = false) {
    const id = randomUUID(), token = randomUUID();
    await db.user.create({ data: { id, email: `${id}@reporting.kivro.local`, name: 'Synthetic reporting fixture', passwordHash: 'disabled',
      emailVerifiedAt: old, isAdmin, createdAt: old, sessions: { create: { tokenHash: hashSecret(token), expiresAt: at(3600) } } } });
    const capability = await db.capability.create({ data: { sellerId: id, slug: randomUUID(), schedule: DEFAULT_SCHEDULE, createdAt: old } });
    const version = await db.capabilityVersion.create({ data: { capabilityId: capability.id, version: 1, title: 'Reporting fixture', summary: '', description: '', category: 'Writing',
      tags: [], priceTierId: 'USD_99', ioContract: {}, permissions: {}, dependencies: [], internalInstructions: privateText, manifestHash: 'a'.repeat(64) } });
    await db.capability.update({ where: { id: capability.id }, data: { currentVersionId: version.id } });
    const worker = await db.workerDevice.create({ data: { sellerId: id, publicKey: `synthetic-${id}`, name: 'Reporting fixture', version: '0.1.0', createdAt: old } });
    return { id, headers: { cookie: `kivro_session=${token}` },
      job: (data: Partial<Prisma.JobUncheckedCreateInput> = {}) => db.job.create({ data: { buyerId: id, sellerId: id, capabilityId: capability.id, capabilityVersionId: version.id,
        state: 'FAILED', paymentState: 'RELEASED', input: {}, priceSnapshot: {}, buyerPriceMinor: 99, sellerNetMinor: 80, platformFeeMinor: 19,
        executionMode: 'NOW', waitDeadline: at(3600), createdAt: at(-300), completedAt: at(-10), error: privateText, ...data } }),
      attempt: (jobId: string, data: Partial<Prisma.JobAttemptUncheckedCreateInput> = {}) => db.jobAttempt.create({ data: { jobId, workerId: worker.id,
        nonce: randomUUID(), createdAt: at(-200), expiresAt: at(60), ...data } }),
      read: async () => {
        const result = await operationsSnapshot(app.kivro, id, 30, now);
        expect(sellerOperationsResponseSchema.parse(result)).toEqual(result);
        return result;
      },
    };
  }
  async function entry(jobId: string, userId: string, type: string, createdAt: Date, amountMinor = type === 'JOB_CAPTURE' ? -99 : 99) {
    return db.ledgerEntry.create({ data: { transactionId: randomUUID(), operationKey: `reporting:${randomUUID()}`, jobId, userId, type, amountMinor, createdAt } });
  }
  async function event(jobId: string, type: string, message: string, source: string, createdAt = at(-10)) {
    return db.jobEvent.create({ data: { jobId, type, message, metadata: { source, privateText }, createdAt } });
  }

  it('excludes never-started and contradictory jobs from execution rates while keeping terminal totals', async () => {
    const f = await owner();
    await f.job({ state: 'SUCCEEDED', startedAt: at(-100) });
    await f.job({ state: 'FAILED', startedAt: at(-100) });
    await f.job({ state: 'TIMED_OUT', startedAt: at(-100) });
    for (const state of ['SUCCEEDED', 'FAILED', 'TIMED_OUT'] as const) await f.job({ state });
    await f.job({ startedAt: at(-5) }); await f.job({ startedAt: at(-400) });
    await f.job({ state: 'CANCELLED', startedAt: at(-100) });
    const result = await f.read();
    expect(result.jobs.executionOutcomes).toEqual({ basis: 'STARTED_TERMINAL_JOBS', decidedCount: 3, succeededCount: 1,
      failedCount: 2, timedOutCount: 1, excludedBeforeStartCount: 3, excludedInvalidTimingCount: 2, cancelledAfterStartCount: 1 });
    expect(result.jobs).toMatchObject({ terminalCount: 9, succeededCount: 2, failedCount: 6, cancelledCount: 1, failureRate: 2 / 3, successRate: 1 / 3 });
  });
  it('returns null execution rates for waiting-only failures, not a fabricated 100 percent failure rate', async () => {
    const f = await owner(); await f.job(); await f.job({ state: 'TIMED_OUT' });
    expect((await f.read()).jobs).toMatchObject({ failedCount: 2, failureRate: null, successRate: null,
      executionOutcomes: { decidedCount: 0, excludedBeforeStartCount: 2 } });
  });
  it('measures first-offer queue latency once, with missing and invalid queue timestamps explicit', async () => {
    const f = await owner(), foreign = await owner();
    const a = await f.job({ queuedAt: at(-200) }); await f.attempt(a.id, { createdAt: at(-190) }); await f.attempt(a.id, { createdAt: at(-100) });
    const b = await f.job({ queuedAt: at(-150) }); await f.attempt(b.id, { createdAt: at(-120) });
    await f.attempt((await f.job()).id, { createdAt: at(-100) });
    await f.attempt((await f.job({ queuedAt: at(-400) })).id, { createdAt: at(-100) });
    const oldJob = await f.job({ createdAt: old, queuedAt: old }); await f.attempt(oldJob.id, { createdAt: old }); await f.attempt(oldJob.id);
    await f.attempt((await f.job({ queuedAt: at(-100) })).id, { createdAt: at(1) });
    await foreign.attempt((await foreign.job({ queuedAt: at(-200) })).id, { createdAt: at(-100) });
    expect((await f.read()).reporting?.dispatchLatency).toEqual({ basis: 'FIRST_OFFER_MINUS_INITIAL_QUEUE_WALL_TIME', cohortJobs: 4,
      sampleCount: 2, missingQueueTimestampCount: 1, invalidTimelineCount: 1, averageSeconds: 20, medianSeconds: 20 });
  });
  it('keeps pending, withdrawn, ambiguous and expired offers distinct in the acceptance denominator', async () => {
    const f = await owner(), job = await f.job({ createdAt: old });
    await f.attempt(job.id, { acceptedAt: at(-190), state: 'RUNNING' });
    await f.attempt(job.id, { expiresAt: at(-100), state: 'EXPIRED', finishedAt: at(-90) });
    await f.attempt(job.id);
    await f.attempt(job.id, { state: 'CANCELLED', finishedAt: at(-100) });
    await f.attempt(job.id, { state: 'FAILED', finishedAt: at(-100) });
    await f.attempt(job.id, { state: 'RUNNING', acceptedAt: at(-300) });
    await f.attempt(job.id, { state: 'RUNNING' });
    await f.attempt(job.id, { state: 'SUCCEEDED', acceptedAt: at(10), finishedAt: at(20) });
    await f.attempt(job.id, { createdAt: old }); await f.attempt(job.id, { createdAt: at(1) });
    expect((await f.read()).reporting?.offerAcceptance).toEqual({ basis: 'ACCEPTED_OR_EXPIRED_OFFERS_CREATED_IN_PERIOD', offeredCount: 8,
      acceptedCount: 1, expiredUnacceptedCount: 1, withdrawnUnacceptedCount: 2, pendingCount: 2, unknownCount: 2, denominatorCount: 2, rate: 0.5 });
  });
  it('includes exact offer period boundaries and excludes later acceptances from the earlier snapshot', async () => {
    const f = await owner(), job = await f.job({ createdAt: old });
    await f.attempt(job.id, { createdAt: from, acceptedAt: new Date(from.getTime() + 1) });
    await f.attempt(job.id, { createdAt: now, acceptedAt: at(1) });
    await f.attempt(job.id, { createdAt: new Date(from.getTime() - 1), acceptedAt: at(-1) });
    await f.attempt(job.id, { createdAt: at(1) });
    expect((await f.read()).reporting?.offerAcceptance).toMatchObject({ offeredCount: 2, acceptedCount: 1, pendingCount: 1, denominatorCount: 1, rate: 1 });
  });
  it('groups only fixed failure categories, preserves missing reasons, and classifies cancellations separately', async () => {
    const f = await owner();
    await event((await f.job()).id, 'FAILED', 'Worker execution failed', 'WORKER');
    await event((await f.job({ state: 'TIMED_OUT' })).id, 'TIMED_OUT', 'Maximum waiting period exceeded', 'PLATFORM');
    await event((await f.job()).id, 'FAILED', privateText, 'WORKER');
    await event((await f.job()).id, 'FAILED', 'Worker execution failed', 'ACCOUNT_API');
    await f.job();
    for (const source of ['PLATFORM', 'ACCOUNT_API', 'WORKER']) await event((await f.job({ state: 'CANCELLED' })).id, 'CANCELLED', privateText, source);
    await f.job({ state: 'CANCELLED' });
    const result = (await f.read()).reporting!;
    expect(result.failures).toMatchObject({ totalJobs: 5, knownReasonJobs: 2, unknownReasonJobs: 3, missingEventJobs: 1 });
    expect(result.failures.groups).toContainEqual({ reason: 'WORKER_EXECUTION_FAILED', source: 'WORKER', count: 1 });
    expect(result.failures.groups).toContainEqual({ reason: 'WAIT_DEADLINE_EXCEEDED', source: 'PLATFORM', count: 1 });
    expect(result.cancellations).toEqual({ totalJobs: 4, platformJobs: 1, accountJobs: 1, workerJobs: 1, unknownSourceJobs: 1 });
    expect(JSON.stringify(result)).not.toContain(privateText);
  });
  it('recognizes each supported platform/Worker failure category without interpreting arbitrary errors', async () => {
    const f = await owner();
    const cases = [
      ['WORKER', 'FAILED', 'Worker execution failed', 'WORKER_EXECUTION_FAILED'],
      ['WORKER', 'TIMED_OUT', 'Worker execution timed out', 'WORKER_EXECUTION_TIMEOUT'],
      ['PLATFORM', 'FAILED', 'Worker did not reconnect within the recovery period', 'RECONNECT_EXPIRED'],
      ['PLATFORM', 'TIMED_OUT', 'Maximum waiting period exceeded', 'WAIT_DEADLINE_EXCEEDED'],
      ['PLATFORM', 'TIMED_OUT', 'Cumulative pause budget exceeded', 'PAUSE_BUDGET_EXCEEDED'],
      ['PLATFORM', 'TIMED_OUT', 'Worker did not acknowledge the pause request', 'PAUSE_ACK_TIMEOUT'],
      ['PLATFORM', 'TIMED_OUT', 'Execution deadline exceeded', 'EXECUTION_DEADLINE_EXCEEDED'],
      ['PLATFORM', 'FAILED', 'An input asset expired before execution', 'INPUT_ASSET_EXPIRED'],
    ] as const;
    for (const [source, state, message] of cases) await event((await f.job({ state })).id, state, message, source);
    const result = (await f.read()).reporting!.failures;
    expect(result).toMatchObject({ totalJobs: 8, knownReasonJobs: 8, unknownReasonJobs: 0, missingEventJobs: 0 });
    expect(result.groups.map(row => row.reason).sort()).toEqual(cases.map(row => row[3]).sort());
  });
  it('does not recover deleted failure events from potentially private raw job errors', async () => {
    const f = await owner(), job = await f.job(); const record = await event(job.id, 'FAILED', 'Worker execution failed', 'WORKER');
    expect((await f.read()).reporting!.failures.knownReasonJobs).toBe(1);
    await db.jobEvent.delete({ where: { id: record.id } });
    expect((await f.read()).reporting!.failures).toMatchObject({ totalJobs: 1, knownReasonJobs: 0, unknownReasonJobs: 1, missingEventJobs: 1 });
  });
  it('matches job refunds to their capture cohort, excluding old captures, releases and top-up refunds', async () => {
    const f = await owner(), foreign = await owner();
    const kept = await f.job(), refunded = await f.job(), prior = await f.job({ createdAt: old }), orphan = await f.job();
    await entry(kept.id, f.id, 'JOB_CAPTURE', at(-100));
    await entry(refunded.id, f.id, 'JOB_CAPTURE', at(-100)); await entry(refunded.id, f.id, 'REFUND', at(-50));
    await entry(prior.id, f.id, 'JOB_CAPTURE', old); await entry(prior.id, f.id, 'REFUND', at(-50));
    await entry(orphan.id, f.id, 'REFUND', at(-50));
    await entry((await f.job()).id, f.id, 'JOB_RELEASE', at(-50));
    await entry((await f.job()).id, f.id, 'TOPUP_REFUND', at(-50), -99);
    await f.job({ paymentState: 'REFUNDED' });
    const other = await foreign.job(); await entry(other.id, foreign.id, 'JOB_CAPTURE', at(-100)); await entry(other.id, foreign.id, 'REFUND', at(-50));
    expect((await f.read()).reporting!.refunds).toEqual({ basis: 'JOBS_WITH_FIRST_USD_CAPTURE_IN_PERIOD', capturedJobs: 2,
      refundedJobs: 1, notRefundedJobs: 1, unknownOutcomeJobs: 0, denominatorJobs: 2, rate: 0.5,
      periodRefundsOutsideCohortJobs: 1, periodRefundsWithoutCaptureJobs: 1, invalidLedgerRecordCount: 0 });
  });
  it('excludes contradictory refund chronology, duplicate capture and wrong-owner records from a known rate', async () => {
    const f = await owner(), other = await owner();
    const reversed = await f.job(); await entry(reversed.id, f.id, 'JOB_CAPTURE', at(-50)); await entry(reversed.id, f.id, 'REFUND', at(-100));
    const duplicate = await f.job(); await entry(duplicate.id, f.id, 'JOB_CAPTURE', at(-100)); await entry(duplicate.id, f.id, 'JOB_CAPTURE', at(-90));
    const wrong = await f.job(); await entry(wrong.id, other.id, 'JOB_CAPTURE', at(-100));
    expect((await f.read()).reporting!.refunds).toMatchObject({ capturedJobs: 3, refundedJobs: 0, unknownOutcomeJobs: 3,
      denominatorJobs: 0, rate: null, invalidLedgerRecordCount: 1 });
  });
  it('uses inclusive capture/refund boundaries without counting later refunds in an earlier snapshot', async () => {
    const f = await owner();
    const first = await f.job({ createdAt: old }); await entry(first.id, f.id, 'JOB_CAPTURE', from); await entry(first.id, f.id, 'REFUND', now);
    const second = await f.job(); await entry(second.id, f.id, 'JOB_CAPTURE', at(-100)); await entry(second.id, f.id, 'REFUND', at(1));
    const before = await f.job({ createdAt: old }); await entry(before.id, f.id, 'JOB_CAPTURE', new Date(from.getTime() - 1)); await entry(before.id, f.id, 'REFUND', now);
    await entry((await f.job()).id, f.id, 'JOB_CAPTURE', at(1));
    expect((await f.read()).reporting!.refunds).toMatchObject({ capturedJobs: 2, refundedJobs: 1, notRefundedJobs: 1,
      denominatorJobs: 2, rate: 0.5, periodRefundsOutsideCohortJobs: 1 });
  });
  it('serves scoped actual API metrics and validates every new reporting object strictly', async () => {
    const f = await owner(), foreign = await owner(), admin = await owner(true);
    const job = await f.job({ queuedAt: at(-250) }); await f.attempt(job.id, { acceptedAt: at(-190) });
    for (let n = 0; n < 3; n++) await foreign.attempt((await foreign.job()).id);
    const response = await app.inject({ url: '/api/seller/operations', headers: f.headers });
    expect(response.statusCode, response.body).toBe(200);
    const value = sellerOperationsResponseSchema.parse(response.json());
    expect(value.reporting?.offerAcceptance).toMatchObject({ offeredCount: 1, acceptedCount: 1, denominatorCount: 1, rate: 1 });
    const platform = await app.inject({ url: '/api/admin/operations', headers: admin.headers });
    expect(platform.statusCode, platform.body).toBe(200);
    expect(adminOperationsResponseSchema.parse(platform.json()).reporting!.offerAcceptance.offeredCount).toBeGreaterThanOrEqual(4);
    for (const section of ['dispatchLatency', 'offerAcceptance', 'failures', 'cancellations', 'refunds'] as const) {
      expect(sellerOperationsResponseSchema.safeParse({ ...value, reporting: { ...value.reporting,
        [section]: { ...value.reporting![section], raw: privateText } } }).success).toBe(false);
    }
    expect(sellerOperationsResponseSchema.safeParse({ ...value, jobs: { ...value.jobs,
      executionOutcomes: { ...value.jobs.executionOutcomes, raw: privateText } } }).success).toBe(false);
  });
});
