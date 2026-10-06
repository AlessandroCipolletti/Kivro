import { z } from 'zod';
import { json, type PaymentDispute, type Transaction } from '@kivro/database';
import { collectRefundDebt, type CanonicalDispute } from '@kivro/billing';
import { ApiError, requireValue } from './errors.js';
import { containJobExecution } from './job-containment.js';

export const disputeEventTypes = new Set(['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed',
  'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated']);
const activeStatuses = new Set(['needs_response', 'under_review', 'warning_needs_response', 'warning_under_review']);
const closedStatuses = new Set(['won', 'lost', 'warning_closed', 'prevented']);
const DisputeSchema = z.object({ id: z.string().min(1).max(255), amount: z.number().int().positive().max(100_000_000), currency: z.string().length(3),
  status: z.string().min(1).max(100), payment_intent: z.union([z.string(), z.object({ id: z.string() })]).nullable().optional() });
type Event = { id: string; type: string; created: number; livemode: boolean; data: { object: unknown } };

export async function lockPaymentIntent(tx: Transaction, id: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-intent:${id}`}, 0))`;
}

export function disputeBlockingReason(dispute: PaymentDispute): string | null {
  if (dispute.reviewRequired) return 'PROVIDER_REVIEW_REQUIRED';
  if (!dispute.closedStatus || dispute.closedEventCreated === null) return 'DISPUTE_OPEN';
  if (dispute.closedStatus === 'lost') return 'DISPUTE_LOST';
  if (['warning_closed', 'prevented'].includes(dispute.closedStatus)) {
    return dispute.withdrawnEventCreated === null ? null : 'UNEXPECTED_DISPUTE_WITHDRAWAL';
  }
  if (dispute.closedStatus !== 'won') return 'UNKNOWN_DISPUTE_OUTCOME';
  // Stripe snapshot timestamps have second precision; a tied debit/credit is ambiguous.
  if (dispute.reinstatedEventCreated === null || dispute.reinstatedEventCreated < dispute.closedEventCreated ||
    (dispute.withdrawnEventCreated !== null && dispute.reinstatedEventCreated <= dispute.withdrawnEventCreated)) return 'FUNDS_REINSTATEMENT_PENDING';
  if (dispute.withdrawnEventCreated !== null && dispute.withdrawnEventCreated >= dispute.closedEventCreated) return 'PROVIDER_REVIEW_REQUIRED';
  return null;
}

export async function synchronizeDisputeHold(tx: Transaction, topupId: string, eventId: string): Promise<void> {
  const topup = await tx.topup.findUniqueOrThrow({ where: { id: topupId } });
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-account:${topup.userId}`}, 0))`;
  if (topup.paymentIntentId) await tx.paymentDispute.updateMany({ where: { paymentIntentId: topup.paymentIntentId, livemode: topup.livemode, topupId: null }, data: { topupId } });
  await tx.paymentDispute.updateMany({ where: { topupId, OR: [{ amountMinor: { gt: topup.amountMinor } }, { currency: { not: 'usd' } }] }, data: { reviewRequired: true } });
  const disputes = await tx.paymentDispute.findMany({ where: { topupId }, orderBy: { id: 'asc' } });
  const blocking = disputes.filter(dispute => disputeBlockingReason(dispute));
  // An unexplained pre-migration hold never becomes permission to restore.
  if (!disputes.length) return;
  if (blocking.length) {
    const user = await tx.user.findUniqueOrThrow({ where: { id: topup.userId } });
    await tx.user.update({ where: { id: user.id }, data: { suspendedAt: user.suspendedAt ?? new Date() } });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await tx.apiKey.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.topup.update({ where: { id: topupId }, data: { disputedAt: topup.disputedAt ?? new Date(), state: 'DISPUTED' } });
    await containJobExecution(tx, { OR: [{ buyerId: user.id }, { sellerId: user.id }] }, 'Payment dispute requires account review');
    if (!topup.disputedAt) await tx.auditEvent.create({ data: { actorId: user.id, type: 'PAYMENT_DISPUTED', metadata: { stripeEventId: eventId, topupId, disputeIds: blocking.map(dispute => dispute.id) } } });
  } else {
    const credited = await tx.ledgerEntry.findUnique({ where: { operationKey: `stripe-topup:${topup.id}` } });
    const state = !credited ? 'PENDING' : topup.refundedMinor === topup.amountMinor ? 'REFUNDED' : topup.refundedMinor > 0 ? 'PARTIALLY_REFUNDED' : 'PAID';
    await tx.topup.update({ where: { id: topupId }, data: { disputedAt: null, state } });
    if (topup.disputedAt) await tx.auditEvent.create({ data: { type: 'PAYMENT_DISPUTE_HOLD_CLEARED', metadata: { stripeEventId: eventId, topupId, userId: topup.userId,
      disputeIds: disputes.map(dispute => dispute.id), accountRestored: false } } });
  }
  if (topup.paymentIntentId) await tx.billingEvent.updateMany({ where: { providerReference: topup.paymentIntentId, livemode: topup.livemode, outcome: 'PENDING', type: { in: [...disputeEventTypes] } }, data: { outcome: 'PROCESSED', processedAt: new Date() } });
}

export async function reconcileDisputeEvent(tx: Transaction, event: Event): Promise<string> {
  const parsed = DisputeSchema.safeParse(event.data.object);
  if (!parsed.success || !Number.isSafeInteger(event.created) || event.created < 0) throw new ApiError(400, 'INVALID_DISPUTE', 'Dispute identity, amount, status and provider time are required');
  const dispute = parsed.data;
  const paymentIntentId = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id;
  if (!paymentIntentId || !/^pi_[A-Za-z0-9_-]+$/.test(paymentIntentId)) throw new ApiError(400, 'INVALID_PAYMENT_REFERENCE', 'Dispute requires a payment intent reference');
  await lockPaymentIntent(tx, paymentIntentId);
  const topup = await tx.topup.findUnique({ where: { paymentIntentId } });
  const prior = await tx.paymentDispute.findUnique({ where: { id: dispute.id } });
  if (topup && topup.livemode !== event.livemode || prior && prior.livemode !== event.livemode) throw new ApiError(400, 'PAYMENT_MODE_MISMATCH', 'Dispute belongs to a different payment mode');
  if (prior && (prior.paymentIntentId !== paymentIntentId || prior.topupId && topup && prior.topupId !== topup.id)) throw new ApiError(400, 'PAYMENT_MISMATCH', 'Dispute reference changed');
  const terminal = event.type === 'charge.dispute.closed';
  if (terminal && !closedStatuses.has(dispute.status)) throw new ApiError(400, 'INVALID_DISPUTE_OUTCOME', 'Closed event must contain a terminal dispute status');
  let reviewRequired = prior?.reviewRequired ?? false;
  if ((!activeStatuses.has(dispute.status) && !closedStatuses.has(dispute.status)) || dispute.currency !== 'usd' ||
    topup && dispute.amount > topup.amountMinor || prior && (prior.amountMinor !== dispute.amount || prior.currency !== dispute.currency)) reviewRequired = true;
  let closedStatus = prior?.closedStatus ?? null, closedEventCreated = prior?.closedEventCreated ?? null;
  let ignored = false;
  if (terminal) {
    if (closedEventCreated === null || event.created > closedEventCreated && closedStatus === 'lost' && dispute.status === 'won') {
      closedStatus = dispute.status; closedEventCreated = event.created;
    } else if (event.created < closedEventCreated || closedStatus === dispute.status) ignored = true;
    else reviewRequired = true;
  } else if (prior?.closedStatus && activeStatuses.has(dispute.status)) {
    if (event.type === 'charge.dispute.updated' && event.created > prior.closedEventCreated!) reviewRequired = true;
    else if (event.type === 'charge.dispute.created' || event.type === 'charge.dispute.updated') ignored = true;
  }
  const maximum = (previous: number | null | undefined) => Math.max(previous ?? 0, event.created);
  // Check durable financial snapshots too, so reversed delivery cannot hide a new
  // loss behind an older won event. A later, separately proven lost-to-won is valid.
  if (closedStatus === 'won') {
    const evidence = await tx.billingEvent.findMany({ where: { providerReference: paymentIntentId, livemode: event.livemode,
      type: { in: ['charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated'] }, payload: { path: ['disputeId'], equals: dispute.id } }, select: { payload: true } });
    const snapshots = evidence.map(row => row.payload as { status?: string; eventCreated?: number });
    if (['charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated'].includes(event.type)) snapshots.push({ status: dispute.status, eventCreated: event.created });
    if (snapshots.some(snapshot => typeof snapshot.eventCreated !== 'number' || snapshot.eventCreated >= closedEventCreated! && snapshot.status !== 'won')) reviewRequired = true;
  }
  const data = { paymentIntentId, topupId: topup?.id ?? prior?.topupId ?? null, livemode: event.livemode,
    amountMinor: prior?.amountMinor ?? dispute.amount, currency: prior?.currency ?? dispute.currency,
    status: closedStatus ?? (event.created >= (prior?.lastEventCreated ?? 0) ? dispute.status : prior!.status),
    lastEventCreated: maximum(prior?.lastEventCreated), lastEventId: event.created >= (prior?.lastEventCreated ?? 0) ? event.id : prior!.lastEventId,
    closedStatus, closedEventCreated, reviewRequired,
    withdrawnEventCreated: event.type === 'charge.dispute.funds_withdrawn' ? maximum(prior?.withdrawnEventCreated) : prior?.withdrawnEventCreated ?? null,
    reinstatedEventCreated: event.type === 'charge.dispute.funds_reinstated' ? maximum(prior?.reinstatedEventCreated) : prior?.reinstatedEventCreated ?? null };
  const saved = await tx.paymentDispute.upsert({ where: { id: dispute.id }, create: { id: dispute.id, ...data }, update: data });
  const outcome = !topup ? 'PENDING' : reviewRequired ? 'REQUIRES_REVIEW' : ignored ? 'IGNORED_STALE' : 'PROCESSED';
  await tx.billingEvent.create({ data: { id: event.id, type: event.type, livemode: event.livemode, outcome, providerReference: paymentIntentId,
    payload: json({ disputeId: dispute.id, amountMinor: dispute.amount, currency: dispute.currency, status: dispute.status, eventCreated: event.created }), processedAt: topup ? new Date() : null } });
  if (topup) await synchronizeDisputeHold(tx, topup.id, event.id);
  await tx.auditEvent.create({ data: { type: 'DISPUTE_EVENT_RECONCILED', metadata: json({ stripeEventId: event.id, disputeId: dispute.id, paymentIntentId,
    topupId: topup?.id ?? null, previousStatus: prior?.closedStatus ?? prior?.status ?? null, status: saved.status, outcome, blockingReason: disputeBlockingReason(saved) }) } });
  return outcome;
}

export async function reconcileCanonicalDispute(tx: Transaction, dispute: CanonicalDispute, livemode: boolean, observationId: string): Promise<void> {
  await lockPaymentIntent(tx, dispute.paymentIntentId);
  const topup = requireValue(await tx.topup.findUnique({ where: { paymentIntentId: dispute.paymentIntentId } }));
  const prior = await tx.paymentDispute.findUnique({ where: { id: dispute.id } });
  if (topup.livemode !== livemode || dispute.amountMinor > topup.amountMinor || dispute.currency !== 'usd' || prior &&
    (prior.livemode !== livemode || prior.paymentIntentId !== dispute.paymentIntentId || prior.topupId && prior.topupId !== topup.id || prior.amountMinor !== dispute.amountMinor || prior.currency !== dispute.currency)) {
    throw new ApiError(409, 'PROVIDER_RECONCILIATION_MISMATCH', 'Canonical dispute does not match the original payment');
  }
  // A current object proves status, not when closure/withdrawal/reinstatement events occurred.
  // Preserve genuine event clocks and never manufacture evidence permitting restoration.
  const reviewRequired = prior?.reviewRequired || Boolean(prior?.closedStatus && prior.closedStatus !== dispute.status);
  await tx.paymentDispute.upsert({ where: { id: dispute.id }, create: {
    id: dispute.id, paymentIntentId: dispute.paymentIntentId, topupId: topup.id, livemode,
    amountMinor: dispute.amountMinor, currency: dispute.currency, status: dispute.status,
    lastEventId: observationId, lastEventCreated: 0, reviewRequired,
  }, update: { topupId: topup.id, status: prior?.closedStatus ?? dispute.status, reviewRequired } });
  const recorded = await tx.billingEvent.findUnique({ where: { id: observationId } });
  if (!recorded) {
    await tx.billingEvent.create({ data: { id: observationId, type: 'canonical.dispute', livemode, outcome: reviewRequired ? 'REQUIRES_REVIEW' : 'OBSERVED',
      providerReference: dispute.paymentIntentId, payload: json({ source: 'PROVIDER_READ', disputeId: dispute.id, status: dispute.status, amountMinor: dispute.amountMinor }) } });
    await tx.auditEvent.create({ data: { actorId: topup.userId, type: 'DISPUTE_CANONICALLY_RECONCILED', metadata: json({ topupId: topup.id, disputeId: dispute.id, status: dispute.status, reviewRequired, observationId }) } });
  }
  await synchronizeDisputeHold(tx, topup.id, observationId);
}

export async function restoreBillingAccount(tx: Transaction, userId: string, adminId: string, reason: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-account:${userId}`}, 0))`;
  const user = requireValue(await tx.user.findUnique({ where: { id: userId } }));
  const topups = await tx.topup.findMany({ where: { userId }, include: { disputes: true } });
  const unresolved = await tx.platformSetting.findFirst({ where: { key: { startsWith: 'billing-reconciliation:topup:' },
    AND: [{ value: { path: ['userId'], equals: userId } }, { value: { path: ['reviewRequired'], equals: true } }] } });
  if (unresolved) throw new ApiError(409, 'PROVIDER_REVIEW_REQUIRED', 'Canonical payment evidence needs operator reconciliation before restoration');
  const disputes = topups.flatMap(topup => topup.disputes);
  if (topups.some(topup => topup.disputedAt) || disputes.some(dispute => disputeBlockingReason(dispute))) throw new ApiError(409, 'DISPUTE_UNRESOLVED', 'Every dispute needs verified closure and any required reinstatement before restoration');
  const debt = topups.reduce((sum, topup) => sum + topup.refundDebtMinor, 0);
  if (await collectRefundDebt(tx, userId) > 0) throw new ApiError(409, 'REFUND_DEBT_OUTSTANDING', 'Refund shortfall must be resolved before restoring this account');
  if (!user.suspendedAt) return { userId, suspended: false, alreadyActive: true };
  await tx.user.update({ where: { id: userId }, data: { suspendedAt: null } });
  const audit = await tx.auditEvent.create({ data: { actorId: adminId, type: 'ACCOUNT_RESTORED', metadata: json({ userId, reason, previousSuspendedAt: user.suspendedAt.toISOString(),
    refundDebtCollectedMinor: debt, disputes: disputes.map(dispute => ({ id: dispute.id, closedStatus: dispute.closedStatus, closedEventCreated: dispute.closedEventCreated,
      reinstatedEventCreated: dispute.reinstatedEventCreated, lastEventId: dispute.lastEventId })), sessionsRestored: false, apiKeysRestored: false }) } });
  return { userId, suspended: false, restoredAt: audit.createdAt.toISOString(), auditId: audit.id };
}
