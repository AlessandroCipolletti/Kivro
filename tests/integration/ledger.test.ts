import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../../packages/database/src/index.js';
import { creditWallet, reserveJob, settleJob, releaseJob, refundJob } from '../../packages/billing/src/ledger.js';
import { getPriceTier, DEFAULT_SCHEDULE } from '../../packages/contracts/src/index.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('PostgreSQL financial concurrency', () => {
  let db: PrismaClient;
  const buyerId = randomUUID(); const sellerId = randomUUID(); const capabilityId = randomUUID(); const versionId = randomUUID();
  const price = getPriceTier('USD_999');
  beforeAll(async () => {
    config({ path: '.env' });
    if (process.env.KIVRO_ENV !== 'development' || !process.env.DATABASE_URL?.includes(':55432/kivro')) throw new Error('Tests require the local Kivro database.');
    db = new PrismaClient();
    await db.user.createMany({ data: [buyerId, sellerId].map(id => ({ id, email: `${id}@integration.kivro.local`, name: 'Integration fixture', passwordHash: 'not-a-login-hash' })) });
    await db.capability.create({ data: { id: capabilityId, sellerId, slug: `integration-${capabilityId}`, schedule: DEFAULT_SCHEDULE } });
    await db.capabilityVersion.create({ data: { id: versionId, capabilityId, version: 1, title: 'Integration fixture', summary: 'Test', description: '', category: 'Data & analytics', tags: [], priceTierId: price.id, ioContract: {}, permissions: {}, dependencies: [], internalInstructions: '', manifestHash: 'a'.repeat(64) } });
  });
  afterAll(async () => {
    if (!db) return;
    // Financial evidence is append-only even in tests; archive synthetic identities.
    await db.user.updateMany({ where: { id: { in: [buyerId, sellerId] } }, data: { suspendedAt: new Date() } });
    await db.$disconnect();
  });
  const job = async () => db.job.create({ data: { buyerId, sellerId, capabilityId, capabilityVersionId: versionId, input: {}, priceSnapshot: price, buyerPriceMinor: price.buyerPriceMinor, platformFeeMinor: price.platformFeeMinor, sellerNetMinor: price.sellerNetMinor, executionMode: 'NOW', waitDeadline: new Date(Date.now() + 60_000) } });
  it('credits a repeated payment only once even under concurrent webhooks', async () => {
    const key = `integration:${buyerId}:fund`;
    await Promise.all(Array.from({ length: 5 }, () => db.$transaction(tx => creditWallet(tx, buyerId, 10_000, key))));
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } })).availableMinor).toBe(10_000);
    expect(await db.ledgerEntry.count({ where: { operationKey: key } })).toBe(1);
  });
  it('reserves, settles and refunds exactly once, preserving fee reversal', async () => {
    const created = await job();
    await db.$transaction(tx => reserveJob(tx, created));
    await db.job.update({ where: { id: created.id }, data: { state: 'VALIDATING_RESULTS' } });
    const results = await Promise.all(Array.from({ length: 5 }, () => db.$transaction(tx => settleJob(tx, created, false))));
    expect(results.filter(Boolean)).toHaveLength(1);
    const seller = await db.wallet.findUniqueOrThrow({ where: { userId: sellerId } });
    expect(seller.earnedMinor).toBe(800);
    const settlements = await db.ledgerEntry.findMany({ where: { jobId: created.id, type: { in: ['JOB_CAPTURE', 'SELLER_EARNING', 'PLATFORM_FEE'] } } });
    expect(settlements).toHaveLength(3);
    expect(settlements.reduce((n, e) => n + e.amountMinor, 0)).toBe(0);
    const refunds = await Promise.all(Array.from({ length: 3 }, () => db.$transaction(tx => refundJob(tx, created))));
    expect(refunds.filter(Boolean)).toHaveLength(1);
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } })).availableMinor).toBe(10_000);
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: sellerId } })).earnedMinor).toBe(0);
  });
  it('releases cancellation once and refuses settlement before validation', async () => {
    const created = await job();
    await db.$transaction(tx => reserveJob(tx, created));
    expect(await db.$transaction(tx => settleJob(tx, created, false))).toBe(false);
    const results = await Promise.all(Array.from({ length: 3 }, () => db.$transaction(tx => releaseJob(tx, created))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } })).reservedMinor).toBe(0);
  });
  it('enforces append-only financial records at the database boundary', async () => {
    await expect(db.ledgerEntry.deleteMany({ where: { operationKey: `integration:${buyerId}:fund` } })).rejects.toThrow('append-only');
    await expect(db.ledgerEntry.updateMany({ where: { operationKey: `integration:${buyerId}:fund` }, data: { amountMinor: 1 } })).rejects.toThrow('append-only');
  });
});
