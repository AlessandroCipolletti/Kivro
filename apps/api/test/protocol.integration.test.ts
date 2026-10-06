import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { PrismaClient, json } from '@kivro/database';
import { creditWallet } from '@kivro/billing';
import { DEFAULT_SCHEDULE, hashManifest, executionManifestHash, stableStringify, type PermissionManifest, type IOContract, type Dependency } from '@kivro/contracts';
import { ADAPTER_POLICY_VERSION } from '@kivro/openclaw-adapter';
import { capabilityDefinitionHash, planApprovalHash, type OrchestrationPlan } from '@kivro/marketplace-agent';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { canonicalWorkerRequest } from '../src/worker.js';
import { reconcileJobs } from '../src/background.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('API durable protocol and funds', () => {
  let app: FastifyInstance; let db: PrismaClient;
  const buyerId = randomUUID(), sellerId = randomUUID(), capabilityId = randomUUID(), versionId = randomUUID();
  const keys = generateKeyPairSync('ed25519');
  const paymentBuyers: { id: string; cookie: string }[] = [];
  let buyerCookie = '', sellerCookie = '', workerId = '', serverPublicKey = '';
  const permissions: PermissionManifest = { schemaVersion: 1, tools: ['read', 'write', 'edit'], network: { mode: 'NONE', allowedDomains: [] }, resources: [],
    inference: { provider: 'openai-compatible', model: 'test-model', credentialRef: 'integration-only' },
    limits: { timeoutSeconds: 300, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 16 * 1024 ** 2, maxOutputBytes: 16 * 1024 ** 2, maxTokens: 1000 } };
  const ioContract: IOContract = { schemaVersion: 1, inputs: [{ key: 'text', label: 'Text', type: 'LONG_TEXT', required: true, order: 0 },
    { key: 'document', label: 'Document', type: 'FILE', required: false, order: 1, constraints: { allowedMimeTypes: ['text/markdown'], allowedExtensions: ['.md'], maxFileSizeBytes: 1024 } }],
    output: { type: 'MIXED', description: 'Summary and Markdown file', required: true, files: { allowedMimeTypes: ['text/markdown'], allowedExtensions: ['.md'], maxFiles: 1, maxTotalSizeBytes: 1024 } } };
  const instructions = 'Use approved inputs and return text plus a Markdown file.';
  const dependencies: Dependency[] = [{ id: 'inference', name: 'Inference', type: 'INFERENCE', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { inferenceProviders: ['openai-compatible'], credentialRefs: ['integration-only'], tools: ['read', 'write', 'edit'] } }];
  const manifestHash = executionManifestHash({ ioContract, permissions, internalInstructions: instructions, dependencies });
  const validation = () => ({ manifestHash, passed: true, proof: { sandbox: { imageId: `sha256:${'a'.repeat(64)}`, policyVersion: ADAPTER_POLICY_VERSION, testedAt: Date.now() }, inference: { configHash: 'b'.repeat(64), testedAt: Date.now() } } });
  const heartbeatBody = { version: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)', sandboxReady: true, paused: false, capabilities: [versionId], runningJobIds: [], health: { ready: true } };
  const jsonHeaders = () => ({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', 'content-type': 'application/json' });
  const workerRequest = (method: 'GET' | 'POST', path: string, body?: unknown, override?: { nonce: string; raw?: Buffer; contentType?: string }) => {
    const raw = override?.raw ?? (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)));
    const nonce = override?.nonce ?? randomUUID(), timestamp = String(Date.now());
    const pathname = new URL(path, 'http://localhost').pathname;
    return app.inject({ method, url: path, headers: { 'x-worker-id': workerId, 'x-worker-timestamp': timestamp, 'x-worker-nonce': nonce,
      'x-worker-signature': sign(null, Buffer.from(canonicalWorkerRequest(method, pathname, timestamp, nonce, raw)), keys.privateKey).toString('base64'),
      ...(raw.length ? { 'content-type': override?.contentType ?? 'application/json' } : {}) }, ...(raw.length ? { payload: raw } : {}) });
  };
  const purchase = (key = randomUUID(), input: Record<string, unknown> = { text: 'Private buyer text for an isolated protocol test.' }) => app.inject({ method: 'POST', url: '/api/jobs',
    headers: { ...jsonHeaders(), cookie: buyerCookie, 'idempotency-key': key }, payload: { capabilityId, input, executionMode: 'NOW' } });
  beforeAll(async () => {
    process.loadEnvFile('.env');
    if (process.env.KIVRO_ENV !== 'development' || !process.env.DATABASE_URL?.includes(':55432/kivro')) throw new Error('Integration requires local development services');
    db = new PrismaClient();
    const passwordHash = await hashPassword('integration-password-123');
    for (const [id, name] of [[buyerId, 'buyer'], [sellerId, 'seller']] as const) await db.user.create({ data: { id, name, email: `${id}@protocol.kivro.local`, passwordHash, wallet: { create: {} } } });
    await db.$transaction(tx => creditWallet(tx, buyerId, 10000, `protocol:${buyerId}:fund`));
    await db.capability.create({ data: { id: capabilityId, sellerId, slug: `protocol-${capabilityId}`, visibility: 'PUBLIC', schedule: DEFAULT_SCHEDULE } });
    await db.capabilityVersion.create({ data: { id: versionId, capabilityId, version: 1, title: 'Protocol fixture', summary: 'Protocol integration test fixture', description: '', category: 'Writing & documents', tags: ['integration'], priceTierId: 'USD_99',
      ioContract: json(ioContract), permissions: json(permissions), dependencies: json(dependencies),
      internalInstructions: instructions, manifestHash, publishedAt: new Date(), testPassedAt: new Date() } });
    await db.capability.update({ where: { id: capabilityId }, data: { currentVersionId: versionId } });
    app = await createApp({ env: { ...process.env, PAYMENT_MODE: 'fake' }, db, logger: false });
    app.get('/api/rate-identity-probe', { config: { responseContract: z.object({ userId: z.string().uuid().optional() }).strict(), rateLimit: { max: 2, timeWindow: '1 minute' } } }, async request => ({ userId: request.identity?.user.id }));
    for (const id of [buyerId, sellerId]) {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: jsonHeaders(), payload: { email: `${id}@protocol.kivro.local`, password: 'integration-password-123' } });
      expect(login.statusCode).toBe(200);
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      if (id === buyerId) buyerCookie = cookie; else sellerCookie = cookie;
    }
    const terms = (await app.inject('/api/terms')).json();
    expect((await app.inject({ method: 'POST', url: '/api/account/terms', headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: { version: terms.version } })).statusCode).toBe(200);
    const pairing = await app.inject({ method: 'POST', url: '/api/seller/pairing-code', headers: { ...jsonHeaders(), cookie: sellerCookie }, payload: {} });
    const paired = await app.inject({ method: 'POST', url: '/api/worker/pair', payload: { code: pairing.json().code,
      publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(), name: 'Protocol integration worker', version: '0.1.0' } });
    expect(paired.statusCode).toBe(200); workerId = paired.json().workerId; serverPublicKey = paired.json().serverPublicKey;
    const heartbeat = await workerRequest('POST', '/api/worker/heartbeat', heartbeatBody);
    expect(heartbeat.statusCode).toBe(200);
    expect((await workerRequest('POST', `/api/worker/capabilities/${versionId}/validation`, validation())).statusCode).toBe(200);
  });
  afterAll(async () => {
    for (const buyer of paymentBuyers) {
      const unfinished = await db.job.findMany({ where: { buyerId: buyer.id, state: { notIn: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] } } });
      for (const job of unfinished) await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: { ...jsonHeaders(), cookie: buyer.cookie }, payload: {} });
    }
    await app?.close();
    if (db) {
      await db.agentPlan.updateMany({ where: { userId: buyerId }, data: { state: 'CANCELLED' } });
      await db.capability.updateMany({ where: { id: capabilityId }, data: { visibility: 'PRIVATE', paused: true } });
      if (workerId) await db.workerDevice.updateMany({ where: { id: workerId }, data: { revokedAt: new Date() } });
      await db.apiKey.updateMany({ where: { userId: { in: paymentBuyers.map(buyer => buyer.id) } }, data: { revokedAt: new Date() } });
      await db.user.updateMany({ where: { id: { in: [buyerId, sellerId, ...paymentBuyers.map(buyer => buyer.id)] } }, data: { suspendedAt: new Date() } });
      await db.$disconnect();
    }
  });
  it('rejects cross-origin mutations and API keys cannot gain seller authority', async () => {
    const denied = await app.inject({ method: 'POST', url: '/api/wallet/topup', headers: { ...jsonHeaders(), origin: 'https://evil.example', cookie: buyerCookie, 'idempotency-key': randomUUID() }, payload: { amountMinor: 100 } });
    expect(denied.statusCode).toBe(403);
    const created = await app.inject({ method: 'POST', url: '/api/api-keys', headers: { ...jsonHeaders(), cookie: sellerCookie }, payload: { name: 'Buyer scope', scopes: ['jobs:read'] } });
    expect(created.statusCode).toBe(200);
    const seller = await app.inject({ method: 'GET', url: '/api/seller/workers', headers: { authorization: `Bearer ${created.json().secret}` } });
    expect(seller.statusCode).toBe(403);
    const publicCap = await app.inject({ url: `/api/capabilities/${capabilityId}` });
    expect(publicCap.json().schedule).toBeUndefined();
    expect(publicCap.json().permissions.inference.credentialRef).toBeUndefined();
    expect(publicCap.json().dependencies[0].grants).toBeUndefined();
  });
  it('rejects lower effective platform input limits before any job or wallet reservation exists', async () => {
    const previous = app.kivro.config.fileLimits.inputBytes;
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } });
    const jobs = await db.job.count({ where: { buyerId } });
    try {
      app.kivro.config.fileLimits.inputBytes = 4;
      const result = await purchase();
      expect(result.statusCode, result.body).toBe(413);
      expect(result.json().error.code).toBe('INPUT_TOO_LARGE');
      expect(await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } })).toEqual(wallet);
      expect(await db.job.count({ where: { buyerId } })).toBe(jobs);
    } finally { app.kivro.config.fileLimits.inputBytes = previous; }
  });
  it.each([
    { identity: 'session', balanceMinor: 0 }, { identity: 'session', balanceMinor: 98 },
    { identity: 'jobs:create API key', balanceMinor: 0 }, { identity: 'jobs:create API key', balanceMinor: 98 },
  ])('rejects $identity purchases with $balanceMinor cents without dispatch or financial side effects, then reserves 99 cents once funded', async ({ identity, balanceMinor }) => {
    const id = randomUUID(), key = randomUUID();
    const { passwordHash } = await db.user.findUniqueOrThrow({ where: { id: buyerId } });
    await db.user.create({ data: { id, name: 'Insufficient funds protocol buyer', email: `${id}@protocol.kivro.local`, passwordHash, wallet: { create: {} } } });
    const buyer = { id, cookie: '' }; paymentBuyers.push(buyer);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: jsonHeaders(), payload: { email: `${id}@protocol.kivro.local`, password: 'integration-password-123' } });
    expect(login.statusCode, login.body).toBe(200); buyer.cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const terms = (await app.inject('/api/terms')).json();
    expect((await app.inject({ method: 'POST', url: '/api/account/terms', headers: { ...jsonHeaders(), cookie: buyer.cookie }, payload: { version: terms.version } })).statusCode).toBe(200);
    let headers: Record<string, string> = { ...jsonHeaders(), cookie: buyer.cookie };
    const prefix = identity === 'session' ? '/api' : '/api/v1';
    if (identity !== 'session') {
      const created = await app.inject({ method: 'POST', url: '/api/api-keys', headers, payload: { name: 'Payment invariant fixture', scopes: ['jobs:create'] } });
      expect(created.statusCode, created.body).toBe(200); expect(created.json().scopes).toEqual(['jobs:create']);
      headers = { 'content-type': 'application/json', authorization: `Bearer ${created.json().secret}` };
    }
    if (balanceMinor) await db.$transaction(tx => creditWallet(tx, id, balanceMinor, `protocol:${id}:initial-credit`));
    const create = () => app.inject({ method: 'POST', url: `${prefix}/jobs`, headers: { ...headers, 'idempotency-key': key },
      payload: { capabilityId, input: { text: 'Synthetic payment invariant input' }, executionMode: 'NOW' } });
    const bucketKey = createHash('sha256').update(`account-purchases:${id}:${Math.floor(Date.now() / 86400_000)}`).digest('hex');
    const snapshot = async () => ({
      wallet: await db.wallet.findUniqueOrThrow({ where: { userId: id } }),
      ledger: await db.ledgerEntry.findMany({ where: { userId: id }, orderBy: { id: 'asc' } }),
      jobs: await db.job.count({ where: { buyerId: id } }),
      attempts: await db.jobAttempt.count({ where: { workerId } }),
      events: await db.jobEvent.count({ where: { job: { buyerId: id } } }),
      grants: await db.assetGrant.count({ where: { job: { buyerId: id } } }),
      idempotency: await db.idempotencyRecord.count({ where: { userId: id, endpoint: 'jobs' } }),
      purchaseQuota: await db.abuseBucket.findUnique({ where: { key: bucketKey } }),
      createdAudit: await db.auditEvent.count({ where: { actorId: id, type: 'JOB_CREATED' } }),
      capacity: await db.job.findMany({ where: { capabilityId, state: { notIn: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] } }, select: { id: true, state: true }, orderBy: { id: 'asc' } }),
    });
    const available = async () => {
      const response = await app.inject(`/api/capabilities/${capabilityId}`); expect(response.statusCode).toBe(200);
      const { status, canRunNow, canQueue } = response.json().availability;
      return { status, canRunNow, canQueue };
    };
    const cap = await db.capability.findUniqueOrThrow({ where: { id: capabilityId } });
    await db.capability.update({ where: { id: capabilityId }, data: { maxQueue: 0 } });
    let jobId: string | undefined;
    try {
      expect((await workerRequest('POST', '/api/worker/heartbeat', heartbeatBody)).statusCode).toBe(200);
      const beforeCapacity = await available();
      expect(beforeCapacity).toMatchObject({ status: 'ONLINE', canRunNow: true, canQueue: false });
      const before = await snapshot();
      expect(before).toMatchObject({ wallet: { availableMinor: balanceMinor, reservedMinor: 0, spentMinor: 0, earnedMinor: 0 }, jobs: 0, events: 0, grants: 0, idempotency: 0, purchaseQuota: null, createdAudit: 0, capacity: [] });
      for (let replay = 0; replay < 2; replay++) {
        const denied = await create();
        expect(denied.statusCode, denied.body).toBe(402);
        expect(denied.json()).toMatchObject({ error: { code: 'INSUFFICIENT_FUNDS' } });
        const offers = await workerRequest('GET', '/api/worker/offers');
        expect(offers.statusCode, offers.body).toBe(200); expect(offers.json().offers).toEqual([]);
        expect(await snapshot()).toEqual(before);
        expect(await available()).toEqual(beforeCapacity);
        expect(await db.ledgerEntry.count({ where: { userId: id, type: 'JOB_RESERVE' } })).toBe(0);
      }
      await db.$transaction(tx => creditWallet(tx, id, 99 - balanceMinor, `protocol:${id}:remaining-credit`));
      const created = await create(); expect(created.statusCode, created.body).toBe(201); jobId = created.json().id;
      expect(created.json()).toMatchObject({ state: 'QUEUED', paymentState: 'RESERVED' });
      const repeat = await create(); expect(repeat.statusCode, repeat.body).toBe(201); expect(repeat.json().id).toBe(jobId);
      expect(await db.wallet.findUniqueOrThrow({ where: { userId: id } })).toMatchObject({ availableMinor: 0, reservedMinor: 99, spentMinor: 0, earnedMinor: 0 });
      const ledger = await db.ledgerEntry.findMany({ where: { jobId } });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ operationKey: `job:${jobId}:reserve`, userId: id, jobId, type: 'JOB_RESERVE', currency: 'USD', amountMinor: 99, availableDelta: -99, reservedDelta: 99, spentDelta: 0, earnedDelta: 0 });
      expect(await db.job.count({ where: { buyerId: id } })).toBe(1);
      expect(await db.abuseBucket.findUniqueOrThrow({ where: { key: bucketKey } })).toMatchObject({ hits: 1, amountMinor: 99 });
      expect(await available()).toMatchObject({ status: 'BUSY', canRunNow: false, canQueue: false });
      const offers = await workerRequest('GET', '/api/worker/offers');
      expect(offers.statusCode, offers.body).toBe(200); expect(offers.json().offers).toHaveLength(1);
      const notice = offers.json().offers[0];
      expect(notice.payload).toMatchObject({ jobId, paymentSecured: true });
      expect(verify(null, Buffer.from(stableStringify(notice.payload)), serverPublicKey, Buffer.from(notice.signature, 'base64'))).toBe(true);
      const cancelled = await app.inject({ method: 'POST', url: `${prefix}/jobs/${jobId}/cancel`, headers, payload: {} });
      expect(cancelled.statusCode, cancelled.body).toBe(200); expect(cancelled.json().paymentState).toBe('RELEASED');
      expect(await db.wallet.findUniqueOrThrow({ where: { userId: id } })).toMatchObject({ availableMinor: 99, reservedMinor: 0, spentMinor: 0, earnedMinor: 0 });
      expect(await db.ledgerEntry.count({ where: { jobId, type: 'JOB_RELEASE' } })).toBe(1);
      expect(await available()).toEqual(beforeCapacity);
    } finally {
      if (jobId) await app.inject({ method: 'POST', url: `${prefix}/jobs/${jobId}/cancel`, headers, payload: {} });
      await db.capability.update({ where: { id: capabilityId }, data: { maxQueue: cap.maxQueue } });
    }
  });
  it('withholds buyer payload until acceptance, blocks replay, validates files and settles once', async () => {
    const key = randomUUID();
    const created = await purchase(key); expect(created.statusCode).toBe(201);
    const job = created.json();
    expect((await app.inject({ url: `/api/capabilities/${capabilityId}` })).json().availability).toMatchObject({ status: 'BUSY', canRunNow: false, canQueue: true });
    expect((await app.inject({ url: `/api/jobs/${job.id}`, headers: { cookie: sellerCookie } })).json().input).toEqual({});
    expect((await app.inject({ url: '/api/seller/jobs', headers: { cookie: sellerCookie } })).json().find((item: { id: string }) => item.id === job.id).input).toEqual({});
    const repeat = await purchase(key); expect(repeat.json().id).toBe(job.id);
    const conflict = await purchase(key, { text: 'Different data' }); expect(conflict.statusCode).toBe(409);
    const offers = await workerRequest('GET', '/api/worker/offers'); expect(offers.statusCode).toBe(200);
    expect(offers.json().offers).toHaveLength(1);
    const notice = offers.json().offers[0];
    expect(notice.payload.input).toBeUndefined(); expect(notice.payload.assets).toBeUndefined(); expect(notice.payload.internalInstructions).toBeUndefined();
    expect(verify(null, Buffer.from(stableStringify(notice.payload)), serverPublicKey, Buffer.from(notice.signature, 'base64'))).toBe(true);
    const path = `/api/worker/jobs/${job.id}/payload?attemptId=${notice.payload.attemptId}`;
    expect((await workerRequest('GET', path)).statusCode).toBe(403);
    const nonce = randomUUID();
    const acceptedBody = { attemptId: notice.payload.attemptId, type: 'ACCEPTED' };
    expect((await workerRequest('POST', `/api/worker/jobs/${job.id}/events`, acceptedBody, { nonce })).statusCode).toBe(200);
    expect((await workerRequest('POST', `/api/worker/jobs/${job.id}/events`, acceptedBody, { nonce })).statusCode).toBe(409);
    const payload = await workerRequest('GET', path); expect(payload.statusCode).toBe(200);
    expect(hashManifest(payload.json().payload)).toBe(notice.payload.payloadHash);
    expect(payload.json().payload.input.text).toContain('Private buyer text');
    expect(payload.json().payload.dependencies).toEqual(notice.payload.dependencies);
    expect(executionManifestHash(payload.json().payload)).toBe(manifestHash);
    expect((await app.inject({ url: `/api/jobs/${job.id}`, headers: { cookie: sellerCookie } })).json().input.text).toContain('Private buyer text');
    const early = await workerRequest('POST', `/api/worker/jobs/${job.id}/result`, { attemptId: notice.payload.attemptId, output: { text: 'Missing file' } });
    expect(early.statusCode).toBe(409);
    expect((await workerRequest('POST', `/api/worker/jobs/${job.id}/events`, { attemptId: notice.payload.attemptId, type: 'RUNNING' })).statusCode).toBe(200);
    const boundary = `test-${randomUUID()}`;
    const raw = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attemptId"\r\n\r\n${notice.payload.attemptId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="summary.md"\r\nContent-Type: text/markdown\r\n\r\n# Verified summary\n\r\n--${boundary}--\r\n`);
    const uploaded = await workerRequest('POST', `/api/worker/jobs/${job.id}/assets`, undefined, { nonce: randomUUID(), raw, contentType: `multipart/form-data; boundary=${boundary}` });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const output = { text: 'Verified summary', assets: [uploaded.json()] };
    for (let i = 0; i < 2; i++) expect((await workerRequest('POST', `/api/worker/jobs/${job.id}/result`, { attemptId: notice.payload.attemptId, output })).statusCode).toBe(200);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).paymentState).toBe('SETTLED');
    expect(await db.ledgerEntry.count({ where: { jobId: job.id, type: 'SELLER_EARNING' } })).toBe(1);
    const download = await app.inject({ url: `/api/assets/${uploaded.json().id}/download`, headers: { cookie: buyerCookie } });
    expect(download.statusCode).toBe(302);
    const denied = await app.inject({ url: `/api/assets/${uploaded.json().id}/download`, headers: { cookie: sellerCookie } });
    expect(denied.statusCode).toBe(404);
  });
  it('releases pre-execution cancellation and recovers an expired offer without another charge', async () => {
    const created = await purchase(); expect(created.statusCode).toBe(201);
    const job = created.json();
    const offers = await workerRequest('GET', '/api/worker/offers');
    const first = offers.json().offers[0].payload;
    await db.jobAttempt.update({ where: { id: first.attemptId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await reconcileJobs(app.kivro);
    const next = await workerRequest('GET', '/api/worker/offers');
    expect(next.json().offers[0].payload.attemptId).not.toBe(first.attemptId);
    expect(await db.ledgerEntry.count({ where: { jobId: job.id, type: 'JOB_RESERVE' } })).toBe(1);
    const cancelled = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: {} });
    expect(cancelled.statusCode).toBe(200); expect(cancelled.json().paymentState).toBe('RELEASED');
    const stale = await workerRequest('POST', `/api/worker/jobs/${job.id}/events`, { attemptId: first.attemptId, type: 'ACCEPTED' });
    expect(stale.statusCode).toBe(409);
  });
  it('finalizes direct Worker output only for the current live attempt and rejects revocation during scanning', async () => {
    const created = await purchase(); expect(created.statusCode).toBe(201);
    const job = created.json();
    const notice = (await workerRequest('GET', '/api/worker/offers')).json().offers[0].payload;
    const path = `/api/worker/jobs/${job.id}/uploads`;
    const bytes = Buffer.from('# Direct Worker result\n');
    const { createHash } = await import('node:crypto');
    const payload = { attemptId: notice.attemptId, filename: 'direct.md', mimeType: 'text/markdown', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    expect((await workerRequest('POST', path, payload)).statusCode).toBe(409);
    await workerRequest('POST', `/api/worker/jobs/${job.id}/events`, { attemptId: notice.attemptId, type: 'ACCEPTED' });
    await workerRequest('POST', `/api/worker/jobs/${job.id}/events`, { attemptId: notice.attemptId, type: 'RUNNING' });
    expect((await workerRequest('POST', path, { ...payload, attemptId: randomUUID() })).statusCode).toBe(409);
    const previousFileLimit = app.kivro.config.fileLimits.workerFileBytes;
    const previousOutputLimit = app.kivro.config.fileLimits.outputBytes;
    try {
      app.kivro.config.fileLimits.workerFileBytes = bytes.length - 1;
      expect((await workerRequest('POST', path, payload)).statusCode).toBe(413);
      app.kivro.config.fileLimits.workerFileBytes = previousFileLimit;
      app.kivro.config.fileLimits.outputBytes = bytes.length - 1;
      expect((await workerRequest('POST', path, payload)).statusCode).toBe(413);
      expect(await db.assetUpload.count({ where: { jobId: job.id } })).toBe(0);
    } finally { app.kivro.config.fileLimits.workerFileBytes = previousFileLimit; app.kivro.config.fileLimits.outputBytes = previousOutputLimit; }
    const ticketResponse = await workerRequest('POST', path, payload); expect(ticketResponse.statusCode, ticketResponse.body).toBe(201);
    const ticket = ticketResponse.json();
    expect((await fetch(ticket.uploadUrl, { method: 'PUT', headers: ticket.headers, body: bytes })).ok).toBe(true);
    const finish = () => workerRequest('POST', `${path}/${ticket.id}/finalize`, { attemptId: notice.attemptId });
    try {
      app.kivro.config.fileLimits.workerFileBytes = bytes.length - 1;
      expect((await finish()).statusCode).toBe(413);
      expect(await db.asset.count({ where: { jobId: job.id, kind: 'OUTPUT' } })).toBe(0);
    } finally { app.kivro.config.fileLimits.workerFileBytes = previousFileLimit; }
    const originalGet = app.kivro.storage.get.bind(app.kivro.storage);
    app.kivro.storage.get = async (...args) => {
      const result = await originalGet(...args);
      await db.workerDevice.update({ where: { id: workerId }, data: { revokedAt: new Date() } });
      return result;
    };
    try {
      const denied = await finish(); expect(denied.statusCode, denied.body).toBe(403);
      expect(await db.asset.count({ where: { jobId: job.id, kind: 'OUTPUT' } })).toBe(0);
    } finally {
      app.kivro.storage.get = originalGet;
      await db.workerDevice.update({ where: { id: workerId }, data: { revokedAt: null } });
    }
    const completed = await finish(); expect(completed.statusCode, completed.body).toBe(200);
    expect((await finish()).json()).toEqual(completed.json());
    await workerRequest('POST', `/api/worker/jobs/${job.id}/result`, { attemptId: notice.attemptId, output: { text: 'Direct Worker result', assets: [completed.json()] } });
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).paymentState).toBe('SETTLED');
  });
  it('atomically admits only available capacity and promotes scheduled jobs after eligibility', async () => {
    await db.capability.update({ where: { id: capabilityId }, data: { maxQueue: 0 } });
    const before = await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } });
    const attempts = await Promise.all([purchase(), purchase(), purchase()]);
    expect(attempts.filter(response => response.statusCode === 201)).toHaveLength(1);
    expect(attempts.filter(response => response.statusCode === 409), JSON.stringify(attempts.map(response => ({ status: response.statusCode, body: response.json() })))).toHaveLength(2);
    const after = await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } });
    expect(before.availableMinor - after.availableMinor).toBe(99);
    const job = attempts.find(response => response.statusCode === 201)!.json();
    await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: {} });
    const scheduled = await app.inject({ method: 'POST', url: '/api/jobs', headers: { ...jsonHeaders(), cookie: buyerCookie, 'idempotency-key': randomUUID() },
      payload: { capabilityId, input: { text: 'Scheduled protocol fixture' }, executionMode: 'SCHEDULED', scheduledAt: new Date(Date.now() + 60_000).toISOString() } });
    expect(scheduled.statusCode, scheduled.body).toBe(201); expect(scheduled.json().state).toBe('SCHEDULED');
    const original = scheduled.json().scheduledAt;
    expect(scheduled.json()).toMatchObject({ originalScheduledAt: original, eligibleAt: null, queuedAt: null });
    expect((await workerRequest('GET', '/api/worker/offers')).json().offers).toHaveLength(0);
    await db.job.update({ where: { id: scheduled.json().id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
    await reconcileJobs(app.kivro);
    const queued = await db.job.findUniqueOrThrow({ where: { id: scheduled.json().id } });
    expect(queued.state).toBe('QUEUED'); expect(queued.originalScheduledAt?.toISOString()).toBe(original);
    expect(queued.eligibleAt).not.toBeNull(); expect(queued.queuedAt).toEqual(queued.eligibleAt);
    await reconcileJobs(app.kivro);
    expect(await db.job.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ originalScheduledAt: queued.originalScheduledAt, eligibleAt: queued.eligibleAt, queuedAt: queued.queuedAt });
    await app.inject({ method: 'POST', url: `/api/jobs/${scheduled.json().id}/cancel`, headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: {} });
    await db.capability.update({ where: { id: capabilityId }, data: { maxQueue: 3 } });
  });
  it('keeps daily purchase ceilings transactional and excludes idempotent replays', async () => {
    const bucketKey = createHash('sha256').update(`account-purchases:${buyerId}:${Math.floor(Date.now() / 86400_000)}`).digest('hex');
    const prior = await db.abuseBucket.findUnique({ where: { key: bucketKey } });
    const previous = { hits: app.kivro.config.accountJobsPerDay, spend: app.kivro.config.accountJobSpendMinorPerDay };
    app.kivro.config.accountJobsPerDay = (prior?.hits ?? 0) + 1;
    app.kivro.config.accountJobSpendMinorPerDay = (prior?.amountMinor ?? 0) + 99;
    let jobId: string | undefined;
    try {
      const failed = await purchase(randomUUID(), {});
      expect(failed.statusCode, failed.body).toBe(400);
      expect(await db.abuseBucket.findUnique({ where: { key: bucketKey } })).toEqual(prior);
      const key = randomUUID(), created = await purchase(key);
      expect(created.statusCode, created.body).toBe(201); jobId = created.json().id;
      const charged = await db.abuseBucket.findUniqueOrThrow({ where: { key: bucketKey } });
      expect(charged).toMatchObject({ hits: (prior?.hits ?? 0) + 1, amountMinor: (prior?.amountMinor ?? 0) + 99 });
      const replay = await purchase(key); expect(replay.statusCode, replay.body).toBe(201); expect(replay.json().id).toBe(jobId);
      expect(await db.abuseBucket.findUnique({ where: { key: bucketKey } })).toEqual(charged);
      const denied = await purchase(); expect(denied.statusCode, denied.body).toBe(429); expect(denied.json().error.code).toBe('ACCOUNT_LIMIT');
      expect(await db.abuseBucket.findUnique({ where: { key: bucketKey } })).toEqual(charged);
      expect(await db.ledgerEntry.count({ where: { jobId, type: 'JOB_RESERVE' } })).toBe(1);
    } finally {
      app.kivro.config.accountJobsPerDay = previous.hits; app.kivro.config.accountJobSpendMinorPerDay = previous.spend;
      if (jobId) await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/cancel`, headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: {} });
    }
  });
  it('retains the original reservation promise when seller availability moves and notifies before full cancellation release', async () => {
    const before = await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } });
    const promised = new Date(Date.now() + 60_000).toISOString();
    const created = await app.inject({ method: 'POST', url: '/api/jobs', headers: { ...jsonHeaders(), cookie: buyerCookie, 'idempotency-key': randomUUID() },
      payload: { capabilityId, input: { text: 'Schedule-history acceptance fixture' }, executionMode: 'SCHEDULED', scheduledAt: promised } });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    try {
      const dates = [0, 1].map(days => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10));
      const schedule = { ...DEFAULT_SCHEDULE, overrides: dates.map(date => ({ date, available: false })) };
      const changed = await app.inject({ method: 'PUT', url: `/api/seller/capabilities/${capabilityId}/schedule`, headers: { ...jsonHeaders(), cookie: sellerCookie }, payload: { schedule } });
      expect(changed.statusCode, changed.body).toBe(200);
      await reconcileJobs(app.kivro);
      const job = await db.job.findUniqueOrThrow({ where: { id } });
      expect(job.originalScheduledAt?.toISOString()).toBe(promised); expect(job.scheduledAt!.getTime()).toBeGreaterThan(Date.parse(promised));
      expect(job).toMatchObject({ state: 'SCHEDULED', eligibleAt: null, queuedAt: null, startedAt: null, paymentState: 'RESERVED' });
      const events = await db.jobEvent.findMany({ where: { jobId: id, type: 'SCHEDULE_CHANGED' } });
      expect(events).toHaveLength(1); expect(events[0]!.metadata).toMatchObject({ previousScheduledAt: promised, originalScheduledAt: promised, scheduledAt: job.scheduledAt!.toISOString() });
      expect(await db.outboxEvent.findFirst({ where: { userId: buyerId, type: 'job.schedule_changed', payload: { path: ['jobId'], equals: id } } })).not.toBeNull();
      await reconcileJobs(app.kivro);
      expect(await db.jobEvent.count({ where: { jobId: id, type: 'SCHEDULE_CHANGED' } })).toBe(1);
      const cancelled = await app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: {} });
      expect(cancelled.statusCode, cancelled.body).toBe(200); expect(cancelled.json().paymentState).toBe('RELEASED');
      const after = await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } });
      expect(after.availableMinor).toBe(before.availableMinor); expect(after.reservedMinor).toBe(before.reservedMinor);
      expect(await db.ledgerEntry.count({ where: { jobId: id, type: 'JOB_RELEASE' } })).toBe(1);
    } finally {
      await app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: {} });
      await app.inject({ method: 'PUT', url: `/api/seller/capabilities/${capabilityId}/schedule`, headers: { ...jsonHeaders(), cookie: sellerCookie }, payload: { schedule: DEFAULT_SCHEDULE } });
    }
  });
  it('isolates buyer, seller and API-key burst limits on one source IP', async () => {
    const key = await app.inject({ method: 'POST', url: '/api/api-keys', headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: { name: 'Rate isolation fixture', scopes: ['jobs:read'] } });
    expect(key.statusCode).toBe(200);
    for (const headers of [{ cookie: buyerCookie }, { cookie: sellerCookie }, { authorization: `Bearer ${key.json().secret}` }]) {
      for (let i = 0; i < 2; i++) expect((await app.inject({ url: '/api/rate-identity-probe', headers })).statusCode).toBe(200);
      const limited = await app.inject({ url: '/api/rate-identity-probe', headers });
      expect(limited.statusCode).toBe(429); expect(limited.json().error.code).toBe('RATE_LIMITED');
    }
  });
  it('protects executed contracts and prices while restricting reviews to settled buyers', async () => {
    const job = await db.job.findFirstOrThrow({ where: { buyerId, capabilityVersionId: versionId, state: 'SUCCEEDED' } });
    await expect(db.capabilityVersion.update({ where: { id: versionId }, data: { internalInstructions: 'Changed after execution' } })).rejects.toThrow('immutable');
    await expect(db.job.update({ where: { id: job.id }, data: { input: { text: 'Rewritten historical input' } } })).rejects.toThrow('immutable');
    const review = () => app.inject({ method: 'POST', url: `/api/capabilities/${capabilityId}/reviews`, headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: { jobId: job.id, rating: 4, comment: 'Synthetic delivered-job review' } });
    expect((await review()).statusCode).toBe(200); expect((await review()).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/capabilities/${capabilityId}/reviews`, headers: { ...jsonHeaders(), cookie: sellerCookie }, payload: { jobId: job.id, rating: 5 } })).statusCode).toBe(403);
    for (const expected of [true, false]) expect((await app.inject({ method: 'POST', url: `/api/capabilities/${capabilityId}/favorite`, headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: {} })).json().isFavorite).toBe(expected);
    const invalid = await app.inject({ method: 'PUT', url: `/api/seller/capabilities/${capabilityId}`, headers: { ...jsonHeaders(), cookie: sellerCookie }, payload: {
      ioContract: { ...ioContract, output: { type: 'JSON', description: 'Unsafe schema', required: true, jsonSchema: { type: 'string', pattern: '(a+)+$' } } },
    } });
    expect(invalid.statusCode).toBe(400);
    expect((await db.capability.findUniqueOrThrow({ where: { id: capabilityId } })).draftVersionId).toBeNull();
  });
  it('never lets a generic heartbeat clear missing or failed manifest validation', async () => {
    const path = `/api/worker/capabilities/${versionId}/validation`;
    expect((await workerRequest('POST', path, { manifestHash, passed: true })).statusCode).toBe(400);
    expect((await workerRequest('POST', path, { manifestHash, passed: false })).statusCode).toBe(200);
    expect((await workerRequest('POST', '/api/worker/heartbeat', heartbeatBody)).statusCode).toBe(200);
    const binding = await db.workerBinding.findUniqueOrThrow({ where: { workerId_capabilityVersionId: { workerId, capabilityVersionId: versionId } } });
    expect(binding.healthy).toBe(false); expect(binding.validationStatus).toBe('FAILED');
    expect((await purchase()).statusCode).toBe(409);
    const expired = validation(); expired.proof.sandbox.testedAt -= 86401_000;
    expect((await workerRequest('POST', path, expired)).statusCode).toBe(409);
    expect((await workerRequest('POST', path, validation())).statusCode).toBe(200);
    expect((await db.workerBinding.findUniqueOrThrow({ where: { workerId_capabilityVersionId: { workerId, capabilityVersionId: versionId } } })).healthy).toBe(true);
  });
  it('resolves required named files from storage even without a top-level asset envelope', async () => {
    const namedVersionId = randomUUID();
    const namedContract: IOContract = { ...ioContract, output: { type: 'FILES', description: 'Named report', required: false, files: ioContract.output.files,
      fields: [{ key: 'report', label: 'Report', type: 'FILE', required: true, order: 0, constraints: { allowedMimeTypes: ['text/markdown'], allowedExtensions: ['.md'], maxFileSizeBytes: 1024 } }] } };
    const namedHash = executionManifestHash({ ioContract: namedContract, permissions, internalInstructions: instructions, dependencies });
    const original = await db.capabilityVersion.findUniqueOrThrow({ where: { id: versionId } });
    await db.capabilityVersion.create({ data: { ...original, publicationEvidence: undefined, id: namedVersionId, version: 2, ioContract: json(namedContract), permissions: json(permissions), dependencies: json(dependencies), examples: [], manifestHash: namedHash } });
    await db.capability.update({ where: { id: capabilityId }, data: { currentVersionId: namedVersionId } });
    await workerRequest('POST', '/api/worker/heartbeat', { ...heartbeatBody, capabilities: [versionId, namedVersionId] });
    expect((await workerRequest('POST', `/api/worker/capabilities/${namedVersionId}/validation`, { ...validation(), manifestHash: namedHash })).statusCode).toBe(200);
    const created = await purchase(); expect(created.statusCode, created.body).toBe(201);
    const jobId = created.json().id;
    const notice = (await workerRequest('GET', '/api/worker/offers')).json().offers[0].payload;
    for (const type of ['ACCEPTED', 'RUNNING']) expect((await workerRequest('POST', `/api/worker/jobs/${jobId}/events`, { attemptId: notice.attemptId, type })).statusCode).toBe(200);
    const invalid = await workerRequest('POST', `/api/worker/jobs/${jobId}/result`, { attemptId: notice.attemptId, output: { fields: { report: randomUUID() } } });
    expect(invalid.statusCode).toBe(400);
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).paymentState).toBe('RESERVED');
    const boundary = `named-${randomUUID()}`;
    const raw = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attemptId"\r\n\r\n${notice.attemptId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="named.md"\r\nContent-Type: text/markdown\r\n\r\n# Named output\n\r\n--${boundary}--\r\n`);
    const uploaded = await workerRequest('POST', `/api/worker/jobs/${jobId}/assets`, undefined, { nonce: randomUUID(), raw, contentType: `multipart/form-data; boundary=${boundary}` });
    expect(uploaded.statusCode).toBe(201);
    const valid = await workerRequest('POST', `/api/worker/jobs/${jobId}/result`, { attemptId: notice.attemptId, output: { fields: { report: uploaded.json().id } } });
    expect(valid.statusCode, valid.body).toBe(200);
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).paymentState).toBe('SETTLED');
    await db.capability.update({ where: { id: capabilityId }, data: { currentVersionId: versionId } });
  });
  it('repairs persisted plans without losing completed work or budget and polls beyond twenty waiting plans', async () => {
    const { agentPlanResponseSchema } = await import('@kivro/contracts/responses');
    const completed = await db.job.findFirstOrThrow({ where: { buyerId, capabilityVersionId: versionId, state: 'SUCCEEDED' } });
    const cap = (await app.inject({ url: `/api/capabilities/${capabilityId}` })).json();
    const quoted = await app.inject({ method: 'POST', url: `/api/capabilities/${capabilityId}/quote`, headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: { executionMode: 'NOW' } });
    expect(quoted.statusCode).toBe(200);
    const quoteBody = quoted.json();
    // The public quote contains priceSnapshot; internal AgentQuote has a separate exact DTO.
    const quote: OrchestrationPlan['steps'][number]['quote'] = { id: quoteBody.id,
      expiresAt: quoteBody.expiresAt, earliestStartAt: quoteBody.earliestStartAt, estimatedDeliveryAt: quoteBody.estimatedDeliveryAt,
      capabilityId, capabilityVersionId: versionId, amountMinor: 99 };
    const stepId = randomUUID(), pendingStepId = randomUUID(), now = new Date().toISOString();
    const plan: OrchestrationPlan = { id: `ffffffff-ffff-4fff-8fff-${buyerId.slice(0, 8)}ffff`, userId: buyerId, goal: 'Preserve the delivered summary and repair its next step', revision: 5,
      constraints: { maxTotalSpendMinor: 198, maxPerJobSpendMinor: 99, maxJobs: 3, blockedSellers: [], noNetwork: true }, timing: { mode: 'IMMEDIATE', maxQueueWaitSeconds: 0 },
      steps: [
        { id: stepId, capabilityId, capabilityVersionId: versionId, dependsOn: [], inputMapping: [{ kind: 'literal', targetInput: 'text', value: 'Completed input' }],
          quote, contractSnapshot: ioContract, capabilityDefinitionHash: capabilityDefinitionHash(cap), status: 'COMPLETED', jobId: completed.id, output: completed.output as OrchestrationPlan['steps'][number]['output'] },
        { id: pendingStepId, capabilityId, capabilityVersionId: versionId, dependsOn: [stepId], inputMapping: [{ kind: 'output', sourceStepId: stepId, targetInput: 'text', pointer: '/text' }],
          quote, contractSnapshot: ioContract, capabilityDefinitionHash: capabilityDefinitionHash(cap), status: 'SKIPPED' },
      ], estimatedCostMinor: 198, estimatedCompletionAt: quote.estimatedDeliveryAt, status: 'FAILED', createdAt: now, updatedAt: now };
    plan.approval = { userId: buyerId, approvedAt: now, planHash: planApprovalHash(plan) };
    expect(() => agentPlanResponseSchema.parse(JSON.parse(JSON.stringify(plan)))).not.toThrow();
    await db.agentPlan.create({ data: { id: plan.id, userId: buyerId, state: plan.status, plan: json(plan), jobIds: [completed.id] } });
    const post = (action: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/agent/plans/${plan.id}/${action}`, headers: { ...jsonHeaders(), cookie: buyerCookie }, payload });
    const repairs = await Promise.all([post('repair', { expectedRevision: 5, reason: 'Retry the unavailable second step', replacements: [{ stepId: pendingStepId, capabilityId, capabilityVersionId: versionId }] }),
      post('repair', { expectedRevision: 5, reason: 'Concurrent stale repair', replacements: [{ stepId: pendingStepId, capabilityId, capabilityVersionId: versionId }] })]);
    expect(repairs.map(response => response.statusCode).sort(), repairs.map(response => response.body).join('\n')).toEqual([200, 409]);
    const repaired = repairs.find(response => response.statusCode === 200)!.json() as OrchestrationPlan;
    expect(repaired).toMatchObject({ revision: 6, status: 'AWAITING_APPROVAL', estimatedCostMinor: 198 });
    expect(repaired.approval).toBeUndefined(); expect(repaired.steps[0]).toEqual(plan.steps[0]);
    expect(repaired.retainedWork).toEqual([{ stepId, jobId: completed.id, outputHash: hashManifest(completed.output) }]);
    expect(repaired.repairHistory?.[0]).toMatchObject({ committedSpendMinor: 99, remainingBudgetMinor: 99 });
    expect((await db.agentPlan.findUniqueOrThrow({ where: { id: plan.id } })).jobIds).toEqual([completed.id]);
    expect((await post('approve', { expectedRevision: 5 })).statusCode).toBe(409);
    expect((await post('approve', { expectedRevision: 6 })).statusCode).toBe(200);
    const waitingIds: string[] = [];
    for (let index = 0; index < 20; index++) {
      const id = `00000000-0000-4000-8000-${buyerId.slice(0, 8)}${index.toString(16).padStart(4, '0')}`; waitingIds.push(id);
      await db.agentPlan.create({ data: { id, userId: buyerId, state: 'RUNNING', plan: json({ ...plan, id, status: 'RUNNING', approval: undefined }), jobIds: [] } });
    }
    try {
      await db.platformSetting.upsert({ where: { key: 'agent-plan-poll-cursor' }, create: { key: 'agent-plan-poll-cursor', value: '' }, update: { value: '' } });
      await app.kivro.tickPlans!(); await app.kivro.tickPlans!();
      const executed = await db.agentPlan.findUniqueOrThrow({ where: { id: plan.id } });
      expect(executed.jobIds).toHaveLength(2); expect(executed.jobIds).toContain(completed.id);
      const boughtId = executed.jobIds.find(id => id !== completed.id)!;
      const bought = await db.job.findUniqueOrThrow({ where: { id: boughtId } });
      expect(bought.input).toEqual({ text: (completed.output as { text: string }).text });
      expect((await db.job.aggregate({ where: { id: { in: executed.jobIds }, paymentState: { in: ['SETTLED', 'RESERVED'] } }, _sum: { buyerPriceMinor: true } }))._sum.buyerPriceMinor).toBe(198);
      const activePlan = executed.plan as unknown as OrchestrationPlan;
      const blocked = await post('repair', { expectedRevision: activePlan.revision, reason: 'Must not replace paid running work', replacements: [{ stepId: pendingStepId, capabilityId, capabilityVersionId: versionId }] });
      expect(blocked.statusCode).toBe(409); expect(blocked.json().error.code).toBe('ACTIVE_JOBS_PREVENT_REPAIR');
      await app.kivro.tickPlans!(); await app.kivro.tickPlans!();
      expect((await db.agentPlan.findUniqueOrThrow({ where: { id: plan.id } })).jobIds).toHaveLength(2);
      const busy = (await app.inject({ url: `/api/capabilities/${capabilityId}` })).json();
      expect(busy.availability.canQueue).toBe(true); expect(busy.availability.estimatedQueueWaitSeconds).toBeGreaterThan(0);
      const queuedStepId = randomUUID();
      const queued: OrchestrationPlan = { ...plan, id: randomUUID(), revision: 0, approval: undefined, status: 'AWAITING_APPROVAL',
        constraints: { ...plan.constraints, maxTotalSpendMinor: 99 }, timing: { mode: 'IMMEDIATE', maxQueueWaitSeconds: 1800 }, estimatedCostMinor: 99,
        steps: [{ ...plan.steps[1]!, id: queuedStepId, dependsOn: [], status: 'PLANNED', inputMapping: [{ kind: 'literal', targetInput: 'text', value: 'Explicit bounded queue approval' }] }] };
      await db.agentPlan.create({ data: { id: queued.id, userId: buyerId, state: queued.status, plan: json(queued), jobIds: [] } });
      waitingIds.push(queued.id);
      // Repair obtains its new quote through the actual agent catalog adapter,
      // exercising NOW queue consent instead of silently switching to scheduling.
      const queuedRepair = await app.inject({ method: 'POST', url: `/api/agent/plans/${queued.id}/repair`, headers: { ...jsonHeaders(), cookie: buyerCookie },
        payload: { expectedRevision: 0, reason: 'Approve bounded queued execution', replacements: [{ stepId: queuedStepId, capabilityId, capabilityVersionId: versionId }] } });
      expect(queuedRepair.statusCode, queuedRepair.body).toBe(200);
      const queuedQuote = queuedRepair.json().steps[0].quote;
      expect((await db.scheduleQuote.findUniqueOrThrow({ where: { id: queuedQuote.id } })).executionMode).toBe('NOW');
      expect(Date.parse(queuedQuote.earliestStartAt)).toBeGreaterThan(Date.now());
      const queueApproval = await app.inject({ method: 'POST', url: `/api/agent/plans/${queued.id}/approve`, headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: { expectedRevision: 1 } });
      expect(queueApproval.statusCode, queueApproval.body).toBe(200);
      await app.kivro.tickPlans!(); await app.kivro.tickPlans!();
      const queueRecord = await db.agentPlan.findUniqueOrThrow({ where: { id: queued.id } });
      expect(queueRecord.jobIds).toHaveLength(1);
      expect(await db.job.findUniqueOrThrow({ where: { id: queueRecord.jobIds[0]! } })).toMatchObject({ state: 'QUEUED', executionMode: 'NOW', paymentState: 'RESERVED' });
      await app.inject({ method: 'POST', url: `/api/jobs/${queueRecord.jobIds[0]}/cancel`, headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: {} });
      await app.inject({ method: 'POST', url: `/api/jobs/${boughtId}/cancel`, headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: {} });
    } finally { await db.agentPlan.updateMany({ where: { id: { in: [plan.id, ...waitingIds] } }, data: { state: 'CANCELLED' } }); }
    expect(await db.auditEvent.count({ where: { actorId: buyerId, type: 'PLAN_REPAIRED', metadata: { path: ['planId'], equals: plan.id } } })).toBe(1);
  });
  it('refuses an old plan revision at the locked purchase boundary without reserving funds', async () => {
    await workerRequest('POST', '/api/worker/heartbeat', heartbeatBody);
    const cap = (await app.inject({ url: `/api/capabilities/${capabilityId}` })).json();
    const response = await app.inject({ method: 'POST', url: `/api/capabilities/${capabilityId}/quote`, headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: { executionMode: 'NOW' } });
    expect(response.statusCode, response.body).toBe(200);
    const quoted = response.json();
    const quote = { id: quoted.id, expiresAt: quoted.expiresAt, earliestStartAt: quoted.earliestStartAt, estimatedDeliveryAt: quoted.estimatedDeliveryAt,
      capabilityId, capabilityVersionId: versionId, amountMinor: 99 };
    const stepId = randomUUID(), now = new Date().toISOString();
    const plan: OrchestrationPlan = { id: randomUUID(), userId: buyerId, goal: 'Verify exact approved revision at purchase', revision: 0,
      constraints: { maxTotalSpendMinor: 99, maxPerJobSpendMinor: 99, maxJobs: 1, blockedSellers: [], noNetwork: true }, timing: { mode: 'IMMEDIATE', maxQueueWaitSeconds: 0 },
      steps: [{ id: stepId, capabilityId, capabilityVersionId: versionId, dependsOn: [], inputMapping: [{ kind: 'literal', targetInput: 'text', value: 'Revision race regression' }],
        quote, contractSnapshot: ioContract, capabilityDefinitionHash: capabilityDefinitionHash(cap), status: 'PLANNED' }],
      estimatedCostMinor: 99, estimatedCompletionAt: quote.estimatedDeliveryAt, status: 'AWAITING_APPROVAL', createdAt: now, updatedAt: now };
    await db.agentPlan.create({ data: { id: plan.id, userId: buyerId, state: plan.status, plan: json(plan), jobIds: [] } });
    const approved = await app.inject({ method: 'POST', url: `/api/agent/plans/${plan.id}/approve`, headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: { expectedRevision: 0 } });
    expect(approved.statusCode, approved.body).toBe(200);
    const before = await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } });
    const key = `orchestration:${plan.id}:${stepId}`;
    const original = app.kivro.db;
    let raced = false;
    // Advance the persisted revision after execution's read, before createJob's
    // actual transaction. No purchase, ledger or transaction functions are mocked.
    app.kivro.db = new Proxy(db, { get(target, property) {
      if (property === 'agentPlan') return { ...target.agentPlan, async findFirst(args: Parameters<typeof db.agentPlan.findFirst>[0]) {
        const row = await db.agentPlan.findFirst(args);
        if (row?.id === plan.id && row.state === 'RUNNING' && !raced) {
          raced = true; const current = row.plan as unknown as OrchestrationPlan;
          await db.agentPlan.update({ where: { id: plan.id }, data: { plan: json({ ...current, revision: current.revision + 1 }) } });
        }
        return row;
      } };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      await db.platformSetting.upsert({ where: { key: 'agent-plan-poll-cursor' }, create: { key: 'agent-plan-poll-cursor', value: '' }, update: { value: '' } });
      await app.kivro.tickPlans!();
      expect(raced).toBe(true);
      const rejected = await db.agentPlan.findUniqueOrThrow({ where: { id: plan.id } });
      expect(rejected.jobIds).toEqual([]); expect((rejected.plan as { revision: number }).revision).toBe(3);
      expect(await db.idempotencyRecord.findUnique({ where: { userId_endpoint_key: { userId: buyerId, endpoint: 'jobs', key } } })).toBeNull();
      expect(await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } })).toEqual(before);
      app.kivro.db = original;
      await app.kivro.tickPlans!(); await app.kivro.tickPlans!();
      const executed = await db.agentPlan.findUniqueOrThrow({ where: { id: plan.id } });
      expect(executed.jobIds).toHaveLength(1);
      expect(await db.ledgerEntry.count({ where: { jobId: executed.jobIds[0], type: 'JOB_RESERVE' } })).toBe(1);
    } finally {
      app.kivro.db = original;
      const row = await db.agentPlan.findUniqueOrThrow({ where: { id: plan.id } });
      for (const jobId of row.jobIds) await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/cancel`, headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: {} });
      await db.agentPlan.update({ where: { id: plan.id }, data: { state: 'CANCELLED' } });
    }
  });
  it('keeps unsupported file formats in drafts but denies publication and successful worker validation', async () => {
    const officeContract: IOContract = { ...ioContract, inputs: [...ioContract.inputs, { key: 'office', label: 'Office document', type: 'FILE', required: false, order: 2,
      constraints: { allowedExtensions: ['.pdf', '.docx'], allowedMimeTypes: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], maxFileSizeBytes: 1024 } }] };
    const draft = await app.inject({ method: 'PUT', url: `/api/seller/capabilities/${capabilityId}`, headers: { ...jsonHeaders(), cookie: sellerCookie }, payload: { ioContract: officeContract } });
    expect(draft.statusCode, draft.body).toBe(200);
    try {
      const version = await db.capabilityVersion.findUniqueOrThrow({ where: { id: draft.json().versionId } });
      const publish = await app.inject({ method: 'POST', url: `/api/seller/capabilities/${capabilityId}/publish`, headers: { ...jsonHeaders(), cookie: sellerCookie }, payload: { visibility: 'PUBLIC' } });
      expect(publish.statusCode).toBe(409); expect(publish.json().error.code).toBe('UNSUPPORTED_RUNTIME_CONTRACT');
      const validationResponse = await workerRequest('POST', `/api/worker/capabilities/${version.id}/validation`, { ...validation(), manifestHash: version.manifestHash });
      expect(validationResponse.statusCode).toBe(409); expect(validationResponse.json().error.code).toBe('UNSUPPORTED_RUNTIME_CONTRACT');
      expect((await db.capabilityVersion.findUniqueOrThrow({ where: { id: version.id } })).publishedAt).toBeNull();
    } finally { await db.capability.update({ where: { id: capabilityId }, data: { draftVersionId: null } }); }
  });
  it('rechecks current Connect status and the exact validated binding at acceptance', async () => {
    const key = { workerId_capabilityVersionId: { workerId, capabilityVersionId: versionId } };
    const original = await db.workerBinding.findUniqueOrThrow({ where: key });
    const cases = ['connect', 'unhealthy', 'failed', 'expired', 'hash', 'missing'] as const;
    for (const mode of cases) {
      await workerRequest('POST', '/api/worker/heartbeat', heartbeatBody);
      const created = await purchase(); expect(created.statusCode, created.body).toBe(201);
      const jobId = created.json().id;
      const notice = (await workerRequest('GET', '/api/worker/offers')).json().offers[0].payload;
      try {
        if (mode === 'connect') {
          app.kivro.config.paymentMode = 'stripe';
          await db.user.update({ where: { id: sellerId }, data: { connectStatus: 'ACTION_REQUIRED' } });
        } else if (mode === 'missing') await db.workerBinding.delete({ where: key });
        else await db.workerBinding.update({ where: key, data: mode === 'unhealthy' ? { healthy: false } : mode === 'failed' ? { validationStatus: 'FAILED' } : mode === 'expired' ? { validatedAt: new Date(Date.now() - 86401_000) } : { validatedManifestHash: 'c'.repeat(64) } });
        const response = await workerRequest('POST', `/api/worker/jobs/${jobId}/events`, { attemptId: notice.attemptId, type: 'ACCEPTED' });
        expect(response.statusCode, `${mode}: ${response.body}`).toBe(409); expect(response.json().error.code).toBe('ACCEPTANCE_BLOCKED');
        expect((await db.jobAttempt.findUniqueOrThrow({ where: { id: notice.attemptId } })).acceptedAt).toBeNull();
        expect((await workerRequest('GET', `/api/worker/jobs/${jobId}/payload?attemptId=${notice.attemptId}`)).statusCode).toBe(403);
        expect((await app.inject({ url: `/api/jobs/${jobId}`, headers: { cookie: sellerCookie } })).json().input).toEqual({});
      } finally {
        app.kivro.config.paymentMode = 'fake';
        await db.workerBinding.upsert({ where: key, create: { ...original, validationProof: json(original.validationProof) }, update: { ...original, validationProof: json(original.validationProof) } });
        await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/cancel`, headers: { ...jsonHeaders(), cookie: buyerCookie }, payload: {} });
      }
    }
  });
  it('enforces acceptance and device revocation for private input payloads and file bytes', async () => {
    const boundary = `input-${randomUUID()}`;
    const raw = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private.md"\r\nContent-Type: text/markdown\r\n\r\n# Private buyer file\n\r\n--${boundary}--\r\n`);
    const upload = await app.inject({ method: 'POST', url: '/api/assets/upload', headers: { ...jsonHeaders(), cookie: buyerCookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: raw });
    expect(upload.statusCode, upload.body).toBe(201);
    const job = await purchase(randomUUID(), { text: 'Private input document', document: upload.json().id }); expect(job.statusCode).toBe(201);
    const notice = (await workerRequest('GET', '/api/worker/offers')).json().offers[0].payload;
    const filePath = `/api/worker/assets/${upload.json().id}/download`, payloadPath = `/api/worker/jobs/${job.json().id}/payload?attemptId=${notice.attemptId}`;
    expect((await workerRequest('GET', filePath)).statusCode).toBe(404);
    await workerRequest('POST', `/api/worker/jobs/${job.json().id}/events`, { attemptId: notice.attemptId, type: 'ACCEPTED' });
    expect((await workerRequest('GET', filePath)).body).toContain('Private buyer file');
    expect((await workerRequest('GET', payloadPath)).statusCode).toBe(200);
    const revoked = await app.inject({ method: 'POST', url: `/api/seller/workers/${workerId}/revoke`, headers: { ...jsonHeaders(), cookie: sellerCookie }, payload: {} });
    expect(revoked.statusCode).toBe(200);
    expect((await workerRequest('GET', payloadPath)).statusCode).toBe(401);
    expect((await workerRequest('GET', filePath)).statusCode).toBe(401);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.json().id } })).paymentState).toBe('RELEASED');
  });
});
