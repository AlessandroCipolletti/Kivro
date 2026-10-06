import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StripeBilling } from './stripe.js';

describe('connected payout reads (synthetic SDK, no provider requests)', () => {
  const billing = new StripeBilling('sk_test_synthetic_payouts', 'whsec_synthetic_payouts');
  const owner = { sellerId: 'seller-1', accountId: 'acct_seller1' };
  const payout = () => ({ id: 'po_owned1', object: 'payout', livemode: false, amount: 1234, currency: 'usd', status: 'paid',
    created: 1800000000, arrival_date: 1800086400, failure_code: null, destination: 'ba_private', failure_message: 'private bank detail', metadata: { private: 'secret' } });
  beforeEach(() => {
    vi.spyOn(billing.stripe.accounts, 'retrieve').mockResolvedValue({ id: owner.accountId, metadata: { kivroUserId: owner.sellerId } } as never);
    vi.spyOn(billing.stripe.payouts, 'retrieve').mockResolvedValue(payout() as never);
    vi.spyOn(billing.stripe.payouts, 'list').mockResolvedValue({ data: [payout()], has_more: false } as never);
    vi.spyOn(billing.stripe.payouts, 'create').mockRejectedValue(new Error('No payout mutation is authorized'));
  });
  afterEach(() => { expect(billing.stripe.payouts.create).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  it('uses an owned Connect account header and fixed request bounds, returning only safe payout fields', async () => {
    expect(await billing.payout({ ...owner, payoutId: 'po_owned1' })).toEqual({ id: 'po_owned1', amountMinor: 1234, currency: 'USD', status: 'paid',
      providerCreatedAt: new Date(1800000000000), arrivalDate: new Date(1800086400000), failureCode: null });
    expect(billing.stripe.payouts.retrieve).toHaveBeenCalledWith('po_owned1', {}, { stripeAccount: owner.accountId, timeout: 3000, maxNetworkRetries: 0 });
    expect(billing.stripe.accounts.retrieve).toHaveBeenCalledWith(owner.accountId, { timeout: 3000, maxNetworkRetries: 0 });
  });
  it('rejects another account owner before any payout read', async () => {
    vi.mocked(billing.stripe.accounts.retrieve).mockResolvedValue({ id: owner.accountId, metadata: { kivroUserId: 'other-seller' } } as never);
    await expect(billing.payout({ ...owner, payoutId: 'po_owned1' })).rejects.toMatchObject({ code: 'PAYOUT_ACCOUNT_MISMATCH' });
    expect(billing.stripe.payouts.retrieve).not.toHaveBeenCalled();
  });
  it.each([
    { livemode: true }, { id: 'po_someoneelse' }, { status: 'invented' }, { amount: -1 }, { amount: 2147483648 },
    { amount: 1.5 }, { currency: 'usd\n' }, { created: NaN }, { arrival_date: 0 }, { failure_code: 'private bank message' }, { object: 'charge' },
  ])('rejects invalid provider identity/mode/fields %j', async change => {
    vi.mocked(billing.stripe.payouts.retrieve).mockResolvedValue({ ...payout(), ...change } as never);
    await expect(billing.payout({ ...owner, payoutId: 'po_owned1' })).rejects.toMatchObject({ code: 'PAYOUT_PROVIDER_MISMATCH' });
  });
  it('uses bounded account-scoped pagination and retains non-USD currency without conversion', async () => {
    vi.mocked(billing.stripe.payouts.list).mockResolvedValue({ data: [{ ...payout(), currency: 'chf', status: 'failed', failure_code: 'account_closed' }], has_more: true } as never);
    expect(await billing.payouts({ ...owner, after: 'po_previous' })).toMatchObject({ items: [{ currency: 'CHF', status: 'failed', failureCode: 'account_closed' }], hasMore: true, nextCursor: 'po_owned1' });
    expect(billing.stripe.payouts.list).toHaveBeenCalledWith({ limit: 20, starting_after: 'po_previous' }, { stripeAccount: owner.accountId, timeout: 3000, maxNetworkRetries: 0 });
  });
  it.each(['empty-more', 'oversized', 'duplicate', 'cross-mode'])('rejects a malformed %s page', async scenario => {
    const data = scenario === 'empty-more' ? [] : scenario === 'oversized' ? Array.from({ length: 21 }, (_, i) => ({ ...payout(), id: `po_${i}` }))
      : scenario === 'duplicate' ? [payout(), payout()] : [{ ...payout(), livemode: true }];
    vi.mocked(billing.stripe.payouts.list).mockResolvedValue({ data, has_more: scenario === 'empty-more' } as never);
    await expect(billing.payouts(owner)).rejects.toMatchObject({ code: 'PAYOUT_PROVIDER_MISMATCH' });
  });
  it('rejects arbitrary path/account/cursor input before provider access', async () => {
    await expect(billing.payout({ ...owner, payoutId: 'po_x/../../charges' })).rejects.toThrow();
    await expect(billing.payouts({ ...owner, after: 'https://evil.invalid' })).rejects.toThrow();
    await expect(billing.payouts({ ...owner, accountId: 'acct_x/secret' })).rejects.toThrow();
    expect(billing.stripe.accounts.retrieve).not.toHaveBeenCalled();
    expect(billing.stripe.payouts.list).not.toHaveBeenCalled();
  });
  it('rejects non-boolean pagination metadata and a cursor that makes no progress', async () => {
    vi.mocked(billing.stripe.payouts.list).mockResolvedValue({ data: [payout()], has_more: 'false' } as never);
    await expect(billing.payouts(owner)).rejects.toMatchObject({ code: 'PAYOUT_PROVIDER_MISMATCH' });
    vi.mocked(billing.stripe.payouts.list).mockResolvedValue({ data: [payout()], has_more: true } as never);
    await expect(billing.payouts({ ...owner, after: 'po_owned1' })).rejects.toMatchObject({ code: 'PAYOUT_PROVIDER_MISMATCH' });
  });
  it('accepts the separate Connect destination secret only for account-scoped, correct-mode events', () => {
    const dual = new StripeBilling('sk_test_synthetic', 'whsec_platform', 'whsec_connect');
    const payload = (account?: string, livemode = false) => JSON.stringify({ id: 'evt_example', object: 'event', type: 'payout.paid',
      created: Math.floor(Date.now() / 1000), account, livemode, data: { object: { ...payout(), livemode } } });
    const signature = (body: string, secret: string) => dual.stripe.webhooks.generateTestHeaderString({ payload: body, secret });
    const connected = payload(owner.accountId), platform = payload();
    expect(dual.verifyWebhook(Buffer.from(connected), signature(connected, 'whsec_connect')).account).toBe(owner.accountId);
    expect(dual.verifyWebhook(Buffer.from(platform), signature(platform, 'whsec_platform')).account).toBeUndefined();
    expect(() => dual.verifyWebhook(Buffer.from(platform), signature(platform, 'whsec_connect'))).toThrow('Connect signing secret cannot authorize platform events');
    expect(() => dual.verifyWebhook(Buffer.from(connected), signature(connected, 'whsec_untrusted'))).toThrow();
    const live = payload(owner.accountId, true);
    expect(() => dual.verifyWebhook(Buffer.from(live), signature(live, 'whsec_connect'))).toThrow('Stripe event mode does not match');
  });
});
