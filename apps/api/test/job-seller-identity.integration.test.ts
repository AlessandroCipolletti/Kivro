import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, json, serializable } from '@kivro/database';
import { DEFAULT_SCHEDULE, executionManifestHash, getPriceTier } from '@kivro/contracts';
import { creditWallet, reserveJob } from '@kivro/billing';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('purchased seller identity (isolated PostgreSQL)', () => {
  const schema = `seller_identity_${randomBytes(8).toString('hex')}`;
  const databaseUrl = `postgresql://kivro:kivro_local_only@127.0.0.1:55432/kivro?schema=${schema}`;
  let db: PrismaClient, app: Awaited<ReturnType<typeof createApp>>;
  const buyerId = randomUUID(), sellerId = randomUUID(), token = randomUUID(), origin = 'http://localhost:3000';
  const originalName = 'Original <seller> & company';
  let capabilityId: string, versionId: string;
  const headers = { origin, cookie: `kivro_session=${token}` };
  beforeAll(async () => {
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: databaseUrl } });
    db = new PrismaClient({ datasourceUrl: databaseUrl });
    for (const id of [buyerId, sellerId]) await db.user.create({ data: { id, name: id === sellerId ? originalName : 'Synthetic buyer',
      email: `${id}@seller-identity.kivro.local`, passwordHash: 'disabled', wallet: { create: {} } } });
    await db.session.create({ data: { userId: buyerId, tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + 600000) } });
    await serializable(db, tx => creditWallet(tx, buyerId, 1000, `identity-funding:${buyerId}`));
    const worker = await db.workerDevice.create({ data: { sellerId, name: 'Synthetic ready device', version: '0.1.0',
      openclawVersion: 'OpenClaw 2026.8.2 (0965053)', sandboxReady: true, lastSeenAt: new Date(),
      publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() } });
    const cap = await db.capability.create({ data: { sellerId, slug: randomUUID(), visibility: 'PUBLIC', schedule: DEFAULT_SCHEDULE, maxQueue: 10 } });
    capabilityId = cap.id;
    const manifest = { ioContract: { schemaVersion: 1, inputs: [], output: { type: 'TEXT', description: 'Result', required: true } },
      permissions: { schemaVersion: 1, tools: [], network: { mode: 'NONE', allowedDomains: [] }, resources: [], inference: { provider: 'openai-compatible', model: 'test' },
        limits: { timeoutSeconds: 300, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 1024, maxOutputBytes: 1024, maxTokens: 1000 } },
      dependencies: [{ id: 'inference', name: 'Dedicated inference', type: 'INFERENCE', required: true, approved: true, healthy: true, supported: true,
        confidence: 'DECLARED', grants: { inferenceProviders: ['openai-compatible'] } }], internalInstructions: 'Synthetic identity test' };
    const version = await db.capabilityVersion.create({ data: { capabilityId, version: 1, title: 'Identity test', summary: 'Synthetic identity test', description: '', category: 'Writing & documents',
      tags: [], priceTierId: 'USD_99', internalInstructions: manifest.internalInstructions, ioContract: json(manifest.ioContract), permissions: json(manifest.permissions), dependencies: json(manifest.dependencies),
      manifestHash: executionManifestHash(manifest), publishedAt: new Date() } });
    versionId = version.id;
    await db.capability.update({ where: { id: capabilityId }, data: { currentVersionId: versionId } });
    await db.workerBinding.create({ data: { workerId: worker.id, capabilityVersionId: versionId, healthy: true, validationStatus: 'PASSED',
      validatedManifestHash: version.manifestHash, validatedAt: new Date() } });
    app = await createApp({ db, logger: false, mailer: null, env: { NODE_ENV: 'test', KIVRO_ENV: 'test', PAYMENT_MODE: 'fake', DATABASE_URL: databaseUrl,
      WEB_ORIGIN: origin, S3_ENDPOINT: 'http://127.0.0.1:59000', S3_BUCKET: 'unused-seller-identity', S3_ACCESS_KEY: 'unused', S3_SECRET_KEY: 'unused' } });
    const terms = (await app.inject('/api/terms')).json();
    const accepted = await app.inject({ method: 'POST', url: '/api/account/terms', headers, payload: { version: terms.version } });
    expect(accepted.statusCode, accepted.body).toBe(200);
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      if (!/^seller_identity_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe test schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await db.$disconnect();
    }
  });
  const purchase = (key: string, extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/api/jobs', headers: { ...headers, 'idempotency-key': key },
    payload: { capabilityId, input: {}, executionMode: 'NOW', ...extra } });

  it('captures seller identity once and preserves it through profile changes and idempotent purchase replay', async () => {
    const key = randomUUID(), bought = await purchase(key);
    expect(bought.statusCode, bought.body).toBe(201); const jobId = bought.json().id as string;
    expect(bought.headers['x-kivro-correlation-id']).toBe(jobId);
    expect(bought.json().correlationId).toBe(jobId);
    expect(bought.json()).toMatchObject({ sellerId, sellerName: originalName });
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).sellerNameSnapshot).toBe(originalName);
    await db.user.update({ where: { id: sellerId }, data: { name: 'Changed seller profile' } });
    for (const result of [await app.inject({ url: `/api/jobs/${jobId}`, headers }), await purchase(key)]) {
      expect(result.statusCode).toBeLessThan(300); expect(result.json()).toMatchObject({ id: jobId, sellerName: originalName });
      expect(result.headers['x-kivro-correlation-id']).toBe(jobId); expect(result.json().correlationId).toBe(jobId);
    }
    const listed = await app.inject({ url: '/api/jobs', headers });
    expect(listed.json().find((job: { id: string }) => job.id === jobId).sellerName).toBe(originalName);
    expect(await db.ledgerEntry.count({ where: { jobId, type: 'JOB_RESERVE' } })).toBe(1);
    for (const value of ['Changed history', null]) await expect(db.job.update({ where: { id: jobId }, data: { sellerNameSnapshot: value } })).rejects.toThrow();
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).sellerNameSnapshot).toBe(originalName);
  });

  it('does not invent a historical seller name for records without purchase evidence', async () => {
    const legacy = await serializable(db, async tx => {
      const job = await tx.job.create({ data: { buyerId, sellerId, capabilityId, capabilityVersionId: versionId, input: {}, priceSnapshot: getPriceTier('USD_99'),
        buyerPriceMinor: 99, platformFeeMinor: 19, sellerNetMinor: 80, executionMode: 'NOW', waitDeadline: new Date(Date.now() + 600000) } });
      await reserveJob(tx, job); return job;
    });
    const result = await app.inject({ url: `/api/jobs/${legacy.id}`, headers });
    expect(result.statusCode, result.body).toBe(200); expect(result.json()).toMatchObject({ sellerId, sellerName: null });
    await expect(db.job.update({ where: { id: legacy.id }, data: { sellerNameSnapshot: 'Invented backfill' } })).rejects.toThrow();
  });

  it('never lets a buyer override the historical seller identity', async () => {
    const before = await db.job.count();
    for (const extra of [{ sellerName: 'Forged' }, { sellerNameSnapshot: 'Forged' }, { sellerId: buyerId }]) {
      const result = await purchase(randomUUID(), extra);
      expect(result.statusCode, result.body).toBe(400);
    }
    expect(await db.job.count()).toBe(before);
  });
});
