import { z } from 'zod';
import { SignedJobNoticeSchema, SignedJobOfferSchema } from './index.ts';
import { isoDate, jsonObject, okResponseSchema, responseRoutes, uuid, type ResponseRoute } from './response-common.ts';
import { WorkerCommandSchema } from './worker-command.ts';
import { WorkerWarningSnapshotSchema } from './worker-warnings.ts';

export const pairingCodeResponseSchema = z.object({ code: z.string().regex(/^[A-F0-9]{24}$/), expiresAt: isoDate }).strict();
export const workerPairResponseSchema = z.object({ workerId: uuid, serverPublicKey: z.string().min(1).max(1024) }).strict();
export const workerHeartbeatResponseSchema = z.object({ commands: z.array(WorkerCommandSchema).max(100) }).strict();

const policyVersion = z.string().regex(/^[0-9A-Za-z.+-]{1,100}$/);
const policyReason = z.enum(['WORKER_UPDATE_REQUIRED', 'WORKER_VERSION_REVOKED', 'OPENCLAW_UPDATE_REQUIRED', 'OPENCLAW_VERSION_REVOKED']).nullable();
export const workerDiagnosticsResponseSchema = z.object({
  serverTime: isoDate, workerId: uuid, minimumWorkerVersion: policyVersion, minimumOpenClawVersion: policyVersion,
  revokedWorkerVersions: z.array(policyVersion).max(100), revokedOpenClawVersions: z.array(policyVersion).max(100), policyReason,
}).strict();
export const workerDiagnosticsV2ResponseSchema = workerDiagnosticsResponseSchema.extend({
  sellerId: uuid, deploymentEnvironment: z.enum(['production', 'staging', 'preview', 'development', 'test', 'unknown']),
  securityWarnings: WorkerWarningSnapshotSchema.optional(),
});

export const sellerWorkerResponseSchema = z.object({
  id: uuid, name: z.string(), version: z.string(), openclawVersion: z.string().nullable(),
  sandboxReady: z.boolean(), paused: z.boolean(), localPaused: z.boolean(), revokedAt: isoDate.nullable(), lastSeenAt: isoDate.nullable(),
  health: jsonObject, healthStatus: z.string(), runningJobIds: z.array(uuid), createdAt: isoDate,
  bindings: z.array(z.object({ capabilityVersionId: uuid, healthy: z.boolean() }).strict()),
  minimumWorkerVersion: policyVersion, minimumOpenClawVersion: policyVersion,
  latestSupportedWorkerVersion: policyVersion, latestSupportedOpenClawVersion: policyVersion, policyReason,
  healthHistory: z.array(z.object({ id: uuid, createdAt: isoDate, metadata: z.object({
    previous: z.string(), status: z.enum(['REVOKED', 'SECURITY_BLOCKED', 'PAUSED', 'OFFLINE', 'NOT_READY', 'READY']),
    reason: z.enum(['DEVICE_REVOKED', 'WORKER_UPDATE_REQUIRED', 'WORKER_VERSION_REVOKED', 'OPENCLAW_UPDATE_REQUIRED', 'OPENCLAW_VERSION_REVOKED',
      'PLATFORM_DISPATCH_DISABLED', 'SELLER_PAUSED', 'HEARTBEAT_EXPIRED', 'RUNTIME_NOT_READY', 'HEARTBEAT_HEALTHY']),
    version: z.string(), openclawVersion: z.string().nullable(),
  }).strict() }).strict()).max(50),
  securityWarnings: WorkerWarningSnapshotSchema.optional(),
}).strict();

export const workerOffersResponseSchema = z.object({ offers: z.array(SignedJobNoticeSchema) }).strict();
export const workerResponseRoutes: ResponseRoute[] = [
  ...responseRoutes('POST', ['/api/seller/pairing-code'], pairingCodeResponseSchema),
  ...responseRoutes('POST', ['/api/worker/pair'], workerPairResponseSchema),
  ...responseRoutes('POST', ['/api/worker/heartbeat'], workerHeartbeatResponseSchema),
  ...responseRoutes('GET', ['/api/worker/diagnostics'], workerDiagnosticsResponseSchema),
  ...responseRoutes('GET', ['/api/worker/diagnostics/v2'], workerDiagnosticsV2ResponseSchema),
  ...responseRoutes('GET', ['/api/worker/offers'], workerOffersResponseSchema),
  ...responseRoutes('GET', ['/api/worker/jobs/:id/payload'], SignedJobOfferSchema),
  ...responseRoutes('GET', ['/api/seller/workers'], z.array(sellerWorkerResponseSchema)),
  ...responseRoutes('POST', ['/api/worker/capabilities/:versionId/validation', '/api/worker/jobs/:id/events', '/api/worker/jobs/:id/result',
    '/api/worker/jobs/:id/usage', '/api/seller/workers/:id/pause', '/api/seller/workers/:id/resume', '/api/seller/workers/:id/revoke'], okResponseSchema),
];
