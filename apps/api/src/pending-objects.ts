import { randomUUID } from 'node:crypto';
import { serializable, type Transaction } from '@kivro/database';
import { safeFilename } from '@kivro/storage';
import type { ApiContext } from './context.js';
import { ApiError, requireValue } from './errors.js';

const publicationTtlMs = 10 * 60_000;
const uploadDrainMs = 60_000;
type PublicationContext = Pick<ApiContext, 'db' | 'storage'>;

export async function stageObject(ctx: PublicationContext, file: { ownerId: string; bytes: Buffer; filename: string; mimeType: string }) {
  safeFilename(file.filename);
  const pending = await ctx.db.pendingObject.create({ data: { ownerId: file.ownerId, objectKey: `assets/${randomUUID()}`, expiresAt: new Date(Date.now() + publicationTtlMs) } });
  try {
    const stored = await ctx.storage.putAt(pending.objectKey, file.bytes, file.filename, file.mimeType);
    return { ...stored, pendingId: pending.id };
  } catch (error) { await abandonObject(ctx, pending.id).catch(() => undefined); throw error; }
}

export async function commitObject(tx: Transaction, pendingId: string, target: { assetId: string; exampleAssetId?: never } | { exampleAssetId: string; assetId?: never }) {
  const pending = requireValue(await tx.pendingObject.findUnique({ where: { id: pendingId } }));
  const asset = target.assetId ? await tx.asset.findUnique({ where: { id: target.assetId } }) : await tx.capabilityExampleAsset.findUnique({ where: { id: target.exampleAssetId! } });
  if (!asset || asset.ownerId !== pending.ownerId || asset.objectKey !== pending.objectKey || asset.deletedAt) throw new ApiError(409, 'OBJECT_TARGET_MISMATCH', 'The private object does not match its publication');
  const changed = await tx.pendingObject.updateMany({ where: { id: pendingId, committedAt: null, cleanupStartedAt: null, deletedAt: null, expiresAt: { gt: new Date() } },
    data: { ...target, committedAt: new Date() } });
  if (!changed.count) throw new ApiError(409, 'OBJECT_PUBLICATION_EXPIRED', 'Private object publication expired or cleanup has begun');
}

export async function abandonObject(ctx: PublicationContext, pendingId: string) {
  await ctx.db.pendingObject.updateMany({ where: { id: pendingId, committedAt: null, deletedAt: null, cleanupStartedAt: null }, data: { cleanupStartedAt: new Date() } });
}

export async function cleanupPendingObjects(ctx: PublicationContext) {
  const drainBefore = new Date(Date.now() - uploadDrainMs);
  const ready = { committedAt: null, deletedAt: null, OR: [
    { cleanupStartedAt: null, expiresAt: { lte: drainBefore } }, { cleanupStartedAt: { lte: drainBefore } },
  ] };
  const rows = await ctx.db.pendingObject.findMany({ where: ready, orderBy: { expiresAt: 'asc' }, take: 100 });
  for (const row of rows) {
    // Claim before external I/O; a concurrent publisher can no longer attach this key.
    const claimed = await serializable(ctx.db, tx => tx.pendingObject.updateMany({ where: { id: row.id, ...ready }, data: { cleanupStartedAt: new Date() } }));
    if (!claimed.count) continue;
    await ctx.storage.delete(row.objectKey);
    await ctx.db.pendingObject.updateMany({ where: { id: row.id, committedAt: null }, data: { deletedAt: new Date() } });
  }
  await ctx.db.pendingObject.deleteMany({ where: { deletedAt: { lt: new Date(Date.now() - 90 * 86400_000) }, committedAt: null } });
}
