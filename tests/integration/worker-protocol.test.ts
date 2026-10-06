import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID, randomBytes } from 'node:crypto';
import { createApp } from '../../apps/api/src/app.js';
import { hashSecret } from '../../apps/api/src/auth.js';
import { PrismaClient, json } from '../../packages/database/src/index.js';
import { creditWallet, reserveJob, releaseJob } from '../../packages/billing/src/ledger.js';
import { executionManifestHash, DEFAULT_SCHEDULE, getPriceTier, type ExecutionManifest } from '../../packages/contracts/src/index.js';
import { generateDeviceIdentity } from '../../packages/crypto/src/index.js';
import { signedHeaders, verifyNotice, verifyAcceptedPayload } from '../../packages/job-protocol/src/index.js';

// Protocol fixtures attest no real runtime: real OpenClaw has a separate E2E gate.
describe.runIf(process.env.KIVRO_INTEGRATION === '1')('API / Worker signed protocol interoperability', () => {
  let app: Awaited<ReturnType<typeof createApp>>, db: PrismaClient;
  const buyerId = randomUUID(), sellerId = randomUUID(), capabilityId = randomUUID(), versionId = randomUUID();
  const device = generateDeviceIdentity();
  let workerId: string, serverPublicKey: string;
  const sellerToken = randomBytes(32).toString('hex');
  const buyerToken = randomBytes(32).toString('hex');
  const price = getPriceTier('USD_99');
  const manifest: ExecutionManifest = {
    ioContract: { schemaVersion: 1, inputs: [{ key: 'text', label: 'Source', type: 'LONG_TEXT', required: true, order: 0 }], output: { type: 'TEXT', description: 'Summary', required: true } },
    permissions: { schemaVersion: 1, tools: ['read', 'write', 'edit'], network: { mode: 'NONE', allowedDomains: [] }, resources: [],
      inference: { provider: 'openai-compatible', model: 'test-model', credentialRef: 'fixture-inference' },
      limits: { timeoutSeconds: 60, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 10000, maxOutputBytes: 10000, maxTokens: 1000 } },
    internalInstructions: 'Summarize only the supplied text.',
    dependencies: [
      { id: 'inference', name: 'Inference fixture', type: 'INFERENCE', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { inferenceProviders: ['openai-compatible'], credentialRefs: ['fixture-inference'] } },
      { id: 'files', name: 'Job files', type: 'TOOL', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { tools: ['read', 'write', 'edit'] } },
    ],
  };
  const origin = 'http://localhost:3000';
  const signed = (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const headers = signedHeaders(workerId, device.privateKey, method, url.split('?')[0], body);
    return app.inject({ method, url, headers: { ...headers, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: body }) });
  };
  const queue = async () => db.$transaction(async tx => {
    const job = await tx.job.create({ data: { buyerId, sellerId, capabilityId, capabilityVersionId: versionId, state: 'QUEUED',
      input: { text: `Private buyer data ${randomUUID()}` }, priceSnapshot: price, buyerPriceMinor: price.buyerPriceMinor,
      platformFeeMinor: price.platformFeeMinor, sellerNetMinor: price.sellerNetMinor, executionMode: 'NOW', waitDeadline: new Date(Date.now() + 60_000) } });
    await reserveJob(tx, job); return job;
  });
  beforeAll(async () => {
    config({ path: '.env' });
    if (process.env.KIVRO_ENV !== 'development' || !process.env.DATABASE_URL?.includes(':55432/kivro')) throw new Error('Local integration database required');
    db = new PrismaClient(); app = await createApp({ db, background: false, logger: false }); await app.ready();
    await db.user.createMany({ data: [buyerId, sellerId].map(id => ({ id, email: `${id}@protocol.kivro.local`, name: 'Protocol fixture', passwordHash: 'disabled' })) });
    await db.session.createMany({ data: [{ userId: sellerId, tokenHash: hashSecret(sellerToken), expiresAt: new Date(Date.now() + 3600000) }, { userId: buyerId, tokenHash: hashSecret(buyerToken), expiresAt: new Date(Date.now() + 3600000) }] });
    await db.capability.create({ data: { id: capabilityId, sellerId, slug: `protocol-${capabilityId}`, visibility: 'PRIVATE', schedule: DEFAULT_SCHEDULE } });
    await db.capabilityVersion.create({ data: { id: versionId, capabilityId, version: 1, title: 'Protocol fixture', summary: '', description: '', category: 'Development', tags: [], priceTierId: price.id,
      ioContract: json(manifest.ioContract), permissions: json(manifest.permissions), dependencies: json(manifest.dependencies), internalInstructions: manifest.internalInstructions,
      manifestHash: executionManifestHash(manifest), publishedAt: new Date(), consentAt: new Date(), testPassedAt: new Date() } });
    await db.capability.update({ where: { id: capabilityId }, data: { currentVersionId: versionId } });
    await db.$transaction(tx => creditWallet(tx, buyerId, 10000, `protocol:${buyerId}`));
    const pairCode = await app.inject({ method: 'POST', url: '/api/seller/pairing-code', headers: { origin, cookie: `kivro_session=${sellerToken}` } });
    expect(pairCode.statusCode).toBe(200);
    const pair = await app.inject({ method: 'POST', url: '/api/worker/pair', payload: { code: pairCode.json().code, publicKey: device.publicKey, name: 'Protocol-only fixture', version: '0.1.0' } });
    expect(pair.statusCode).toBe(200); ({ workerId, serverPublicKey } = pair.json());
    const reuse = await app.inject({ method: 'POST', url: '/api/worker/pair', payload: { code: pairCode.json().code, publicKey: generateDeviceIdentity().publicKey, name: 'Replay', version: '0.1.0' } });
    expect(reuse.statusCode).toBe(401);
    const heartbeat = await signed('POST', '/api/worker/heartbeat', { version: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)', sandboxReady: true, paused: false, capabilities: [versionId], runningJobIds: [], health: { ready: true } });
    expect(heartbeat.statusCode).toBe(200);
    const validation = await signed('POST', `/api/worker/capabilities/${versionId}/validation`, {
      manifestHash: executionManifestHash(manifest), passed: true,
      proof: { sandbox: { imageId: `sha256:${'1'.repeat(64)}`, policyVersion: 1, testedAt: Date.now() },
        inference: { configHash: '2'.repeat(64), testedAt: Date.now() } },
    });
    expect(validation.statusCode, validation.body).toBe(200);
  });
  afterAll(async () => {
    if (!db) return;
    for (const job of await db.job.findMany({ where: { buyerId, paymentState: 'RESERVED' } })) await db.$transaction(async tx => {
      await releaseJob(tx, job); await tx.job.update({ where: { id: job.id }, data: { state: 'CANCELLED' } });
    });
    await db.user.updateMany({ where: { id: { in: [buyerId, sellerId] } }, data: { suspendedAt: new Date() } });
    if (workerId) await db.workerDevice.update({ where: { id: workerId }, data: { revokedAt: new Date(), sandboxReady: false } });
    await app?.close(); await db.$disconnect();
  });
  it('verifies the real server signature and releases content only after acceptance', async () => {
    const job = await queue();
    const offered = await signed('GET', '/api/worker/offers');
    expect(offered.statusCode, offered.body).toBe(200);
    const raw = offered.json().offers[0];
    const notice = verifyNotice(raw, serverPublicKey, workerId, { ...manifest, capabilityVersionId: versionId });
    expect(notice.jobId).toBe(job.id);
    for (const key of ['input', 'assets', 'internalInstructions']) expect(raw.payload[key]).toBeUndefined();
    const payloadUrl = `/api/worker/jobs/${job.id}/payload?attemptId=${notice.attemptId}`;
    expect((await signed('GET', payloadUrl)).statusCode).toBe(403);
    const sellerView = await app.inject({ url: `/api/jobs/${job.id}`, headers: { cookie: `kivro_session=${sellerToken}` } });
    expect(sellerView.json().input).toEqual({});
    const accepted = await signed('POST', `/api/worker/jobs/${job.id}/events`, { attemptId: notice.attemptId, type: 'ACCEPTED' });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const payload = await signed('GET', payloadUrl);
    expect(payload.statusCode, payload.body).toBe(200);
    const verified = verifyAcceptedPayload(payload.json(), serverPublicKey, notice, executionManifestHash(manifest));
    expect(verified.input).toEqual(job.input);
    const signedPayload = payload.json<{ payload: Record<string, unknown> }>();
    expect(() => verifyAcceptedPayload({ ...signedPayload, payload: { ...signedPayload.payload, input: { text: 'tampered' } } }, serverPublicKey, notice, executionManifestHash(manifest))).toThrow();
    expect(() => verifyNotice(raw, serverPublicKey, workerId, { ...manifest, capabilityVersionId: versionId, dependencies: [] })).toThrow();
    expect((await signed('POST', `/api/worker/jobs/${job.id}/events`, { attemptId: notice.attemptId, type: 'RUNNING' })).statusCode).toBe(200);
    const resultBody = { attemptId: notice.attemptId, output: { text: 'Validated protocol fixture output.' } };
    const result = await signed('POST', `/api/worker/jobs/${job.id}/result`, resultBody);
    expect(result.statusCode, result.body).toBe(200);
    expect((await signed('POST', `/api/worker/jobs/${job.id}/result`, resultBody)).statusCode).toBe(200);
    expect((await signed('GET', payloadUrl)).statusCode).toBe(403);
    expect(await db.ledgerEntry.count({ where: { jobId: job.id, type: 'JOB_CAPTURE' } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { jobId: job.id, type: 'SELLER_EARNING' } })).toBe(1);
  });
  it('rejects nonce replay, tampered requests and cancelled payload access', async () => {
    const headers = signedHeaders(workerId, device.privateKey, 'GET', '/api/worker/offers');
    expect((await app.inject({ url: '/api/worker/offers', headers })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/worker/offers', headers })).statusCode).toBe(409);
    const bad = signedHeaders(workerId, device.privateKey, 'POST', '/api/worker/heartbeat', '{}');
    expect((await app.inject({ method: 'POST', url: '/api/worker/heartbeat', headers: { ...bad, 'content-type': 'application/json' }, payload: '{"tampered":true}' })).statusCode).toBe(401);
    const job = await queue();
    const offered = await signed('GET', '/api/worker/offers');
    const notice = offered.json().offers[0].payload;
    expect((await signed('POST', `/api/worker/jobs/${job.id}/events`, { attemptId: notice.attemptId, type: 'ACCEPTED' })).statusCode).toBe(200);
    const cancelled = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: { origin, cookie: `kivro_session=${buyerToken}` } });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await signed('GET', `/api/worker/jobs/${job.id}/payload?attemptId=${notice.attemptId}`)).statusCode).toBe(403);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).paymentState).toBe('RELEASED');
  });
});
