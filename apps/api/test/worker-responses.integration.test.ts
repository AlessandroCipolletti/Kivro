import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient, json, serializable } from '@kivro/database';
import { creditWallet } from '@kivro/billing';
import { DEFAULT_SCHEDULE, SignedJobOfferSchema, executionManifestHash, stableStringify } from '@kivro/contracts';
import { ADAPTER_POLICY_VERSION } from '@kivro/openclaw-adapter';
import { workerOffersResponseSchema, workerResponseRoutes } from '../../../packages/contracts/src/response-worker.ts';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';
import { canonicalWorkerRequest } from '../src/worker.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('Worker response schemas against actual routes (isolated PostgreSQL)', () => {
  let db: PrismaClient, app: FastifyInstance;
  const schema = `worker_responses_${randomBytes(8).toString('hex')}`, origin = 'http://localhost:3000';
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
      if (!/^worker_responses_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe test schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await db.$disconnect();
    }
  });

  it('validates all fifteen success projections, signed notices/payloads, lifecycle commands, ISO history and usage', async () => {
    const sellerId = randomUUID(), buyerId = randomUUID(), sellerToken = randomUUID(), buyerToken = randomUUID();
    for (const [id, token] of [[sellerId, sellerToken], [buyerId, buyerToken]] as const) await db.user.create({ data: {
      id, email: `${id}@response.kivro.local`, name: 'Response fixture', passwordHash: 'disabled', wallet: { create: {} },
      sessions: { create: { tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + 600000) } },
    } });
    const sellerHeaders = { origin, cookie: `kivro_session=${sellerToken}` }, buyerHeaders = { origin, cookie: `kivro_session=${buyerToken}` };
    const seen = new Set<string>();
    function validate(method: string, path: string, response: { statusCode: number; body: string; json(): unknown }) {
      expect(response.statusCode, response.body).toBe(200);
      const descriptor = workerResponseRoutes.find(route => route.method === method && route.path === path);
      expect(descriptor, `${method} ${path}`).toBeDefined(); seen.add(`${method} ${path}`);
      const wire = response.json(); expect(descriptor!.schema.parse(wire)).toEqual(wire); return wire;
    }
    const pairing = await app.inject({ method: 'POST', url: '/api/seller/pairing-code', headers: sellerHeaders, payload: {} });
    validate('POST', '/api/seller/pairing-code', pairing);
    const keys = generateKeyPairSync('ed25519');
    const paired = await app.inject({ method: 'POST', url: '/api/worker/pair', payload: { code: pairing.json().code,
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), name: 'Response worker', version: '0.1.0' } });
    validate('POST', '/api/worker/pair', paired);
    const { workerId, serverPublicKey } = paired.json() as { workerId: string; serverPublicKey: string };
    const signed = (method: 'GET' | 'POST', url: string, body?: unknown) => {
      const timestamp = String(Date.now()), nonce = randomUUID(), raw = body === undefined ? '' : JSON.stringify(body);
      return app.inject({ method, url, ...(body === undefined ? {} : { payload: raw }), headers: { 'content-type': 'application/json', 'x-worker-id': workerId,
        'x-worker-timestamp': timestamp, 'x-worker-nonce': nonce,
        'x-worker-signature': sign(null, Buffer.from(canonicalWorkerRequest(method, url.split('?')[0]!, timestamp, nonce, Buffer.from(raw))), keys.privateKey).toString('base64') } });
    };
    const initial = await app.inject({ url: '/api/seller/workers', headers: sellerHeaders });
    validate('GET', '/api/seller/workers', initial);
    expect(initial.json()[0]).toMatchObject({ id: workerId, lastSeenAt: null, openclawVersion: null, revokedAt: null, bindings: [], healthHistory: [] });
    expect(initial.json()[0]).not.toHaveProperty('publicKey'); expect(initial.json()[0]).not.toHaveProperty('sellerId');
    const cap = await db.capability.create({ data: { sellerId, slug: randomUUID(), visibility: 'PUBLIC', schedule: DEFAULT_SCHEDULE } });
    const manifest = { ioContract: { schemaVersion: 1, inputs: [{ key: 'text', label: 'Text', type: 'LONG_TEXT', required: true, order: 0 }], output: { type: 'TEXT', description: 'Result', required: true } },
      permissions: { schemaVersion: 1, tools: [], network: { mode: 'NONE', allowedDomains: [] }, resources: [], inference: { provider: 'openai-compatible', model: 'test' },
        limits: { timeoutSeconds: 300, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 1024, maxOutputBytes: 1024, maxTokens: 1000 } },
      dependencies: [{ id: 'inference', name: 'Dedicated inference', type: 'INFERENCE', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { inferenceProviders: ['openai-compatible'] } }], internalInstructions: 'Synthetic response fixture' };
    const version = await db.capabilityVersion.create({ data: { capabilityId: cap.id, version: 1, title: 'Response fixture', summary: 'Synthetic response case', description: '', category: 'Writing & documents', tags: [], priceTierId: 'USD_99',
      ...manifest, ioContract: json(manifest.ioContract), permissions: json(manifest.permissions), dependencies: json(manifest.dependencies), manifestHash: executionManifestHash(manifest), publishedAt: new Date() } });
    await db.capability.update({ where: { id: cap.id }, data: { currentVersionId: version.id } });
    const heartbeat = { version: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)', sandboxReady: true, paused: false,
      capabilities: [version.id], runningJobIds: [], health: { ready: true } };
    validate('POST', '/api/worker/heartbeat', await signed('POST', '/api/worker/heartbeat', heartbeat));
    for (const path of ['/api/worker/diagnostics', '/api/worker/diagnostics/v2']) validate('GET', path, await signed('GET', path));
    const validated = await signed('POST', `/api/worker/capabilities/${version.id}/validation`, { manifestHash: version.manifestHash, passed: true,
      proof: { sandbox: { imageId: `sha256:${'a'.repeat(64)}`, policyVersion: ADAPTER_POLICY_VERSION, testedAt: Date.now() },
        inference: { configHash: 'b'.repeat(64), testedAt: Date.now() } } });
    validate('POST', '/api/worker/capabilities/:versionId/validation', validated);
    await serializable(db, tx => creditWallet(tx, buyerId, 99, `response-funding:${buyerId}`));
    const terms = (await app.inject('/api/terms')).json();
    expect((await app.inject({ method: 'POST', url: '/api/account/terms', headers: buyerHeaders, payload: { version: terms.version } })).statusCode).toBe(200);
    const created = await app.inject({ method: 'POST', url: '/api/jobs', headers: { ...buyerHeaders, 'idempotency-key': randomUUID() },
      payload: { capabilityId: cap.id, input: { text: 'Synthetic private buyer text' }, executionMode: 'NOW' } });
    expect(created.statusCode, created.body).toBe(201); const jobId = created.json().id as string;
    const offers = await signed('GET', '/api/worker/offers'); validate('GET', '/api/worker/offers', offers);
    const notice = offers.json().offers[0];
    expect(notice.payload).not.toHaveProperty('input'); expect(notice.payload).not.toHaveProperty('internalInstructions'); expect(notice.payload).not.toHaveProperty('assets');
    expect(verify(null, Buffer.from(stableStringify(notice.payload)), serverPublicKey, Buffer.from(notice.signature, 'base64'))).toBe(true);
    const parsedNotice = workerOffersResponseSchema.parse(offers.json()).offers[0]!;
    expect(stableStringify(parsedNotice.payload)).toBe(stableStringify(notice.payload));
    expect(verify(null, Buffer.from(stableStringify(parsedNotice.payload)), serverPublicKey, Buffer.from(parsedNotice.signature, 'base64'))).toBe(true);
    const attemptId = notice.payload.attemptId as string;
    validate('POST', '/api/worker/jobs/:id/events', await signed('POST', `/api/worker/jobs/${jobId}/events`, { attemptId, type: 'ACCEPTED' }));
    const payload = await signed('GET', `/api/worker/jobs/${jobId}/payload?attemptId=${attemptId}`);
    validate('GET', '/api/worker/jobs/:id/payload', payload);
    expect(payload.json().payload.input).toEqual({ text: 'Synthetic private buyer text' });
    expect(verify(null, Buffer.from(stableStringify(payload.json().payload)), serverPublicKey, Buffer.from(payload.json().signature, 'base64'))).toBe(true);
    const parsedPayload = SignedJobOfferSchema.parse(payload.json());
    expect(stableStringify(parsedPayload.payload)).toBe(stableStringify(payload.json().payload));
    expect(verify(null, Buffer.from(stableStringify(parsedPayload.payload)), serverPublicKey, Buffer.from(parsedPayload.signature, 'base64'))).toBe(true);
    validate('POST', '/api/worker/jobs/:id/events', await signed('POST', `/api/worker/jobs/${jobId}/events`, { attemptId, type: 'RUNNING' }));
    validate('POST', '/api/worker/jobs/:id/result', await signed('POST', `/api/worker/jobs/${jobId}/result`, { attemptId, output: { text: 'Synthetic response result' } }));
    validate('POST', '/api/worker/jobs/:id/usage', await signed('POST', `/api/worker/jobs/${jobId}/usage`, { attemptId, provider: 'openai-compatible', model: 'test',
      attemptedCalls: 1, successfulCalls: 1, unpricedCalls: 0, inputTokens: 10, outputTokens: 5, estimatedCostMicroUsd: 1, reservedCostMicroUsd: 2, costBasis: 'WORKER_CONFIGURED_RATES' }));
    for (const action of ['pause', 'resume', 'revoke']) {
      validate('POST', `/api/seller/workers/:id/${action}`, await app.inject({ method: 'POST', url: `/api/seller/workers/${workerId}/${action}`, headers: sellerHeaders, payload: {} }));
      if (action !== 'revoke') {
        const response = await signed('POST', '/api/worker/heartbeat', heartbeat); validate('POST', '/api/worker/heartbeat', response);
        if (action === 'pause') expect(response.json().commands).toEqual([expect.objectContaining({ type: 'PAUSE_ALL' })]);
      }
    }
    const final = await app.inject({ url: '/api/seller/workers', headers: sellerHeaders }); validate('GET', '/api/seller/workers', final);
    expect(final.json()[0].healthHistory.length).toBeGreaterThan(0); expect(final.json()[0].revokedAt).toEqual(expect.any(String));
    expect(seen).toEqual(new Set(workerResponseRoutes.map(route => `${route.method} ${route.path}`)));
    expect(await db.ledgerEntry.count({ where: { jobId, type: 'JOB_CAPTURE' } })).toBe(1);
  });
});
