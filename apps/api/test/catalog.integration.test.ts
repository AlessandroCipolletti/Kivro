import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient, json } from '@kivro/database';
import { creditWallet, refundJob } from '@kivro/billing';
import { DEFAULT_SCHEDULE, executionManifestHash, getPriceTier, hashManifest, type Dependency, type IOContract, type PermissionManifest } from '@kivro/contracts';
import { PublicationEvidenceSchema } from '@kivro/contracts/publication-evidence';
import { ADAPTER_POLICY_VERSION } from '@kivro/openclaw-adapter';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';
import { canonicalWorkerRequest } from '../src/worker.js';
import { availability, loadCapability } from '../src/catalog.js';
import { versionReadiness } from '../src/capability-lifecycle.js';
import { loadSecurityPolicy } from '../src/security-policy.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('catalog lifecycle and server pagination with real persistence', () => {
  let app: FastifyInstance, db: PrismaClient;
  const sellerId = randomUUID(), buyerId = randomUUID(), strangerId = randomUUID(), workerId = randomUUID();
  const sellerToken = randomUUID(), buyerToken = randomUUID(), strangerToken = randomUUID();
  const category = `catalog-${randomUUID()}`, createdCapabilities: string[] = [], knownVersions = new Set<string>();
  const keys = generateKeyPairSync('ed25519');
  const ioContract: IOContract = { schemaVersion: 1, inputs: [{ key: 'text', label: 'Text', type: 'LONG_TEXT', required: true, order: 0 }], output: { type: 'TEXT', description: 'A short summary', required: true } };
  const permissions: PermissionManifest = { schemaVersion: 1, tools: ['read'], network: { mode: 'NONE', allowedDomains: [] }, resources: [],
    inference: { provider: 'openai-compatible', model: 'catalog-fixture', credentialRef: 'local-fixture-ref' },
    limits: { timeoutSeconds: 300, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024, maxTokens: 10000 } };
  const dependencies: Dependency[] = [{ id: 'inference', name: 'Local inference', type: 'INFERENCE', required: true, approved: true, healthy: true, supported: true,
    confidence: 'DECLARED', contentHash: 'a'.repeat(64), source: 'private-local-provenance', grants: { tools: ['read'], inferenceProviders: ['openai-compatible'], credentialRefs: ['local-fixture-ref'] } }];
  const headers = (token = sellerToken) => ({ cookie: `kivro_session=${token}`, origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000' });
  const request = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>, token = sellerToken) => app.inject({ method, url, headers: headers(token), ...(payload === undefined ? {} : { payload }) });
  const worker = (method: 'GET' | 'POST', url: string, body?: unknown) => {
    const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)), nonce = randomUUID(), timestamp = String(Date.now());
    return app.inject({ method, url, headers: { 'x-worker-id': workerId, 'x-worker-timestamp': timestamp, 'x-worker-nonce': nonce,
      'x-worker-signature': sign(null, Buffer.from(canonicalWorkerRequest(method, new URL(url, 'http://localhost').pathname, timestamp, nonce, raw)), keys.privateKey).toString('base64'),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { payload: raw }) });
  };
  const validate = async (id: string) => {
    knownVersions.add(id);
    const heartbeat = await worker('POST', '/api/worker/heartbeat', { version: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)', sandboxReady: true, paused: false,
      capabilities: [...knownVersions], runningJobIds: [], health: { ready: true } });
    expect(heartbeat.statusCode, heartbeat.body).toBe(200);
    const version = await db.capabilityVersion.findUniqueOrThrow({ where: { id } });
    const result = await worker('POST', `/api/worker/capabilities/${id}/validation`, { manifestHash: version.manifestHash, passed: true,
      proof: { sandbox: { imageId: `sha256:${'a'.repeat(64)}`, policyVersion: ADAPTER_POLICY_VERSION, testedAt: Date.now() }, inference: { configHash: 'b'.repeat(64), testedAt: Date.now() } } });
    expect(result.statusCode, result.body).toBe(200);
  };
  const history = async (id: string) => (await request('GET', `/api/seller/capabilities/${id}/versions`)).json();
  const create = async (overrides: Record<string, unknown> = {}) => {
    const result = await request('POST', '/api/seller/capabilities', { title: `Catalog fixture ${randomUUID().slice(0, 8)}`, summary: 'Synthetic lifecycle test capability', description: 'A retained immutable definition', category,
      tags: ['catalog-test'], priceTierId: 'USD_99', ioContract, permissions, dependencies, internalInstructions: 'Private instructions: summarize the supplied text.',
      estimatedDurationSeconds: 60, workerId, examples: [], ...overrides });
    expect(result.statusCode, result.body).toBe(200);
    createdCapabilities.push(result.json().id); return result.json() as { id: string; versionId: string; lifecycleRevision: number };
  };
  const edit = async (id: string, changes: Record<string, unknown>) => {
    const current = await history(id);
    const response = await request('PUT', `/api/seller/capabilities/${id}`, { expectedRevision: current.lifecycleRevision, ...changes });
    expect(response.statusCode, response.body).toBe(200); return response.json() as { versionId: string; lifecycleRevision: number };
  };
  const publish = async (id: string, versionId: string, visibility = 'PUBLIC') => {
    const current = await history(id), diff = (await request('GET', `/api/seller/capabilities/${id}/versions/${versionId}/diff`)).json();
    return request('POST', `/api/seller/capabilities/${id}/publish`, { visibility, expectedRevision: current.lifecycleRevision, versionId, reviewedDiffHash: diff.diffHash, localExecutionAcknowledged: true });
  };
  const ready = async (overrides: Record<string, unknown> = {}) => {
    const cap = await create(overrides); await validate(cap.versionId);
    const response = await publish(cap.id, cap.versionId); expect(response.statusCode, response.body).toBe(200); return cap;
  };
  const purchase = async (id: string, token = buyerToken) => {
    const result = await app.inject({ method: 'POST', url: '/api/jobs', headers: { ...headers(token), 'idempotency-key': randomUUID() }, payload: { capabilityId: id, input: { text: 'Seller-owned or buyer-private example input' }, executionMode: 'NOW' } });
    expect(result.statusCode, result.body).toBe(201); return result.json() as { id: string; capabilityVersionId: string; priceSnapshot: { buyerPriceMinor: number } };
  };
  const complete = async (jobId: string) => {
    const offers = await worker('GET', '/api/worker/offers');
    const offer = offers.json().offers.find((value: { payload: { jobId: string } }) => value.payload.jobId === jobId);
    expect(offer, offers.body).toBeDefined();
    for (const type of ['ACCEPTED', 'RUNNING']) {
      const result = await worker('POST', `/api/worker/jobs/${jobId}/events`, { attemptId: offer.payload.attemptId, type }); expect(result.statusCode, result.body).toBe(200);
    }
    const result = await worker('POST', `/api/worker/jobs/${jobId}/result`, { attemptId: offer.payload.attemptId, output: { text: 'A verified scalar example output.' } });
    expect(result.statusCode, result.body).toBe(200);
  };
  const activate = async (id: string, versionId: string, expectedRevision?: number) => {
    const current = await history(id), diff = (await request('GET', `/api/seller/capabilities/${id}/versions/${versionId}/diff`)).json();
    return request('POST', `/api/seller/capabilities/${id}/versions/${versionId}/activate`, { expectedRevision: expectedRevision ?? current.lifecycleRevision, reason: 'Restore this compatible immutable version', reviewedDiffHash: diff.diffHash });
  };
  beforeAll(async () => {
    process.loadEnvFile('.env');
    if (process.env.KIVRO_ENV !== 'development' || !process.env.DATABASE_URL?.includes(':55432/kivro')) throw new Error('Requires isolated local development services');
    db = new PrismaClient();
    for (const [id, token] of [[sellerId, sellerToken], [buyerId, buyerToken], [strangerId, strangerToken]]) {
      await db.user.create({ data: { id, email: `${id}@catalog.kivro.local`, emailVerifiedAt: new Date(), name: 'Catalog fixture account', passwordHash: 'disabled-test-identity', wallet: { create: {} },
        sessions: { create: { tokenHash: hashSecret(token!), expiresAt: new Date(Date.now() + 3600_000) } } } });
      await db.$transaction(tx => creditWallet(tx, id!, 10000, `catalog-fixture:${id}`));
    }
    await db.workerDevice.create({ data: { id: workerId, sellerId, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), name: 'Signed synthetic catalog worker', version: '0.1.0', runningJobIds: [] } });
  });
  beforeEach(async () => {
    await app?.close();
    app = await createApp({ env: { ...process.env, PAYMENT_MODE: 'fake', ACCOUNT_REQUESTS_PER_MINUTE: '10000', ACCOUNT_WRITES_PER_MINUTE: '1000' }, db, logger: false });
    const terms = await app.inject({ url: '/api/terms' });
    expect(terms.statusCode, terms.body).toBe(200);
    for (const token of [sellerToken, buyerToken]) {
      const acceptance = await request('POST', '/api/account/terms', { version: terms.json().version }, token);
      expect(acceptance.statusCode, acceptance.body).toBe(200);
    }
  });
  afterAll(async () => {
    if (app && db) {
      const pending = await db.job.findMany({ where: { capabilityId: { in: createdCapabilities }, paymentState: 'RESERVED' } });
      for (const job of pending) await request('POST', `/api/jobs/${job.id}/cancel`, {}, job.buyerId === sellerId ? sellerToken : buyerToken);
      await db.capability.updateMany({ where: { id: { in: createdCapabilities } }, data: { visibility: 'PRIVATE', paused: true } });
      await db.workerDevice.updateMany({ where: { id: workerId }, data: { revokedAt: new Date() } });
      await db.user.updateMany({ where: { id: { in: [sellerId, buyerId, strangerId] } }, data: { suspendedAt: new Date() } });
    }
    await app?.close(); await db?.$disconnect();
  });
  it('keeps history/details/diffs seller-only and public DTOs free of private manifest data', async () => {
    const privateDependencies: Dependency[] = [...dependencies,
      { id: 'credential-node-sentinel', name: 'private-credential-name-sentinel', type: 'CREDENTIAL', required: true, approved: true, healthy: true, supported: true,
        confidence: 'DECLARED', dependsOn: ['inference'], contentHash: 'c'.repeat(64), source: '/private/internal/credential-path-sentinel' },
      { id: 'resource-graph-sentinel', name: 'private-client-dataset-sentinel', type: 'RESOURCE', required: false, approved: true, healthy: true, supported: true,
        confidence: 'DECLARED', dependsOn: ['credential-node-sentinel'], details: 'private-schema-sentinel' }];
    const cap = await create({ dependencies: privateDependencies });
    for (const suffix of ['', `/${cap.versionId}`, `/${cap.versionId}/diff`]) {
      expect((await request('GET', `/api/seller/capabilities/${cap.id}/versions${suffix}`, undefined, strangerToken)).statusCode).toBe(404);
      expect((await app.inject({ url: `/api/seller/capabilities/${cap.id}/versions${suffix}` })).statusCode).toBe(401);
    }
    expect((await app.inject({ url: `/api/capabilities/${cap.id}` })).statusCode).toBe(404);
    const detail = (await request('GET', `/api/seller/capabilities/${cap.id}/versions/${cap.versionId}`)).json();
    expect(detail).toMatchObject({ state: 'DRAFT', version: 1, internalInstructions: 'Private instructions: summarize the supplied text.', permissions: { inference: { credentialRef: 'local-fixture-ref' } } });
    const other = await create();
    expect((await request('GET', `/api/seller/capabilities/${cap.id}/versions/${other.versionId}`)).statusCode).toBe(404);
    await validate(cap.versionId); expect((await publish(cap.id, cap.versionId)).statusCode).toBe(200);
    const publicView = (await app.inject({ url: `/api/capabilities/${cap.id}` })).json();
    expect(publicView).toMatchObject({ pauseSupport: 'FULL_RESUME', dataProcessing: { assetRetentionDays: app.kivro.config.assetRetentionDays,
      jobContentRetentionDays: app.kivro.config.jobContentRetentionDays, inferenceProvider: permissions.inference.provider, inferenceModel: permissions.inference.model, privateSellerRuntime: true } });
    expect(publicView.schedule).toBeUndefined(); expect(publicView.internalInstructions).toBeUndefined();
    expect(publicView.permissions.inference.credentialRef).toBeUndefined(); expect(publicView.dependencies[0].grants).toBeUndefined(); expect(publicView.dependencies[0].source).toBeUndefined();
    expect(JSON.stringify(publicView)).not.toContain('sentinel'); expect(JSON.stringify(publicView)).not.toContain('c'.repeat(64));
    expect(publicView.dependencies.every((node: { type: string; dependsOn?: string[] }) => node.type !== 'CREDENTIAL' && node.dependsOn === undefined)).toBe(true);
    expect(JSON.stringify(detail.dependencies)).toContain('private-client-dataset-sentinel');
    const key = (await request('POST', '/api/api-keys', { name: 'Catalog reader', scopes: ['capabilities:read'] })).json().secret;
    expect((await app.inject({ url: `/api/seller/capabilities/${cap.id}/versions`, headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(403);
  });
  it('models testing without fabricated success and preserves immutable published definitions', async () => {
    const cap = await create(); await validate(cap.versionId);
    expect((await history(cap.id)).versions[0].state).toBe('READY_TO_PUBLISH');
    const oldProof = await db.workerBinding.findUniqueOrThrow({ where: { workerId_capabilityVersionId: { workerId, capabilityVersionId: cap.versionId } } });
    const started = await request('POST', `/api/seller/capabilities/${cap.id}/versions/${cap.versionId}/testing`, { expectedRevision: cap.lifecycleRevision });
    expect(started.statusCode, started.body).toBe(200); expect(started.json().versions[0].state).toBe('TESTING');
    await db.workerBinding.update({ where: { workerId_capabilityVersionId: { workerId, capabilityVersionId: cap.versionId } }, data: { healthy: true, validationStatus: 'PASSED', validatedAt: new Date(), validationProof: json(oldProof.validationProof) } });
    const lifecycle = await db.capabilityVersionLifecycle.findUniqueOrThrow({ where: { versionId: cap.versionId } });
    await db.capabilityVersionLifecycle.update({ where: { versionId: cap.versionId }, data: { testingStartedAt: new Date(lifecycle.testingStartedAt!.getTime() + 1) } });
    expect((await publish(cap.id, cap.versionId)).statusCode).toBe(409);
    await validate(cap.versionId); expect((await publish(cap.id, cap.versionId)).statusCode).toBe(200);
    expect((await history(cap.id)).versions[0].state).toBe('PUBLISHED');
    await expect(db.capabilityVersion.update({ where: { id: cap.versionId }, data: { internalInstructions: 'Forbidden rewrite' } })).rejects.toThrow();
    await expect(db.capabilityVersion.delete({ where: { id: cap.versionId } })).rejects.toThrow();
  });
  it('freezes the validated publication environment despite later Worker retests and hides it publicly', async () => {
    const cap = await ready();
    const version = await db.capabilityVersion.findUniqueOrThrow({ where: { id: cap.versionId } });
    const evidence = PublicationEvidenceSchema.parse(version.publicationEvidence);
    expect(evidence).toMatchObject({ capabilityVersionId: cap.versionId, manifestHash: version.manifestHash,
      workerId, workerVersion: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)', localExecutionAcknowledgement: { revision: 1, acceptedBy: sellerId, acceptedAt: version.publishedAt!.toISOString() },
      workerConfig: { schemaVersion: 1, executionManifestHash: version.manifestHash, inferenceConfigHash: 'b'.repeat(64) },
      sandbox: { imageId: `sha256:${'a'.repeat(64)}`, policyVersion: ADAPTER_POLICY_VERSION }, dependencyBundleHash: hashManifest(dependencies), skills: [] });
    const { evidenceHash, ...snapshot } = evidence;
    expect(evidenceHash).toBe(hashManifest(snapshot));
    expect(evidence.recordedAt).toBe(version.publishedAt!.toISOString());
    await validate(cap.versionId);
    expect((await publish(cap.id, cap.versionId)).statusCode).toBe(200);
    expect((await db.capabilityVersion.findUniqueOrThrow({ where: { id: cap.versionId } })).publicationEvidence).toEqual(evidence);
    await expect(db.capabilityVersion.update({ where: { id: cap.versionId }, data: { publicationEvidence: {} } })).rejects.toThrow();
    expect((await request('GET', `/api/seller/capabilities/${cap.id}/versions/${cap.versionId}`)).json().publicationEvidence).toEqual(evidence);
    expect((await app.inject(`/api/capabilities/${cap.id}`)).json()).not.toHaveProperty('publicationEvidence');
    expect(JSON.stringify(evidence)).not.toContain('local-fixture-ref');
    expect(JSON.stringify(evidence)).not.toContain('Private instructions');
  });
  it('requires explicit local execution consent for each new version without changing a denied draft', async () => {
    const cap = await create(); await validate(cap.versionId);
    for (const acknowledgement of [undefined, false]) {
      const result = await request('POST', `/api/seller/capabilities/${cap.id}/publish`, { visibility: 'PUBLIC',
        ...(acknowledgement === undefined ? {} : { localExecutionAcknowledged: acknowledgement }) });
      expect(result.statusCode, result.body).toBe(409);
      expect(result.json().error.code).toBe('LOCAL_EXECUTION_ACK_REQUIRED');
      expect(await db.capabilityVersion.findUniqueOrThrow({ where: { id: cap.versionId } })).toMatchObject({ publishedAt: null, publicationEvidence: null });
    }
    expect((await publish(cap.id, cap.versionId)).statusCode).toBe(200);
    const next = await edit(cap.id, { title: 'Next consent-bound version' }); await validate(next.versionId);
    const denied = await request('POST', `/api/seller/capabilities/${cap.id}/publish`, { visibility: 'PUBLIC' });
    expect(denied.json().error.code).toBe('LOCAL_EXECUTION_ACK_REQUIRED');
    expect((await publish(cap.id, next.versionId)).statusCode).toBe(200);
  });
  it('requires review of the exact permission expansion diff and rejects stale draft publication', async () => {
    const cap = await ready();
    const changedPermissions = { ...permissions, tools: ['read', 'write'], inference: { ...permissions.inference, credentialRef: 'new-approved-ref' } };
    const changedDeps = [{ ...dependencies[0]!, grants: { ...dependencies[0]!.grants, tools: ['read', 'write'], credentialRefs: ['new-approved-ref'] } }];
    const draft = await edit(cap.id, { permissions: changedPermissions, dependencies: changedDeps, priceTierId: 'USD_299' }); await validate(draft.versionId);
    const diff = (await request('GET', `/api/seller/capabilities/${cap.id}/versions/${draft.versionId}/diff`)).json();
    expect(diff.permissionExpansion).toBe(true); expect(diff.warnings).toContainEqual({ code: 'NEW_CREDENTIAL', path: 'permissions.inference.credentialRef' });
    expect(diff.changes.map((value: { category: string }) => value.category)).toEqual(expect.arrayContaining(['PERMISSIONS', 'INFERENCE', 'SKILLS', 'PRICE']));
    for (const reviewedDiffHash of [undefined, '0'.repeat(64)]) {
      const denied = await request('POST', `/api/seller/capabilities/${cap.id}/publish`, { visibility: 'PUBLIC', expectedRevision: draft.lifecycleRevision, versionId: draft.versionId, ...(reviewedDiffHash ? { reviewedDiffHash } : {}) });
      expect(denied.statusCode).toBe(409); expect(denied.json().error.code).toBe('PERMISSION_REVIEW_REQUIRED');
      expect((await db.capability.findUniqueOrThrow({ where: { id: cap.id } })).currentVersionId).toBe(cap.versionId);
    }
    const newer = await edit(cap.id, { description: 'A newer draft must not be silently published' });
    expect((await request('POST', `/api/seller/capabilities/${cap.id}/publish`, { visibility: 'PUBLIC', expectedRevision: draft.lifecycleRevision, versionId: draft.versionId, reviewedDiffHash: diff.diffHash })).statusCode).toBe(409);
    await validate(newer.versionId); expect((await publish(cap.id, newer.versionId)).statusCode).toBe(200);
  });
  it('rechecks exact worker proof before rollback and preserves queued job version/price pins', async () => {
    const cap = await ready(), second = await edit(cap.id, { priceTierId: 'USD_299', internalInstructions: 'Private immutable version two instructions' });
    await validate(second.versionId); expect((await publish(cap.id, second.versionId)).statusCode).toBe(200);
    const queued = await purchase(cap.id), bindingKey = { workerId_capabilityVersionId: { workerId, capabilityVersionId: cap.versionId } };
    const original = await db.workerBinding.findUniqueOrThrow({ where: bindingKey });
    for (const data of [{ healthy: false }, { validatedManifestHash: '0'.repeat(64) }, { validatedAt: new Date(0) }, { validationProof: { sandbox: {}, inference: {} } }]) {
      await db.workerBinding.update({ where: bindingKey, data });
      const denied = await activate(cap.id, cap.versionId); expect(denied.statusCode, denied.body).toBe(409); expect(denied.json().error.code).toBe('ROLLBACK_NOT_READY');
      await db.workerBinding.update({ where: bindingKey, data: { ...original, validationProof: json(original.validationProof) } });
    }
    app.kivro.config.paymentMode = 'stripe';
    try { expect((await activate(cap.id, cap.versionId)).json().error.details.reasons).toContain('SELLER_PAYMENT_NOT_READY'); }
    finally { app.kivro.config.paymentMode = 'fake'; }
    const reverted = await activate(cap.id, cap.versionId); expect(reverted.statusCode, reverted.body).toBe(200); expect(reverted.json().currentVersionId).toBe(cap.versionId);
    const next = await purchase(cap.id); expect(next.capabilityVersionId).toBe(cap.versionId); expect(next.priceSnapshot.buyerPriceMinor).toBe(99);
    expect(await db.job.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ capabilityVersionId: second.versionId, buyerPriceMinor: 299 });
    await complete(queued.id);
    expect((await db.job.findUniqueOrThrow({ where: { id: queued.id } })).paymentState).toBe('SETTLED');
    expect((await request('POST', `/api/jobs/${next.id}/cancel`, {}, buyerToken)).statusCode).toBe(200);
  });
  it('uses one revision for concurrent lifecycle changes without a lost activation', async () => {
    const cap = await ready(), second = await edit(cap.id, { priceTierId: 'USD_299' }); await validate(second.versionId); await publish(cap.id, second.versionId);
    const third = await edit(cap.id, { priceTierId: 'USD_499' }); await validate(third.versionId); await publish(cap.id, third.versionId);
    const before = await history(cap.id);
    const results = await Promise.all([activate(cap.id, cap.versionId, before.lifecycleRevision), activate(cap.id, second.versionId, before.lifecycleRevision)]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    const after = await history(cap.id); expect(after.lifecycleRevision).toBe(before.lifecycleRevision + 1);
    expect(await db.auditEvent.count({ where: { type: 'CAPABILITY_VERSION_ACTIVATED', metadata: { path: ['capabilityId'], equals: cap.id } } })).toBe(1);
    expect((await activate(cap.id, third.versionId, before.lifecycleRevision)).statusCode).toBe(409);
  });
  it('applies operator runtime and category policy to public availability and version readiness', async () => {
    const cap = await ready();
    await db.workerDevice.update({ where: { id: workerId }, data: { version: '0.0.0' } });
    try {
      expect((await app.inject({ url: `/api/capabilities/${cap.id}` })).json().availability).toMatchObject({ status: 'OFFLINE', canRunNow: false });
      expect((await activate(cap.id, cap.versionId)).json().error.details.reasons).toContain('WORKER_UPDATE_REQUIRED');
    } finally { await db.workerDevice.update({ where: { id: workerId }, data: { version: '0.1.0' } }); }
    const current = await loadCapability(db, cap.id), policy = { ...await loadSecurityPolicy(db), blockedCategories: [category.toUpperCase()] };
    const bindings = await db.workerBinding.findMany({ where: { capabilityVersionId: cap.versionId }, include: { worker: true } });
    expect(await availability(app.kivro, current, db, { bindings, runningJobs: 0, queueDepth: 0, securityPolicy: policy })).toMatchObject({ status: 'SECURITY_BLOCKED', canRunNow: false });
    expect((await versionReadiness(app.kivro, db, current, current.currentVersion!, policy)).reasons).toContain('CATEGORY_BLOCKED');
  });
  it('retires active versions only with explicit deactivation and lets existing jobs finish', async () => {
    const cap = await ready(), queued = await purchase(cap.id), before = await history(cap.id);
    const path = `/api/seller/capabilities/${cap.id}/versions/${cap.versionId}/retire`;
    expect((await request('POST', path, { expectedRevision: before.lifecycleRevision, reason: 'Stop offering this version' })).json().error.code).toBe('ACTIVE_VERSION_RETIREMENT_BLOCKED');
    const retired = await request('POST', path, { expectedRevision: before.lifecycleRevision, reason: 'Stop offering this version', deactivate: true });
    expect(retired.statusCode, retired.body).toBe(200); expect(retired.json()).toMatchObject({ currentVersionId: null, visibility: 'DRAFT', versions: [{ state: 'RETIRED' }] });
    expect((await app.inject({ url: `/api/capabilities/${cap.id}` })).statusCode).toBe(404);
    expect((await activate(cap.id, cap.versionId)).json().error.details.reasons).toContain('VERSION_RETIRED');
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } });
    expect((await app.inject({ method: 'POST', url: '/api/jobs', headers: { ...headers(buyerToken), 'idempotency-key': randomUUID() }, payload: { capabilityId: cap.id, input: { text: 'Must not reserve' }, executionMode: 'NOW' } })).statusCode).toBe(404);
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } })).toEqual(wallet);
    await complete(queued.id);
    const sellerList = await request('GET', '/api/seller/capabilities'); expect(sellerList.statusCode, sellerList.body).toBe(200);
    const draft = await edit(cap.id, { summary: 'A replacement draft after retirement' }); expect(draft.versionId).not.toBe(cap.versionId);
    expect((await history(cap.id)).versions[0].state).toBe('DRAFT');
  });
  it('keeps visibility separate from runtime state and enforces explicit private grants', async () => {
    const cap = await ready(), completed = await purchase(cap.id); await complete(completed.id);
    const review = await request('POST', `/api/capabilities/${cap.id}/reviews`, { jobId: completed.id, rating: 5, comment: 'Retain across visibility transitions' }, buyerToken);
    expect(review.statusCode, review.body).toBe(200);
    const change = async (visibility: string) => request('POST', `/api/seller/capabilities/${cap.id}/visibility`, { expectedRevision: (await history(cap.id)).lifecycleRevision, visibility });
    await db.workerDevice.update({ where: { id: workerId }, data: { lastSeenAt: new Date(0) } });
    expect((await change('PRIVATE')).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/capabilities/${cap.id}` })).statusCode).toBe(404);
    expect((await request('POST', `/api/seller/capabilities/${cap.id}/grants`, { email: `${buyerId}@catalog.kivro.local`, allowed: true })).statusCode).toBe(200);
    expect((await request('GET', `/api/capabilities/${cap.id}`, undefined, buyerToken)).statusCode).toBe(200);
    expect((await change('UNLISTED')).statusCode).toBe(409);
    await validate(cap.versionId); expect((await change('UNLISTED')).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/capabilities/${cap.id}` })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/capabilities/page?q=${encodeURIComponent((await db.capabilityVersion.findUniqueOrThrow({ where: { id: cap.versionId } })).title)}` })).json().total).toBe(0);
    expect((await change('PUBLIC')).statusCode).toBe(200);
    expect((await db.job.findUniqueOrThrow({ where: { id: completed.id } })).capabilityVersionId).toBe(cap.versionId);
    expect(await db.review.findUniqueOrThrow({ where: { id: review.json().id } })).toMatchObject({ jobId: completed.id, rating: 5 });
  });
  it('publishes executed scalar examples only from the sellers own matching settled work', async () => {
    const cap = await ready(), privateJob = await purchase(cap.id); await complete(privateJob.id);
    const fromJob = async (jobId: string, versionId = cap.versionId) => request('POST', `/api/seller/capabilities/${cap.id}/versions/${versionId}/examples/from-job`, {
      expectedRevision: (await history(cap.id)).lifecycleRevision, jobId, title: 'Real summary example', confirmPublic: true });
    expect((await fromJob(privateJob.id)).statusCode).toBe(404);
    const owned = await purchase(cap.id, sellerToken); await complete(owned.id);
    const response = await fromJob(owned.id); expect(response.statusCode, response.body).toBe(200);
    const draftId = response.json().draftVersionId;
    expect((await app.inject({ url: `/api/capabilities/${cap.id}` })).json().examples).toEqual([]);
    const detail = (await request('GET', `/api/seller/capabilities/${cap.id}/versions/${draftId}`)).json();
    expect(detail.examples[0]).toMatchObject({ source: 'REAL_EXECUTION', provenance: { jobId: owned.id, capabilityVersionId: cap.versionId } });
    await validate(draftId); expect((await publish(cap.id, draftId)).statusCode).toBe(200);
    const publicExample = (await app.inject({ url: `/api/capabilities/${cap.id}` })).json().examples[0];
    expect(publicExample.source).toBe('REAL_EXECUTION'); expect(publicExample.provenance.jobId).toBeUndefined();
    const incompatible = await edit(cap.id, { internalInstructions: 'A new runtime requires examples to be rerun' }); await validate(incompatible.versionId);
    const denied = await publish(cap.id, incompatible.versionId); expect(denied.statusCode).toBe(409); expect(denied.json().error.details.reasons).toContain('EXAMPLE_NEEDS_REVALIDATION');
  });
  it('rejects curated examples incompatible with the frozen output contract', async () => {
    const cap = await create({ ioContract: { ...ioContract, output: { type: 'JSON', required: true, description: 'A JSON object', jsonSchema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } }, additionalProperties: false } } },
      examples: [{ id: randomUUID(), title: 'Invalid advertising', input: { text: 'Example' }, output: 'Not JSON' }] });
    await validate(cap.versionId);
    expect((await history(cap.id)).versions[0].exampleIssues[0].code).toBe('EXAMPLE_NEEDS_REVALIDATION');
    expect((await publish(cap.id, cap.versionId)).statusCode).toBe(409);
  });

  it('exposes review eligibility only to the buyer and rejects unpaid, undelivered and self reviews', async () => {
    const cap = await ready(), job = await purchase(cap.id), url = `/api/jobs/${job.id}/review`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    for (const token of [sellerToken, strangerToken]) expect((await request('GET', url, undefined, token)).statusCode).toBe(404);
    expect((await request('GET', url, undefined, buyerToken)).json()).toMatchObject({ eligible: false, canEdit: false, reason: 'JOB_NOT_DELIVERED', review: null });
    const submit = () => request('POST', `/api/capabilities/${cap.id}/reviews`, { jobId: job.id, rating: 5 }, buyerToken);
    expect((await submit()).statusCode).toBe(403);
    await complete(job.id);
    expect((await request('GET', url, undefined, buyerToken)).json()).toMatchObject({ jobId: job.id, capabilityVersionId: cap.versionId, capabilityVersionNumber: 1, eligible: true, reason: null, policy: { editWindowDays: 30 } });
    expect((await request('POST', `/api/capabilities/${cap.id}/reviews`, { jobId: job.id, rating: 6 }, buyerToken)).statusCode).toBe(400);
    expect((await request('POST', `/api/capabilities/${cap.id}/reviews`, { jobId: job.id, rating: 5, comment: 'x'.repeat(2001) }, buyerToken)).statusCode).toBe(400);
    await db.$transaction(async tx => refundJob(tx, await tx.job.findUniqueOrThrow({ where: { id: job.id } })));
    expect((await submit()).statusCode).toBe(403);
    expect((await request('GET', url, undefined, buyerToken)).json().reason).toBe('JOB_NOT_PAID');
    const own = await purchase(cap.id, sellerToken); await complete(own.id);
    expect((await request('GET', `/api/jobs/${own.id}/review`)).json()).toMatchObject({ eligible: false, reason: 'SELF_REVIEW' });
    expect((await request('POST', `/api/capabilities/${cap.id}/reviews`, { jobId: own.id, rating: 5 })).statusCode).toBe(403);
  });
  it('creates exactly one review per paid job and never exposes private job IDs or review hashes publicly', async () => {
    const cap = await ready(), job = await purchase(cap.id); await complete(job.id);
    const results = await Promise.all([1, 2].map(() => request('POST', `/api/capabilities/${cap.id}/reviews`, { jobId: job.id, rating: 5, comment: 'Verified result' }, buyerToken)));
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect(results.find(result => result.statusCode === 409)!.json().error.code).toBe('REVIEW_ALREADY_EXISTS');
    const own = (await request('GET', `/api/jobs/${job.id}/review`, undefined, buyerToken)).json();
    expect(own).toMatchObject({ eligible: false, canEdit: true, reason: 'ALREADY_REVIEWED' }); expect(own.review.reviewHash).toMatch(/^[a-f0-9]{64}$/);
    const publicList = await app.inject({ url: `/api/capabilities/${cap.id}/reviews` });
    expect(publicList.json()).toHaveLength(1);
    for (const forbidden of [job.id, buyerId, own.review.reviewHash, 'capabilityVersionId', 'jobId', 'userId']) expect(publicList.body).not.toContain(forbidden);
    expect(await db.auditEvent.count({ where: { type: 'REVIEW_CREATED', jobId: job.id } })).toBe(1);
    const key = (await request('POST', '/api/api-keys', { name: 'Own job reader', scopes: ['jobs:read'] }, buyerToken)).json().secret;
    expect((await app.inject({ url: `/api/jobs/${job.id}/review`, headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/capabilities/${cap.id}/reviews/summary`, headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(403);
  });
  it('audits optimistic concurrent review edits without touching funds and enforces the original edit deadline', async () => {
    const cap = await ready(), job = await purchase(cap.id); await complete(job.id);
    const created = await request('POST', `/api/capabilities/${cap.id}/reviews`, { jobId: job.id, rating: 3, comment: 'Original' }, buyerToken);
    expect(created.statusCode, created.body).toBe(200);
    const url = `/api/jobs/${job.id}/review`, expectedReviewHash = created.json().reviewHash;
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } }), ledgerCount = await db.ledgerEntry.count({ where: { jobId: job.id } });
    expect((await request('PUT', url, { expectedReviewHash, rating: 4 }, sellerToken)).statusCode).toBe(404);
    expect((await request('PUT', url, { rating: 4 }, buyerToken)).statusCode).toBe(400);
    const edits = await Promise.all([4, 5].map(rating => request('PUT', url, { expectedReviewHash, rating, comment: `Edited to ${rating}` }, buyerToken)));
    expect(edits.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect(edits.find(result => result.statusCode === 409)!.json().error.code).toBe('REVIEW_CONFLICT');
    const current = (await request('GET', url, undefined, buyerToken)).json().review;
    expect((await request('PUT', url, { expectedReviewHash: current.reviewHash, rating: current.rating, comment: current.comment }, buyerToken)).statusCode).toBe(200);
    const audits = await db.auditEvent.findMany({ where: { type: 'REVIEW_EDITED', jobId: job.id } });
    expect(audits).toHaveLength(1); expect(audits[0]!.metadata).toMatchObject({ capabilityVersionId: cap.versionId, previous: { rating: 3, comment: 'Original' }, next: { rating: current.rating } });
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } })).toEqual(wallet); expect(await db.ledgerEntry.count({ where: { jobId: job.id } })).toBe(ledgerCount);
    await db.review.update({ where: { id: current.id }, data: { createdAt: new Date(Date.now() - 31 * 86400_000) } });
    const closed = (await request('GET', url, undefined, buyerToken)).json(); expect(closed).toMatchObject({ canEdit: false, reason: 'REVIEW_EDIT_WINDOW_CLOSED' });
    expect((await request('PUT', url, { expectedReviewHash: closed.review.reviewHash, rating: 1 }, buyerToken)).json().error.code).toBe('REVIEW_EDIT_WINDOW_CLOSED');
    expect((await app.inject({ url: `/api/capabilities/${cap.id}/reviews` })).json()).toHaveLength(1);
  });
  it('keeps a previously verified review editable after refund without allowing new refunded-job reviews', async () => {
    const cap = await ready(), job = await purchase(cap.id); await complete(job.id);
    const review = (await request('POST', `/api/capabilities/${cap.id}/reviews`, { jobId: job.id, rating: 5 }, buyerToken)).json();
    await db.$transaction(async tx => refundJob(tx, await tx.job.findUniqueOrThrow({ where: { id: job.id } })));
    expect((await request('GET', `/api/jobs/${job.id}/review`, undefined, buyerToken)).json().canEdit).toBe(true);
    const edited = await request('PUT', `/api/jobs/${job.id}/review`, { expectedReviewHash: review.reviewHash, rating: 2, comment: 'Updated after refund' }, buyerToken);
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).paymentState).toBe('REFUNDED');
    expect((await app.inject({ url: `/api/capabilities/${cap.id}/reviews/summary` })).json()).toMatchObject({ averageRating: 2, reviewCount: 1 });
  });
  it('returns complete rating distributions, updates aggregates after edits and preserves private capability access', async () => {
    const cap = await ready(), first = await purchase(cap.id); await complete(first.id);
    const empty = (await app.inject({ url: `/api/capabilities/${cap.id}/reviews/summary` })).json(); expect(empty).toMatchObject({ averageRating: null, reviewCount: 0 });
    expect(empty.distribution).toEqual([1, 2, 3, 4, 5].map(rating => ({ rating, count: 0 })));
    const initial = (await request('POST', `/api/capabilities/${cap.id}/reviews`, { jobId: first.id, rating: 5 }, buyerToken)).json();
    for (const rating of [3, 3]) {
      const job = await purchase(cap.id); await complete(job.id);
      expect((await request('POST', `/api/capabilities/${cap.id}/reviews`, { jobId: job.id, rating }, buyerToken)).statusCode).toBe(200);
    }
    const summary = (await app.inject({ url: `/api/capabilities/${cap.id}/reviews/summary` })).json();
    expect(summary.averageRating).toBeCloseTo(11 / 3); expect(summary.reviewCount).toBe(3);
    expect(summary.distribution).toEqual([{ rating: 1, count: 0 }, { rating: 2, count: 0 }, { rating: 3, count: 2 }, { rating: 4, count: 0 }, { rating: 5, count: 1 }]);
    expect((await request('PUT', `/api/jobs/${first.id}/review`, { expectedReviewHash: initial.reviewHash, rating: 3 }, buyerToken)).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/capabilities/${cap.id}` })).json()).toMatchObject({ rating: 3, reviewCount: 3 });
    expect((await request('POST', `/api/seller/capabilities/${cap.id}/visibility`, { expectedRevision: (await history(cap.id)).lifecycleRevision, visibility: 'PRIVATE' })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/capabilities/${cap.id}/reviews/summary` })).statusCode).toBe(404);
    expect((await request('GET', `/api/jobs/${first.id}/review`, undefined, buyerToken)).statusCode).toBe(200);
  });

  const catalogFixture = async (count: number) => {
    const tag = `page-${randomUUID()}`, ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const id = randomUUID(), versionId = randomUUID(); ids.push(id); createdCapabilities.push(id);
      await db.capability.create({ data: { id, sellerId, slug: `page-${id}`, visibility: 'PUBLIC', schedule: DEFAULT_SCHEDULE, createdAt: new Date(Date.now() - (count - index) * 1000) } });
      const body = { ioContract, permissions, dependencies, internalInstructions: 'Private paginated fixture' };
      await db.capabilityVersion.create({ data: { id: versionId, capabilityId: id, version: 1, title: `${tag} ${index}`, summary: 'Synthetic catalog paging record', description: 'Catalog search fixture',
        category: tag, tags: [tag], priceTierId: index === 0 ? 'USD_99' : 'USD_999', ...body, ioContract: json(ioContract), permissions: json(permissions), dependencies: json(dependencies),
        manifestHash: executionManifestHash(body), publishedAt: new Date(), examples: [] } });
      await db.capability.update({ where: { id }, data: { currentVersionId: versionId } });
    }
    return { tag, ids };
  };
  it('filters before pagination past one hundred records and keeps the legacy array shape', async () => {
    const fixture = await catalogFixture(105);
    const filtered = await app.inject({ url: `/api/capabilities/page?category=${fixture.tag}&maxPrice=99&limit=1&sort=PRICE_ASC` });
    expect(filtered.statusCode, filtered.body).toBe(200); expect(filtered.json().total).toBe(1); expect(filtered.json().items[0].id).toBe(fixture.ids[0]); expect(filtered.json().nextCursor).toBeNull();
    const versionId = (await db.capability.findUniqueOrThrow({ where: { id: fixture.ids[0] } })).currentVersionId!; await validate(versionId);
    const now = await app.inject({ url: `/api/capabilities/page?category=${fixture.tag}&availability=NOW&limit=1` });
    expect(now.json().total).toBe(1); expect(now.json().items[0].id).toBe(fixture.ids[0]);
    const legacy = await app.inject({ url: `/api/capabilities?category=${fixture.tag}` }); expect(legacy.statusCode).toBe(200); expect(Array.isArray(legacy.json())).toBe(true);
  });
  it('uses deterministic cursors, validates filter binding, and returns each matching item once', async () => {
    const fixture = await catalogFixture(8); const seen: string[] = [];
    let cursor: string | null = null, firstCursor = '';
    do {
      const url: string = `/api/capabilities/page?category=${fixture.tag}&sort=PRICE_DESC&limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const response = await app.inject({ url }); expect(response.statusCode, response.body).toBe(200);
      expect(response.json().total).toBe(8); seen.push(...response.json().items.map((item: { id: string }) => item.id));
      cursor = response.json().nextCursor; if (!firstCursor && cursor) firstCursor = cursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(8); expect(seen).toHaveLength(8);
    expect((await app.inject({ url: `/api/capabilities/page?category=${fixture.tag}&sort=PRICE_ASC&cursor=${firstCursor}` })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/capabilities/page?cursor=not-json' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/capabilities/page?limit=1000' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/capabilities/page?minPrice=999&maxPrice=99' })).statusCode).toBe(400);
  });
  it('keeps future services discoverable while filtering now, today and schedulable in the buyer timezone', async () => {
    const category = `availability-${randomUUID()}`;
    const immediate = await ready({ title: 'Equal relevance service', category });
    const later = await ready({ title: 'Equal relevance service', category });
    const now = new Date(), timezone = now.getUTCHours() < 12 ? 'UTC' : 'Etc/GMT+12';
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const time = (offset: number) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(now.getTime() + offset));
    const schedule = { mode: 'WEEKLY', timezone, windows: [], overrides: [{ date, available: true, start: time(3600_000), end: time(7200_000) }] };
    const changed = await request('PUT', `/api/seller/capabilities/${later.id}/schedule`, { schedule }); expect(changed.statusCode, changed.body).toBe(200);
    const page = async (filter = '') => {
      const response = await app.inject({ url: `/api/capabilities/page?category=${category}&timezone=${encodeURIComponent(timezone)}${filter}` });
      expect(response.statusCode, response.body).toBe(200); return response.json();
    };
    const all = await page(); expect(all.total).toBe(2); expect(all.items.map((item: { id: string }) => item.id)).toEqual([immediate.id, later.id]);
    expect(all.items[1].availability.status).toBe('SCHEDULED_OFFLINE'); expect(all.items[1].schedule).toBeUndefined();
    const available = await page('&availability=NOW'); expect(available.total).toBe(1); expect(available.items[0].id).toBe(immediate.id);
    expect((await page('&availability=TODAY')).total).toBe(2); expect((await page('&availability=SCHEDULABLE')).total).toBe(2);
    expect((await app.inject({ url: '/api/capabilities/page?timezone=Not/A_Zone' })).statusCode).toBe(400);
    await db.workerDevice.update({ where: { id: workerId }, data: { lastSeenAt: new Date(0) } });
    expect((await page()).total).toBe(2); expect((await page('&availability=SCHEDULABLE')).total).toBe(0);
  });
  it('filters ratings/output/duration/favorites and sorts by actual aggregate metrics', async () => {
    const fixture = await catalogFixture(3), firstId = fixture.ids[0]!, secondId = fixture.ids[1]!;
    const first = await db.capability.findUniqueOrThrow({ where: { id: firstId } }), second = await db.capability.findUniqueOrThrow({ where: { id: secondId } });
    const price = getPriceTier('USD_99');
    for (let index = 0; index < 2; index++) {
      const item = index === 0 ? first : second;
      const job = await db.job.create({ data: { capabilityId: item.id, capabilityVersionId: item.currentVersionId!, buyerId, sellerId, state: 'SUCCEEDED', paymentState: 'SETTLED', input: { text: 'Synthetic ranking fixture, not execution evidence' },
        priceSnapshot: price, buyerPriceMinor: price.buyerPriceMinor, sellerNetMinor: price.sellerNetMinor, platformFeeMinor: price.platformFeeMinor, executionMode: 'NOW', waitDeadline: new Date() } });
      await db.review.create({ data: { capabilityId: item.id, jobId: job.id, userId: buyerId, rating: index === 0 ? 5 : 2, comment: 'Synthetic ranking fixture' } });
    }
    expect((await request('POST', `/api/capabilities/${firstId}/favorite`, {}, buyerToken)).statusCode).toBe(200);
    const response = await request('GET', `/api/capabilities/page?category=${fixture.tag}&minRating=4&outputType=TEXT&maxDurationSeconds=60&favorites=true&sort=RATING`, undefined, buyerToken);
    expect(response.json().total).toBe(1); expect(response.json().items[0]).toMatchObject({ id: firstId, rating: 5, isFavorite: true });
    expect((await app.inject({ url: `/api/capabilities/page?category=${fixture.tag}&outputType=JSON` })).json().total).toBe(0);
    expect((await app.inject({ url: `/api/capabilities/page?category=${fixture.tag}&maxDurationSeconds=1` })).json().total).toBe(0);
    expect((await app.inject({ url: '/api/capabilities/page?favorites=true' })).statusCode).toBe(401);
    const sorted = (await app.inject({ url: `/api/capabilities/page?category=${fixture.tag}&sort=POPULAR` })).json().items;
    expect(sorted[0].completedJobs).toBe(1); expect(sorted[2].completedJobs).toBe(0);
    expect(JSON.stringify(sorted)).not.toContain('local-fixture-ref'); expect(JSON.stringify(sorted)).not.toContain('private-local-provenance');
  });
});
