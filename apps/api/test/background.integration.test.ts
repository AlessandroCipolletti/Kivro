import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient, json, serializable, type JobState } from '@kivro/database';
import { creditWallet, reserveJob } from '@kivro/billing';
import { DEFAULT_SCHEDULE, getPriceTier, type PermissionManifest } from '@kivro/contracts';
import { createApp } from '../src/app.js';
import { reconcileJobs } from '../src/background.js';
import { failJob } from '../src/jobs.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('durable bounded recovery fairness', () => {
  let db: PrismaClient, app: FastifyInstance;
  const buyerId = randomUUID(), sellerId = randomUUID(), capabilityId = randomUUID(), versionId = randomUUID(), workerId = randomUUID();
  const permissions: PermissionManifest = { schemaVersion: 1, tools: [], network: { mode: 'NONE', allowedDomains: [] }, resources: [], inference: { provider: 'openai-compatible', model: 'test' },
    limits: { timeoutSeconds: 10, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 1024, maxOutputBytes: 1024, maxTokens: 1000 } };
  const price = getPriceTier('USD_99');
  const makeJob = async (state: JobState, timestamp: number, id = randomUUID()) => db.$transaction(async tx => {
    const job = await tx.job.create({ data: { id, buyerId, sellerId, capabilityId, capabilityVersionId: versionId, state, input: {}, priceSnapshot: price,
      buyerPriceMinor: price.buyerPriceMinor, platformFeeMinor: price.platformFeeMinor, sellerNetMinor: price.sellerNetMinor,
      executionMode: 'SCHEDULED', scheduledAt: new Date(Date.now() + 3600_000), waitDeadline: new Date(Date.now() + 2 * 3600_000), createdAt: new Date(timestamp) } });
    await reserveJob(tx, job); return job;
  });
  beforeAll(async () => {
    process.loadEnvFile('.env');
    if (process.env.KIVRO_ENV !== 'development' || !process.env.DATABASE_URL?.includes(':55432/kivro')) throw new Error('Requires local development services');
    db = new PrismaClient();
    for (const id of [buyerId, sellerId]) await db.user.create({ data: { id, email: `${id}@recovery.kivro.local`, name: 'Synthetic recovery fixture', passwordHash: 'disabled', wallet: { create: {} } } });
    await serializable(db, tx => creditWallet(tx, buyerId, 100_000, `recovery:${buyerId}`));
    await db.capability.create({ data: { id: capabilityId, sellerId, slug: `recovery-${capabilityId}`, schedule: DEFAULT_SCHEDULE } });
    await db.capabilityVersion.create({ data: { id: versionId, capabilityId, version: 1, title: 'Recovery test only', summary: '', description: '', category: 'test', tags: [], priceTierId: price.id,
      ioContract: {}, permissions: json(permissions), dependencies: [], internalInstructions: 'Synthetic recovery fixture; never dispatch', manifestHash: 'a'.repeat(64) } });
    await db.capability.update({ where: { id: capabilityId }, data: { currentVersionId: versionId } });
    await db.workerDevice.create({ data: { id: workerId, sellerId, publicKey: `synthetic-unused-key-${workerId}`, name: 'Disconnected recovery worker', version: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)', lastSeenAt: new Date(Date.now() - 10 * 60_000) } });
    app = await createApp({ db, logger: false });
  });
  afterAll(async () => {
    if (db) {
      const remaining = await db.job.findMany({ where: { buyerId, paymentState: 'RESERVED' } });
      for (const job of remaining) await db.$transaction(tx => failJob(tx, job, 'CANCELLED', 'Archived synthetic recovery fixture'));
      await db.user.updateMany({ where: { id: { in: [buyerId, sellerId] } }, data: { suspendedAt: new Date() } });
      await db.capability.updateMany({ where: { id: capabilityId }, data: { paused: true, visibility: 'PRIVATE' } });
      await db.workerDevice.updateMany({ where: { id: workerId }, data: { revokedAt: new Date() } });
    }
    await app?.close(); await db?.$disconnect();
  });
  it('processes active deadlines behind 251 older future reservations and advances the waiting cursor', async () => {
    const now = Date.now();
    // Ascending IDs make the overflow deterministic; all historical financial
    // entries remain append-only after these synthetic reservations are released.
    for (let index = 0; index < 251; index++) await makeJob('SCHEDULED', now - 3600_000, `00000000-0000-4000-8000-${buyerId.slice(0, 8)}${index.toString(16).padStart(4, '0')}`);
    const expiredWaiting = await makeJob('SCHEDULED', now, `ffffffff-ffff-4fff-8fff-${buyerId.slice(0, 8)}ffff`);
    await db.job.update({ where: { id: expiredWaiting.id }, data: { waitDeadline: new Date(now - 1000) } });
    const running = await makeJob('RUNNING', now), paused = await makeJob('PAUSED', now), disconnected = await makeJob('ACCEPTED', now), offered = await makeJob('OFFERED', now);
    await db.job.update({ where: { id: running.id }, data: { startedAt: new Date(now - 300_000) } });
    await db.job.update({ where: { id: paused.id }, data: { startedAt: new Date(now - 1200_000), pausedAt: new Date(now - 1000_000) } });
    for (const job of [disconnected, offered]) {
      const attempt = await db.jobAttempt.create({ data: { jobId: job.id, workerId, nonce: randomUUID(), expiresAt: new Date(now + (job.id === offered.id ? -1000 : 60_000)), ...(job.id === disconnected.id ? { acceptedAt: new Date(now - 100_000), state: 'ACCEPTED' } : {}) } });
      await db.job.update({ where: { id: job.id }, data: { activeAttemptId: attempt.id } });
    }
    for (const key of ['job-recovery-active-cursor', 'job-recovery-waiting-cursor']) await db.platformSetting.upsert({ where: { key }, create: { key, value: '' }, update: { value: '' } });
    await reconcileJobs(app.kivro);
    for (const [id, state] of [[running.id, 'TIMED_OUT'], [paused.id, 'TIMED_OUT'], [disconnected.id, 'FAILED']] as const) {
      expect(await db.job.findUniqueOrThrow({ where: { id } })).toMatchObject({ state, paymentState: 'RELEASED' });
      expect(await db.ledgerEntry.count({ where: { jobId: id, type: 'JOB_RELEASE' } })).toBe(1);
    }
    expect(await db.job.findUniqueOrThrow({ where: { id: offered.id } })).toMatchObject({ state: 'QUEUED', activeAttemptId: null, paymentState: 'RESERVED' });
    // A second pass must reach the overflow instead of repeating the same 250.
    await reconcileJobs(app.kivro);
    expect(await db.job.findUniqueOrThrow({ where: { id: expiredWaiting.id } })).toMatchObject({ state: 'TIMED_OUT', paymentState: 'RELEASED' });
  });
});
