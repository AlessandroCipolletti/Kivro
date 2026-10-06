import { z } from 'zod';
import { AssetDTOSchema, type AssetDTO } from '@kivro/contracts';
import type { ApiContext } from './context.js';
import { ApiError } from './errors.js';

const inputIds = z.array(z.string().uuid()).max(20)
  .refine(ids => new Set(ids).size === ids.length, 'Attachment IDs must be distinct');

/** Resolve metadata only; neither storage contents nor download grants enter discovery. */
export async function resolveAgentInputAssets(ctx: Pick<ApiContext, 'db' | 'config'>, userId: string, ids: string[]): Promise<AssetDTO[]> {
  inputIds.parse(ids);
  if (!ids.length) return [];
  const rows = await ctx.db.asset.findMany({ where: {
    id: { in: ids }, ownerId: userId, deletedAt: null, expiresAt: { gt: new Date() },
    scanStatus: { in: ctx.config.development ? ['CLEAN', 'DEVELOPMENT_ONLY'] : ['CLEAN'] },
    OR: [{ kind: 'INPUT' }, { kind: 'OUTPUT', job: { state: 'SUCCEEDED', buyerId: userId } }],
  }, select: { id: true, filename: true, mimeType: true, sizeBytes: true, sha256: true, expiresAt: true } });
  if (rows.length !== ids.length) throw new ApiError(403, 'AGENT_ASSET_NOT_AVAILABLE', 'An attachment is unavailable, expired, unverified, or not owned by you');
  const byId = new Map(rows.map(row => [row.id, row]));
  return ids.map(id => {
    const row = byId.get(id)!;
    return AssetDTOSchema.parse({ ...row, expiresAt: row.expiresAt.toISOString() });
  });
}
