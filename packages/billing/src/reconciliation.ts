import { BillingError } from './ledger.js';
import type { StripeBilling } from './stripe.js';

export const RECONCILIATION_READ_OPTIONS = Object.freeze({ timeout: 3000, maxNetworkRetries: 0 });
export const RECONCILIATION_PAGE_SIZE = 10;
const idOf = (value: string | { id: string } | null): string | null => typeof value === 'string' ? value : value?.id ?? null;
const validId = (id: string, prefix: string) => typeof id === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,240}$`).test(id);
const money = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000;
function requireProvider(condition: unknown): asserts condition {
  if (!condition) throw new BillingError('PROVIDER_RECONCILIATION_MISMATCH', 'Canonical provider evidence does not match the marketplace record');
}
function page<T extends { id: string }>(result: { data: T[]; has_more: boolean }, prefix: string, after?: string | null) {
  requireProvider(Array.isArray(result.data) && result.data.length <= RECONCILIATION_PAGE_SIZE && typeof result.has_more === 'boolean');
  requireProvider(new Set(result.data.map(row => row.id)).size === result.data.length && result.data.every(row => validId(row.id, prefix)));
  requireProvider(!result.has_more || result.data.length && result.data.at(-1)!.id !== after);
  return { items: result.data, next: result.has_more ? result.data.at(-1)!.id : null };
}

export async function readCheckoutPage(billing: StripeBilling, after?: string | null) {
  requireProvider(!after || validId(after, 'cs'));
  const result = page(await billing.stripe.checkout.sessions.list({ limit: RECONCILIATION_PAGE_SIZE, ...(after ? { starting_after: after } : {}) }, RECONCILIATION_READ_OPTIONS), 'cs', after);
  requireProvider(result.items.every(session => session.object === 'checkout.session' && session.livemode === billing.livemode));
  return result;
}

export interface TopupRead {
  id: string; userId: string; amountMinor: number; sessionId: string; customerId: string | null;
  paymentIntentId: string | null; credited: boolean; disputeAfter?: string | null;
}
export interface CanonicalDispute {
  id: string; paymentIntentId: string; chargeId: string; amountMinor: number; currency: string; status: string; created: number;
}
export async function readTopup(billing: StripeBilling, request: TopupRead) {
  requireProvider(validId(request.sessionId, 'cs'));
  const session = await billing.stripe.checkout.sessions.retrieve(request.sessionId, {}, RECONCILIATION_READ_OPTIONS);
  const customerId = idOf(session.customer);
  requireProvider(session.id === request.sessionId && session.object === 'checkout.session' && session.livemode === billing.livemode && session.mode === 'payment' &&
    session.metadata?.topupId === request.id && session.metadata.userId === request.userId && session.client_reference_id === request.id &&
    session.currency === 'usd' && session.amount_total === request.amountMinor && customerId && validId(customerId, 'cus') && (!request.customerId || request.customerId === customerId));
  const customer = await billing.stripe.customers.retrieve(customerId, {}, RECONCILIATION_READ_OPTIONS);
  requireProvider(!customer.deleted && customer.id === customerId && customer.livemode === billing.livemode && customer.metadata.kivroUserId === request.userId);
  const paymentIntentId = idOf(session.payment_intent);
  requireProvider(!request.paymentIntentId || request.paymentIntentId === paymentIntentId);
  if (session.payment_status !== 'paid') {
    requireProvider(!request.credited && ['unpaid', 'no_payment_required'].includes(session.payment_status) && ['open', 'complete', 'expired'].includes(session.status ?? ''));
    return { session, customerId, charge: null, disputes: [] as CanonicalDispute[], disputeAfter: null, historyComplete: false };
  }
  requireProvider(session.status === 'complete' && paymentIntentId && validId(paymentIntentId, 'pi'));
  const intent = await billing.stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] }, RECONCILIATION_READ_OPTIONS);
  requireProvider(intent.id === paymentIntentId && intent.livemode === billing.livemode && intent.status === 'succeeded' && intent.currency === 'usd' &&
    intent.amount === request.amountMinor && intent.amount_received === request.amountMinor && idOf(intent.customer) === customerId &&
    intent.metadata.topupId === request.id && intent.metadata.userId === request.userId);
  const charge = typeof intent.latest_charge === 'string' ? await billing.stripe.charges.retrieve(intent.latest_charge, {}, RECONCILIATION_READ_OPTIONS) : intent.latest_charge;
  requireProvider(charge && validId(charge.id, 'ch') && charge.object === 'charge' && charge.livemode === billing.livemode && charge.paid && charge.captured &&
    charge.amount === request.amountMinor && charge.amount_captured === request.amountMinor && charge.currency === 'usd' && idOf(charge.customer) === customerId &&
    idOf(charge.payment_intent) === paymentIntentId && money(charge.amount_refunded) && charge.amount_refunded <= request.amountMinor &&
    (!charge.metadata.topupId || charge.metadata.topupId === request.id) && (!charge.metadata.userId || charge.metadata.userId === request.userId));
  const readDisputes = async (after?: string | null) => {
    requireProvider(!after || validId(after, 'dp') || validId(after, 'du'));
    const result = await billing.stripe.disputes.list({ payment_intent: paymentIntentId, limit: RECONCILIATION_PAGE_SIZE, ...(after ? { starting_after: after } : {}) }, RECONCILIATION_READ_OPTIONS);
    // Stripe uses both dp_ and du_ dispute identifiers across API generations.
    const checked = page(result, 'd[pu]', after);
    const items = result.data.map(dispute => {
      requireProvider(dispute.object === 'dispute' && dispute.livemode === billing.livemode && idOf(dispute.payment_intent) === paymentIntentId && idOf(dispute.charge) === charge.id &&
        money(dispute.amount) && dispute.amount > 0 && dispute.amount <= request.amountMinor && dispute.currency === 'usd' && Number.isSafeInteger(dispute.created) && dispute.created > 0 &&
        ['needs_response', 'under_review', 'warning_needs_response', 'warning_under_review', 'won', 'lost', 'warning_closed', 'prevented'].includes(dispute.status));
      return { id: dispute.id, paymentIntentId, chargeId: charge.id, amountMinor: dispute.amount, currency: dispute.currency, status: dispute.status, created: dispute.created };
    });
    return { items, next: checked.next };
  };
  const head = await readDisputes();
  const history = request.disputeAfter ? await readDisputes(request.disputeAfter) : head;
  const disputes = [...new Map([...history.items, ...head.items].map(dispute => [dispute.id, dispute])).values()];
  requireProvider(!charge.disputed || disputes.length > 0);
  return { session, customerId, charge, disputes, disputeAfter: history.next, historyComplete: history.next === null };
}

export async function readCompletedTransfer(billing: StripeBilling, request: { id: string; jobId: string; amountMinor: number; destination: string }) {
  requireProvider(validId(request.id, 'tr') && validId(request.destination, 'acct'));
  const transfer = await billing.stripe.transfers.retrieve(request.id, {}, RECONCILIATION_READ_OPTIONS);
  requireProvider(transfer.object === 'transfer' && transfer.id === request.id && transfer.livemode === billing.livemode && transfer.currency === 'usd' &&
    transfer.amount === request.amountMinor && transfer.metadata.jobId === request.jobId && transfer.transfer_group === `job_${request.jobId}` && idOf(transfer.destination) === request.destination &&
    money(transfer.amount_reversed) && transfer.amount_reversed <= request.amountMinor && typeof transfer.reversed === 'boolean' && transfer.reversed === (transfer.amount_reversed === request.amountMinor));
  return { id: transfer.id, amountReversedMinor: transfer.amount_reversed, reversed: transfer.reversed };
}
