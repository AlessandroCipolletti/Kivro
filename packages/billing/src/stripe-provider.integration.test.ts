import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StripeBilling } from './stripe.js';

// Opt-in real Stripe TEST API probe. No payment/charge creation or real card data.
describe.runIf(process.env.KIVRO_STRIPE_SAVED_METHODS === '1')('real Stripe test-mode saved-method operator probe (no charge)', () => {
  let billing: StripeBilling, customerId: string | undefined, sessionId: string | undefined;
  const userId = `kivro-method-probe-${randomUUID()}`, operationId = randomUUID();
  beforeAll(async () => {
    const key = process.env.STRIPE_SECRET_KEY ?? '';
    if (!key.startsWith('sk_test_')) throw new Error('This operator probe requires a dedicated Stripe TEST secret key; live keys are forbidden');
    billing = new StripeBilling(key, process.env.STRIPE_WEBHOOK_SECRET || 'whsec_unused_no_webhooks_in_this_probe');
    customerId = await billing.ensureCustomer({ userId, email: `${userId}@fixture.kivro.invalid` });
  });
  afterAll(async () => {
    try { if (sessionId) await billing.stripe.checkout.sessions.expire(sessionId, {}, { idempotencyKey: `probe:${operationId}:expire` }); }
    finally { if (customerId) await billing.stripe.customers.del(customerId); }
  });
  it('creates a real hosted Setup Checkout, confirms a synthetic SetupIntent, lists/defaults/removes the saved card, and creates no charge', async () => {
    const owner = { userId, customerId: customerId! };
    const setup = await billing.setupCheckout({ ...owner, operationId, webOrigin: 'http://localhost:3000', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    sessionId = setup.id;
    expect(new URL(setup.url).hostname).toBe('checkout.stripe.com');
    // Stripe's official test PaymentMethod alias; never a real card or payment intent.
    const intent = await billing.stripe.setupIntents.create({ customer: customerId, payment_method: 'pm_card_visa',
      payment_method_types: ['card'], usage: 'off_session', confirm: true, metadata: { purpose: 'synthetic_no_charge_operator_probe', kivroUserId: userId } },
    { idempotencyKey: `probe:${operationId}:confirm-test-setup` });
    expect(intent.status).toBe('succeeded'); expect(intent.livemode).toBe(false);
    const methodId = typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method!.id;
    expect((await billing.paymentMethods(owner)).methods.some(method => method.id === methodId)).toBe(true);
    const change = { ...owner, paymentMethodId: methodId, idempotencyKey: `probe:${operationId}` };
    await billing.setDefaultPaymentMethod(change); await billing.setDefaultPaymentMethod(change);
    expect((await billing.paymentMethods(owner)).defaultPaymentMethodId).toBe(methodId);
    await billing.removePaymentMethod(change);
    expect((await billing.paymentMethods(owner)).methods).toEqual([]);
    expect((await billing.paymentMethods(owner)).defaultPaymentMethodId).toBeNull();
    expect((await billing.stripe.charges.list({ customer: customerId, limit: 1 })).data).toHaveLength(0);
  }, 120_000);
});

// Read-only provider evidence against an operator-selected, existing TEST Connect account.
describe.runIf(process.env.KIVRO_STRIPE_PAYOUTS === '1')('real Stripe test-mode payout read probe (no mutation)', () => {
  it('checks account ownership, bounded listing and an existing canonical payout with the real Connect API', async () => {
    const key = process.env.STRIPE_SECRET_KEY ?? '';
    if (!key.startsWith('sk_test_')) throw new Error('This read-only probe requires a dedicated Stripe TEST key; live keys are forbidden');
    const accountId = process.env.KIVRO_STRIPE_PAYOUT_ACCOUNT ?? '', sellerId = process.env.KIVRO_STRIPE_PAYOUT_SELLER ?? '', payoutId = process.env.KIVRO_STRIPE_PAYOUT_ID ?? '';
    if (!/^acct_[A-Za-z0-9]+$/.test(accountId) || !sellerId || !/^po_[A-Za-z0-9]+$/.test(payoutId)) throw new Error('Set the existing test account, its kivroUserId metadata value and a test payout ID');
    const billing = new StripeBilling(key, process.env.STRIPE_WEBHOOK_SECRET || 'whsec_unused_no_webhooks_in_this_probe');
    const owner = { sellerId, accountId };
    const page = await billing.payouts(owner);
    expect(page.items.length).toBeLessThanOrEqual(20);
    const payout = await billing.payout({ ...owner, payoutId });
    expect(payout.id).toBe(payoutId); expect(payout.amountMinor).toBeGreaterThanOrEqual(0);
    expect(['pending', 'in_transit', 'paid', 'failed', 'canceled']).toContain(payout.status);
    expect(payout).not.toHaveProperty('destination'); expect(payout).not.toHaveProperty('failure_message');
  }, 30000);
});

describe.runIf(process.env.KIVRO_STRIPE_RECEIPTS === '1')('real Stripe test-mode receipt read probe (no mutation)', () => {
  it('verifies an existing test purchase and returns its real hosted receipt without creating another charge', async () => {
    const key = process.env.STRIPE_SECRET_KEY ?? '';
    if (!key.startsWith('sk_test_')) throw new Error('This read-only probe requires a dedicated Stripe TEST key; live keys are forbidden');
    const customerId = process.env.KIVRO_STRIPE_RECEIPT_CUSTOMER ?? '', userId = process.env.KIVRO_STRIPE_RECEIPT_BUYER ?? '';
    const topupId = process.env.KIVRO_STRIPE_RECEIPT_TOPUP ?? '', paymentIntentId = process.env.KIVRO_STRIPE_RECEIPT_INTENT ?? '';
    const amountMinor = Number(process.env.KIVRO_STRIPE_RECEIPT_AMOUNT);
    if (!/^cus_[A-Za-z0-9]+$/.test(customerId) || !userId || !topupId || !/^pi_[A-Za-z0-9]+$/.test(paymentIntentId) || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new Error('Set an existing Kivro test customer, buyer/topup IDs, paid PaymentIntent ID and original amount in minor units');
    }
    const billing = new StripeBilling(key, process.env.STRIPE_WEBHOOK_SECRET || 'whsec_unused_no_webhooks_in_this_probe');
    expect(new URL((await billing.receipt({ userId, customerId, topupId, paymentIntentId, amountMinor })).url).hostname).toBe('pay.stripe.com');
  }, 60000);
});
