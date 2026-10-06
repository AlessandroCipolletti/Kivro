import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@kivro/database';
import { StripeBilling } from '@kivro/billing';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';
import { reconcilePayouts } from '../src/billing.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('payout lifecycle (real isolated PostgreSQL, synthetic Stripe SDK)', () => {
  let db: PrismaClient, app: FastifyInstance;
  const schema = `payouts_test_${randomBytes(8).toString('hex')}`;
  const secret = 'whsec_synthetic_payouts', billing = new StripeBilling('sk_test_synthetic_payouts', secret);
  const accounts = new Map<string, string>();
  type Payout = { id: string; object: string; amount: number; currency: string; status: string; livemode: boolean; created: number; arrival_date: number; failure_code: string | null; destination: string; failure_message: string };
  const provider = new Map<string, Payout[]>();
  const fixture = async () => {
    const id = randomUUID(), token = randomUUID(), apiKey = randomUUID(), accountId = `acct_${id.replaceAll('-', '')}`;
    await db.user.create({ data: { id, email: `${id}@payouts.kivro.invalid`, name: 'Synthetic seller', passwordHash: 'disabled-fixture-login',
      stripeConnectedAccountId: accountId, connectStatus: 'READY', payoutsEnabled: true, wallet: { create: { earnedMinor: 9000 } },
      sessions: { create: { tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + 3600_000) } },
      apiKeys: { create: { name: 'Test API key', prefix: apiKey.slice(0, 10), secretHash: hashSecret(apiKey), scopes: ['jobs:read'] } } } });
    accounts.set(accountId, id); provider.set(accountId, []);
    return { id, token, apiKey, accountId };
  };
  type Seller = Awaited<ReturnType<typeof fixture>>;
  const payout = (seller: Seller, overrides: Partial<Payout> = {}) => {
    const value: Payout = { id: `po_${randomBytes(12).toString('hex')}`, object: 'payout', amount: 1234, currency: 'usd', status: 'pending', livemode: false,
      created: Math.floor(Date.now() / 1000), arrival_date: Math.floor(Date.now() / 1000) + 86400, failure_code: null,
      destination: 'ba_never_expose', failure_message: 'private bank detail', ...overrides };
    provider.get(seller.accountId)!.unshift(value); return value;
  };
  const headers = (seller: Seller) => ({ cookie: `kivro_session=${seller.token}` });
  const get = (seller: Seller, url = '/api/seller/earnings') => app.inject({ method: 'GET', url, headers: headers(seller) });
  const event = (seller: Seller, value: Payout, type = 'payout.updated', changes: Record<string, unknown> = {}) => ({
    id: `evt_${randomBytes(12).toString('hex')}`, object: 'event', type, livemode: false, created: Math.floor(Date.now() / 1000), account: seller.accountId,
    data: { object: structuredClone(value) }, ...changes,
  });
  const send = (value: Record<string, unknown>) => {
    const payload = JSON.stringify(value);
    return app.inject({ method: 'POST', url: '/api/billing/webhook', payload,
      headers: { 'content-type': 'application/json', 'stripe-signature': billing.stripe.webhooks.generateTestHeaderString({ payload, secret }) } });
  };
  const syncKey = (seller: Seller) => `payout-sync:test:${seller.accountId}`;
  const resetDelay = async (seller: Seller, extra: Record<string, unknown> = {}) => {
    const saved = await db.platformSetting.findUnique({ where: { key: syncKey(seller) } });
    await db.platformSetting.upsert({ where: { key: syncKey(seller) }, create: { key: syncKey(seller), value: { nextAttemptAt: 0, ...extra } },
      update: { value: { ...(saved?.value as Record<string, never> ?? {}), nextAttemptAt: 0, ...extra } } });
  };
  beforeAll(async () => {
    process.loadEnvFile('.env');
    const url = new URL(process.env.DATABASE_URL!);
    if (process.env.KIVRO_ENV !== 'development' || url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/kivro') throw new Error('Requires isolated local development database');
    url.searchParams.set('schema', schema);
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url.toString() } });
    db = new PrismaClient({ datasourceUrl: url.toString() });
    vi.spyOn(billing.stripe.accounts, 'retrieve').mockImplementation(async id => ({ id, metadata: { kivroUserId: accounts.get(String(id)) } }) as never);
    vi.spyOn(billing.stripe.payouts, 'retrieve').mockImplementation((async (id: string, _params: unknown, options: { stripeAccount: string }) => {
      const found = provider.get(options!.stripeAccount!)?.find(row => row.id === id);
      if (!found) throw new Error('Missing connected-account fixture payout');
      return structuredClone(found) as never;
    }) as never);
    vi.spyOn(billing.stripe.payouts, 'list').mockImplementation((async (params: { limit: number; starting_after?: string }, options: { stripeAccount: string }) => {
      const rows = provider.get(options.stripeAccount)!;
      const cursor = params.starting_after ? rows.findIndex(row => row.id === params.starting_after) + 1 : 0;
      return { data: structuredClone(rows.slice(cursor, cursor + params.limit)), has_more: rows.length > cursor + params.limit } as never;
    }) as never);
    vi.spyOn(billing.stripe.payouts, 'create').mockRejectedValue(new Error('No payout creation authorized'));
    vi.spyOn(billing.stripe.transfers, 'create').mockRejectedValue(new Error('No extra transfer authorized'));
    app = await createApp({ env: { ...process.env, NODE_ENV: 'test', PAYMENT_MODE: 'stripe' }, db, billing, logger: false });
  });
  beforeEach(async () => {
    await db.$transaction([db.billingEvent.deleteMany(), db.payoutRecord.deleteMany(), db.platformSetting.deleteMany(), db.sellerTransfer.deleteMany(),
      db.auditEvent.deleteMany(), db.topup.deleteMany(), db.ledgerEntry.deleteMany(), db.session.deleteMany(), db.apiKey.deleteMany(), db.wallet.deleteMany(), db.user.deleteMany()]);
    accounts.clear(); provider.clear(); vi.clearAllMocks();
  });
  afterEach(() => {
    expect(billing.stripe.payouts.create).not.toHaveBeenCalled(); expect(billing.stripe.transfers.create).not.toHaveBeenCalled();
  });
  afterAll(async () => {
    vi.restoreAllMocks(); await app?.close();
    if (db) {
      if (!/^payouts_test_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe fixture schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await db.$disconnect();
    }
  });
  it('persists created/in-transit/paid/failed/canceled states and never double-counts a ledger/transfer withdrawal', async () => {
    const seller = await fixture(), value = payout(seller);
    await db.sellerTransfer.create({ data: { jobId: randomUUID(), sellerId: seller.id, amountMinor: 6000, state: 'TRANSFERRED', stripeTransferId: 'tr_existing', destinationAccountId: seller.accountId } });
    for (const [type, status] of [['payout.created', 'pending'], ['payout.updated', 'in_transit'], ['payout.paid', 'paid'], ['payout.failed', 'failed'], ['payout.canceled', 'canceled']]) {
      value.status = status!; value.failure_code = status === 'failed' ? 'account_closed' : null;
      const response = await send(event(seller, value, type)); expect(response.statusCode, response.body).toBe(200);
      expect(response.json().outcome).toBe('PAYOUT_RECONCILED');
      const earning = (await get(seller)).json();
      expect(earning).toMatchObject({ earnedMinor: 9000, transferredMinor: 6000, payoutSummary: { paidOutMinor: status === 'paid' ? 1234 : 0, accountWide: true } });
      expect(earning.payouts[0]).toMatchObject({ status });
      expect(earning.payouts[0].paidAt === null).toBe(status !== 'paid');
    }
    expect(await db.payoutRecord.count()).toBe(1); expect(await db.sellerTransfer.count()).toBe(1); expect(await db.ledgerEntry.count()).toBe(0);
    expect(await db.auditEvent.count({ where: { type: 'SELLER_PAYOUT_RECONCILED' } })).toBe(5);
  });
  it('deduplicates concurrent/replayed events and reads canonical state for old or same-second payloads', async () => {
    const seller = await fixture(), value = payout(seller), old = event(seller, value, 'payout.created', { created: 100 });
    value.status = 'paid';
    const paid = event(seller, value, 'payout.paid', { created: 200 });
    const responses = await Promise.all([send(paid), send(paid)]);
    expect(responses.every(response => response.statusCode === 200)).toBe(true);
    expect((await send(old)).statusCode).toBe(200);
    expect((await get(seller)).json().payoutSummary.paidOutMinor).toBe(1234);
    value.status = 'failed'; value.failure_code = 'account_closed';
    await send(event(seller, { ...value, status: 'paid', failure_code: null }, 'payout.paid', { created: 200 }));
    expect((await get(seller)).json().payoutSummary).toMatchObject({ paidOutMinor: 0, failedMinor: 1234 });
    expect(await db.payoutRecord.count()).toBe(1);
    expect(await db.auditEvent.count({ where: { type: 'SELLER_PAYOUT_RECONCILED' } })).toBe(2);
  });
  it('ignores platform/unknown account events and rejects bad signatures or cross-mode objects', async () => {
    const seller = await fixture(), value = payout(seller);
    for (const account of [undefined, 'acct_unknown']) expect((await send(event(seller, value, 'payout.paid', { account }))).json().outcome).toBe('IGNORED_PAYOUT_ACCOUNT');
    expect((await send(event(seller, { ...value, livemode: true }))).statusCode).toBe(400);
    expect((await send(event(seller, value, 'payout.paid', { livemode: true }))).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/billing/webhook', payload: event(seller, value), headers: { 'stripe-signature': 'invalid' } })).statusCode).toBe(400);
    expect(billing.stripe.payouts.retrieve).not.toHaveBeenCalled(); expect(await db.payoutRecord.count()).toBe(0);
  });
  it('does not allow connected Checkout events to credit platform buyer topups', async () => {
    const seller = await fixture(), value = payout(seller), id = randomUUID();
    await db.topup.create({ data: { id, userId: seller.id, idempotencyKey: randomUUID(), amountMinor: 1000 } });
    const response = await send(event(seller, value, 'checkout.session.completed', { data: { object: { id: 'cs_connected', object: 'checkout.session',
      mode: 'payment', livemode: false, payment_status: 'paid', amount_total: 1000, currency: 'usd', payment_intent: 'pi_connected', metadata: { topupId: id, userId: seller.id } } } }));
    expect(response.json().outcome).toBe('IGNORED_CONNECTED_EVENT'); expect(await db.ledgerEntry.count()).toBe(0);
    expect((await db.topup.findUniqueOrThrow({ where: { id } })).state).toBe('PENDING');
  });
  it('retains durable pending evidence when provider retrieval fails and recovers on maintenance retry', async () => {
    const seller = await fixture(), value = payout(seller, { status: 'paid' }), notification = event(seller, value);
    vi.mocked(billing.stripe.payouts.retrieve).mockRejectedValueOnce(new Error('private provider response / credential must not leak'));
    expect((await send(notification)).json().outcome).toBe('PAYOUT_PENDING'); expect(await db.payoutRecord.count()).toBe(0);
    const failed = (await get(seller)).json(); expect(failed.payoutSummary.lastError).toBe('PAYOUT_PROVIDER_UNAVAILABLE');
    expect(JSON.stringify(failed)).not.toContain('private provider');
    await resetDelay(seller); await reconcilePayouts(app.kivro);
    expect((await db.billingEvent.findUniqueOrThrow({ where: { id: notification.id } })).outcome).toBe('PAYOUT_RECONCILED');
    expect((await get(seller)).json().payoutSummary.paidOutMinor).toBe(1234);
  });
  it('fails closed on provider account ownership/mode/amount mismatch without replacing verified records', async () => {
    const seller = await fixture(), value = payout(seller, { status: 'paid' }); await send(event(seller, value));
    const stored = await db.payoutRecord.findFirstOrThrow();
    for (const data of [{ amountMinor: 9999 }, { stripePayoutId: 'po_rebound' }, { stripeAccountId: 'acct_rebound' }, { livemode: true }, { currency: 'CHF' }]) {
      await expect(db.payoutRecord.update({ where: { id: stored.id }, data })).rejects.toThrow('Payout identity and amount are immutable');
    }
    value.amount = 9999;
    await send(event(seller, value));
    expect((await get(seller)).json().payoutSummary).toMatchObject({ paidOutMinor: 1234, lastError: 'PAYOUT_IMMUTABLE_MISMATCH' });
    value.amount = 1234; value.livemode = true; await resetDelay(seller);
    await send(event(seller, { ...value, livemode: false }));
    expect((await get(seller)).json().payoutSummary.lastError).toBe('PAYOUT_PROVIDER_MISMATCH');
    value.livemode = false; accounts.set(seller.accountId, 'someone-else'); await resetDelay(seller);
    await send(event(seller, value));
    expect((await get(seller)).json().payoutSummary.lastError).toBe('PAYOUT_ACCOUNT_MISMATCH');
  });
  it('fences delayed provider responses after the account lease is replaced', async () => {
    const seller = await fixture(), value = payout(seller, { status: 'paid' });
    let release!: (value: never) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(billing.stripe.payouts.retrieve).mockImplementationOnce(async () => { entered(); return new Promise<never>(resolve => { release = resolve; }); });
    const pending = send(event(seller, value)); await started;
    await resetDelay(seller, { token: 'replacement-owner', leaseUntil: Date.now() + 60000 });
    release(structuredClone(value) as never); expect((await pending).json().outcome).toBe('PAYOUT_PENDING');
    expect(await db.payoutRecord.count()).toBe(0);
    value.status = 'failed'; await resetDelay(seller, { token: null, leaseUntil: 0 }); await reconcilePayouts(app.kivro);
    expect((await get(seller)).json().payoutSummary).toMatchObject({ paidOutMinor: 0, failedMinor: 1234 });
  });
  it('rechecks the seller account binding before committing a provider response', async () => {
    const seller = await fixture(), value = payout(seller, { status: 'paid' });
    vi.mocked(billing.stripe.payouts.retrieve).mockImplementationOnce(async () => {
      await db.user.update({ where: { id: seller.id }, data: { stripeConnectedAccountId: 'acct_replaced' } });
      return structuredClone(value) as never;
    });
    expect((await send(event(seller, value))).json().outcome).toBe('PAYOUT_PENDING');
    expect(await db.payoutRecord.count()).toBe(0);
  });
  it('keeps a later event pending when it arrives during an earlier canonical read', async () => {
    const seller = await fixture(), value = payout(seller, { status: 'paid' });
    let release!: (value: never) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(billing.stripe.payouts.retrieve).mockImplementationOnce(async () => { entered(); return new Promise<never>(resolve => { release = resolve; }); });
    const priorState = structuredClone(value);
    const first = send(event(seller, value)); await started;
    value.status = 'failed'; value.failure_code = 'account_closed';
    const later = event(seller, value, 'payout.failed');
    expect((await send(later)).json().outcome).toBe('PAYOUT_PENDING');
    release(priorState as never); await first;
    expect((await db.billingEvent.findUniqueOrThrow({ where: { id: later.id } })).outcome).toBe('PAYOUT_PENDING');
    await reconcilePayouts(app.kivro);
    expect((await db.billingEvent.findUniqueOrThrow({ where: { id: later.id } })).outcome).toBe('PAYOUT_RECONCILED');
    expect((await get(seller)).json().payoutSummary).toMatchObject({ paidOutMinor: 0, failedMinor: 1234 });
  });
  it('discovers missed webhooks with bounded backfill, refreshes the head and revisits older paid failures', async () => {
    const seller = await fixture();
    for (let i = 0; i < 45; i++) payout(seller, { id: `po_page${i}`, status: 'paid', amount: 100, created: 1800000000 + i });
    await reconcilePayouts(app.kivro);
    expect(await db.payoutRecord.count()).toBe(20); expect((await get(seller)).json().payoutSummary.historyComplete).toBe(false);
    await resetDelay(seller); await reconcilePayouts(app.kivro);
    expect(await db.payoutRecord.count()).toBe(40);
    await resetDelay(seller); await reconcilePayouts(app.kivro);
    expect(await db.payoutRecord.count()).toBe(45); expect((await get(seller)).json().payoutSummary).toMatchObject({ historyComplete: true, paidOutMinor: 4500 });
    provider.get(seller.accountId)!.at(-1)!.status = 'failed';
    for (let i = 0; i < 3; i++) { await resetDelay(seller); await reconcilePayouts(app.kivro); }
    expect((await get(seller)).json().payoutSummary).toMatchObject({ paidOutMinor: 4400, failedMinor: 100 });
    for (const call of vi.mocked(billing.stripe.payouts.list).mock.calls) expect(call[0]).toMatchObject({ limit: 20 });
  });
  it('makes fair progress past a failing seller and includes suspended or not-ready accounts', async () => {
    const sellers = await Promise.all([fixture(), fixture(), fixture()]);
    accounts.set(sellers[0]!.accountId, 'wrong-owner');
    await db.user.update({ where: { id: sellers[1]!.id }, data: { suspendedAt: new Date(), connectStatus: 'ACTION_REQUIRED', payoutsEnabled: false } });
    for (const seller of sellers) payout(seller, { status: 'paid' });
    for (let i = 0; i < 4; i++) await reconcilePayouts(app.kivro);
    expect(await db.payoutRecord.count()).toBe(2);
    expect(await db.payoutRecord.count({ where: { sellerId: sellers[1]!.id } })).toBe(1);
  });
  it('requires owner sessions and paginates without foreign, cross-mode or sensitive fields', async () => {
    const seller = await fixture(), other = await fixture();
    for (let i = 0; i < 21; i++) payout(seller, { status: 'paid', created: 1800000000 + i });
    for (let i = 0; i < 4; i++) { await resetDelay(seller); await resetDelay(other); await reconcilePayouts(app.kivro); }
    const first = await get(seller, '/api/seller/payouts'); expect(first.json().items).toHaveLength(20); expect(first.json().hasMore).toBe(true);
    expect(first.body).not.toMatch(/acct_|po_|ba_|private bank|stripeAccount|sellerId/);
    expect((await get(seller, `/api/seller/payouts?after=${first.json().nextCursor}`)).json().items).toHaveLength(1);
    expect((await get(other, `/api/seller/payouts?after=${first.json().nextCursor}`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/seller/payouts' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/seller/payouts', headers: { authorization: `Bearer ${seller.apiKey}` } })).statusCode).toBe(403);
    const row = await db.payoutRecord.findFirstOrThrow();
    await db.payoutRecord.create({ data: { sellerId: seller.id, stripeAccountId: seller.accountId, stripePayoutId: 'po_live', livemode: true, amountMinor: 999999,
      currency: 'USD', status: 'paid', providerCreatedAt: row.providerCreatedAt, arrivalDate: row.arrivalDate, lastSyncedAt: new Date() } });
    expect((await get(seller)).json().payoutSummary.paidOutMinor).toBe(21 * 1234);
  });
  it('does not convert non-USD payouts into USD totals or fabricate payouts in fake mode', async () => {
    const seller = await fixture(), value = payout(seller, { status: 'paid', currency: 'chf' }); await send(event(seller, value));
    const earning = (await get(seller)).json(); expect(earning.payoutSummary.paidOutMinor).toBe(0); expect(earning.payouts[0].currency).toBe('CHF');
    const fake = await createApp({ env: { ...process.env, NODE_ENV: 'test', PAYMENT_MODE: 'fake' }, db, billing: null, logger: false });
    try {
      expect((await fake.inject({ method: 'GET', url: '/api/seller/earnings', headers: headers(seller) })).json().payoutSummary).toMatchObject({ available: false, reason: 'DEVELOPMENT_PAYMENTS', paidOutMinor: 0 });
      expect((await fake.inject({ method: 'GET', url: '/api/seller/payouts', headers: headers(seller) })).json().items).toEqual([]);
    } finally { await fake.close(); }
  });
});
