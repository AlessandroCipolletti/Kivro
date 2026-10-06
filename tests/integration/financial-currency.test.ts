import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../packages/database/src/index.js';
import { DEFAULT_SCHEDULE, getPriceTier, prepaidFinancialBreakdown } from '../../packages/contracts/src/index.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('explicit marketplace currency (isolated PostgreSQL schema)', () => {
  const schema = `currency_test_${randomBytes(8).toString('hex')}`;
  const buyerId = randomUUID(), sellerId = randomUUID(), capabilityId = randomUUID(), versionId = randomUUID();
  const jobId = randomUUID(), topupId = randomUUID(), transferId = randomUUID(), bucketKey = randomUUID();
  let db: PrismaClient;
  beforeAll(async () => {
    process.loadEnvFile('.env');
    const url = new URL(process.env.DATABASE_URL!);
    if (process.env.KIVRO_ENV !== 'development' || url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/kivro') throw new Error('Requires local development database');
    url.searchParams.set('schema', schema);
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url.toString() } });
    db = new PrismaClient({ datasourceUrl: url.toString() });
    await db.user.createMany({ data: [buyerId, sellerId].map(id => ({ id, email: `${id}@currency.kivro.local`, name: 'Currency fixture', passwordHash: 'disabled-fixture' })) });
    await db.wallet.create({ data: { userId: buyerId, availableMinor: 999 } });
    await db.capability.create({ data: { id: capabilityId, sellerId, slug: capabilityId, schedule: DEFAULT_SCHEDULE } });
    const price = getPriceTier('USD_99');
    await db.capabilityVersion.create({ data: { id: versionId, capabilityId, version: 1, title: 'Currency fixture', summary: 'Synthetic', description: '',
      category: 'Data & analytics', tags: [], priceTierId: price.id, ioContract: {}, permissions: {}, dependencies: [], internalInstructions: '', manifestHash: 'a'.repeat(64) } });
    await db.job.create({ data: { id: jobId, buyerId, sellerId, capabilityId, capabilityVersionId: versionId, input: {}, priceSnapshot: price,
      buyerPriceMinor: price.buyerPriceMinor, platformFeeMinor: price.platformFeeMinor, sellerNetMinor: price.sellerNetMinor,
      executionMode: 'NOW', waitDeadline: new Date(Date.now() + 60_000) } });
    await db.topup.create({ data: { id: topupId, userId: buyerId, idempotencyKey: randomUUID(), amountMinor: 999 } });
    await db.sellerTransfer.create({ data: { id: transferId, jobId, sellerId, amountMinor: price.sellerNetMinor } });
    await db.abuseBucket.create({ data: { key: bucketKey, amountMinor: 99, expiresAt: new Date(Date.now() + 60_000) } });
  });
  afterAll(async () => {
    if (db) {
      if (!/^currency_test_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe test schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await db.$disconnect();
    }
  });
  it('stores USD alongside all marketplace amounts without changing their values', async () => {
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } })).toMatchObject({ currency: 'USD', availableMinor: 999 });
    expect(await db.topup.findUniqueOrThrow({ where: { id: topupId } })).toMatchObject({ currency: 'USD', amountMinor: 999 });
    expect(await db.sellerTransfer.findUniqueOrThrow({ where: { id: transferId } })).toMatchObject({ currency: 'USD', amountMinor: 80 });
    expect(await db.job.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ currency: 'USD', buyerPriceMinor: 99, priceSnapshot: { currency: 'USD' } });
    expect(await db.abuseBucket.findUniqueOrThrow({ where: { key: bucketKey } })).toMatchObject({ currency: 'USD', amountMinor: 99 });
  });
  it('persists the canonical financial breakdown even for inserts that omit it', async () => {
    const saved = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(saved.financialBreakdown).toEqual(prepaidFinancialBreakdown(getPriceTier('USD_99')));
  });
  it.each([{ taxMinor: 0 }, { buyerTotalMinor: 100 }, { sellerEntitlementMinor: 79 }, { paymentProcessingFeeMinor: 1 },
    { processingFeeBearer: 'SELLER' }])('rejects rewriting historical financial interpretation %j', async patch => {
    const original = prepaidFinancialBreakdown(getPriceTier('USD_99'));
    await expect(db.job.update({ where: { id: jobId }, data: { financialBreakdown: { ...original, ...patch } } })).rejects.toThrow('financial breakdown is immutable');
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).financialBreakdown).toEqual(original);
  });
  it('rejects forged tax and allocation at job insertion instead of inventing a new payment policy', async () => {
    const id = randomUUID(), price = getPriceTier('USD_99');
    await expect(db.job.create({ data: { id, buyerId, sellerId, capabilityId, capabilityVersionId: versionId, input: {}, priceSnapshot: price,
      buyerPriceMinor: 99, platformFeeMinor: 19, sellerNetMinor: 80, executionMode: 'NOW', waitDeadline: new Date(Date.now() + 60_000),
      financialBreakdown: { ...prepaidFinancialBreakdown(price), taxMinor: 0 } } })).rejects.toThrow('does not match the prepaid policy');
    expect(await db.job.findUnique({ where: { id } })).toBeNull();
  });
  it.each(['Wallet', 'Topup', 'SellerTransfer', 'Job', 'AbuseBucket'])('rejects non-USD %s writes at the database boundary', async table => {
    await expect(db.$executeRawUnsafe(`UPDATE "${table}" SET "currency" = $1`, 'EUR')).rejects.toThrow(`${table}_supported_currency`);
    const rows = await db.$queryRawUnsafe<{ currency: string }[]>(`SELECT "currency" FROM "${table}"`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.currency).toBe('USD');
  });
  it('preserves provider-reported non-USD payout amounts without silently converting them', async () => {
    const now = new Date();
    const payout = await db.payoutRecord.create({ data: { sellerId, stripeAccountId: 'acct_currency_fixture', stripePayoutId: 'po_currency_fixture',
      livemode: false, amountMinor: 123, currency: 'CHF', status: 'paid', providerCreatedAt: now, arrivalDate: now, lastSyncedAt: now } });
    expect(payout).toMatchObject({ currency: 'CHF', amountMinor: 123 });
  });
});
