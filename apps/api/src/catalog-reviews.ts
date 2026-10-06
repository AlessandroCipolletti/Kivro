import { z } from 'zod';
import { hashManifest } from '@kivro/contracts';
import { Prisma, json, serializable, type Job, type Review, type Transaction } from '@kivro/database';
import type { FastifyInstance } from 'fastify';
import type { ApiContext } from './context.js';
import { requireIdentity } from './auth.js';
import { ApiError, requireValue } from './errors.js';
import { assertCapabilityAccess, loadCapability } from './catalog.js';

export const REVIEW_EDIT_WINDOW_DAYS = 30;
const ReviewContent = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(2000).default('') });
const publicReviewSelect = { id: true, rating: true, comment: true, createdAt: true, user: { select: { name: true } } } as const;
export function reviewHash(review: Pick<Review, 'id' | 'rating' | 'comment' | 'createdAt'>) {
  return hashManifest({ id: review.id, rating: review.rating, comment: review.comment, createdAt: review.createdAt.toISOString() });
}
function ownReview(review: Review) {
  return { id: review.id, rating: review.rating, comment: review.comment, createdAt: review.createdAt.toISOString(), reviewHash: reviewHash(review) };
}
export function reviewStatus(job: Pick<Job, 'buyerId' | 'sellerId' | 'state' | 'paymentState' | 'buyerPriceMinor'>, review: Review | null, now = new Date()) {
  const deadline = review ? new Date(review.createdAt.getTime() + REVIEW_EDIT_WINDOW_DAYS * 86400_000) : null;
  const baseReason = job.buyerId === job.sellerId ? 'SELF_REVIEW' : job.state !== 'SUCCEEDED' ? 'JOB_NOT_DELIVERED'
    : job.buyerPriceMinor <= 0 || (job.paymentState !== 'SETTLED' && !(review && job.paymentState === 'REFUNDED')) ? 'JOB_NOT_PAID' : null;
  const canEdit = !!review && !baseReason && now.getTime() < deadline!.getTime();
  return { eligible: !review && !baseReason, canEdit,
    reason: baseReason ?? (review ? canEdit ? 'ALREADY_REVIEWED' : 'REVIEW_EDIT_WINDOW_CLOSED' : null),
    review: review ? ownReview(review) : null, policy: { editWindowDays: REVIEW_EDIT_WINDOW_DAYS, editDeadlineAt: deadline?.toISOString() ?? null } };
}
async function lockReview(tx: Transaction, jobId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`review:${jobId}`}, 0))`;
}
async function buyerJob(tx: Transaction, jobId: string, buyerId: string) {
  return requireValue(await tx.job.findFirst({ where: { id: jobId, buyerId }, include: { review: true, version: { select: { version: true } } } }));
}

export function registerCatalogReviews(app: FastifyInstance, ctx: ApiContext) {
  app.get('/api/capabilities/:id/reviews', async request => {
    if (request.identity?.kind === 'api-key') requireIdentity(request, 'capabilities:read');
    const capability = await loadCapability(ctx.db, (request.params as { id: string }).id);
    await assertCapabilityAccess(ctx.db, capability, request.identity?.user.id);
    return ctx.db.review.findMany({ where: { capabilityId: capability.id }, take: 100, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], select: publicReviewSelect });
  });
  app.get('/api/capabilities/:id/reviews/summary', async request => {
    if (request.identity?.kind === 'api-key') requireIdentity(request, 'capabilities:read');
    const capability = await loadCapability(ctx.db, (request.params as { id: string }).id);
    await assertCapabilityAccess(ctx.db, capability, request.identity?.user.id);
    const groups = await ctx.db.review.groupBy({ by: ['rating'], where: { capabilityId: capability.id }, _count: true });
    const distribution = [1, 2, 3, 4, 5].map(rating => ({ rating, count: groups.find(group => group.rating === rating)?._count ?? 0 }));
    const reviewCount = distribution.reduce((total, group) => total + group.count, 0);
    return { averageRating: reviewCount ? distribution.reduce((total, group) => total + group.rating * group.count, 0) / reviewCount : null, reviewCount, distribution };
  });
  app.get('/api/jobs/:id/review', async request => {
    const { user } = requireIdentity(request, 'jobs:read'), id = z.string().uuid().parse((request.params as { id: string }).id);
    const job = await buyerJob(ctx.db, id, user.id);
    return { jobId: job.id, capabilityId: job.capabilityId, capabilityVersionId: job.capabilityVersionId, capabilityVersionNumber: job.version.version,
      sellerId: job.sellerId, ...reviewStatus(job, job.review) };
  });
  app.post('/api/capabilities/:id/reviews', async request => {
    const { user } = requireIdentity(request), capabilityId = (await loadCapability(ctx.db, (request.params as { id: string }).id)).id;
    const { jobId, ...content } = ReviewContent.extend({ jobId: z.string().uuid() }).strict().parse(request.body);
    try {
      return await serializable(ctx.db, async tx => {
        await lockReview(tx, jobId);
        const job = await tx.job.findFirst({ where: { id: jobId, capabilityId, buyerId: user.id }, include: { review: true } });
        if (!job) throw new ApiError(403, 'REVIEW_NOT_ELIGIBLE', 'Only the buyer of a successfully settled paid job can review it');
        if (job.review) throw new ApiError(409, 'REVIEW_ALREADY_EXISTS', 'This job already has a review');
        if (!reviewStatus(job, null).eligible) throw new ApiError(403, 'REVIEW_NOT_ELIGIBLE', 'Only the buyer of a successfully settled paid job can review it');
        const review = await tx.review.create({ data: { userId: user.id, capabilityId, jobId, ...content } });
        await tx.auditEvent.create({ data: { actorId: user.id, sellerId: job.sellerId, jobId, type: 'REVIEW_CREATED', metadata: json({ reviewId: review.id, capabilityId, capabilityVersionId: job.capabilityVersionId, ...content }) } });
        return ownReview(review);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ApiError(409, 'REVIEW_ALREADY_EXISTS', 'This job already has a review');
      throw error;
    }
  });
  app.put('/api/jobs/:id/review', async request => {
    const { user } = requireIdentity(request), jobId = z.string().uuid().parse((request.params as { id: string }).id);
    const { expectedReviewHash, ...content } = ReviewContent.extend({ expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body);
    return serializable(ctx.db, async tx => {
      await lockReview(tx, jobId);
      const job = await buyerJob(tx, jobId, user.id), review = requireValue(job.review, 'REVIEW_NOT_FOUND', 'Submit a review before editing');
      const status = reviewStatus(job, review);
      if (!status.canEdit) throw new ApiError(409, status.reason ?? 'REVIEW_NOT_EDITABLE', 'This review cannot be edited under the current review policy', status.policy);
      if (reviewHash(review) !== expectedReviewHash) throw new ApiError(409, 'REVIEW_CONFLICT', 'The review changed; reload it before editing');
      if (review.rating === content.rating && review.comment === content.comment) return ownReview(review);
      const updated = await tx.review.update({ where: { id: review.id }, data: content });
      await tx.auditEvent.create({ data: { actorId: user.id, sellerId: job.sellerId, jobId, type: 'REVIEW_EDITED', metadata: json({ reviewId: review.id, capabilityId: job.capabilityId,
        capabilityVersionId: job.capabilityVersionId, previous: { rating: review.rating, comment: review.comment }, next: content, expectedReviewHash, reviewHash: reviewHash(updated) }) } });
      return ownReview(updated);
    });
  });
}
