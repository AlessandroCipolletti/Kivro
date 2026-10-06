import { z } from 'zod';
import { PriceTierSchema } from './index.ts';
import { count, isoDate, okResponseSchema, responseRoutes, sha256, uuid, type ResponseRoute } from './response-common.ts';

export const publicUserResponseSchema = z.object({
  id: uuid, name: z.string(), email: z.string().email(), bio: z.string().nullable(),
  emailVerifiedAt: isoDate.nullable(), termsAcceptedVersion: z.string().nullable(), termsAcceptedAt: isoDate.nullable(), isAdmin: z.boolean(),
}).strict();
const userResponse = z.object({ user: publicUserResponseSchema }).strict();
const apiKey = z.object({ id: uuid, name: z.string(), prefix: z.string(), scopes: z.array(z.string()),
  expiresAt: isoDate.nullable(), revokedAt: isoDate.nullable(), lastUsedAt: isoDate.nullable(), createdAt: isoDate }).strict();
const report = z.object({ id: uuid, reporterId: uuid, jobId: uuid.nullable(), capabilityId: uuid.nullable(),
  category: z.enum(['ABUSE', 'PRIVACY', 'QUALITY', 'DELIVERY', 'PAYMENT', 'OTHER']), description: z.string(),
  status: z.enum(['OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED']), resolution: z.string().nullable(), revision: count,
  createdAt: isoDate, updatedAt: isoDate }).strict();
const webhookDelivery = z.object({ id: uuid, eventId: uuid, attempts: count, deliveredAt: isoDate.nullable(), failedAt: isoDate.nullable(),
  lastStatus: z.number().int().nullable(), lastError: z.string().nullable(), nextAttemptAt: isoDate,
  status: z.enum(['DELIVERED', 'FAILED', 'DISABLED', 'RETRYING', 'PENDING']) }).strict();
const webhook = z.object({ id: uuid, url: z.string().url(), events: z.array(z.string()), enabled: z.boolean(), failureCount: count,
  lastSuccessAt: isoDate.nullable(), lastFailureAt: isoDate.nullable(), createdAt: isoDate,
  status: z.enum(['DISABLED', 'DEGRADED', 'ACTIVE']), deliveries: z.array(webhookDelivery) }).strict();
const securityPolicy = z.object({ revision: count, minimumWorkerVersion: z.string(), minimumOpenClawVersion: z.string(),
  revokedWorkerVersions: z.array(z.string()), revokedOpenClawVersions: z.array(z.string()), blockedCategories: z.array(z.string()) }).strict();
const health = z.object({ status: z.literal('ok'), service: z.literal('kivro-api'), serverTime: isoDate }).strict();
export const readyResponseSchema = z.object({ status: z.enum(['ready', 'unavailable']), services: z.object({
  database: z.enum(['ready', 'unavailable']), storage: z.enum(['ready', 'unavailable']), redis: z.enum(['ready', 'unavailable']),
}).strict() }).strict();

export const accountResponseRoutes: ResponseRoute[] = [
  ...responseRoutes('GET', ['/health', '/health/live', '/api/health'], health),
  ...responseRoutes('GET', ['/ready', '/health/ready', '/api/ready'], readyResponseSchema),
  ...responseRoutes('GET', ['/api/config'], z.object({ priceTiers: z.array(PriceTierSchema), categories: z.array(z.string()),
    devMode: z.boolean(), paymentMode: z.enum(['fake', 'stripe']), paymentPolicy: z.object({
      version: z.literal('PREPAID_USD_V1'), currency: z.literal('USD'), processingFeeBearer: z.literal('PLATFORM'),
      taxAssessment: z.literal('UNASSESSED'), buyerTotalBasis: z.literal('PREPAID_CREDIT_RESERVATION'),
      failurePolicy: z.literal('NO_VALIDATED_DELIVERY_NO_SETTLEMENT'),
    }).strict() }).strict()),
  ...responseRoutes('GET', ['/api/auth/me'], z.object({ user: publicUserResponseSchema.nullable() }).strict()),
  ...responseRoutes('POST', ['/api/auth/register', '/api/auth/login', '/api/auth/dev-login', '/api/account/terms'], userResponse),
  ...responseRoutes('PUT', ['/api/account'], userResponse),
  ...responseRoutes('POST', ['/api/auth/logout', '/api/account/password', '/api/auth/password-reset/confirm', '/api/auth/email-verification/confirm'], okResponseSchema),
  ...responseRoutes('POST', ['/api/auth/password-reset/request', '/api/auth/email-verification/request'], okResponseSchema.extend({ message: z.string() })),
  ...responseRoutes('GET', ['/api/terms'], z.object({ version: z.string(), text: z.string(), sha256, preliminary: z.boolean() }).strict()),
  ...responseRoutes('GET', ['/api/api-keys'], z.array(apiKey)),
  ...responseRoutes('POST', ['/api/api-keys'], apiKey.pick({ id: true, name: true, prefix: true, scopes: true }).extend({ secret: z.string().min(1) })),
  ...responseRoutes('DELETE', ['/api/api-keys', '/api/api-keys/:id', '/api/webhooks', '/api/webhooks/:id'], okResponseSchema),
  ...responseRoutes('GET', ['/api/reports', '/api/admin/reports'], z.array(report)),
  ...responseRoutes('POST', ['/api/reports'], report),
  ...responseRoutes('PUT', ['/api/admin/reports/:id'], report),
  ...responseRoutes('GET', ['/api/webhooks'], z.array(webhook)),
  ...responseRoutes('POST', ['/api/webhooks'], webhook.pick({ id: true, url: true, events: true, enabled: true }).extend({ secret: z.string().min(1) })),
  ...responseRoutes('POST', ['/api/webhooks/:id/test'], z.object({ deliveryId: uuid, status: z.literal('PENDING') }).strict()),
  ...responseRoutes('GET', ['/api/admin/security-policy'], securityPolicy),
  ...responseRoutes('PUT', ['/api/admin/security-policy'], securityPolicy),
  ...responseRoutes('GET', ['/api/admin/workers'], z.array(z.object({ id: uuid, sellerId: uuid, name: z.string(), version: z.string(),
    openclawVersion: z.string().nullable(), revokedAt: isoDate.nullable(), paused: z.boolean(), localPaused: z.boolean(), sandboxReady: z.boolean(),
    lastSeenAt: isoDate.nullable(), policyReason: z.string().nullable(), minimumWorkerVersion: z.string(), minimumOpenClawVersion: z.string() }).strict())),
  ...responseRoutes('GET', ['/api/admin/capabilities'], z.array(z.object({ id: uuid, sellerId: uuid, paused: z.boolean(), securityBlocked: z.boolean(),
    visibility: z.enum(['DRAFT', 'PRIVATE', 'UNLISTED', 'PUBLIC']), currentVersion: z.object({ title: z.string(), category: z.string(), version: count }).strict().nullable() }).strict())),
  ...responseRoutes('POST', ['/api/admin/capabilities/:id/security', '/api/admin/workers/:id/revoke'], okResponseSchema),
];
