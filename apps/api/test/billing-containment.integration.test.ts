import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient, serializable } from '@kivro/database';
import { StripeBilling, creditWallet, reserveJob, settleJob } from '@kivro/billing';
import { DEFAULT_SCHEDULE, getPriceTier } from '@kivro/contracts';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('durable billing containment (real PostgreSQL, synthetic signed Stripe)', () => {
  let db: PrismaClient, app: FastifyInstance, sellerId: string, workerId: string, capabilityId: string, versionId: string;
  const schema = `billing_containment_${randomBytes(8).toString('hex')}`;
  const secret = 'whsec_billing_containment_synthetic_only';
  const billing = new StripeBilling('sk_test_billing_containment_synthetic_only', secret);
  // Deliberately do not load personal .env or provider keys. Only the documented local DB is used.
  const env = { NODE_ENV: 'test', KIVRO_ENV: 'test', PAYMENT_MODE: 'stripe', WEB_ORIGIN: 'http://localhost:3000',
    DATABASE_URL: `postgresql://kivro:kivro_local_only@127.0.0.1:55432/kivro?schema=${schema}`,
    S3_ENDPOINT: 'http://127.0.0.1:59000', S3_BUCKET: 'unused-containment-fixture', S3_ACCESS_KEY: 'unused', S3_SECRET_KEY: 'unused' };
  const startApp = () => createApp({ env, db, billing, logger: false, mailer: null });
  const send = (type: string, object: Record<string, unknown>, id = `evt_${randomUUID()}`) => {
    const payload = JSON.stringify({ id, object: 'event', api_version: '2025-03-31.basil', created: Math.floor(Date.now() / 1000), livemode: false, type, data: { object } });
    const signature = billing.stripe.webhooks.generateTestHeaderString({ payload, secret });
    return app.inject({ method: 'POST', url: '/api/billing/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, payload });
  };
  const user = async () => {
    const id = randomUUID(), token = randomUUID(), key = randomUUID();
    await db.user.create({ data: { id, email: `${id}@billing-containment.kivro.local`, name: 'Synthetic billing containment', passwordHash: 'disabled',
      wallet: { create: {} }, sessions: { create: { tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + 600_000) } },
      apiKeys: { create: { name: 'Fixture', prefix: key.slice(0, 12), secretHash: hashSecret(key), scopes: ['jobs:read'] } } } });
    return id;
  };
  const fixture = async (paid = true, amountMinor = 1000) => {
    const userId = await user(), id = randomUUID(), pi = `pi_${id}`;
    await db.topup.create({ data: { id, userId, idempotencyKey: randomUUID(), amountMinor } });
    const checkout = { id: `cs_${id}`, payment_intent: pi, currency: 'usd', amount_total: amountMinor, payment_status: 'paid', metadata: { topupId: id, userId } };
    const charge = { id: `ch_${id}`, payment_intent: pi, currency: 'usd', amount: amountMinor, amount_refunded: amountMinor, metadata: { topupId: id, userId } };
    const dispute = { id: `dp_${id}`, payment_intent: pi, currency: 'usd', amount: amountMinor, status: 'needs_response' };
    if (paid) {
      const response = await send('checkout.session.completed', checkout);
      expect(response.statusCode, response.body).toBe(200);
    }
    return { id, userId, pi, checkout, charge, dispute };
  };
  const market = async (ownerId: string) => {
    const keys = generateKeyPairSync('ed25519');
    const worker = await db.workerDevice.create({ data: { sellerId: ownerId, name: 'Synthetic billing worker', version: '0.1.0',
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } });
    const cap = await db.capability.create({ data: { sellerId: ownerId, slug: randomUUID(), schedule: DEFAULT_SCHEDULE } });
    const version = await db.capabilityVersion.create({ data: { capabilityId: cap.id, version: 1, title: 'Billing isolation fixture', summary: '', description: '', category: 'test', tags: [],
      priceTierId: 'USD_99', ioContract: {}, permissions: {}, dependencies: [], internalInstructions: 'Synthetic accounting fixture; never dispatch.', manifestHash: 'f'.repeat(64) } });
    return { sellerId: ownerId, workerId: worker.id, capabilityId: cap.id, capabilityVersionId: version.id };
  };
  const job = async (buyerId: string, kind: 'damaged' | 'healthy' | 'settled' = 'healthy', source = { sellerId, workerId, capabilityId, capabilityVersionId: versionId }, options: { id?: string; priceTierId?: string } = {}) => serializable(db, async tx => {
    const price = getPriceTier(options.priceTierId ?? (kind === 'damaged' ? 'USD_999' : kind === 'settled' ? 'USD_499' : 'USD_99'));
    const row = await tx.job.create({ data: { id: options.id, buyerId, sellerId: source.sellerId, capabilityId: source.capabilityId, capabilityVersionId: source.capabilityVersionId, state: 'PAUSED', paymentState: 'RESERVED', input: {},
      priceSnapshot: price, buyerPriceMinor: price.buyerPriceMinor, sellerNetMinor: price.sellerNetMinor, platformFeeMinor: price.platformFeeMinor,
      executionMode: 'NOW', waitDeadline: new Date(Date.now() + 600_000) } });
    // A damaged job deliberately has no reserve entry, regardless of the pooled wallet balance.
    if (kind !== 'damaged') await reserveJob(tx, row);
    if (kind === 'settled') {
      await settleJob(tx, await tx.job.update({ where: { id: row.id }, data: { state: 'VALIDATING_RESULTS' } }), false);
      return tx.job.update({ where: { id: row.id }, data: { state: 'SUCCEEDED', completedAt: new Date() } });
    }
    const attempt = await tx.jobAttempt.create({ data: { jobId: row.id, workerId: source.workerId, state: 'PAUSED', acceptedAt: new Date(), expiresAt: new Date(Date.now() + 600_000), nonce: randomUUID() } });
    const asset = await tx.asset.create({ data: { ownerId: buyerId, jobId: row.id, filename: 'synthetic.txt', mimeType: 'text/plain', sizeBytes: 1,
      sha256: 'a'.repeat(64), objectKey: `unused-containment/${randomUUID()}`, scanStatus: 'CLEAN', expiresAt: new Date(Date.now() + 600_000) } });
    await tx.assetGrant.create({ data: { assetId: asset.id, jobId: row.id, expiresAt: new Date(Date.now() + 600_000) } });
    return tx.job.update({ where: { id: row.id }, data: { activeAttemptId: attempt.id } });
  });
  const assertHeld = async (userId: string, jobIds: string[]) => {
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).suspendedAt).not.toBeNull();
    expect(await db.session.count({ where: { userId } })).toBe(0);
    expect(await db.apiKey.count({ where: { userId, revokedAt: null } })).toBe(0);
    for (const id of jobIds) {
      expect((await db.job.findUniqueOrThrow({ where: { id } })).executionRevokedAt).not.toBeNull();
      expect(await db.assetGrant.count({ where: { jobId: id } })).toBe(0);
      expect(await db.workerCommand.count({ where: { jobId: id, type: 'CANCEL_JOB' } })).toBe(1);
      expect(await db.jobEvent.count({ where: { jobId: id, type: 'EXECUTION_REVOKED' } })).toBe(1);
    }
  };
  const assertIsolated = async (damagedId: string, healthyId: string) => {
    expect(await db.job.findUniqueOrThrow({ where: { id: damagedId } })).toMatchObject({ state: 'PAUSED', paymentState: 'RESERVED' });
    expect(await db.ledgerEntry.count({ where: { jobId: damagedId, type: 'JOB_RELEASE' } })).toBe(0);
    expect((await db.platformSetting.findUniqueOrThrow({ where: { key: `job-recovery-error:${damagedId}` } })).value).toMatchObject({ code: 'LEDGER_INVARIANT' });
    expect(await db.auditEvent.count({ where: { jobId: damagedId, type: 'JOB_RECOVERY_REQUIRED' } })).toBe(1);
    expect(await db.job.findUniqueOrThrow({ where: { id: healthyId } })).toMatchObject({ state: 'CANCELLED', paymentState: 'RELEASED' });
    expect(await db.ledgerEntry.count({ where: { jobId: healthyId, type: 'JOB_RELEASE' } })).toBe(1);
  };
  const assertBalanced = async () => {
    const transfers = await db.ledgerEntry.findMany({ where: { type: { in: ['JOB_RESERVE', 'JOB_RELEASE'] } } });
    for (const entry of transfers) {
      expect(entry.availableDelta + entry.reservedDelta).toBe(0);
      expect(Math.abs(entry.availableDelta)).toBe(entry.amountMinor);
    }
    const totals = await db.ledgerEntry.groupBy({ where: { type: { notIn: ['JOB_RESERVE', 'JOB_RELEASE'] } }, by: ['transactionId'], _sum: { amountMinor: true } });
    expect(totals.filter(total => total._sum.amountMinor !== 0)).toEqual([]);
  };
  beforeAll(async () => {
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: env.DATABASE_URL } });
    db = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    sellerId = await user();
    const source = await market(sellerId);
    workerId = source.workerId; capabilityId = source.capabilityId; versionId = source.capabilityVersionId;
    app = await startApp();
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      if (!/^billing_containment_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe fixture schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await db.$disconnect();
    }
  });

  it.each(['dispute', 'refund'] as const)('%s commits containment and receipt despite a damaged reservation, with independent healthy release', async kind => {
    const f = await fixture(), other = await fixture();
    const damaged = await job(f.userId, 'damaged'), healthy = await job(f.userId), untouched = await job(other.userId);
    const id = `evt_${randomUUID()}`, type = kind === 'dispute' ? 'charge.dispute.created' : 'charge.refunded', object = kind === 'dispute' ? f.dispute : f.charge;
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await send(type, object, id); expect(response.statusCode, response.body).toBe(200);
    }
    await assertHeld(f.userId, [damaged.id, healthy.id]);
    await assertIsolated(damaged.id, healthy.id);
    expect(await db.billingEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({ outcome: 'PROCESSED', providerReference: f.pi });
    expect((await db.user.findUniqueOrThrow({ where: { id: other.userId } })).suspendedAt).toBeNull();
    expect(await db.job.findUniqueOrThrow({ where: { id: untouched.id } })).toMatchObject({ state: 'PAUSED', paymentState: 'RESERVED', executionRevokedAt: null });
    if (kind === 'dispute') {
      expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).disputedAt).not.toBeNull();
      expect(await db.paymentDispute.findUniqueOrThrow({ where: { id: f.dispute.id } })).toMatchObject({ topupId: f.id, status: 'needs_response' });
      expect(await db.auditEvent.count({ where: { actorId: f.userId, type: 'PAYMENT_DISPUTED' } })).toBe(1);
      expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(1000);
    } else {
      expect(await db.topup.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ refundedMinor: 1000, refundAppliedMinor: 1000, refundDebtMinor: 0 });
      expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(0);
      expect(await db.ledgerEntry.count({ where: { userId: f.userId, type: 'TOPUP_REFUND' } })).toBe(1);
      expect(await db.ledgerEntry.count({ where: { userId: f.userId, type: 'REFUND_DEBT_COLLECTION' } })).toBe(1);
      expect(await db.auditEvent.count({ where: { actorId: f.userId, type: 'TOPUP_REFUND_RECONCILED' } })).toBe(1);
    }
    await assertBalanced();
  });

  it('commits partial debt collection and duplicate delivery collects only subsequently available funds', async () => {
    const f = await fixture(), damaged = await job(f.userId, 'damaged'), healthy = await job(f.userId);
    await job(f.userId, 'settled');
    const id = `evt_${randomUUID()}`;
    const initial = await send('charge.refunded', f.charge, id); expect(initial.statusCode, initial.body).toBe(200);
    await assertHeld(f.userId, [damaged.id, healthy.id]); await assertIsolated(damaged.id, healthy.id);
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).refundDebtMinor).toBe(499);
    for (const [funding, remaining] of [[200, 299], [299, 0]] as const) {
      await serializable(db, tx => creditWallet(tx, f.userId, funding, `fixture-funding:${randomUUID()}`));
      const response = await send('charge.refunded', f.charge, id); expect(response.statusCode, response.body).toBe(200);
      expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).refundDebtMinor).toBe(remaining);
      expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(0);
      expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).suspendedAt).not.toBeNull();
    }
    expect(await db.ledgerEntry.count({ where: { userId: f.userId, type: 'TOPUP_REFUND' } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { userId: f.userId, type: 'REFUND_DEBT_COLLECTION' } })).toBe(3);
    await assertBalanced();
  });

  it.each(['dispute', 'refund'].flatMap(kind => ['damaged-first', 'healthy-first'].flatMap(order => ['equal', 'smaller'].map(size => ({ kind, order, size })))))('$kind isolates $size unbacked job with $order ordering and concurrent replay', async ({ kind, order, size }) => {
    const f = await fixture();
    const first = `00000000-0000-4000-8000-${randomBytes(6).toString('hex')}`, last = `ffffffff-ffff-4fff-8fff-${randomBytes(6).toString('hex')}`;
    const damaged = await job(f.userId, 'damaged', undefined, { id: order === 'damaged-first' ? first : last, priceTierId: 'USD_99' });
    const healthy = await job(f.userId, 'healthy', undefined, { id: order === 'healthy-first' ? first : last, priceTierId: size === 'equal' ? 'USD_99' : 'USD_499' });
    const id = `evt_${randomUUID()}`, type = kind === 'dispute' ? 'charge.dispute.created' : 'charge.refunded', object = kind === 'dispute' ? f.dispute : f.charge;
    for (const response of await Promise.all([send(type, object, id), send(type, object, id)])) expect(response.statusCode, response.body).toBe(200);
    for (const replay of await Promise.all([send(type, object, id), send(type, object, id)])) expect(replay.statusCode, replay.body).toBe(200);
    await assertHeld(f.userId, [damaged.id, healthy.id]); await assertIsolated(damaged.id, healthy.id);
    expect(await db.ledgerEntry.count({ where: { jobId: damaged.id } })).toBe(0);
    expect(await db.ledgerEntry.count({ where: { jobId: healthy.id, type: 'JOB_RESERVE' } })).toBe(1);
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).toMatchObject({ reservedMinor: 0, availableMinor: kind === 'dispute' ? 1000 : 0 });
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).refundDebtMinor).toBe(0);
    await assertBalanced();
  });

  it.each(['single', 'partial', 'legacy'] as const)('collects recurring 499 debt with monotonic identities, restart and concurrent replay (%s)', async mode => {
    const f = await fixture(true, 998);
    await job(f.userId, 'settled'); await job(f.userId, 'settled');
    const partial = { ...f.charge, amount_refunded: 499 }, firstId = `evt_${randomUUID()}`, secondId = `evt_${randomUUID()}`;
    const first = await send('charge.refunded', partial, firstId); expect(first.statusCode, first.body).toBe(200);
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).refundDebtMinor).toBe(499);
    await serializable(db, tx => creditWallet(tx, f.userId, 499, `fixture-funding:${randomUUID()}`));
    if (mode === 'legacy') {
      // Existing append-only evidence from the pre-fix implementation must remain usable.
      await serializable(db, async tx => {
        await tx.wallet.update({ where: { userId: f.userId }, data: { availableMinor: { decrement: 499 } } });
        await tx.topup.update({ where: { id: f.id }, data: { refundDebtMinor: 0 } });
        const transactionId = randomUUID(), operationKey = `topup:${f.id}:debt:499`;
        await tx.ledgerEntry.createMany({ data: [
          { operationKey, transactionId, userId: f.userId, type: 'REFUND_DEBT_COLLECTION', amountMinor: -499, availableDelta: -499, metadata: { topupId: f.id } },
          { operationKey: `${operationKey}:receivable`, transactionId, userId: f.userId, type: 'REFUND_RECEIVABLE_RECOVERY', amountMinor: 499, metadata: { topupId: f.id } },
        ] });
      });
    } else {
      for (const replay of await Promise.all([send('charge.refunded', partial, firstId), send('charge.refunded', partial, firstId)])) expect(replay.statusCode, replay.body).toBe(200);
    }
    const second = await send('charge.refunded', f.charge, secondId); expect(second.statusCode, second.body).toBe(200);
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).refundDebtMinor).toBe(499);
    await app.close(); app = await startApp();
    for (const funding of mode === 'partial' ? [200, 299] : [499]) {
      await serializable(db, tx => creditWallet(tx, f.userId, funding, `fixture-funding:${randomUUID()}`));
      for (const replay of await Promise.all([send('charge.refunded', f.charge, secondId), send('charge.refunded', partial, firstId), send('charge.refunded', f.charge, secondId)])) expect(replay.statusCode, replay.body).toBe(200);
    }
    expect(await db.topup.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ refundedMinor: 998, refundAppliedMinor: 998, refundDebtMinor: 0 });
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).toMatchObject({ availableMinor: 0, reservedMinor: 0 });
    const collections = await db.ledgerEntry.findMany({ where: { userId: f.userId, type: 'REFUND_DEBT_COLLECTION' }, orderBy: { createdAt: 'asc' } });
    expect(collections.map(row => row.operationKey)).toEqual(mode === 'legacy' ? [`topup:${f.id}:debt:499`, `topup:${f.id}:debt-collected:998`] :
      (mode === 'partial' ? [499, 699, 998] : [499, 998]).map(total => `topup:${f.id}:debt-collected:${total}`));
    expect(collections.reduce((total, row) => total - row.amountMinor, 0)).toBe(998);
    expect(await db.ledgerEntry.count({ where: { userId: f.userId, type: 'TOPUP_REFUND' } })).toBe(2);
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).suspendedAt).not.toBeNull();
    await assertBalanced();
  });

  it.each(['dispute', 'refund'] as const)('%s holds also stop the suspended account acting as a seller without suspending its buyers', async kind => {
    const f = await fixture(), other = await fixture(), source = await market(f.userId);
    const damaged = await job(f.userId, 'damaged'), ownPurchase = await job(f.userId), sale = await job(other.userId, 'healthy', source);
    const response = await send(kind === 'dispute' ? 'charge.dispute.created' : 'charge.refunded', kind === 'dispute' ? f.dispute : f.charge);
    expect(response.statusCode, response.body).toBe(200);
    await assertHeld(f.userId, [damaged.id, ownPurchase.id, sale.id]);
    await assertIsolated(damaged.id, ownPurchase.id);
    expect(await db.job.findUniqueOrThrow({ where: { id: sale.id } })).toMatchObject({ state: 'CANCELLED', paymentState: 'RELEASED' });
    expect((await db.user.findUniqueOrThrow({ where: { id: other.userId } })).suspendedAt).toBeNull();
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: other.userId } })).availableMinor).toBe(1000);
    await assertBalanced();
  });

  it.each(['dispute', 'refund'] as const)('%s duplicate resumes an interrupted healthy release after restart using its durable receipt', async kind => {
    const f = await fixture(), damaged = await job(f.userId, 'damaged'), healthy = await job(f.userId), id = `evt_${randomUUID()}`;
    const type = kind === 'dispute' ? 'charge.dispute.created' : 'charge.refunded', object = kind === 'dispute' ? f.dispute : f.charge;
    await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".reject_job_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.type = 'JOB_RELEASE' THEN RAISE EXCEPTION 'synthetic interrupted release'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER reject_job_release BEFORE INSERT ON "${schema}"."LedgerEntry" FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_job_release()`);
    try {
      const response = await send(type, object, id); expect(response.statusCode, response.body).toBe(200);
      await assertHeld(f.userId, [damaged.id, healthy.id]);
      expect(await db.job.findUniqueOrThrow({ where: { id: healthy.id } })).toMatchObject({ state: 'PAUSED', paymentState: 'RESERVED' });
      expect(await db.ledgerEntry.count({ where: { jobId: healthy.id, type: 'JOB_RELEASE' } })).toBe(0);
      expect(await db.platformSetting.findUnique({ where: { key: `job-recovery-error:${healthy.id}` } })).not.toBeNull();
      expect(await db.billingEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({ outcome: 'PROCESSED' });
      await app.close(); app = await startApp();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER reject_job_release ON "${schema}"."LedgerEntry"`);
      await db.$executeRawUnsafe(`DROP FUNCTION "${schema}".reject_job_release()`);
    }
    const replay = await send(type, object, id); expect(replay.statusCode, replay.body).toBe(200);
    await assertHeld(f.userId, [damaged.id, healthy.id]); await assertIsolated(damaged.id, healthy.id);
    expect(await db.platformSetting.findUnique({ where: { key: `job-recovery-error:${healthy.id}` } })).toBeNull();
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).refundDebtMinor).toBe(0);
    await assertBalanced();
  });

  it('restart and altered duplicate resume only the committed refund after a real post-commit database failure', async () => {
    const f = await fixture(), other = await fixture();
    const damaged = await job(f.userId, 'damaged'), healthy = await job(f.userId), untouched = await job(other.userId);
    const id = `evt_${randomUUID()}`;
    await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".reject_debt_collection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.type = 'REFUND_DEBT_COLLECTION' THEN RAISE EXCEPTION 'synthetic post-commit collection failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER reject_debt_collection BEFORE INSERT ON "${schema}"."LedgerEntry" FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_debt_collection()`);
    try {
      const response = await send('charge.refunded', f.charge, id); expect(response.statusCode, response.body).toBe(500);
      await assertHeld(f.userId, [damaged.id, healthy.id]); await assertIsolated(damaged.id, healthy.id);
      expect(await db.billingEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({ payload: { topupId: f.id, userId: f.userId } });
      expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).refundDebtMinor).toBe(99);
      expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(99);
      await app.close(); app = await startApp();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER reject_debt_collection ON "${schema}"."LedgerEntry"`);
      await db.$executeRawUnsafe(`DROP FUNCTION "${schema}".reject_debt_collection()`);
    }
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await send('charge.refunded', other.charge, id); expect(response.statusCode, response.body).toBe(200);
    }
    expect((await db.topup.findUniqueOrThrow({ where: { id: f.id } })).refundDebtMinor).toBe(0);
    expect((await db.topup.findUniqueOrThrow({ where: { id: other.id } })).refundedMinor).toBe(0);
    expect(await db.job.findUniqueOrThrow({ where: { id: untouched.id } })).toMatchObject({ executionRevokedAt: null, paymentState: 'RESERVED' });
    expect(await db.ledgerEntry.count({ where: { userId: f.userId, type: 'TOPUP_REFUND' } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { userId: f.userId, type: 'REFUND_DEBT_COLLECTION' } })).toBe(1);
    const mismatch = await send('charge.dispute.created', f.dispute, id); expect(mismatch.statusCode).toBe(400);
    await assertBalanced();
  });

  it('late checkout after a pending dispute commits credit and hold despite damaged reservations, including after restart/replay', async () => {
    const f = await fixture(false);
    await serializable(db, tx => creditWallet(tx, f.userId, 1000, `fixture-funding:${randomUUID()}`));
    const damaged = await job(f.userId, 'damaged'), healthy = await job(f.userId), disputeEventId = `evt_${randomUUID()}`;
    const pending = await send('charge.dispute.created', f.dispute, disputeEventId);
    expect(pending.statusCode, pending.body).toBe(200); expect(pending.json().outcome).toBe('PENDING');
    await app.close(); app = await startApp();
    const checkoutId = `evt_${randomUUID()}`;
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await send('checkout.session.completed', f.checkout, checkoutId); expect(response.statusCode, response.body).toBe(200);
      expect((await send('charge.dispute.created', f.dispute, disputeEventId)).statusCode).toBe(200);
    }
    await assertHeld(f.userId, [damaged.id, healthy.id]); await assertIsolated(damaged.id, healthy.id);
    expect(await db.billingEvent.findUniqueOrThrow({ where: { id: disputeEventId } })).toMatchObject({ outcome: 'PROCESSED' });
    expect(await db.ledgerEntry.count({ where: { operationKey: `stripe-topup:${f.id}` } })).toBe(1);
    expect(await db.auditEvent.count({ where: { actorId: f.userId, type: 'PAYMENT_DISPUTED' } })).toBe(1);
    await assertBalanced();
  });

  it('refund-before-credit records the canonical refund without a premature account hold', async () => {
    const f = await fixture(false), damaged = await job(f.userId, 'damaged');
    const response = await send('charge.refunded', f.charge); expect(response.statusCode, response.body).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).suspendedAt).toBeNull();
    expect((await db.job.findUniqueOrThrow({ where: { id: damaged.id } })).executionRevokedAt).toBeNull();
    expect((await send('checkout.session.completed', f.checkout)).statusCode).toBe(200);
    expect(await db.topup.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ refundAppliedMinor: 1000, refundDebtMinor: 0 });
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(0);
    await assertBalanced();
  });

  it('a database serialization retry commits one set of effects, never effects from the aborted attempt', async () => {
    const f = await fixture(), damaged = await job(f.userId, 'damaged'), healthy = await job(f.userId), id = `evt_${randomUUID()}`;
    await db.$executeRawUnsafe(`CREATE SEQUENCE "${schema}".receipt_retry`);
    await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".retry_receipt_once() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF nextval('"${schema}".receipt_retry') = 1 THEN RAISE EXCEPTION 'synthetic serialization conflict' USING ERRCODE = '40001'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER retry_receipt_once AFTER INSERT ON "${schema}"."BillingEvent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${schema}".retry_receipt_once()`);
    try {
      const response = await send('charge.refunded', f.charge, id); expect(response.statusCode, response.body).toBe(200);
      expect(await db.$queryRawUnsafe(`SELECT last_value::integer AS attempts FROM "${schema}".receipt_retry`)).toEqual([{ attempts: 2 }]);
      await assertHeld(f.userId, [damaged.id, healthy.id]); await assertIsolated(damaged.id, healthy.id);
      expect(await db.ledgerEntry.count({ where: { userId: f.userId, type: 'TOPUP_REFUND' } })).toBe(1);
      expect(await db.auditEvent.count({ where: { actorId: f.userId, type: 'TOPUP_REFUND_RECONCILED' } })).toBe(1);
      await assertBalanced();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER retry_receipt_once ON "${schema}"."BillingEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION "${schema}".retry_receipt_once()`);
      await db.$executeRawUnsafe(`DROP SEQUENCE "${schema}".receipt_retry`);
    }
  });

  it.each([undefined, null, '1000', -1, 1001, 1.5, Number.MAX_SAFE_INTEGER])('rejects invalid cumulative refund %s before containment or receipt storage', async amount => {
    const f = await fixture(), damaged = await job(f.userId, 'damaged'), id = `evt_${randomUUID()}`;
    const response = await send('charge.refunded', { ...f.charge, amount_refunded: amount }, id);
    expect(response.statusCode, response.body).toBe(400); expect(response.json().error.code).toBe('INVALID_REFUND');
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).suspendedAt).toBeNull();
    expect((await db.job.findUniqueOrThrow({ where: { id: damaged.id } })).executionRevokedAt).toBeNull();
    expect(await db.billingEvent.findUnique({ where: { id } })).toBeNull();
    expect(await db.session.count({ where: { userId: f.userId } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { userId: f.userId, type: 'TOPUP_REFUND' } })).toBe(0);
  });

  it.each([
    { currency: 'eur' }, { amount: 999 }, { payment_intent: null }, { payment_intent: 'not-a-payment-intent' }, { payment_intent: 'pi_unrelated' },
    { id: 'not-a-charge' }, { metadata: { topupId: 'not-a-uuid' } }, { metadata: { topupId: randomUUID() } },
    { metadata: { userId: randomUUID() } }, { livemode: true },
  ])('rejects conflicting canonical refund identity %j before containment', async overrides => {
    const f = await fixture(), damaged = await job(f.userId, 'damaged'), id = `evt_${randomUUID()}`;
    const response = await send('charge.refunded', { ...f.charge, ...overrides }, id); expect(response.statusCode, response.body).toBe(400);
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).suspendedAt).toBeNull();
    expect((await db.job.findUniqueOrThrow({ where: { id: damaged.id } })).executionRevokedAt).toBeNull();
    expect(await db.billingEvent.findUnique({ where: { id } })).toBeNull();
    expect((await db.wallet.findUniqueOrThrow({ where: { userId: f.userId } })).availableMinor).toBe(1000);
  });

  it('neither a cleared dispute nor a fully collected refund restores an independently held account', async () => {
    const f = await fixture(), heldSince = new Date(Date.now() - 60_000);
    await db.user.update({ where: { id: f.userId }, data: { suspendedAt: heldSince } });
    const response = await send('charge.dispute.closed', { ...f.dispute, status: 'warning_closed' }); expect(response.statusCode, response.body).toBe(200);
    expect((await send('charge.refunded', { ...f.charge, amount_refunded: 500 })).statusCode).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).suspendedAt).toEqual(heldSince);
    await assertBalanced();
  });
});
