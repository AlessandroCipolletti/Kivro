import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient, serializable } from '@kivro/database';
import { StripeBilling, creditWallet, reserveJob, settleJob } from '@kivro/billing';
import { DEFAULT_SCHEDULE, getPriceTier } from '@kivro/contracts';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('signed dispute closure and audited account restoration (synthetic Stripe)', () => {
  let db: PrismaClient, app: FastifyInstance;
  const secret = 'whsec_dispute_integration_not_a_real_secret';
  const billing = new StripeBilling('sk_test_dispute_integration_not_a_real_key', secret);
  const identities: string[] = [];
  const adminId = randomUUID(), adminToken = randomUUID(), sellerId = randomUUID(), capabilityId = randomUUID(), versionId = randomUUID();
  const origin = () => process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  const adminHeaders = () => ({ origin: origin(), cookie: `kivro_session=${adminToken}` });
  const start = Math.floor(Date.now() / 1000) - 1000;
  const send = (type: string, object: Record<string, unknown>, created = start, id = `evt_${randomUUID()}`, target = app, livemode = false) => {
    const payload = JSON.stringify({ id, object: 'event', api_version: '2025-03-31.basil', created, livemode, type, data: { object } });
    const signature = billing.stripe.webhooks.generateTestHeaderString({ payload, secret });
    return target.inject({ method: 'POST', url: '/api/billing/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, payload });
  };
  const fixture = async (existingUserId?: string) => {
    const id = randomUUID(), userId = existingUserId ?? randomUUID(), token = randomUUID(), key = randomUUID();
    if (!existingUserId) {
      identities.push(userId);
      await db.user.create({ data: { id: userId, email: `${userId}@dispute.kivro.local`, name: 'Synthetic dispute buyer', passwordHash: 'disabled-test-identity', wallet: { create: {} },
        sessions: { create: { tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + 3600_000) } },
        apiKeys: { create: { name: 'Dispute regression key', prefix: key.slice(0, 12), secretHash: hashSecret(key), scopes: ['jobs:read'] } } } });
    }
    await db.topup.create({ data: { id, userId, idempotencyKey: randomUUID(), amountMinor: 1000, livemode: false } });
    const pi = `pi_${id}`, disputeId = `dp_${id}`;
    const object = (status: string, overrides: Record<string, unknown> = {}) => ({ id: disputeId, amount: 1000, currency: 'usd', status, payment_intent: pi, ...overrides });
    const paid = (target = app) => send('checkout.session.completed', { id: `cs_${id}`, currency: 'usd', amount_total: 1000, payment_status: 'paid', payment_intent: pi, metadata: { topupId: id, userId } }, start, undefined, target);
    const event = (type: string, status: string, time = start, overrides: Record<string, unknown> = {}, eventId?: string, target = app) => send(`charge.dispute.${type}`, object(status, overrides), time, eventId, target);
    const refund = (amount = 1000) => send('charge.refunded', { id: `ch_${id}`, currency: 'usd', amount: 1000, amount_refunded: amount, payment_intent: pi });
    return { id, userId, pi, disputeId, token, key, object, paid, event, refund };
  };
  const restore = (userId: string, key = randomUUID(), reason = 'Reviewed signed closure and all outstanding payment holds') => app.inject({ method: 'POST', url: `/api/admin/users/${userId}/restore`,
    headers: { ...adminHeaders(), 'idempotency-key': key }, payload: { reason } });
  const blocked = async (userId: string, code = 'DISPUTE_UNRESOLVED') => {
    const response = await restore(userId); expect(response.statusCode, response.body).toBe(409); expect(response.json().error.code).toBe(code);
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).suspendedAt).not.toBeNull();
  };
  const job = async (buyerId: string, settle = false) => serializable(db, async tx => {
    const price = getPriceTier('USD_999');
    const row = await tx.job.create({ data: { buyerId, sellerId, capabilityId, capabilityVersionId: versionId, input: {}, priceSnapshot: price,
      buyerPriceMinor: price.buyerPriceMinor, sellerNetMinor: price.sellerNetMinor, platformFeeMinor: price.platformFeeMinor, executionMode: 'NOW', waitDeadline: new Date(Date.now() + 3600_000) } });
    await reserveJob(tx, row);
    if (settle) {
      await settleJob(tx, await tx.job.update({ where: { id: row.id }, data: { state: 'VALIDATING_RESULTS' } }), false);
      await tx.job.update({ where: { id: row.id }, data: { state: 'SUCCEEDED', completedAt: new Date() } });
    }
    return row;
  });
  beforeAll(async () => {
    process.loadEnvFile('.env');
    if (process.env.KIVRO_ENV !== 'development' || !process.env.DATABASE_URL?.includes(':55432/kivro')) throw new Error('Requires isolated local development services');
    db = new PrismaClient(); identities.push(adminId, sellerId);
    await db.user.create({ data: { id: adminId, email: `${adminId}@dispute.kivro.local`, name: 'Dispute administrator', passwordHash: 'disabled-test-identity', isAdmin: true,
      sessions: { create: { tokenHash: hashSecret(adminToken), expiresAt: new Date(Date.now() + 3600_000) } } } });
    await db.user.create({ data: { id: sellerId, email: `${sellerId}@dispute.kivro.local`, name: 'Dispute ledger seller', passwordHash: 'disabled-test-identity', wallet: { create: {} } } });
    await db.capability.create({ data: { id: capabilityId, sellerId, slug: `dispute-${capabilityId}`, schedule: DEFAULT_SCHEDULE } });
    await db.capabilityVersion.create({ data: { id: versionId, capabilityId, version: 1, title: 'Dispute ledger fixture', summary: '', description: '', category: 'test', tags: [], priceTierId: 'USD_999',
      ioContract: {}, permissions: {}, dependencies: [], internalInstructions: 'Synthetic ledger fixture; never dispatch.', manifestHash: 'f'.repeat(64), publishedAt: new Date() } });
    app = await createApp({ env: { ...process.env, PAYMENT_MODE: 'stripe' }, db, billing, logger: false });
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.user.updateMany({ where: { id: { in: identities } }, data: { suspendedAt: new Date() } });
      await db.capability.updateMany({ where: { id: capabilityId }, data: { paused: true, visibility: 'PRIVATE' } });
      await db.$disconnect();
    }
  });
  it('requires funds proof plus audited admin action, revokes access and never replays an old restoration', async () => {
    const f = await fixture(); expect((await f.paid()).statusCode).toBe(200);
    const reserved = await job(f.userId), eventId = `evt_${randomUUID()}`;
    expect((await f.event('created', 'needs_response', start, {}, eventId)).statusCode).toBe(200);
    expect((await f.event('created', 'needs_response', start, {}, eventId)).statusCode).toBe(200);
    expect(await db.job.findUniqueOrThrow({ where: { id: reserved.id } })).toMatchObject({ state: 'CANCELLED', paymentState: 'RELEASED' });
    expect(await db.ledgerEntry.count({ where: { jobId: reserved.id, type: 'JOB_RELEASE' } })).toBe(1);
    expect(await db.session.count({ where: { userId: f.userId } })).toBe(0);
    expect((await db.apiKey.findFirstOrThrow({ where: { userId: f.userId } })).revokedAt).not.toBeNull();
    const ledgerCount = await db.ledgerEntry.count({ where: { userId: f.userId } });
    expect((await f.event('closed', 'won', start + 10)).statusCode).toBe(200);
    await blocked(f.userId);
    expect((await f.event('funds_reinstated', 'won', start + 11)).statusCode).toBe(200);
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).disputedAt).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).suspendedAt).not.toBeNull();
    const key = randomUUID(), response = await restore(f.userId, key); expect(response.statusCode, response.body).toBe(200);
    expect((await restore(f.userId, key)).json()).toEqual(response.json());
    expect((await restore(f.userId)).json().alreadyActive).toBe(true);
    const audit = await db.auditEvent.findUniqueOrThrow({ where: { id: response.json().auditId } });
    expect(audit.actorId).toBe(adminId); expect(audit.type).toBe('ACCOUNT_RESTORED');
    expect(audit.metadata).toMatchObject({ userId: f.userId, sessionsRestored: false, apiKeysRestored: false, disputes: [{ id: f.disputeId, closedStatus: 'won' }] });
    expect(await db.auditEvent.count({ where: { type: 'ACCOUNT_RESTORED', metadata: { path: ['userId'], equals: f.userId } } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { userId: f.userId } })).toBe(ledgerCount);
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(1000);
    expect((await app.inject({ method: 'POST', url: `/api/admin/users/${f.userId}/suspend`, headers: adminHeaders(), payload: { suspended: true } })).statusCode).toBe(200);
    expect((await restore(f.userId, key)).statusCode).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).suspendedAt).not.toBeNull();
    expect((await restore(f.userId, key, 'Different restoration review must not reuse this key')).statusCode).toBe(409);
    expect(await db.session.count({ where: { userId: f.userId } })).toBe(0);
  });
  it('persists resolved out-of-order cases across restart before checkout without resurrecting a hold', async () => {
    const f = await fixture();
    expect((await f.event('funds_reinstated', 'won', start + 11)).json().outcome).toBe('PENDING');
    expect((await f.event('closed', 'won', start + 10)).json().outcome).toBe('PENDING');
    const restarted = await createApp({ env: { ...process.env, PAYMENT_MODE: 'stripe' }, db, billing, logger: false });
    try {
      expect((await f.event('created', 'needs_response', start, {}, undefined, restarted)).statusCode).toBe(200);
      expect((await f.paid(restarted)).statusCode).toBe(200);
      expect((await f.event('closed', 'won', start + 20, {}, undefined, restarted)).statusCode).toBe(200);
      expect((await f.paid(restarted)).statusCode).toBe(200);
    } finally { await restarted.close(); }
    expect(await db.paymentDispute.findUniqueOrThrow({ where: { id: f.disputeId } })).toMatchObject({ topupId: f.id, closedStatus: 'won', closedEventCreated: start + 10 });
    expect(await db.billingEvent.count({ where: { providerReference: f.pi, outcome: 'PENDING' } })).toBe(0);
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).disputedAt).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).suspendedAt).toBeNull();
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(1000);
    expect(await db.ledgerEntry.count({ where: { userId: f.userId, type: 'CREDIT_PURCHASE' } })).toBe(1);
  });
  it('keeps independent cases and payments blocked until every dispute is cleared', async () => {
    const f = await fixture(), other = await fixture(f.userId), secondId = `dp_${randomUUID()}`;
    await f.paid(); await other.paid();
    for (const [source, id] of [[f, f.disputeId], [f, secondId], [other, other.disputeId]] as const) expect((await source.event('created', 'needs_response', start, { id })).statusCode).toBe(200);
    await f.event('closed', 'won', start + 10); await f.event('funds_reinstated', 'won', start + 11); await blocked(f.userId);
    await f.event('closed', 'warning_closed', start + 10, { id: secondId }); await blocked(f.userId);
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).disputedAt).toBeNull();
    expect((await db.topup.findUniqueOrThrow({ where: { id: other.id } })).disputedAt).not.toBeNull();
    await other.event('closed', 'warning_closed', start + 10);
    expect((await restore(f.userId)).statusCode).toBe(200);
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(2000);
    expect((await app.inject({ url: `/api/admin/users/${f.userId}/billing-review`, headers: adminHeaders() })).json().topups).toHaveLength(2);
  });
  it.each([['funds_withdrawn', 'funds_reinstated'], ['funds_reinstated', 'funds_withdrawn']])('fails closed on same-second financial evidence arriving %s then %s', async (first, second) => {
    const f = await fixture(); await f.paid(); await f.event('created', 'needs_response'); await f.event('closed', 'won', start + 10);
    expect((await f.event(first, 'won', start + 11)).statusCode).toBe(200);
    expect((await f.event(second, 'won', start + 11)).statusCode).toBe(200);
    await blocked(f.userId);
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).disputedAt).not.toBeNull();
    const review = (await app.inject({ url: `/api/admin/users/${f.userId}/billing-review`, headers: adminHeaders() })).json();
    expect(review.topups[0].disputes[0].blockingReason).toBe('FUNDS_REINSTATEMENT_PENDING');
  });
  it('retains lost disputes, accepts a later win with funds proof, and ignores delayed older loss', async () => {
    const f = await fixture(); await f.paid(); await f.event('created', 'needs_response');
    await f.event('funds_withdrawn', 'needs_response', start + 1); await f.event('closed', 'lost', start + 10);
    await blocked(f.userId); await f.event('closed', 'won', start + 20); await blocked(f.userId);
    await f.event('funds_reinstated', 'won', start + 21); await f.event('closed', 'lost', start + 10);
    expect((await restore(f.userId)).statusCode).toBe(200);
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(1000);
  });
  it.each([false, true])('quarantines a later lost financial cycle despite old won proof (reverse delivery %s)', async reverse => {
    const f = await fixture(); await f.paid(); await f.event('created', 'needs_response');
    await f.event('closed', 'won', start + 10); await f.event('funds_reinstated', 'won', start + 11);
    const events = [['funds_withdrawn', start + 20], ['funds_reinstated', start + 21]] as const;
    for (const [type, time] of reverse ? [...events].reverse() : events) {
      const id = `evt_${randomUUID()}`;
      expect((await f.event(type, 'lost', time, {}, id)).statusCode).toBe(200);
      expect((await f.event(type, 'lost', time, {}, id)).statusCode).toBe(200);
      await blocked(f.userId);
    }
    expect((await db.paymentDispute.findUniqueOrThrow({ where: { id: f.disputeId } })).reviewRequired).toBe(true);
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(1000);
  });
  it('accepts reversed delivery of a late-win closure and its later funds proof', async () => {
    const f = await fixture(); await f.paid(); await f.event('created', 'needs_response');
    await f.event('funds_withdrawn', 'needs_response', start + 1); await f.event('closed', 'lost', start + 10);
    await f.event('funds_reinstated', 'won', start + 21); await blocked(f.userId);
    await f.event('closed', 'won', start + 20);
    expect((await restore(f.userId)).statusCode).toBe(200);
  });
  it('does not erase refund debt or settled job accounting when a case closes', async () => {
    const f = await fixture(); await f.paid(); const settled = await job(f.userId, true);
    await f.event('created', 'needs_response'); await f.refund();
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).refundDebtMinor).toBe(999);
    await f.event('closed', 'won', start + 10); await f.event('funds_reinstated', 'won', start + 11);
    await blocked(f.userId, 'REFUND_DEBT_OUTSTANDING');
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).state).toBe('REFUNDED');
    await serializable(db, tx => creditWallet(tx, f.userId, 999, `dispute-debt:${f.id}`));
    const restored = await restore(f.userId); expect(restored.statusCode, restored.body).toBe(200);
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).refundDebtMinor).toBe(0);
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).toMatchObject({ availableMinor: 0, spentMinor: 999 });
    expect((await db.job.findUniqueOrThrow({ where: { id: settled.id } })).paymentState).toBe('SETTLED');
    const entries = await db.ledgerEntry.findMany({ where: { userId: f.userId, type: { notIn: ['JOB_RESERVE', 'JOB_RELEASE'] } } });
    for (const transactionId of new Set(entries.map(entry => entry.transactionId))) expect((await db.ledgerEntry.aggregate({ where: { transactionId }, _sum: { amountMinor: true } }))._sum.amountMinor).toBe(0);
    expect((await db.auditEvent.findUniqueOrThrow({ where: { id: restored.json().auditId } })).metadata).toMatchObject({ refundDebtCollectedMinor: 999 });
  });
  it('rejects mismatched dispute identities/modes and quarantines ambiguous terminal or amount evidence', async () => {
    const f = await fixture(), other = await fixture(); await f.paid(); await other.paid(); await f.event('created', 'needs_response');
    expect((await f.event('closed', 'won', start + 10, { payment_intent: other.pi })).statusCode).toBe(400);
    expect((await send('charge.dispute.closed', f.object('won'), start + 10, undefined, app, true)).statusCode).toBe(400);
    expect((await f.event('closed', 'under_review', start + 10)).statusCode).toBe(400);
    await f.event('closed', 'lost', start + 10); await f.event('closed', 'won', start + 10); await f.event('funds_reinstated', 'won', start + 11);
    await blocked(f.userId); expect((await db.paymentDispute.findUniqueOrThrow({ where: { id: f.disputeId } })).reviewRequired).toBe(true);
    const early = await fixture(); await early.event('closed', 'won', start + 10, { amount: 2000 }); await early.event('funds_reinstated', 'won', start + 11, { amount: 2000 });
    expect((await early.paid()).statusCode).toBe(200); await blocked(early.userId);
    expect((await db.paymentDispute.findUniqueOrThrow({ where: { id: early.disputeId } })).reviewRequired).toBe(true);
  });
  it('requires administrator authority, a review reason and an operation key', async () => {
    const f = await fixture(); await db.user.update({ where: { id: f.userId }, data: { suspendedAt: new Date() } });
    const path = `/api/admin/users/${f.userId}/restore`, payload = { reason: 'Reviewed the manual suspension' };
    expect((await app.inject({ method: 'POST', url: path, headers: { origin: origin() }, payload })).statusCode).toBe(401);
    const nonAdmin = await fixture();
    expect((await app.inject({ method: 'POST', url: path, headers: { origin: origin(), cookie: `kivro_session=${nonAdmin.token}`, 'idempotency-key': randomUUID() }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: path, headers: adminHeaders(), payload })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: path, headers: { ...adminHeaders(), 'idempotency-key': randomUUID() }, payload: { reason: 'short' } })).statusCode).toBe(400);
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).suspendedAt).not.toBeNull();
    expect((await restore(f.userId)).statusCode).toBe(200);
  });
  it('serializes a new dispute against restoration so the resulting account remains held', async () => {
    const f = await fixture(); await f.paid(); await f.event('created', 'needs_response'); await f.event('closed', 'warning_closed', start + 10);
    const [restored, disputed] = await Promise.all([restore(f.userId), f.event('created', 'needs_response', start + 20, { id: `dp_${randomUUID()}` })]);
    expect([200, 409]).toContain(restored.statusCode); expect(disputed.statusCode, disputed.body).toBe(200);
    await blocked(f.userId);
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(1000);
  });
});
