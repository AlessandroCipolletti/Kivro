import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@kivro/database';
import { SAVED_METHOD_CONSENT, StripeBilling } from '@kivro/billing';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('buyer saved methods/receipts (real isolated PostgreSQL, synthetic Stripe SDK)', () => {
  let db: PrismaClient, app: FastifyInstance;
  const schema = `methods_test_${randomBytes(8).toString('hex')}`;
  const billing = new StripeBilling('sk_test_synthetic_saved_methods', 'whsec_synthetic_saved_methods');
  const origin = 'http://localhost:3000';
  const customers = new Map<string, { id: string; livemode: boolean; metadata: { kivroUserId: string }; invoice_settings: { default_payment_method: string | null } }>();
  const methods = new Map<string, { id: string; customer: string | null; livemode: boolean; type: string; card: { brand: string; last4: string; exp_month: number; exp_year: number } }>();
  const sessions = new Map<string, Record<string, unknown>>();
  let failDetach = false, failSetup = false;
  const fixture = async () => {
    const id = randomUUID(), token = randomUUID(), apiKey = randomUUID(), suffix = id.replaceAll('-', '');
    const customerId = `cus_${suffix}`, methodId = `pm_${suffix}`;
    customers.set(customerId, { id: customerId, livemode: false, metadata: { kivroUserId: id }, invoice_settings: { default_payment_method: methodId } });
    methods.set(methodId, { id: methodId, customer: customerId, livemode: false, type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2035 } });
    await db.user.create({ data: { id, email: `${id}@methods.kivro.invalid`, name: 'Synthetic buyer', passwordHash: 'disabled-fixture-login', stripeCustomerId: customerId,
      wallet: { create: {} }, sessions: { create: { tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + 3600_000) } },
      apiKeys: { create: { name: 'Read-only test', prefix: apiKey.slice(0, 10), secretHash: hashSecret(apiKey), scopes: ['jobs:read'] } } } });
    return { id, token, apiKey, customerId, methodId };
  };
  type Buyer = Awaited<ReturnType<typeof fixture>>;
  const headers = (user?: Buyer, key = randomUUID()) => ({ origin, 'content-type': 'application/json', 'idempotency-key': key, ...(user ? { cookie: `kivro_session=${user.token}` } : {}) });
  const get = (url: string, user?: Buyer) => app.inject({ method: 'GET', url, headers: headers(user) });
  const post = (url: string, payload: Record<string, unknown>, user?: Buyer, key = randomUUID()) => app.inject({ method: 'POST', url, payload, headers: headers(user, key) });
  const setup = (user: Buyer, key = randomUUID()) => post('/api/billing/payment-methods/setup', { consentAccepted: true, consentVersion: SAVED_METHOD_CONSENT.version }, user, key);
  const sendSetup = (session: Record<string, unknown>, eventId = `evt_${randomUUID()}`) => {
    const payload = JSON.stringify({ id: eventId, object: 'event', created: Math.floor(Date.now() / 1000), type: 'checkout.session.completed', livemode: false,
      data: { object: { ...session, status: 'complete', payment_status: 'no_payment_required', setup_intent: 'seti_fixture' } } });
    return app.inject({ method: 'POST', url: '/api/billing/webhook', payload,
      headers: { 'content-type': 'application/json', 'stripe-signature': billing.stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_synthetic_saved_methods' }) } });
  };
  beforeAll(async () => {
    process.loadEnvFile('.env');
    const url = new URL(process.env.DATABASE_URL!);
    if (process.env.KIVRO_ENV !== 'development' || url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/kivro') throw new Error('Requires local development database');
    url.searchParams.set('schema', schema);
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url.toString() } });
    db = new PrismaClient({ datasourceUrl: url.toString() });
    // These are the only simulated boundary objects; routes, guards, adapter and DB are real.
    vi.spyOn(billing.stripe.customers, 'retrieve').mockImplementation(async id => structuredClone(customers.get(id)) as never);
    vi.spyOn(billing.stripe.customers, 'create').mockRejectedValue(new Error('Unexpected provider customer creation'));
    vi.spyOn(billing.stripe.customers, 'listPaymentMethods').mockImplementation((async (id: string, params?: { starting_after?: string }) => {
      const all = [...methods.values()].filter(method => method.customer === id);
      const cursor = params?.starting_after ? all.findIndex(method => method.id === params.starting_after) + 1 : 0;
      return { data: structuredClone(all.slice(cursor, cursor + 20)), has_more: all.length > cursor + 20 } as never;
    }) as never);
    vi.spyOn(billing.stripe.paymentMethods, 'retrieve').mockImplementation(async id => {
      const method = methods.get(id); if (!method) throw Object.assign(new Error('Missing fixture method'), { code: 'resource_missing' });
      return structuredClone(method) as never;
    });
    vi.spyOn(billing.stripe.customers, 'update').mockImplementation(async (id, params) => {
      customers.get(id)!.invoice_settings.default_payment_method = params?.invoice_settings?.default_payment_method || null;
      return structuredClone(customers.get(id)) as never;
    });
    vi.spyOn(billing.stripe.paymentMethods, 'detach').mockImplementation(async id => {
      const method = methods.get(id)!; method.customer = null;
      if (failDetach) { failDetach = false; throw new Error('Simulated response loss after Stripe detach'); }
      return structuredClone(method) as never;
    });
    vi.spyOn(billing.stripe.checkout.sessions, 'create').mockImplementation((async (params?: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
      const key = options!.idempotencyKey!;
      if (!sessions.has(key)) sessions.set(key, { ...params, id: `cs_test_${randomBytes(12).toString('hex')}`, livemode: false,
        url: 'https://checkout.stripe.com/c/pay/test_fixture', status: 'open' });
      if (failSetup) { failSetup = false; throw new Error('Simulated response loss after Stripe setup'); }
      return structuredClone(sessions.get(key)) as never;
    }) as never);
    vi.spyOn(billing.stripe.paymentIntents, 'retrieve').mockRejectedValue(new Error('Unexpected provider payment-intent retrieval'));
    vi.spyOn(billing.stripe.charges, 'retrieve').mockRejectedValue(new Error('Unexpected provider charge retrieval'));
    app = await createApp({ env: { ...process.env, NODE_ENV: 'test', PAYMENT_MODE: 'stripe', WEB_ORIGIN: origin }, db, billing, logger: false });
  });
  afterAll(async () => {
    vi.restoreAllMocks(); await app?.close();
    if (db) {
      if (!/^methods_test_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe fixture schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await db.$disconnect();
    }
  });
  it('requires sessions for list, mutation and receipt routes and rejects cross-site mutations', async () => {
    const user = await fixture();
    for (const url of ['/api/billing/payment-methods', '/api/billing/receipts', `/api/billing/receipts/${randomUUID()}`]) {
      expect((await get(url)).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${user.apiKey}` } })).statusCode).toBe(403);
    }
    expect((await post(`/api/billing/payment-methods/${user.methodId}/remove`, {})).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/billing/payment-methods/${user.methodId}/remove`, payload: {}, headers: { ...headers(user), origin: 'https://attacker.invalid' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/billing/payment-methods/${user.methodId}/remove`, payload: {}, headers: { authorization: `Bearer ${user.apiKey}` } })).statusCode).toBe(403);
  });
  it('projects masked cards/default without storing card details and rejects foreign cursors', async () => {
    const user = await fixture(), other = await fixture();
    const response = await get('/api/billing/payment-methods', user);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ available: true, defaultPaymentMethodId: user.methodId, consent: SAVED_METHOD_CONSENT,
      methods: [{ id: user.methodId, last4: '4242', isDefault: true }], pendingOperation: null });
    expect((await get(`/api/billing/payment-methods?after=${other.methodId}`, user)).statusCode).toBe(404);
    expect(await db.idempotencyRecord.count({ where: { userId: user.id } })).toBe(0);
  });
  it('requires explicit current consent, a key and a strict body before creating hosted setup', async () => {
    const user = await fixture();
    for (const body of [{}, { consentAccepted: false, consentVersion: SAVED_METHOD_CONSENT.version }, { consentAccepted: true, consentVersion: 'outdated' },
      { consentAccepted: true, consentVersion: SAVED_METHOD_CONSENT.version, cardNumber: '4242424242424242' }]) {
      expect((await post('/api/billing/payment-methods/setup', body, user)).statusCode).toBe(400);
    }
    const noKey = await app.inject({ method: 'POST', url: '/api/billing/payment-methods/setup', payload: { consentAccepted: true, consentVersion: SAVED_METHOD_CONSENT.version }, headers: { origin, cookie: `kivro_session=${user.token}` } });
    expect(noKey.statusCode).toBe(400);
    expect(await db.idempotencyRecord.count({ where: { userId: user.id } })).toBe(0);
  });
  it('persists consent before Stripe and replays one setup without creating credit or duplicate audit', async () => {
    const user = await fixture(), key = randomUUID();
    const first = await setup(user, key), second = await setup(user, key);
    expect(first.statusCode, first.body).toBe(200); expect(second.json()).toEqual(first.json());
    const operation = await db.idempotencyRecord.findFirstOrThrow({ where: { userId: user.id, key } });
    const consent = await db.auditEvent.findMany({ where: { actorId: user.id, type: 'BUYER_SAVED_METHOD_CONSENT' } });
    expect(consent).toHaveLength(1); expect(consent[0]!.metadata).toMatchObject({ consentAccepted: true, consentVersion: SAVED_METHOD_CONSENT.version, operationId: operation.id });
    const session = sessions.get(`saved-method:${operation.id}:setup`)!;
    expect(session).toMatchObject({ mode: 'setup', customer: user.customerId });
    expect(session).not.toHaveProperty('line_items');
    expect(await db.ledgerEntry.count({ where: { userId: user.id } })).toBe(0);
    expect(JSON.stringify(operation.response)).not.toMatch(/cardNumber|last4|fingerprint/);
    const conflicting = await post(`/api/billing/payment-methods/${user.methodId}/default`, {}, user, key);
    expect(conflicting.statusCode).toBe(409); expect(conflicting.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('handles signed setup completion idempotently without entering the topup credit branch', async () => {
    const user = await fixture(), key = randomUUID(); await setup(user, key);
    const operation = await db.idempotencyRecord.findFirstOrThrow({ where: { userId: user.id, key } });
    const session = sessions.get(`saved-method:${operation.id}:setup`)!;
    const eventId = `evt_${randomUUID()}`;
    expect((await sendSetup(session, eventId)).json()).toMatchObject({ received: true, outcome: 'SETUP_COMPLETED' });
    expect((await sendSetup(session, eventId)).statusCode).toBe(200);
    expect((await sendSetup(session)).statusCode).toBe(200);
    expect(await db.auditEvent.count({ where: { actorId: user.id, type: 'BUYER_PAYMENT_METHOD_SETUP_COMPLETED' } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.topup.count({ where: { userId: user.id } })).toBe(0);
    expect((await sendSetup({ ...session, customer: 'cus_foreign' })).statusCode).toBe(400);
    const forged = await app.inject({ method: 'POST', url: '/api/billing/webhook', payload: session, headers: { 'stripe-signature': 'invalid' } });
    expect(forged.statusCode).toBe(400);
  });
  it('rejects cross-customer removal/default, missing methods and raw payment fields', async () => {
    const user = await fixture(), other = await fixture();
    for (const action of ['default', 'remove']) {
      const response = await post(`/api/billing/payment-methods/${other.methodId}/${action}`, {}, user);
      expect(response.statusCode, response.body).toBe(404);
      expect((await post(`/api/billing/payment-methods/${user.methodId}/${action}`, { customerId: other.customerId }, user)).statusCode).toBe(400);
    }
    expect((await post('/api/billing/payment-methods/pm_nonexistent/remove', {}, user)).statusCode).toBe(404);
    expect(methods.get(other.methodId)!.customer).toBe(other.customerId);
  });
  it('sets and removes the default once, and replays success without repeating provider writes', async () => {
    const user = await fixture(), defaultKey = randomUUID(), removeKey = randomUUID();
    const updates = vi.mocked(billing.stripe.customers.update).mock.calls.length;
    const detached = vi.mocked(billing.stripe.paymentMethods.detach).mock.calls.length;
    expect((await post(`/api/billing/payment-methods/${user.methodId}/default`, {}, user, defaultKey)).statusCode).toBe(200);
    expect((await post(`/api/billing/payment-methods/${user.methodId}/default`, {}, user, defaultKey)).statusCode).toBe(200);
    expect((await post(`/api/billing/payment-methods/${user.methodId}/remove`, {}, user, removeKey)).statusCode).toBe(200);
    expect((await post(`/api/billing/payment-methods/${user.methodId}/remove`, {}, user, removeKey)).statusCode).toBe(200);
    expect(vi.mocked(billing.stripe.customers.update).mock.calls.length - updates).toBe(2);
    expect(vi.mocked(billing.stripe.paymentMethods.detach).mock.calls.length - detached).toBe(1);
    expect((await get('/api/billing/payment-methods', user)).json()).toMatchObject({ methods: [], defaultPaymentMethodId: null });
  });
  it('serializes simultaneous buyer mutations and retry keys across requests', async () => {
    const user = await fixture(), key = randomUUID();
    const results = await Promise.all([setup(user, key), setup(user, key)]);
    expect(results.some(result => result.statusCode === 200)).toBe(true);
    expect(results.every(result => [200, 409].includes(result.statusCode))).toBe(true);
    expect((await setup(user, key)).statusCode).toBe(200);
    expect(await db.idempotencyRecord.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { actorId: user.id, type: 'BUYER_PAYMENT_METHOD_OPERATION_COMPLETED' } })).toBe(1);
  });
  it('recovers an uncertain detach using persisted ownership, blocking unrelated mutations until retry', async () => {
    const user = await fixture(), key = randomUUID(); failDetach = true;
    const failed = await post(`/api/billing/payment-methods/${user.methodId}/remove`, {}, user, key);
    expect(failed.statusCode).toBe(503); expect(failed.json().error.code).toBe('BILLING_PROVIDER_UNCERTAIN');
    expect(methods.get(user.methodId)!.customer).toBeNull();
    expect((await setup(user)).json().error.code).toBe('BILLING_OPERATION_PENDING');
    const listing = await get('/api/billing/payment-methods', user);
    expect(listing.json().pendingOperation).toMatchObject({ key, action: 'remove', paymentMethodId: user.methodId });
    expect((await post(`/api/billing/payment-methods/${user.methodId}/remove`, {}, user, key)).statusCode).toBe(200);
    expect((await get('/api/billing/payment-methods', user)).json().pendingOperation).toBeNull();
  });
  it('reuses identical provider setup parameters after lost responses and rejects unsafe late replay', async () => {
    const user = await fixture(), key = randomUUID(); failSetup = true;
    expect((await setup(user, key)).statusCode).toBe(503);
    expect((await setup(user, key)).statusCode).toBe(200);
    const operation = await db.idempotencyRecord.findFirstOrThrow({ where: { userId: user.id, key } });
    const recorded = vi.mocked(billing.stripe.checkout.sessions.create).mock.calls as unknown as [Record<string, unknown>, { idempotencyKey: string }][];
    const calls = recorded.filter(([, options]) => options.idempotencyKey === `saved-method:${operation.id}:setup`);
    expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1]);
    const other = await fixture(), oldKey = randomUUID(); failSetup = true; await setup(other, oldKey);
    await db.idempotencyRecord.updateMany({ where: { userId: other.id, key: oldKey }, data: { createdAt: new Date(Date.now() - 21 * 3600_000) } });
    const late = await setup(other, oldKey);
    expect(late.statusCode).toBe(409); expect(late.json().error.code).toBe('BILLING_RECONCILIATION_REQUIRED');
  });
  it('exposes only owned paid provider receipts and verifies the intent/charge binding before returning URLs', async () => {
    const user = await fixture(), other = await fixture(), id = randomUUID();
    await db.topup.create({ data: { id, userId: user.id, idempotencyKey: randomUUID(), amountMinor: 1000, state: 'PAID', paymentIntentId: 'pi_receiptfixture', livemode: false } });
    await db.topup.create({ data: { userId: user.id, idempotencyKey: randomUUID(), amountMinor: 1000, state: 'PAID' } }); // Fake credit is not a Stripe receipt.
    const charge = { id: 'ch_receiptfixture', customer: user.customerId, payment_intent: 'pi_receiptfixture', livemode: false,
      paid: true, currency: 'usd', amount: 1000, receipt_url: 'https://pay.stripe.com/receipts/test/owned' };
    const intent = { id: 'pi_receiptfixture', customer: user.customerId, livemode: false, currency: 'usd', amount: 1000, status: 'succeeded', metadata: { topupId: id, userId: user.id }, latest_charge: charge };
    vi.mocked(billing.stripe.paymentIntents.retrieve).mockResolvedValue(intent as never);
    const list = await get('/api/billing/receipts', user);
    expect(list.json().items).toHaveLength(1); expect(list.json().items[0]).toMatchObject({ id, amountMinor: 1000, receiptAvailable: true });
    expect((await get(`/api/billing/receipts/${id}`, other)).statusCode).toBe(404);
    expect((await get(`/api/billing/receipts?after=${id}`, other)).statusCode).toBe(404);
    expect((await get(`/api/billing/receipts/${id}`, user)).json()).toEqual({ url: charge.receipt_url });
    vi.mocked(billing.stripe.paymentIntents.retrieve).mockResolvedValue({ ...intent, customer: other.customerId } as never);
    expect((await get(`/api/billing/receipts/${id}`, user)).statusCode).toBe(404);
  });
  it('reports honest unavailability with fake payments and never creates synthetic methods', async () => {
    const user = await fixture();
    const fake = await createApp({ env: { ...process.env, PAYMENT_MODE: 'fake', NODE_ENV: 'test', WEB_ORIGIN: origin }, db, billing: null, logger: false });
    try {
      const result = await fake.inject({ method: 'GET', url: '/api/billing/payment-methods', headers: headers(user) });
      expect(result.json()).toMatchObject({ available: false, reason: 'DEVELOPMENT_PAYMENTS', methods: [] });
      const result2 = await fake.inject({ method: 'POST', url: '/api/billing/payment-methods/setup', headers: headers(user), payload: { consentAccepted: true, consentVersion: SAVED_METHOD_CONSENT.version } });
      expect(result2.statusCode).toBe(503);
    } finally { await fake.close(); }
  });
});
