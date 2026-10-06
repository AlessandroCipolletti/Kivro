import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@kivro/database';
import { creditWallet } from '@kivro/billing';
import { AssetDTOSchema, type AssetDTO, type CapabilityExampleDTO, type Dependency, type IOContract, type PermissionManifest } from '@kivro/contracts';
import { ADAPTER_POLICY_VERSION } from '@kivro/openclaw-adapter';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';
import { canonicalWorkerRequest } from '../src/worker.js';
import { cleanupExampleAssets } from '../src/example-assets.js';
import { abandonObject, cleanupPendingObjects, commitObject, stageObject } from '../src/pending-objects.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('seller-approved example files with real PostgreSQL and S3', () => {
  let app: FastifyInstance, db: PrismaClient;
  const sellerId = randomUUID(), buyerId = randomUUID(), strangerId = randomUUID(), workerId = randomUUID();
  const sellerToken = randomUUID(), buyerToken = randomUUID(), strangerToken = randomUUID(), capabilities: string[] = [];
  const keys = generateKeyPairSync('ed25519'), knownVersions = new Set<string>();
  const constraints = { allowedMimeTypes: ['text/markdown'], allowedExtensions: ['.md'], maxFileSizeBytes: 1024 * 1024 };
  const ioContract: IOContract = { schemaVersion: 1, inputs: [
    { key: 'text', label: 'Text', type: 'LONG_TEXT', required: true, order: 0 },
    { key: 'document', label: 'Document', type: 'FILE', required: true, order: 1, constraints },
  ], output: { type: 'MIXED', required: true, description: 'Summary and report',
    files: { allowedMimeTypes: ['text/markdown'], allowedExtensions: ['.md'], maxFiles: 2, maxTotalSizeBytes: 1024 * 1024 },
    fields: [{ key: 'report', label: 'Report', type: 'FILE', required: true, order: 0, constraints }] } };
  const permissions: PermissionManifest = { schemaVersion: 1, tools: ['read', 'write'], network: { mode: 'NONE', allowedDomains: [] }, resources: [],
    inference: { provider: 'openai-compatible', model: 'example-fixture', credentialRef: 'local-test' },
    limits: { timeoutSeconds: 300, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024, maxTokens: 10000 } };
  const dependencies: Dependency[] = [{ id: 'inference', name: 'Private local inference', type: 'INFERENCE', required: true, approved: true, healthy: true, supported: true,
    confidence: 'DECLARED', grants: { tools: ['read', 'write'], inferenceProviders: ['openai-compatible'], credentialRefs: ['local-test'] } }];
  const headers = (token: string = sellerToken) => ({ cookie: `kivro_session=${token}`, origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000' });
  const request = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>, token: string = sellerToken) => app.inject({ method, url, headers: headers(token), ...(payload === undefined ? {} : { payload }) });
  const worker = (method: 'GET' | 'POST', url: string, body?: unknown, multipart?: { raw: Buffer; contentType: string }) => {
    const raw = multipart?.raw ?? (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))), nonce = randomUUID(), timestamp = String(Date.now());
    return app.inject({ method, url, headers: { 'x-worker-id': workerId, 'x-worker-timestamp': timestamp, 'x-worker-nonce': nonce,
      'x-worker-signature': sign(null, Buffer.from(canonicalWorkerRequest(method, new URL(url, 'http://localhost').pathname, timestamp, nonce, raw)), keys.privateKey).toString('base64'),
      ...(raw.length ? { 'content-type': multipart?.contentType ?? 'application/json' } : {}) }, ...(raw.length ? { payload: raw } : {}) });
  };
  const multipart = (bytes: Buffer, filename: string, mimeType: string, attemptId?: string) => {
    const boundary = `example-${randomUUID()}`;
    return { contentType: `multipart/form-data; boundary=${boundary}`, raw: Buffer.concat([
      Buffer.from(`${attemptId ? `--${boundary}\r\nContent-Disposition: form-data; name="attemptId"\r\n\r\n${attemptId}\r\n` : ''}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]) };
  };
  const upload = async (token = sellerToken, filename = 'source.md', bytes = Buffer.from('# Private seller-owned example source\n'), mimeType = 'text/markdown') => {
    const file = multipart(bytes, filename, mimeType);
    const result = await app.inject({ method: 'POST', url: '/api/assets/upload', headers: { ...headers(token), 'content-type': file.contentType }, payload: file.raw });
    expect(result.statusCode, result.body).toBe(201); return AssetDTOSchema.parse(result.json());
  };
  const history = async (id: string) => (await request('GET', `/api/seller/capabilities/${id}/versions`)).json();
  const collectAbandoned = async (keys: string[]) => {
    const pending = await db.pendingObject.findMany({ where: { objectKey: { in: keys } } });
    expect(pending).toHaveLength(keys.length);
    expect(pending.every(row => !row.committedAt && row.cleanupStartedAt)).toBe(true);
    // Model elapsed drain time without waiting a minute for each fault fixture.
    await db.pendingObject.updateMany({ where: { objectKey: { in: keys }, committedAt: null }, data: { cleanupStartedAt: new Date(0) } });
    await cleanupPendingObjects(app.kivro);
    for (const key of keys) await expect(app.kivro.storage.get(key)).rejects.toThrow();
  };
  const create = async (contract = ioContract) => {
    const result = await request('POST', '/api/seller/capabilities', { title: `File examples ${randomUUID().slice(0, 8)}`, summary: 'Synthetic file example fixture', description: 'Explicitly approved demonstration files', category: 'DOCUMENTS',
      tags: ['example-test'], priceTierId: 'USD_99', ioContract: contract, permissions, dependencies, internalInstructions: 'Summarize text and create a Markdown report.', estimatedDurationSeconds: 60, workerId, examples: [] });
    expect(result.statusCode, result.body).toBe(200); const cap = result.json() as { id: string; versionId: string; lifecycleRevision: number };
    capabilities.push(cap.id); return cap;
  };
  const validate = async (versionId: string) => {
    knownVersions.add(versionId);
    const heartbeat = await worker('POST', '/api/worker/heartbeat', { version: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)', sandboxReady: true, paused: false,
      capabilities: [...knownVersions], runningJobIds: [], health: { ready: true } });
    expect(heartbeat.statusCode, heartbeat.body).toBe(200);
    const version = await db.capabilityVersion.findUniqueOrThrow({ where: { id: versionId } });
    const result = await worker('POST', `/api/worker/capabilities/${versionId}/validation`, { manifestHash: version.manifestHash, passed: true,
      proof: { sandbox: { imageId: `sha256:${'a'.repeat(64)}`, policyVersion: ADAPTER_POLICY_VERSION, testedAt: Date.now() }, inference: { configHash: 'b'.repeat(64), testedAt: Date.now() } } });
    expect(result.statusCode, result.body).toBe(200);
  };
  const publish = async (id: string, versionId: string, visibility = 'PUBLIC') => {
    await validate(versionId);
    const current = await history(id), diff = (await request('GET', `/api/seller/capabilities/${id}/versions/${versionId}/diff`)).json();
    return request('POST', `/api/seller/capabilities/${id}/publish`, { visibility, expectedRevision: current.lifecycleRevision, versionId, reviewedDiffHash: diff.diffHash, localExecutionAcknowledged: true });
  };
  const promote = async (id: string, versionId: string, input: AssetDTO, output: AssetDTO, extras: Record<string, unknown> = {}) => request('POST', `/api/seller/capabilities/${id}/versions/${versionId}/examples`, {
    expectedRevision: (await history(id)).lifecycleRevision, title: 'Approved file example', confirmPublic: true,
    input: { text: 'Seller-approved example scalar', document: input.id }, outputValue: { text: 'Summary result', assets: [output], fields: { report: output.id } },
    approvedAssetIds: [input.id, output.id], reusableInputAssetIds: [input.id], ...extras,
  });
  const fixture = async (published = true) => {
    const cap = await create(), input = await upload(), output = await upload(sellerToken, 'result.md', Buffer.from('# Seller-curated report\n'));
    const result = await promote(cap.id, cap.versionId, input, output); expect(result.statusCode, result.body).toBe(200);
    const versionId = result.json().draftVersionId as string;
    if (published) { const result = await publish(cap.id, versionId); expect(result.statusCode, result.body).toBe(200); }
    const version = await db.capabilityVersion.findUniqueOrThrow({ where: { id: versionId } });
    const example = (version.examples as unknown as CapabilityExampleDTO[])[0]!;
    return { cap, input, output, versionId, example, path: `/api/capabilities/${cap.id}/examples/${example.id}` };
  };
  beforeAll(async () => {
    process.loadEnvFile('.env');
    if (process.env.KIVRO_ENV !== 'development' || !process.env.DATABASE_URL?.includes(':55432/kivro')) throw new Error('Requires isolated development services');
    db = new PrismaClient();
    for (const [id, token] of [[sellerId, sellerToken], [buyerId, buyerToken], [strangerId, strangerToken]]) {
      await db.user.create({ data: { id, email: `${id}@examples.kivro.local`, emailVerifiedAt: new Date(), name: 'Example fixture account', passwordHash: 'disabled-test-identity', wallet: { create: {} },
        sessions: { create: { tokenHash: hashSecret(token!), expiresAt: new Date(Date.now() + 3600_000) } } } });
      await db.$transaction(tx => creditWallet(tx, id!, 10000, `example-fixture:${id}`));
    }
    await db.workerDevice.create({ data: { id: workerId, sellerId, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), name: 'Signed synthetic example worker', version: '0.1.0', runningJobIds: [] } });
  });
  beforeEach(async () => {
    await app?.close();
    app = await createApp({ env: { ...process.env, PAYMENT_MODE: 'fake', ACCOUNT_REQUESTS_PER_MINUTE: '10000', ACCOUNT_WRITES_PER_MINUTE: '1000' }, db, logger: false });
    const terms = await app.inject({ url: '/api/terms' });
    for (const token of [sellerToken, buyerToken, strangerToken]) expect((await request('POST', '/api/account/terms', { version: terms.json().version }, token)).statusCode).toBe(200);
  });
  afterAll(async () => {
    if (app && db) {
      const pending = await db.job.findMany({ where: { capabilityId: { in: capabilities }, paymentState: 'RESERVED' } });
      for (const job of pending) await request('POST', `/api/jobs/${job.id}/cancel`, {}, job.buyerId === sellerId ? sellerToken : buyerToken);
      await db.capability.updateMany({ where: { id: { in: capabilities } }, data: { visibility: 'PRIVATE', paused: true } });
      const copies = await db.capabilityExampleAsset.findMany({ where: { capabilityId: { in: capabilities }, deletedAt: null } });
      for (const copy of copies) {
        await app.kivro.storage.delete(copy.objectKey);
        await db.capabilityExampleAsset.update({ where: { id: copy.id }, data: { ...(copy.revokedAt ? {} : { revokedAt: new Date() }), deletedAt: new Date() } });
      }
      const assets = await db.asset.findMany({ where: { ownerId: { in: [sellerId, buyerId, strangerId] }, deletedAt: null } });
      for (const asset of assets) await app.kivro.storage.delete(asset.objectKey);
      await db.asset.updateMany({ where: { ownerId: { in: [sellerId, buyerId, strangerId] } }, data: { deletedAt: new Date(), expiresAt: new Date(0) } });
      await db.pendingObject.updateMany({ where: { ownerId: { in: [sellerId, buyerId, strangerId] }, committedAt: null, deletedAt: null }, data: { cleanupStartedAt: new Date(0) } });
      await cleanupPendingObjects(app.kivro);
      await db.workerDevice.updateMany({ where: { id: workerId }, data: { revokedAt: new Date() } });
      await db.user.updateMany({ where: { id: { in: [sellerId, buyerId, strangerId] } }, data: { suspendedAt: new Date() } });
    }
    await app?.close(); await db?.$disconnect();
  });

  it('requires exact per-file consent and ownership before creating any public copy', async () => {
    const cap = await create(), input = await upload(), output = await upload(), other = await upload(buyerToken);
    for (const extras of [{ approvedAssetIds: [] }, { approvedAssetIds: [input.id] }, { approvedAssetIds: [input.id, output.id, other.id] }, { reusableInputAssetIds: [output.id] }, { confirmPublic: false }]) {
      expect((await promote(cap.id, cap.versionId, input, output, extras)).statusCode).toBe(400);
    }
    expect((await promote(cap.id, cap.versionId, other, output)).statusCode).toBe(404);
    expect((await request('POST', `/api/seller/capabilities/${cap.id}/versions/${cap.versionId}/examples`, { expectedRevision: 0 }, buyerToken)).statusCode).toBe(400);
    expect(await db.capabilityExampleAsset.count({ where: { capabilityId: cap.id } })).toBe(0);
    expect((await history(cap.id)).versions).toHaveLength(1);
    const expired = await db.asset.update({ where: { id: input.id }, data: { expiresAt: new Date(0) } });
    expect((await promote(cap.id, cap.versionId, input, output)).statusCode).toBe(404);
    expect(expired.ownerId).toBe(sellerId);
  });

  it('keeps draft copies inaccessible and serves only current approved bytes after publication', async () => {
    const { cap, versionId, example, input, path } = await fixture(false), copy = example.inputAssets![0]!;
    expect(copy.id).not.toBe(input.id);
    expect((await app.inject({ url: `${path}/assets/${copy.id}` })).statusCode).toBe(404);
    expect((await request('GET', `${path}/assets/${copy.id}`)).statusCode).toBe(404);
    const detailPath = `/api/seller/capabilities/${cap.id}/versions/${versionId}`;
    expect((await request('GET', detailPath)).json().examples[0].inputAssets[0].downloadUrl).toBeUndefined();
    expect((await publish(cap.id, versionId)).statusCode).toBe(200);
    expect((await request('GET', detailPath)).json().examples[0].inputAssets[0].downloadUrl).toBe(`${path}/assets/${copy.id}`);
    const publicView = await app.inject({ url: `/api/capabilities/${cap.id}` });
    expect(publicView.json().examples[0]).toMatchObject({ source: 'SELLER_CURATED', input: { document: copy.id }, inputAssets: [{ id: copy.id, reusableTemplate: true, downloadUrl: `${path}/assets/${copy.id}` }] });
    expect(publicView.body).not.toContain(input.id); expect(publicView.body).not.toContain('objectKey'); expect(publicView.body).not.toContain('sourceAssetId');
    const response = await app.inject({ url: `${path}/assets/${copy.id}` });
    expect(response.statusCode, response.body).toBe(200); expect(response.body).toBe('# Private seller-owned example source\n');
    expect(response.headers['content-disposition']).toContain('attachment'); expect(response.headers['x-content-type-options']).toBe('nosniff');
    const range = await app.inject({ url: `${path}/assets/${copy.id}`, headers: { range: 'bytes=2-8' } });
    expect(range.statusCode).toBe(206); expect(range.body).toBe('Private');
    const head = await app.inject({ method: 'HEAD', url: `${path}/assets/${copy.id}` }); expect(head.body).toBe(''); expect(Number(head.headers['content-length'])).toBe(copy.sizeBytes);
    expect((await app.inject({ url: `${path}/assets/${copy.id}`, headers: { range: 'bytes=99999-' } })).statusCode).toBe(416);
    expect((await app.inject({ url: `${path}/assets/${input.id}` })).statusCode).toBe(404);
    expect((await app.inject({ url: `${path}/assets/${randomUUID()}` })).statusCode).toBe(404);
    await expect(db.capabilityExampleAsset.update({ where: { id: copy.id }, data: { filename: 'rewritten.md' } })).rejects.toThrow();
    await expect(db.capabilityVersion.update({ where: { id: versionId }, data: { examples: [] } })).rejects.toThrow();
  });

  it('retains independent example objects after source expiry/deletion and across application restart', async () => {
    const { cap, example, input, path } = await fixture(), copy = example.inputAssets![0]!;
    const source = await db.asset.findUniqueOrThrow({ where: { id: input.id } });
    await db.asset.update({ where: { id: input.id }, data: { expiresAt: new Date(0), deletedAt: new Date() } });
    await app.kivro.storage.delete(source.objectKey);
    await app.close(); app = await createApp({ db, env: { ...process.env, PAYMENT_MODE: 'fake', ACCOUNT_REQUESTS_PER_MINUTE: '10000', ACCOUNT_WRITES_PER_MINUTE: '1000' }, logger: false });
    expect((await app.inject({ url: `${path}/assets/${copy.id}` })).body).toBe('# Private seller-owned example source\n');
    expect((await app.inject({ url: `/api/capabilities/${cap.id}` })).json().examples).toHaveLength(1);
    expect((await db.capabilityExampleAsset.findUniqueOrThrow({ where: { id: copy.id } })).objectKey).not.toBe(source.objectKey);
  });

  it('records unapproved stages before PUT and atomically commits example and buyer-template references', async () => {
    const cap = await create(), input = await upload(), output = await upload(), originalPut = app.kivro.storage.putAt, pendingIds: string[] = [];
    app.kivro.storage.putAt = async (...args) => {
      const pending = await db.pendingObject.findUniqueOrThrow({ where: { objectKey: args[0] } });
      expect(pending).toMatchObject({ ownerId: sellerId, committedAt: null, exampleAssetId: null, assetId: null, cleanupStartedAt: null });
      expect(await db.capabilityExampleAsset.count({ where: { objectKey: args[0] } })).toBe(0);
      pendingIds.push(pending.id);
      await cleanupPendingObjects(app.kivro);
      expect((await db.pendingObject.findUniqueOrThrow({ where: { id: pending.id } })).deletedAt).toBeNull();
      return originalPut.apply(app.kivro.storage, args);
    };
    let result;
    try { result = await promote(cap.id, cap.versionId, input, output); }
    finally { app.kivro.storage.putAt = originalPut; }
    expect(result.statusCode, result.body).toBe(200); expect(pendingIds).toHaveLength(2);
    const rows = await db.pendingObject.findMany({ where: { id: { in: pendingIds } }, include: { exampleAsset: true } });
    for (const row of rows) {
      expect(row.committedAt).not.toBeNull(); expect(row.assetId).toBeNull(); expect(row.exampleAsset?.objectKey).toBe(row.objectKey);
      expect(row.exampleAsset?.approvedAt.getTime()).toBeGreaterThanOrEqual(row.createdAt.getTime());
    }
    const versionId = result.json().draftVersionId as string, published = await publish(cap.id, versionId); expect(published.statusCode, published.body).toBe(200);
    const example = (await app.inject({ url: `/api/capabilities/${cap.id}` })).json().examples[0] as CapabilityExampleDTO;
    const template = await request('POST', `/api/capabilities/${cap.id}/examples/${example.id}/template`, { capabilityVersionId: versionId, assetIds: [example.inputAssets![0]!.id], confirmCopy: true }, buyerToken);
    expect(template.statusCode, template.body).toBe(200);
    const buyerAsset = await db.asset.findUniqueOrThrow({ where: { id: template.json().assets[0].id } });
    const committed = await db.pendingObject.findUniqueOrThrow({ where: { assetId: buyerAsset.id } });
    expect(committed).toMatchObject({ ownerId: buyerId, objectKey: buyerAsset.objectKey, exampleAssetId: null, cleanupStartedAt: null, deletedAt: null });
    expect(committed.committedAt).not.toBeNull();
    for (const pending of [...rows, committed]) await abandonObject(app.kivro, pending.id);
    await db.pendingObject.updateMany({ where: { id: { in: [...pendingIds, committed.id] } }, data: { expiresAt: new Date(0) } });
    await cleanupPendingObjects(app.kivro);
    for (const pending of [...rows, committed]) {
      const retained = await db.pendingObject.findUniqueOrThrow({ where: { id: pending.id } });
      expect(retained.cleanupStartedAt).toBeNull(); expect(retained.deletedAt).toBeNull();
      expect((await app.kivro.storage.get(retained.objectKey)).length).toBeGreaterThan(0);
    }
  });

  it('recovers before-PUT and after-PUT crash stages after restart without exposing or deleting live examples', async () => {
    const { cap, example, path } = await fixture(), live = example.inputAssets![0]!;
    const orphan = await stageObject(app.kivro, { ownerId: sellerId, bytes: Buffer.from('# Crash-stage bytes\n'), filename: 'orphan.md', mimeType: 'text/markdown' });
    const beforePut = await db.pendingObject.create({ data: { ownerId: sellerId, objectKey: `assets/${randomUUID()}`, expiresAt: new Date(0) } });
    const fresh = await stageObject(app.kivro, { ownerId: sellerId, bytes: Buffer.from('# Still active\n'), filename: 'active.md', mimeType: 'text/markdown' });
    expect((await app.inject({ url: `${path}/assets/${orphan.pendingId}` })).statusCode).toBe(404);
    expect(await db.capabilityExampleAsset.count({ where: { objectKey: orphan.key } })).toBe(0);
    await app.close(); app = await createApp({ db, env: { ...process.env, PAYMENT_MODE: 'fake', ACCOUNT_REQUESTS_PER_MINUTE: '10000', ACCOUNT_WRITES_PER_MINUTE: '1000' }, logger: false });
    // Persisted timestamps represent a process restart after the publication TTL and drain grace.
    await db.pendingObject.update({ where: { id: orphan.pendingId }, data: { expiresAt: new Date(0) } });
    await cleanupPendingObjects(app.kivro); await cleanupPendingObjects(app.kivro);
    for (const id of [orphan.pendingId, beforePut.id]) {
      const row = await db.pendingObject.findUniqueOrThrow({ where: { id } });
      expect(row.committedAt).toBeNull(); expect(row.cleanupStartedAt).not.toBeNull(); expect(row.deletedAt).not.toBeNull();
      await expect(app.kivro.storage.get(row.objectKey)).rejects.toThrow();
    }
    expect((await app.kivro.storage.get(fresh.key)).toString()).toBe('# Still active\n');
    expect((await app.inject({ url: `${path}/assets/${live.id}` })).statusCode).toBe(200);
    const count = await db.capabilityExampleAsset.count({ where: { capabilityId: cap.id } });
    await expect(db.$transaction(async tx => {
      const copy = await tx.capabilityExampleAsset.create({ data: { capabilityId: cap.id, ownerId: sellerId, filename: orphan.filename, mimeType: orphan.mimeType,
        sha256: orphan.sha256, sizeBytes: orphan.sizeBytes, objectKey: orphan.key, scanStatus: 'DEVELOPMENT_ONLY' } });
      await commitObject(tx, orphan.pendingId, { exampleAssetId: copy.id });
    })).rejects.toMatchObject({ code: 'OBJECT_PUBLICATION_EXPIRED' });
    expect(await db.capabilityExampleAsset.count({ where: { capabilityId: cap.id } })).toBe(count);
    await abandonObject(app.kivro, fresh.pendingId);
  });

  it('rolls back example approval and draft changes if publication expires after PUT', async () => {
    const cap = await create(), input = await upload(), output = await upload(), originalPut = app.kivro.storage.putAt, keys: string[] = [];
    app.kivro.storage.putAt = async (...args) => {
      const stored = await originalPut.apply(app.kivro.storage, args); keys.push(stored.key);
      await db.pendingObject.update({ where: { objectKey: stored.key }, data: { expiresAt: new Date(0) } }); return stored;
    };
    try {
      const failed = await promote(cap.id, cap.versionId, input, output);
      expect(failed.statusCode, failed.body).toBe(409); expect(failed.json().error.code).toBe('OBJECT_PUBLICATION_EXPIRED');
    } finally { app.kivro.storage.putAt = originalPut; }
    expect(await db.capabilityExampleAsset.count({ where: { capabilityId: cap.id } })).toBe(0);
    const unchanged = await history(cap.id); expect(unchanged.draftVersionId).toBe(cap.versionId); expect(unchanged.lifecycleRevision).toBe(cap.lifecycleRevision);
    await collectAbandoned(keys);
  });

  it('serves validated image previews inline with exact bytes and safe range headers', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK3sAAAAASUVORK5CYII=', 'base64');
    const mediaConstraints = { allowedMimeTypes: ['image/png'], allowedExtensions: ['.png'], maxFileSizeBytes: 1024 * 1024 };
    const contract: IOContract = { schemaVersion: 1, inputs: [{ key: 'image', label: 'Image', type: 'FILE', required: true, order: 0, constraints: mediaConstraints }],
      output: { type: 'FILES', description: 'Approved image', required: true, files: { allowedMimeTypes: ['image/png'], allowedExtensions: ['.png'], maxFiles: 1, maxTotalSizeBytes: 1024 * 1024 } } };
    const cap = await create(contract), image = await upload(sellerToken, 'pixel.png', png, 'image/png');
    const promoted = await request('POST', `/api/seller/capabilities/${cap.id}/versions/${cap.versionId}/examples`, { expectedRevision: cap.lifecycleRevision,
      title: 'Approved image preview', input: { image: image.id }, outputValue: { assets: [image] }, approvedAssetIds: [image.id], confirmPublic: true });
    expect(promoted.statusCode, promoted.body).toBe(200);
    const result = await publish(cap.id, promoted.json().draftVersionId); expect(result.statusCode, result.body).toBe(200);
    const view = (await app.inject({ url: `/api/capabilities/${cap.id}` })).json().examples[0] as CapabilityExampleDTO;
    const full = await app.inject({ url: view.outputAssets![0]!.downloadUrl! });
    expect(full.statusCode).toBe(200); expect(full.rawPayload).toEqual(png); expect(full.headers['content-type']).toBe('image/png');
    expect(full.headers['content-disposition']).toContain('inline'); expect(full.headers['content-security-policy']).toContain('sandbox');
    const partial = await app.inject({ url: view.outputAssets![0]!.downloadUrl!, headers: { range: 'bytes=-4' } });
    expect(partial.statusCode).toBe(206); expect(partial.rawPayload).toEqual(png.subarray(-4));
  });

  it('copies only explicitly selected reusable inputs into private expiring buyer assets without payment', async () => {
    const { cap, example, versionId, path } = await fixture(), copy = example.inputAssets![0]!, output = example.outputAssets![0]!;
    expect((await app.inject({ method: 'POST', url: `${path}/template`, payload: { capabilityVersionId: versionId } })).statusCode).toBe(401);
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } }), initial = await db.asset.count({ where: { ownerId: buyerId } });
    const scalar = await request('POST', `${path}/template`, { capabilityVersionId: versionId }, buyerToken);
    expect(scalar.statusCode, scalar.body).toBe(200); expect(scalar.json()).toMatchObject({ input: { text: 'Seller-approved example scalar' }, assets: [] });
    expect(scalar.json().input.document).toBeUndefined(); expect(await db.asset.count({ where: { ownerId: buyerId } })).toBe(initial);
    expect((await request('POST', `${path}/template`, { capabilityVersionId: versionId, assetIds: [copy.id] }, buyerToken)).statusCode).toBe(400);
    expect((await request('POST', `${path}/template`, { capabilityVersionId: versionId, assetIds: [output.id], confirmCopy: true }, buyerToken)).statusCode).toBe(403);
    expect((await request('POST', `${path}/template`, { capabilityVersionId: cap.versionId, assetIds: [copy.id], confirmCopy: true }, buyerToken)).statusCode).toBe(409);
    const result = await request('POST', `${path}/template`, { capabilityVersionId: versionId, assetIds: [copy.id], confirmCopy: true }, buyerToken);
    expect(result.statusCode, result.body).toBe(200); const asset = result.json().assets[0] as AssetDTO;
    expect(asset.id).not.toBe(copy.id); expect(result.json().input.document).toBe(asset.id);
    const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(row.ownerId).toBe(buyerId); expect(row.kind).toBe('INPUT'); expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + app.kivro.config.assetRetentionDays * 86400_000);
    expect((await request('GET', `/api/assets/${row.id}/download`, undefined, strangerToken)).statusCode).toBe(404);
    expect((await request('GET', `/api/assets/${row.id}/download`, undefined, buyerToken)).statusCode).toBe(302);
    expect((await app.kivro.storage.get(row.objectKey)).toString()).toBe('# Private seller-owned example source\n');
    expect(await db.wallet.findUniqueOrThrow({ where: { userId: buyerId } })).toEqual(wallet);
    expect(await db.job.count({ where: { capabilityId: cap.id } })).toBe(0);
  });

  it('honors private grants, suspension, draft state, security blocking and current version references', async () => {
    const { cap, example, path } = await fixture(), url = `${path}/assets/${example.inputAssets![0]!.id}`;
    await db.capability.update({ where: { id: cap.id }, data: { visibility: 'PRIVATE' } });
    expect((await app.inject({ url })).statusCode).toBe(404); expect((await request('GET', url, undefined, buyerToken)).statusCode).toBe(404);
    await db.capabilityGrant.create({ data: { capabilityId: cap.id, userId: buyerId } });
    expect((await request('GET', url, undefined, buyerToken)).statusCode).toBe(200);
    await db.capability.update({ where: { id: cap.id }, data: { visibility: 'UNLISTED' } }); expect((await app.inject({ url })).statusCode).toBe(200);
    await db.user.update({ where: { id: sellerId }, data: { suspendedAt: new Date() } });
    try { expect((await app.inject({ url })).statusCode).toBe(404); } finally { await db.user.update({ where: { id: sellerId }, data: { suspendedAt: null } }); }
    for (const data of [{ securityBlocked: true }, { securityBlocked: false, visibility: 'DRAFT' }] as const) {
      await db.capability.update({ where: { id: cap.id }, data }); expect((await app.inject({ url })).statusCode).toBe(404);
    }
    await db.capability.update({ where: { id: cap.id }, data: { visibility: 'PUBLIC', currentVersionId: cap.versionId } });
    expect((await app.inject({ url })).statusCode).toBe(404);
  });

  it('revokes immediately, hides invalid examples, cleans independent copies and never revokes buyer templates', async () => {
    const { cap, example, versionId, path, input } = await fixture(), copy = example.inputAssets![0]!;
    const template = await request('POST', `${path}/template`, { capabilityVersionId: versionId, assetIds: [copy.id], confirmCopy: true }, buyerToken);
    const buyerAsset = await db.asset.findUniqueOrThrow({ where: { id: template.json().assets[0].id } });
    const row = await db.capabilityExampleAsset.findUniqueOrThrow({ where: { id: copy.id } });
    const revoke = `/api/seller/capabilities/${cap.id}/example-assets/${copy.id}/revoke`, before = await history(cap.id);
    expect((await request('POST', revoke, { expectedRevision: before.lifecycleRevision, reason: 'Withdraw public license' }, buyerToken)).statusCode).toBe(404);
    expect((await request('POST', revoke, { expectedRevision: before.lifecycleRevision, reason: 'Withdraw public license' })).statusCode).toBe(200);
    expect((await request('POST', revoke, { expectedRevision: before.lifecycleRevision, reason: 'Stale request' })).statusCode).toBe(409);
    expect((await request('POST', revoke, { expectedRevision: before.lifecycleRevision + 1, reason: 'Retry same revocation' })).statusCode).toBe(200);
    expect((await app.inject({ url: `${path}/assets/${copy.id}` })).statusCode).toBe(404);
    expect((await request('POST', `${path}/template`, { capabilityVersionId: versionId, assetIds: [copy.id], confirmCopy: true }, buyerToken)).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/capabilities/${cap.id}` })).json().examples).toHaveLength(0);
    await expect(db.capabilityExampleAsset.update({ where: { id: copy.id }, data: { revokedAt: null } })).rejects.toThrow();
    await cleanupExampleAssets(app.kivro);
    expect((await db.capabilityExampleAsset.findUniqueOrThrow({ where: { id: copy.id } })).deletedAt).not.toBeNull();
    await expect(app.kivro.storage.get(row.objectKey)).rejects.toThrow();
    expect((await app.kivro.storage.get(buyerAsset.objectKey)).toString()).toContain('seller-owned');
    expect((await db.asset.findUniqueOrThrow({ where: { id: input.id } })).deletedAt).toBeNull();
    expect(await db.auditEvent.count({ where: { type: 'EXAMPLE_ASSET_REVOKED', metadata: { path: ['assetId'], equals: copy.id } } })).toBe(1);
  });

  it('rechecks revocation and version access after storage waits, with no partial template commit', async () => {
    const first = await fixture(), copy = first.example.inputAssets![0]!, originalStream = app.kivro.storage.getStream!;
    app.kivro.storage.getStream = async (...args) => {
      const stream = await originalStream.apply(app.kivro.storage, args);
      await db.capabilityExampleAsset.update({ where: { id: copy.id }, data: { revokedAt: new Date() } }); return stream;
    };
    try {
      const denied = await app.inject({ url: `${first.path}/assets/${copy.id}`, headers: { range: 'bytes=0-3' } });
      expect(denied.statusCode, denied.body).toBe(404); expect(denied.json().error.code).toBe('NOT_FOUND'); expect(denied.headers['content-range']).toBeUndefined();
    } finally { app.kivro.storage.getStream = originalStream; }
    const second = await fixture(), secondCopy = second.example.inputAssets![0]!, originalPut = app.kivro.storage.putAt, objects: string[] = [];
    const before = await db.asset.count({ where: { ownerId: buyerId } });
    app.kivro.storage.putAt = async (...args) => {
      const result = await originalPut.apply(app.kivro.storage, args); objects.push(result.key);
      await db.capabilityExampleAsset.update({ where: { id: secondCopy.id }, data: { revokedAt: new Date() } }); return result;
    };
    try {
      const denied = await request('POST', `${second.path}/template`, { capabilityVersionId: second.versionId, assetIds: [secondCopy.id], confirmCopy: true }, buyerToken);
      expect(denied.statusCode, denied.body).toBe(404);
    } finally { app.kivro.storage.putAt = originalPut; }
    expect(await db.asset.count({ where: { ownerId: buyerId } })).toBe(before);
    await collectAbandoned(objects);
  });

  it('rejects changed source bytes and source expiry during copying, cleaning failed transaction objects', async () => {
    const cap = await create(), input = await upload(), output = await upload(), originalGet = app.kivro.storage.get;
    app.kivro.storage.get = async () => Buffer.from('tampered');
    try { expect((await promote(cap.id, cap.versionId, input, output)).json().error.code).toBe('EXAMPLE_ASSET_INTEGRITY'); }
    finally { app.kivro.storage.get = originalGet; }
    const originalPut = app.kivro.storage.putAt, objects: string[] = [];
    app.kivro.storage.putAt = async (...args) => {
      const result = await originalPut.apply(app.kivro.storage, args); objects.push(result.key);
      await db.asset.update({ where: { id: input.id }, data: { expiresAt: new Date(0) } }); return result;
    };
    try { expect((await promote(cap.id, cap.versionId, input, output)).statusCode).toBe(404); }
    finally { app.kivro.storage.putAt = originalPut; }
    expect(await db.capabilityExampleAsset.count({ where: { capabilityId: cap.id } })).toBe(0);
    expect((await history(cap.id)).versions).toHaveLength(1);
    await collectAbandoned(objects);
  });

  it('serializes concurrent example creation, enforces the three-example limit and replaces explicitly', async () => {
    const cap = await create(), input = await upload(), output = await upload();
    const pair = await Promise.all([promote(cap.id, cap.versionId, input, output, { expectedRevision: cap.lifecycleRevision }), promote(cap.id, cap.versionId, input, output, { expectedRevision: cap.lifecycleRevision })]);
    expect(pair.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect(await db.capabilityExampleAsset.count({ where: { capabilityId: cap.id } })).toBe(2);
    let current = await history(cap.id);
    for (let i = 0; i < 2; i++) {
      const result = await promote(cap.id, current.draftVersionId, input, output); expect(result.statusCode, result.body).toBe(200); current = result.json();
    }
    const rejected = await promote(cap.id, current.draftVersionId, input, output); expect(rejected.statusCode).toBe(409); expect(rejected.json().error.code).toBe('EXAMPLE_LIMIT_EXCEEDED');
    const version = await db.capabilityVersion.findUniqueOrThrow({ where: { id: current.draftVersionId } });
    const previous = version.examples as unknown as CapabilityExampleDTO[], exampleId = previous[0]!.id;
    const replaced = await promote(cap.id, current.draftVersionId, input, output, { replaceExampleId: exampleId, title: 'Explicitly replaced example' });
    expect(replaced.statusCode, replaced.body).toBe(200);
    const after = await db.capabilityVersion.findUniqueOrThrow({ where: { id: replaced.json().draftVersionId } });
    expect(after.examples).toHaveLength(3); expect((after.examples as unknown as CapabilityExampleDTO[])[0]).toMatchObject({ id: exampleId, title: 'Explicitly replaced example' });
    expect((after.examples as unknown as CapabilityExampleDTO[])[0]!.inputAssets![0]!.id).not.toBe(previous[0]!.inputAssets![0]!.id);
    expect((await db.capabilityVersion.findUniqueOrThrow({ where: { id: version.id } })).examples).toEqual(version.examples);
  });

  it('preserves approved evidence on title edits and blocks publication after incompatible contracts', async () => {
    const { cap, example, versionId } = await fixture();
    const edited = await request('PUT', `/api/seller/capabilities/${cap.id}`, { expectedRevision: (await history(cap.id)).lifecycleRevision,
      examples: [{ id: example.id, title: 'Edited explanation', input: example.input, output: example.output }] });
    expect(edited.statusCode, edited.body).toBe(200);
    const saved = await db.capabilityVersion.findUniqueOrThrow({ where: { id: edited.json().versionId } });
    expect((saved.examples as unknown as CapabilityExampleDTO[])[0]!.inputAssets).toEqual(example.inputAssets);
    const changed = await request('PUT', `/api/seller/capabilities/${cap.id}`, { expectedRevision: edited.json().lifecycleRevision,
      ioContract: { ...ioContract, inputs: [...ioContract.inputs, { key: 'requiredExtra', label: 'New required value', type: 'SHORT_TEXT', required: true, order: 2 }] } });
    expect(changed.statusCode, changed.body).toBe(200);
    const denied = await publish(cap.id, changed.json().versionId); expect(denied.statusCode, denied.body).toBe(409); expect(denied.json().error.details.reasons).toContain('EXAMPLE_NEEDS_REVALIDATION');
    expect((await db.capability.findUniqueOrThrow({ where: { id: cap.id } })).currentVersionId).toBe(versionId);
  });

  it('publishes only self-owned successful execution outputs, remapping named files and redacting provenance', async () => {
    const cap = await create(); expect((await publish(cap.id, cap.versionId)).statusCode).toBe(200);
    const selfInput = await upload(), buyerInput = await upload(buyerToken);
    const execute = async (token: string, input: AssetDTO) => {
      const purchase = await app.inject({ method: 'POST', url: '/api/jobs', headers: { ...headers(token), 'idempotency-key': randomUUID() }, payload: { capabilityId: cap.id, input: { text: 'Explicit test content', document: input.id }, executionMode: 'NOW' } });
      expect(purchase.statusCode, purchase.body).toBe(201); const jobId = purchase.json().id as string;
      const notices = await worker('GET', '/api/worker/offers'), notice = notices.json().offers.find((offer: { payload: { jobId: string } }) => offer.payload.jobId === jobId)?.payload;
      expect(notice, notices.body).toBeDefined();
      for (const type of ['ACCEPTED', 'RUNNING']) expect((await worker('POST', `/api/worker/jobs/${jobId}/events`, { attemptId: notice.attemptId, type })).statusCode).toBe(200);
      const uploaded = await worker('POST', `/api/worker/jobs/${jobId}/assets`, undefined, multipart(Buffer.from('# Actual signed fixture output\n'), 'report.md', 'text/markdown', notice.attemptId));
      expect(uploaded.statusCode, uploaded.body).toBe(201); const output = AssetDTOSchema.parse(uploaded.json());
      const result = await worker('POST', `/api/worker/jobs/${jobId}/result`, { attemptId: notice.attemptId, output: { text: 'Verified execution summary', assets: [output], fields: { report: output.id } } });
      expect(result.statusCode, result.body).toBe(200); return { jobId, output };
    };
    const self = await execute(sellerToken, selfInput), buyer = await execute(buyerToken, buyerInput);
    expect((await app.inject({ url: `/api/capabilities/${cap.id}` })).json().examples).toHaveLength(0);
    const path = `/api/seller/capabilities/${cap.id}/versions/${cap.versionId}/examples/from-job`, revision = (await history(cap.id)).lifecycleRevision;
    const preview = await request('GET', `${path}/${self.jobId}`);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ jobId: self.jobId, capabilityVersionId: cap.versionId, targetVersionId: cap.versionId,
      inputAssets: [{ id: selfInput.id, filename: selfInput.filename, sha256: selfInput.sha256, downloadUrl: `/api/assets/${selfInput.id}/download` }],
      outputAssets: [{ id: self.output.id, filename: 'report.md', downloadUrl: `/api/assets/${self.output.id}/download` }] });
    expect(preview.body).not.toContain('objectKey');
    expect((await request('GET', `${path}/${self.jobId}`, undefined, buyerToken)).statusCode).toBe(404);
    expect((await request('GET', `${path}/${buyer.jobId}`)).statusCode).toBe(404);
    expect((await app.inject({ url: `${path}/${self.jobId}` })).statusCode).toBe(401);
    const body = { expectedRevision: revision, title: 'Real seller test', jobId: self.jobId, confirmPublic: true, approvedAssetIds: [selfInput.id, self.output.id], reusableInputAssetIds: [selfInput.id] };
    expect((await request('POST', path, { ...body, jobId: buyer.jobId, approvedAssetIds: [buyerInput.id, buyer.output.id] })).statusCode).toBe(404);
    expect((await promote(cap.id, cap.versionId, selfInput, buyer.output)).statusCode).toBe(404);
    const result = await request('POST', path, body); expect(result.statusCode, result.body).toBe(200);
    const versionId = result.json().draftVersionId as string;
    expect((await publish(cap.id, versionId)).statusCode).toBe(200);
    const response = await app.inject({ url: `/api/capabilities/${cap.id}` }), example = response.json().examples[0] as CapabilityExampleDTO;
    expect(example).toMatchObject({ source: 'REAL_EXECUTION', provenance: { capabilityVersionId: cap.versionId } });
    expect(example.outputValue!.fields!.report).toBe(example.outputAssets![0]!.id); expect(example.outputAssets![0]!.id).not.toBe(self.output.id);
    for (const secret of [self.jobId, buyer.jobId, self.output.id, selfInput.id, buyerInput.id]) expect(response.body).not.toContain(secret);
    expect((await app.inject({ url: example.outputAssets![0]!.downloadUrl! })).body).toBe('# Actual signed fixture output\n');
    const changed = await request('PUT', `/api/seller/capabilities/${cap.id}`, { expectedRevision: (await history(cap.id)).lifecycleRevision, internalInstructions: 'Meaningful changed execution behavior' });
    const denied = await publish(cap.id, changed.json().versionId); expect(denied.statusCode).toBe(409); expect(denied.json().error.details.reasons).toContain('EXAMPLE_NEEDS_REVALIDATION');
  });
});
