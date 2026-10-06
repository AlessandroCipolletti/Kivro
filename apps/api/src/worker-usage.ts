import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { WorkerUsageReceiptSchema, PermissionManifestSchema, hashManifest } from '@kivro/contracts';
import { json, serializable } from '@kivro/database';
import type { ApiContext } from './context.js';
import { ApiError, requireValue } from './errors.js';

export function registerWorkerUsage(app: FastifyInstance, ctx: ApiContext) {
  app.post('/api/worker/jobs/:id/usage', async request => {
    const worker = requireValue(request.worker);
    const jobId = z.string().uuid().parse((request.params as { id: string }).id);
    const receipt = WorkerUsageReceiptSchema.parse(request.body);
    await serializable(ctx.db, async tx => {
      const attempt = requireValue(await tx.jobAttempt.findFirst({ where: { id: receipt.attemptId, jobId, workerId: worker.id }, include: { job: { include: { version: true } } } }));
      if (attempt.usageReceipt) {
        if (hashManifest(attempt.usageReceipt) !== hashManifest(receipt)) throw new ApiError(409, 'USAGE_RECEIPT_CONFLICT', 'This attempt already has a different usage receipt');
        return;
      }
      if (!attempt.acceptedAt || !attempt.finishedAt) throw new ApiError(409, 'USAGE_ATTEMPT_NOT_FINISHED', 'Usage requires a finished accepted attempt');
      const permissions = PermissionManifestSchema.parse(attempt.job.version.permissions);
      if (receipt.provider !== permissions.inference.provider || receipt.model !== permissions.inference.model ||
        receipt.inputTokens + receipt.outputTokens > permissions.limits.maxTokens) throw new ApiError(400, 'USAGE_PERMISSION_MISMATCH', 'Usage does not match the purchased inference contract');
      await tx.jobAttempt.update({ where: { id: attempt.id }, data: { usageReceipt: json(receipt), usageReportedAt: new Date() } });
      await tx.auditEvent.create({ data: { workerId: worker.id, sellerId: worker.sellerId, jobId, type: 'WORKER_USAGE_RECORDED',
        metadata: { attemptId: attempt.id, costBasis: receipt.costBasis, unpricedCalls: receipt.unpricedCalls } } });
    });
    return { ok: true };
  });
}
