import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, json, type Prisma } from '@kivro/database';
import { DEFAULT_SCHEDULE, executionManifestHash, getPriceTier } from '@kivro/contracts';
import { parseApiResponse, sellerCapabilityLiveStateSchema } from '@kivro/contracts/responses';
import { createApp } from '../src/app.js';
import { hashSecret } from '../src/auth.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('seller capability live health (isolated PostgreSQL)', () => {
  const schema = `cap_live_${randomBytes(8).toString('hex')}`;
  const databaseUrl = `postgresql://kivro:kivro_local_only@127.0.0.1:55432/kivro?schema=${schema}`;
  let db: PrismaClient, app: Awaited<ReturnType<typeof createApp>>;
  const sellerId = randomUUID(), buyerId = randomUUID(), sellerToken = randomUUID(), buyerToken = randomUUID();
  const origin = 'http://localhost:3000';
  let capabilityId: string, versionId: string, olderVersionId: string, emptyCapabilityId: string, historicalSuccessId: string;
  const historicalCompletedAt = new Date(Date.now() - 60_000);
  const job = (data: Partial<Prisma.JobUncheckedCreateInput> = {}) => db.job.create({ data: {
    buyerId, sellerId, capabilityId, capabilityVersionId: versionId, input: {}, priceSnapshot: getPriceTier('USD_99'),
    buyerPriceMinor: 99, platformFeeMinor: 19, sellerNetMinor: 80, executionMode: 'NOW',
    waitDeadline: new Date(Date.now() + 600000), createdAt: new Date(Date.now() - 120_000), ...data,
  } });
  const list = async (token = sellerToken) => {
    const result = await app.inject({ url: '/api/seller/capabilities', headers: { cookie: `kivro_session=${token}` } });
    expect(result.statusCode, result.body).toBe(200);
    expect(() => parseApiResponse('GET', '/api/seller/capabilities', result.statusCode, result.json())).not.toThrow();
    return result.json<Array<{ id: string; versionId: string; concurrency: number; maxQueue: number; maxScheduled: number; liveState: unknown }>>();
  };
  beforeAll(async () => {
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: databaseUrl } });
    db = new PrismaClient({ datasourceUrl: databaseUrl });
    for (const [id, token] of [[sellerId, sellerToken], [buyerId, buyerToken]]) await db.user.create({ data: { id,
      name: 'Synthetic live health account', email: `${id}@cap-live.kivro.local`, passwordHash: 'disabled',
      sessions: { create: { tokenHash: hashSecret(token!), expiresAt: new Date(Date.now() + 600000) } } } });
    const worker = await db.workerDevice.create({ data: { sellerId, name: 'Synthetic ready device', version: '0.1.0',
      openclawVersion: 'OpenClaw 2026.8.2 (0965053)', sandboxReady: true, lastSeenAt: new Date(),
      publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() } });
    const manifest = { ioContract: { schemaVersion: 1, inputs: [], output: { type: 'TEXT', description: 'Result', required: true } },
      permissions: { schemaVersion: 1, tools: [], network: { mode: 'NONE', allowedDomains: [] }, resources: [], inference: { provider: 'openai-compatible', model: 'test' },
        limits: { timeoutSeconds: 300, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 1024, maxOutputBytes: 1024, maxTokens: 1000 } },
      dependencies: [{ id: 'inference', name: 'Dedicated inference', type: 'INFERENCE', required: true, approved: true, healthy: true, supported: true,
        confidence: 'DECLARED', grants: { inferenceProviders: ['openai-compatible'] } }], internalInstructions: 'Synthetic health test' };
    for (let index = 0; index < 2; index++) {
      const cap = await db.capability.create({ data: { sellerId, slug: randomUUID(), visibility: 'PUBLIC', schedule: DEFAULT_SCHEDULE, concurrency: 1, maxQueue: 3, maxScheduled: 4 } });
      if (index === 0) capabilityId = cap.id; else emptyCapabilityId = cap.id;
      for (let number = 1; number <= 2; number++) {
        const version = await db.capabilityVersion.create({ data: { capabilityId: cap.id, version: number, title: 'Live health test', summary: 'Synthetic health test', description: '', category: 'Writing & documents',
          tags: [], priceTierId: 'USD_99', internalInstructions: manifest.internalInstructions, ioContract: json(manifest.ioContract), permissions: json(manifest.permissions), dependencies: json(manifest.dependencies),
          manifestHash: executionManifestHash(manifest), publishedAt: new Date() } });
        if (index === 0) { if (number === 1) olderVersionId = version.id; else versionId = version.id; }
        if (number === 2) {
          await db.capability.update({ where: { id: cap.id }, data: { currentVersionId: version.id } });
          await db.workerBinding.create({ data: { workerId: worker.id, capabilityVersionId: version.id, healthy: true, validationStatus: 'PASSED',
            validatedManifestHash: version.manifestHash, validatedAt: new Date() } });
        }
      }
    }
    historicalSuccessId = (await job({ capabilityVersionId: olderVersionId, state: 'SUCCEEDED', completedAt: historicalCompletedAt })).id;
    await job({ state: 'SUCCEEDED', completedAt: new Date(Date.now() + 3600_000) });
    await job({ state: 'SUCCEEDED', completedAt: null });
    await job({ state: 'FAILED', completedAt: new Date() });
    for (const state of ['RUNNING', 'PAUSED', 'QUEUED', 'QUEUED', 'SCHEDULED'] as const) await job({ state, capabilityVersionId: state === 'PAUSED' ? olderVersionId : versionId });
    app = await createApp({ db, logger: false, mailer: null, env: { NODE_ENV: 'test', KIVRO_ENV: 'test', PAYMENT_MODE: 'fake', DATABASE_URL: databaseUrl,
      WEB_ORIGIN: origin, S3_ENDPOINT: 'http://127.0.0.1:59000', S3_BUCKET: 'unused-cap-live', S3_ACCESS_KEY: 'unused', S3_SECRET_KEY: 'unused' } });
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      if (!/^cap_live_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe test schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await db.$disconnect();
    }
  });
  it('exposes actual all-version counts without clipping jobs draining above configured limits', async () => {
    const cap = (await list()).find(row => row.id === capabilityId)!;
    expect(cap).toMatchObject({ versionId, concurrency: 1, maxQueue: 3, maxScheduled: 4 });
    const live = sellerCapabilityLiveStateSchema.parse(cap.liveState);
    expect(live).toMatchObject({ runningJobs: 2, queueDepth: 2, scheduledJobs: 1, effectiveConcurrency: 1, capacityLoad: 2 });
    expect(Date.now() - Date.parse(live.observedAt)).toBeLessThan(5000);
  });
  it('retains the exact successful version and timestamp, excluding missing/future completions', async () => {
    const live = sellerCapabilityLiveStateSchema.parse((await list()).find(row => row.id === capabilityId)!.liveState);
    expect(live.lastSuccess).toEqual({ jobId: historicalSuccessId, capabilityVersionId: olderVersionId, completedAt: historicalCompletedAt.toISOString() });
    expect(sellerCapabilityLiveStateSchema.parse((await list()).find(row => row.id === emptyCapabilityId)!.liveState).lastSuccess).toBeNull();
  });
  it('never leaks seller live health to public consumers or another account', async () => {
    expect(await list(buyerToken)).toEqual([]);
    const anonymous = await app.inject('/api/seller/capabilities'); expect(anonymous.statusCode).toBe(401);
    const publicView = await app.inject(`/api/capabilities/${capabilityId}`); expect(publicView.statusCode, publicView.body).toBe(200);
    expect(publicView.json()).not.toHaveProperty('liveState');
    expect(publicView.body).not.toContain(historicalSuccessId);
  });
});
