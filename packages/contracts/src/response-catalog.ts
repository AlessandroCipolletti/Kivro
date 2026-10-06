import { z } from 'zod';
import { PublicationEvidenceSchema } from './publication-evidence.ts';
import { AssetDTOSchema, CapabilityDTOSchema, JobDTOSchema, JobOutputSchema, PriceTierSchema, ScheduleSchema } from './index.ts';
import { count, isoDate, jsonObject, jsonValue, okResponseSchema, responseRoutes, sha256, uuid, type ResponseRoute } from './response-common.ts';

export const publicCapabilityResponseSchema = CapabilityDTOSchema.strict();
export const sellerCapabilityLiveStateSchema = z.object({
  observedAt: isoDate, runningJobs: count, queueDepth: count, scheduledJobs: count, effectiveConcurrency: count, capacityLoad: count,
  lastSuccess: z.object({ jobId: uuid, capabilityVersionId: uuid, completedAt: isoDate }).strict().nullable(),
}).strict();
export type SellerCapabilityLiveState = z.infer<typeof sellerCapabilityLiveStateSchema>;
const sellerCapability = publicCapabilityResponseSchema.extend({
  lifecycleRevision: count, concurrency: count, maxQueue: count, maxScheduled: count, currentVersionId: uuid.nullable(), draftVersionId: uuid.nullable(),
  liveState: sellerCapabilityLiveStateSchema,
  internalInstructions: z.string().optional(), manifestHash: sha256.optional(), testPassedAt: isoDate.nullable().optional(), paused: z.boolean().optional(),
});
const summary = z.object({ id: uuid, version: z.number().int().positive(), title: z.string(),
  state: z.enum(['DRAFT', 'TESTING', 'READY_TO_PUBLISH', 'PUBLISHED', 'RETIRED']), isActive: z.boolean(), isDraft: z.boolean(),
  createdAt: isoDate, publishedAt: isoDate.nullable(), retiredAt: isoDate.nullable(), testPassedAt: isoDate.nullable(), consentAt: isoDate.nullable(),
  manifestHash: sha256, priceTierId: z.string(), readiness: z.object({ ready: z.boolean(), reasons: z.array(z.string()) }).strict(),
  publicationEvidence: PublicationEvidenceSchema.nullable().optional(),
  exampleIssues: z.array(z.object({ id: z.string(), code: z.string() }).strict()),
}).strict();
const history = z.object({ capabilityId: uuid, currentVersionId: uuid.nullable(), draftVersionId: uuid.nullable(), lifecycleRevision: count,
  visibility: CapabilityDTOSchema.shape.visibility, versions: z.array(summary), nextCursor: z.string().nullable() }).strict();
const detail = summary.merge(CapabilityDTOSchema.pick({ title: true, summary: true, description: true, category: true, tags: true,
  ioContract: true, permissions: true, dependencies: true, estimatedDurationSeconds: true })).extend({
  capabilityId: uuid, currentVersionId: uuid.nullable(), draftVersionId: uuid.nullable(), lifecycleRevision: count, internalInstructions: z.string(),
  // Draft examples remain editable even when their contract validation reports issues.
  examples: z.array(jsonObject),
}).strict();
const diff = z.object({ lifecycleRevision: count, fromVersionId: uuid.nullable(), toVersionId: uuid, diffHash: sha256, permissionExpansion: z.boolean(),
  changes: z.array(z.object({ path: z.string(), category: z.enum(['SKILLS', 'INFERENCE', 'PERMISSIONS', 'INPUTS', 'OUTPUTS', 'PRICE', 'RUNTIME', 'METADATA', 'EXAMPLES']), before: jsonValue, after: jsonValue }).strict()),
  warnings: z.array(z.object({ code: z.string(), path: z.string() }).strict()),
}).strict();
const review = z.object({ id: uuid, rating: z.number().int().min(1).max(5), comment: z.string(), createdAt: isoDate }).strict();
const ownReview = review.extend({ reviewHash: sha256 });
export const uploadResponseSchema = z.object({ id: uuid, uploadUrl: z.string().url(), method: z.literal('PUT'),
  headers: z.object({ 'content-type': z.string() }).strict(), expiresAt: isoDate, uploadUrlExpiresAt: isoDate }).strict();
const versionsPath = '/api/seller/capabilities/:id/versions';
const examplesPath = `${versionsPath}/:versionId/examples`;

export const catalogResponseRoutes: ResponseRoute[] = [
  ...responseRoutes('GET', ['/api/capabilities'], z.array(publicCapabilityResponseSchema)),
  ...responseRoutes('GET', ['/api/capabilities/page'], z.object({ items: z.array(publicCapabilityResponseSchema), nextCursor: z.string().nullable(), total: count }).strict()),
  ...responseRoutes('GET', ['/api/capabilities/:idOrSlug'], publicCapabilityResponseSchema),
  ...responseRoutes('POST', ['/api/capabilities/:id/favorite'], z.object({ isFavorite: z.boolean() }).strict()),
  ...responseRoutes('GET', ['/api/seller/capabilities'], z.array(sellerCapability)),
  ...responseRoutes('POST', ['/api/seller/capabilities', '/api/seller/capabilities/:id/publish'], sellerCapability),
  ...responseRoutes('PUT', ['/api/seller/capabilities/:id'], sellerCapability),
  ...responseRoutes('POST', ['/api/seller/capabilities/:id/pause'], z.object({ paused: z.boolean() }).strict()),
  ...responseRoutes('PUT', ['/api/seller/capabilities/:id/schedule'], z.object({ schedule: ScheduleSchema }).strict()),
  ...responseRoutes('POST', ['/api/seller/capabilities/:id/grants'], okResponseSchema),
  ...responseRoutes('GET', [versionsPath], history),
  ...responseRoutes('GET', [`${versionsPath}/:versionId`], detail),
  ...responseRoutes('GET', [`${versionsPath}/:versionId/diff`], diff),
  ...responseRoutes('POST', [`${versionsPath}/:versionId/activate`, `${versionsPath}/:versionId/retire`, `${versionsPath}/:versionId/testing`, '/api/seller/capabilities/:id/visibility'], history),
  ...responseRoutes('GET', ['/api/capabilities/:id/reviews'], z.array(review.extend({ user: z.object({ name: z.string() }).strict() }))),
  ...responseRoutes('GET', ['/api/capabilities/:id/reviews/summary'], z.object({ averageRating: z.number().min(1).max(5).nullable(), reviewCount: count,
    distribution: z.array(z.object({ rating: z.number().int().min(1).max(5), count }).strict()).length(5) }).strict()),
  ...responseRoutes('GET', ['/api/jobs/:id/review'], z.object({ jobId: uuid, capabilityId: uuid, capabilityVersionId: uuid, capabilityVersionNumber: count,
    sellerId: uuid, eligible: z.boolean(), canEdit: z.boolean(), reason: z.string().nullable(), review: ownReview.nullable(),
    policy: z.object({ editWindowDays: count, editDeadlineAt: isoDate.nullable() }).strict() }).strict()),
  ...responseRoutes('POST', ['/api/capabilities/:id/reviews'], ownReview),
  ...responseRoutes('PUT', ['/api/jobs/:id/review'], ownReview),
  ...responseRoutes('GET', ['/api/jobs', '/api/seller/jobs'], z.array(JobDTOSchema.strict())),
  ...responseRoutes('GET', ['/api/jobs/:id'], JobDTOSchema.strict()),
  ...responseRoutes('POST', ['/api/jobs', '/api/jobs/:id/cancel', '/api/jobs/:id/pause', '/api/jobs/:id/resume'], JobDTOSchema.strict()),
  ...responseRoutes('POST', ['/api/capabilities/:id/quote'], z.object({ id: uuid, priceSnapshot: PriceTierSchema,
    earliestStartAt: isoDate, estimatedDeliveryAt: isoDate, expiresAt: isoDate }).strict()),
  ...responseRoutes('POST', ['/api/assets/upload', '/api/assets/uploads/:id/finalize', '/api/worker/jobs/:id/assets', '/api/worker/jobs/:id/uploads/:uploadId/finalize'], AssetDTOSchema),
  ...responseRoutes('POST', ['/api/assets/uploads', '/api/worker/jobs/:id/uploads'], uploadResponseSchema),
  ...responseRoutes('GET', [`${examplesPath}/from-job/:jobId`], z.object({ jobId: uuid, capabilityVersionId: uuid, targetVersionId: uuid, input: jsonObject,
    outputValue: JobOutputSchema, inputAssets: z.array(AssetDTOSchema), outputAssets: z.array(AssetDTOSchema) }).strict()),
  ...responseRoutes('POST', [examplesPath, `${examplesPath}/from-job`], history),
  ...responseRoutes('POST', ['/api/seller/capabilities/:id/example-assets/:assetId/revoke'], z.object({ revoked: z.literal(true), lifecycleRevision: count }).strict()),
  ...responseRoutes('POST', ['/api/capabilities/:id/examples/:exampleId/template'], z.object({ capabilityId: uuid, capabilityVersionId: uuid, input: jsonObject, assets: z.array(AssetDTOSchema) }).strict()),
];
