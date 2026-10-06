import { randomUUID } from 'node:crypto';
import type { Job, LedgerEntry, Transaction } from '@kivro/database';

export class BillingError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export function assertMoney(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100_000_000) {
    throw new BillingError('INVALID_AMOUNT', 'Amount must be positive integer USD cents within the platform limit');
  }
}

export function assertPrice(price: { buyerPriceMinor: number; sellerNetMinor: number; platformFeeMinor: number }): void {
  assertMoney(price.buyerPriceMinor);
  assertMoney(price.sellerNetMinor);
  assertMoney(price.platformFeeMinor);
  if (price.buyerPriceMinor !== price.sellerNetMinor + price.platformFeeMinor) {
    throw new BillingError('INVALID_PRICE', 'Price does not balance');
  }
}

export async function ensureWallet(tx: Transaction, userId: string) {
  return tx.wallet.upsert({ where: { userId }, create: { userId }, update: {} });
}

export async function creditWallet(tx: Transaction, userId: string, amount: number, operationKey: string) {
  assertMoney(amount);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${operationKey}, 0))`;
  const existing = await tx.ledgerEntry.findUnique({ where: { operationKey } });
  if (existing) {
    if (existing.userId !== userId || existing.amountMinor !== amount) throw new BillingError('IDEMPOTENCY_CONFLICT', 'Credit reference was already used');
    return existing;
  }
  await ensureWallet(tx, userId);
  await tx.wallet.update({ where: { userId }, data: { availableMinor: { increment: amount } } });
  const transactionId = randomUUID();
  const entry = await tx.ledgerEntry.create({ data: {
    operationKey, transactionId, userId, type: 'CREDIT_PURCHASE', amountMinor: amount, availableDelta: amount,
  } });
  await tx.ledgerEntry.create({ data: {
    operationKey: `${operationKey}:funding`, transactionId, type: 'EXTERNAL_FUNDING', amountMinor: -amount,
  } });
  return entry;
}

export async function reconcileTopupRefund(tx: Transaction, topupId: string, cumulativeRefundMinor: number): Promise<void> {
  const lock = `topup-refund:${topupId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
  const topup = await tx.topup.findUniqueOrThrow({ where: { id: topupId } });
  if (!Number.isSafeInteger(cumulativeRefundMinor) || cumulativeRefundMinor < 0 || cumulativeRefundMinor > topup.amountMinor) throw new BillingError('INVALID_REFUND', 'Provider refund exceeds the original payment');
  const refundedMinor = Math.max(topup.refundedMinor, cumulativeRefundMinor);
  const credited = await tx.ledgerEntry.findUnique({ where: { operationKey: `stripe-topup:${topup.id}` } });
  if (!credited) {
    await tx.topup.update({ where: { id: topup.id }, data: { refundedMinor } });
    return;
  }
  const delta = refundedMinor - topup.refundAppliedMinor;
  let additionalDebt = 0;
  if (delta > 0) {
    const wallet = await ensureWallet(tx, topup.userId);
    const collected = Math.min(wallet.availableMinor, delta), debt = delta - collected;
    additionalDebt = debt;
    await tx.wallet.update({ where: { userId: topup.userId }, data: { availableMinor: { decrement: collected } } });
    const transactionId = randomUUID(), operationKey = `topup:${topup.id}:refund:${refundedMinor}`;
    await tx.ledgerEntry.createMany({ data: [
      { operationKey, transactionId, userId: topup.userId, type: 'TOPUP_REFUND', amountMinor: -collected, availableDelta: -collected, metadata: { topupId, providerRefundMinor: delta } },
      { operationKey: `${operationKey}:external`, transactionId, type: 'EXTERNAL_REFUND', amountMinor: delta, metadata: { topupId } },
      ...(debt ? [{ operationKey: `${operationKey}:debt`, transactionId, userId: topup.userId, type: 'REFUND_RECEIVABLE', amountMinor: -debt, metadata: { topupId } }] : []),
    ] });
    if (debt) await tx.user.update({ where: { id: topup.userId }, data: { suspendedAt: new Date() } });
  }
  await tx.topup.update({ where: { id: topup.id }, data: { refundedMinor, refundAppliedMinor: refundedMinor, refundDebtMinor: { increment: additionalDebt },
    state: refundedMinor === topup.amountMinor ? 'REFUNDED' : refundedMinor > 0 ? 'PARTIALLY_REFUNDED' : 'PAID' } });
}

export async function collectRefundDebt(tx: Transaction, userId: string): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-account:${userId}`}, 0))`;
  const topups = await tx.topup.findMany({ where: { userId, refundDebtMinor: { gt: 0 } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } });
  let remaining = 0;
  for (const { id } of topups) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`topup-refund:${id}`}, 0))`;
    const topup = await tx.topup.findUniqueOrThrow({ where: { id } });
    if (topup.userId !== userId || topup.refundDebtMinor < 0 || topup.refundDebtMinor > topup.refundAppliedMinor || topup.refundAppliedMinor > topup.amountMinor) {
      throw new BillingError('LEDGER_INVARIANT', 'Refund debt does not match the original payment');
    }
    const wallet = await ensureWallet(tx, userId);
    const collected = Math.min(wallet.availableMinor, topup.refundDebtMinor);
    remaining += topup.refundDebtMinor - collected;
    if (!collected) continue;
    // Outstanding debt can repeat after a later cumulative refund. Immutable collections cannot.
    const history = await tx.ledgerEntry.aggregate({ where: { userId, type: 'REFUND_DEBT_COLLECTION', metadata: { path: ['topupId'], equals: topup.id } }, _sum: { amountMinor: true } });
    const previouslyCollected = -(history._sum.amountMinor ?? 0), cumulativeCollectedMinor = previouslyCollected + collected;
    if (!Number.isSafeInteger(cumulativeCollectedMinor) || previouslyCollected < 0 || cumulativeCollectedMinor > topup.refundAppliedMinor) {
      throw new BillingError('LEDGER_INVARIANT', 'Refund collection history does not match the applied refund');
    }
    await tx.wallet.update({ where: { userId }, data: { availableMinor: { decrement: collected } } });
    await tx.topup.update({ where: { id: topup.id }, data: { refundDebtMinor: { decrement: collected } } });
    const transactionId = randomUUID(), operationKey = `topup:${topup.id}:debt-collected:${cumulativeCollectedMinor}`;
    await tx.ledgerEntry.createMany({ data: [
      { operationKey, transactionId, userId, type: 'REFUND_DEBT_COLLECTION', amountMinor: -collected, availableDelta: -collected, metadata: { topupId: topup.id, cumulativeCollectedMinor } },
      { operationKey: `${operationKey}:receivable`, transactionId, userId, type: 'REFUND_RECEIVABLE_RECOVERY', amountMinor: collected, metadata: { topupId: topup.id, cumulativeCollectedMinor } },
    ] });
  }
  return remaining;
}

async function lockJob(tx: Transaction, id: string): Promise<Job> {
  await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${id}::uuid FOR UPDATE`;
  return tx.job.findUniqueOrThrow({ where: { id } });
}

async function hasFinancialHistory(tx: Transaction, job: Job, state: 'reserved' | 'settled'): Promise<boolean> {
  type Evidence = Pick<LedgerEntry, 'operationKey' | 'type' | 'userId' | 'jobId' | 'currency' | 'amountMinor' | 'availableDelta' | 'reservedDelta' | 'spentDelta' | 'earnedDelta'>;
  const entry = (suffix: string, values: Pick<Evidence, 'type' | 'amountMinor'> & Partial<Evidence>): Evidence => ({
    operationKey: `job:${job.id}:${suffix}`, jobId: job.id, userId: null, currency: 'USD', availableDelta: 0, reservedDelta: 0, spentDelta: 0, earnedDelta: 0, ...values,
  });
  const expected = [entry('reserve', { type: 'JOB_RESERVE', userId: job.buyerId, amountMinor: job.buyerPriceMinor, availableDelta: -job.buyerPriceMinor, reservedDelta: job.buyerPriceMinor })];
  if (state === 'settled') expected.push(
    entry('capture', { type: 'JOB_CAPTURE', userId: job.buyerId, amountMinor: -job.buyerPriceMinor, reservedDelta: -job.buyerPriceMinor, spentDelta: job.buyerPriceMinor }),
    entry('earning', { type: 'SELLER_EARNING', userId: job.sellerId, amountMinor: job.sellerNetMinor, earnedDelta: job.sellerNetMinor }),
    entry('fee', { type: 'PLATFORM_FEE', amountMinor: job.platformFeeMinor }),
  );
  const keys = ['reserve', 'release', 'capture', 'earning', 'fee', 'refund', 'earning-reversal', 'fee-reversal'].map(suffix => `job:${job.id}:${suffix}`);
  // Pooled wallet balances are not proof of this job's funds. Check its exact prior stage.
  const entries = await tx.ledgerEntry.findMany({ where: { OR: [{ jobId: job.id }, { operationKey: { in: keys } }] }, take: expected.length + 1 });
  if (!entries.length) return false;
  if (entries.length !== expected.length || expected.some(evidence => {
    const actual = entries.find(row => row.operationKey === evidence.operationKey);
    return !actual || (Object.keys(evidence) as (keyof Evidence)[]).some(key => actual[key] !== evidence[key]);
  })) {
    throw new BillingError('LEDGER_INVARIANT', 'Job financial history is invalid or already consumed');
  }
  if (state === 'settled') {
    const reserve = entries.find(row => row.type === 'JOB_RESERVE')!;
    const settlementIds = new Set(entries.filter(row => row.type !== 'JOB_RESERVE').map(row => row.transactionId));
    if (settlementIds.size !== 1 || settlementIds.has(reserve.transactionId)) throw new BillingError('LEDGER_INVARIANT', 'Job settlement is not one balanced transaction');
  }
  return true;
}

export async function reserveJob(tx: Transaction, job: Job): Promise<void> {
  job = await lockJob(tx, job.id);
  assertPrice(job);
  if (job.paymentState !== 'RESERVED') throw new BillingError('LEDGER_INVARIANT', 'Job is not eligible for a reservation');
  const operationKey = `job:${job.id}:reserve`;
  if (await hasFinancialHistory(tx, job, 'reserved')) return;
  await ensureWallet(tx, job.buyerId);
  const reserved = await tx.wallet.updateMany({
    where: { userId: job.buyerId, availableMinor: { gte: job.buyerPriceMinor } },
    data: { availableMinor: { decrement: job.buyerPriceMinor }, reservedMinor: { increment: job.buyerPriceMinor } },
  });
  if (reserved.count !== 1) throw new BillingError('INSUFFICIENT_FUNDS', 'Insufficient available credit balance');
  await tx.ledgerEntry.create({ data: {
    operationKey, transactionId: randomUUID(), userId: job.buyerId, jobId: job.id,
    type: 'JOB_RESERVE', amountMinor: job.buyerPriceMinor,
    availableDelta: -job.buyerPriceMinor, reservedDelta: job.buyerPriceMinor,
  } });
}

export async function releaseJob(tx: Transaction, job: Job): Promise<boolean> {
  job = await lockJob(tx, job.id);
  if (job.paymentState !== 'RESERVED') return false;
  if (!await hasFinancialHistory(tx, job, 'reserved')) throw new BillingError('LEDGER_INVARIANT', 'Job has no backing reservation');
  const changed = await tx.job.updateMany({ where: { id: job.id, paymentState: 'RESERVED' }, data: { paymentState: 'RELEASED' } });
  if (!changed.count) return false;
  const wallet = await tx.wallet.updateMany({ where: { userId: job.buyerId, reservedMinor: { gte: job.buyerPriceMinor } },
    data: { reservedMinor: { decrement: job.buyerPriceMinor }, availableMinor: { increment: job.buyerPriceMinor } } });
  if (!wallet.count) throw new BillingError('LEDGER_INVARIANT', 'Reserved balance does not match the job');
  await tx.ledgerEntry.create({ data: {
    operationKey: `job:${job.id}:release`, transactionId: randomUUID(), jobId: job.id,
    userId: job.buyerId, type: 'JOB_RELEASE', amountMinor: job.buyerPriceMinor,
    availableDelta: job.buyerPriceMinor, reservedDelta: -job.buyerPriceMinor,
  } });
  return true;
}

export async function settleJob(tx: Transaction, job: Job, createTransfer: boolean): Promise<boolean> {
  job = await lockJob(tx, job.id);
  assertPrice(job);
  if (job.paymentState !== 'RESERVED' || job.state !== 'VALIDATING_RESULTS') return false;
  if (!await hasFinancialHistory(tx, job, 'reserved')) throw new BillingError('LEDGER_INVARIANT', 'Job has no backing reservation');
  const changed = await tx.job.updateMany({ where: { id: job.id, paymentState: 'RESERVED', state: 'VALIDATING_RESULTS' }, data: { paymentState: 'SETTLED' } });
  if (!changed.count) return false;
  const wallet = await tx.wallet.updateMany({ where: { userId: job.buyerId, reservedMinor: { gte: job.buyerPriceMinor } },
    data: { reservedMinor: { decrement: job.buyerPriceMinor }, spentMinor: { increment: job.buyerPriceMinor } } });
  if (!wallet.count) throw new BillingError('LEDGER_INVARIANT', 'Reserved balance does not match the job');
  await ensureWallet(tx, job.sellerId);
  await tx.wallet.update({ where: { userId: job.sellerId }, data: { earnedMinor: { increment: job.sellerNetMinor } } });
  const transactionId = randomUUID();
  await tx.ledgerEntry.createMany({ data: [
    { operationKey: `job:${job.id}:capture`, transactionId, userId: job.buyerId, jobId: job.id,
      type: 'JOB_CAPTURE', amountMinor: -job.buyerPriceMinor, reservedDelta: -job.buyerPriceMinor, spentDelta: job.buyerPriceMinor },
    { operationKey: `job:${job.id}:earning`, transactionId, userId: job.sellerId, jobId: job.id,
      type: 'SELLER_EARNING', amountMinor: job.sellerNetMinor, earnedDelta: job.sellerNetMinor },
    { operationKey: `job:${job.id}:fee`, transactionId, jobId: job.id, type: 'PLATFORM_FEE', amountMinor: job.platformFeeMinor },
  ] });
  if (createTransfer) await tx.sellerTransfer.create({ data: { jobId: job.id, sellerId: job.sellerId, amountMinor: job.sellerNetMinor } });
  return true;
}

export async function refundJob(tx: Transaction, job: Job): Promise<boolean> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`transfer:${job.id}`}, 0))`;
  job = await lockJob(tx, job.id);
  if (job.paymentState !== 'SETTLED') return false;
  assertPrice(job);
  if (!await hasFinancialHistory(tx, job, 'settled')) throw new BillingError('LEDGER_INVARIANT', 'Job has no backing settlement');
  const changed = await tx.job.updateMany({ where: { id: job.id, paymentState: 'SETTLED' }, data: { paymentState: 'REFUNDED' } });
  if (!changed.count) return false;
  await tx.wallet.update({ where: { userId: job.buyerId }, data: {
    availableMinor: { increment: job.buyerPriceMinor }, spentMinor: { decrement: job.buyerPriceMinor },
  } });
  await tx.wallet.update({ where: { userId: job.sellerId }, data: { earnedMinor: { decrement: job.sellerNetMinor } } });
  const transactionId = randomUUID();
  await tx.ledgerEntry.createMany({ data: [
    { operationKey: `job:${job.id}:refund`, transactionId, userId: job.buyerId, jobId: job.id,
      type: 'REFUND', amountMinor: job.buyerPriceMinor, availableDelta: job.buyerPriceMinor, spentDelta: -job.buyerPriceMinor },
    { operationKey: `job:${job.id}:earning-reversal`, transactionId, userId: job.sellerId, jobId: job.id,
      type: 'SELLER_EARNING_REVERSAL', amountMinor: -job.sellerNetMinor, earnedDelta: -job.sellerNetMinor },
    { operationKey: `job:${job.id}:fee-reversal`, transactionId, jobId: job.id, type: 'PLATFORM_FEE_REVERSAL', amountMinor: -job.platformFeeMinor },
  ] });
  await tx.sellerTransfer.updateMany({ where: { jobId: job.id, state: { not: 'NEEDS_RECONCILIATION' } }, data: { state: 'REVERSAL_PENDING', nextAttemptAt: new Date() } });
  return true;
}
