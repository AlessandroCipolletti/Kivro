import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { SAVED_METHOD_CONSENT, StripeBilling } from './stripe.js';

describe('Stripe saved cards and receipts (synthetic SDK responses, no provider requests)', () => {
  const billing = new StripeBilling('sk_test_synthetic_saved_methods', 'whsec_synthetic_saved_methods');
  const owner = { userId: 'buyer-1', customerId: 'cus_buyer1' };
  const customer = () => ({ id: owner.customerId, livemode: false, metadata: { kivroUserId: owner.userId }, invoice_settings: { default_payment_method: 'pm_card1' } });
  const card = () => ({ id: 'pm_card1', customer: owner.customerId, livemode: false, type: 'card',
    card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2035, fingerprint: 'private-fingerprint' }, billing_details: { email: 'private@example.invalid' } });
  const change = () => ({ ...owner, paymentMethodId: 'pm_card1', idempotencyKey: 'saved-method:operation-1' });
  const charge = () => ({ id: 'ch_owned1', customer: owner.customerId, payment_intent: 'pi_owned1', livemode: false, paid: true,
    amount: 1000, currency: 'usd', receipt_url: 'https://pay.stripe.com/receipts/test/owned' });
  const intent = () => ({ id: 'pi_owned1', customer: owner.customerId, livemode: false, amount: 1000, currency: 'usd', status: 'succeeded',
    metadata: { userId: owner.userId, topupId: 'topup-1' }, latest_charge: charge() });
  const receipt = () => billing.receipt({ ...owner, topupId: 'topup-1', paymentIntentId: 'pi_owned1', amountMinor: 1000 });
  beforeEach(() => {
    vi.spyOn(billing.stripe.customers, 'retrieve').mockResolvedValue(customer() as never);
    vi.spyOn(billing.stripe.customers, 'create').mockRejectedValue(new Error('Unexpected customer creation'));
    vi.spyOn(billing.stripe.customers, 'update').mockResolvedValue(customer() as never);
    vi.spyOn(billing.stripe.customers, 'listPaymentMethods').mockResolvedValue({ data: [card()], has_more: false } as never);
    vi.spyOn(billing.stripe.paymentMethods, 'retrieve').mockResolvedValue(card() as never);
    vi.spyOn(billing.stripe.paymentMethods, 'detach').mockResolvedValue({ ...card(), customer: null } as never);
    vi.spyOn(billing.stripe.checkout.sessions, 'create').mockRejectedValue(new Error('Unexpected Checkout creation'));
    vi.spyOn(billing.stripe.paymentIntents, 'retrieve').mockResolvedValue(intent() as never);
    vi.spyOn(billing.stripe.charges, 'retrieve').mockResolvedValue(charge() as never);
  });
  afterEach(() => vi.restoreAllMocks());
  it('creates an identified customer idempotently and reuses only its actual owner', async () => {
    vi.mocked(billing.stripe.customers.create).mockResolvedValue(customer() as never);
    expect(await billing.ensureCustomer({ userId: owner.userId, email: 'buyer@example.invalid' })).toBe(owner.customerId);
    expect(billing.stripe.customers.create).toHaveBeenCalledWith({ email: 'buyer@example.invalid', metadata: { kivroUserId: owner.userId } }, { idempotencyKey: 'customer:buyer-1' });
    expect(await billing.ensureCustomer({ ...owner, email: 'buyer@example.invalid' })).toBe(owner.customerId);
    expect(billing.stripe.customers.create).toHaveBeenCalledTimes(1);
  });
  it.each(['foreign', 'deleted', 'live'])('rejects a %s Stripe customer before method access', async scenario => {
    vi.mocked(billing.stripe.customers.retrieve).mockResolvedValue({ ...customer(), ...(scenario === 'foreign' ? { metadata: { kivroUserId: 'someone-else' } } : scenario === 'deleted' ? { deleted: true } : { livemode: true }) } as never);
    await expect(billing.paymentMethods(owner)).rejects.toMatchObject({ code: 'PAYMENT_CUSTOMER_UNAVAILABLE' });
    expect(billing.stripe.customers.listPaymentMethods).not.toHaveBeenCalled();
  });
  it('projects only masked display data and bounds/correlates pagination', async () => {
    vi.mocked(billing.stripe.customers.listPaymentMethods).mockResolvedValue({ data: [card()], has_more: true } as never);
    const result = await billing.paymentMethods(owner, 'pm_card1');
    expect(result).toEqual({ methods: [{ id: 'pm_card1', type: 'card', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2035, isDefault: true }], defaultPaymentMethodId: 'pm_card1', hasMore: true, nextCursor: 'pm_card1' });
    expect(JSON.stringify(result)).not.toMatch(/fingerprint|private@example/);
    expect(billing.stripe.customers.listPaymentMethods).toHaveBeenCalledWith('cus_buyer1', { type: 'card', limit: 20, starting_after: 'pm_card1' });
  });
  it('rejects a foreign pagination cursor and unexpected provider list rows', async () => {
    vi.mocked(billing.stripe.paymentMethods.retrieve).mockResolvedValue({ ...card(), customer: 'cus_other' } as never);
    await expect(billing.paymentMethods(owner, 'pm_card1')).rejects.toMatchObject({ code: 'PAYMENT_METHOD_UNAVAILABLE' });
    vi.mocked(billing.stripe.customers.listPaymentMethods).mockResolvedValue({ data: [{ ...card(), customer: 'cus_other' }], has_more: false } as never);
    await expect(billing.paymentMethods(owner)).rejects.toMatchObject({ code: 'PAYMENT_METHOD_UNAVAILABLE' });
  });
  it('uses hosted setup, explicit reuse consent, stable expiry and no payment/charge fields', async () => {
    vi.mocked(billing.stripe.checkout.sessions.create).mockResolvedValue({ id: 'cs_setup1', mode: 'setup', customer: owner.customerId, livemode: false,
      url: 'https://checkout.stripe.com/c/pay/cs_setup1', expires_at: 2_000_000_000 } as never);
    const result = await billing.setupCheckout({ ...owner, operationId: 'operation-1', webOrigin: 'https://kivro.example', expiresAt: 2_000_000_000 });
    expect(result).toEqual({ id: 'cs_setup1', url: 'https://checkout.stripe.com/c/pay/cs_setup1', expiresAt: '2033-05-18T03:33:20.000Z' });
    const [params, options] = vi.mocked(billing.stripe.checkout.sessions.create).mock.calls[0]! as unknown as [Stripe.Checkout.SessionCreateParams, Stripe.RequestOptions];
    expect(params).toMatchObject({ mode: 'setup', customer: owner.customerId, payment_method_types: ['card'],
      setup_intent_data: { metadata: { consentVersion: SAVED_METHOD_CONSENT.version, purpose: 'saved_payment_method' } },
      custom_text: { submit: { message: SAVED_METHOD_CONSENT.text } }, success_url: 'https://kivro.example/wallet?paymentMethod=returned' });
    expect(params).not.toHaveProperty('line_items'); expect(params).not.toHaveProperty('payment_intent_data');
    expect(options).toEqual({ idempotencyKey: 'saved-method:operation-1:setup' });
  });
  it('refuses a Checkout response for another customer or a non-Stripe URL', async () => {
    const session = { id: 'cs_setup1', mode: 'setup', customer: owner.customerId, livemode: false, expires_at: 2_000_000_000, url: 'https://attacker.invalid/checkout' };
    const setup = () => billing.setupCheckout({ ...owner, operationId: 'op', webOrigin: 'https://kivro.example', expiresAt: 2_000_000_000 });
    vi.mocked(billing.stripe.checkout.sessions.create).mockResolvedValue(session as never);
    await expect(setup()).rejects.toMatchObject({ code: 'PROVIDER_URL_UNAVAILABLE' });
    vi.mocked(billing.stripe.checkout.sessions.create).mockResolvedValue({ ...session, customer: 'cus_other' } as never);
    await expect(setup()).rejects.toMatchObject({ code: 'PAYMENT_CUSTOMER_UNAVAILABLE' });
  });
  it.each(['foreign', 'live', 'bank', 'detached'])('rejects a %s method before default changes', async scenario => {
    const extra = scenario === 'foreign' ? { customer: 'cus_other' } : scenario === 'live' ? { livemode: true } : scenario === 'bank' ? { type: 'us_bank_account' } : { customer: null };
    vi.mocked(billing.stripe.paymentMethods.retrieve).mockResolvedValue({ ...card(), ...extra } as never);
    await expect(billing.setDefaultPaymentMethod(change())).rejects.toMatchObject({ code: 'PAYMENT_METHOD_UNAVAILABLE' });
    expect(billing.stripe.customers.update).not.toHaveBeenCalled();
  });
  it('sets only the customer default using its stable provider key', async () => {
    await billing.setDefaultPaymentMethod(change());
    expect(billing.stripe.customers.update).toHaveBeenCalledWith('cus_buyer1', { invoice_settings: { default_payment_method: 'pm_card1' } }, { idempotencyKey: 'saved-method:operation-1:default' });
  });
  it('clears a removed default and detaches it with separate stable keys', async () => {
    await billing.removePaymentMethod(change());
    expect(billing.stripe.customers.update).toHaveBeenCalledWith('cus_buyer1', { invoice_settings: { default_payment_method: '' } }, { idempotencyKey: 'saved-method:operation-1:clear-default' });
    expect(billing.stripe.paymentMethods.detach).toHaveBeenCalledWith('pm_card1', {}, { idempotencyKey: 'saved-method:operation-1:detach' });
  });
  it('recovers an already detached method only from prior host authorization, never a foreign customer', async () => {
    vi.mocked(billing.stripe.paymentMethods.retrieve).mockResolvedValue({ ...card(), customer: null } as never);
    await expect(billing.removePaymentMethod(change())).rejects.toMatchObject({ code: 'PAYMENT_METHOD_UNAVAILABLE' });
    await billing.removePaymentMethod(change(), true);
    expect(billing.stripe.paymentMethods.detach).not.toHaveBeenCalled();
    vi.mocked(billing.stripe.paymentMethods.retrieve).mockResolvedValue({ ...card(), customer: 'cus_other' } as never);
    await expect(billing.removePaymentMethod(change(), true)).rejects.toMatchObject({ code: 'PAYMENT_METHOD_UNAVAILABLE' });
  });
  it('returns only the receipt URL from the verified purchase/charge', async () => {
    expect(await receipt()).toEqual({ url: 'https://pay.stripe.com/receipts/test/owned' });
    expect(billing.stripe.paymentIntents.retrieve).toHaveBeenCalledWith('pi_owned1', { expand: ['latest_charge'] });
  });
  it.each(['customer', 'user', 'topup', 'amount', 'currency', 'mode', 'status'])('rejects receipt intent %s mismatches', async mismatch => {
    const extra = { customer: { customer: 'cus_other' }, user: { metadata: { ...intent().metadata, userId: 'other' } },
      topup: { metadata: { ...intent().metadata, topupId: 'other' } }, amount: { amount: 1001 }, currency: { currency: 'eur' }, mode: { livemode: true }, status: { status: 'processing' } }[mismatch];
    vi.mocked(billing.stripe.paymentIntents.retrieve).mockResolvedValue({ ...intent(), ...extra } as never);
    await expect(receipt()).rejects.toMatchObject({ code: 'RECEIPT_UNAVAILABLE' });
  });
  it.each(['customer', 'intent', 'mode', 'unpaid', 'amount'])('rejects receipt charge %s mismatches', async mismatch => {
    const extra = { customer: { customer: 'cus_other' }, intent: { payment_intent: 'pi_other' }, mode: { livemode: true }, unpaid: { paid: false }, amount: { amount: 1001 } }[mismatch];
    vi.mocked(billing.stripe.paymentIntents.retrieve).mockResolvedValue({ ...intent(), latest_charge: { ...charge(), ...extra } } as never);
    await expect(receipt()).rejects.toMatchObject({ code: 'RECEIPT_UNAVAILABLE' });
  });
  it.each(['http://pay.stripe.com/receipt', 'https://pay.stripe.com.evil.invalid/x', 'https://user@pay.stripe.com/x', null])('refuses unsafe or unavailable receipt URLs: %s', async receipt_url => {
    vi.mocked(billing.stripe.paymentIntents.retrieve).mockResolvedValue({ ...intent(), latest_charge: { ...charge(), receipt_url } } as never);
    await expect(receipt()).rejects.toMatchObject({ code: 'PROVIDER_URL_UNAVAILABLE' });
  });
});
