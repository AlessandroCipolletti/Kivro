import Stripe from 'stripe';
import { assertMoney, BillingError } from './ledger.js';

export interface CheckoutRequest {
  topupId: string; userId: string; email: string; amountMinor: number;
  customerId?: string | null; webOrigin: string;
}

export const SAVED_METHOD_CONSENT = Object.freeze({
  version: 'saved-card-2026-10-06-v1',
  text: 'I agree to save this card with Stripe for future Kivro credit purchases I authorize, including off-session processing of those authorized purchases. Saving a card does not authorize automatic top-ups or unapproved job charges. I can remove the card at any time.',
});
export interface BuyerCustomer { userId: string; customerId: string }
export interface SavedMethodChange extends BuyerCustomer { paymentMethodId: string; idempotencyKey: string }
export interface SetupCheckoutRequest extends BuyerCustomer { operationId: string; webOrigin: string; expiresAt: number }
export interface SavedCard { id: string; type: 'card'; brand: string; last4: string; expMonth: number; expYear: number; isDefault: boolean }
export interface ConnectedSeller { sellerId: string; accountId: string }
export interface ProviderPayout {
  id: string; amountMinor: number; currency: string; status: 'pending' | 'in_transit' | 'paid' | 'failed' | 'canceled';
  providerCreatedAt: Date; arrivalDate: Date; failureCode: string | null;
}
const payoutOptions = { timeout: 3000, maxNetworkRetries: 0 } as const;
const providerId = (id: string, prefix: 'acct' | 'po') => new RegExp(`^${prefix}_[A-Za-z0-9]{1,200}$`).test(id);
const objectId = (value: string | { id: string } | null): string | null => typeof value === 'string' ? value : value?.id ?? null;
function stripeUrl(raw: string | null, host: 'checkout.stripe.com' | 'pay.stripe.com'): string {
  let url: URL;
  try { url = new URL(raw ?? ''); } catch { throw new BillingError('PROVIDER_URL_UNAVAILABLE', 'Stripe did not return an available hosted page'); }
  if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password || url.port || url.href.length > 8192) throw new BillingError('PROVIDER_URL_UNAVAILABLE', 'Stripe returned an unsupported hosted page');
  return url.href;
}

export class StripeBilling {
  readonly stripe: Stripe;
  readonly livemode: boolean;
  constructor(secretKey: string, private readonly webhookSecret: string, private readonly connectWebhookSecret?: string) {
    if (!/^sk_(live|test)_/.test(secretKey) || !webhookSecret) throw new Error('A Stripe live or test secret key and webhook secret are required');
    this.livemode = secretKey.startsWith('sk_live_');
    this.stripe = new Stripe(secretKey, { apiVersion: '2025-03-31.basil', maxNetworkRetries: 2, timeout: 15_000 });
  }

  verifyWebhook(raw: Buffer, signature: string): Stripe.Event {
    let event: Stripe.Event;
    try { event = this.stripe.webhooks.constructEvent(raw, signature, this.webhookSecret, 300); }
    catch (error) {
      if (!this.connectWebhookSecret) throw error;
      event = this.stripe.webhooks.constructEvent(raw, signature, this.connectWebhookSecret, 300);
      if (!event.account) throw new BillingError('PAYMENT_ACCOUNT_SCOPE_MISMATCH', 'Connect signing secret cannot authorize platform events');
    }
    const object = event.data.object as { livemode?: boolean };
    if (event.livemode !== this.livemode || (object.livemode !== undefined && object.livemode !== this.livemode)) {
      throw new BillingError('PAYMENT_MODE_MISMATCH', 'Stripe event mode does not match the configured account mode');
    }
    return event;
  }

  async ownedCustomer(request: BuyerCustomer): Promise<Stripe.Customer> {
    const customer = await this.stripe.customers.retrieve(request.customerId);
    if (customer.deleted || customer.id !== request.customerId || customer.livemode !== this.livemode || customer.metadata.kivroUserId !== request.userId) {
      throw new BillingError('PAYMENT_CUSTOMER_UNAVAILABLE', 'The Stripe customer does not belong to this account');
    }
    return customer;
  }

  async ensureCustomer(request: { userId: string; email: string; customerId?: string | null }): Promise<string> {
    if (request.customerId) return (await this.ownedCustomer({ userId: request.userId, customerId: request.customerId })).id;
    const customer = await this.stripe.customers.create({ email: request.email, metadata: { kivroUserId: request.userId } }, { idempotencyKey: `customer:${request.userId}` });
    if (customer.livemode !== this.livemode || customer.metadata.kivroUserId !== request.userId) throw new BillingError('PAYMENT_CUSTOMER_UNAVAILABLE', 'Stripe customer creation could not be verified');
    return customer.id;
  }

  async ownedPaymentMethod(request: BuyerCustomer, paymentMethodId: string): Promise<Stripe.PaymentMethod> {
    const method = await this.stripe.paymentMethods.retrieve(paymentMethodId);
    if (method.id !== paymentMethodId || objectId(method.customer) !== request.customerId || method.livemode !== this.livemode || method.type !== 'card' || !method.card) {
      throw new BillingError('PAYMENT_METHOD_UNAVAILABLE', 'Saved payment method is unavailable');
    }
    return method;
  }

  async paymentMethods(request: BuyerCustomer, after?: string) {
    const customer = await this.ownedCustomer(request);
    if (after) await this.ownedPaymentMethod(request, after);
    const page = await this.stripe.customers.listPaymentMethods(request.customerId, { type: 'card', limit: 20, ...(after ? { starting_after: after } : {}) });
    const defaultPaymentMethodId = objectId(customer.invoice_settings.default_payment_method);
    const methods: SavedCard[] = page.data.map(method => {
      if (objectId(method.customer) !== request.customerId || method.livemode !== this.livemode || method.type !== 'card' || !method.card) throw new BillingError('PAYMENT_METHOD_UNAVAILABLE', 'Stripe returned an unexpected payment method');
      return { id: method.id, type: 'card', brand: method.card.brand, last4: method.card.last4, expMonth: method.card.exp_month,
        expYear: method.card.exp_year, isDefault: method.id === defaultPaymentMethodId };
    });
    return { methods, defaultPaymentMethodId, hasMore: page.has_more, nextCursor: page.has_more ? methods.at(-1)?.id ?? null : null };
  }

  async setupCheckout(request: SetupCheckoutRequest) {
    await this.ownedCustomer(request);
    const metadata = { purpose: 'saved_payment_method', userId: request.userId, operationId: request.operationId, consentVersion: SAVED_METHOD_CONSENT.version };
    const session = await this.stripe.checkout.sessions.create({ mode: 'setup', customer: request.customerId, payment_method_types: ['card'],
      client_reference_id: request.operationId, metadata, setup_intent_data: { metadata },
      custom_text: { submit: { message: SAVED_METHOD_CONSENT.text } }, expires_at: request.expiresAt,
      success_url: `${request.webOrigin}/wallet?paymentMethod=returned`, cancel_url: `${request.webOrigin}/wallet?paymentMethod=cancelled`,
    }, { idempotencyKey: `saved-method:${request.operationId}:setup` });
    if (session.mode !== 'setup' || objectId(session.customer) !== request.customerId || session.livemode !== this.livemode) throw new BillingError('PAYMENT_CUSTOMER_UNAVAILABLE', 'Stripe setup session could not be verified');
    return { id: session.id, url: stripeUrl(session.url, 'checkout.stripe.com'), expiresAt: new Date(session.expires_at * 1000).toISOString() };
  }

  async setDefaultPaymentMethod(request: SavedMethodChange): Promise<void> {
    await this.ownedCustomer(request); await this.ownedPaymentMethod(request, request.paymentMethodId);
    await this.stripe.customers.update(request.customerId, { invoice_settings: { default_payment_method: request.paymentMethodId } }, { idempotencyKey: `${request.idempotencyKey}:default` });
  }

  /** previouslyAuthorized is host-persisted operation evidence, never browser input. */
  async removePaymentMethod(request: SavedMethodChange, previouslyAuthorized = false): Promise<void> {
    const customer = await this.ownedCustomer(request);
    const method = await this.stripe.paymentMethods.retrieve(request.paymentMethodId);
    if (method.id !== request.paymentMethodId || method.livemode !== this.livemode || method.type !== 'card' ||
      (objectId(method.customer) !== request.customerId && !(previouslyAuthorized && method.customer === null))) {
      throw new BillingError('PAYMENT_METHOD_UNAVAILABLE', 'Saved payment method is unavailable');
    }
    // Recover a completed detach after a crash without authorizing a foreign method.
    if (method.customer === null) return;
    if (objectId(customer.invoice_settings.default_payment_method) === method.id) {
      await this.stripe.customers.update(request.customerId, { invoice_settings: { default_payment_method: '' } }, { idempotencyKey: `${request.idempotencyKey}:clear-default` });
    }
    await this.stripe.paymentMethods.detach(method.id, {}, { idempotencyKey: `${request.idempotencyKey}:detach` });
  }

  async receipt(request: BuyerCustomer & { topupId: string; paymentIntentId: string; amountMinor: number }) {
    await this.ownedCustomer(request);
    const intent = await this.stripe.paymentIntents.retrieve(request.paymentIntentId, { expand: ['latest_charge'] });
    if (intent.id !== request.paymentIntentId || intent.livemode !== this.livemode || objectId(intent.customer) !== request.customerId ||
      intent.metadata.topupId !== request.topupId || intent.metadata.userId !== request.userId || intent.currency !== 'usd' ||
      intent.amount !== request.amountMinor || intent.status !== 'succeeded') throw new BillingError('RECEIPT_UNAVAILABLE', 'Receipt does not match this purchase');
    const charge = typeof intent.latest_charge === 'string' ? await this.stripe.charges.retrieve(intent.latest_charge) : intent.latest_charge;
    if (!charge || charge.livemode !== this.livemode || objectId(charge.customer) !== request.customerId || objectId(charge.payment_intent) !== intent.id ||
      !charge.paid || charge.currency !== 'usd' || charge.amount !== request.amountMinor) throw new BillingError('RECEIPT_UNAVAILABLE', 'Receipt does not match this purchase');
    return { url: stripeUrl(charge.receipt_url, 'pay.stripe.com') };
  }

  async ownedConnectedAccount(request: ConnectedSeller): Promise<void> {
    if (!providerId(request.accountId, 'acct')) throw new BillingError('PAYOUT_ACCOUNT_MISMATCH', 'Invalid connected account');
    const account = await this.stripe.accounts.retrieve(request.accountId, payoutOptions);
    if (account.id !== request.accountId || account.metadata?.kivroUserId !== request.sellerId) {
      throw new BillingError('PAYOUT_ACCOUNT_MISMATCH', 'Connected account does not belong to this seller');
    }
  }

  private payoutProjection(payout: Stripe.Payout): ProviderPayout {
    const timestamp = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 253402300799;
    if (payout.object !== 'payout' || !providerId(payout.id, 'po') || payout.livemode !== this.livemode ||
      !Number.isSafeInteger(payout.amount) || payout.amount < 0 || payout.amount > 2147483647 || !/^[a-z]{3}$/.test(payout.currency) ||
      !['pending', 'in_transit', 'paid', 'failed', 'canceled'].includes(payout.status) || !timestamp(payout.created) || !timestamp(payout.arrival_date) ||
      (payout.failure_code !== null && !/^[a-z0-9_]{1,100}$/.test(payout.failure_code))) {
      throw new BillingError('PAYOUT_PROVIDER_MISMATCH', 'Stripe returned an unsupported payout');
    }
    // Do not persist bank destinations, descriptors, metadata or failure messages.
    return { id: payout.id, amountMinor: payout.amount, currency: payout.currency.toUpperCase(), status: payout.status as ProviderPayout['status'],
      providerCreatedAt: new Date(payout.created * 1000), arrivalDate: new Date(payout.arrival_date * 1000), failureCode: payout.failure_code };
  }

  async payout(request: ConnectedSeller & { payoutId: string }): Promise<ProviderPayout> {
    if (!providerId(request.payoutId, 'po')) throw new BillingError('PAYOUT_PROVIDER_MISMATCH', 'Invalid payout reference');
    await this.ownedConnectedAccount(request);
    const payout = await this.stripe.payouts.retrieve(request.payoutId, {}, { ...payoutOptions, stripeAccount: request.accountId });
    if (payout.id !== request.payoutId) throw new BillingError('PAYOUT_PROVIDER_MISMATCH', 'Payout reference changed');
    return this.payoutProjection(payout);
  }

  async payouts(request: ConnectedSeller & { after?: string }): Promise<{ items: ProviderPayout[]; hasMore: boolean; nextCursor: string | null }> {
    if (request.after && !providerId(request.after, 'po')) throw new BillingError('PAYOUT_PROVIDER_MISMATCH', 'Invalid payout cursor');
    await this.ownedConnectedAccount(request);
    const page = await this.stripe.payouts.list({ limit: 20, ...(request.after ? { starting_after: request.after } : {}) }, { ...payoutOptions, stripeAccount: request.accountId });
    if (typeof page.has_more !== 'boolean' || page.data.length > 20 || (page.has_more && (!page.data.length || page.data.at(-1)?.id === request.after)) || new Set(page.data.map(row => row.id)).size !== page.data.length) {
      throw new BillingError('PAYOUT_PROVIDER_MISMATCH', 'Stripe returned an invalid payout page');
    }
    const items = page.data.map(row => this.payoutProjection(row));
    return { items, hasMore: page.has_more, nextCursor: page.has_more ? items.at(-1)!.id : null };
  }

  async checkout(request: CheckoutRequest) {
    assertMoney(request.amountMinor);
    const customerId = request.customerId ?? (await this.stripe.customers.create({
      email: request.email, metadata: { kivroUserId: request.userId },
    }, { idempotencyKey: `customer:${request.userId}` })).id;
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment', customer: customerId, client_reference_id: request.topupId,
      metadata: { topupId: request.topupId, userId: request.userId },
      payment_intent_data: { metadata: { topupId: request.topupId, userId: request.userId } },
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: request.amountMinor,
        product_data: { name: 'Kivro marketplace credits' } } }],
      success_url: `${request.webOrigin}/wallet?checkout=success`,
      cancel_url: `${request.webOrigin}/wallet?checkout=cancelled`,
    }, { idempotencyKey: `topup:${request.topupId}` });
    return { id: session.id, url: session.url, customerId };
  }

  async connect(userId: string, email: string, accountId: string | null, webOrigin: string) {
    const account = accountId ?? (await this.stripe.accounts.create({
      type: 'express', email, capabilities: { transfers: { requested: true } }, metadata: { kivroUserId: userId },
    }, { idempotencyKey: `connect:${userId}` })).id;
    const link = await this.stripe.accountLinks.create({ account, type: 'account_onboarding',
      refresh_url: `${webOrigin}/selling/earnings?connect=refresh`, return_url: `${webOrigin}/selling/earnings?connect=returned` });
    return { accountId: account, url: link.url };
  }

  async transfer(jobId: string, destination: string, amount: number) {
    assertMoney(amount);
    return this.stripe.transfers.create({ amount, currency: 'usd', destination,
      transfer_group: `job_${jobId}`, metadata: { jobId } }, { idempotencyKey: `job:${jobId}:transfer` });
  }

  async reverseTransfer(jobId: string, transferId: string) {
    return this.stripe.transfers.createReversal(transferId, {}, { idempotencyKey: `job:${jobId}:reverse` });
  }

  async retrieveTransfer(transferId: string) {
    return this.stripe.transfers.retrieve(transferId);
  }

  async findJobTransfers(jobId: string) {
    return this.stripe.transfers.list({ transfer_group: `job_${jobId}`, limit: 1 });
  }

  async refundTopup(topupId: string, paymentIntentId: string, amount: number) {
    assertMoney(amount);
    return this.stripe.refunds.create({ payment_intent: paymentIntentId, amount, metadata: { topupId } },
      { idempotencyKey: `topup:${topupId}:refund` });
  }
}
