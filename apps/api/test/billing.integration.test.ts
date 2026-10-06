import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient, serializable } from '@kivro/database';
import { StripeBilling, reserveJob, settleJob, refundJob } from '@kivro/billing';
import { DEFAULT_SCHEDULE, getPriceTier } from '@kivro/contracts';
import { createApp } from '../src/app.js';
import { reconcileTransfers } from '../src/background.js';
import { hashSecret } from '../src/auth.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('signed provider events and durable refund recovery (synthetic Stripe)', () => {
  let db: PrismaClient, app: FastifyInstance;
  const webhookSecret = 'whsec_local_integration_not_a_real_secret';
  const billing = new StripeBilling('sk_test_local_integration_not_a_real_key', webhookSecret);
  const identities: string[] = [];
  const sellerId = randomUUID(), capabilityId = randomUUID(), versionId = randomUUID(), adminId = randomUUID(), adminToken = randomUUID();
  const adminHeaders = () => ({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', cookie: `kivro_session=${adminToken}` });
  const send = (type: string, object: Record<string, unknown>, id = `evt_${randomUUID()}`, live = false, target = app, created = Math.floor(Date.now() / 1000)) => {
    const payload = JSON.stringify({ id, object: 'event', api_version: '2025-03-31.basil', created, livemode: live, type, data: { object } });
    const signature = billing.stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
    return target.inject({ method: 'POST', url: '/api/billing/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, payload });
  };
  const fixture = async () => {
    const userId = randomUUID(), id = randomUUID(); identities.push(userId);
    await db.user.create({ data: { id: userId, email: `${userId}@billing.kivro.local`, name: 'Synthetic refund fixture', passwordHash: 'disabled-test-identity', wallet: { create: {} } } });
    await db.topup.create({ data: { id, userId, idempotencyKey: randomUUID(), amountMinor: 1000, livemode: false } });
    const pi = `pi_${id}`;
    const paid = (target = app) => send('checkout.session.completed', { id: `cs_${id}`, livemode: false, currency: 'usd', amount_total: 1000, payment_status: 'paid', payment_intent: pi, metadata: { topupId: id, userId } }, undefined, false, target);
    const refund = (amount: number, eventId?: string) => send('charge.refunded', { id: `ch_${id}`, livemode: false, currency: 'usd', amount: 1000, amount_refunded: amount, payment_intent: pi, metadata: { topupId: id } }, eventId);
    return { id, userId, pi, paid, refund };
  };
  const spentJob = async (buyerId: string, transfer: boolean) => serializable(db, async tx => {
    const price = getPriceTier('USD_999');
    const job = await tx.job.create({ data: { buyerId, sellerId, capabilityId, capabilityVersionId: versionId, input: {}, priceSnapshot: price,
      buyerPriceMinor: price.buyerPriceMinor, sellerNetMinor: price.sellerNetMinor, platformFeeMinor: price.platformFeeMinor, executionMode: 'NOW', waitDeadline: new Date(Date.now() + 3600_000) } });
    await reserveJob(tx, job);
    const validating = await tx.job.update({ where: { id: job.id }, data: { state: 'VALIDATING_RESULTS' } });
    await settleJob(tx, validating, transfer);
    return tx.job.update({ where: { id: job.id }, data: { state: 'SUCCEEDED', completedAt: new Date() } });
  });
  beforeAll(async () => {
    process.loadEnvFile('.env');
    if (process.env.KIVRO_ENV !== 'development' || !process.env.DATABASE_URL?.includes(':55432/kivro')) throw new Error('Requires isolated local development services');
    db = new PrismaClient(); identities.push(sellerId);
    identities.push(adminId);
    await db.user.create({ data: { id: adminId, email: `${adminId}@billing.kivro.local`, name: 'Synthetic billing administrator', passwordHash: 'disabled-test-identity', isAdmin: true,
      sessions: { create: { tokenHash: hashSecret(adminToken), expiresAt: new Date(Date.now() + 3600_000) } } } });
    await db.user.create({ data: { id: sellerId, email: `${sellerId}@billing.kivro.local`, name: 'Synthetic transfer seller', passwordHash: 'disabled-test-identity',
      stripeConnectedAccountId: `acct_${sellerId}`, connectStatus: 'READY', wallet: { create: {} } } });
    await db.capability.create({ data: { id: capabilityId, sellerId, slug: `billing-${capabilityId}`, schedule: DEFAULT_SCHEDULE } });
    await db.capabilityVersion.create({ data: { id: versionId, capabilityId, version: 1, title: 'Billing test only', summary: '', description: '', category: 'test', tags: [], priceTierId: 'USD_999',
      ioContract: {}, permissions: {}, dependencies: [], internalInstructions: 'Synthetic ledger fixture; never dispatch.', manifestHash: 'f'.repeat(64), publishedAt: new Date() } });
    app = await createApp({ env: { ...process.env, PAYMENT_MODE: 'stripe' }, db, billing, logger: false });
  });
  afterAll(async () => {
    vi.restoreAllMocks(); await app?.close();
    if (db) {
      await db.user.updateMany({ where: { id: { in: identities } }, data: { suspendedAt: new Date() } });
      await db.capability.updateMany({ where: { id: capabilityId }, data: { paused: true, visibility: 'PRIVATE' } });
      await db.$disconnect();
    }
  });
  it('rejects signed test/live mode mismatches, including account lifecycle events', async () => {
    const cross = await send('account.updated', { id: `acct_${sellerId}`, payouts_enabled: true, capabilities: { transfers: 'active' } }, undefined, true);
    expect(cross.statusCode).toBe(400); expect(cross.json().error.code).toBe('PAYMENT_MODE_MISMATCH');
    const liveApp = await createApp({ env: { ...process.env, PAYMENT_MODE: 'stripe' }, db, billing: new StripeBilling('sk_live_synthetic_not_real', webhookSecret), logger: false });
    try { expect((await send('account.updated', { id: `acct_${sellerId}`, payouts_enabled: true }, undefined, false, liveApp)).statusCode).toBe(400); }
    finally { await liveApp.close(); }
    expect((await db.user.findUniqueOrThrow({ where: { id: sellerId } })).connectStatus).toBe('READY');
  });
  it('reconciles partial, duplicate and out-of-order cumulative refunds exactly once', async () => {
    const f = await fixture(); expect((await f.paid()).statusCode).toBe(200);
    const eventId = `evt_${randomUUID()}`;
    expect((await f.refund(400, eventId)).statusCode).toBe(200);
    expect((await f.refund(400, eventId)).statusCode).toBe(200);
    expect((await f.refund(200)).statusCode).toBe(200);
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(600);
    expect((await f.refund(1000)).statusCode).toBe(200);
    expect((await f.paid()).statusCode).toBe(200);
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(0);
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).state).toBe('REFUNDED');
    expect(await db.ledgerEntry.count({ where: { userId: f.userId, type: 'TOPUP_REFUND' } })).toBe(2);
  });
  it('never restores Connect readiness from an older or ambiguously ordered event', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const blocked = { id: `acct_${sellerId}`, payouts_enabled: false, capabilities: { transfers: 'inactive' }, requirements: { disabled_reason: 'requirements.past_due' } };
    const ready = { id: `acct_${sellerId}`, payouts_enabled: true, capabilities: { transfers: 'active' }, requirements: {} };
    expect((await send('account.updated', blocked, undefined, false, app, timestamp)).statusCode).toBe(200);
    for (const created of [timestamp - 1, timestamp]) {
      const response = await send('account.updated', ready, undefined, false, app, created);
      expect(response.statusCode).toBe(200); expect(response.json().outcome).toBe('IGNORED_STALE');
      expect((await db.user.findUniqueOrThrow({ where: { id: sellerId } })).connectStatus).toBe('ACTION_REQUIRED');
    }
    expect((await send('account.updated', ready, undefined, false, app, timestamp + 1)).statusCode).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: sellerId } })).connectStatus).toBe('READY');
  });
  it('persists an early dispute across restart and a refund cannot clear its suspension guard', async () => {
    const f = await fixture(), eventId = `evt_${randomUUID()}`;
    const dispute = { id: `dp_${f.id}`, livemode: false, payment_intent: f.pi, amount: 1000, currency: 'usd', status: 'needs_response' };
    const pending = await send('charge.dispute.created', dispute, eventId);
    expect(pending.statusCode).toBe(200); expect(pending.json().outcome).toBe('PENDING');
    expect(await db.billingEvent.findUniqueOrThrow({ where: { id: eventId } })).toMatchObject({ outcome: 'PENDING', processedAt: null, providerReference: f.pi });
    const restarted = await createApp({ env: { ...process.env, PAYMENT_MODE: 'stripe' }, db, billing, logger: false });
    try { expect((await f.paid(restarted)).statusCode).toBe(200); }
    finally { await restarted.close(); }
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).suspendedAt).not.toBeNull();
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).disputedAt).not.toBeNull();
    const reconciled = await db.billingEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(reconciled.outcome).toBe('PROCESSED'); expect(reconciled.processedAt).not.toBeNull();
    expect((await send('charge.dispute.created', dispute, eventId)).statusCode).toBe(200);
    expect(await db.auditEvent.count({ where: { type: 'PAYMENT_DISPUTED', actorId: f.userId } })).toBe(1);
    expect((await f.refund(400)).statusCode).toBe(200);
    expect(await db.topup.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ state: 'DISPUTED', refundedMinor: 400 });
    const restore = await app.inject({ method: 'POST', url: `/api/admin/users/${f.userId}/suspend`, headers: { ...adminHeaders(), 'idempotency-key': randomUUID() }, payload: { suspended: false, reason: 'Review the still-open payment dispute' } });
    expect(restore.statusCode).toBe(409); expect(restore.json().error.code).toBe('DISPUTE_UNRESOLVED');
    const missingId = `evt_${randomUUID()}`;
    expect((await send('charge.dispute.created', { id: `dp_${randomUUID()}`, livemode: false }, missingId)).statusCode).toBe(400);
    expect(await db.billingEvent.findUnique({ where: { id: missingId } })).toBeNull();
  });
  it('remembers a refund arriving before checkout credit and never exposes refunded credits', async () => {
    const f = await fixture(); expect((await f.refund(500)).statusCode).toBe(200);
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(0);
    expect((await f.paid()).statusCode).toBe(200);
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } });
    expect(wallet.availableMinor).toBe(500);
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).refundAppliedMinor).toBe(500);
  });
  it('suspends a spent-credit refund shortfall with balanced compensating entries', async () => {
    const f = await fixture(); expect((await f.paid()).statusCode).toBe(200); await spentJob(f.userId, false);
    expect((await f.refund(1000)).statusCode).toBe(200);
    const topup = await db.topup.findUniqueOrThrow({ where: { id: f.id } });
    expect(topup.refundDebtMinor).toBe(999); expect(topup.refundAppliedMinor).toBe(1000);
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).suspendedAt).not.toBeNull();
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(0);
    const entry = await db.ledgerEntry.findUniqueOrThrow({ where: { operationKey: `topup:${f.id}:refund:1000` } });
    expect((await db.ledgerEntry.aggregate({ where: { transactionId: entry.transactionId }, _sum: { amountMinor: true } }))._sum.amountMinor).toBe(0);
  });
  it('recovers a lost transfer response after a concurrent refund before reversing once', async () => {
    const f = await fixture(); await f.paid(); const job = await spentJob(f.userId, true);
    const transferId = `tr_${randomUUID()}`; let externalCreates = 0, lost = false;
    const original = billing.transfer.bind(billing), originalReverse = billing.reverseTransfer.bind(billing);
    const calls = vi.spyOn(billing, 'transfer').mockImplementation(async (id, destination, amount) => {
      if (id !== job.id) return original(id, destination, amount);
      if (!lost) {
        externalCreates++; lost = true;
        await serializable(db, tx => refundJob(tx, job));
        throw new Error('Synthetic lost response after Stripe accepted the transfer');
      }
      return { id: transferId } as Awaited<ReturnType<StripeBilling['transfer']>>;
    });
    const reversals = vi.spyOn(billing, 'reverseTransfer').mockImplementation(async (id, externalId) => {
      if (id !== job.id) return originalReverse(id, externalId);
      expect(externalId).toBe(transferId);
      return { id: `trr_${job.id}` } as Awaited<ReturnType<StripeBilling['reverseTransfer']>>;
    });
    // Limit this synthetic adapter to its own durable transfer fixture.
    const findTransfers = db.sellerTransfer.findMany.bind(db.sellerTransfer);
    const ctx = { ...app.kivro, db: new Proxy(db, { get(target, property) {
      if (property === 'sellerTransfer') return { ...target.sellerTransfer, findMany: () => findTransfers({ where: { jobId: job.id, state: { in: ['PENDING', 'PROCESSING', 'REVERSAL_PENDING'] } } }) };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) };
    try {
      await reconcileTransfers(ctx);
      expect((await db.sellerTransfer.findUniqueOrThrow({ where: { jobId: job.id } })).stripeTransferId).toBeNull();
      await db.sellerTransfer.update({ where: { jobId: job.id }, data: { nextAttemptAt: new Date(0) } });
      await reconcileTransfers(ctx); await reconcileTransfers(ctx);
      const transfer = await db.sellerTransfer.findUniqueOrThrow({ where: { jobId: job.id } });
      expect(transfer.state).toBe('REVERSED'); expect(transfer.stripeTransferId).toBe(transferId);
      expect(externalCreates).toBe(1); expect(calls.mock.calls.filter(call => call[0] === job.id)).toHaveLength(2);
      expect(reversals.mock.calls.filter(call => call[0] === job.id)).toHaveLength(1);
    } finally { calls.mockRestore(); reversals.mockRestore(); }
  });
  it('closes a crash-before-provider-call intent only after provider-empty verification and a buyer refund', async () => {
    const f = await fixture(); await f.paid(); const job = await spentJob(f.userId, true);
    const intent = await db.sellerTransfer.update({ where: { jobId: job.id }, data: { state: 'PROCESSING', startedAt: new Date(Date.now() - 24 * 3600_000), destinationAccountId: `acct_${sellerId}`, nextAttemptAt: new Date(0) } });
    const creates = vi.spyOn(billing, 'transfer').mockRejectedValue(new Error('Never blindly recreate an uncertain transfer'));
    const findTransfers = db.sellerTransfer.findMany.bind(db.sellerTransfer);
    const ctx = { ...app.kivro, db: new Proxy(db, { get(target, property) {
      if (property === 'sellerTransfer') return { ...target.sellerTransfer, findMany: () => findTransfers({ where: { jobId: job.id, state: { in: ['PENDING', 'PROCESSING', 'REVERSAL_PENDING'] } } }) };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } }) };
    const provider = vi.spyOn(billing, 'findJobTransfers').mockResolvedValue({ object: 'list', data: [], has_more: true, url: '/v1/transfers', lastResponse: { headers: {}, requestId: 'synthetic', statusCode: 200 } });
    const cancel = () => app.inject({ method: 'POST', url: `/api/admin/transfers/${intent.id}/cancel-uncreated`, headers: adminHeaders(), payload: {
      confirmation: 'CONFIRM_NO_PROVIDER_TRANSFER_AND_REFUND', reason: 'Investigated process crash before the outbound Stripe request', investigationReference: 'synthetic-provider-investigation-001' } });
    try {
      await reconcileTransfers(ctx);
      expect((await db.sellerTransfer.findUniqueOrThrow({ where: { id: intent.id } })).state).toBe('NEEDS_RECONCILIATION');
      expect((await cancel()).statusCode).toBe(409);
      provider.mockResolvedValue({ object: 'list', data: [], has_more: false, url: '/v1/transfers', lastResponse: { headers: {}, requestId: 'synthetic', statusCode: 200 } });
      const response = await cancel(); expect(response.statusCode, response.body).toBe(200);
      expect(response.json().state).toBe('CANCELLED');
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).paymentState).toBe('REFUNDED');
      expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(1000);
      expect(await db.auditEvent.count({ where: { jobId: job.id, actorId: adminId, type: 'TRANSFER_CONFIRMED_UNCREATED' } })).toBe(1);
      await reconcileTransfers(ctx); expect(creates).not.toHaveBeenCalled();
    } finally { creates.mockRestore(); provider.mockRestore(); }
  });
  it('quarantines an old uncertain transfer and only accepts audited provider-verified recovery', async () => {
    const f = await fixture(); await f.paid(); const job = await spentJob(f.userId, true);
    const transferId = `tr_${randomUUID().replaceAll('-', '')}`;
    const intent = await db.sellerTransfer.update({ where: { jobId: job.id }, data: { state: 'PROCESSING', startedAt: new Date(Date.now() - 24 * 3600_000), destinationAccountId: `acct_${sellerId}`, nextAttemptAt: new Date(0) } });
    const creates = vi.spyOn(billing, 'transfer').mockRejectedValue(new Error('Old uncertain transfers must not be created again'));
    const external: Awaited<ReturnType<StripeBilling['retrieveTransfer']>> = { id: transferId, object: 'transfer', livemode: false, amount: intent.amountMinor, currency: 'usd',
      destination: intent.destinationAccountId!, metadata: { jobId: job.id }, transfer_group: `job_${job.id}`, reversed: false, amount_reversed: 0, balance_transaction: null,
      created: Math.floor(Date.now() / 1000), description: null, reversals: { object: 'list', data: [], has_more: false, url: '' }, source_transaction: null, source_type: 'card',
      lastResponse: { headers: {}, requestId: 'synthetic', statusCode: 200 } };
    const retrieval = vi.spyOn(billing, 'retrieveTransfer').mockResolvedValue({ ...external, amount: 1 });
    const reversals = vi.spyOn(billing, 'reverseTransfer').mockResolvedValue({ id: `trr_${job.id}` } as Awaited<ReturnType<StripeBilling['reverseTransfer']>>);
    const findTransfers = db.sellerTransfer.findMany.bind(db.sellerTransfer);
    const ctx = { ...app.kivro, db: new Proxy(db, { get(target, property) {
      if (property === 'sellerTransfer') return { ...target.sellerTransfer, findMany: () => findTransfers({ where: { jobId: job.id, state: { in: ['PENDING', 'PROCESSING', 'REVERSAL_PENDING'] } } }) };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } }) };
    const resolve = () => app.inject({ method: 'POST', url: `/api/admin/transfers/${intent.id}/resolve`, headers: adminHeaders(), payload: { stripeTransferId: transferId, reason: 'Verified original provider transfer against the durable intent' } });
    try {
      await reconcileTransfers(ctx); await reconcileTransfers(ctx);
      expect(creates).not.toHaveBeenCalled();
      expect((await db.sellerTransfer.findUniqueOrThrow({ where: { id: intent.id } })).state).toBe('NEEDS_RECONCILIATION');
      expect(await db.auditEvent.count({ where: { jobId: job.id, type: 'TRANSFER_RECONCILIATION_REQUIRED' } })).toBe(1);
      await serializable(db, tx => refundJob(tx, job));
      expect((await db.sellerTransfer.findUniqueOrThrow({ where: { id: intent.id } })).state).toBe('NEEDS_RECONCILIATION');
      expect((await app.inject({ url: '/api/admin/transfers', headers: adminHeaders() })).json().some((row: { id: string }) => row.id === intent.id)).toBe(true);
      expect((await resolve()).statusCode).toBe(409);
      retrieval.mockResolvedValue(external);
      expect((await resolve()).statusCode).toBe(200); expect((await resolve()).statusCode).toBe(200);
      const audit = await db.auditEvent.findMany({ where: { jobId: job.id, type: 'TRANSFER_MANUALLY_RECONCILED' } });
      expect(audit).toHaveLength(1); expect(audit[0]!.actorId).toBe(adminId);
      expect(audit[0]!.metadata).toMatchObject({ stripeTransferId: transferId, previousState: 'NEEDS_RECONCILIATION', state: 'REVERSAL_PENDING' });
      await reconcileTransfers(ctx); await reconcileTransfers(ctx);
      expect((await db.sellerTransfer.findUniqueOrThrow({ where: { id: intent.id } })).state).toBe('REVERSED');
      expect(reversals).toHaveBeenCalledTimes(1); expect(creates).not.toHaveBeenCalled();
    } finally { creates.mockRestore(); retrieval.mockRestore(); reversals.mockRestore(); }
  });
});
