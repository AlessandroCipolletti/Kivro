import { z } from 'zod';
import { PRICE_TIERS, hashManifest, getPriceTier } from '@kivro/contracts';
import type { Prisma } from '@kivro/database';
import type { FastifyInstance } from 'fastify';
import type { ApiContext } from './context.js';
import { requireIdentity } from './auth.js';
import { ApiError } from './errors.js';
import { activeStates, availability, capabilityDto, capabilityInclude, terminalStates, type CapabilityRecord, type CatalogMetrics } from './catalog.js';
import { loadSecurityPolicy } from './security-policy.js';
import { pendingCapacity, type PendingCapacity } from './pending-capacity.js';

export const CatalogPageQuery = z.object({
  q: z.string().trim().max(200).default(''), category: z.string().max(100).optional(), sellerId: z.string().uuid().optional(),
  minPrice: z.coerce.number().int().nonnegative().optional(), maxPrice: z.coerce.number().int().nonnegative().optional(),
  minRating: z.coerce.number().min(0).max(5).optional(), outputType: z.enum(['TEXT', 'JSON', 'FILES', 'MIXED']).optional(),
  maxDurationSeconds: z.coerce.number().int().positive().max(3600).optional(), favorites: z.enum(['true', 'false']).default('false'),
  availability: z.enum(['ALL', 'NOW', 'TODAY', 'SCHEDULABLE', 'ONLINE', 'BUSY', 'SCHEDULED_OFFLINE', 'OFFLINE', 'PAUSED', 'SECURITY_BLOCKED']).default('ALL'),
  timezone: z.string().max(100).default('UTC').refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Unknown timezone'),
  sort: z.enum(['RELEVANCE', 'NEWEST', 'PRICE_ASC', 'PRICE_DESC', 'RATING', 'POPULAR', 'FASTEST']).default('RELEVANCE'),
  limit: z.coerce.number().int().min(1).max(100).default(24), cursor: z.string().max(2048).optional(),
}).strict().refine(value => value.minPrice === undefined || value.maxPrice === undefined || value.minPrice <= value.maxPrice, 'Minimum price exceeds maximum price');
type Query = z.infer<typeof CatalogPageQuery>;
const Cursor = z.object({ v: z.literal(1), fingerprint: z.string().length(64), asOf: z.string().datetime(), id: z.string().uuid(), rank: z.array(z.number().finite()).min(1).max(8) }).strict();
type Ranked = { id: string; rank: number[]; cap: CapabilityRecord; metrics: CatalogMetrics };
function compare(a: Pick<Ranked, 'rank' | 'id'>, b: Pick<Ranked, 'rank' | 'id'>) {
  for (let i = 0; i < Math.max(a.rank.length, b.rank.length); i++) { const delta = (a.rank[i] ?? 0) - (b.rank[i] ?? 0); if (delta) return delta; }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function rank(cap: CapabilityRecord, metrics: CatalogMetrics, query: Query): number[] {
  const version = cap.currentVersion!, price = getPriceTier(version.priceTierId).buyerPriceMinor, online = metrics.availability.canRunNow ? -1 : 0;
  const created = -cap.createdAt.getTime(), rating = -(metrics.rating ?? -1);
  if (query.sort === 'NEWEST') return [created];
  if (query.sort === 'PRICE_ASC') return [price, online, created];
  if (query.sort === 'PRICE_DESC') return [-price, online, created];
  if (query.sort === 'RATING') return [rating, -metrics.reviewCount, online, created];
  if (query.sort === 'POPULAR') return [-metrics.completedJobs, online, rating, created];
  if (query.sort === 'FASTEST') return [version.estimatedDurationSeconds, online, rating, created];
  const term = query.q.toLowerCase();
  const score = !term ? 0 : (version.title.toLowerCase() === term ? 100 : version.title.toLowerCase().includes(term) ? 40 : 0) +
    (version.summary.toLowerCase().includes(term) ? 10 : 0) + (version.description.toLowerCase().includes(term) ? 5 : 0) +
    (version.tags.some(tag => tag.toLowerCase() === term) ? 20 : 0) + (cap.seller.name.toLowerCase().includes(term) ? 10 : 0);
  return [-score, rating, online, -metrics.completedJobs, created];
}
function matchesAvailability(metrics: CatalogMetrics, query: Query, now: Date) {
  const status = metrics.availability;
  if (query.availability === 'ALL') return true;
  if (query.availability === 'NOW') return status.canRunNow;
  if (query.availability === 'SCHEDULABLE') return ['ONLINE', 'BUSY', 'SCHEDULED_OFFLINE'].includes(status.status) && !!status.nextWindow;
  if (query.availability === 'TODAY') {
    if (status.canRunNow || status.canQueue) return true;
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: query.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    return status.status === 'SCHEDULED_OFFLINE' && !!status.nextAvailableAt && date.format(new Date(status.nextAvailableAt)) === date.format(now);
  }
  return status.status === query.availability;
}

export async function catalogPage(ctx: ApiContext, query: Query, userId?: string) {
  if (query.favorites === 'true' && !userId) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to see favorites');
  const { cursor: encoded, limit, ...filters } = query;
  const fingerprint = hashManifest({ ...filters, userId: query.favorites === 'true' ? userId : null });
  let cursor: z.infer<typeof Cursor> | undefined;
  if (encoded) {
    try { cursor = Cursor.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))); }
    catch { throw new ApiError(400, 'INVALID_CURSOR', 'Catalog cursor is invalid'); }
    if (cursor.fingerprint !== fingerprint || Date.parse(cursor.asOf) > Date.now()) throw new ApiError(400, 'INVALID_CURSOR', 'Cursor does not match these catalog filters');
  }
  const now = new Date(), asOf = cursor?.asOf ?? now.toISOString(), securityPolicy = await loadSecurityPolicy(ctx.db);
  const tiers = PRICE_TIERS.filter(tier => (query.minPrice === undefined || tier.buyerPriceMinor >= query.minPrice) && (query.maxPrice === undefined || tier.buyerPriceMinor <= query.maxPrice)).map(tier => tier.id);
  const where: Prisma.CapabilityWhereInput = { visibility: 'PUBLIC', currentVersionId: { not: null }, createdAt: { lte: new Date(asOf) }, seller: { suspendedAt: null },
    ...(query.sellerId ? { sellerId: query.sellerId } : {}), ...(query.favorites === 'true' ? { favorites: { some: { userId } } } : {}),
    currentVersion: { is: { publishedAt: { not: null }, priceTierId: { in: tiers }, ...(query.category ? { category: query.category } : {}),
      ...(query.outputType ? { ioContract: { path: ['output', 'type'], equals: query.outputType } } : {}),
      ...(query.maxDurationSeconds ? { estimatedDurationSeconds: { lte: query.maxDurationSeconds } } : {}) } },
    ...(query.q ? { OR: [{ currentVersion: { is: { OR: [{ title: { contains: query.q, mode: 'insensitive' } }, { summary: { contains: query.q, mode: 'insensitive' } },
      { description: { contains: query.q, mode: 'insensitive' } }, { tags: { has: query.q } }] } } }, { seller: { name: { contains: query.q, mode: 'insensitive' }, suspendedAt: null } }] } : {}) };
  let scanAfter: string | undefined, total = 0;
  const page: Ranked[] = [];
  const pendingBySeller = new Map<string, PendingCapacity>();
  // Dynamic schedule/dependency eligibility must be evaluated before pagination.
  // Scan bounded batches with grouped metrics, retaining only one ranked page.
  for (;;) {
    const caps = await ctx.db.capability.findMany({ where: { ...where, ...(scanAfter ? { id: { gt: scanAfter } } : {}) }, include: capabilityInclude, take: 200, orderBy: { id: 'asc' } });
    if (!caps.length) break;
    const ids = caps.map(cap => cap.id), versionIds = caps.map(cap => cap.currentVersionId!);
    const [reviews, jobs, bindings, favorites] = await Promise.all([
      ctx.db.review.groupBy({ by: ['capabilityId'], where: { capabilityId: { in: ids } }, _avg: { rating: true }, _count: true }),
      ctx.db.job.groupBy({ by: ['capabilityId', 'state'], where: { capabilityId: { in: ids } }, _count: true }),
      ctx.db.workerBinding.findMany({ where: { capabilityVersionId: { in: versionIds }, healthy: true, validationStatus: 'PASSED', validatedAt: { gt: new Date(Date.now() - 24 * 3600_000) } }, include: { worker: true } }),
      userId ? ctx.db.favorite.findMany({ where: { userId, capabilityId: { in: ids } } }) : Promise.resolve([]),
    ]);
    const workerIds = [...new Set(bindings.map(binding => binding.workerId))];
    const occupiedWorkerIds = workerIds.length ? (await ctx.db.job.findMany({
      where: { state: { in: [...activeStates] }, activeAttempt: { workerId: { in: workerIds } } },
      select: { activeAttempt: { select: { workerId: true } } },
    })).flatMap(job => job.activeAttempt ? [job.activeAttempt.workerId] : []) : [];
    for (const cap of caps) {
      if (!pendingBySeller.has(cap.sellerId)) pendingBySeller.set(cap.sellerId, await pendingCapacity(ctx, ctx.db, cap.sellerId, now));
      const review = reviews.find(row => row.capabilityId === cap.id), states = jobs.filter(row => row.capabilityId === cap.id);
      const runningJobs = states.filter(row => (activeStates as readonly string[]).includes(row.state)).reduce((sum, row) => sum + row._count, 0);
      const evidence = { runningJobs, queueDepth: states.find(row => row.state === 'QUEUED')?._count ?? 0, securityPolicy, occupiedWorkerIds, pending: pendingBySeller.get(cap.sellerId)!,
        bindings: bindings.filter(row => row.capabilityVersionId === cap.currentVersionId && row.validatedManifestHash === cap.currentVersion!.manifestHash) };
      const metrics: CatalogMetrics = { rating: review?._avg.rating ?? null, reviewCount: review?._count ?? 0,
        completedJobs: states.find(row => row.state === 'SUCCEEDED')?._count ?? 0,
        totalJobs: states.filter(row => (terminalStates as readonly string[]).includes(row.state)).reduce((sum, row) => sum + row._count, 0),
        isFavorite: favorites.some(row => row.capabilityId === cap.id), availability: await availability(ctx, cap, ctx.db, evidence) };
      if (query.minRating !== undefined && (metrics.rating === null || metrics.rating < query.minRating) || !matchesAvailability(metrics, query, now)) continue;
      total++;
      const candidate = { id: cap.id, cap, metrics, rank: rank(cap, metrics, query) };
      if (cursor && compare(candidate, cursor) <= 0) continue;
      page.push(candidate); page.sort(compare); if (page.length > limit + 1) page.pop();
    }
    scanAfter = caps.at(-1)!.id;
    if (caps.length < 200) break;
  }
  const selected = page.slice(0, limit), last = selected.at(-1);
  return { items: await Promise.all(selected.map(row => capabilityDto(ctx, row.cap, userId, false, row.metrics))), total,
    nextCursor: page.length > limit && last ? Buffer.from(JSON.stringify({ v: 1, fingerprint, asOf, id: last.id, rank: last.rank })).toString('base64url') : null };
}

export function registerCatalogPages(app: FastifyInstance, ctx: ApiContext) {
  app.get('/api/capabilities/page', async request => {
    if (request.identity?.kind === 'api-key') requireIdentity(request, 'capabilities:read');
    return catalogPage(ctx, CatalogPageQuery.parse(request.query), request.identity?.user.id);
  });
}
