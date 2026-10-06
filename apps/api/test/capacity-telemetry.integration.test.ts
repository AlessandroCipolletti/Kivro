import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, serializable, type Prisma } from '@kivro/database';
import { DEFAULT_SCHEDULE } from '@kivro/contracts';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';
import { operationsSnapshot, type OperationsDTO } from '../src/operations.js';
import { capacityAnalytics, recordCapacityObservation, recordQueueFullRejection, reconcileCapacityTelemetry } from '../src/capacity-telemetry.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('capacity analytics (isolated real PostgreSQL)', () => {
  const schema = `capacity_telemetry_${randomBytes(8).toString('hex')}`;
  const url = `postgresql://kivro:kivro_local_only@127.0.0.1:55432/kivro?schema=${schema}`;
  let db: PrismaClient, app: Awaited<ReturnType<typeof createApp>>;
  const now = new Date(), at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  const seller = randomUUID(), other = randomUUID(), buyer = randomUUID(), admin = randomUUID();
  const sellerToken = randomUUID(), otherToken = randomUUID(), adminToken = randomUUID(), apiKey = randomUUID();
  const env = { NODE_ENV: 'test', KIVRO_ENV: 'test', PAYMENT_MODE: 'fake', WEB_ORIGIN: 'http://localhost:3000', DATABASE_URL: url,
    S3_ENDPOINT: 'http://127.0.0.1:59000', S3_BUCKET: 'unused-capacity', S3_ACCESS_KEY: 'unused', S3_SECRET_KEY: 'unused' };
  const startApp = () => createApp({ env, db, logger: false, mailer: null });
  const capability = async (owner = seller, createdAt = at(-3600), published = true) => {
    const cap = await db.capability.create({ data: { sellerId: owner, slug: randomUUID(), schedule: DEFAULT_SCHEDULE, createdAt } });
    const version = await db.capabilityVersion.create({ data: { capabilityId: cap.id, version: 1, title: `Capacity ${cap.id}`, summary: '', description: '', category: 'test', tags: [],
      priceTierId: 'USD_99', ioContract: {}, permissions: {}, dependencies: [], internalInstructions: 'private-capacity-secret', manifestHash: 'a'.repeat(64) } });
    if (published) await db.capability.update({ where: { id: cap.id }, data: { currentVersionId: version.id } });
    return { ...cap, versionId: version.id };
  };
  const observe = (id: string, status: Parameters<typeof recordCapacityObservation>[2], time: Date) => serializable(db, tx => recordCapacityObservation(tx, id, status, time));
  const snapshot = async (id: string, end = now, start = at(-3600)) => {
    const dto = await db.$transaction(tx => capacityAnalytics(tx, undefined, start, end, 90));
    return dto.items.find(item => item.capabilityId === id)!;
  };
  beforeAll(async () => {
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url } });
    db = new PrismaClient({ datasourceUrl: url });
    for (const [id, token] of [[seller, sellerToken], [other, otherToken], [buyer, randomUUID()], [admin, adminToken]]) {
      await db.user.create({ data: { id, name: 'Synthetic capacity metrics', email: `${id}@capacity.kivro.local`, passwordHash: 'disabled', isAdmin: id === admin,
        emailVerifiedAt: at(-7200), sessions: { create: { tokenHash: hashSecret(token!), expiresAt: at(3600) } } } });
    }
    await db.apiKey.create({ data: { userId: admin, name: 'Denied telemetry key', prefix: 'capacity', secretHash: hashSecret(apiKey), scopes: ['jobs:read', 'capabilities:read'] } });
    app = await startApp();
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      if (!/^capacity_telemetry_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe fixture schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await db.$disconnect();
    }
  });

  it('keeps an unobserved or newly first-observed capability entirely unknown', async () => {
    const cap = await capability();
    expect((await snapshot(cap.id)).coverage).toMatchObject({ observedMs: 0, unknownMs: 3600000, ratio: 0, firstObservedAt: null });
    await observe(cap.id, 'ONLINE', at(-60));
    const row = await snapshot(cap.id);
    expect(row.coverage).toMatchObject({ eligibleMs: 3600000, observedMs: 0, unknownMs: 3600000, observationCount: 1,
      firstObservedAt: at(-60).toISOString(), lastObservedAt: at(-60).toISOString() });
    expect(row.durations.onlineMs).toBe(0);
  });

  it('records bounded sampled states and never fills a restart gap or the trailing interval', async () => {
    const cap = await capability();
    await observe(cap.id, 'ONLINE', at(-900)); await observe(cap.id, 'BUSY', at(-870));
    await app.close(); app = await startApp();
    await observe(cap.id, 'OFFLINE', at(-810)); await observe(cap.id, 'ONLINE', at(-780));
    await observe(cap.id, 'BUSY', at(-300)); await observe(cap.id, 'OFFLINE', at(-270));
    const row = await snapshot(cap.id);
    expect(row.durations).toEqual({ onlineMs: 30000, busyMs: 90000, offlineMs: 30000, scheduledOfflineMs: 0, pausedMs: 0, securityBlockedMs: 0 });
    expect(row.coverage).toMatchObject({ observedMs: 150000, unknownMs: 3450000, observationCount: 6 });
  });

  it('deduplicates simultaneous repeated observations and ignores stale timestamps', async () => {
    const cap = await capability();
    await observe(cap.id, 'ONLINE', at(-100));
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => observe(cap.id, 'BUSY', at(-70))));
    expect(concurrent.filter(Boolean)).toHaveLength(1);
    expect(await observe(cap.id, 'OFFLINE', at(-90))).toBe(false);
    expect(await snapshot(cap.id)).toMatchObject({ durations: { onlineMs: 30000 }, coverage: { observationCount: 2, observedMs: 30000 } });
  });

  it('keeps schedule, pause and security states separate and clips to the requested window', async () => {
    const cap = await capability(seller, at(-600));
    await observe(cap.id, 'SCHEDULED_OFFLINE', at(-300)); await observe(cap.id, 'PAUSED', at(-240));
    await observe(cap.id, 'SECURITY_BLOCKED', at(-180)); await observe(cap.id, 'ONLINE', at(-120));
    const row = await snapshot(cap.id, now, at(-270));
    expect(row.durations).toMatchObject({ scheduledOfflineMs: 30000, pausedMs: 60000, securityBlockedMs: 60000, onlineMs: 0 });
    expect(row.coverage).toMatchObject({ eligibleMs: 270000, observedMs: 150000, unknownMs: 120000 });
  });

  it('resets malformed checkpoints without attributing their gap and exposes malformed events', async () => {
    const cap = await capability();
    await db.platformSetting.create({ data: { key: `capacity-observation:${cap.id}`, value: { at: 'bad' } } });
    await observe(cap.id, 'ONLINE', at(-100));
    await db.auditEvent.create({ data: { sellerId: seller, type: 'CAPACITY_OBSERVATION', createdAt: at(-90), metadata: { capabilityId: cap.id, kind: 'INTERVAL', fromMs: 'bad', toMs: -1 } } });
    expect((await snapshot(cap.id)).coverage).toMatchObject({ observedMs: 0, observationCount: 2, invalidObservationCount: 1 });
  });

  it('counts the exact observation gap limit but leaves larger gaps unknown', async () => {
    const cap = await capability();
    await observe(cap.id, 'ONLINE', at(-500)); await observe(cap.id, 'BUSY', at(-380));
    await observe(cap.id, 'OFFLINE', new Date(at(-260).getTime() + 1));
    expect(await snapshot(cap.id)).toMatchObject({ durations: { onlineMs: 120000, busyMs: 0 }, coverage: { observedMs: 120000 } });
  });

  it('never attributes time before creation, and zero elapsed eligibility has no coverage percentage', async () => {
    const cap = await capability(seller, at(-10));
    await expect(observe(cap.id, 'ONLINE', at(-11))).rejects.toThrow('Observation predates capability');
    await observe(cap.id, 'ONLINE', at(-10));
    const row = await snapshot(cap.id, at(-10));
    expect(row.coverage).toMatchObject({ eligibleMs: 0, observedMs: 0, unknownMs: 0, ratio: null });
  });

  it('retains old marker identity without claiming observations outside event retention', async () => {
    const created = at(-100 * 86400), cap = await capability(seller, created);
    await observe(cap.id, 'ONLINE', at(-95 * 86400)); await observe(cap.id, 'BUSY', at(-95 * 86400 + 30));
    await observe(cap.id, 'OFFLINE', at(-40 * 86400)); await observe(cap.id, 'ONLINE', at(-40 * 86400 + 30));
    await observe(cap.id, 'BUSY', at(-60)); await observe(cap.id, 'OFFLINE', at(-30));
    const dto = await db.$transaction(tx => capacityAnalytics(tx, seller, at(-90 * 86400), now, 30));
    const row = dto.items.find(item => item.capabilityId === cap.id)!;
    expect(row.coverage).toMatchObject({ observedMs: 30000, firstObservedAt: at(-95 * 86400).toISOString(), observationCount: 2 });
    expect(row.durations).toMatchObject({ onlineMs: 0, offlineMs: 0, busyMs: 30000 });
    expect(row.queueFullCoverageFrom && Date.parse(row.queueFullCoverageFrom)).toBeGreaterThanOrEqual(at(-30 * 86400).getTime());
  });

  it('persists a rejected purchase independently and deduplicates retry, restart and concurrent delivery', async () => {
    const cap = await capability(), key = 'private-purchase-rejection';
    for (const run of [0, 1]) {
      if (run) { await app.close(); app = await startApp(); }
      await Promise.all(Array.from({ length: 3 }, () => recordQueueFullRejection(app.kivro, buyer, cap.id, key)));
    }
    await recordQueueFullRejection(app.kivro, buyer, cap.id, 'different-key');
    const events = await db.auditEvent.findMany({ where: { type: 'CAPACITY_QUEUE_FULL', metadata: { path: ['capabilityId'], equals: cap.id } } });
    expect(events).toHaveLength(2); expect(JSON.stringify(events)).not.toContain(key);
    expect(await db.job.count({ where: { capabilityId: cap.id } })).toBe(0);
    expect(await db.ledgerEntry.count()).toBe(0);
    const row = await snapshot(cap.id, new Date());
    expect(row.queueFullRejects).toBe(2); expect(row.queueFullCoverageFrom).not.toBeNull();
  });

  it('does not retain an event or checkpoint when the telemetry transaction fails', async () => {
    const cap = await capability();
    await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".reject_capacity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.type = 'CAPACITY_QUEUE_FULL' THEN RAISE EXCEPTION 'synthetic telemetry failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER reject_capacity BEFORE INSERT ON "${schema}"."AuditEvent" FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_capacity()`);
    try { await expect(recordQueueFullRejection(app.kivro, buyer, cap.id, 'failure-purchase')).rejects.toThrow(); }
    finally { await db.$executeRawUnsafe(`DROP TRIGGER reject_capacity ON "${schema}"."AuditEvent"`); await db.$executeRawUnsafe(`DROP FUNCTION "${schema}".reject_capacity()`); }
    expect(await db.auditEvent.count({ where: { type: 'CAPACITY_QUEUE_FULL', metadata: { path: ['capabilityId'], equals: cap.id } } })).toBe(0);
  });

  it('derives medians from persisted times, excludes pauses and incomplete/ambiguous samples, and counts accepted jobs once', async () => {
    const cap = await capability();
    const worker = await db.workerDevice.create({ data: { sellerId: seller, name: 'Synthetic metrics', version: '0.1.0', publicKey: randomUUID() } });
    const job = (overrides: Partial<Prisma.JobUncheckedCreateInput> = {}) => db.job.create({ data: { buyerId: buyer, sellerId: seller, capabilityId: cap.id, capabilityVersionId: cap.versionId,
      input: {}, priceSnapshot: {}, buyerPriceMinor: 99, sellerNetMinor: 80, platformFeeMinor: 19, state: 'SUCCEEDED', paymentState: 'RELEASED',
      executionMode: 'NOW', waitDeadline: at(600), createdAt: at(-600), queuedAt: at(-300), startedAt: at(-270), completedAt: at(-170), ...overrides } });
    const paused = await job({ pausedDurationMs: 30000 });
    await db.jobEvent.create({ data: { jobId: paused.id, type: 'PAUSED', message: 'Paused', createdAt: at(-250) } });
    await job({ queuedAt: at(-330), completedAt: at(-160) });
    await job({ startedAt: null, completedAt: at(-160) });
    await job({ queuedAt: at(-260) });
    const prestart = await job({ pausedDurationMs: 20000 });
    await db.jobEvent.create({ data: { jobId: prestart.id, type: 'PAUSED', message: 'Prestart pause', createdAt: at(-290) } });
    await job({ pausedDurationMs: 200000 });
    const disconnected = await job({ state: 'FAILED', pausedAt: at(-220), completedAt: at(-170) });
    await db.jobEvent.create({ data: { jobId: disconnected.id, type: 'FAILED', message: 'Worker did not reconnect within the recovery period', metadata: { source: 'PLATFORM' }, createdAt: at(-170) } });
    for (let i = 0; i < 2; i++) await db.jobAttempt.create({ data: { jobId: paused.id, workerId: worker.id, nonce: randomUUID(), expiresAt: at(600), acceptedAt: at(-280 + i), finishedAt: at(-170), state: 'SUCCEEDED' } });
    await db.jobAttempt.create({ data: { jobId: disconnected.id, workerId: worker.id, nonce: randomUUID(), expiresAt: at(600), state: 'OFFERED' } });
    const row = await snapshot(cap.id);
    expect(row.queueWait).toEqual({ sampleCount: 3, medianSeconds: 30, excludedCount: 3 });
    expect(row.execution).toEqual({ sampleCount: 4, medianSeconds: 85, excludedCount: 3 });
    expect(row).toMatchObject({ jobsAccepted: 1, acceptedAttempts: 2, disconnectFailures: 1 });
  });

  it('keeps unknown metric samples null and does not equate a Worker-supplied failure with platform disconnect expiry', async () => {
    const cap = await capability();
    const row = await db.job.create({ data: { buyerId: buyer, sellerId: seller, capabilityId: cap.id, capabilityVersionId: cap.versionId, input: {}, priceSnapshot: {},
      buyerPriceMinor: 99, sellerNetMinor: 80, platformFeeMinor: 19, state: 'FAILED', paymentState: 'RELEASED', executionMode: 'NOW', waitDeadline: at(600), completedAt: at(-10) } });
    await db.jobEvent.create({ data: { jobId: row.id, type: 'FAILED', message: 'Worker did not reconnect within the recovery period', metadata: { source: 'WORKER' } } });
    expect(await snapshot(cap.id)).toMatchObject({ queueWait: { sampleCount: 0, medianSeconds: null }, execution: { sampleCount: 0, medianSeconds: null, excludedCount: 1 }, disconnectFailures: 0 });
  });

  it('scopes the additive operations DTO to its session seller and requires an admin session for platform results', async () => {
    const own = await capability(), foreign = await capability(other);
    await observe(own.id, 'ONLINE', at(-100)); await observe(own.id, 'BUSY', at(-70));
    await observe(foreign.id, 'ONLINE', at(-100)); await observe(foreign.id, 'BUSY', at(-70));
    const read = (path: string, token: string) => app.inject({ url: path, headers: { cookie: `kivro_session=${token}` } });
    const ownResponse = await read('/api/seller/operations', sellerToken);
    expect(ownResponse.statusCode, ownResponse.body).toBe(200);
    const dto = ownResponse.json<OperationsDTO>();
    expect(dto.capabilityAnalytics!.items.some(row => row.capabilityId === own.id)).toBe(true);
    expect(dto.capabilityAnalytics!.items.some(row => row.capabilityId === foreign.id)).toBe(false);
    expect(JSON.stringify(dto.capabilityAnalytics)).not.toContain('private-capacity-secret');
    expect((await read(`/api/seller/operations?sellerId=${other}`, sellerToken)).statusCode).toBe(400);
    expect((await read('/api/admin/operations', sellerToken)).statusCode).toBe(403);
    const platform = await read('/api/admin/operations', adminToken);
    expect(platform.statusCode, platform.body).toBe(200);
    expect(platform.json<OperationsDTO>().capabilityAnalytics!.items.some(row => row.capabilityId === foreign.id)).toBe(true);
    expect((await app.inject({ url: '/api/seller/operations' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/admin/operations', headers: { authorization: `Bearer ${apiKey}` } })).statusCode).toBe(403);
    const otherResponse = await read('/api/seller/operations', otherToken);
    expect(otherResponse.statusCode).toBe(200);
    expect(otherResponse.json<OperationsDTO>().capabilityAnalytics!.items.every(row => row.capabilityId === foreign.id)).toBe(true);
    const scope = await operationsSnapshot(app.kivro, other, 30);
    expect(scope.capabilityAnalytics!.items.map(row => row.capabilityId)).toEqual([foreign.id]);
  });

  it('fairly advances more than a page across restarts, isolates a bad capability, and bounds the returned groups', async () => {
    const caps = [];
    for (let i = 0; i < 205; i++) caps.push(await capability());
    await db.capability.update({ where: { id: caps[0]!.id }, data: { schedule: { invalid: true } } });
    const observed = new Set<string>();
    for (let i = 0; i < 4; i++) {
      try { await reconcileCapacityTelemetry(app.kivro); } catch (error) { expect((error as Error).message).toBe('CAPACITY_OBSERVATION_FAILED'); }
      if (i === 0) { await app.close(); app = await startApp(); }
      for (const row of await db.platformSetting.findMany({ where: { key: { startsWith: 'capacity-observation:' } } })) observed.add(row.key.slice('capacity-observation:'.length));
    }
    expect(caps.slice(1).every(cap => observed.has(cap.id))).toBe(true);
    expect(observed.has(caps[0]!.id)).toBe(false);
    const dto = await db.$transaction(tx => capacityAnalytics(tx, seller, at(-3600), new Date(), 90));
    expect(dto.items).toHaveLength(200); expect(dto.truncated).toBe(true); expect(dto.totalCapabilities).toBeGreaterThan(205);
  });
});
