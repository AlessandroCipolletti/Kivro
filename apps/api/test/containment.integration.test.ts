import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient, serializable } from '@kivro/database';
import { DEFAULT_SCHEDULE, getPriceTier } from '@kivro/contracts';
import { creditWallet, reserveJob } from '@kivro/billing';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';
import { canonicalWorkerRequest } from '../src/worker.js';
import { reconcileJobs } from '../src/background.js';
import { containJobExecution, releaseContainedJobs } from '../src/job-containment.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('security containment survives damaged financial reservations', () => {
  let db: PrismaClient, app: FastifyInstance;
  const schema = `containment_test_${randomBytes(8).toString('hex')}`, origin = 'http://localhost:3000';
  const user = async (isAdmin = false) => {
    const id = randomUUID(), token = randomUUID(), key = randomUUID();
    await db.user.create({ data: { id, email: `${id}@containment.kivro.local`, name: 'Containment fixture', passwordHash: 'disabled', isAdmin, wallet: { create: {} },
      sessions: { create: { tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + 600_000) } },
      apiKeys: { create: { name: 'Fixture', prefix: key.slice(0, 12), secretHash: hashSecret(key), scopes: ['jobs:read'] } } } });
    return { id, headers: { origin, cookie: `kivro_session=${token}` } };
  };
  beforeAll(async () => {
    process.loadEnvFile('.env'); const url = new URL(process.env.DATABASE_URL!);
    if (process.env.KIVRO_ENV !== 'development' || url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/kivro') throw new Error('Requires local development DB');
    url.searchParams.set('schema', schema);
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url.toString() } });
    db = new PrismaClient({ datasourceUrl: url.toString() });
    app = await createApp({ db, logger: false, mailer: null, env: { ...process.env, NODE_ENV: 'test', PAYMENT_MODE: 'fake', WEB_ORIGIN: origin,
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', PLATFORM_OPENAI_API_KEY: '', PLATFORM_ANTHROPIC_API_KEY: '', PLATFORM_INFERENCE_PROVIDER: '' } });
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      if (!/^containment_test_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe test schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await db.$disconnect();
    }
  });
  it('retains a terminal reservation recovery marker across containment and background retries', async () => {
    const seller = await user(), buyer = await user(), price = getPriceTier('USD_99');
    const cap = await db.capability.create({ data: { sellerId: seller.id, slug: randomUUID(), schedule: DEFAULT_SCHEDULE,
      versions: { create: { version: 1, title: 'Terminal recovery fixture', summary: 'Synthetic damaged history', description: '', category: 'Writing', tags: [],
        priceTierId: price.id, ioContract: {}, permissions: {}, dependencies: [], internalInstructions: '', manifestHash: 'a'.repeat(64) } } }, include: { versions: true } });
    const job = await db.job.create({ data: { buyerId: buyer.id, sellerId: seller.id, capabilityId: cap.id, capabilityVersionId: cap.versions[0]!.id,
      state: 'CANCELLED', paymentState: 'RESERVED', completedAt: new Date(), input: {}, priceSnapshot: price,
      buyerPriceMinor: price.buyerPriceMinor, platformFeeMinor: price.platformFeeMinor, sellerNetMinor: price.sellerNetMinor,
      executionMode: 'NOW', waitDeadline: new Date(Date.now() + 600_000) } });
    const key = `job-recovery-error:${job.id}`;
    const ids = await serializable(db, tx => containJobExecution(tx, { id: job.id }, 'Synthetic terminal history containment'));
    await releaseContainedJobs(app.kivro, ids);
    const recovery = await db.platformSetting.findUniqueOrThrow({ where: { key } });
    expect(recovery.value).toMatchObject({ code: 'LEDGER_INVARIANT', attempts: 1 });
    await db.platformSetting.update({ where: { key }, data: { value: { ...recovery.value as Record<string, unknown>, nextRetryAt: 0 } } });
    await reconcileJobs(app.kivro);
    expect((await db.platformSetting.findUniqueOrThrow({ where: { key } })).value).toMatchObject({ code: 'LEDGER_INVARIANT', attempts: 2 });
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ state: 'CANCELLED', paymentState: 'RESERVED', executionRevokedAt: expect.any(Date) });
    expect(await db.ledgerEntry.count({ where: { jobId: job.id } })).toBe(0);
    expect(await db.auditEvent.count({ where: { jobId: job.id, type: 'JOB_RECOVERY_REQUIRED' } })).toBe(1);
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: buyer.id } })).toMatchObject({ availableMinor: 0, reservedMinor: 0, spentMinor: 0 });
  });
  it.each(['capability', 'worker', 'seller-worker', 'seller', 'buyer'] as const)('persists %s containment, cancellation and audit while only releasing the healthy reservation', async action => {
    const admin = await user(true), seller = await user(), damagedBuyer = await user(), healthyBuyer = await user();
    const keys = generateKeyPairSync('ed25519'), price = getPriceTier('USD_99');
    const worker = await db.workerDevice.create({ data: { sellerId: seller.id, name: 'Containment fixture', version: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)', sandboxReady: true, lastSeenAt: new Date(),
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } });
    const cap = await db.capability.create({ data: { sellerId: seller.id, slug: randomUUID(), visibility: 'PUBLIC', schedule: DEFAULT_SCHEDULE } });
    const version = await db.capabilityVersion.create({ data: { capabilityId: cap.id, version: 1, title: 'Containment fixture', summary: 'Synthetic safety case', description: '', category: 'Writing', tags: [], priceTierId: price.id,
      ioContract: { schemaVersion: 1, inputs: [], output: { type: 'TEXT', description: 'Result', required: true } },
      permissions: { schemaVersion: 1, tools: [], network: { mode: 'NONE', allowedDomains: [] }, resources: [], inference: { provider: 'openai-compatible', model: 'test' },
        limits: { timeoutSeconds: 300, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 1024, maxOutputBytes: 1024, maxTokens: 1000 } },
      dependencies: [], internalInstructions: 'Synthetic fixture', manifestHash: 'a'.repeat(64), publishedAt: new Date() } });
    await db.capability.update({ where: { id: cap.id }, data: { currentVersionId: version.id } });
    const makeJob = (buyerId: string, healthy: boolean) => serializable(db, async tx => {
      if (healthy) await creditWallet(tx, buyerId, 1000, `containment-funding:${randomUUID()}`);
      const job = await tx.job.create({ data: { buyerId, sellerId: seller.id, capabilityId: cap.id, capabilityVersionId: version.id, state: 'PAUSED', paymentState: 'RESERVED', input: {}, priceSnapshot: price,
        buyerPriceMinor: price.buyerPriceMinor, platformFeeMinor: price.platformFeeMinor, sellerNetMinor: price.sellerNetMinor, executionMode: 'NOW', waitDeadline: new Date(Date.now() + 600_000) } });
      if (healthy) await reserveJob(tx, job);
      const attempt = await tx.jobAttempt.create({ data: { jobId: job.id, workerId: worker.id, state: 'PAUSED', acceptedAt: new Date(), expiresAt: new Date(Date.now() + 600_000), nonce: randomUUID() } });
      return tx.job.update({ where: { id: job.id }, data: { activeAttemptId: attempt.id } });
    });
    const damaged = await makeJob(damagedBuyer.id, false), healthy = await makeJob(healthyBuyer.id, true);
    const signed = (method: 'GET' | 'POST', url: string, body?: unknown) => {
      const timestamp = String(Date.now()), nonce = randomUUID(), raw = body === undefined ? '' : JSON.stringify(body);
      return app.inject({ method, url, ...(body === undefined ? {} : { payload: raw }), headers: { 'content-type': 'application/json', 'x-worker-id': worker.id, 'x-worker-timestamp': timestamp,
        'x-worker-nonce': nonce, 'x-worker-signature': sign(null, Buffer.from(canonicalWorkerRequest(method, url.split('?')[0]!, timestamp, nonce, Buffer.from(raw))), keys.privateKey).toString('base64') } });
    };
    const endpoint = action === 'capability' ? `/api/admin/capabilities/${cap.id}/security` : action === 'worker' ? `/api/admin/workers/${worker.id}/revoke`
      : action === 'seller-worker' ? `/api/seller/workers/${worker.id}/revoke`
      : `/api/admin/users/${action === 'seller' ? seller.id : damagedBuyer.id}/suspend`;
    const payload = action === 'capability' ? { blocked: true, reason: 'Synthetic containment safety test' } : action === 'worker' ? { reason: 'Synthetic containment safety test' } : { suspended: true };
    if (action === 'seller-worker') expect((await app.inject({ method: 'POST', url: endpoint, headers: damagedBuyer.headers, payload: {} })).statusCode).toBe(404);
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await app.inject({ method: 'POST', url: endpoint, headers: action === 'seller-worker' ? seller.headers : admin.headers, payload }); expect(response.statusCode, response.body).toBe(200);
    }
    if (action === 'capability') expect((await db.capability.findUniqueOrThrow({ where: { id: cap.id } })).securityBlocked).toBe(true);
    if (action === 'worker' || action === 'seller-worker') expect((await db.workerDevice.findUniqueOrThrow({ where: { id: worker.id } })).revokedAt).not.toBeNull();
    if (action === 'seller' || action === 'buyer') {
      const id = action === 'seller' ? seller.id : damagedBuyer.id;
      expect((await db.user.findUniqueOrThrow({ where: { id } })).suspendedAt).not.toBeNull();
      expect(await db.session.count({ where: { userId: id } })).toBe(0);
      expect(await db.apiKey.count({ where: { userId: id, revokedAt: null } })).toBe(0);
    }
    const current = await db.job.findUniqueOrThrow({ where: { id: damaged.id } });
    expect(current).toMatchObject({ state: 'PAUSED', paymentState: 'RESERVED' }); expect(current.executionRevokedAt).not.toBeNull();
    expect(await db.workerCommand.count({ where: { jobId: damaged.id, type: 'CANCEL_JOB' } })).toBe(1);
    expect(await db.jobEvent.count({ where: { jobId: damaged.id, type: 'EXECUTION_REVOKED' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { jobId: damaged.id, type: 'JOB_RECOVERY_REQUIRED' } })).toBe(1);
    expect((await db.platformSetting.findUniqueOrThrow({ where: { key: `job-recovery-error:${damaged.id}` } })).value).toMatchObject({ code: 'LEDGER_INVARIANT' });
    expect(await db.ledgerEntry.count({ where: { jobId: damaged.id } })).toBe(0);
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: damagedBuyer.id } })).reservedMinor).toBe(0);
    const healthyState = await db.job.findUniqueOrThrow({ where: { id: healthy.id } });
    expect(healthyState.paymentState).toBe(action === 'buyer' ? 'RESERVED' : 'RELEASED');
    expect(await db.ledgerEntry.count({ where: { jobId: healthy.id, type: 'JOB_RELEASE' } })).toBe(action === 'buyer' ? 0 : 1);
    for (const response of [
      await signed('POST', `/api/worker/jobs/${damaged.id}/events`, { attemptId: damaged.activeAttemptId, type: 'RESUMING' }),
      await signed('GET', `/api/worker/jobs/${damaged.id}/payload?attemptId=${damaged.activeAttemptId}`),
      await signed('POST', `/api/worker/jobs/${damaged.id}/result`, { attemptId: damaged.activeAttemptId, output: { text: 'Must never settle' } }),
      await signed('POST', `/api/worker/jobs/${damaged.id}/uploads`, { attemptId: damaged.activeAttemptId, filename: 'private.txt', mimeType: 'text/plain', sizeBytes: 3, sha256: 'a'.repeat(64) }),
      await app.inject({ method: 'POST', url: `/api/jobs/${damaged.id}/resume`, headers: admin.headers, payload: {} }),
    ]) expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
    expect(await db.ledgerEntry.count({ where: { jobId: damaged.id, type: 'JOB_CAPTURE' } })).toBe(0);
    await reconcileJobs(app.kivro);
    expect(await db.workerCommand.count({ where: { jobId: damaged.id, type: 'CANCEL_JOB' } })).toBe(1);
    if (action === 'capability') {
      expect((await app.inject({ method: 'POST', url: endpoint, headers: admin.headers, payload: { ...payload, blocked: false } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `/api/jobs/${damaged.id}/resume`, headers: admin.headers, payload: {} })).statusCode).toBe(403);
    }
    await expect(db.job.update({ where: { id: damaged.id }, data: { executionRevokedAt: null } })).rejects.toThrow('immutable');
  });
});
