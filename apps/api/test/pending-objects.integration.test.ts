import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient, serializable, type Transaction } from '@kivro/database';
import { createObjectStore, type S3ObjectStore } from '@kivro/storage';
import type { ApiContext } from '../src/context.js';
import { stageObject, commitObject, abandonObject, cleanupPendingObjects } from '../src/pending-objects.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('durable object publication with PostgreSQL and S3', () => {
  let db: PrismaClient, storage: S3ObjectStore, ctx: Pick<ApiContext, 'db' | 'storage'>;
  const schema = `pending_test_${randomBytes(8).toString('hex')}`, ownerId = randomUUID();
  const file = { ownerId, bytes: Buffer.from('Private publication fixture'), filename: 'private.txt', mimeType: 'text/plain' };
  const createAsset = (tx: Transaction, staged: Awaited<ReturnType<typeof stageObject>>, owner = ownerId) => tx.asset.create({
    data: { ownerId: owner, filename: file.filename, mimeType: file.mimeType, sizeBytes: staged.sizeBytes, sha256: staged.sha256, objectKey: staged.key,
      scanStatus: 'DEVELOPMENT_ONLY', expiresAt: new Date(Date.now() + 60_000) },
  });
  beforeAll(async () => {
    process.loadEnvFile('.env');
    const url = new URL(process.env.DATABASE_URL!);
    if (process.env.KIVRO_ENV !== 'development' || url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/kivro' || process.env.S3_ENDPOINT !== 'http://127.0.0.1:59000') throw new Error('Requires local development DB and S3');
    url.searchParams.set('schema', schema);
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url.toString() } });
    db = new PrismaClient({ datasourceUrl: url.toString() }); storage = createObjectStore();
    ctx = { db, storage };
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@pending.kivro.local`, name: 'Publication fixture', passwordHash: 'disabled' } });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (db) {
      for (const row of await db.pendingObject.findMany()) await storage.delete(row.objectKey);
      if (!/^pending_test_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe test schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await db.$disconnect();
    }
    storage?.client.destroy();
  });
  it('persists a known private key before PUT and publishes atomically', async () => {
    const putAt = storage.putAt.bind(storage);
    vi.spyOn(storage, 'putAt').mockImplementation(async (key, ...args) => {
      expect(await db.pendingObject.findUnique({ where: { objectKey: key } })).toMatchObject({ ownerId, committedAt: null });
      return putAt(key, ...args);
    });
    const staged = await stageObject(ctx, file);
    const asset = await serializable(db, async tx => {
      const created = await createAsset(tx, staged); await commitObject(tx, staged.pendingId, { assetId: created.id }); return created;
    });
    await db.pendingObject.update({ where: { id: staged.pendingId }, data: { expiresAt: new Date(0) } });
    await abandonObject(ctx, staged.pendingId); await cleanupPendingObjects(ctx);
    expect(await storage.get(asset.objectKey)).toEqual(file.bytes);
    expect(await db.pendingObject.findUnique({ where: { id: staged.pendingId } })).toMatchObject({ assetId: asset.id, deletedAt: null, cleanupStartedAt: null });
  });
  it('recovers a crash after S3 PUT and before database publication', async () => {
    const staged = await stageObject(ctx, file);
    await db.pendingObject.update({ where: { id: staged.pendingId }, data: { expiresAt: new Date(0) } });
    await cleanupPendingObjects(ctx); await cleanupPendingObjects(ctx);
    await expect(storage.get(staged.key)).rejects.toThrow();
    expect((await db.pendingObject.findUniqueOrThrow({ where: { id: staged.pendingId } })).deletedAt).not.toBeNull();
    expect(await db.asset.count({ where: { objectKey: staged.key } })).toBe(0);
  });
  it('retains cleanup intent after a lost PUT response and enforces its drain grace', async () => {
    const putAt = storage.putAt.bind(storage);
    vi.spyOn(storage, 'putAt').mockImplementationOnce(async (...args) => { await putAt(...args); throw new Error('Synthetic lost PUT acknowledgement'); });
    await expect(stageObject(ctx, file)).rejects.toThrow('lost PUT');
    const row = await db.pendingObject.findFirstOrThrow({ where: { committedAt: null, deletedAt: null, cleanupStartedAt: { not: null } }, orderBy: { createdAt: 'desc' } });
    await cleanupPendingObjects(ctx); expect(await storage.get(row.objectKey)).toEqual(file.bytes);
    await db.pendingObject.update({ where: { id: row.id }, data: { cleanupStartedAt: new Date(0) } });
    await cleanupPendingObjects(ctx); await expect(storage.get(row.objectKey)).rejects.toThrow();
  });
  it('rolls back publication to a different object and forbids expired stages', async () => {
    const staged = await stageObject(ctx, file), other = await stageObject(ctx, file);
    await expect(serializable(db, async tx => { const asset = await createAsset(tx, other); await commitObject(tx, staged.pendingId, { assetId: asset.id }); })).rejects.toMatchObject({ code: 'OBJECT_TARGET_MISMATCH' });
    expect(await db.asset.count({ where: { objectKey: other.key } })).toBe(0);
    await db.pendingObject.update({ where: { id: staged.pendingId }, data: { expiresAt: new Date(0) } });
    await expect(serializable(db, async tx => { const asset = await createAsset(tx, staged); await commitObject(tx, staged.pendingId, { assetId: asset.id }); })).rejects.toMatchObject({ code: 'OBJECT_PUBLICATION_EXPIRED' });
    expect(await db.asset.count({ where: { objectKey: staged.key } })).toBe(0);
    await abandonObject(ctx, other.pendingId);
  });
  it('retries failed cleanup without letting a publisher resurrect the object', async () => {
    const staged = await stageObject(ctx, file);
    await db.pendingObject.update({ where: { id: staged.pendingId }, data: { expiresAt: new Date(0) } });
    vi.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('Synthetic unavailable S3'));
    await expect(cleanupPendingObjects(ctx)).rejects.toThrow('unavailable S3');
    await expect(serializable(db, async tx => { const asset = await createAsset(tx, staged); await commitObject(tx, staged.pendingId, { assetId: asset.id }); })).rejects.toMatchObject({ code: 'OBJECT_PUBLICATION_EXPIRED' });
    await db.pendingObject.update({ where: { id: staged.pendingId }, data: { cleanupStartedAt: new Date(0) } });
    await cleanupPendingObjects(ctx); await expect(storage.get(staged.key)).rejects.toThrow();
  });
  it('refuses overwriting a published object key or using a caller path', async () => {
    const staged = await stageObject(ctx, file);
    await expect(storage.putAt(staged.key, Buffer.from('overwrite'), file.filename, file.mimeType)).rejects.toThrow();
    expect(await storage.get(staged.key)).toEqual(file.bytes);
    await expect(storage.putAt('../private', file.bytes, file.filename, file.mimeType)).rejects.toThrow('Invalid private object key');
  });
});
