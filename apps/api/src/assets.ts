import { z } from 'zod';
import { inspectFile, scanWithClamAv } from '@kivro/storage';
import { serializable } from '@kivro/database';
import { PermissionManifestSchema } from '@kivro/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiContext } from './context.js';
import { requireIdentity } from './auth.js';
import { ApiError, requireValue } from './errors.js';
import { assetDto } from './jobs.js';
import { ownedAttempt } from './worker.js';
import { activeStates } from './catalog.js';
import { assertWorkerJobDataPolicy } from './security-policy.js';
import { stageObject, commitObject, abandonObject } from './pending-objects.js';

async function readUpload(request: FastifyRequest, ctx: ApiContext) {
  const fields: Record<string, string> = {};
  let file: { filename: string; declaredMime: string; bytes: Buffer } | undefined;
  if (request.worker && request.rawBody.length) {
    // Signed multipart has already been bounded and authenticated byte-for-byte.
    // Fastify's multipart plugin reads IncomingMessage directly, so parse this buffer.
    const form = await new Response(new Uint8Array(request.rawBody), { headers: { 'content-type': request.headers['content-type']! } }).formData();
    let count = 0;
    for (const [name, value] of form.entries()) {
      if (++count > 3) throw new ApiError(400, 'INVALID_UPLOAD', 'Too many multipart fields');
      if (typeof value === 'string') {
        if (value.length > 200 || fields[name] !== undefined) throw new ApiError(400, 'INVALID_UPLOAD', 'Invalid multipart field');
        fields[name] = value;
      } else {
        if (file || name !== 'file') throw new ApiError(400, 'INVALID_UPLOAD', 'Upload exactly one file field');
        if (value.size > ctx.config.maxUploadBytes) throw new ApiError(413, 'FILE_TOO_LARGE', 'File exceeds the upload limit');
        file = { filename: value.name, declaredMime: value.type, bytes: Buffer.from(await value.arrayBuffer()) };
      }
    }
  } else {
    for await (const part of request.parts({ limits: { files: 1, fields: 2, parts: 3, fileSize: ctx.config.maxUploadBytes, fieldSize: 200 } })) {
      if (part.type === 'file') {
        if (file || part.fieldname !== 'file') throw new ApiError(400, 'INVALID_UPLOAD', 'Upload exactly one file field');
        const bytes = await part.toBuffer();
        if (part.file.truncated) throw new ApiError(413, 'FILE_TOO_LARGE', 'File exceeds the upload limit');
        file = { bytes, filename: part.filename, declaredMime: part.mimetype };
      } else fields[part.fieldname] = String(part.value);
    }
  }
  if (!file) throw new ApiError(400, 'FILE_REQUIRED', 'A multipart file is required');
  const mimeType = await inspectFile(file.bytes, file.filename, file.declaredMime, ctx.config.maxUploadBytes);
  if (ctx.config.scannerHost) await scanWithClamAv(file.bytes, ctx.config.scannerHost, ctx.config.scannerPort);
  else if (!ctx.config.development) throw new ApiError(503, 'SCANNER_UNAVAILABLE', 'File scanning is unavailable');
  return { ...file, fields, mimeType, scanStatus: ctx.config.scannerHost ? 'CLEAN' : 'DEVELOPMENT_ONLY' };
}

export function registerAssets(app: FastifyInstance, ctx: ApiContext) {
  app.post('/api/assets/upload', async (request, reply) => {
    const { user } = requireIdentity(request, 'assets:create');
    const file = await readUpload(request, ctx);
    const stored = await stageObject(ctx, { ownerId: user.id, ...file });
    try {
      const asset = await serializable(ctx.db, async tx => {
        const owner = requireValue(await tx.user.findUnique({ where: { id: user.id } }));
        if (owner.suspendedAt) throw new ApiError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended');
        const created = await tx.asset.create({ data: { ownerId: user.id, filename: file.filename, mimeType: file.mimeType, sizeBytes: stored.sizeBytes,
          sha256: stored.sha256, objectKey: stored.key, scanStatus: file.scanStatus, expiresAt: new Date(Date.now() + ctx.config.assetRetentionDays * 86400_000) } });
        await commitObject(tx, stored.pendingId, { assetId: created.id });
        return created;
      });
      reply.code(201); return assetDto(asset);
    } catch (error) { await abandonObject(ctx, stored.pendingId).catch(() => undefined); throw error; }
  });
  app.get('/api/assets/:id/download', async (request, reply) => {
    const { user } = requireIdentity(request, 'assets:read');
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const asset = requireValue(await ctx.db.asset.findFirst({ where: { id, ownerId: user.id, deletedAt: null, expiresAt: { gt: new Date() },
      OR: [{ kind: 'INPUT' }, { kind: 'OUTPUT', job: { state: 'SUCCEEDED' } }] } }));
    reply.header('Cache-Control', 'private, no-store');
    const url = await ctx.storage.downloadUrl(asset.objectKey, asset.filename);
    await ctx.db.auditEvent.create({ data: { actorId: user.id, jobId: asset.jobId, type: 'ASSET_DOWNLOAD_GRANTED',
      metadata: { assetId: asset.id, bytesGranted: asset.sizeBytes, delivery: 'PRESIGNED_OBJECT_STORE', confirmedBytesTransferred: null } } });
    return reply.redirect(url);
  });
  app.get('/api/worker/assets/:id/download', async (request, reply) => {
    const worker = requireValue(request.worker);
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const grant = requireValue(await ctx.db.assetGrant.findFirst({ where: { assetId: id, expiresAt: { gt: new Date() },
      job: { paymentState: 'RESERVED', state: { in: [...activeStates].filter(state => state !== 'OFFERED') }, activeAttempt: { workerId: worker.id, acceptedAt: { not: null },
        worker: { revokedAt: null, seller: { suspendedAt: null } } } },
      asset: { deletedAt: null, expiresAt: { gt: new Date() } } }, include: { asset: true } }));
    await assertWorkerJobDataPolicy(ctx.db, grant.jobId, worker.id);
    const bytes = ctx.storage.getStream ? await ctx.storage.getStream(grant.asset.objectKey, grant.asset.sizeBytes) : await ctx.storage.get(grant.asset.objectKey, grant.asset.sizeBytes);
    try { await assertWorkerJobDataPolicy(ctx.db, grant.jobId, worker.id); }
    catch (error) { if (!Buffer.isBuffer(bytes)) bytes.destroy(); throw error; }
    const authorized = await ctx.db.assetGrant.count({ where: { assetId: id, jobId: grant.jobId, expiresAt: { gt: new Date() },
      job: { paymentState: 'RESERVED', state: { in: [...activeStates].filter(state => state !== 'OFFERED') }, activeAttempt: { workerId: worker.id, acceptedAt: { not: null }, worker: { revokedAt: null, seller: { suspendedAt: null } } } } } });
    if (!authorized) { if (!Buffer.isBuffer(bytes)) bytes.destroy(); throw new ApiError(403, 'ASSET_GRANT_REVOKED', 'Execution access was revoked'); }
    reply.header('Content-Type', 'application/octet-stream').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(grant.asset.filename)}`)
      .header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    return reply.send(bytes);
  });
  app.post('/api/worker/jobs/:id/assets', async (request, reply) => {
    const worker = requireValue(request.worker);
    const jobId = z.string().uuid().parse((request.params as { id: string }).id);
    const file = await readUpload(request, ctx);
    const attemptId = z.string().uuid().parse(file.fields.attemptId);
    await assertWorkerJobDataPolicy(ctx.db, jobId, worker.id);
    const jobOwner = requireValue(await ctx.db.job.findUnique({ where: { id: jobId }, select: { buyerId: true } }));
    const stored = await stageObject(ctx, { ownerId: jobOwner.buyerId, ...file });
    try {
      const asset = await serializable(ctx.db, async tx => {
        const job = await ownedAttempt(tx, worker.id, jobId, attemptId);
        await assertWorkerJobDataPolicy(tx, jobId, worker.id);
        if (!['RUNNING', 'UPLOADING_RESULTS'].includes(job.state) || job.paymentState !== 'RESERVED') throw new ApiError(409, 'INVALID_JOB_STATE', 'Only the active running attempt may upload results');
        const permissions = PermissionManifestSchema.parse(job.version.permissions);
        const existing = await tx.asset.aggregate({ where: { jobId, attemptId, kind: 'OUTPUT', deletedAt: null }, _sum: { sizeBytes: true }, _count: true });
        if (file.bytes.length > ctx.config.fileLimits.workerFileBytes || existing._count >= 20 || (existing._sum.sizeBytes ?? 0) + file.bytes.length > Math.min(ctx.config.fileLimits.outputBytes, permissions.limits.maxOutputBytes)) throw new ApiError(413, 'OUTPUT_TOO_LARGE', 'Output assets exceed the effective job limits');
        const created = await tx.asset.create({ data: { ownerId: job.buyerId, jobId, attemptId, kind: 'OUTPUT', filename: file.filename, mimeType: file.mimeType,
          sizeBytes: stored.sizeBytes, sha256: stored.sha256, objectKey: stored.key, scanStatus: file.scanStatus,
          expiresAt: new Date(Date.now() + ctx.config.assetRetentionDays * 86400_000) } });
        await commitObject(tx, stored.pendingId, { assetId: created.id });
        return created;
      });
      reply.code(201); return assetDto(asset);
    } catch (error) { await abandonObject(ctx, stored.pendingId).catch(() => undefined); throw error; }
  });
}
