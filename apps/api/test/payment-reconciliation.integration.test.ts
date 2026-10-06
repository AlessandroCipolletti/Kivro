import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient, json, serializable } from '@kivro/database';
import { StripeBilling, reserveJob, settleJob, refundJob } from '@kivro/billing';
import { DEFAULT_SCHEDULE, getPriceTier } from '@kivro/contracts';
import { createApp } from '../src/app.js';
import { reconcilePayments } from '../src/payment-reconciliation.js';
import { restoreBillingAccount } from '../src/disputes.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('canonical payment recovery (real PostgreSQL and loopback Stripe HTTP fixture)', () => {
  let db: PrismaClient, app: FastifyInstance, server: Server, schema: string, origin: string, billing: StripeBilling, startApp: () => Promise<FastifyInstance>;
  const key = 'sk_test_reconciliation_synthetic_only', secret = 'whsec_reconciliation_synthetic_only', scanKey = 'billing-reconciliation:test';
  type ObjectData = Record<string, unknown>;
  const sessions = new Map<string, ObjectData>(), customers = new Map<string, ObjectData>(), intents = new Map<string, ObjectData>();
  const disputes = new Map<string, ObjectData>(), transfers = new Map<string, ObjectData>();
  const calls: { path: string; query: URLSearchParams; method: string }[] = [];
  const failures = new Map<string, number>();
  const overrides = new Map<string, ObjectData>();
  let intercept: ((path: string) => Promise<void>) | null = null, sequence = 0;
  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const url = new URL(request.url!, 'http://fixture.local'), path = url.pathname;
      calls.push({ path, query: url.searchParams, method: request.method! });
      response.setHeader('content-type', 'application/json');
      if (request.headers.authorization !== `Bearer ${key}` || request.method !== 'GET') { response.writeHead(403); response.end(JSON.stringify({ error: { message: 'Fixture permits dedicated-key GETs only' } })); return; }
      await intercept?.(path);
      if (failures.get(path)) { failures.set(path, failures.get(path)! - 1); response.writeHead(503); response.end(JSON.stringify({ error: { type: 'api_error', message: 'Synthetic unavailable provider' } })); return; }
      if (overrides.has(path)) { response.end(JSON.stringify(overrides.get(path))); return; }
      const list = (rows: ObjectData[]) => {
        rows.sort((a, b) => Number(b.created) - Number(a.created));
        const after = url.searchParams.get('starting_after'), index = after ? rows.findIndex(row => row.id === after) : -1;
        if (after && index < 0) { response.writeHead(400); return { error: { type: 'invalid_request_error', param: 'starting_after', message: 'Synthetic expired cursor' } }; }
        const limit = Number(url.searchParams.get('limit'));
        return { object: 'list', data: rows.slice(index + 1, index + 1 + limit), has_more: rows.length > index + 1 + limit, url: path };
      };
      let result: unknown;
      if (path === '/v1/checkout/sessions') result = list([...sessions.values()]);
      else if (path === '/v1/disputes') result = list([...disputes.values()].filter(row => row.payment_intent === url.searchParams.get('payment_intent')));
      else if (path.startsWith('/v1/checkout/sessions/')) result = sessions.get(path.split('/').at(-1)!);
      else if (path.startsWith('/v1/customers/')) result = customers.get(path.split('/').at(-1)!);
      else if (path.startsWith('/v1/payment_intents/')) result = intents.get(path.split('/').at(-1)!);
      else if (path.startsWith('/v1/transfers/')) result = transfers.get(path.split('/').at(-1)!);
      if (!result) { response.writeHead(404); result = { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No synthetic fixture object' } }; }
      response.end(JSON.stringify(result));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    for (const map of [sessions, customers, intents, disputes, transfers, failures, overrides]) map.clear();
    calls.length = 0; intercept = null; sequence = 0;
    schema = `payment_reconcile_${randomBytes(8).toString('hex')}`;
    const DATABASE_URL = `postgresql://kivro:kivro_local_only@127.0.0.1:55432/kivro?schema=${schema}`;
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL } });
    db = new PrismaClient({ datasourceUrl: DATABASE_URL });
    billing = new StripeBilling(key, secret);
    // Real pinned SDK transport, redirected only inside this test to an isolated HTTP provider fixture.
    const Client = createRequire(createRequire(import.meta.url).resolve('@kivro/billing'))('stripe') as new (key: string, options: object) => typeof billing.stripe;
    Object.defineProperty(billing, 'stripe', { value: new Client(key, { host: '127.0.0.1', port: Number(new URL(origin).port), protocol: 'http', apiVersion: '2025-03-31.basil', maxNetworkRetries: 0 }) });
    expect(billing.stripe.webhooks.generateTestHeaderString).toBeTypeOf('function');
    startApp = () => createApp({ db, billing, logger: false, mailer: null, env: { NODE_ENV: 'test', KIVRO_ENV: 'test', PAYMENT_MODE: 'stripe', DATABASE_URL,
      WEB_ORIGIN: 'http://localhost:3000', S3_ENDPOINT: 'http://127.0.0.1:59000', S3_BUCKET: 'unused-payment-reconciliation', S3_ACCESS_KEY: 'unused', S3_SECRET_KEY: 'unused' } });
    app = await startApp();
  });
  afterEach(async () => {
    intercept = null; await app?.close();
    if (db) {
      if (!/^payment_reconcile_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe fixture schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await db.$disconnect();
    }
  });
  afterAll(async () => { server?.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const run = () => reconcilePayments(app.kivro);
  const send = async (type: string, object: unknown, created = Math.floor(Date.now() / 1000), id = `evt_${randomUUID()}`) => {
    const payload = JSON.stringify({ id, object: 'event', api_version: '2025-03-31.basil', livemode: false, created, type, data: { object } });
    return app.inject({ method: 'POST', url: '/api/billing/webhook', payload, headers: { 'content-type': 'application/json', 'stripe-signature': billing.stripe.webhooks.generateTestHeaderString({ payload, secret }) } });
  };
  const fixture = async (bound = true, id = randomUUID()) => {
    const userId = randomUUID(), customerId = `cus_${userId.replaceAll('-', '')}`, sessionId = `cs_test_${id.replaceAll('-', '')}`, intentId = `pi_${id.replaceAll('-', '')}`, chargeId = `ch_${id.replaceAll('-', '')}`;
    await db.user.create({ data: { id: userId, email: `${userId}@canonical.kivro.local`, name: 'Synthetic canonical buyer', passwordHash: 'disabled', stripeCustomerId: bound ? customerId : null, wallet: { create: {} } } });
    await db.topup.create({ data: { id, userId, amountMinor: 1000, idempotencyKey: randomUUID(), stripeSessionId: bound ? sessionId : null } });
    const metadata = { topupId: id, userId }, created = 1700000000 + ++sequence;
    const charge: ObjectData = { id: chargeId, object: 'charge', customer: customerId, payment_intent: intentId, paid: true, captured: true, amount: 1000, amount_captured: 1000, amount_refunded: 0, currency: 'usd', livemode: false, disputed: false, metadata };
    const intent: ObjectData = { id: intentId, object: 'payment_intent', customer: customerId, status: 'succeeded', currency: 'usd', amount: 1000, amount_received: 1000, livemode: false, latest_charge: charge, metadata };
    const session: ObjectData = { id: sessionId, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 1000, currency: 'usd', livemode: false, customer: customerId, payment_intent: intentId, client_reference_id: id, metadata, created };
    sessions.set(sessionId, session); customers.set(customerId, { id: customerId, object: 'customer', livemode: false, metadata: { kivroUserId: userId } }); intents.set(intentId, intent);
    return { id, userId, customerId, sessionId, intentId, chargeId, session, intent, charge };
  };
  const due = async (id: string, kind = 'topup') => {
    const key = `billing-reconciliation:${kind}:${id}`, existing = await db.platformSetting.findUnique({ where: { key } });
    await db.platformSetting.upsert({ where: { key }, create: { key, value: { nextAttemptAt: 0 } }, update: { value: json({ ...(existing?.value as object ?? {}), nextAttemptAt: 0 }) } });
  };
  const addDispute = (f: Awaited<ReturnType<typeof fixture>>, status = 'needs_response') => {
    const id = `dp_${randomUUID().replaceAll('-', '')}`, object = { id, object: 'dispute', livemode: false, payment_intent: f.intentId, charge: f.chargeId, amount: 1000, currency: 'usd', status, created: 1700000000 + ++sequence };
    disputes.set(id, object); f.charge.disputed = true; return object;
  };
  const job = async (buyerId: string, settled = false) => {
    const seller = await db.user.create({ data: { email: `${randomUUID()}@canonical.kivro.local`, name: 'Synthetic seller', passwordHash: 'disabled', stripeConnectedAccountId: `acct_${randomBytes(8).toString('hex')}`, connectStatus: 'READY' } });
    const cap = await db.capability.create({ data: { sellerId: seller.id, slug: randomUUID(), schedule: DEFAULT_SCHEDULE } });
    const price = getPriceTier('USD_499');
    const version = await db.capabilityVersion.create({ data: { capabilityId: cap.id, version: 1, title: 'Synthetic financial recovery', summary: '', description: '', category: 'test', tags: [], priceTierId: price.id,
      ioContract: {}, dependencies: [], permissions: {}, internalInstructions: 'Never dispatch.', manifestHash: 'b'.repeat(64) } });
    return serializable(db, async tx => {
      const row = await tx.job.create({ data: { buyerId, sellerId: seller.id, capabilityId: cap.id, capabilityVersionId: version.id, input: {}, state: settled ? 'VALIDATING_RESULTS' : 'PAUSED', paymentState: 'RESERVED',
        buyerPriceMinor: price.buyerPriceMinor, sellerNetMinor: price.sellerNetMinor, platformFeeMinor: price.platformFeeMinor, priceSnapshot: price, executionMode: 'NOW', waitDeadline: new Date(Date.now() + 600_000) } });
      await reserveJob(tx, row);
      if (settled) await settleJob(tx, row, true);
      return { ...row, accountId: seller.stripeConnectedAccountId! };
    });
  };
  const completedTransfer = async () => {
    const f = await fixture(); expect((await send('checkout.session.completed', f.session)).statusCode).toBe(200);
    const j = await job(f.userId, true), id = `tr_${randomBytes(8).toString('hex')}`;
    const row = await db.sellerTransfer.update({ where: { jobId: j.id }, data: { stripeTransferId: id, destinationAccountId: j.accountId, state: 'TRANSFERRED', startedAt: new Date() } });
    const object: ObjectData = { id, object: 'transfer', currency: 'usd', livemode: false, amount: j.sellerNetMinor, amount_reversed: 0, reversed: false, destination: j.accountId, transfer_group: `job_${j.id}`, metadata: { jobId: j.id } };
    transfers.set(id, object); return { f, j, row, object };
  };
  const ledger = () => db.ledgerEntry.findMany({ orderBy: { operationKey: 'asc' } });

  it('recovers lost Checkout and lost create-response IDs using canonical HTTP reads, then tolerates restart and webhook replay', async () => {
    const f = await fixture(false);
    await run();
    expect(await db.topup.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ state: 'PAID', paymentIntentId: f.intentId, stripeSessionId: f.sessionId });
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).stripeCustomerId).toBe(f.customerId);
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(1000);
    const before = await ledger(); await due(f.id); await app.close(); app = await startApp();
    await run(); expect((await send('checkout.session.completed', f.session)).statusCode).toBe(200);
    expect(await ledger()).toEqual(before);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect(calls.some(call => call.path === `/v1/payment_intents/${f.intentId}`)).toBe(true);
  });

  it('commits a lost refund and release/debt cleanup without duplicating the original credit', async () => {
    const f = await fixture(); expect((await send('checkout.session.completed', f.session)).statusCode).toBe(200);
    const held = await job(f.userId); f.charge.amount_refunded = 1000;
    await run();
    expect(await db.topup.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ refundedMinor: 1000, refundAppliedMinor: 1000, refundDebtMinor: 0 });
    expect(await db.job.findUniqueOrThrow({ where: { id: held.id } })).toMatchObject({ paymentState: 'RELEASED', executionRevokedAt: expect.any(Date) });
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).suspendedAt).not.toBeNull();
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).toMatchObject({ availableMinor: 0, reservedMinor: 0 });
    const before = await ledger(); await due(f.id); await run(); expect((await send('charge.refunded', f.charge)).statusCode).toBe(200);
    expect(await ledger()).toEqual(before);
  });

  it('never exposes a newly discovered paid balance before its known refund and dispute commit', async () => {
    const f = await fixture(false); f.charge.amount_refunded = 1000; const dispute = addDispute(f);
    await run();
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).toMatchObject({ availableMinor: 0, reservedMinor: 0 });
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).suspendedAt).not.toBeNull();
    expect(await db.paymentDispute.findUniqueOrThrow({ where: { id: dispute.id } })).toMatchObject({ topupId: f.id, closedStatus: null, lastEventCreated: 0 });
    expect(await db.ledgerEntry.count({ where: { operationKey: `stripe-topup:${f.id}` } })).toBe(1);
  });

  it('discovers lost dispute state, preserves real event chronology and never invents reinstatement', async () => {
    const f = await fixture(); const dispute = addDispute(f, 'won'); await run();
    const saved = await db.paymentDispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(saved).toMatchObject({ status: 'won', closedStatus: null, closedEventCreated: null, reinstatedEventCreated: null, reviewRequired: false });
    await expect(serializable(db, tx => restoreBillingAccount(tx, f.userId, f.userId, 'Synthetic operator evidence'))).rejects.toMatchObject({ code: 'DISPUTE_UNRESOLVED' });
    const timestamp = Math.floor(Date.now() / 1000) - 60;
    expect((await send('charge.dispute.closed', dispute, timestamp)).statusCode).toBe(200);
    expect((await send('charge.dispute.funds_reinstated', dispute, timestamp + 1)).statusCode).toBe(200);
    await due(f.id); await run();
    expect(await db.paymentDispute.findUniqueOrThrow({ where: { id: dispute.id } })).toMatchObject({ closedStatus: 'won', closedEventCreated: timestamp, reinstatedEventCreated: timestamp + 1, reviewRequired: false });
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).disputedAt).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).suspendedAt).not.toBeNull();
  });

  it('pages dispute history before first credit while refreshing the head each pass', async () => {
    const f = await fixture(); for (let i = 0; i < 12; i++) addDispute(f);
    await run(); expect(await db.ledgerEntry.count({ where: { operationKey: `stripe-topup:${f.id}` } })).toBe(0);
    expect(await db.paymentDispute.count()).toBe(10);
    await due(f.id); await run();
    expect(await db.paymentDispute.count()).toBe(12);
    expect(await db.ledgerEntry.count({ where: { operationKey: `stripe-topup:${f.id}` } })).toBe(1);
    expect(calls.filter(call => call.path === '/v1/disputes').map(call => call.query.get('starting_after'))).toEqual([null, null, expect.stringMatching(/^dp_/)]);
  });

  it('backs up beyond the newest Checkout page and resumes its persisted cursor', async () => {
    const f = await fixture(false);
    for (let i = 0; i < 25; i++) sessions.set(`cs_test_unrelated${i}`, { ...f.session, id: `cs_test_unrelated${i}`, created: 1800000000 + i, metadata: {}, client_reference_id: null });
    await run(); expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).stripeSessionId).toBeNull();
    await run(); expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).stripeSessionId).toBeNull();
    await run(); expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).state).toBe('PAID');
    expect(calls.filter(call => call.path === '/v1/checkout/sessions' && call.query.has('starting_after'))).toHaveLength(2);
    expect(calls.filter(call => call.path === '/v1/checkout/sessions').every(call => call.query.get('limit') === '10')).toBe(true);
  });

  it('advances past failures and future retries without starving later topups', async () => {
    const all: Awaited<ReturnType<typeof fixture>>[] = [];
    for (let i = 0; i < 6; i++) all.push(await fixture(true, `00000000-0000-4000-8000-${i.toString().padStart(12, '0')}`));
    failures.set(`/v1/checkout/sessions/${all[0]!.sessionId}`, 1);
    await run(); await run(); await run();
    expect((await db.topup.findUniqueOrThrow({ where: { id: all[0]!.id } })).state).toBe('PENDING');
    for (const f of all.slice(1)) expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).state).toBe('PAID');
    expect(calls.filter(call => call.path === `/v1/checkout/sessions/${all[0]!.sessionId}`)).toHaveLength(1);
    await due(all[0]!.id); await run();
    expect((await db.topup.findUniqueOrThrow({ where: { id: all[0]!.id } })).state).toBe('PAID');
  });

  it('claims one scan across concurrent callers and fences a stale response after lease replacement', async () => {
    const f = await fixture(); await Promise.all([run(), run(), run()]);
    expect(calls.filter(call => call.path === `/v1/checkout/sessions/${f.sessionId}`)).toHaveLength(1);
    const other = await fixture(); let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; }), paused = new Promise<void>(resolve => { release = resolve; });
    intercept = async path => { if (path === `/v1/checkout/sessions/${other.sessionId}`) { started(); await paused; } };
    const pending = run(); await entered;
    const state = (await db.platformSetting.findUniqueOrThrow({ where: { key: scanKey } })).value as object;
    await db.platformSetting.update({ where: { key: scanKey }, data: { value: json({ ...state, token: 'replacement-owner', leaseUntil: Date.now() + 120000 }) } });
    release(); await pending; intercept = null;
    expect(await db.ledgerEntry.count({ where: { operationKey: `stripe-topup:${other.id}` } })).toBe(0);
    expect((await db.platformSetting.findUniqueOrThrow({ where: { key: scanKey } })).value).toMatchObject({ token: 'replacement-owner' });
  });

  it.each(['customer', 'intent', 'charge', 'mode', 'refund', 'dispute'] as const)('holds ambiguous %s evidence without crediting or fabricating paid state', async damage => {
    const f = await fixture();
    if (damage === 'customer') customers.get(f.customerId)!.metadata = { kivroUserId: randomUUID() };
    if (damage === 'intent') f.intent.amount_received = 999;
    if (damage === 'charge') f.charge.payment_intent = 'pi_someoneElse';
    if (damage === 'mode') f.intent.livemode = true;
    if (damage === 'refund') f.charge.amount_refunded = 1001;
    if (damage === 'dispute') addDispute(f).payment_intent = 'pi_someoneElse';
    await run();
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).state).toBe('PENDING'); expect(await db.ledgerEntry.count()).toBe(0);
    expect((await db.platformSetting.findUniqueOrThrow({ where: { key: `billing-reconciliation:topup:${f.id}` } })).value).toMatchObject({ reviewRequired: true, lastError: 'PROVIDER_RECONCILIATION_MISMATCH' });
    expect((await send('checkout.session.completed', f.session)).statusCode).toBe(409);
    await expect(serializable(db, tx => restoreBillingAccount(tx, f.userId, f.userId, 'Synthetic review must not clear ambiguity'))).rejects.toMatchObject({ code: 'PROVIDER_REVIEW_REQUIRED' });
  });

  it('does not turn an unpaid canonical Checkout into credits or a completed payment', async () => {
    const f = await fixture(); f.session.payment_status = 'unpaid'; f.session.status = 'open'; f.session.payment_intent = null;
    await run(); expect(await db.ledgerEntry.count()).toBe(0); expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).state).toBe('PENDING');
    expect((await db.platformSetting.findUniqueOrThrow({ where: { key: `billing-reconciliation:topup:${f.id}` } })).value).toMatchObject({ lastVerifiedAt: expect.any(String), lastError: null });
  });

  it('holds conflicting paid Checkout identities rather than choosing one and crediting it', async () => {
    const f = await fixture(); sessions.set('cs_test_duplicatePayment', { ...f.session, id: 'cs_test_duplicatePayment', created: 1800000000 });
    await run(); expect(await db.ledgerEntry.count()).toBe(0);
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).stripeSessionId).toBe(f.sessionId);
    expect((await db.platformSetting.findUniqueOrThrow({ where: { key: `billing-reconciliation:topup:${f.id}` } })).value).toMatchObject({ reviewRequired: true, reviewReason: 'CHECKOUT_DISCOVERY_CONFLICT' });
  });

  it.each(['partial', 'full', 'identity'] as const)('revisits already-TRANSFERRED objects and quarantines %s changes without double paying or refunding', async change => {
    const f = await completedTransfer(), before = await ledger();
    if (change === 'identity') f.object.destination = 'acct_someoneElse';
    else { f.object.amount_reversed = change === 'full' ? f.j.sellerNetMinor : 1; f.object.reversed = change === 'full'; }
    await run();
    expect(await db.sellerTransfer.findUniqueOrThrow({ where: { id: f.row.id } })).toMatchObject({ state: 'NEEDS_RECONCILIATION' });
    expect(await db.job.findUniqueOrThrow({ where: { id: f.j.id } })).toMatchObject({ paymentState: 'SETTLED' });
    expect(await ledger()).toEqual(before);
    await due(f.row.id, 'transfer'); await run(); expect(await ledger()).toEqual(before);
    expect(await db.auditEvent.count({ where: { jobId: f.j.id, type: 'TRANSFER_RECONCILIATION_REQUIRED' } })).toBe(1);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('confirms a canonical completed transfer and a previously refunded full reversal without new ledger effects', async () => {
    const f = await completedTransfer(); await run();
    expect((await db.sellerTransfer.findUniqueOrThrow({ where: { id: f.row.id } })).state).toBe('TRANSFERRED');
    await serializable(db, tx => refundJob(tx, f.j));
    await db.sellerTransfer.update({ where: { id: f.row.id }, data: { state: 'REVERSED' } });
    f.object.amount_reversed = f.j.sellerNetMinor; f.object.reversed = true;
    const before = await ledger(); await due(f.row.id, 'transfer'); await run();
    expect((await db.sellerTransfer.findUniqueOrThrow({ where: { id: f.row.id } })).state).toBe('REVERSED'); expect(await ledger()).toEqual(before);
  });

  it('resets an expired provider cursor durably and still services other recovery families', async () => {
    const f = await completedTransfer();
    await db.platformSetting.create({ data: { key: scanKey, value: { checkoutAfter: 'cs_test_missingCursor' } } });
    await run();
    expect((await db.platformSetting.findUniqueOrThrow({ where: { key: scanKey } })).value).toMatchObject({ checkoutAfter: null, checkoutAttempts: 1 });
    expect((await db.platformSetting.findUniqueOrThrow({ where: { key: `billing-reconciliation:transfer:${f.row.id}` } })).value).toMatchObject({ lastVerifiedAt: expect.any(String) });
  });

  it('resumes interrupted post-commit refund cleanup after API restart using committed observations', async () => {
    const f = await fixture(); expect((await send('checkout.session.completed', f.session)).statusCode).toBe(200);
    const held = await job(f.userId); f.charge.amount_refunded = 1000;
    await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".reject_collection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.type = 'REFUND_DEBT_COLLECTION' THEN RAISE EXCEPTION 'synthetic interrupted collection'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER reject_collection BEFORE INSERT ON "${schema}"."LedgerEntry" FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_collection()`);
    try {
      await run();
      expect(await db.topup.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ refundAppliedMinor: 1000, refundDebtMinor: 499 });
      expect((await db.job.findUniqueOrThrow({ where: { id: held.id } })).paymentState).toBe('RELEASED');
      expect(await db.billingEvent.findUnique({ where: { id: `canonical:refund:${f.chargeId}:1000` } })).not.toBeNull();
      expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).suspendedAt).not.toBeNull();
      await app.close(); app = await startApp();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER reject_collection ON "${schema}"."LedgerEntry"`);
      await db.$executeRawUnsafe(`DROP FUNCTION "${schema}".reject_collection()`);
    }
    await due(f.id); await run();
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).refundDebtMinor).toBe(0);
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).toMatchObject({ availableMinor: 0, reservedMinor: 0 });
    for (const type of ['CREDIT_PURCHASE', 'TOPUP_REFUND', 'REFUND_DEBT_COLLECTION']) expect(await db.ledgerEntry.count({ where: { userId: f.userId, type } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { jobId: held.id, type: 'JOB_RELEASE' } })).toBe(1);
  });

  it('crosses the twenty-row candidate boundary despite earlier future retries', async () => {
    for (let i = 0; i < 21; i++) {
      const f = await fixture(true, `00000000-0000-4000-8000-${i.toString().padStart(12, '0')}`);
      await db.platformSetting.create({ data: { key: `billing-reconciliation:topup:${f.id}`, value: { nextAttemptAt: Date.now() + 3600000 } } });
    }
    const fresh = await fixture(true, 'ffffffff-ffff-4fff-8fff-ffffffffffff');
    await run(); expect(await db.ledgerEntry.count()).toBe(0);
    await run(); expect((await db.topup.findUniqueOrThrow({ where: { id: fresh.id } })).state).toBe('PAID');
    expect(calls.filter(call => call.path.startsWith('/v1/checkout/sessions/'))).toHaveLength(1);
  });

  it('bounds a stalled HTTP read to three seconds without retrying or capturing state', async () => {
    const f = await fixture();
    intercept = async path => { if (path === `/v1/checkout/sessions/${f.sessionId}`) await new Promise(resolve => setTimeout(resolve, 3300)); };
    const started = Date.now(); await run(); const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(2800); expect(elapsed).toBeLessThan(6500);
    expect(calls.filter(call => call.path === `/v1/checkout/sessions/${f.sessionId}`)).toHaveLength(1);
    expect(await db.ledgerEntry.count()).toBe(0); expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).state).toBe('PENDING');
    expect((await db.platformSetting.findUniqueOrThrow({ where: { key: `billing-reconciliation:topup:${f.id}` } })).value).toMatchObject({ reviewRequired: false, attempts: 1 });
  });

  it('rejects a malformed provider page, keeps known-object recovery working, and clears discovery errors on retry', async () => {
    const f = await fixture(); overrides.set('/v1/checkout/sessions', { object: 'list', data: [], has_more: true });
    await run(); expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).state).toBe('PAID');
    expect((await db.platformSetting.findUniqueOrThrow({ where: { key: `${scanKey}:discovery-error` } })).value).toMatchObject({ code: 'PROVIDER_RECONCILIATION_MISMATCH' });
    overrides.clear(); const state = (await db.platformSetting.findUniqueOrThrow({ where: { key: scanKey } })).value as object;
    await db.platformSetting.update({ where: { key: scanKey }, data: { value: json({ ...state, checkoutRetryAt: 0 }) } });
    await run(); expect(await db.platformSetting.findUnique({ where: { key: `${scanKey}:discovery-error` } })).toBeNull();
  });

  it('resets a vanished dispute cursor without treating network pagination as proof of payment', async () => {
    const f = await fixture(); addDispute(f);
    await db.platformSetting.create({ data: { key: `billing-reconciliation:topup:${f.id}`, value: { disputeAfter: 'dp_vanishedCursor' } } });
    await run(); expect(await db.ledgerEntry.count()).toBe(0);
    expect((await db.platformSetting.findUniqueOrThrow({ where: { key: `billing-reconciliation:topup:${f.id}` } })).value).toMatchObject({ disputeAfter: null, reviewRequired: false, lastError: 'PROVIDER_CURSOR_INVALID' });
    await due(f.id); await run(); expect(await db.paymentDispute.count()).toBe(1);
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).suspendedAt).not.toBeNull();
  });

  it.each(['valid', 'invalid'] as const)('does not overwrite a concurrent refund with a stale %s transfer read', async response => {
    const f = await completedTransfer(); if (response === 'invalid') f.object.destination = 'acct_conflictingDestination';
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; }), paused = new Promise<void>(resolve => { release = resolve; });
    intercept = async path => { if (path === `/v1/transfers/${f.row.stripeTransferId}`) { started(); await paused; } };
    const pending = run(); await entered;
    await serializable(db, tx => refundJob(tx, f.j)); const before = await ledger();
    release(); await pending;
    expect(await db.sellerTransfer.findUniqueOrThrow({ where: { id: f.row.id } })).toMatchObject({ state: 'REVERSAL_PENDING' });
    expect(await ledger()).toEqual(before);
    expect(await db.auditEvent.count({ where: { jobId: f.j.id, type: 'TRANSFER_RECONCILIATION_REQUIRED' } })).toBe(0);
  });

  it('holds regressed provider refund evidence without restoring credits or paid state', async () => {
    const f = await fixture(); expect((await send('checkout.session.completed', f.session)).statusCode).toBe(200);
    f.charge.amount_refunded = 1000; expect((await send('charge.refunded', f.charge)).statusCode).toBe(200);
    const before = await ledger(); f.charge.amount_refunded = 0; await run();
    expect(await ledger()).toEqual(before);
    expect(await db.topup.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ state: 'REFUNDED', refundAppliedMinor: 1000 });
    expect((await db.platformSetting.findUniqueOrThrow({ where: { key: `billing-reconciliation:topup:${f.id}` } })).value).toMatchObject({ reviewRequired: true });
  });
});
