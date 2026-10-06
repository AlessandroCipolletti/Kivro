import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, serializable, type Job, type Prisma } from '@kivro/database';
import { DEFAULT_SCHEDULE, getPriceTier } from '@kivro/contracts';
import { creditWallet, refundJob, releaseJob, reserveJob, settleJob } from '@kivro/billing';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('job-specific financial provenance (real PostgreSQL)', () => {
  let db: PrismaClient;
  const schema = `ledger_provenance_${randomBytes(8).toString('hex')}`;
  const url = `postgresql://kivro:kivro_local_only@127.0.0.1:55432/kivro?schema=${schema}`;
  beforeAll(async () => {
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url } });
    db = new PrismaClient({ datasourceUrl: url });
  });
  afterAll(async () => {
    if (!db) return;
    if (!/^ledger_provenance_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe fixture schema');
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
  });
  const fixture = async () => {
    const buyerId = randomUUID(), sellerId = randomUUID();
    await db.user.createMany({ data: [buyerId, sellerId].map(id => ({ id, email: `${id}@ledger-provenance.kivro.local`, name: 'Synthetic provenance fixture', passwordHash: 'disabled' })) });
    const capability = await db.capability.create({ data: { sellerId, slug: randomUUID(), schedule: DEFAULT_SCHEDULE } });
    const version = await db.capabilityVersion.create({ data: { capabilityId: capability.id, version: 1, title: 'Provenance fixture', summary: '', description: '', category: 'test', tags: [], priceTierId: 'USD_99',
      ioContract: {}, permissions: {}, dependencies: [], internalInstructions: 'Never dispatch this accounting fixture.', manifestHash: 'a'.repeat(64) } });
    await serializable(db, tx => creditWallet(tx, buyerId, 1000, `fixture:${buyerId}`));
    const job = async (funded: boolean, tier = 'USD_99') => serializable(db, async tx => {
      const price = getPriceTier(tier);
      const row = await tx.job.create({ data: { buyerId, sellerId, capabilityId: capability.id, capabilityVersionId: version.id, state: 'VALIDATING_RESULTS', paymentState: 'RESERVED', input: {},
        priceSnapshot: price, buyerPriceMinor: price.buyerPriceMinor, sellerNetMinor: price.sellerNetMinor, platformFeeMinor: price.platformFeeMinor, executionMode: 'NOW', waitDeadline: new Date(Date.now() + 60_000) } });
      if (funded) await reserveJob(tx, row);
      return row;
    });
    return { buyerId, sellerId, job };
  };
  const reserveEvidence = (job: Job): Prisma.LedgerEntryCreateManyInput => ({ operationKey: `job:${job.id}:reserve`, transactionId: randomUUID(), jobId: job.id, userId: job.buyerId,
    type: 'JOB_RESERVE', amountMinor: job.buyerPriceMinor, availableDelta: -job.buyerPriceMinor, reservedDelta: job.buyerPriceMinor });
  const snapshot = async (buyerId: string, sellerId: string, jobId: string) => ({
    wallets: await db.wallet.findMany({ where: { userId: { in: [buyerId, sellerId] } }, orderBy: { userId: 'asc' } }),
    job: await db.job.findUniqueOrThrow({ where: { id: jobId } }),
    ledger: await db.ledgerEntry.findMany({ where: { jobId }, orderBy: { operationKey: 'asc' } }),
  });

  it.each(['release', 'settle', 'reserve'].flatMap(operation => ['missing', 'wrong-amount', 'wrong-owner', 'wrong-job', 'wrong-type', 'wrong-deltas', 'duplicate', 'consumed'].filter(damage => operation !== 'reserve' || damage !== 'missing').map(damage => ({ operation, damage }))))('$operation rejects $damage history without touching another job funds', async ({ operation, damage }) => {
    const f = await fixture(), healthy = await f.job(true), damaged = await f.job(false);
    const entry = reserveEvidence(damaged);
    if (damage === 'wrong-amount') entry.amountMinor = 98;
    if (damage === 'wrong-owner') entry.userId = f.sellerId;
    if (damage === 'wrong-job') entry.jobId = healthy.id;
    if (damage === 'wrong-type') entry.type = 'CREDIT_PURCHASE';
    if (damage === 'wrong-deltas') entry.spentDelta = 1;
    if (damage !== 'missing') await db.ledgerEntry.createMany({ data: [entry] });
    if (damage === 'duplicate' || damage === 'consumed') await db.ledgerEntry.createMany({ data: [{ ...entry, transactionId: randomUUID(),
      operationKey: damage === 'duplicate' ? `fixture:duplicate:${damaged.id}` : `job:${damaged.id}:release`, type: damage === 'duplicate' ? 'JOB_RESERVE' : 'JOB_RELEASE' }] });
    const before = await snapshot(f.buyerId, f.sellerId, damaged.id);
    await expect(serializable<boolean | void>(db, tx => operation === 'release' ? releaseJob(tx, damaged) : operation === 'settle' ? settleJob(tx, damaged, true) : reserveJob(tx, damaged))).rejects.toMatchObject({ code: 'LEDGER_INVARIANT' });
    expect(await snapshot(f.buyerId, f.sellerId, damaged.id)).toEqual(before);
    expect(await db.sellerTransfer.count({ where: { jobId: damaged.id } })).toBe(0);
    // A wrongly bound entry also invalidates the job it names; it must never be ignored.
    if (damage !== 'wrong-job') expect(await serializable(db, tx => releaseJob(tx, healthy))).toBe(true);
  });

  it.each(['missing', 'reserve-only', 'wrong-capture', 'wrong-earning', 'wrong-fee', 'wrong-job', 'split-transaction', 'consumed'])('refund rejects %s settlement even when pooled spent and earned balances suffice', async damage => {
    const f = await fixture(), healthy = await f.job(true, 'USD_499'), damaged = await f.job(false, 'USD_499');
    await serializable(db, tx => settleJob(tx, healthy, false));
    await db.job.update({ where: { id: damaged.id }, data: { paymentState: 'SETTLED' } });
    const settlementId = randomUUID();
    const history = await db.ledgerEntry.findMany({ where: { jobId: healthy.id } });
    if (damage !== 'missing') {
      for (const row of history.filter(row => damage !== 'reserve-only' || row.type === 'JOB_RESERVE')) {
        const { id: _id, createdAt: _createdAt, metadata: _metadata, ...data } = row;
        await db.ledgerEntry.create({ data: { ...data, jobId: damage === 'wrong-job' && row.type === 'JOB_CAPTURE' ? healthy.id : damaged.id,
          operationKey: data.operationKey.replace(healthy.id, damaged.id), transactionId: row.type === 'JOB_RESERVE' || damage === 'split-transaction' ? randomUUID() : settlementId,
          amountMinor: (damage === 'wrong-capture' && row.type === 'JOB_CAPTURE' || damage === 'wrong-earning' && row.type === 'SELLER_EARNING' || damage === 'wrong-fee' && row.type === 'PLATFORM_FEE') ? row.amountMinor + 1 : row.amountMinor } });
      }
    }
    if (damage === 'consumed') await db.ledgerEntry.create({ data: { operationKey: `job:${damaged.id}:refund`, transactionId: randomUUID(), jobId: damaged.id, userId: f.buyerId, type: 'REFUND', amountMinor: 499, availableDelta: 499, spentDelta: -499 } });
    const before = await snapshot(f.buyerId, f.sellerId, damaged.id);
    await expect(serializable(db, tx => refundJob(tx, damaged))).rejects.toMatchObject({ code: 'LEDGER_INVARIANT' });
    expect(await snapshot(f.buyerId, f.sellerId, damaged.id)).toEqual(before);
    if (damage !== 'wrong-job') expect(await serializable(db, tx => refundJob(tx, healthy))).toBe(true);
  });

  it.each(['damaged-first', 'healthy-first'] as const)('concurrent settlement cannot borrow another job reserve (%s)', async order => {
    const f = await fixture(), damaged = await f.job(false), healthy = await f.job(true);
    const jobs = order === 'damaged-first' ? [damaged, healthy] : [healthy, damaged];
    const results = await Promise.allSettled(jobs.map(row => serializable(db, tx => settleJob(tx, row, true))));
    expect(results[jobs.indexOf(damaged)]).toMatchObject({ status: 'rejected', reason: { code: 'LEDGER_INVARIANT' } });
    expect(results[jobs.indexOf(healthy)]).toEqual({ status: 'fulfilled', value: true });
    expect(await db.ledgerEntry.count({ where: { jobId: damaged.id } })).toBe(0);
    expect(await db.ledgerEntry.count({ where: { jobId: healthy.id, type: 'JOB_CAPTURE' } })).toBe(1);
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } })).toMatchObject({ availableMinor: 901, reservedMinor: 0, spentMinor: 99 });
  });

  it('serializes release versus settlement and refund replay using persisted immutable job amounts', async () => {
    const f = await fixture(), row = await f.job(true);
    const stale = { ...row, buyerPriceMinor: 999, sellerNetMinor: 800, platformFeeMinor: 199, buyerId: f.sellerId };
    const results = await Promise.all([serializable(db, tx => releaseJob(tx, stale)), serializable(db, tx => settleJob(tx, stale, false))]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const final = await db.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(await db.ledgerEntry.count({ where: { jobId: row.id, type: { in: ['JOB_RELEASE', 'JOB_CAPTURE'] } } })).toBe(1);
    if (final.paymentState === 'SETTLED') {
      const refunds = await Promise.all(Array.from({ length: 3 }, () => serializable(db, tx => refundJob(tx, stale))));
      expect(refunds.filter(Boolean)).toHaveLength(1);
    }
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } })).toMatchObject({ availableMinor: 1000, reservedMinor: 0, spentMinor: 0 });
  });

  it.each(['damaged-first', 'healthy-first'] as const)('concurrent refund cannot borrow another job capture (%s)', async order => {
    const f = await fixture(), damaged = await f.job(false, 'USD_499'), healthy = await f.job(true, 'USD_499');
    await db.job.update({ where: { id: damaged.id }, data: { paymentState: 'SETTLED' } });
    await serializable(db, tx => settleJob(tx, healthy, false));
    const jobs = order === 'damaged-first' ? [damaged, healthy] : [healthy, damaged];
    const results = await Promise.allSettled(jobs.map(row => serializable(db, tx => refundJob(tx, row))));
    expect(results[jobs.indexOf(damaged)]).toMatchObject({ status: 'rejected', reason: { code: 'LEDGER_INVARIANT' } });
    expect(results[jobs.indexOf(healthy)]).toEqual({ status: 'fulfilled', value: true });
    expect(await db.ledgerEntry.count({ where: { jobId: damaged.id } })).toBe(0);
    expect(await db.ledgerEntry.count({ where: { jobId: healthy.id, type: 'REFUND' } })).toBe(1);
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } })).toMatchObject({ availableMinor: 1000, spentMinor: 0 });
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.sellerId } })).toMatchObject({ earnedMinor: 0 });
  });

  it('preserves exact-once reserve, settle and refund under concurrent retries', async () => {
    const f = await fixture(), row = await f.job(false);
    await Promise.all(Array.from({ length: 3 }, () => serializable(db, tx => reserveJob(tx, row))));
    const settlements = await Promise.all(Array.from({ length: 3 }, () => serializable(db, tx => settleJob(tx, row, true))));
    expect(settlements.filter(Boolean)).toHaveLength(1);
    const refunds = await Promise.all(Array.from({ length: 3 }, () => serializable(db, tx => refundJob(tx, row))));
    expect(refunds.filter(Boolean)).toHaveLength(1);
    const history = await db.ledgerEntry.findMany({ where: { jobId: row.id } });
    expect(history).toHaveLength(7);
    expect(history.filter(entry => entry.type !== 'JOB_RESERVE').reduce((total, entry) => total + entry.amountMinor, 0)).toBe(0);
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } })).toMatchObject({ availableMinor: 1000, reservedMinor: 0, spentMinor: 0 });
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.sellerId } })).toMatchObject({ earnedMinor: 0 });
    expect(await db.sellerTransfer.findUniqueOrThrow({ where: { jobId: row.id } })).toMatchObject({ state: 'REVERSAL_PENDING' });
  });
});
