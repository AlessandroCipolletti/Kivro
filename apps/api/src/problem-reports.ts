import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { serializable } from '@kivro/database';
import type { ApiContext } from './context.js';
import { requireAdmin, requireIdentity } from './auth.js';
import { assertCapabilityAccess, loadCapability } from './catalog.js';
import { consumeBucket } from './abuse.js';
import { ApiError, requireValue } from './errors.js';

const reportBody = z.object({ jobId: z.string().uuid().optional(), capabilityId: z.string().uuid().optional(),
  category: z.enum(['ABUSE', 'PRIVACY', 'QUALITY', 'DELIVERY', 'PAYMENT', 'OTHER']),
  description: z.string().trim().min(10).max(4000) }).strict().refine(body => !!body.jobId !== !!body.capabilityId, 'Exactly one target is required');
const statuses = z.enum(['OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED']);

export function registerProblemReports(app: FastifyInstance, ctx: ApiContext) {
  app.post('/api/reports', async (request, reply) => {
    const { user } = requireIdentity(request), body = reportBody.parse(request.body);
    const report = await serializable(ctx.db, async tx => {
      if (body.jobId) {
        const job = await tx.job.findFirst({ where: { id: body.jobId, OR: [{ buyerId: user.id }, { sellerId: user.id }] } });
        requireValue(job);
      } else {
        const cap = await loadCapability(tx, body.capabilityId!);
        await assertCapabilityAccess(tx, cap, user.id);
      }
      await consumeBucket(tx, `problem-reports:${user.id}`, 5, 3600_000);
      const created = await tx.problemReport.create({ data: { ...body, reporterId: user.id } });
      await tx.auditEvent.create({ data: { actorId: user.id, type: 'PROBLEM_REPORTED', metadata: { reportId: created.id, category: created.category } } });
      return created;
    });
    reply.code(201); return report;
  });
  app.get('/api/reports', async request => {
    const { user } = requireIdentity(request);
    return ctx.db.problemReport.findMany({ where: { reporterId: user.id }, orderBy: { createdAt: 'desc' }, take: 100 });
  });
  app.get('/api/admin/reports', async request => {
    requireAdmin(request);
    const query = z.object({ status: statuses.optional() }).strict().parse(request.query);
    return ctx.db.problemReport.findMany({ where: query, orderBy: { createdAt: 'desc' }, take: 200 });
  });
  app.put('/api/admin/reports/:id', async request => {
    const user = requireAdmin(request), id = z.string().uuid().parse((request.params as { id: string }).id);
    const body = z.object({ status: statuses, resolution: z.string().trim().min(10).max(2000), expectedRevision: z.number().int().nonnegative() }).strict().parse(request.body);
    return serializable(ctx.db, async tx => {
      const result = await tx.problemReport.updateMany({ where: { id, revision: body.expectedRevision },
        data: { status: body.status, resolution: body.resolution, revision: { increment: 1 } } });
      if (!result.count) throw new ApiError(409, 'REPORT_CHANGED', 'Report changed; reload before editing');
      await tx.auditEvent.create({ data: { actorId: user.id, type: 'PROBLEM_REPORT_REVIEWED', metadata: { reportId: id, status: body.status } } });
      return tx.problemReport.findUniqueOrThrow({ where: { id } });
    });
  });
}
