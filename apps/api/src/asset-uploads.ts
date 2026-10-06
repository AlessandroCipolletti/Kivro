import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializable, type Transaction, type AssetUpload } from '@kivro/database';
import { PermissionManifestSchema } from '@kivro/contracts';
import { FILE_SAFETY_CEILINGS } from '@kivro/contracts/file-limits';
import { inspectFile, safeFilename, scanWithClamAv, sha256 } from '@kivro/storage';
import { requireIdentity } from './auth.js';
import type { ApiContext } from './context.js';
import { ApiError, requireValue } from './errors.js';
import { assetDto } from './jobs.js';
import { ownedAttempt } from './worker.js';
import { assertWorkerJobDataPolicy } from './security-policy.js';
import { stageObject, commitObject, abandonObject } from './pending-objects.js';

const UploadSchema = z.object({ filename: z.string().min(1).max(180), mimeType: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/).max(150),
  sizeBytes: z.number().int().positive().max(FILE_SAFETY_CEILINGS.singleFileBytes), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type UploadBody = z.infer<typeof UploadSchema>;
type Principal = { ownerId: string } | { workerId: string; jobId: string; attemptId: string };

async function requireActiveWorker(tx: Transaction, workerId: string) {
  const worker = requireValue(await tx.workerDevice.findUnique({ where: { id: workerId }, include: { seller: true } }));
  if (worker.revokedAt || worker.seller.suspendedAt) throw new ApiError(403, 'WORKER_REVOKED', 'Worker execution access was revoked');
}

async function authorize(tx: Transaction, ticket: AssetUpload, principal: Principal, finalized = false) {
  if ('ownerId' in principal) {
    if (ticket.kind !== 'INPUT' || ticket.ownerId !== principal.ownerId) throw new ApiError(404, 'NOT_FOUND', 'Upload not found');
    const user = await tx.user.findUniqueOrThrow({ where: { id: principal.ownerId } });
    if (user.suspendedAt) throw new ApiError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended');
  } else {
    if (ticket.kind !== 'OUTPUT' || ticket.workerId !== principal.workerId || ticket.jobId !== principal.jobId || ticket.attemptId !== principal.attemptId) throw new ApiError(404, 'NOT_FOUND', 'Upload not found');
    await requireActiveWorker(tx, principal.workerId);
    const job = await ownedAttempt(tx, principal.workerId, principal.jobId, principal.attemptId);
    await assertWorkerJobDataPolicy(tx, job.id, principal.workerId);
    if (!job.activeAttempt.acceptedAt) throw new ApiError(409, 'ATTEMPT_NOT_ACCEPTED', 'The Worker has not accepted this attempt');
    if (!finalized && (!['RUNNING', 'UPLOADING_RESULTS'].includes(job.state) || job.paymentState !== 'RESERVED')) throw new ApiError(409, 'INVALID_JOB_STATE', 'Only the current running attempt may finalize output');
  }
}

async function createUpload(ctx: ApiContext, principal: Principal, body: UploadBody) {
  if (!ctx.storage.uploadUrl) throw new ApiError(503, 'DIRECT_UPLOAD_UNAVAILABLE', 'Object storage does not support direct uploads');
  safeFilename(body.filename);
  if (body.sizeBytes > ctx.config.maxUploadBytes) throw new ApiError(413, 'FILE_TOO_LARGE', 'File exceeds the upload limit');
  const id = randomUUID(), objectKey = `quarantine/${id}`, expiresAt = new Date(Date.now() + 10 * 60_000);
  const ticket = await serializable(ctx.db, async tx => {
    let ownerId: string;
    if ('ownerId' in principal) {
      ownerId = principal.ownerId;
      const owner = await tx.user.findUniqueOrThrow({ where: { id: ownerId } });
      if (owner.suspendedAt) throw new ApiError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`uploads:${ownerId}`}, 0))`;
      const pending = await tx.assetUpload.count({ where: { ownerId, kind: 'INPUT', assetId: null, expiresAt: { gt: new Date() } } });
      if (pending >= 10) throw new ApiError(429, 'UPLOAD_LIMIT', 'Complete existing uploads or wait for them to expire');
    } else {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`output-assets:${principal.jobId}`}, 0))`;
      await requireActiveWorker(tx, principal.workerId);
      const job = await ownedAttempt(tx, principal.workerId, principal.jobId, principal.attemptId);
      await assertWorkerJobDataPolicy(tx, job.id, principal.workerId);
      if (!job.activeAttempt.acceptedAt) throw new ApiError(409, 'ATTEMPT_NOT_ACCEPTED', 'The Worker has not accepted this attempt');
      if (!['RUNNING', 'UPLOADING_RESULTS'].includes(job.state) || job.paymentState !== 'RESERVED') throw new ApiError(409, 'INVALID_JOB_STATE', 'Only the current running attempt may upload output');
      ownerId = job.buyerId;
      const limits = PermissionManifestSchema.parse(job.version.permissions).limits;
      const assets = await tx.asset.aggregate({ where: { jobId: job.id, attemptId: principal.attemptId, kind: 'OUTPUT', deletedAt: null }, _sum: { sizeBytes: true }, _count: true });
      const pending = await tx.assetUpload.aggregate({ where: { jobId: job.id, attemptId: principal.attemptId, assetId: null, expiresAt: { gt: new Date() } }, _sum: { sizeBytes: true }, _count: true });
      if (body.sizeBytes > ctx.config.fileLimits.workerFileBytes || assets._count + pending._count >= FILE_SAFETY_CEILINGS.maxFiles || (assets._sum.sizeBytes ?? 0) + (pending._sum.sizeBytes ?? 0) + body.sizeBytes > Math.min(ctx.config.fileLimits.outputBytes, limits.maxOutputBytes)) throw new ApiError(413, 'OUTPUT_TOO_LARGE', 'Output upload reservations exceed the effective job limits');
    }
    return tx.assetUpload.create({ data: { id, ownerId, objectKey, expiresAt, ...body,
      ...('workerId' in principal ? { ...principal, kind: 'OUTPUT' } : { kind: 'INPUT' }) } });
  });
  const uploadUrl = await ctx.storage.uploadUrl(objectKey, body.mimeType, body.sizeBytes, body.sha256, 300);
  return { id: ticket.id, uploadUrl, method: 'PUT', headers: { 'content-type': body.mimeType }, expiresAt: expiresAt.toISOString(), uploadUrlExpiresAt: new Date(Date.now() + 300_000).toISOString() };
}

async function finalizeUpload(ctx: ApiContext, id: string, principal: Principal) {
  const leaseId = randomUUID();
  const claim = await serializable(ctx.db, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`upload:${id}`}, 0))`;
    const ticket = requireValue(await tx.assetUpload.findUnique({ where: { id }, include: { asset: true } }));
    await authorize(tx, ticket, principal, !!ticket.asset);
    if (ticket.asset) {
      if (ticket.asset.deletedAt || ticket.asset.expiresAt <= new Date()) throw new ApiError(410, 'ASSET_EXPIRED', 'The finalized asset has expired');
      return { ticket, asset: ticket.asset };
    }
    if (ticket.expiresAt <= new Date()) throw new ApiError(410, 'UPLOAD_EXPIRED', 'The upload has expired');
    if (ticket.leaseExpiresAt && ticket.leaseExpiresAt > new Date()) throw new ApiError(409, 'UPLOAD_PROCESSING', 'The upload is being validated; retry shortly');
    await tx.assetUpload.update({ where: { id }, data: { leaseId, leaseExpiresAt: new Date(Date.now() + 180_000) } });
    return { ticket, asset: null };
  });
  if (claim.asset) return assetDto(claim.asset);
  const ticket = claim.ticket;
  let pendingId: string | undefined;
  try {
    if (ticket.sizeBytes > ctx.config.maxUploadBytes || 'workerId' in principal && ticket.sizeBytes > ctx.config.fileLimits.workerFileBytes) throw new ApiError(413, 'FILE_TOO_LARGE', 'File exceeds the current effective upload limit');
    const bytes = await ctx.storage.get(ticket.objectKey, ticket.sizeBytes);
    if (bytes.length !== ticket.sizeBytes || sha256(bytes) !== ticket.sha256) throw new ApiError(400, 'UPLOAD_INTEGRITY_MISMATCH', 'Uploaded bytes do not match the authorized size and hash');
    const mimeType = await inspectFile(bytes, ticket.filename, ticket.mimeType, ctx.config.maxUploadBytes);
    if (ctx.config.scannerHost) await scanWithClamAv(bytes, ctx.config.scannerHost, ctx.config.scannerPort);
    else if (!ctx.config.development) throw new ApiError(503, 'SCANNER_UNAVAILABLE', 'File scanning is unavailable');
    // A signed PUT may be replayed until expiry. Never publish its mutable key.
    const stored = await stageObject(ctx, { ownerId: ticket.ownerId, bytes, filename: ticket.filename, mimeType });
    pendingId = stored.pendingId;
    const asset = await serializable(ctx.db, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`upload:${id}`}, 0))`;
      const current = requireValue(await tx.assetUpload.findUnique({ where: { id } }));
      await authorize(tx, current, principal);
      if (current.assetId || current.leaseId !== leaseId || current.expiresAt <= new Date()) throw new ApiError(409, 'UPLOAD_CHANGED', 'Upload authorization changed while validating');
      if ('workerId' in principal) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`output-assets:${principal.jobId}`}, 0))`;
        const job = await ownedAttempt(tx, principal.workerId, principal.jobId, principal.attemptId);
        const limits = PermissionManifestSchema.parse(job.version.permissions).limits;
        const existing = await tx.asset.aggregate({ where: { jobId: job.id, attemptId: principal.attemptId, kind: 'OUTPUT', deletedAt: null }, _sum: { sizeBytes: true }, _count: true });
        if (existing._count >= FILE_SAFETY_CEILINGS.maxFiles || (existing._sum.sizeBytes ?? 0) + stored.sizeBytes > Math.min(ctx.config.fileLimits.outputBytes, limits.maxOutputBytes)) throw new ApiError(413, 'OUTPUT_TOO_LARGE', 'Output assets exceed the effective job limits');
      }
      const created = await tx.asset.create({ data: { ownerId: ticket.ownerId, jobId: ticket.jobId, attemptId: ticket.attemptId, kind: ticket.kind,
        filename: ticket.filename, mimeType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, objectKey: stored.key,
        scanStatus: ctx.config.scannerHost ? 'CLEAN' : 'DEVELOPMENT_ONLY', expiresAt: new Date(Date.now() + ctx.config.assetRetentionDays * 86400_000) } });
      await commitObject(tx, stored.pendingId, { assetId: created.id });
      await tx.assetUpload.update({ where: { id }, data: { assetId: created.id, leaseId: null, leaseExpiresAt: null } });
      return created;
    });
    pendingId = undefined;
    return assetDto(asset);
  } catch (error) {
    if (pendingId) await abandonObject(ctx, pendingId).catch(() => undefined);
    await ctx.db.assetUpload.updateMany({ where: { id, leaseId, assetId: null }, data: { leaseId: null, leaseExpiresAt: null } });
    throw error;
  }
}

export async function expireAssetUploads(ctx: ApiContext) {
  const rows = await ctx.db.assetUpload.findMany({ where: { expiresAt: { lte: new Date() }, stagingDeletedAt: null }, take: 100, orderBy: { expiresAt: 'asc' } });
  for (const row of rows) {
    await ctx.storage.delete(row.objectKey);
    await ctx.db.assetUpload.update({ where: { id: row.id }, data: { stagingDeletedAt: new Date(), leaseId: null, leaseExpiresAt: null } });
  }
}

export function registerAssetUploads(app: FastifyInstance, ctx: ApiContext) {
  app.post('/api/assets/uploads', async (request, reply) => {
    const { user } = requireIdentity(request, 'assets:create');
    const result = await createUpload(ctx, { ownerId: user.id }, UploadSchema.parse(request.body));
    reply.code(201); return result;
  });
  app.post('/api/assets/uploads/:id/finalize', async request => {
    const { user } = requireIdentity(request, 'assets:create');
    z.object({}).strict().parse(request.body);
    return finalizeUpload(ctx, z.string().uuid().parse((request.params as { id: string }).id), { ownerId: user.id });
  });
  app.post('/api/worker/jobs/:id/uploads', async (request, reply) => {
    const worker = requireValue(request.worker);
    const { attemptId, ...body } = UploadSchema.extend({ attemptId: z.string().uuid() }).strict().parse(request.body);
    const result = await createUpload(ctx, { workerId: worker.id, jobId: z.string().uuid().parse((request.params as { id: string }).id), attemptId }, body);
    reply.code(201); return result;
  });
  app.post('/api/worker/jobs/:id/uploads/:uploadId/finalize', async request => {
    const worker = requireValue(request.worker);
    const params = z.object({ id: z.string().uuid(), uploadId: z.string().uuid() }).parse(request.params);
    const { attemptId } = z.object({ attemptId: z.string().uuid() }).strict().parse(request.body);
    return finalizeUpload(ctx, params.uploadId, { workerId: worker.id, jobId: params.id, attemptId });
  });
}
