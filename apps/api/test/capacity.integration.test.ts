import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@kivro/database';
import { creditWallet } from '@kivro/billing';
import { CreateCapabilitySchema, type Dependency, type IOContract, type PermissionManifest } from '@kivro/contracts';
import { ADAPTER_POLICY_VERSION } from '@kivro/openclaw-adapter';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';
import { canonicalWorkerRequest } from '../src/worker.js';

const capacitySchema = CreateCapabilitySchema.pick({ concurrency: true, maxQueue: true, maxScheduled: true });
describe('strict seller capacity settings', () => {
  it('keeps omitted settings optional and accepts only the bounded integer extremes', () => {
    expect(capacitySchema.parse({})).toEqual({});
    for (const value of [{ concurrency: 1, maxQueue: 0, maxScheduled: 0 }, { concurrency: 4, maxQueue: 10, maxScheduled: 20 }]) {
      expect(capacitySchema.parse(value)).toEqual(value);
    }
  });
  it.each([
    ...[0, 5, 1.5, '2', null, Infinity, NaN].map(concurrency => ({ concurrency })),
    ...[-1, 11, 0.5, '0', null, Infinity, NaN].map(maxQueue => ({ maxQueue })),
    ...[-1, 21, 0.5, '20', null, Infinity, NaN].map(maxScheduled => ({ maxScheduled })),
    { effectiveConcurrency: 100 },
  ])('rejects invalid capacity values %j without coercion', value => {
    expect(capacitySchema.safeParse(value).success).toBe(false);
  });
});

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('seller capacity API with real persistence and signed dispatch', () => {
  let app: FastifyInstance, db: PrismaClient;
  const sellerId = randomUUID(), buyerId = randomUUID(), strangerId = randomUUID();
  const sellerToken = randomUUID(), buyerToken = randomUUID(), strangerToken = randomUUID();
  const createdCapabilities: string[] = [];
  const workers = Array.from({ length: 2 }, () => ({ id: randomUUID(), keys: generateKeyPairSync('ed25519'), versions: new Set<string>() }));
  const ioContract: IOContract = { schemaVersion: 1, inputs: [{ key: 'text', label: 'Text', type: 'LONG_TEXT', required: true, order: 0 }],
    output: { type: 'TEXT', description: 'Synthetic scalar result', required: true } };
  const permissions: PermissionManifest = { schemaVersion: 1, tools: ['read'], network: { mode: 'NONE', allowedDomains: [] }, resources: [],
    inference: { provider: 'openai-compatible', model: 'capacity-fixture', credentialRef: 'synthetic-local-ref' },
    limits: { timeoutSeconds: 300, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 1048576, maxOutputBytes: 1048576, maxTokens: 1000 } };
  const dependencies: Dependency[] = [{ id: 'inference', name: 'Synthetic inference', type: 'INFERENCE', required: true, approved: true, healthy: true, supported: true,
    confidence: 'DECLARED', grants: { tools: ['read'], inferenceProviders: ['openai-compatible'], credentialRefs: ['synthetic-local-ref'] } }];
  const definition = () => ({ title: `Capacity fixture ${randomUUID().slice(0, 8)}`, summary: 'Synthetic capacity configuration fixture', description: 'No external inference or Docker execution.',
    category: 'Writing & documents', tags: ['capacity-fixture'], priceTierId: 'USD_99', ioContract, permissions, dependencies,
    internalInstructions: 'Return a synthetic scalar result.', estimatedDurationSeconds: 60, workerId: workers[0]!.id, examples: [] });
  const headers = (token = sellerToken) => ({ cookie: `kivro_session=${token}`, origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000' });
  const request = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>, token = sellerToken) =>
    app.inject({ method, url, headers: headers(token), ...(payload === undefined ? {} : { payload }) });
  const worker = (index: number, method: 'GET' | 'POST', url: string, body?: unknown) => {
    const device = workers[index]!, raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const nonce = randomUUID(), timestamp = String(Date.now());
    return app.inject({ method, url, headers: { 'x-worker-id': device.id, 'x-worker-timestamp': timestamp, 'x-worker-nonce': nonce,
      'x-worker-signature': sign(null, Buffer.from(canonicalWorkerRequest(method, new URL(url, 'http://localhost').pathname, timestamp, nonce, raw)), device.keys.privateKey).toString('base64'),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { payload: raw }) });
  };
  type SellerView = { id: string; versionId: string; lifecycleRevision: number; concurrency: number; maxQueue: number; maxScheduled: number;
    currentVersionId: string | null; draftVersionId: string | null };
  const create = async (capacity: Record<string, unknown> = {}) => {
    const result = await request('POST', '/api/seller/capabilities', { ...definition(), ...capacity });
    expect(result.statusCode, result.body).toBe(200); const cap = result.json<SellerView>(); createdCapabilities.push(cap.id); return cap;
  };
  const ready = async (capacity: Record<string, unknown> = {}) => {
    const cap = await create(capacity);
    const version = await db.capabilityVersion.findUniqueOrThrow({ where: { id: cap.versionId } });
    for (const [index, device] of workers.entries()) {
      device.versions.add(cap.versionId);
      const heartbeat = await worker(index, 'POST', '/api/worker/heartbeat', { version: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)', sandboxReady: true, paused: false,
        capabilities: [...device.versions], runningJobIds: [], health: { ready: true } });
      expect(heartbeat.statusCode, heartbeat.body).toBe(200);
      const validation = await worker(index, 'POST', `/api/worker/capabilities/${cap.versionId}/validation`, { manifestHash: version.manifestHash, passed: true,
        proof: { sandbox: { imageId: `sha256:${'a'.repeat(64)}`, policyVersion: ADAPTER_POLICY_VERSION, testedAt: Date.now() }, inference: { configHash: 'b'.repeat(64), testedAt: Date.now() } } });
      expect(validation.statusCode, validation.body).toBe(200);
    }
    const published = await request('POST', `/api/seller/capabilities/${cap.id}/publish`, { visibility: 'PUBLIC', expectedRevision: cap.lifecycleRevision, versionId: cap.versionId, localExecutionAcknowledged: true });
    expect(published.statusCode, published.body).toBe(200); return published.json<SellerView>();
  };
  const update = (cap: SellerView, values: Record<string, unknown>) => request('PUT', `/api/seller/capabilities/${cap.id}`, { expectedRevision: cap.lifecycleRevision, ...values });
  const audits = (id: string) => db.auditEvent.findMany({ where: { actorId: sellerId, type: 'CAPACITY_UPDATED', metadata: { path: ['capabilityId'], equals: id } }, orderBy: { id: 'asc' } });
  const purchase = (id: string, executionMode: 'NOW' | 'SCHEDULED' = 'NOW', extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/api/jobs',
    headers: { ...headers(buyerToken), 'idempotency-key': randomUUID() }, payload: { capabilityId: id, input: { text: 'Synthetic capacity input' }, executionMode,
      ...(executionMode === 'SCHEDULED' ? { scheduledAt: new Date(Date.now() + 3600_000).toISOString() } : {}), ...extra } });
  const start = async (index: number) => {
    const offers = await worker(index, 'GET', '/api/worker/offers'); expect(offers.statusCode, offers.body).toBe(200); expect(offers.json().offers).toHaveLength(1);
    const notice = offers.json().offers[0].payload as { jobId: string; attemptId: string; paymentSecured: boolean };
    expect(notice.paymentSecured).toBe(true);
    for (const type of ['ACCEPTED', 'RUNNING']) {
      const result = await worker(index, 'POST', `/api/worker/jobs/${notice.jobId}/events`, { attemptId: notice.attemptId, type }); expect(result.statusCode, result.body).toBe(200);
    }
    return notice.jobId;
  };
  beforeAll(async () => {
    process.loadEnvFile('.env');
    if (process.env.KIVRO_ENV !== 'development' || !process.env.DATABASE_URL?.includes(':55432/kivro')) throw new Error('Requires local development services');
    db = new PrismaClient();
    for (const [id, token] of [[sellerId, sellerToken], [buyerId, buyerToken], [strangerId, strangerToken]] as const) {
      await db.user.create({ data: { id, email: `${id}@capacity.kivro.local`, name: 'Synthetic capacity account', passwordHash: 'disabled-test-identity', wallet: { create: {} },
        sessions: { create: { tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + 3600_000) } } } });
    }
    await db.$transaction(tx => creditWallet(tx, buyerId, 10000, `capacity-fixture:${buyerId}:credit`));
    for (const device of workers) await db.workerDevice.create({ data: { id: device.id, sellerId, publicKey: device.keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      name: 'Signed capacity test Worker', version: '0.1.0', runningJobIds: [] } });
    app = await createApp({ env: { ...process.env, PAYMENT_MODE: 'fake', ACCOUNT_REQUESTS_PER_MINUTE: '10000', ACCOUNT_WRITES_PER_MINUTE: '1000' }, db, logger: false });
    const terms = await app.inject('/api/terms'); expect(terms.statusCode).toBe(200);
    for (const token of [sellerToken, buyerToken]) expect((await request('POST', '/api/account/terms', { version: terms.json().version }, token)).statusCode).toBe(200);
  });
  afterEach(async () => {
    if (!app || !db) return;
    const pending = await db.job.findMany({ where: { capabilityId: { in: createdCapabilities }, paymentState: 'RESERVED' } });
    for (const job of pending) {
      const cancelled = await request('POST', `/api/jobs/${job.id}/cancel`, {});
      expect(cancelled.statusCode, cancelled.body).toBe(200);
    }
    await db.capability.updateMany({ where: { id: { in: createdCapabilities } }, data: { visibility: 'PRIVATE', paused: true } });
  });
  afterAll(async () => {
    if (db) {
      await db.apiKey.updateMany({ where: { userId: sellerId }, data: { revokedAt: new Date() } });
      await db.workerDevice.updateMany({ where: { id: { in: workers.map(device => device.id) } }, data: { revokedAt: new Date() } });
      await db.user.updateMany({ where: { id: { in: [sellerId, buyerId, strangerId] } }, data: { suspendedAt: new Date() } });
      expect(await db.job.count({ where: { capabilityId: { in: createdCapabilities }, paymentState: 'RESERVED' } })).toBe(0);
    }
    await app?.close(); await db?.$disconnect();
  });
  it('persists defaults and explicit bounds and returns all capacity settings only to the seller', async () => {
    const defaults = await create(); expect(defaults).toMatchObject({ concurrency: 1, maxQueue: 3, maxScheduled: 20 });
    const configured = await ready({ concurrency: 4, maxQueue: 10, maxScheduled: 0 });
    expect(configured).toMatchObject({ concurrency: 4, maxQueue: 10, maxScheduled: 0 });
    expect(await db.capability.findUniqueOrThrow({ where: { id: configured.id } })).toMatchObject({ concurrency: 4, maxQueue: 10, maxScheduled: 0 });
    const listed = await request('GET', '/api/seller/capabilities');
    expect(listed.statusCode).toBe(200); expect(listed.json().find((cap: SellerView) => cap.id === configured.id)).toMatchObject({ concurrency: 4, maxQueue: 10, maxScheduled: 0 });
    const publicView = await app.inject(`/api/capabilities/${configured.id}`); expect(publicView.statusCode).toBe(200);
    for (const key of ['concurrency', 'maxQueue', 'maxScheduled']) expect(publicView.json()).not.toHaveProperty(key);
    expect((await request('GET', '/api/seller/capabilities', undefined, strangerToken)).json()).toEqual([]);
  });
  it('rejects invalid create/update settings atomically without making a draft or audit', async () => {
    const cap = await create(), before = await db.capability.findUniqueOrThrow({ where: { id: cap.id } });
    const count = await db.capability.count({ where: { sellerId } });
    for (const invalid of [{ concurrency: 0 }, { concurrency: 5 }, { maxQueue: -1 }, { maxQueue: 11 }, { maxScheduled: 21 }, { maxScheduled: '1' }, { maxQueue: null }, { concurrency: 1.5 }]) {
      expect((await request('POST', '/api/seller/capabilities', { ...definition(), ...invalid })).statusCode).toBe(400);
      expect((await update(cap, invalid)).statusCode).toBe(400);
    }
    expect(await db.capability.count({ where: { sellerId } })).toBe(count);
    expect(await db.capability.findUniqueOrThrow({ where: { id: cap.id } })).toEqual(before);
    expect(await db.capabilityVersion.count({ where: { capabilityId: cap.id } })).toBe(1); expect(await audits(cap.id)).toEqual([]);
  });
  it('requires an owner session and explicit revision and rejects buyer/API-key concurrency overrides', async () => {
    const cap = await ready();
    expect((await app.inject({ method: 'PUT', url: `/api/seller/capabilities/${cap.id}`, payload: { expectedRevision: cap.lifecycleRevision, concurrency: 4 } })).statusCode).toBe(401);
    expect((await request('PUT', `/api/seller/capabilities/${cap.id}`, { expectedRevision: cap.lifecycleRevision, concurrency: 4 }, buyerToken)).statusCode).toBe(404);
    const noRevision = await request('PUT', `/api/seller/capabilities/${cap.id}`, { maxQueue: 0 });
    expect(noRevision.statusCode).toBe(400); expect(noRevision.json().error.code).toBe('CAPACITY_REVISION_REQUIRED');
    const key = await request('POST', '/api/api-keys', { name: 'Not seller authority', scopes: ['capabilities:read', 'jobs:create'] }); expect(key.statusCode).toBe(200);
    const deniedKey = await app.inject({ method: 'PUT', url: `/api/seller/capabilities/${cap.id}`, headers: { authorization: `Bearer ${key.json().secret}` }, payload: { expectedRevision: cap.lifecycleRevision, concurrency: 4 } });
    expect(deniedKey.statusCode).toBe(403);
    expect((await purchase(cap.id, 'NOW', { concurrency: 4, maxQueue: 10, maxScheduled: 20 })).statusCode).toBe(400);
    expect(await db.capability.findUniqueOrThrow({ where: { id: cap.id } })).toMatchObject({ concurrency: 1, maxQueue: 3, maxScheduled: 20, lifecycleRevision: cap.lifecycleRevision });
    expect(await db.job.count({ where: { capabilityId: cap.id } })).toBe(0); expect(await audits(cap.id)).toEqual([]);
  });
  it('changes capacity without cloning a published definition, invalidating validation or silently creating a draft', async () => {
    const cap = await ready(), version = await db.capabilityVersion.findUniqueOrThrow({ where: { id: cap.versionId } });
    const bindings = await db.workerBinding.findMany({ where: { capabilityVersionId: cap.versionId }, orderBy: { workerId: 'asc' } });
    const changed = await update(cap, { concurrency: 2, maxQueue: 0, maxScheduled: 5 });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ versionId: cap.versionId, currentVersionId: cap.versionId, draftVersionId: null,
      lifecycleRevision: cap.lifecycleRevision + 1, concurrency: 2, maxQueue: 0, maxScheduled: 5 });
    expect(await db.capabilityVersion.count({ where: { capabilityId: cap.id } })).toBe(1);
    expect(await db.capabilityVersion.findUniqueOrThrow({ where: { id: cap.versionId } })).toEqual(version);
    expect(await db.workerBinding.findMany({ where: { capabilityVersionId: cap.versionId }, orderBy: { workerId: 'asc' } })).toEqual(bindings);
    expect((await audits(cap.id)).map(row => row.metadata)).toEqual([{ capabilityId: cap.id, previous: { concurrency: 1, maxQueue: 3, maxScheduled: 20 },
      next: { concurrency: 2, maxQueue: 0, maxScheduled: 5 }, previousRevision: cap.lifecycleRevision, lifecycleRevision: cap.lifecycleRevision + 1 }]);
    const noOp = await update(changed.json<SellerView>(), { concurrency: 2, maxQueue: 0, maxScheduled: 5 });
    expect(noOp.statusCode).toBe(200); expect(noOp.json().lifecycleRevision).toBe(cap.lifecycleRevision + 1); expect(await audits(cap.id)).toHaveLength(1);
    const stale = await update(cap, { maxQueue: 0 }); expect(stale.statusCode).toBe(409); expect(stale.json().error.code).toBe('CAPABILITY_CONFLICT');
    expect(await db.capabilityVersion.count({ where: { capabilityId: cap.id } })).toBe(1);
  });
  it('preserves an existing draft and commits mixed capacity/definition edits under one lifecycle revision', async () => {
    const cap = await ready();
    const edited = await update(cap, { summary: 'Changed draft with atomic capacity settings', maxQueue: 5 }); expect(edited.statusCode, edited.body).toBe(200);
    const draft = edited.json<SellerView>(); expect(draft.versionId).not.toBe(cap.versionId);
    expect(draft).toMatchObject({ currentVersionId: cap.versionId, lifecycleRevision: cap.lifecycleRevision + 1, maxQueue: 5, concurrency: 1, maxScheduled: 20 });
    const changed = await update(draft, { maxScheduled: 2 }); expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ versionId: draft.versionId, draftVersionId: draft.versionId, currentVersionId: cap.versionId, lifecycleRevision: draft.lifecycleRevision + 1, maxScheduled: 2, maxQueue: 5 });
    expect(await db.capabilityVersion.count({ where: { capabilityId: cap.id } })).toBe(2);
    const failed = await update(changed.json<SellerView>(), { workerId: randomUUID(), summary: 'This entire mixed update must roll back', concurrency: 4 });
    expect(failed.statusCode).toBe(404);
    expect(await db.capability.findUniqueOrThrow({ where: { id: cap.id } })).toMatchObject({ lifecycleRevision: draft.lifecycleRevision + 1, concurrency: 1, maxQueue: 5, maxScheduled: 2 });
    expect(await db.capabilityVersion.count({ where: { capabilityId: cap.id } })).toBe(2); expect(await audits(cap.id)).toHaveLength(2);
  });
  it('serializes simultaneous capacity saves and conflicts with a concurrent immutable draft edit', async () => {
    const cap = await create();
    const saves = await Promise.all([update(cap, { maxQueue: 0 }), update(cap, { concurrency: 4 })]);
    expect(saves.map(result => result.statusCode).sort()).toEqual([200, 409]); expect(await audits(cap.id)).toHaveLength(1);
    const current = saves.find(result => result.statusCode === 200)!.json<SellerView>();
    const mixed = await Promise.all([update(current, { maxScheduled: 0 }), update(current, { summary: 'Concurrent version definition change' })]);
    expect(mixed.map(result => result.statusCode).sort()).toEqual([200, 409]);
    const result = mixed.find(response => response.statusCode === 200)!.json<SellerView>();
    expect(result.lifecycleRevision).toBe(cap.lifecycleRevision + 2);
    expect(await db.capabilityVersion.count({ where: { capabilityId: cap.id } })).toBe(result.versionId === cap.versionId ? 1 : 2);
    expect((await db.capability.findUniqueOrThrow({ where: { id: cap.id } })).maxScheduled).toBe(mixed[0]!.statusCode === 200 ? 0 : 20);
  });
  it('enforces configured concurrent/queue admission and admits more work only after an owner capacity increase', async () => {
    const cap = await ready({ concurrency: 2, maxQueue: 0 });
    const purchases = await Promise.all([purchase(cap.id), purchase(cap.id), purchase(cap.id)]);
    expect(purchases.map(result => result.statusCode).sort()).toEqual([201, 201, 409]);
    expect(purchases.find(result => result.statusCode === 409)!.json().error.code).toBe('CAPABILITY_QUEUE_FULL');
    const first = await start(0), second = await start(1); expect(first).not.toBe(second);
    expect(await db.job.count({ where: { capabilityId: cap.id, state: 'RUNNING' } })).toBe(2);
    const changed = await update(cap, { maxQueue: 1 }); expect(changed.statusCode, changed.body).toBe(200);
    const queued = await purchase(cap.id); expect(queued.statusCode, queued.body).toBe(201); expect(queued.json().state).toBe('QUEUED');
    const denied = await purchase(cap.id); expect(denied.statusCode, denied.body).toBe(409);
    expect(await db.job.count({ where: { capabilityId: cap.id } })).toBe(3);
    expect(await db.ledgerEntry.count({ where: { jobId: { in: [first, second, queued.json().id] }, type: 'JOB_RESERVE' } })).toBe(3);
    for (const index of [0, 1]) expect((await worker(index, 'GET', '/api/worker/offers')).json().offers).toEqual([]);
  });
  it('lets active, queued and scheduled paid jobs drain unchanged when the seller lowers every capacity limit', async () => {
    const cap = await ready({ concurrency: 2, maxQueue: 2, maxScheduled: 2 });
    for (let count = 0; count < 2; count++) expect((await purchase(cap.id)).statusCode).toBe(201);
    await start(0); await start(1);
    expect((await purchase(cap.id)).statusCode).toBe(201);
    for (let count = 0; count < 2; count++) expect((await purchase(cap.id, 'SCHEDULED')).statusCode).toBe(201);
    const jobs = await db.job.findMany({ where: { capabilityId: cap.id }, orderBy: { id: 'asc' } }), ids = jobs.map(job => job.id);
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } }); expect(wallet.reservedMinor).toBe(495);
    const ledger = await db.ledgerEntry.findMany({ where: { jobId: { in: ids } }, orderBy: { id: 'asc' } });
    const attempts = await db.jobAttempt.findMany({ where: { jobId: { in: ids } }, orderBy: { id: 'asc' } });
    const commands = await db.workerCommand.count({ where: { jobId: { in: ids } } });
    const lowered = await update(cap, { concurrency: 1, maxQueue: 0, maxScheduled: 0 }); expect(lowered.statusCode, lowered.body).toBe(200);
    expect(await db.job.findMany({ where: { capabilityId: cap.id }, orderBy: { id: 'asc' } })).toEqual(jobs);
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } })).toEqual(wallet);
    expect(await db.ledgerEntry.findMany({ where: { jobId: { in: ids } }, orderBy: { id: 'asc' } })).toEqual(ledger);
    expect(await db.jobAttempt.findMany({ where: { jobId: { in: ids } }, orderBy: { id: 'asc' } })).toEqual(attempts);
    expect(await db.workerCommand.count({ where: { jobId: { in: ids } } })).toBe(commands);
    for (const [mode, code] of [['NOW', 'CAPABILITY_QUEUE_FULL'], ['SCHEDULED', 'SCHEDULE_FULL']] as const) {
      const denied = await purchase(cap.id, mode); expect(denied.statusCode, denied.body).toBe(409); expect(denied.json().error.code).toBe(code);
    }
    expect(await db.job.count({ where: { capabilityId: cap.id } })).toBe(5);
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } })).toEqual(wallet);
  });
  it('enforces zero and finite scheduled reservation settings without changing the execution definition', async () => {
    const cap = await ready({ maxScheduled: 0 });
    const blocked = await purchase(cap.id, 'SCHEDULED'); expect(blocked.statusCode).toBe(409); expect(blocked.json().error.code).toBe('SCHEDULE_FULL');
    const changed = await update(cap, { maxScheduled: 1 }); expect(changed.statusCode).toBe(200);
    const reserved = await purchase(cap.id, 'SCHEDULED'); expect(reserved.statusCode, reserved.body).toBe(201); expect(reserved.json().state).toBe('SCHEDULED');
    expect((await purchase(cap.id, 'SCHEDULED')).statusCode).toBe(409);
    expect(await db.job.count({ where: { capabilityId: cap.id } })).toBe(1);
    expect(await db.capabilityVersion.count({ where: { capabilityId: cap.id } })).toBe(1);
    expect((await worker(0, 'GET', '/api/worker/offers')).json().offers).toEqual([]);
  });
});
