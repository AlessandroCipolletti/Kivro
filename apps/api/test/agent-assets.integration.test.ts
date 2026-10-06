import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@kivro/database';
import { DEFAULT_SCHEDULE, getPriceTier } from '@kivro/contracts';
import { MarketplaceAgent } from '@kivro/marketplace-agent';
import { createApp } from '../src/app.js';
import { resolveAgentInputAssets } from '../src/agent-assets.js';
import { hashSecret } from '../src/auth.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('agent attachment metadata (isolated PostgreSQL)', () => {
  const schema = `agent_assets_${randomBytes(8).toString('hex')}`;
  const databaseUrl = `postgresql://kivro:kivro_local_only@127.0.0.1:55432/kivro?schema=${schema}`;
  let db: PrismaClient, app: Awaited<ReturnType<typeof createApp>>;
  const buyerId = randomUUID(), otherId = randomUUID(), session = randomUUID();
  beforeAll(async () => {
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: databaseUrl } });
    db = new PrismaClient({ datasourceUrl: databaseUrl });
    for (const id of [buyerId, otherId]) await db.user.create({ data: { id, name: 'Synthetic attachment owner', email: `${id}@agent-assets.kivro.local`, passwordHash: 'disabled' } });
    await db.session.create({ data: { userId: buyerId, tokenHash: hashSecret(session), expiresAt: new Date(Date.now() + 600000) } });
    app = await createApp({ db, logger: false, mailer: null, env: { NODE_ENV: 'test', KIVRO_ENV: 'test', PAYMENT_MODE: 'fake', DATABASE_URL: databaseUrl,
      S3_ENDPOINT: 'http://127.0.0.1:59000', S3_BUCKET: 'unused-agent-assets', S3_ACCESS_KEY: 'unused', S3_SECRET_KEY: 'unused' } });
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    await app?.close();
    if (db) {
      if (!/^agent_assets_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe fixture schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await db.$disconnect();
    }
  });
  const asset = (patch: Record<string, unknown> = {}) => db.asset.create({ data: { ownerId: buyerId, kind: 'INPUT', filename: 'selected.csv', mimeType: 'text/csv',
    sizeBytes: 17, sha256: 'a'.repeat(64), objectKey: `private-unretrieved/${randomUUID()}`, scanStatus: 'CLEAN', expiresAt: new Date(Date.now() + 600000), ...patch } });

  it('returns canonical metadata in selection order, without storage keys, download URLs or content access', async () => {
    const first = await asset(), second = await asset({ filename: 'other.csv', sizeBytes: 29 });
    const result = await resolveAgentInputAssets(app.kivro, buyerId, [second.id, first.id]);
    expect(result.map(row => row.id)).toEqual([second.id, first.id]);
    expect(result[0]).toEqual({ id: second.id, filename: 'other.csv', mimeType: 'text/csv', sizeBytes: 29, sha256: 'a'.repeat(64), expiresAt: second.expiresAt.toISOString() });
    expect(JSON.stringify(result)).not.toContain('private-unretrieved');
    expect(await db.assetGrant.count()).toBe(0); expect(await db.job.count()).toBe(0); expect(await db.ledgerEntry.count()).toBe(0);
  });

  it.each([
    ['another owner', () => ({ ownerId: otherId })],
    ['expired', () => ({ expiresAt: new Date(Date.now() - 1) })],
    ['deleted', () => ({ deletedAt: new Date() })],
    ['unscanned', () => ({ scanStatus: 'PENDING' })],
    ['blocked', () => ({ scanStatus: 'INFECTED' })],
  ] as const)('denies %s attachments without creating authorization or purchase state', async (_reason, patch) => {
    const file = await asset(patch());
    await expect(resolveAgentInputAssets(app.kivro, buyerId, [file.id])).rejects.toMatchObject({ statusCode: 403, code: 'AGENT_ASSET_NOT_AVAILABLE' });
    expect(await db.assetGrant.count()).toBe(0); expect(await db.ledgerEntry.count()).toBe(0);
  });

  it('does not return a partial list or distinguish a missing ID from an inaccessible file', async () => {
    const file = await asset();
    await expect(resolveAgentInputAssets(app.kivro, buyerId, [file.id, randomUUID()])).rejects.toMatchObject({ code: 'AGENT_ASSET_NOT_AVAILABLE' });
  });

  it('validates distinct bounded UUID selectors before touching a database', async () => {
    const unavailable = { ...app.kivro, db: undefined as unknown as PrismaClient };
    expect(await resolveAgentInputAssets(unavailable, buyerId, [])).toEqual([]);
    const id = randomUUID();
    for (const ids of [['path/to/file'], [id, id], Array.from({ length: 21 }, () => randomUUID())]) {
      await expect(resolveAgentInputAssets(unavailable, buyerId, ids)).rejects.toMatchObject({ name: 'ZodError' });
    }
  });

  it('accepts development-only scans only in development, not staging or production', async () => {
    const file = await asset({ scanStatus: 'DEVELOPMENT_ONLY' });
    const context = (development: boolean) => ({ ...app.kivro, config: { ...app.kivro.config, development } });
    expect(await resolveAgentInputAssets(context(true), buyerId, [file.id])).toHaveLength(1);
    await expect(resolveAgentInputAssets(context(false), buyerId, [file.id])).rejects.toMatchObject({ code: 'AGENT_ASSET_NOT_AVAILABLE' });
  });

  it('requires a successful owned job before reusing generated output metadata', async () => {
    const cap = await db.capability.create({ data: { sellerId: otherId, slug: randomUUID(), schedule: DEFAULT_SCHEDULE } });
    const version = await db.capabilityVersion.create({ data: { capabilityId: cap.id, version: 1, title: 'Fixture', summary: 'Fixture', description: '', category: 'Documents', tags: [],
      priceTierId: 'USD_99', ioContract: {}, permissions: {}, dependencies: [], internalInstructions: 'private', manifestHash: 'b'.repeat(64) } });
    for (const [state, owner, allowed] of [['RUNNING', buyerId, false], ['SUCCEEDED', otherId, false], ['SUCCEEDED', buyerId, true]] as const) {
      const job = await db.job.create({ data: { buyerId: owner, sellerId: otherId, capabilityId: cap.id, capabilityVersionId: version.id, state, input: {}, priceSnapshot: getPriceTier('USD_99'),
        buyerPriceMinor: 99, sellerNetMinor: 80, platformFeeMinor: 19, executionMode: 'NOW', waitDeadline: new Date(Date.now() + 600000) } });
      const file = await asset({ kind: 'OUTPUT', jobId: job.id });
      const result = resolveAgentInputAssets(app.kivro, buyerId, [file.id]);
      if (allowed) expect(await result).toHaveLength(1);
      else await expect(result).rejects.toMatchObject({ code: 'AGENT_ASSET_NOT_AVAILABLE' });
    }
  });

  const chat = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/agent/chat',
    headers: { cookie: `kivro_session=${session}`, origin: 'http://localhost:3000' },
    payload: { message: 'Find a capability for my selected document', budgetMinor: 999, ...body } });
  const observeInitialization = () => vi.spyOn(app.kivro as typeof app.kivro & { initializeInferenceRouting(): Promise<void> }, 'initializeInferenceRouting').mockResolvedValue(undefined);
  const agentQuota = () => db.abuseBucket.findMany({ where: { key: { in: [-1, 0, 1].map(offset =>
    createHash('sha256').update(`agent-turns:${buyerId}:${Math.floor(Date.now() / 86400_000) + offset}`).digest('hex')) } }, orderBy: { key: 'asc' } });

  it.each(['inputAssets', 'userId'])('rejects client-supplied %s before inference initialization or quota consumption', async field => {
    const initialize = observeInitialization();
    const turn = vi.spyOn(MarketplaceAgent.prototype, 'chat');
    const quotaBefore = await agentQuota();
    const result = await chat({ [field]: field === 'userId' ? otherId : [{ id: randomUUID(), mimeType: 'text/plain' }] });
    expect(result.statusCode, result.body).toBe(400);
    expect(result.json().error.code).toBe('VALIDATION_ERROR');
    expect(initialize).not.toHaveBeenCalled(); expect(turn).not.toHaveBeenCalled();
    expect(await agentQuota()).toEqual(quotaBefore);
  });

  it('rejects an inaccessible selected ID at the authenticated route before any inference or quota state', async () => {
    const file = await asset({ ownerId: otherId });
    const initialize = observeInitialization();
    const turn = vi.spyOn(MarketplaceAgent.prototype, 'chat');
    const quotaBefore = await agentQuota();
    const result = await chat({ inputAssetIds: [file.id] });
    expect(result.statusCode, result.body).toBe(403);
    expect(result.json().error.code).toBe('AGENT_ASSET_NOT_AVAILABLE');
    expect(initialize).not.toHaveBeenCalled(); expect(turn).not.toHaveBeenCalled();
    expect(await agentQuota()).toEqual(quotaBefore);
  });

  it('passes only owner-resolved metadata and explicit output requirements across the chat route', async () => {
    const file = await asset();
    const initialize = observeInitialization();
    const turn = vi.spyOn(MarketplaceAgent.prototype, 'chat').mockResolvedValue({ conversationId: randomUUID(), message: 'Synthetic response', recommendations: [], inferenceStatus: 'UNAVAILABLE' });
    const requiredOutputFiles = [{ mimeType: 'application/pdf', extension: '.pdf', count: 1 }];
    const result = await chat({ inputAssetIds: [file.id], requiredOutputFiles });
    expect(result.statusCode, result.body).toBe(200);
    expect(initialize).toHaveBeenCalledOnce(); expect(turn).toHaveBeenCalledOnce();
    expect((await agentQuota()).reduce((total, row) => total + row.hits, 0)).toBe(1);
    expect(turn.mock.calls[0]![0]).toMatchObject({ userId: buyerId, inputAssetIds: [file.id], requiredOutputFiles,
      inputAssets: [{ id: file.id, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes, sha256: file.sha256 }] });
    expect(JSON.stringify(turn.mock.calls[0])).not.toContain('private-unretrieved');
    expect(JSON.stringify(turn.mock.calls[0])).not.toContain('downloadUrl');
    expect(await db.assetGrant.count()).toBe(0); expect(await db.ledgerEntry.count()).toBe(0);
  });
});
