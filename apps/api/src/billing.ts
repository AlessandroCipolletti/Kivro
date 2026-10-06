import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { serializable, json, type Transaction, type BillingEvent } from '@kivro/database';
import { hashManifest } from '@kivro/contracts';
import { creditWallet, refundJob, reconcileTopupRefund, collectRefundDebt, BillingError, SAVED_METHOD_CONSENT, type ProviderPayout } from '@kivro/billing';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiContext } from './context.js';
import { requireIdentity, requireAdmin } from './auth.js';
import { ApiError, requireValue } from './errors.js';
import { idempotencyKey, failJob, getJob } from './jobs.js';
import { activeStates } from './catalog.js';
import { containJobExecution, releaseContainedJobs } from './job-containment.js';
import { disputeEventTypes, lockPaymentIntent, reconcileDisputeEvent, synchronizeDisputeHold, restoreBillingAccount, disputeBlockingReason } from './disputes.js';

const METHOD_ENDPOINT = 'buyer-payment-methods';
const payoutEvents = new Set(['payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled']);
const PayoutReference = z.object({ sellerId: z.string().uuid(), accountId: z.string().regex(/^acct_[A-Za-z0-9]{1,200}$/), payoutId: z.string().regex(/^po_[A-Za-z0-9]{1,200}$/) }).strict();
const PayoutSync = z.object({ token: z.string().nullable().default(null), leaseUntil: z.number().default(0), nextAttemptAt: z.number().default(0),
  cursor: z.string().nullable().default(null), historyComplete: z.boolean().default(false), lastSyncedAt: z.string().nullable().default(null), lastError: z.string().nullable().default(null) });
const payoutKey = (livemode: boolean, accountId: string) => `payout-sync:${livemode ? 'live' : 'test'}:${accountId}`;
const payoutReference = (livemode: boolean, accountId: string, payoutId: string) => `${payoutKey(livemode, accountId)}:${payoutId}`;

async function storePayout(tx: Transaction, sellerId: string, accountId: string, livemode: boolean, payout: ProviderPayout, now: Date) {
  const where = { livemode_stripeAccountId_stripePayoutId: { livemode, stripeAccountId: accountId, stripePayoutId: payout.id } };
  const previous = await tx.payoutRecord.findUnique({ where });
  if (previous && (previous.sellerId !== sellerId || previous.amountMinor !== payout.amountMinor || previous.currency !== payout.currency ||
    previous.providerCreatedAt.getTime() !== payout.providerCreatedAt.getTime())) throw new BillingError('PAYOUT_IMMUTABLE_MISMATCH', 'Payout identity or amount changed');
  const data = { status: payout.status, arrivalDate: payout.arrivalDate, failureCode: payout.failureCode,
    paidAt: payout.status === 'paid' ? previous?.paidAt ?? now : null, lastSyncedAt: now };
  await tx.payoutRecord.upsert({ where, create: { sellerId, stripeAccountId: accountId, stripePayoutId: payout.id, livemode,
    amountMinor: payout.amountMinor, currency: payout.currency, providerCreatedAt: payout.providerCreatedAt, ...data }, update: data });
  if (!previous || previous.status !== payout.status || previous.failureCode !== payout.failureCode) {
    await tx.auditEvent.create({ data: { sellerId, type: 'SELLER_PAYOUT_RECONCILED', metadata: { stripePayoutId: payout.id, stripeAccountId: accountId,
      livemode, amountMinor: payout.amountMinor, currency: payout.currency, previousStatus: previous?.status ?? null, status: payout.status, failureCode: payout.failureCode } } });
  }
}

/** Fence provider reads with a durable account lease; never hold a DB transaction across Stripe I/O. */
async function synchronizePayoutAccount(ctx: ApiContext, sellerId: string, accountId: string, payoutId?: string): Promise<void> {
  const billing = ctx.billing!;
  const key = payoutKey(billing.livemode, accountId), token = randomUUID();
  const lease = await serializable(ctx.db, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    if (!await tx.user.findFirst({ where: { id: sellerId, stripeConnectedAccountId: accountId } })) return null;
    const saved = await tx.platformSetting.findUnique({ where: { key } });
    const state = PayoutSync.parse(saved?.value ?? {});
    if (state.leaseUntil > Date.now() || state.nextAttemptAt > Date.now()) return null;
    state.token = token; state.leaseUntil = Date.now() + 60_000;
    await tx.platformSetting.upsert({ where: { key }, create: { key, value: json(state) }, update: { value: json(state) } });
    const events = payoutId ? await tx.billingEvent.findMany({ where: { providerReference: payoutReference(billing.livemode, accountId, payoutId), outcome: 'PAYOUT_PENDING', livemode: billing.livemode }, select: { id: true }, take: 100 }) : [];
    return { state, eventIds: events.map(event => event.id) };
  });
  if (!lease) return;
  try {
    const owner = { sellerId, accountId };
    let payouts: ProviderPayout[], cursor = lease.state.cursor;
    if (payoutId) payouts = [await billing.payout({ ...owner, payoutId })];
    else {
      const head = await billing.payouts(owner);
      // Refresh the head while a durable second cursor eventually revisits all older payouts.
      const tail = cursor ? await billing.payouts({ ...owner, after: cursor }) : head;
      payouts = [...new Map([...head.items, ...tail.items].map(payout => [payout.id, payout])).values()];
      cursor = tail.nextCursor;
    }
    await serializable(ctx.db, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      const current = PayoutSync.parse((await tx.platformSetting.findUniqueOrThrow({ where: { key } })).value);
      if (current.token !== token || current.leaseUntil <= Date.now()) return;
      if (!await tx.user.findFirst({ where: { id: sellerId, stripeConnectedAccountId: accountId } })) throw new BillingError('PAYOUT_ACCOUNT_MISMATCH', 'Seller account binding changed');
      const now = new Date();
      for (const payout of payouts) await storePayout(tx, sellerId, accountId, billing.livemode, payout, now);
      if (lease.eventIds.length) await tx.billingEvent.updateMany({ where: { id: { in: lease.eventIds }, outcome: 'PAYOUT_PENDING' }, data: { outcome: 'PAYOUT_RECONCILED', processedAt: now } });
      await tx.platformSetting.update({ where: { key }, data: { value: json({ ...current, token: null, leaseUntil: 0, cursor,
        historyComplete: current.historyComplete || (!payoutId && !cursor),
        nextAttemptAt: payoutId ? 0 : Date.now() + 60_000, lastSyncedAt: now.toISOString(), lastError: null }) } });
    });
  } catch (error) {
    await serializable(ctx.db, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      const current = PayoutSync.parse((await tx.platformSetting.findUniqueOrThrow({ where: { key } })).value);
      if (current.token !== token) return;
      const code = error instanceof BillingError ? error.code : 'PAYOUT_PROVIDER_UNAVAILABLE';
      await tx.platformSetting.update({ where: { key }, data: { value: json({ ...current, token: null, leaseUntil: 0, nextAttemptAt: Date.now() + 60_000, lastError: code }) } });
      if (current.lastError !== code) await tx.auditEvent.create({ data: { sellerId, type: 'SELLER_PAYOUT_RECONCILIATION_FAILED', metadata: { stripeAccountId: accountId, livemode: billing.livemode, code } } });
    });
  }
}

/** Bounded, fair recovery of missed webhooks and old status changes, including paid -> failed. */
export async function reconcilePayouts(ctx: ApiContext): Promise<void> {
  if (ctx.config.paymentMode !== 'stripe' || !ctx.billing) return;
  const livemode = ctx.billing.livemode;
  const selected = await serializable(ctx.db, async tx => {
    const key = `payout-scan:${livemode ? 'live' : 'test'}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    const saved = await tx.platformSetting.findUnique({ where: { key } });
    const state = z.object({ event: z.string().default(''), seller: z.string().default('') }).parse(saved?.value ?? {});
    const eventQuery = (after: string) => tx.billingEvent.findMany({ where: { outcome: 'PAYOUT_PENDING', livemode, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 2 });
    let events = await eventQuery(state.event); if (!events.length && state.event) events = await eventQuery('');
    const sellerQuery = (after: string) => tx.user.findMany({ where: { stripeConnectedAccountId: { not: null }, ...(after ? { id: { gt: after } } : {}) }, select: { id: true, stripeConnectedAccountId: true }, orderBy: { id: 'asc' }, take: 1 });
    let sellers = await sellerQuery(state.seller); if (!sellers.length && state.seller) sellers = await sellerQuery('');
    await tx.platformSetting.upsert({ where: { key }, create: { key, value: { event: events.at(-1)?.id ?? '', seller: sellers.at(-1)?.id ?? '' } }, update: { value: { event: events.at(-1)?.id ?? '', seller: sellers.at(-1)?.id ?? '' } } });
    return { events, sellers };
  });
  for (const event of selected.events) {
    const reference = PayoutReference.safeParse(event.payload);
    if (!reference.success) continue;
    await synchronizePayoutAccount(ctx, reference.data.sellerId, reference.data.accountId, reference.data.payoutId);
  }
  for (const seller of selected.sellers) await synchronizePayoutAccount(ctx, seller.id, seller.stripeConnectedAccountId!);
}

async function acceptPayoutEvent(ctx: ApiContext, event: ReturnType<NonNullable<ApiContext['billing']>['verifyWebhook']>) {
  const object = event.data.object as { id?: string; object?: string };
  if (object.object !== 'payout' || !z.string().regex(/^po_[A-Za-z0-9]{1,200}$/).safeParse(object.id).success) throw new ApiError(400, 'INVALID_PAYOUT_REFERENCE', 'Payout event requires a payout reference');
  const accepted = await serializable(ctx.db, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${event.id}, 0))`;
    const previous = await tx.billingEvent.findUnique({ where: { id: event.id } });
    if (previous) return previous;
    const seller = event.account ? await tx.user.findUnique({ where: { stripeConnectedAccountId: event.account } }) : null;
    const reference = seller ? PayoutReference.parse({ sellerId: seller.id, accountId: event.account, payoutId: object.id }) : null;
    return tx.billingEvent.create({ data: { id: event.id, type: event.type, livemode: event.livemode,
      outcome: reference ? 'PAYOUT_PENDING' : 'IGNORED_PAYOUT_ACCOUNT', processedAt: reference ? null : new Date(),
      ...(reference ? { payload: reference, providerReference: payoutReference(event.livemode, reference.accountId, reference.payoutId) } : {}) } });
  });
  const reference = PayoutReference.safeParse(accepted.payload);
  if (accepted.outcome === 'PAYOUT_PENDING' && reference.success) await synchronizePayoutAccount(ctx, reference.data.sellerId, reference.data.accountId, reference.data.payoutId);
  return { received: true, outcome: (await ctx.db.billingEvent.findUniqueOrThrow({ where: { id: event.id } })).outcome };
}

const payoutSelect = { id: true, amountMinor: true, currency: true, status: true, providerCreatedAt: true, arrivalDate: true, paidAt: true, failureCode: true, lastSyncedAt: true } as const;
async function sellerPayouts(ctx: ApiContext, sellerId: string, accountId: string | null, after?: string, db: Transaction = ctx.db) {
  const reason = methodAvailability(ctx) ?? (!accountId ? 'CONNECT_NOT_CONFIGURED' : null);
  if (reason) return { available: false, reason, items: [], hasMore: false, nextCursor: null };
  const where = { sellerId, stripeAccountId: accountId!, livemode: ctx.billing!.livemode };
  if (after) requireValue(await db.payoutRecord.findFirst({ where: { ...where, id: after }, select: { id: true } }));
  const rows = await db.payoutRecord.findMany({ where, select: payoutSelect, orderBy: [{ providerCreatedAt: 'desc' }, { id: 'desc' }], take: 21, ...(after ? { cursor: { id: after }, skip: 1 } : {}) });
  const items = rows.slice(0, 20);
  return { available: true, reason: null, items, hasMore: rows.length > 20, nextCursor: rows.length > 20 ? items.at(-1)!.id : null };
}
const MethodId = z.string().regex(/^pm_[A-Za-z0-9]{1,200}$/);
const MethodOperation = z.object({
  state: z.enum(['PENDING', 'DONE', 'FAILED']), action: z.enum(['setup', 'default', 'remove']),
  methodId: MethodId.optional(), consentVersion: z.string().optional(), customerId: z.string().optional(),
  authorized: z.boolean().default(false), leaseUntil: z.number(), result: z.record(z.unknown()).optional(),
  error: z.object({ status: z.number(), code: z.string() }).optional(),
});
type MethodProgress = z.infer<typeof MethodOperation>;
const pendingDto = (key: string, progress: MethodProgress) => ({ key, action: progress.action, paymentMethodId: progress.methodId ?? null,
  consentVersion: progress.consentVersion ?? null, retryAfter: new Date(progress.leaseUntil).toISOString() });
const methodAvailability = (ctx: ApiContext) => ctx.config.paymentMode !== 'stripe' ? 'DEVELOPMENT_PAYMENTS' : !ctx.billing ? 'STRIPE_NOT_CONFIGURED' : null;
function requireStripe(ctx: ApiContext) {
  const reason = methodAvailability(ctx);
  if (reason) throw new ApiError(503, reason, 'Saved payment methods and provider receipts require Stripe');
  return ctx.billing!;
}
function providerReadError(error: unknown): never {
  if (error instanceof BillingError) throw new ApiError(404, error.code, error.message);
  if ((error as { code?: unknown })?.code === 'resource_missing') throw new ApiError(404, 'PAYMENT_METHOD_UNAVAILABLE', 'The provider resource is unavailable');
  throw new ApiError(503, 'BILLING_PROVIDER_UNAVAILABLE', 'Stripe is temporarily unavailable');
}

/** Commit consent/intent before Stripe I/O; retry the same persisted key after an uncertain outcome. */
async function changeSavedMethod(ctx: ApiContext, request: FastifyRequest, action: MethodProgress['action'], methodId?: string) {
  const { user } = requireIdentity(request); // No API-key scope authorizes billing profile changes.
  const billing = requireStripe(ctx), key = idempotencyKey(request);
  const body = action === 'setup' ? z.object({ consentAccepted: z.literal(true), consentVersion: z.literal(SAVED_METHOD_CONSENT.version) }).strict().parse(request.body)
    : z.object({}).strict().parse(request.body ?? {});
  const fingerprint = hashManifest({ action, methodId, body });
  const acquired = await serializable(ctx.db, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`buyer-methods:${user.id}`}, 0))`;
    const current = requireValue(await tx.user.findUnique({ where: { id: user.id } }));
    if (current.suspendedAt) throw new ApiError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended');
    const where = { userId_endpoint_key: { userId: user.id, endpoint: METHOD_ENDPOINT, key } };
    const previous = await tx.idempotencyRecord.findUnique({ where });
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to another billing operation');
      const progress = MethodOperation.parse(previous.response);
      if (progress.state !== 'PENDING') return { record: previous, progress };
      if (Date.now() - previous.createdAt.getTime() >= 20 * 3600_000) throw new ApiError(409, 'BILLING_RECONCILIATION_REQUIRED', 'An uncertain operation must be reconciled before another provider mutation');
      if (progress.leaseUntil > Date.now()) throw new ApiError(409, 'BILLING_OPERATION_PENDING', 'This operation is still running', pendingDto(key, progress));
      progress.leaseUntil = Date.now() + 10 * 60_000;
      await tx.idempotencyRecord.update({ where, data: { response: json(progress) } });
      return { record: previous, progress };
    }
    const pending = await tx.idempotencyRecord.findFirst({ where: { userId: user.id, endpoint: METHOD_ENDPOINT, response: { path: ['state'], equals: 'PENDING' } } });
    if (pending) throw new ApiError(409, 'BILLING_OPERATION_PENDING', 'Retry the pending billing operation first', pendingDto(pending.key, MethodOperation.parse(pending.response)));
    const progress: MethodProgress = { state: 'PENDING', action, methodId, authorized: false, leaseUntil: Date.now() + 10 * 60_000,
      ...(action === 'setup' ? { consentVersion: SAVED_METHOD_CONSENT.version } : {}) };
    const record = await tx.idempotencyRecord.create({ data: { userId: user.id, endpoint: METHOD_ENDPOINT, key, fingerprint, response: json(progress) } });
    await tx.auditEvent.create({ data: { actorId: user.id, type: action === 'setup' ? 'BUYER_SAVED_METHOD_CONSENT' : 'BUYER_PAYMENT_METHOD_CHANGE_REQUESTED',
      metadata: json({ operationId: record.id, action, paymentMethodId: methodId, ...(action === 'setup' ? { consentVersion: SAVED_METHOD_CONSENT.version, consentAccepted: true } : {}) }) } });
    return { record, progress };
  });
  const { record, progress } = acquired;
  if (progress.state === 'FAILED') throw new ApiError(progress.error!.status, progress.error!.code, 'This billing operation was rejected; use a new key after correcting the problem');
  if (progress.state === 'DONE') {
    if (action === 'setup' && Date.parse(String(progress.result?.expiresAt)) <= Date.now()) throw new ApiError(410, 'SETUP_SESSION_EXPIRED', 'Start a new setup session');
    return progress.result;
  }
  const checkpoint = async () => { await ctx.db.idempotencyRecord.update({ where: { id: record.id }, data: { response: json(progress) } }); };
  try {
    const current = requireValue(await ctx.db.user.findUnique({ where: { id: user.id } }));
    if (current.suspendedAt) throw new ApiError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended');
    if (!progress.customerId) {
      if (action !== 'setup' && !current.stripeCustomerId) throw new ApiError(404, 'PAYMENT_METHOD_UNAVAILABLE', 'No saved payment method is available');
      progress.customerId = await billing.ensureCustomer({ userId: user.id, email: current.email, customerId: current.stripeCustomerId });
      const saved = await ctx.db.user.updateMany({ where: { id: user.id, OR: [{ stripeCustomerId: null }, { stripeCustomerId: progress.customerId }] }, data: { stripeCustomerId: progress.customerId } });
      if (saved.count !== 1) throw new ApiError(409, 'PAYMENT_CUSTOMER_CHANGED', 'The customer binding changed');
      await checkpoint();
    }
    if (current.stripeCustomerId && current.stripeCustomerId !== progress.customerId) throw new ApiError(409, 'PAYMENT_CUSTOMER_CHANGED', 'The customer binding changed');
    const owner = { userId: user.id, customerId: progress.customerId };
    if (!progress.authorized) {
      await billing.ownedCustomer(owner);
      if (methodId) await billing.ownedPaymentMethod(owner, methodId);
      progress.authorized = true; await checkpoint();
    }
    if (action === 'setup') progress.result = await billing.setupCheckout({ ...owner, operationId: record.id, webOrigin: ctx.config.webOrigin, expiresAt: Math.floor(record.createdAt.getTime() / 1000) + 24 * 3600 });
    else {
      const change = { ...owner, paymentMethodId: methodId!, idempotencyKey: `saved-method:${record.id}` };
      if (action === 'default') await billing.setDefaultPaymentMethod(change);
      else await billing.removePaymentMethod(change, progress.authorized);
      progress.result = { ok: true };
    }
    progress.state = 'DONE'; progress.leaseUntil = 0;
    await serializable(ctx.db, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`buyer-methods:${user.id}`}, 0))`;
      const current = await tx.idempotencyRecord.findUniqueOrThrow({ where: { id: record.id } });
      if (MethodOperation.parse(current.response).state === 'DONE') return;
      await tx.idempotencyRecord.update({ where: { id: record.id }, data: { response: json(progress) } });
      await tx.auditEvent.create({ data: { actorId: user.id, type: 'BUYER_PAYMENT_METHOD_OPERATION_COMPLETED', metadata: json({ operationId: record.id, action, paymentMethodId: methodId }) } });
    });
    return progress.result;
  } catch (error) {
    // A lost commit acknowledgement must not turn an already completed operation back into pending.
    const persisted = MethodOperation.parse((await ctx.db.idempotencyRecord.findUniqueOrThrow({ where: { id: record.id } })).response);
    if (persisted.state === 'DONE') return persisted.result;
    const denied = !progress.authorized && (error instanceof BillingError || error instanceof ApiError || (error as { code?: string })?.code === 'resource_missing');
    progress.state = denied ? 'FAILED' : 'PENDING'; progress.leaseUntil = 0;
    if (denied) progress.error = { status: error instanceof ApiError ? error.statusCode : 404, code: error instanceof ApiError || error instanceof BillingError ? error.code : 'PAYMENT_METHOD_UNAVAILABLE' };
    await checkpoint();
    if (denied) throw new ApiError(progress.error!.status, progress.error!.code, 'Saved payment method operation was not authorized');
    throw new ApiError(503, 'BILLING_PROVIDER_UNCERTAIN', 'Retry this operation with the same idempotency key; no new operation has been authorized', pendingDto(key, progress));
  }
}

const RefundReceipt = z.object({ topupId: z.string().uuid(), userId: z.string().uuid() });

// Return effects from the committed transaction only. Replays use the durable
// receipt, never a new delivery's object, to resume interrupted financial cleanup.
async function billingContainmentEffects(tx: Transaction, receipt: BillingEvent) {
  const empty = { outcome: receipt.outcome, jobIds: [] as string[], collectDebtFor: null as string | null };
  if (!receipt.providerReference) return empty;
  const dispute = disputeEventTypes.has(receipt.type);
  const refund = receipt.type === 'charge.refunded';
  const checkout = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(receipt.type);
  if (!dispute && !refund && !checkout) return empty;
  const topup = await tx.topup.findUnique({ where: { paymentIntentId: receipt.providerReference } });
  if (!topup) {
    if (dispute && receipt.outcome === 'PENDING') return empty;
    throw new ApiError(409, 'PAYMENT_MISMATCH', 'Stored payment reference no longer matches a topup');
  }
  if (topup.livemode !== receipt.livemode) throw new ApiError(409, 'PAYMENT_MODE_MISMATCH', 'Stored payment mode changed');
  if (dispute) {
    const reference = z.object({ disputeId: z.string() }).parse(receipt.payload);
    const saved = await tx.paymentDispute.findUnique({ where: { id: reference.disputeId } });
    if (!saved || saved.paymentIntentId !== receipt.providerReference || saved.topupId !== topup.id || saved.livemode !== receipt.livemode) {
      throw new ApiError(409, 'PAYMENT_MISMATCH', 'Stored dispute binding changed');
    }
  } else {
    const reference = RefundReceipt.parse(receipt.payload);
    if (reference.topupId !== topup.id || reference.userId !== topup.userId) throw new ApiError(409, 'PAYMENT_MISMATCH', 'Stored refund binding changed');
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-account:${topup.userId}`}, 0))`;
  const jobs = await tx.job.findMany({ where: { OR: [{ buyerId: topup.userId }, { sellerId: topup.userId }],
    paymentState: 'RESERVED', executionRevokedAt: { not: null } }, select: { id: true }, orderBy: { id: 'asc' } });
  return { outcome: receipt.outcome, jobIds: jobs.map(job => job.id), collectDebtFor: dispute ? null : topup.userId };
}

// Internal only: callers authenticate signatures or validate canonical provider reads.
type ProviderEvent = ReturnType<NonNullable<ApiContext['billing']>['verifyWebhook']>;
export type BillingObservation<T = ProviderEvent> = T extends ProviderEvent ? Pick<T, 'id' | 'type' | 'created' | 'livemode' | 'data'> : never;
export async function applyBillingObservation(tx: Transaction, event: BillingObservation) {
  let outcome = 'PROCESSED', providerReference: string | null = null;
  let reference: z.infer<typeof RefundReceipt> | null = null;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${event.id}, 0))`;
  const previous = await tx.billingEvent.findUnique({ where: { id: event.id } });
  if (previous) {
    if (previous.type !== event.type || previous.livemode !== event.livemode) throw new ApiError(400, 'PAYMENT_MISMATCH', 'Stored event identity changed');
    return billingContainmentEffects(tx, previous);
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    if (session.mode === 'setup') {
      const operationId = z.string().uuid().parse(session.metadata?.operationId);
      const operation = requireValue(await tx.idempotencyRecord.findFirst({ where: { id: operationId, endpoint: METHOD_ENDPOINT } }));
      const progress = MethodOperation.parse(operation.response);
      const customer = typeof session.customer === 'string' ? session.customer : session.customer?.id;
      const setupIntent = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id;
      if (progress.action !== 'setup' || !progress.authorized || session.metadata?.purpose !== 'saved_payment_method' ||
        session.metadata.userId !== operation.userId || session.metadata.consentVersion !== progress.consentVersion || customer !== progress.customerId ||
        session.client_reference_id !== operation.id || session.payment_status !== 'no_payment_required' || session.status !== 'complete' || !setupIntent ||
        (progress.result?.id && progress.result.id !== session.id)) throw new ApiError(400, 'PAYMENT_SETUP_MISMATCH', 'Setup does not match the consented operation');
      const owner = requireValue(await tx.user.findUnique({ where: { id: operation.userId } }));
      if (owner.stripeCustomerId !== customer) throw new ApiError(400, 'PAYMENT_SETUP_MISMATCH', 'Setup customer binding changed');
      const prior = await tx.auditEvent.findFirst({ where: { type: 'BUYER_PAYMENT_METHOD_SETUP_COMPLETED', metadata: { path: ['sessionId'], equals: session.id } } });
      if (!prior) await tx.auditEvent.create({ data: { actorId: owner.id, type: 'BUYER_PAYMENT_METHOD_SETUP_COMPLETED',
        metadata: { operationId, sessionId: session.id, setupIntentId: setupIntent, customerId: customer!, consentVersion: progress.consentVersion! } } });
      outcome = 'SETUP_COMPLETED';
    } else if (session.payment_status === 'paid') {
      const topupId = session.metadata?.topupId;
      if (!topupId) throw new ApiError(400, 'INVALID_PAYMENT_REFERENCE', 'Stripe payment does not reference a topup');
      const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
      if (!paymentIntentId || !/^pi_[A-Za-z0-9_-]+$/.test(paymentIntentId)) throw new ApiError(400, 'INVALID_PAYMENT_REFERENCE', 'Paid checkout requires a payment intent reference');
      await lockPaymentIntent(tx, paymentIntentId);
      const topup = requireValue(await tx.topup.findUnique({ where: { id: topupId } }));
      if (topup.paymentIntentId && topup.paymentIntentId !== paymentIntentId) throw new ApiError(400, 'PAYMENT_MISMATCH', 'Topup payment intent changed');
      if (topup.livemode !== event.livemode || session.currency !== 'usd' || session.amount_total !== topup.amountMinor || session.metadata?.userId !== topup.userId || (topup.stripeSessionId && topup.stripeSessionId !== session.id)) throw new ApiError(400, 'PAYMENT_MISMATCH', 'Stripe amount, mode or payment reference does not match');
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-account:${topup.userId}`}, 0))`;
          const review = (await tx.platformSetting.findUnique({ where: { key: `billing-reconciliation:topup:${topup.id}` } }))?.value as { reviewRequired?: boolean } | undefined;
          if (review?.reviewRequired && !await tx.ledgerEntry.findUnique({ where: { operationKey: `stripe-topup:${topup.id}` } })) {
            throw new ApiError(409, 'PROVIDER_REVIEW_REQUIRED', 'Ambiguous payment evidence must be reviewed before credit');
          }
          await creditWallet(tx, topup.userId, topup.amountMinor, `stripe-topup:${topup.id}`);
      await tx.topup.update({ where: { id: topup.id }, data: { state: 'PAID', stripeSessionId: session.id,
        paymentIntentId } });
      await reconcileTopupRefund(tx, topup.id, topup.refundedMinor);
      // Link and enforce every durable case atomically with credit. Never
      // recreate a hold merely because an old created event was processed.
      await synchronizeDisputeHold(tx, topup.id, event.id);
      providerReference = paymentIntentId; reference = { topupId: topup.id, userId: topup.userId };
    }
  } else if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
    if (!paymentIntentId || !/^pi_[A-Za-z0-9_-]+$/.test(paymentIntentId) || !/^ch_[A-Za-z0-9_-]+$/.test(charge.id)) throw new ApiError(400, 'INVALID_PAYMENT_REFERENCE', 'Refund requires charge and payment intent references');
    const metadataTopupId = charge.metadata?.topupId;
    if (metadataTopupId !== undefined && !z.string().uuid().safeParse(metadataTopupId).success) throw new ApiError(400, 'INVALID_PAYMENT_REFERENCE', 'Refund topup reference is invalid');
    await lockPaymentIntent(tx, paymentIntentId);
    const bound = await tx.topup.findUnique({ where: { paymentIntentId } });
    if (bound && metadataTopupId !== undefined && metadataTopupId !== bound.id) throw new ApiError(400, 'PAYMENT_MISMATCH', 'Refund topup references conflict');
    const topup = bound ?? (metadataTopupId ? await tx.topup.findUnique({ where: { id: metadataTopupId } }) : null);
    if (!topup) throw new ApiError(503, 'PAYMENT_NOT_RECONCILED', 'The original payment must be reconciled before its refund');
    if (topup.livemode !== event.livemode || charge.currency !== 'usd' || charge.amount !== topup.amountMinor || (topup.paymentIntentId && topup.paymentIntentId !== paymentIntentId) ||
      (charge.metadata?.userId !== undefined && charge.metadata.userId !== topup.userId)) throw new ApiError(400, 'PAYMENT_MISMATCH', 'Refund amount, mode or payment reference does not match');
    if (!Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0 || charge.amount_refunded > topup.amountMinor) throw new ApiError(400, 'INVALID_REFUND', 'Cumulative refund must be an integer within the original payment');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-account:${topup.userId}`}, 0))`;
    await tx.topup.update({ where: { id: topup.id }, data: { paymentIntentId } });
    const wallet = await tx.wallet.findUnique({ where: { userId: topup.userId } });
    const credited = await tx.ledgerEntry.findUnique({ where: { operationKey: `stripe-topup:${topup.id}` } });
    if (credited && (wallet?.availableMinor ?? 0) < charge.amount_refunded - topup.refundAppliedMinor) {
      const user = await tx.user.findUniqueOrThrow({ where: { id: topup.userId } });
      await tx.user.update({ where: { id: user.id }, data: { suspendedAt: user.suspendedAt ?? new Date() } });
      await tx.session.deleteMany({ where: { userId: user.id } });
      await tx.apiKey.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await containJobExecution(tx, { OR: [{ buyerId: user.id }, { sellerId: user.id }] }, 'Payment refund requires account review');
    }
    await reconcileTopupRefund(tx, topup.id, charge.amount_refunded);
    await synchronizeDisputeHold(tx, topup.id, event.id);
    await tx.auditEvent.create({ data: { actorId: topup.userId, type: 'TOPUP_REFUND_RECONCILED', metadata: { stripeEventId: event.id, topupId: topup.id, cumulativeRefundMinor: charge.amount_refunded } } });
    providerReference = paymentIntentId; reference = { topupId: topup.id, userId: topup.userId };
  } else if (event.type === 'account.updated') {
    const account = event.data.object;
    const ready = account.payouts_enabled && account.capabilities?.transfers === 'active' && !account.requirements?.disabled_reason;
    const key = `connect-event:${event.livemode ? 'live' : 'test'}:${account.id}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    const prior = await tx.platformSetting.findUnique({ where: { key } });
    const cursor = prior?.value as { created: number; ready: boolean } | undefined;
    // Stripe events can arrive out of order. A same-second restriction wins
    // because provider timestamps cannot establish a safe ordering there.
    if (!cursor || event.created > cursor.created || (event.created === cursor.created && (!ready || cursor.ready))) {
      await tx.user.updateMany({ where: { stripeConnectedAccountId: account.id }, data: { payoutsEnabled: account.payouts_enabled, connectStatus: ready ? 'READY' : 'ACTION_REQUIRED' } });
      await tx.platformSetting.upsert({ where: { key }, create: { key, value: { created: event.created, ready } }, update: { value: { created: event.created, ready } } });
    } else outcome = 'IGNORED_STALE';
  } else if (disputeEventTypes.has(event.type)) {
    await reconcileDisputeEvent(tx, event);
    return billingContainmentEffects(tx, await tx.billingEvent.findUniqueOrThrow({ where: { id: event.id } }));
  } else outcome = 'UNHANDLED';
  const receipt = await tx.billingEvent.create({ data: { id: event.id, type: event.type, livemode: event.livemode, outcome, providerReference,
    ...(reference ? { payload: json(reference) } : {}) } });
  if (outcome === 'UNHANDLED') await tx.auditEvent.create({ data: { type: 'BILLING_EVENT_UNHANDLED', metadata: { stripeEventId: event.id, eventType: event.type, livemode: event.livemode } } });
  return billingContainmentEffects(tx, receipt);


}

export async function finishBillingObservation(ctx: ApiContext, effects: Awaited<ReturnType<typeof applyBillingObservation>>) {
  await releaseContainedJobs(ctx, effects.jobIds);
  if (effects.collectDebtFor) await serializable(ctx.db, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-account:${effects.collectDebtFor}`}, 0))`;
    // A remaining shortfall is a durable receivable, not a reason to roll back
    // collections made possible by healthy reservation releases.
    await collectRefundDebt(tx, effects.collectDebtFor!);
  });
  return { received: true, outcome: effects.outcome };
}

export function registerBilling(app: FastifyInstance, ctx: ApiContext) {
  app.get('/api/billing/payment-methods', async request => {
    const { user } = requireIdentity(request);
    const { after } = z.object({ after: MethodId.optional() }).strict().parse(request.query);
    const reason = methodAvailability(ctx);
    const pending = await ctx.db.idempotencyRecord.findFirst({ where: { userId: user.id, endpoint: METHOD_ENDPOINT, response: { path: ['state'], equals: 'PENDING' } } });
    const common = { available: !reason, reason, consent: SAVED_METHOD_CONSENT, pendingOperation: pending ? pendingDto(pending.key, MethodOperation.parse(pending.response)) : null };
    if (reason || !user.stripeCustomerId) return { ...common, methods: [], defaultPaymentMethodId: null, hasMore: false, nextCursor: null };
    try { return { ...common, ...await ctx.billing!.paymentMethods({ userId: user.id, customerId: user.stripeCustomerId }, after) }; }
    catch (error) { providerReadError(error); }
  });
  app.post('/api/billing/payment-methods/setup', request => changeSavedMethod(ctx, request, 'setup'));
  for (const action of ['default', 'remove'] as const) app.post(`/api/billing/payment-methods/:id/${action}`, request =>
    changeSavedMethod(ctx, request, action, MethodId.parse((request.params as { id: string }).id)));
  app.get('/api/billing/receipts', async request => {
    const { user } = requireIdentity(request);
    const { after } = z.object({ after: z.string().uuid().optional() }).strict().parse(request.query);
    const reason = methodAvailability(ctx);
    if (reason) return { available: false, reason, items: [], hasMore: false, nextCursor: null };
    const eligible = { userId: user.id, livemode: ctx.billing!.livemode, paymentIntentId: { not: null }, state: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED'] } };
    if (after) requireValue(await ctx.db.topup.findFirst({ where: { ...eligible, id: after } }));
    const rows = await ctx.db.topup.findMany({ where: eligible, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 21, ...(after ? { cursor: { id: after }, skip: 1 } : {}) });
    const items = rows.slice(0, 20).map(row => ({ id: row.id, amountMinor: row.amountMinor, currency: 'USD', status: row.state,
      refundedMinor: row.refundedMinor, createdAt: row.createdAt.toISOString(), receiptAvailable: true }));
    return { available: true, reason: null, items, hasMore: rows.length > 20, nextCursor: rows.length > 20 ? items.at(-1)!.id : null };
  });
  app.get('/api/billing/receipts/:id', async request => {
    const { user } = requireIdentity(request), billing = requireStripe(ctx);
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const topup = requireValue(await ctx.db.topup.findFirst({ where: { id, userId: user.id, livemode: billing.livemode,
      paymentIntentId: { not: null }, state: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED'] } } }));
    if (!user.stripeCustomerId) throw new ApiError(404, 'RECEIPT_UNAVAILABLE', 'Receipt is unavailable');
    try { return await billing.receipt({ userId: user.id, customerId: user.stripeCustomerId, topupId: topup.id, paymentIntentId: topup.paymentIntentId!, amountMinor: topup.amountMinor }); }
    catch (error) { providerReadError(error); }
  });
  app.get('/api/wallet', async request => {
    const { user } = requireIdentity(request, 'jobs:read');
    const wallet = await ctx.db.wallet.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id } });
    const ledger = await ctx.db.ledgerEntry.findMany({ where: { userId: user.id }, take: 100, orderBy: { createdAt: 'desc' },
      select: { id: true, type: true, jobId: true, currency: true, amountMinor: true, availableDelta: true, reservedDelta: true, spentDelta: true, earnedDelta: true, createdAt: true } });
    return { availableMinor: wallet.availableMinor, reservedMinor: wallet.reservedMinor, spentMinor: wallet.spentMinor, earnedMinor: wallet.earnedMinor, ledger };
  });
  app.post('/api/wallet/topup', async request => {
    const { user } = requireIdentity(request);
    const { amountMinor } = z.object({ amountMinor: z.number().int().min(100).max(100_000) }).strict().parse(request.body);
    const key = idempotencyKey(request);
    const topup = await serializable(ctx.db, async tx => {
      const operation = `topup:${user.id}:${key}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${operation}, 0))`;
      const existing = await tx.topup.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: key } } });
      if (existing) {
        if (existing.amountMinor !== amountMinor) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Topup key was already used for a different amount');
        return existing;
      }
      const created = await tx.topup.create({ data: { userId: user.id, amountMinor, idempotencyKey: key, livemode: ctx.billing?.livemode ?? false } });
      if (ctx.config.paymentMode === 'fake') {
        if (!ctx.config.development) throw new ApiError(503, 'PAYMENT_UNAVAILABLE', 'Fake payments are development only');
        await creditWallet(tx, user.id, amountMinor, `fake-topup:${created.id}`);
        return tx.topup.update({ where: { id: created.id }, data: { state: 'PAID' } });
      }
      return created;
    });
    if (ctx.config.paymentMode === 'fake' || ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(topup.state)) return { id: topup.id, status: topup.state };
    if (topup.checkoutUrl) return { id: topup.id, url: topup.checkoutUrl };
    if (!ctx.billing) throw new ApiError(503, 'PAYMENT_UNAVAILABLE', 'Stripe is not configured');
    const checkout = await ctx.billing.checkout({ topupId: topup.id, userId: user.id, email: user.email, customerId: user.stripeCustomerId, amountMinor, webOrigin: ctx.config.webOrigin });
    await ctx.db.$transaction([
      ctx.db.topup.update({ where: { id: topup.id }, data: { stripeSessionId: checkout.id, checkoutUrl: checkout.url } }),
      ctx.db.user.update({ where: { id: user.id }, data: { stripeCustomerId: checkout.customerId } }),
    ]);
    return { id: topup.id, url: checkout.url };
  });
  app.post('/api/billing/webhook', async request => {
    if (!ctx.billing) throw new ApiError(503, 'PAYMENT_UNAVAILABLE', 'Stripe webhook verification is not configured');
    const signature = z.string().parse(request.headers['stripe-signature']);
    let event;
    try { event = ctx.billing.verifyWebhook(request.rawBody, signature); }
    catch (error) {
      if (error instanceof BillingError) throw new ApiError(400, error.code, error.message);
      throw new ApiError(400, 'INVALID_STRIPE_SIGNATURE', 'Stripe signature did not verify');
    }
    if (payoutEvents.has(event.type)) return acceptPayoutEvent(ctx, event);
    // Connect destinations also deliver seller-controlled charge/Checkout objects.
    // They cannot credit the platform's buyer wallet or mutate its disputes.
    if (event.account && event.type !== 'account.updated') {
      await ctx.db.billingEvent.upsert({ where: { id: event.id }, create: { id: event.id, type: event.type, livemode: event.livemode, outcome: 'IGNORED_CONNECTED_EVENT' }, update: {} });
      return { received: true, outcome: 'IGNORED_CONNECTED_EVENT' };
    }
    if (event.type === 'account.updated' && event.account && event.account !== event.data.object.id) throw new ApiError(400, 'CONNECTED_ACCOUNT_MISMATCH', 'Account event scope changed');
    const effects = await serializable(ctx.db, tx => applyBillingObservation(tx, event));
    return finishBillingObservation(ctx, effects);
  });
  app.post('/api/seller/billing/onboard', async request => {
    const { user } = requireIdentity(request);
    if (!ctx.billing) throw new ApiError(503, 'STRIPE_NOT_CONFIGURED', 'Connect onboarding requires Stripe configuration');
    const onboarding = await ctx.billing.connect(user.id, user.email, user.stripeConnectedAccountId, ctx.config.webOrigin);
    await ctx.db.user.update({ where: { id: user.id }, data: { stripeConnectedAccountId: onboarding.accountId, connectStatus: 'IN_PROGRESS' } });
    return { url: onboarding.url };
  });
  app.get('/api/seller/earnings', async request => {
    const { user } = requireIdentity(request);
    const wallet = await ctx.db.wallet.findUnique({ where: { userId: user.id } });
    const settled = await ctx.db.job.aggregate({ where: { sellerId: user.id, paymentState: 'SETTLED' }, _sum: { buyerPriceMinor: true, platformFeeMinor: true, sellerNetMinor: true }, _count: true });
    const pending = await ctx.db.job.aggregate({ where: { sellerId: user.id, paymentState: 'RESERVED' }, _sum: { sellerNetMinor: true }, _count: true });
    const transfers = await ctx.db.sellerTransfer.findMany({ where: { sellerId: user.id }, take: 100, orderBy: { createdAt: 'desc' } });
    const transferred = await ctx.db.sellerTransfer.aggregate({ where: { sellerId: user.id, state: 'TRANSFERRED' }, _sum: { amountMinor: true } });
    const payoutView = await serializable(ctx.db, async tx => {
      // Totals and backfill/error evidence must describe the same database snapshot.
      const payouts = await sellerPayouts(ctx, user.id, user.stripeConnectedAccountId, undefined, tx);
      const totals = payouts.available ? await tx.payoutRecord.groupBy({ by: ['status'], where: { sellerId: user.id,
        stripeAccountId: user.stripeConnectedAccountId!, livemode: ctx.billing!.livemode, currency: 'USD' }, _sum: { amountMinor: true } }) : [];
      const payoutTotal = (...statuses: string[]) => totals.filter(row => statuses.includes(row.status)).reduce((sum, row) => sum + (row._sum.amountMinor ?? 0), 0);
      const sync = payouts.available ? await tx.platformSetting.findUnique({ where: { key: payoutKey(ctx.billing!.livemode, user.stripeConnectedAccountId!) } }) : null;
      const syncState = PayoutSync.parse(sync?.value ?? {});
      return { payoutSummary: { available: payouts.available, reason: payouts.reason, currency: 'USD', accountWide: true,
        paidOutMinor: payoutTotal('paid'), pendingMinor: payoutTotal('pending', 'in_transit'), failedMinor: payoutTotal('failed'), canceledMinor: payoutTotal('canceled'),
        lastSyncedAt: syncState.lastSyncedAt, historyComplete: syncState.historyComplete, lastError: syncState.lastError },
      payouts: payouts.items, payoutsHasMore: payouts.hasMore, payoutsNextCursor: payouts.nextCursor };
    });
    return { earnedMinor: wallet?.earnedMinor ?? 0, grossSalesMinor: settled._sum.buyerPriceMinor ?? 0, platformFeesMinor: settled._sum.platformFeeMinor ?? 0,
      pendingMinor: pending._sum.sellerNetMinor ?? 0, settledJobs: settled._count, pendingJobs: pending._count, connectStatus: user.connectStatus, payoutsEnabled: user.payoutsEnabled, transfers,
      transferredMinor: transferred._sum.amountMinor ?? 0, ...payoutView };
  });
  app.get('/api/seller/payouts', async request => {
    const { user } = requireIdentity(request);
    const { after } = z.object({ after: z.string().uuid().optional() }).strict().parse(request.query);
    return sellerPayouts(ctx, user.id, user.stripeConnectedAccountId, after);
  });
  app.get('/api/seller/audit', async request => {
    const { user } = requireIdentity(request);
    return ctx.db.auditEvent.findMany({ where: { sellerId: user.id }, take: 200, orderBy: { createdAt: 'desc' } });
  });
  app.get('/api/admin/overview', async request => {
    requireAdmin(request);
    const [users, capabilities, jobs, activeJobs, ledger, setting] = await Promise.all([
      ctx.db.user.count(), ctx.db.capability.count(), ctx.db.job.count(), ctx.db.job.count({ where: { state: { in: [...activeStates] } } }),
      ctx.db.ledgerEntry.aggregate({ where: { type: { in: ['PLATFORM_FEE', 'PLATFORM_FEE_REVERSAL'] } }, _sum: { amountMinor: true } }),
      ctx.db.platformSetting.findUnique({ where: { key: 'dispatchEnabled' } }),
    ]);
    return { users, capabilities, jobs, activeJobs, platformFeeMinor: ledger._sum.amountMinor ?? 0, dispatchEnabled: setting?.value !== false };
  });
  app.get('/api/admin/transfers', async request => {
    requireAdmin(request);
    const { state } = z.object({ state: z.enum(['NEEDS_RECONCILIATION', 'PENDING', 'PROCESSING', 'REVERSAL_PENDING', 'TRANSFERRED', 'REVERSED', 'CANCELLED']).default('NEEDS_RECONCILIATION') }).parse(request.query);
    return ctx.db.sellerTransfer.findMany({ where: { state }, take: 100, orderBy: { createdAt: 'asc' } });
  });
  app.post('/api/admin/transfers/:id/resolve', async request => {
    const admin = requireAdmin(request);
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const { stripeTransferId, reason } = z.object({ stripeTransferId: z.string().regex(/^tr_[A-Za-z0-9_]+$/), reason: z.string().trim().min(10).max(1000) }).strict().parse(request.body);
    if (!ctx.billing) throw new ApiError(503, 'STRIPE_NOT_CONFIGURED', 'Provider verification requires Stripe configuration');
    const existing = requireValue(await ctx.db.sellerTransfer.findUnique({ where: { id } }));
    const external = await ctx.billing.retrieveTransfer(stripeTransferId);
    const destination = typeof external.destination === 'string' ? external.destination : external.destination?.id;
    if (external.id !== stripeTransferId || external.livemode !== ctx.billing.livemode || external.currency !== 'usd' || external.amount !== existing.amountMinor ||
      destination !== existing.destinationAccountId || external.metadata.jobId !== existing.jobId || external.transfer_group !== `job_${existing.jobId}`) {
      throw new ApiError(409, 'TRANSFER_MISMATCH', 'Provider transfer does not match the immutable transfer intent');
    }
    const result = await serializable(ctx.db, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`transfer:${existing.jobId}`}, 0))`;
      const current = await tx.sellerTransfer.findUniqueOrThrow({ where: { id } });
      if (current.stripeTransferId === stripeTransferId) return current;
      if (current.state !== 'NEEDS_RECONCILIATION' || current.stripeTransferId) throw new ApiError(409, 'TRANSFER_NOT_UNCERTAIN', 'Only an unresolved transfer can be reconciled');
      const job = await tx.job.findUniqueOrThrow({ where: { id: current.jobId } });
      if (external.reversed && job.paymentState !== 'REFUNDED') throw new ApiError(409, 'REFUND_REQUIRED', 'Reconcile the buyer refund before linking a reversed transfer');
      const state = external.reversed ? 'REVERSED' : job.paymentState === 'REFUNDED' ? 'REVERSAL_PENDING' : 'TRANSFERRED';
      const updated = await tx.sellerTransfer.update({ where: { id }, data: { stripeTransferId, state, nextAttemptAt: new Date(), lastError: null } });
      await tx.auditEvent.create({ data: { actorId: admin.id, sellerId: current.sellerId, jobId: current.jobId, type: 'TRANSFER_MANUALLY_RECONCILED',
        metadata: { reason, transferId: id, stripeTransferId, previousState: current.state, state, amountMinor: current.amountMinor, destinationAccountId: destination } } });
      return updated;
    });
    await ctx.wake();
    return result;
  });
  app.post('/api/admin/transfers/:id/cancel-uncreated', async request => {
    const admin = requireAdmin(request);
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const { reason, investigationReference } = z.object({ confirmation: z.literal('CONFIRM_NO_PROVIDER_TRANSFER_AND_REFUND'),
      reason: z.string().trim().min(10).max(1000), investigationReference: z.string().trim().min(5).max(500) }).strict().parse(request.body);
    if (!ctx.billing) throw new ApiError(503, 'STRIPE_NOT_CONFIGURED', 'Provider verification requires Stripe configuration');
    const existing = requireValue(await ctx.db.sellerTransfer.findUnique({ where: { id } }));
    if (existing.state !== 'NEEDS_RECONCILIATION' || existing.stripeTransferId) throw new ApiError(409, 'TRANSFER_NOT_UNCERTAIN', 'Only an unresolved transfer can be cancelled');
    const transfers = await ctx.billing.findJobTransfers(existing.jobId);
    if (transfers.data.length || transfers.has_more) throw new ApiError(409, 'PROVIDER_TRANSFER_EXISTS', 'Link the existing provider transfer instead of cancelling its intent');
    return serializable(ctx.db, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`transfer:${existing.jobId}`}, 0))`;
      const current = await tx.sellerTransfer.findUniqueOrThrow({ where: { id } });
      if (current.state !== 'NEEDS_RECONCILIATION' || current.stripeTransferId) throw new ApiError(409, 'TRANSFER_NOT_UNCERTAIN', 'Transfer was already reconciled');
      const job = await tx.job.findUniqueOrThrow({ where: { id: current.jobId } });
      if (job.paymentState === 'SETTLED') await refundJob(tx, job);
      else if (job.paymentState !== 'REFUNDED') throw new ApiError(409, 'PAYMENT_NOT_SETTLED', 'Only a settled or refunded job can be reconciled');
      const updated = await tx.sellerTransfer.update({ where: { id }, data: { state: 'CANCELLED', lastError: null } });
      await tx.auditEvent.create({ data: { actorId: admin.id, sellerId: current.sellerId, jobId: current.jobId, type: 'TRANSFER_CONFIRMED_UNCREATED',
        metadata: { transferId: id, reason, investigationReference, providerTransferGroup: `job_${job.id}`, previousPaymentState: job.paymentState, paymentState: 'REFUNDED', resolution: 'CANCEL_WITH_BUYER_REFUND' } } });
      return updated;
    });
  });
  app.post('/api/admin/dispatch', async request => {
    const admin = requireAdmin(request);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    await ctx.db.$transaction([
      ctx.db.platformSetting.upsert({ where: { key: 'dispatchEnabled' }, update: { value: enabled }, create: { key: 'dispatchEnabled', value: enabled } }),
      ctx.db.auditEvent.create({ data: { actorId: admin.id, type: 'DISPATCH_CHANGED', metadata: { enabled } } }),
    ]);
    return { enabled };
  });
  app.get('/api/admin/users/:id/billing-review', async request => {
    requireAdmin(request);
    const userId = z.string().uuid().parse((request.params as { id: string }).id);
    const user = requireValue(await ctx.db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, suspendedAt: true } }));
    const topups = await ctx.db.topup.findMany({ where: { userId }, include: { disputes: true }, orderBy: { createdAt: 'desc' } });
    return { user, refundDebtMinor: topups.reduce((sum, topup) => sum + topup.refundDebtMinor, 0),
      topups: topups.map(topup => ({ id: topup.id, amountMinor: topup.amountMinor, refundedMinor: topup.refundedMinor, refundDebtMinor: topup.refundDebtMinor, disputedAt: topup.disputedAt,
        disputes: topup.disputes.map(dispute => ({ ...dispute, blockingReason: disputeBlockingReason(dispute) })) })) };
  });
  const restore = async (request: FastifyRequest) => {
    const admin = requireAdmin(request);
    const userId = z.string().uuid().parse((request.params as { id: string }).id);
    const { reason } = z.object({ reason: z.string().trim().min(10).max(1000), suspended: z.literal(false).optional() }).strict().parse(request.body);
    if (userId === admin.id) throw new ApiError(409, 'SELF_RESTORE', 'Use another administrator to review this account');
    const key = idempotencyKey(request), endpoint = `restore:${userId}`, fingerprint = hashManifest({ userId, reason });
    return serializable(ctx.db, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`restore:${admin.id}:${userId}:${key}`}, 0))`;
      const previous = await tx.idempotencyRecord.findUnique({ where: { userId_endpoint_key: { userId: admin.id, endpoint, key } } });
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Restoration key was used with another reason');
        return previous.response;
      }
      const result = await restoreBillingAccount(tx, userId, admin.id, reason);
      await tx.idempotencyRecord.create({ data: { userId: admin.id, endpoint, key, fingerprint, response: json(result) } });
      return result;
    });
  };
  app.post('/api/admin/users/:id/restore', restore);
  app.post('/api/admin/users/:id/suspend', async request => {
    const admin = requireAdmin(request);
    const userId = z.string().uuid().parse((request.params as { id: string }).id);
    const { suspended } = z.object({ suspended: z.boolean().default(true) }).parse(request.body ?? {});
    if (userId === admin.id) throw new ApiError(409, 'SELF_SUSPEND', 'Use another administrator to suspend this account');
    if (!suspended) return restore(request);
    const affected = await serializable(ctx.db, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-account:${userId}`}, 0))`;
      const account = requireValue(await tx.user.findUnique({ where: { id: userId } }));
      await tx.user.update({ where: { id: userId }, data: { suspendedAt: account.suspendedAt ?? new Date() } });
      await tx.session.deleteMany({ where: { userId } });
      await tx.apiKey.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      const jobs = await containJobExecution(tx, { OR: [{ buyerId: userId }, { sellerId: userId }] }, 'An account associated with this job was suspended');
      await tx.auditEvent.create({ data: { actorId: admin.id, type: 'ACCOUNT_SUSPENSION_CHANGED', metadata: { userId, suspended } } });
      return jobs;
    });
    await releaseContainedJobs(ctx, affected);
    await ctx.wake();
    return { suspended };
  });
  app.post('/api/admin/jobs/:id/refund', async request => {
    const admin = requireAdmin(request);
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500).default('Administrative refund') }).parse(request.body ?? {});
    await serializable(ctx.db, async tx => {
      const job = requireValue(await tx.job.findUnique({ where: { id } }));
      if (job.paymentState === 'REFUNDED' || job.paymentState === 'RELEASED') return;
      if (job.paymentState === 'RESERVED') await failJob(tx, job, 'CANCELLED', 'Cancelled with buyer reservation released');
      else await refundJob(tx, job);
      await tx.auditEvent.create({ data: { actorId: admin.id, sellerId: job.sellerId, jobId: id, type: 'JOB_REFUNDED', metadata: { reason } } });
    });
    await ctx.wake();
    return getJob(ctx, id, admin.id, true);
  });
}
