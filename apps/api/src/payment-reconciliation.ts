import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { json, serializable, type Transaction, type SellerTransfer } from '@kivro/database';
import { hashManifest } from '@kivro/contracts';
import { BillingError, readCheckoutPage, readTopup, readCompletedTransfer } from '@kivro/billing';
import type { ApiContext } from './context.js';
import { applyBillingObservation, finishBillingObservation } from './billing.js';
import { lockPaymentIntent, reconcileCanonicalDispute } from './disputes.js';
import { containJobExecution, releaseContainedJobs } from './job-containment.js';
import { failureCode } from './job-recovery.js';

const Scan = z.object({ token: z.string().nullable().default(null), leaseUntil: z.number().default(0), checkoutAfter: z.string().nullable().default(null),
  checkoutRetryAt: z.number().default(0), checkoutAttempts: z.number().default(0), topupAfter: z.string().nullable().default(null), transferAfter: z.string().nullable().default(null) });
const Progress = z.object({ userId: z.string().optional(), attempts: z.number().default(0), nextAttemptAt: z.number().default(0), lastError: z.string().nullable().default(null),
  lastVerifiedAt: z.string().nullable().default(null), disputeAfter: z.string().nullable().default(null), historyComplete: z.boolean().default(false),
  reviewRequired: z.boolean().default(false), reviewReason: z.string().nullable().default(null) });
type Lease = { key: string; token: string };
type ProgressState = z.infer<typeof Progress>;
class StaleLease extends Error {}
const topupKey = (id: string) => `billing-reconciliation:topup:${id}`;
const transferKey = (id: string) => `billing-reconciliation:transfer:${id}`;
const delay = (attempt: number) => Math.min(3600_000, 15_000 * 2 ** Math.min(attempt, 8));
const invalidCursor = (error: unknown) => Boolean(error && typeof error === 'object' && 'param' in error && error.param === 'starting_after');

async function fence(tx: Transaction, lease: Lease) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lease.key}, 0))`;
  const state = Scan.parse((await tx.platformSetting.findUniqueOrThrow({ where: { key: lease.key } })).value);
  if (state.token !== lease.token || state.leaseUntil <= Date.now()) throw new StaleLease('Reconciliation lease expired');
  return state;
}
async function checkpoint(ctx: ApiContext, lease: Lease, patch: Partial<z.infer<typeof Scan>>) {
  await serializable(ctx.db, async tx => {
    const state = await fence(tx, lease);
    await tx.platformSetting.update({ where: { key: lease.key }, data: { value: json({ ...state, ...patch }) } });
  });
}
async function progress(tx: Transaction, key: string) {
  return Progress.parse((await tx.platformSetting.findUnique({ where: { key } }))?.value ?? {});
}
async function saveProgress(tx: Transaction, key: string, state: ProgressState) {
  await tx.platformSetting.upsert({ where: { key }, create: { key, value: json(state) }, update: { value: json(state) } });
}

async function topupFailure(ctx: ApiContext, lease: Lease, id: string, code: string, review: boolean) {
  const affected = await serializable(ctx.db, async tx => {
    await fence(tx, lease);
    const topup = await tx.topup.findUniqueOrThrow({ where: { id } }), key = topupKey(id), previous = await progress(tx, key);
    const state = { ...previous, userId: topup.userId, attempts: previous.attempts + 1, nextAttemptAt: Date.now() + delay(previous.attempts), lastError: code,
      reviewRequired: previous.reviewRequired || review, reviewReason: review ? code : previous.reviewReason,
      ...(code === 'PROVIDER_CURSOR_INVALID' ? { disputeAfter: null } : {}) };
    await saveProgress(tx, key, state);
    if (review && (!previous.reviewRequired || previous.reviewReason !== code)) await tx.auditEvent.create({ data: { actorId: topup.userId,
      type: 'PAYMENT_RECONCILIATION_REQUIRED', metadata: { topupId: id, code, source: 'PROVIDER_READ' } } });
    if (!review || !await tx.ledgerEntry.findUnique({ where: { operationKey: `stripe-topup:${id}` } })) return [] as string[];
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-account:${topup.userId}`}, 0))`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: topup.userId } });
    await tx.user.update({ where: { id: user.id }, data: { suspendedAt: user.suspendedAt ?? new Date() } });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await tx.apiKey.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    return containJobExecution(tx, { OR: [{ buyerId: user.id }, { sellerId: user.id }] }, 'Canonical payment evidence requires operator review');
  });
  await releaseContainedJobs(ctx, affected);
}

async function discoverCheckouts(ctx: ApiContext, lease: Lease, state: z.infer<typeof Scan>) {
  if (state.checkoutRetryAt > Date.now()) return;
  try {
    // Refresh the head while advancing the backfill, so neither recent nor old lost responses starve.
    const head = await readCheckoutPage(ctx.billing!);
    const history = state.checkoutAfter ? await readCheckoutPage(ctx.billing!, state.checkoutAfter) : head;
    const sessions = [...new Map([...history.items, ...head.items].map(session => [session.id, session])).values()];
    for (const session of sessions) {
      if (session.mode !== 'payment' || !z.string().uuid().safeParse(session.metadata?.topupId).success) continue;
      const id = session.metadata!.topupId!;
      const conflict = await serializable(ctx.db, async tx => {
        await fence(tx, lease);
        const topup = await tx.topup.findUnique({ where: { id } });
        if (!topup || topup.livemode !== ctx.billing!.livemode) return false;
        if (topup.stripeSessionId && topup.stripeSessionId !== session.id) return session.payment_status === 'paid';
        if (session.metadata?.userId !== topup.userId || session.client_reference_id !== id || session.currency !== 'usd' || session.amount_total !== topup.amountMinor) return true;
        // This stores a candidate reference, not payment success. The complete chain is read before credit.
        if (!topup.stripeSessionId) await tx.topup.update({ where: { id }, data: { stripeSessionId: session.id } });
        return false;
      });
      if (conflict) await topupFailure(ctx, lease, id, 'CHECKOUT_DISCOVERY_CONFLICT', true);
    }
    await checkpoint(ctx, lease, { checkoutAfter: history.next, checkoutRetryAt: 0, checkoutAttempts: 0 });
    await serializable(ctx.db, async tx => {
      await fence(tx, lease);
      await tx.platformSetting.deleteMany({ where: { key: `${lease.key}:discovery-error` } });
    });
  } catch (error) {
    if (error instanceof StaleLease) throw error;
    await checkpoint(ctx, lease, { checkoutRetryAt: Date.now() + delay(state.checkoutAttempts), checkoutAttempts: state.checkoutAttempts + 1,
      ...(invalidCursor(error) ? { checkoutAfter: null } : {}) });
    await serializable(ctx.db, async tx => {
      await fence(tx, lease);
      const key = `${lease.key}:discovery-error`, value = { code: failureCode(error), at: new Date().toISOString() };
      await tx.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    });
  }
}

async function reconcileTopup(ctx: ApiContext, lease: Lease, id: string, previous: ProgressState) {
  const topup = await ctx.db.topup.findUniqueOrThrow({ where: { id } });
  const buyer = await ctx.db.user.findUniqueOrThrow({ where: { id: topup.userId } });
  const credited = Boolean(await ctx.db.ledgerEntry.findUnique({ where: { operationKey: `stripe-topup:${id}` } }));
  const snapshot = await readTopup(ctx.billing!, { id, userId: buyer.id, amountMinor: topup.amountMinor, sessionId: topup.stripeSessionId!,
    customerId: buyer.stripeCustomerId, paymentIntentId: topup.paymentIntentId, credited, disputeAfter: previous.disputeAfter });
  if (snapshot.charge && snapshot.charge.amount_refunded < topup.refundedMinor) throw new BillingError('PROVIDER_RECONCILIATION_MISMATCH', 'Provider refund regressed below committed evidence');
  const effects = await serializable(ctx.db, async tx => {
    await fence(tx, lease);
    const current = await tx.topup.findUniqueOrThrow({ where: { id } });
    const owner = await tx.user.findUniqueOrThrow({ where: { id: buyer.id } });
    if (current.stripeSessionId !== snapshot.session.id || current.amountMinor !== topup.amountMinor || current.userId !== buyer.id || current.livemode !== ctx.billing!.livemode ||
      owner.stripeCustomerId && owner.stripeCustomerId !== snapshot.customerId) throw new StaleLease('Payment binding changed during provider read');
    if (!owner.stripeCustomerId) await tx.user.update({ where: { id: owner.id }, data: { stripeCustomerId: snapshot.customerId } });
    const saved = await progress(tx, topupKey(id));
    if (!snapshot.charge) {
      await saveProgress(tx, topupKey(id), { ...saved, userId: buyer.id, attempts: 0, nextAttemptAt: Date.now() + 60_000, lastError: null, lastVerifiedAt: new Date().toISOString() });
      return [];
    }
    const intentId = typeof snapshot.session.payment_intent === 'string' ? snapshot.session.payment_intent : snapshot.session.payment_intent!.id;
    await lockPaymentIntent(tx, intentId);
    if (current.paymentIntentId && current.paymentIntentId !== intentId) throw new StaleLease('Payment binding changed during provider read');
    await tx.topup.update({ where: { id }, data: { paymentIntentId: intentId } });
    for (const dispute of snapshot.disputes) await reconcileCanonicalDispute(tx, dispute, ctx.billing!.livemode, `canonical:dispute:${dispute.id}:${hashManifest(dispute)}`);
    const result: Awaited<ReturnType<typeof applyBillingObservation>>[] = [];
    const base = { livemode: ctx.billing!.livemode, created: snapshot.session.created };
    // All observations commit together. No newly credited balance can escape a known refund/dispute.
    const hasCredit = Boolean(await tx.ledgerEntry.findUnique({ where: { operationKey: `stripe-topup:${id}` } }));
    if ((hasCredit || !saved.reviewRequired) && (snapshot.historyComplete || saved.historyComplete)) result.push(await applyBillingObservation(tx, { ...base, id: `canonical:checkout:${snapshot.session.id}`,
      type: 'checkout.session.completed', data: { object: snapshot.session } }));
    if (snapshot.charge.amount_refunded || current.refundedMinor) result.push(await applyBillingObservation(tx, { ...base,
      id: `canonical:refund:${snapshot.charge.id}:${snapshot.charge.amount_refunded}`, type: 'charge.refunded', data: { object: snapshot.charge } }));
    const heldJobs = await tx.job.findMany({ where: { OR: [{ buyerId: buyer.id }, { sellerId: buyer.id }], paymentState: 'RESERVED', executionRevokedAt: { not: null } }, select: { id: true } });
    result.push({ outcome: 'CANONICALLY_RECONCILED', jobIds: heldJobs.map(job => job.id), collectDebtFor: buyer.id });
    await saveProgress(tx, topupKey(id), { ...saved, userId: buyer.id, attempts: 0, nextAttemptAt: Date.now() + 60_000, lastError: null,
      lastVerifiedAt: new Date().toISOString(), disputeAfter: snapshot.disputeAfter, historyComplete: saved.historyComplete || snapshot.historyComplete });
    return result;
  });
  for (const effect of effects) await finishBillingObservation(ctx, effect);
}

function sameTransfer(current: SellerTransfer, observed: SellerTransfer) {
  return current.stripeTransferId === observed.stripeTransferId && current.destinationAccountId === observed.destinationAccountId &&
    current.amountMinor === observed.amountMinor && current.state === observed.state;
}
async function reconcileTransfer(ctx: ApiContext, lease: Lease, row: SellerTransfer) {
  const id = row.id;
  if (!row.stripeTransferId || !row.destinationAccountId) throw Object.assign(new Error('Missing immutable transfer reference'), { code: 'PROVIDER_RECONCILIATION_MISMATCH' });
  const observed = await readCompletedTransfer(ctx.billing!, { id: row.stripeTransferId, jobId: row.jobId, amountMinor: row.amountMinor, destination: row.destinationAccountId });
  await serializable(ctx.db, async tx => {
    await fence(tx, lease);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`transfer:${row.jobId}`}, 0))`;
    const current = await tx.sellerTransfer.findUniqueOrThrow({ where: { id } }), job = await tx.job.findUniqueOrThrow({ where: { id: row.jobId } });
    if (!sameTransfer(current, row)) throw new StaleLease('Transfer changed during provider read');
    const saved = await progress(tx, transferKey(id));
    const unexpected = !['SETTLED', 'REFUNDED'].includes(job.paymentState) || observed.amountReversedMinor > 0 && job.paymentState !== 'REFUNDED' ||
      observed.amountReversedMinor > 0 && !observed.reversed || current.state === 'REVERSED' && !observed.reversed ||
      current.state === 'TRANSFERRED' && job.paymentState === 'REFUNDED' && !observed.reversed;
    const state = unexpected ? 'NEEDS_RECONCILIATION' : observed.reversed && job.paymentState === 'REFUNDED' ? 'REVERSED' : current.state;
    const code = unexpected ? 'UNEXPECTED_PROVIDER_TRANSFER_REVERSAL' : null;
    await tx.sellerTransfer.update({ where: { id }, data: { state, lastError: code ?? (current.state === 'NEEDS_RECONCILIATION' ? current.lastError : null) } });
    if (unexpected && (!saved.reviewRequired || saved.reviewReason !== code)) await tx.auditEvent.create({ data: { sellerId: row.sellerId, jobId: row.jobId,
      type: 'TRANSFER_RECONCILIATION_REQUIRED', metadata: { transferId: id, stripeTransferId: observed.id, amountReversedMinor: observed.amountReversedMinor, code } } });
    await saveProgress(tx, transferKey(id), { ...saved, attempts: 0, nextAttemptAt: Date.now() + 60_000, lastError: null, lastVerifiedAt: new Date().toISOString(),
      reviewRequired: saved.reviewRequired || unexpected, reviewReason: code ?? saved.reviewReason });
  });
}

async function scanRows(ctx: ApiContext, lease: Lease, kind: 'topup' | 'transfer') {
  const state = await serializable(ctx.db, tx => fence(tx, lease)), cursorKey = kind === 'topup' ? 'topupAfter' : 'transferAfter';
  const query = (after: string | null) => kind === 'topup'
    ? ctx.db.topup.findMany({ where: { livemode: ctx.billing!.livemode, stripeSessionId: { not: null }, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 20, select: { id: true } })
    : ctx.db.sellerTransfer.findMany({ where: { state: { in: ['TRANSFERRED', 'REVERSED', 'NEEDS_RECONCILIATION'] }, stripeTransferId: { not: null }, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 20, select: { id: true } });
  let rows = await query(state[cursorKey]);
  if (!rows.length && state[cursorKey]) rows = await query(null);
  let worked = 0;
  for (const row of rows) {
    const key = kind === 'topup' ? topupKey(row.id) : transferKey(row.id), previous = Progress.parse((await ctx.db.platformSetting.findUnique({ where: { key } }))?.value ?? {});
    if (previous.nextAttemptAt <= Date.now()) {
      const transferBefore = kind === 'transfer' ? await ctx.db.sellerTransfer.findUniqueOrThrow({ where: { id: row.id } }) : null;
      try {
        if (kind === 'topup') await reconcileTopup(ctx, lease, row.id, previous);
        else await reconcileTransfer(ctx, lease, transferBefore!);
      } catch (error) {
        if (error instanceof StaleLease) throw error;
        const code = invalidCursor(error) ? 'PROVIDER_CURSOR_INVALID' : failureCode(error), review = ['PROVIDER_RECONCILIATION_MISMATCH', 'PAYMENT_MISMATCH', 'IDEMPOTENCY_CONFLICT', 'LEDGER_INVARIANT', 'P2002'].includes(code);
        if (kind === 'topup') await topupFailure(ctx, lease, row.id, code, review);
        else await serializable(ctx.db, async tx => {
          await fence(tx, lease);
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`transfer:${transferBefore!.jobId}`}, 0))`;
          const transfer = await tx.sellerTransfer.findUniqueOrThrow({ where: { id: row.id } });
          if (!sameTransfer(transfer, transferBefore!)) throw new StaleLease('Transfer changed during failed provider read');
          const current = await progress(tx, key);
          await saveProgress(tx, key, { ...current, attempts: current.attempts + 1, nextAttemptAt: Date.now() + delay(current.attempts), lastError: code,
            reviewRequired: current.reviewRequired || review, reviewReason: review ? code : current.reviewReason });
          if (review) {
            await tx.sellerTransfer.update({ where: { id: row.id }, data: { state: 'NEEDS_RECONCILIATION', lastError: code } });
            if (!current.reviewRequired || current.reviewReason !== code) await tx.auditEvent.create({ data: { sellerId: transfer.sellerId, jobId: transfer.jobId,
              type: 'TRANSFER_RECONCILIATION_REQUIRED', metadata: { transferId: row.id, code, source: 'PROVIDER_READ' } } });
          }
        });
      }
      worked++;
    }
    await checkpoint(ctx, lease, { [cursorKey]: row.id });
    if (worked >= (kind === 'topup' ? 2 : 1)) return;
  }
  if (rows.length < 20) await checkpoint(ctx, lease, { [cursorKey]: null });
}

export async function reconcilePayments(ctx: ApiContext): Promise<void> {
  if (!ctx.billing || ctx.config.paymentMode !== 'stripe') return;
  const key = `billing-reconciliation:${ctx.billing.livemode ? 'live' : 'test'}`;
  const claimed = await serializable(ctx.db, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    const state = Scan.parse((await tx.platformSetting.findUnique({ where: { key } }))?.value ?? {});
    if (state.token && state.leaseUntil > Date.now()) return null;
    const next = { ...state, token: randomUUID(), leaseUntil: Date.now() + 120_000 };
    await tx.platformSetting.upsert({ where: { key }, create: { key, value: json(next) }, update: { value: json(next) } });
    return next;
  });
  if (!claimed) return;
  const lease = { key, token: claimed.token };
  try {
    await discoverCheckouts(ctx, lease, claimed);
    await scanRows(ctx, lease, 'topup');
    await scanRows(ctx, lease, 'transfer');
  } catch (error) {
    if (!(error instanceof StaleLease)) throw error;
  } finally {
    await serializable(ctx.db, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      const state = Scan.parse((await tx.platformSetting.findUniqueOrThrow({ where: { key } })).value);
      if (state.token === lease.token) await tx.platformSetting.update({ where: { key }, data: { value: json({ ...state, token: null, leaseUntil: 0 }) } });
    });
  }
}
