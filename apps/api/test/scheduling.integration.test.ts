import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient, json, serializable } from '@kivro/database';
import { DEFAULT_SCHEDULE, executionManifestHash, getPriceTier, JobDTOSchema, type Schedule } from '@kivro/contracts';
import { creditWallet, reserveJob } from '@kivro/billing';
import { ADAPTER_POLICY_VERSION } from '@kivro/openclaw-adapter';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';
import { canonicalWorkerRequest } from '../src/worker.js';
import { maintenance, reconcileJobs } from '../src/background.js';
import * as telemetry from '../src/capacity-telemetry.js';
import * as examples from '../src/example-assets.js';
import { quoteAgentCapability } from '../src/agent.js';
import { availability, loadCapability } from '../src/catalog.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('scheduled admission and FIFO (isolated PostgreSQL)', () => {
  let db: PrismaClient, app: FastifyInstance;
  const schema = `scheduling_${randomBytes(8).toString('hex')}`, origin = 'http://localhost:3000';
  beforeAll(async () => {
    process.loadEnvFile('.env'); const url = new URL(process.env.DATABASE_URL!);
    if (process.env.KIVRO_ENV !== 'development' || url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/kivro') throw new Error('Requires local development DB');
    url.searchParams.set('schema', schema);
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url.toString() } });
    db = new PrismaClient({ datasourceUrl: url.toString() });
    app = await createApp({ db, logger: false, mailer: null, background: false, env: { ...process.env, NODE_ENV: 'test', PAYMENT_MODE: 'fake', WEB_ORIGIN: origin,
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', PLATFORM_OPENAI_API_KEY: '', PLATFORM_ANTHROPIC_API_KEY: '', PLATFORM_INFERENCE_PROVIDER: '' } });
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      if (!/^scheduling_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe test schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await db.$disconnect();
    }
  });
  async function fixture(options: { concurrency?: number; maxQueue?: number; schedule?: Schedule; funding?: number } = {}) {
    const sellerId = randomUUID(), buyerId = randomUUID(), token = randomUUID(), keys = generateKeyPairSync('ed25519');
    for (const id of [sellerId, buyerId]) await db.user.create({ data: { id, email: `${id}@scheduling.kivro.local`, name: 'Scheduling fixture', passwordHash: 'disabled', wallet: { create: {} },
      ...(id === buyerId ? { sessions: { create: { tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + 600000) } } } : {}) } });
    if (options.funding !== 0) await serializable(db, tx => creditWallet(tx, buyerId, options.funding ?? 10000, `scheduling-funding:${buyerId}`));
    const worker = await db.workerDevice.create({ data: { sellerId, name: 'Scheduling fixture', version: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)', sandboxReady: true, lastSeenAt: new Date(),
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } });
    const cap = await db.capability.create({ data: { sellerId, slug: randomUUID(), visibility: 'PUBLIC', schedule: options.schedule ?? DEFAULT_SCHEDULE,
      concurrency: options.concurrency ?? 1, maxQueue: options.maxQueue ?? 1, maxScheduled: 20 } });
    const manifest = { ioContract: { schemaVersion: 1, inputs: [], output: { type: 'TEXT', description: 'Result', required: true } },
      permissions: { schemaVersion: 1, tools: [], network: { mode: 'NONE', allowedDomains: [] }, resources: [], inference: { provider: 'openai-compatible', model: 'test' },
        limits: { timeoutSeconds: 300, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 1024, maxOutputBytes: 1024, maxTokens: 1000 } },
      dependencies: [{ id: 'inference', name: 'Dedicated inference', type: 'INFERENCE', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { inferenceProviders: ['openai-compatible'] } }], internalInstructions: 'Synthetic scheduling fixture' };
    const newVersion = async (number: number) => db.capabilityVersion.create({ data: { capabilityId: cap.id, version: number, title: `Scheduling fixture ${number}`, summary: 'Synthetic scheduling case', description: '', category: 'Writing & documents', tags: [], priceTierId: 'USD_99', estimatedDurationSeconds: 60,
      ...manifest, ioContract: json(manifest.ioContract), permissions: json(manifest.permissions), dependencies: json(manifest.dependencies), manifestHash: executionManifestHash(manifest), publishedAt: new Date() } });
    const version = await newVersion(1);
    await db.capability.update({ where: { id: cap.id }, data: { currentVersionId: version.id } });
    const bind = async (versionId: string, workerId = worker.id) => db.workerBinding.create({ data: { workerId, capabilityVersionId: versionId, healthy: true, validationStatus: 'PASSED', validatedManifestHash: version.manifestHash, validatedAt: new Date(),
      validationProof: { sandbox: { imageId: `sha256:${'a'.repeat(64)}`, policyVersion: ADAPTER_POLICY_VERSION, testedAt: Date.now() }, inference: { configHash: 'b'.repeat(64), testedAt: Date.now() } } } });
    await bind(version.id);
    const headers = { origin, cookie: `kivro_session=${token}` };
    const terms = (await app.inject('/api/terms')).json();
    expect((await app.inject({ method: 'POST', url: '/api/account/terms', headers, payload: { version: terms.version } })).statusCode).toBe(200);
    const signed = (method: 'GET' | 'POST', url: string, body?: unknown, device = { workerId: worker.id, privateKey: keys.privateKey }) => {
      const timestamp = String(Date.now()), nonce = randomUUID(), raw = body === undefined ? '' : JSON.stringify(body);
      return app.inject({ method, url, ...(body === undefined ? {} : { payload: raw }), headers: { 'content-type': 'application/json', 'x-worker-id': device.workerId, 'x-worker-timestamp': timestamp,
        'x-worker-nonce': nonce, 'x-worker-signature': sign(null, Buffer.from(canonicalWorkerRequest(method, url.split('?')[0]!, timestamp, nonce, Buffer.from(raw))), device.privateKey).toString('base64') } });
    };
    const purchase = (mode: 'NOW' | 'SCHEDULED' = 'NOW', scheduledAt?: Date, key = randomUUID(), quoteId?: string) => app.inject({ method: 'POST', url: '/api/jobs',
      headers: { ...headers, 'idempotency-key': key }, payload: { capabilityId: cap.id, input: {}, executionMode: mode,
        ...(scheduledAt ? { scheduledAt: scheduledAt.toISOString() } : {}), ...(quoteId ? { quoteId } : {}) } });
    const makeJob = async (data: { state?: 'SCHEDULED' | 'QUEUED'; createdAt?: Date; scheduledAt?: Date; id?: string; capabilityVersionId?: string; capabilityId?: string; input?: Record<string, string> } = {}) => serializable(db, async tx => {
      const job = await tx.job.create({ data: { buyerId, sellerId, capabilityId: cap.id, capabilityVersionId: version.id, state: 'SCHEDULED', input: {}, priceSnapshot: getPriceTier('USD_99'),
        buyerPriceMinor: 99, platformFeeMinor: 19, sellerNetMinor: 80, executionMode: 'SCHEDULED', waitDeadline: new Date(Date.now() + 600000),
        scheduledAt: new Date(Date.now() - 1000), ...data } });
      await reserveJob(tx, job); return job;
    });
    return { worker, cap, version, buyerId, sellerId, headers, signed, purchase, makeJob, bind, newVersion };
  }
  async function notice(f: Awaited<ReturnType<typeof fixture>>) {
    const response = await f.signed('GET', '/api/worker/offers'); expect(response.statusCode, response.body).toBe(200);
    return response.json().offers[0]?.payload as { jobId: string; attemptId: string; capabilityVersionId: string } | undefined;
  }
  async function anotherCapability(f: Awaited<ReturnType<typeof fixture>>, options: { concurrency?: number; maxQueue?: number } = {}) {
    const cap = await db.capability.create({ data: { sellerId: f.sellerId, slug: randomUUID(), visibility: 'PUBLIC', schedule: DEFAULT_SCHEDULE,
      concurrency: options.concurrency ?? 1, maxQueue: options.maxQueue ?? 0, maxScheduled: 20 } });
    const version = await db.capabilityVersion.create({ data: { capabilityId: cap.id, version: 1, title: 'Shared-device candidate', summary: 'Shared execution capacity', description: '',
      category: f.version.category, tags: [], priceTierId: 'USD_99', estimatedDurationSeconds: 60, publishedAt: new Date(),
      ioContract: json(f.version.ioContract), permissions: json(f.version.permissions), dependencies: json(f.version.dependencies),
      internalInstructions: f.version.internalInstructions, manifestHash: f.version.manifestHash } });
    await db.capability.update({ where: { id: cap.id }, data: { currentVersionId: version.id } });
    await f.bind(version.id);
    const purchase = () => app.inject({ method: 'POST', url: '/api/jobs', headers: { ...f.headers, 'idempotency-key': randomUUID() },
      payload: { capabilityId: cap.id, input: {}, executionMode: 'NOW' } });
    const state = async () => availability(app.kivro, await loadCapability(db, cap.id), db);
    return { cap, version, purchase, state };
  }
  async function start(f: Awaited<ReturnType<typeof fixture>>) {
    const purchase = await f.purchase(); expect(purchase.statusCode, purchase.body).toBe(201);
    const offer = await notice(f); expect(offer?.jobId).toBe(purchase.json().id);
    for (const type of ['ACCEPTED', 'RUNNING']) {
      const response = await f.signed('POST', `/api/worker/jobs/${offer!.jobId}/events`, { attemptId: offer!.attemptId, type });
      expect(response.statusCode, response.body).toBe(200);
    }
    return offer!;
  }
  async function finish(f: Awaited<ReturnType<typeof fixture>>, offer: { jobId: string; attemptId: string }) {
    const response = await f.signed('POST', `/api/worker/jobs/${offer.jobId}/events`, { attemptId: offer.attemptId, type: 'FAILED' });
    expect(response.statusCode, response.body).toBe(200);
  }
  async function secondDevice(f: Awaited<ReturnType<typeof fixture>>, versionId: string) {
    const keys = generateKeyPairSync('ed25519');
    const worker = await db.workerDevice.create({ data: { sellerId: f.sellerId, name: 'Second shared device', version: '0.1.0',
      openclawVersion: f.worker.openclawVersion, sandboxReady: true, lastSeenAt: new Date(), publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } });
    await f.bind(versionId, worker.id); return { workerId: worker.id, privateKey: keys.privateKey };
  }
  describe('owner-safe current job waiting projection', () => {
    async function read(f: Awaited<ReturnType<typeof fixture>>, id: string) {
      const response = await app.inject({ url: `/api/jobs/${id}`, headers: f.headers });
      expect(response.statusCode, response.body).toBe(200);
      return JobDTOSchema.strict().parse(response.json());
    }
    async function offline(f: Awaited<ReturnType<typeof fixture>>) {
      await db.workerDevice.update({ where: { id: f.worker.id }, data: { lastSeenAt: new Date(Date.now() - 2 * app.kivro.config.heartbeatTtlMs) } });
    }
    it('shows an offline reason only after scheduled eligibility and retains the bounded reservation', async () => {
      const f = await fixture(), bought = await f.purchase('SCHEDULED', new Date(Date.now() + 60000));
      expect(bought.statusCode, bought.body).toBe(201); const id = bought.json().id;
      const deadline = (await db.job.findUniqueOrThrow({ where: { id } })).waitDeadline.toISOString();
      await offline(f);
      expect(await read(f, id)).toMatchObject({ state: 'SCHEDULED', paymentState: 'RESERVED', waitDeadline: deadline, waitReason: 'WAITING_FOR_SCHEDULE' });
      await db.job.update({ where: { id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
      await reconcileJobs(app.kivro);
      expect(await read(f, id)).toMatchObject({ state: 'SCHEDULED', paymentState: 'RESERVED', waitDeadline: deadline, waitReason: 'ELIGIBLE_BUT_WORKER_OFFLINE' });
      const list = await app.inject({ url: '/api/jobs', headers: f.headers });
      expect(list.statusCode, list.body).toBe(200); expect(list.json()[0]).toMatchObject({ id, waitDeadline: deadline, waitReason: 'ELIGIBLE_BUT_WORKER_OFFLINE' });
      expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } })).toMatchObject({ reservedMinor: 99, spentMinor: 0 });
      expect(await db.ledgerEntry.count({ where: { jobId: id, type: { in: ['JOB_RELEASE', 'JOB_CAPTURE', 'SELLER_EARNING'] } } })).toBe(0);
      expect(await db.jobAttempt.count({ where: { jobId: id } })).toBe(0);
    });
    it('refreshes waiting reasons on reconnect, offer, acceptance and start without changing the deadline', async () => {
      const f = await fixture(), job = await f.makeJob(); await offline(f);
      expect((await read(f, job.id)).waitReason).toBe('ELIGIBLE_BUT_WORKER_OFFLINE');
      await db.workerDevice.update({ where: { id: f.worker.id }, data: { lastSeenAt: new Date() } });
      expect(await read(f, job.id)).toMatchObject({ state: 'SCHEDULED', waitReason: 'WAITING_FOR_WORKER_ACCEPTANCE' });
      await reconcileJobs(app.kivro);
      expect(await read(f, job.id)).toMatchObject({ state: 'QUEUED', waitReason: 'WAITING_FOR_WORKER_ACCEPTANCE' });
      const offer = (await notice(f))!; expect(offer.jobId).toBe(job.id);
      expect(await read(f, job.id)).toMatchObject({ state: 'OFFERED', waitReason: 'WAITING_FOR_WORKER_ACCEPTANCE' });
      expect((await f.signed('POST', `/api/worker/jobs/${job.id}/events`, { attemptId: offer.attemptId, type: 'ACCEPTED' })).statusCode).toBe(200);
      expect(await read(f, job.id)).toMatchObject({ state: 'ACCEPTED', waitReason: 'WAITING_FOR_WORKER_START' });
      expect((await f.signed('POST', `/api/worker/jobs/${job.id}/events`, { attemptId: offer.attemptId, type: 'RUNNING' })).statusCode).toBe(200);
      expect(await read(f, job.id)).toMatchObject({ state: 'RUNNING', waitReason: null, waitDeadline: job.waitDeadline.toISOString() });
      expect(await db.ledgerEntry.count({ where: { jobId: job.id, type: 'JOB_RESERVE' } })).toBe(1);
      expect(await db.ledgerEntry.count({ where: { jobId: job.id, type: { in: ['JOB_RELEASE', 'JOB_CAPTURE', 'SELLER_EARNING'] } } })).toBe(0);
    });
    it('reports deadline expiry before recovery then releases exactly once without offline earnings', async () => {
      const f = await fixture(), job = await f.makeJob(); await offline(f);
      const deadline = new Date(Date.now() - 1);
      await db.job.update({ where: { id: job.id }, data: { waitDeadline: deadline } });
      expect(await read(f, job.id)).toMatchObject({ state: 'SCHEDULED', paymentState: 'RESERVED', waitReason: 'WAIT_LIMIT_REACHED', waitDeadline: deadline.toISOString() });
      await reconcileJobs(app.kivro); await reconcileJobs(app.kivro);
      expect(await read(f, job.id)).toMatchObject({ state: 'TIMED_OUT', paymentState: 'RELEASED', waitReason: null, waitDeadline: deadline.toISOString() });
      expect(await db.ledgerEntry.count({ where: { jobId: job.id, type: 'JOB_RELEASE' } })).toBe(1);
      expect(await db.ledgerEntry.count({ where: { jobId: job.id, type: { in: ['JOB_CAPTURE', 'SELLER_EARNING', 'PLATFORM_FEE'] } } })).toBe(0);
      expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } })).toMatchObject({ availableMinor: 10000, reservedMinor: 0, spentMinor: 0 });
      expect(await db.outboxEvent.count({ where: { userId: f.buyerId, type: 'job.expired' } })).toBe(1);
    });
    it('keeps closed-window, provider pause and security reasons distinct from connectivity', async () => {
      const f = await fixture(), job = await f.makeJob(); await offline(f);
      await db.capability.update({ where: { id: f.cap.id }, data: { schedule: { mode: 'WEEKLY', timezone: 'UTC', windows: [], overrides: [] } } });
      expect((await read(f, job.id)).waitReason).toBe('WAITING_FOR_SCHEDULE');
      await db.capability.update({ where: { id: f.cap.id }, data: { paused: true } });
      expect((await read(f, job.id)).waitReason).toBe('PROVIDER_PAUSED');
      await db.capability.update({ where: { id: f.cap.id }, data: { securityBlocked: true } });
      expect((await read(f, job.id)).waitReason).toBe('PROVIDER_UNAVAILABLE');
    });
    it('uses the purchased historical version and distinguishes unverified readiness from offline', async () => {
      const f = await fixture(), job = await f.makeJob(), current = await f.newVersion(2);
      await secondDevice(f, current.id);
      await db.capability.update({ where: { id: f.cap.id }, data: { currentVersionId: current.id } });
      await offline(f);
      expect(await read(f, job.id)).toMatchObject({ capabilityVersionId: f.version.id, waitReason: 'ELIGIBLE_BUT_WORKER_OFFLINE' });
      await db.workerDevice.update({ where: { id: f.worker.id }, data: { lastSeenAt: new Date(), sandboxReady: false } });
      expect((await read(f, job.id)).waitReason).toBe('PROVIDER_UNAVAILABLE');
      await db.workerDevice.update({ where: { id: f.worker.id }, data: { sandboxReady: true } });
      await db.workerBinding.update({ where: { workerId_capabilityVersionId: { workerId: f.worker.id, capabilityVersionId: f.version.id } }, data: { validatedAt: new Date(Date.now() - 25 * 3600000) } });
      expect((await read(f, job.id)).waitReason).toBe('PROVIDER_UNAVAILABLE');
      await db.workerBinding.update({ where: { workerId_capabilityVersionId: { workerId: f.worker.id, capabilityVersionId: f.version.id } }, data: { validatedAt: new Date() } });
      expect((await read(f, job.id)).waitReason).toBe('WAITING_FOR_WORKER_ACCEPTANCE');
    });
    it('reports shared-device pending and running occupancy as capacity rather than offline', async () => {
      const f = await fixture({ maxQueue: 0 }), other = await anotherCapability(f, { maxQueue: 1 });
      const first = await f.purchase(), second = await other.purchase(); expect(first.statusCode).toBe(201); expect(second.statusCode).toBe(201);
      expect((await read(f, first.json().id)).waitReason).toBe('WAITING_FOR_WORKER_ACCEPTANCE');
      expect((await read(f, second.json().id)).waitReason).toBe('WAITING_FOR_CAPACITY');
      const offer = (await notice(f))!;
      for (const type of ['ACCEPTED', 'RUNNING']) expect((await f.signed('POST', `/api/worker/jobs/${offer.jobId}/events`, { attemptId: offer.attemptId, type })).statusCode).toBe(200);
      expect((await read(f, second.json().id)).waitReason).toBe('WAITING_FOR_CAPACITY');
      await finish(f, offer);
      expect((await read(f, second.json().id)).waitReason).toBe('WAITING_FOR_WORKER_ACCEPTANCE');
    });
    it('checks the assigned device after acceptance instead of substituting a different online worker', async () => {
      const f = await fixture(); expect((await f.purchase()).statusCode).toBe(201);
      const offer = (await notice(f))!;
      expect((await f.signed('POST', `/api/worker/jobs/${offer.jobId}/events`, { attemptId: offer.attemptId, type: 'ACCEPTED' })).statusCode).toBe(200);
      await secondDevice(f, f.version.id); await offline(f);
      expect(await read(f, offer.jobId)).toMatchObject({ state: 'ACCEPTED', waitReason: 'ELIGIBLE_BUT_WORKER_OFFLINE' });
      await db.workerDevice.update({ where: { id: f.worker.id }, data: { lastSeenAt: new Date() } });
      expect((await read(f, offer.jobId)).waitReason).toBe('WAITING_FOR_WORKER_START');
      await db.workerDevice.update({ where: { id: f.worker.id }, data: { version: '0.0.1' } });
      expect((await read(f, offer.jobId)).waitReason).toBe('PROVIDER_UNAVAILABLE');
    });
    it('keeps local device pause and revoked readiness separate from an offline heartbeat', async () => {
      const f = await fixture(), job = await f.makeJob();
      await db.workerDevice.update({ where: { id: f.worker.id }, data: { localPaused: true } });
      expect((await read(f, job.id)).waitReason).toBe('PROVIDER_PAUSED');
      await db.workerDevice.update({ where: { id: f.worker.id }, data: { localPaused: false, revokedAt: new Date() } });
      expect((await read(f, job.id)).waitReason).toBe('PROVIDER_UNAVAILABLE');
    });
    it('exposes only safe wait codes to authorized owners and keeps seller content redacted before acceptance', async () => {
      const f = await fixture(), stranger = await fixture(), job = await f.makeJob({ input: { buyerPrivate: 'BUYER-PRIVATE-CONTENT' } }); await offline(f);
      const marker = 'PRIVATE-WORKER-HEALTH-DO-NOT-PROJECT';
      await db.workerDevice.update({ where: { id: f.worker.id }, data: { health: { warning: marker, path: '/private/seller/runtime' } } });
      const sellerToken = randomUUID();
      await db.session.create({ data: { userId: f.sellerId, tokenHash: hashSecret(sellerToken), expiresAt: new Date(Date.now() + 600000) } });
      const sellerHeaders = { origin, cookie: `kivro_session=${sellerToken}` };
      for (const url of [`/api/jobs/${job.id}`, '/api/seller/jobs']) {
        const response = await app.inject({ url, headers: sellerHeaders }); expect(response.statusCode, response.body).toBe(200);
        const dto = url === '/api/seller/jobs' ? response.json()[0] : response.json();
        expect(dto).toMatchObject({ input: {}, output: null, waitReason: 'ELIGIBLE_BUT_WORKER_OFFLINE', waitDeadline: job.waitDeadline.toISOString() });
        expect(response.body).not.toContain(marker); expect(response.body).not.toContain(f.worker.id); expect(response.body).not.toContain('BUYER-PRIVATE-CONTENT');
      }
      const key = `kivro_wait_${randomUUID()}`;
      await db.apiKey.create({ data: { userId: f.buyerId, name: 'Read my waiting jobs', prefix: 'wait', secretHash: hashSecret(key), scopes: ['jobs:read'] } });
      const own = await app.inject({ url: `/api/jobs/${job.id}`, headers: { authorization: `Bearer ${key}` } });
      expect(own.statusCode, own.body).toBe(200); expect(own.json()).toMatchObject({ input: { buyerPrivate: 'BUYER-PRIVATE-CONTENT' }, waitReason: 'ELIGIBLE_BUT_WORKER_OFFLINE' });
      expect(own.body).not.toContain(marker); expect(own.body).not.toContain(f.worker.id);
      expect((await app.inject({ url: `/api/jobs/${job.id}`, headers: stranger.headers })).statusCode).toBe(404);
      expect((await app.inject(`/api/jobs/${job.id}`)).statusCode).toBe(401);
    });
    it('distinguishes the dispatch switch from accepted execution and clears wait state after cancellation', async () => {
      const accepted = await fixture(), waiting = await fixture();
      const active = await accepted.purchase(), queued = await waiting.purchase(); const offer = (await notice(accepted))!;
      expect((await accepted.signed('POST', `/api/worker/jobs/${offer.jobId}/events`, { attemptId: offer.attemptId, type: 'ACCEPTED' })).statusCode).toBe(200);
      await db.platformSetting.upsert({ where: { key: 'dispatchEnabled' }, create: { key: 'dispatchEnabled', value: false }, update: { value: false } });
      try {
        expect((await read(waiting, queued.json().id)).waitReason).toBe('DISPATCH_PAUSED');
        expect((await read(accepted, active.json().id)).waitReason).toBe('WAITING_FOR_WORKER_START');
        const cancelled = await app.inject({ method: 'POST', url: `/api/jobs/${queued.json().id}/cancel`, headers: waiting.headers, payload: {} });
        expect(cancelled.statusCode, cancelled.body).toBe(200); expect(cancelled.json()).toMatchObject({ state: 'CANCELLED', paymentState: 'RELEASED', waitReason: null });
      } finally { await db.platformSetting.update({ where: { key: 'dispatchEnabled' }, data: { value: true } }); }
    });
  });
  it('reserves a shared pending device before any offer and releases it on cancellation', async () => {
    const f = await fixture({ maxQueue: 0 }), other = await anotherCapability(f);
    const first = await f.purchase(); expect(first.statusCode, first.body).toBe(201);
    expect(await db.jobAttempt.count({ where: { workerId: f.worker.id } })).toBe(0);
    expect(await other.state()).toMatchObject({ status: 'BUSY', runningJobs: 0, queueDepth: 0, canRunNow: false, canQueue: false });
    const page = await app.inject(`/api/capabilities/page?sellerId=${f.sellerId}&q=Shared-device`);
    expect(page.statusCode, page.body).toBe(200); expect(page.json().items[0].availability.status).toBe('BUSY');
    const before = await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } });
    const denied = await other.purchase(); expect(denied.statusCode, denied.body).toBe(409); expect(denied.json().error.code).toBe('CAPABILITY_QUEUE_FULL');
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } })).toEqual(before);
    expect(await db.job.count({ where: { capabilityId: other.cap.id } })).toBe(0);
    expect(await db.ledgerEntry.count({ where: { userId: f.buyerId, type: 'JOB_RESERVE' } })).toBe(1);
    const cancelled = await app.inject({ method: 'POST', url: `/api/jobs/${first.json().id}/cancel`, headers: f.headers, payload: {} });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(await other.state()).toMatchObject({ status: 'ONLINE', canRunNow: true });
    const next = await other.purchase(); expect(next.statusCode, next.body).toBe(201);
    expect((await notice(f))?.jobId).toBe(next.json().id);
    expect(await db.ledgerEntry.count({ where: { jobId: first.json().id, type: 'JOB_RELEASE' } })).toBe(1);
  });
  it('serializes simultaneous zero-queue purchases across capabilities before payment', async () => {
    const f = await fixture({ maxQueue: 0 }), other = await anotherCapability(f);
    const responses = await Promise.all([f.purchase(), other.purchase()]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    expect(responses.find(response => response.statusCode === 409)!.json().error.code).toBe('CAPABILITY_QUEUE_FULL');
    expect(await db.job.count({ where: { sellerId: f.sellerId } })).toBe(1);
    expect(await db.jobAttempt.count({ where: { workerId: f.worker.id } })).toBe(0);
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } })).toMatchObject({ availableMinor: 9901, reservedMinor: 99, spentMinor: 0 });
    expect(await db.ledgerEntry.count({ where: { userId: f.buyerId, type: 'JOB_RESERVE' } })).toBe(1);
    expect((await notice(f))?.jobId).toBe(responses.find(response => response.statusCode === 201)!.json().id);
  });
  it('bounds a positive queue behind a pending reservation and dispatches in acceptance order', async () => {
    const f = await fixture({ maxQueue: 0 }), other = await anotherCapability(f, { maxQueue: 1 });
    const first = await f.purchase(); expect(first.statusCode).toBe(201);
    const second = await other.purchase(); expect(second.statusCode, second.body).toBe(201);
    expect(await other.state()).toMatchObject({ runningJobs: 0, queueDepth: 1, status: 'BUSY', canQueue: false, estimatedQueueWaitSeconds: 120 });
    expect((await other.purchase()).statusCode).toBe(409);
    expect((await notice(f))?.jobId).toBe(first.json().id);
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${first.json().id}/cancel`, headers: f.headers, payload: {} })).statusCode).toBe(200);
    expect((await notice(f))?.jobId).toBe(second.json().id);
    expect(await db.ledgerEntry.count({ where: { userId: f.buyerId, type: 'JOB_RESERVE' } })).toBe(2);
  });
  it('matches flexible pending work to a spare device and dispatches the single-device capability on its only device', async () => {
    const f = await fixture({ maxQueue: 0 }), other = await anotherCapability(f), second = await secondDevice(f, f.version.id);
    const originalIsFirst = f.worker.id < second.workerId;
    if (!originalIsFirst) {
      await db.workerBinding.delete({ where: { workerId_capabilityVersionId: { workerId: f.worker.id, capabilityVersionId: other.version.id } } });
      await f.bind(other.version.id, second.workerId);
    }
    const a = await f.purchase(); expect(a.statusCode).toBe(201);
    expect(await other.state()).toMatchObject({ canRunNow: true, status: 'ONLINE' });
    const b = await other.purchase(); expect(b.statusCode, b.body).toBe(201);
    const [original, spare] = await Promise.all([f.signed('GET', '/api/worker/offers'), f.signed('GET', '/api/worker/offers', undefined, second)]);
    for (const response of [original, spare]) expect(response.statusCode, response.body).toBe(200);
    expect(original.json().offers[0].payload.jobId).toBe(originalIsFirst ? b.json().id : a.json().id);
    expect(spare.json().offers[0].payload.jobId).toBe(originalIsFirst ? a.json().id : b.json().id);
    expect(await db.jobAttempt.count({ where: { job: { sellerId: f.sellerId } } })).toBe(2);
    expect(await db.ledgerEntry.count({ where: { userId: f.buyerId, type: 'JOB_RESERVE' } })).toBe(2);
  });
  it('does not use an incompatible spare device or block an independent compatible capability', async () => {
    const f = await fixture({ maxQueue: 0 }), shared = await anotherCapability(f), independent = await anotherCapability(f);
    const spare = await secondDevice(f, independent.version.id);
    await db.workerBinding.delete({ where: { workerId_capabilityVersionId: { workerId: f.worker.id, capabilityVersionId: independent.version.id } } });
    expect((await f.purchase()).statusCode).toBe(201);
    expect((await shared.purchase()).statusCode).toBe(409);
    const available = await independent.purchase(); expect(available.statusCode, available.body).toBe(201);
    const dispatched = await f.signed('GET', '/api/worker/offers', undefined, spare);
    expect(dispatched.statusCode, dispatched.body).toBe(200); expect(dispatched.json().offers[0].payload.jobId).toBe(available.json().id);
  });
  it('matches old queued versions independently of a newly published version and its device', async () => {
    const f = await fixture({ concurrency: 2, maxQueue: 0 }), shared = await anotherCapability(f);
    const old = await f.purchase(); expect(old.statusCode).toBe(201);
    const version = await f.newVersion(2), spare = await secondDevice(f, version.id);
    await db.capability.update({ where: { id: f.cap.id }, data: { currentVersionId: version.id } });
    const current = await f.purchase(); expect(current.statusCode, current.body).toBe(201);
    expect((await shared.purchase()).statusCode).toBe(409);
    expect((await notice(f))?.jobId).toBe(old.json().id);
    const offered = await f.signed('GET', '/api/worker/offers', undefined, spare);
    expect(offered.statusCode, offered.body).toBe(200); expect(offered.json().offers[0].payload).toMatchObject({ jobId: current.json().id, capabilityVersionId: version.id });
  });
  it('does not let an older scheduled promotion steal a different capability zero-queue reservation', async () => {
    const f = await fixture({ maxQueue: 0 }), other = await anotherCapability(f);
    const first = await f.purchase(); expect(first.statusCode).toBe(201);
    const due = await f.makeJob({ capabilityId: other.cap.id, capabilityVersionId: other.version.id, createdAt: new Date(Date.now() - 10000) });
    await reconcileJobs(app.kivro);
    expect((await db.job.findUniqueOrThrow({ where: { id: due.id } })).state).toBe('SCHEDULED');
    expect((await notice(f))?.jobId).toBe(first.json().id);
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${first.json().id}/cancel`, headers: f.headers, payload: {} })).statusCode).toBe(200);
    expect((await f.purchase()).statusCode).toBe(409);
    expect((await notice(f))?.jobId).toBe(due.id);
    expect(await db.ledgerEntry.count({ where: { jobId: due.id, type: 'JOB_RESERVE' } })).toBe(1);
  });
  it('does not retain a shared pending reservation when funding fails', async () => {
    const f = await fixture({ maxQueue: 0, funding: 0 }), other = await anotherCapability(f);
    expect((await f.purchase()).statusCode).toBe(402);
    expect(await other.state()).toMatchObject({ canRunNow: true });
    expect(await db.job.count({ where: { sellerId: f.sellerId } })).toBe(0);
    await serializable(db, tx => creditWallet(tx, f.buyerId, 99, `recovered-funding:${f.buyerId}`));
    const bought = await other.purchase(); expect(bought.statusCode, bought.body).toBe(201);
    expect((await f.purchase()).statusCode).toBe(409);
    expect(await db.ledgerEntry.count({ where: { userId: f.buyerId, type: 'JOB_RESERVE' } })).toBe(1);
  });
  it('persists the admission ordering timestamp instead of an older transaction-start timestamp', async () => {
    const f = await fixture({ maxQueue: 0 }), other = await anotherCapability(f, { maxQueue: 1 });
    const accepted = await f.makeJob({ state: 'QUEUED', createdAt: new Date(Date.now() + 1000) });
    const bought = await other.purchase(); expect(bought.statusCode, bought.body).toBe(201);
    const queued = await db.job.findUniqueOrThrow({ where: { id: bought.json().id } });
    expect(queued.createdAt.getTime()).toBeGreaterThan(accepted.createdAt.getTime());
    expect((await notice(f))?.jobId).toBe(accepted.id);
  });
  it('enforces the real admin dispatch switch without charging or offering new work and preserves running execution', async () => {
    const running = await fixture(), offered = await fixture(), queued = await fixture();
    const active = await start(running), offeredPurchase = await offered.purchase(), queuedPurchase = await queued.purchase();
    expect(offeredPurchase.statusCode).toBe(201); expect(queuedPurchase.statusCode).toBe(201);
    const issued = (await notice(offered))!;
    const adminId = randomUUID(), token = randomUUID();
    await db.user.create({ data: { id: adminId, name: 'Dispatch admin', email: `${adminId}@dispatch.kivro.local`, passwordHash: 'disabled', isAdmin: true,
      sessions: { create: { tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + 600000) } } } });
    const headers = { origin, cookie: `kivro_session=${token}` };
    const change = (enabled: boolean, requestHeaders = headers) => app.inject({ method: 'POST', url: '/api/admin/dispatch', headers: requestHeaders, payload: { enabled } });
    expect((await change(false, running.headers)).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/dispatch', headers: { origin }, payload: { enabled: false } })).statusCode).toBe(401);
    const key = await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: 'No administrative bearer authority', scopes: ['jobs:create'] } });
    expect(key.statusCode, key.body).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/admin/dispatch', headers: { authorization: `Bearer ${key.json().secret}` }, payload: { enabled: false } })).statusCode).toBe(403);
    const buyerIds = [running.buyerId, offered.buyerId, queued.buyerId];
    const wallets = await db.wallet.findMany({ where: { userId: { in: buyerIds } }, orderBy: { userId: 'asc' } });
    const jobs = await db.job.count({ where: { buyerId: { in: buyerIds } } });
    const activeBefore = await db.job.findUniqueOrThrow({ where: { id: active.jobId } });
    const issuedBefore = await db.jobAttempt.findUniqueOrThrow({ where: { id: issued.attemptId } });
    try {
      const disabled = await change(false); expect(disabled.statusCode, disabled.body).toBe(200); expect(disabled.json()).toEqual({ enabled: false });
      const denied = await queued.purchase(); expect(denied.statusCode, denied.body).toBe(503); expect(denied.json().error.code).toBe('DISPATCH_DISABLED');
      expect(await db.job.count({ where: { buyerId: { in: buyerIds } } })).toBe(jobs);
      expect(await db.wallet.findMany({ where: { userId: { in: buyerIds } }, orderBy: { userId: 'asc' } })).toEqual(wallets);
      expect(await notice(queued)).toBeUndefined(); expect(await notice(offered)).toBeUndefined();
      const accepted = await offered.signed('POST', `/api/worker/jobs/${issued.jobId}/events`, { attemptId: issued.attemptId, type: 'ACCEPTED' });
      expect(accepted.statusCode, accepted.body).toBe(409); expect(accepted.json().error.code).toBe('ACCEPTANCE_BLOCKED');
      expect(await db.jobAttempt.findUniqueOrThrow({ where: { id: issued.attemptId } })).toEqual(issuedBefore);
      expect(await db.job.findUniqueOrThrow({ where: { id: active.jobId } })).toEqual(activeBefore);
      expect(await db.workerCommand.count({ where: { workerId: { in: [running.worker.id, offered.worker.id, queued.worker.id] } } })).toBe(0);
      expect(await db.ledgerEntry.count({ where: { jobId: { in: [active.jobId, issued.jobId, queuedPurchase.json().id] }, type: { in: ['JOB_RELEASE', 'JOB_CAPTURE', 'SELLER_EARNING'] } } })).toBe(0);
      const completed = await running.signed('POST', `/api/worker/jobs/${active.jobId}/result`, { attemptId: active.attemptId, output: { text: 'Already-running work may finish' } });
      expect(completed.statusCode, completed.body).toBe(200);
      expect(await db.ledgerEntry.count({ where: { jobId: active.jobId, type: 'JOB_CAPTURE' } })).toBe(1);
      const restored = await change(true); expect(restored.statusCode, restored.body).toBe(200);
      expect((await notice(offered))?.attemptId).toBe(issued.attemptId);
      expect((await offered.signed('POST', `/api/worker/jobs/${issued.jobId}/events`, { attemptId: issued.attemptId, type: 'ACCEPTED' })).statusCode).toBe(200);
      expect((await notice(queued))?.jobId).toBe(queuedPurchase.json().id);
      const resumedPurchase = await running.purchase(); expect(resumedPurchase.statusCode, resumedPurchase.body).toBe(201);
      expect(await db.ledgerEntry.count({ where: { jobId: resumedPurchase.json().id, type: 'JOB_RESERVE' } })).toBe(1);
      const changes = await db.auditEvent.findMany({ where: { actorId: adminId, type: 'DISPATCH_CHANGED' }, orderBy: { createdAt: 'asc' } });
      expect(changes.map(event => event.metadata)).toEqual([{ enabled: false }, { enabled: true }]);
    } finally {
      await db.platformSetting.upsert({ where: { key: 'dispatchEnabled' }, create: { key: 'dispatchEnabled', value: true }, update: { value: true } });
    }
  });
  it('reports shared-device occupancy publicly and rejects zero-queue purchases without reserving funds', async () => {
    const f = await fixture({ maxQueue: 0 }), other = await anotherCapability(f);
    const active = await start(f);
    expect(await other.state()).toMatchObject({ status: 'BUSY', canRunNow: false, canQueue: false, runningJobs: 0,
      effectiveConcurrency: 1, capacityLoad: 1, estimatedQueueWaitSeconds: 60 });
    const detail = await app.inject(`/api/capabilities/${other.cap.id}`);
    expect(detail.json().availability).toMatchObject({ status: 'BUSY', canRunNow: false, canQueue: false, estimatedQueueWaitSeconds: 60 });
    const busyPage = await app.inject(`/api/capabilities/page?sellerId=${f.sellerId}&availability=BUSY&q=Shared-device`);
    expect(busyPage.statusCode, busyPage.body).toBe(200); expect(busyPage.json().items.map((item: { id: string }) => item.id)).toEqual([other.cap.id]);
    const nowPage = await app.inject(`/api/capabilities/page?sellerId=${f.sellerId}&availability=NOW`);
    expect(nowPage.json().items).toEqual([]);
    const quote = await app.inject({ method: 'POST', url: `/api/capabilities/${other.cap.id}/quote`, headers: f.headers, payload: { executionMode: 'NOW' } });
    expect(quote.statusCode, quote.body).toBe(409); expect(await db.scheduleQuote.count({ where: { capabilityId: other.cap.id } })).toBe(0);
    await expect(quoteAgentCapability(app.kivro, { userId: f.buyerId, capabilityId: other.cap.id, capabilityVersionId: other.version.id, executionMode: 'NOW' }))
      .rejects.toMatchObject({ code: 'NOT_IMMEDIATELY_AVAILABLE', statusCode: 409 });
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } });
    const response = await other.purchase(); expect(response.statusCode, response.body).toBe(409); expect(response.json().error.code).toBe('CAPABILITY_QUEUE_FULL');
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } })).toEqual(wallet);
    expect(await db.job.count({ where: { capabilityId: other.cap.id } })).toBe(0);
    expect(await db.ledgerEntry.count({ where: { userId: f.buyerId, type: 'JOB_RESERVE' } })).toBe(1);
    expect(await notice(f)).toBeUndefined();
    await finish(f, active);
    expect(await other.state()).toMatchObject({ status: 'ONLINE', canRunNow: true, capacityLoad: 0, runningJobs: 0 });
    expect((await other.purchase()).statusCode).toBe(201);
    expect((await notice(f))?.capabilityVersionId).toBe(other.version.id);
  });
  it('bounds positive queue capacity behind another capability and drains it after the device is freed', async () => {
    const f = await fixture({ maxQueue: 0 }), other = await anotherCapability(f, { concurrency: 4, maxQueue: 1 });
    const active = await start(f);
    expect(await other.state()).toMatchObject({ status: 'BUSY', canQueue: true, runningJobs: 0, capacityLoad: 1, effectiveConcurrency: 1 });
    const first = await other.purchase(); expect(first.statusCode, first.body).toBe(201);
    expect(await other.state()).toMatchObject({ status: 'BUSY', canQueue: false, queueDepth: 1, runningJobs: 0, estimatedQueueWaitSeconds: 120 });
    const rejected = await other.purchase(); expect(rejected.statusCode).toBe(409); expect(rejected.json().error.code).toBe('CAPABILITY_QUEUE_FULL');
    expect(await db.job.count({ where: { capabilityId: other.cap.id } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { jobId: first.json().id, type: 'JOB_RESERVE' } })).toBe(1);
    await finish(f, active);
    expect((await notice(f))?.jobId).toBe(first.json().id);
  });
  it('counts a live unaccepted offer as an occupied device slot', async () => {
    const f = await fixture({ maxQueue: 0 }), other = await anotherCapability(f);
    expect((await f.purchase()).statusCode).toBe(201); const offered = await notice(f); expect(offered).toBeDefined();
    expect(await other.state()).toMatchObject({ status: 'BUSY', canRunNow: false, capacityLoad: 1, runningJobs: 0 });
    expect((await other.purchase()).statusCode).toBe(409);
    const cancelled = await app.inject({ method: 'POST', url: `/api/jobs/${offered!.jobId}/cancel`, headers: f.headers, payload: {} });
    expect(cancelled.statusCode).toBe(200);
    expect(await other.state()).toMatchObject({ status: 'ONLINE', canRunNow: true, capacityLoad: 0 });
  });
  it('preserves security, pause, schedule and offline precedence over shared-device load', async () => {
    const f = await fixture({ maxQueue: 0 }), other = await anotherCapability(f); await start(f);
    await db.capability.update({ where: { id: other.cap.id }, data: { securityBlocked: true, paused: true } });
    expect(await other.state()).toMatchObject({ status: 'SECURITY_BLOCKED', canRunNow: false, canQueue: false });
    await db.capability.update({ where: { id: other.cap.id }, data: { securityBlocked: false } });
    expect(await other.state()).toMatchObject({ status: 'PAUSED', canRunNow: false, canQueue: false });
    const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    await db.capability.update({ where: { id: other.cap.id }, data: { paused: false, schedule: { mode: 'WEEKLY', timezone: 'UTC', overrides: [],
      windows: [{ day: tomorrow.getUTCDay(), start: '10:00', end: '11:00' }] } } });
    expect(await other.state()).toMatchObject({ status: 'SCHEDULED_OFFLINE', canRunNow: false, canQueue: false });
    await db.workerDevice.update({ where: { id: f.worker.id }, data: { lastSeenAt: new Date(Date.now() - 600000) } });
    expect(await other.state()).toMatchObject({ status: 'OFFLINE', canRunNow: false, canQueue: false });
  });
  it('keeps due zero-queue reservations scheduled while their device is occupied elsewhere', async () => {
    const f = await fixture({ maxQueue: 0 }), other = await anotherCapability(f), active = await start(f);
    const waiting = await f.makeJob({ capabilityId: other.cap.id, capabilityVersionId: other.version.id });
    await reconcileJobs(app.kivro);
    expect((await db.job.findUniqueOrThrow({ where: { id: waiting.id } })).state).toBe('SCHEDULED');
    expect(await notice(f)).toBeUndefined();
    await finish(f, active); await reconcileJobs(app.kivro);
    expect((await db.job.findUniqueOrThrow({ where: { id: waiting.id } })).state).toBe('QUEUED');
    expect((await notice(f))?.jobId).toBe(waiting.id);
    expect(await db.ledgerEntry.count({ where: { jobId: waiting.id, type: 'JOB_RESERVE' } })).toBe(1);
  });
  it('uses a spare ready device instead of treating every foreign attempt as a capability slot', async () => {
    const f = await fixture({ maxQueue: 0 }), other = await anotherCapability(f), device = await secondDevice(f, other.version.id);
    await start(f);
    expect(await other.state()).toMatchObject({ status: 'ONLINE', canRunNow: true, runningJobs: 0, effectiveConcurrency: 1, capacityLoad: 0 });
    const job = await other.purchase(); expect(job.statusCode, job.body).toBe(201);
    expect(await notice(f)).toBeUndefined();
    const offered = await f.signed('GET', '/api/worker/offers', undefined, device);
    expect(offered.statusCode, offered.body).toBe(200); expect(offered.json().offers[0].payload.jobId).toBe(job.json().id);
    expect(await other.state()).toMatchObject({ status: 'BUSY', runningJobs: 1, capacityLoad: 1, effectiveConcurrency: 1 });
  });
  it('counts historical active attempts even after their capability publishes another version', async () => {
    const f = await fixture({ maxQueue: 0 }), other = await anotherCapability(f), active = await start(f);
    const next = await f.newVersion(2); await secondDevice(f, next.id);
    await db.capability.update({ where: { id: f.cap.id }, data: { currentVersionId: next.id } });
    await db.workerDevice.update({ where: { id: f.worker.id }, data: { runningJobIds: [] } });
    expect((await db.job.findUniqueOrThrow({ where: { id: active.jobId } })).capabilityVersionId).toBe(f.version.id);
    expect(await other.state()).toMatchObject({ status: 'BUSY', runningJobs: 0, capacityLoad: 1 });
    expect(await availability(app.kivro, await loadCapability(db, f.cap.id), db)).toMatchObject({ status: 'BUSY', runningJobs: 1, capacityLoad: 1 });
    expect((await other.purchase()).statusCode).toBe(409);
    await db.capability.update({ where: { id: f.cap.id }, data: { concurrency: 2 } });
    expect(await availability(app.kivro, await loadCapability(db, f.cap.id), db)).toMatchObject({ status: 'ONLINE', runningJobs: 1, capacityLoad: 0, effectiveConcurrency: 1 });
    expect((await f.purchase()).statusCode).toBe(201);
  });
  it('ignores reported running IDs and stale nonactive attempt rows when computing physical occupancy', async () => {
    const f = await fixture({ maxQueue: 0 }), other = await anotherCapability(f);
    const past = await f.makeJob();
    await app.inject({ method: 'POST', url: `/api/jobs/${past.id}/cancel`, headers: f.headers, payload: {} });
    await db.jobAttempt.create({ data: { jobId: past.id, workerId: f.worker.id, state: 'RUNNING', expiresAt: new Date(Date.now() + 60000), nonce: randomUUID() } });
    await db.workerDevice.update({ where: { id: f.worker.id }, data: { runningJobIds: [past.id, randomUUID()] } });
    expect(await other.state()).toMatchObject({ status: 'ONLINE', canRunNow: true, capacityLoad: 0 });
    expect((await other.purchase()).statusCode).toBe(201);
  });
  it('keeps future quotes as estimates while a device is currently occupied elsewhere', async () => {
    const f = await fixture({ maxQueue: 0 }), other = await anotherCapability(f); await start(f);
    const at = new Date(Date.now() + 3600000).toISOString();
    const quote = await quoteAgentCapability(app.kivro, { userId: f.buyerId, capabilityId: other.cap.id, capabilityVersionId: other.version.id, executionMode: 'SCHEDULED', scheduledAt: at });
    expect(quote.earliestStartAt).toBe(at);
    expect(await db.job.count({ where: { capabilityId: other.cap.id } })).toBe(0);
  });
  it('gives due reservations the last slots before NOW and records one durable rejection without financial effects', async () => {
    const f = await fixture({ maxQueue: 0 }), older = await f.makeJob();
    const before = await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } }), key = randomUUID();
    for (let replay = 0; replay < 2; replay++) {
      const response = await f.purchase('NOW', undefined, key); expect(response.statusCode, response.body).toBe(409); expect(response.json().error.code).toBe('CAPABILITY_QUEUE_FULL');
    }
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } })).toEqual(before);
    expect(await db.job.count({ where: { capabilityId: f.cap.id } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { jobId: older.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { actorId: f.buyerId, type: 'CAPACITY_QUEUE_FULL' } })).toBe(1);
    expect((await notice(f))?.jobId).toBe(older.id);
    expect(await db.ledgerEntry.count({ where: { jobId: older.id, type: 'JOB_RESERVE' } })).toBe(1);
  });
  it('preserves the queue-full 409 if independent telemetry is unavailable', async () => {
    const f = await fixture({ maxQueue: 0 }); await f.makeJob({ state: 'QUEUED' });
    const spy = vi.spyOn(telemetry, 'recordQueueFullRejection').mockRejectedValueOnce(new Error('Synthetic telemetry outage'));
    try {
      const response = await f.purchase(); expect(response.statusCode, response.body).toBe(409); expect(response.json().error.code).toBe('CAPABILITY_QUEUE_FULL');
      expect(await db.job.count({ where: { capabilityId: f.cap.id } })).toBe(1);
      expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } })).toMatchObject({ availableMinor: 9901, reservedMinor: 99, spentMinor: 0 });
    } finally { spy.mockRestore(); }
  });
  it('does not record capacity rejections for insufficient funds or retain a failed admission', async () => {
    const f = await fixture({ funding: 0 });
    const response = await f.purchase(); expect(response.statusCode, response.body).toBe(402);
    expect(await db.auditEvent.count({ where: { actorId: f.buyerId, type: 'CAPACITY_QUEUE_FULL' } })).toBe(0);
    expect(await db.job.count({ where: { capabilityId: f.cap.id } })).toBe(0);
    expect(await db.ledgerEntry.count({ where: { userId: f.buyerId } })).toBe(0);
  });
  it('runs bounded capacity observation as an independent maintenance task after a telemetry failure', async () => {
    const f = await fixture(), job = await f.makeJob();
    await db.job.update({ where: { id: job.id }, data: { waitDeadline: new Date(Date.now() - 1000) } });
    const observation = vi.spyOn(telemetry, 'reconcileCapacityTelemetry').mockRejectedValueOnce(new Error('CAPACITY_OBSERVATION_FAILED'));
    const cleanup = vi.spyOn(examples, 'cleanupExampleAssets');
    try {
      await maintenance(app.kivro);
      expect(observation).toHaveBeenCalledTimes(1); expect(cleanup).toHaveBeenCalledTimes(1);
      expect((await db.platformSetting.findUniqueOrThrow({ where: { key: 'maintenance-error:capacity' } })).value).toMatchObject({ code: 'OPERATION_FAILED' });
      expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ state: 'TIMED_OUT', paymentState: 'RELEASED' });
      expect(await db.ledgerEntry.count({ where: { jobId: job.id, type: 'JOB_RELEASE' } })).toBe(1);
    } finally { observation.mockRestore(); cleanup.mockRestore(); }
    await maintenance(app.kivro);
    expect(await db.platformSetting.findUnique({ where: { key: 'maintenance-error:capacity' } })).toBeNull();
    expect(await db.auditEvent.count({ where: { type: 'CAPACITY_OBSERVATION', sellerId: f.sellerId } })).toBeGreaterThan(0);
  });
  it('promotes by acceptance order even when the recovery UUID page sees the newer reservation first', async () => {
    const f = await fixture({ maxQueue: 0 });
    const old = await f.makeJob({ id: `ffffffff-ffff-4fff-8fff-${randomBytes(6).toString('hex')}`, createdAt: new Date(Date.now() - 2000) });
    const newer = await f.makeJob({ id: `00000000-0000-4000-8000-${randomBytes(6).toString('hex')}`, createdAt: new Date(Date.now() - 1000) });
    await reconcileJobs(app.kivro);
    expect((await db.job.findUniqueOrThrow({ where: { id: old.id } })).state).toBe('QUEUED');
    expect((await db.job.findUniqueOrThrow({ where: { id: newer.id } })).state).toBe('SCHEDULED');
    expect((await notice(f))?.jobId).toBe(old.id);
  });
  it('breaks equal acceptance timestamps by ID, never by price or input priority', async () => {
    const f = await fixture(), at = new Date(Date.now() - 2000);
    const ids = [randomUUID(), randomUUID()].sort();
    await f.makeJob({ id: ids[1], createdAt: at }); await f.makeJob({ id: ids[0], createdAt: at });
    expect((await notice(f))?.jobId).toBe(ids[0]);
    const response = await app.inject({ method: 'POST', url: '/api/jobs', headers: { ...f.headers, 'idempotency-key': randomUUID() },
      payload: { capabilityId: f.cap.id, input: {}, executionMode: 'NOW', priority: 100 } });
    expect(response.statusCode).toBe(400);
  });
  it('keeps historical versions pinned and cannot skip an unverified older version to offer a newer job', async () => {
    const f = await fixture(), next = await f.newVersion(2); await f.bind(next.id);
    const old = await f.makeJob({ createdAt: new Date(Date.now() - 2000) });
    await db.capability.update({ where: { id: f.cap.id }, data: { currentVersionId: next.id } });
    await f.makeJob({ capabilityVersionId: next.id, state: 'QUEUED' });
    await db.workerBinding.update({ where: { workerId_capabilityVersionId: { workerId: f.worker.id, capabilityVersionId: f.version.id } }, data: { healthy: false } });
    expect(await notice(f)).toBeUndefined();
    expect(await db.jobAttempt.count({ where: { job: { capabilityId: f.cap.id } } })).toBe(0);
    await db.workerBinding.update({ where: { workerId_capabilityVersionId: { workerId: f.worker.id, capabilityVersionId: f.version.id } }, data: { healthy: true } });
    expect(await notice(f)).toMatchObject({ jobId: old.id, capabilityVersionId: f.version.id });
    expect((await db.job.findUniqueOrThrow({ where: { id: old.id } })).buyerPriceMinor).toBe(99);
  });
  it('does not block NOW behind a reservation that is not eligible yet', async () => {
    const f = await fixture({ maxQueue: 0 }); await f.makeJob({ scheduledAt: new Date(Date.now() + 3600000) });
    const response = await f.purchase(); expect(response.statusCode, response.body).toBe(201);
    expect((await notice(f))?.jobId).toBe(response.json().id);
  });
  it('preserves an already-full execution queue, then fills its freed slot with the oldest due reservation', async () => {
    const f = await fixture({ maxQueue: 0 });
    const scheduled = await f.makeJob({ createdAt: new Date(Date.now() - 3000) });
    const admitted = await f.makeJob({ state: 'QUEUED', createdAt: new Date(Date.now() - 2000) });
    expect((await notice(f))?.jobId).toBe(admitted.id);
    const cancel = await app.inject({ method: 'POST', url: `/api/jobs/${admitted.id}/cancel`, headers: f.headers, payload: {} });
    expect(cancel.statusCode, cancel.body).toBe(200);
    const purchase = f.purchase(), offered = notice(f);
    const [rejected, next] = await Promise.all([purchase, offered]);
    expect(rejected.statusCode, rejected.body).toBe(409); expect(rejected.json().error.code).toBe('CAPABILITY_QUEUE_FULL');
    expect(next?.jobId).toBe(scheduled.id);
    expect(await db.job.count({ where: { capabilityId: f.cap.id } })).toBe(2);
    expect(await db.ledgerEntry.count({ where: { jobId: admitted.id, type: 'JOB_RELEASE' } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { jobId: scheduled.id, type: 'JOB_RESERVE' } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { jobId: scheduled.id, type: { in: ['JOB_CAPTURE', 'SELLER_EARNING'] } } })).toBe(0);
  });
  it('admits only the real ready device count even when configured concurrency is higher', async () => {
    const f = await fixture({ concurrency: 4, maxQueue: 0 });
    expect((await f.purchase()).statusCode).toBe(201);
    const second = await f.purchase(); expect(second.statusCode).toBe(409); expect(second.json().error.code).toBe('CAPABILITY_QUEUE_FULL');
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } })).toMatchObject({ availableMinor: 9901, reservedMinor: 99 });
  });
  it('serializes the last future-window reservation, rechecks quotes, and treats later windows independently', async () => {
    const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1); tomorrow.setUTCHours(10, 0, 0, 0);
    const later = new Date(tomorrow.getTime() + 3600000);
    const f = await fixture({ maxQueue: 3, schedule: { mode: 'WEEKLY', timezone: 'UTC', overrides: [],
      windows: [{ day: tomorrow.getUTCDay(), start: '10:00', end: '10:01' }, { day: tomorrow.getUTCDay(), start: '11:00', end: '11:01' }] } });
    const quote = await app.inject({ method: 'POST', url: `/api/capabilities/${f.cap.id}/quote`, headers: f.headers, payload: { executionMode: 'SCHEDULED' } });
    expect(quote.statusCode, quote.body).toBe(200);
    const agentRequest = { userId: f.buyerId, capabilityId: f.cap.id, capabilityVersionId: f.version.id, executionMode: 'SCHEDULED' as const, scheduledAt: tomorrow.toISOString() };
    expect(await quoteAgentCapability(app.kivro, agentRequest)).toMatchObject({ earliestStartAt: tomorrow.toISOString() });
    expect(await db.job.count({ where: { capabilityId: f.cap.id } })).toBe(0);
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } })).toMatchObject({ availableMinor: 10000, reservedMinor: 0 });
    const a = f.purchase('SCHEDULED', tomorrow), b = f.purchase('SCHEDULED', tomorrow);
    const responses = await Promise.all([a, b]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    expect(responses.find(response => response.statusCode === 409)!.json().error.code).toBe('SCHEDULE_WINDOW_FULL');
    const stale = await f.purchase('SCHEDULED', tomorrow, randomUUID(), quote.json().id);
    expect(stale.statusCode).toBe(409); expect(stale.json().error.code).toBe('SCHEDULE_WINDOW_FULL');
    const quoteCount = await db.scheduleQuote.count({ where: { capabilityId: f.cap.id } });
    await expect(quoteAgentCapability(app.kivro, agentRequest)).rejects.toMatchObject({ code: 'SCHEDULE_WINDOW_FULL', statusCode: 409 });
    expect(await db.scheduleQuote.count({ where: { capabilityId: f.cap.id } })).toBe(quoteCount);
    expect(await quoteAgentCapability(app.kivro, { ...agentRequest, scheduledAt: later.toISOString() })).toMatchObject({ earliestStartAt: later.toISOString() });
    expect((await f.purchase('SCHEDULED', later)).statusCode).toBe(201);
    expect(await db.job.count({ where: { capabilityId: f.cap.id } })).toBe(2);
    expect(await db.ledgerEntry.count({ where: { userId: f.buyerId, type: 'JOB_RESERVE' } })).toBe(2);
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: f.buyerId } })).toMatchObject({ availableMinor: 9802, reservedMinor: 198, spentMinor: 0 });
  });
});
