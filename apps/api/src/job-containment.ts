import { serializable, type Transaction, type Prisma } from '@kivro/database';
import type { ApiContext } from './context.js';
import { failJob } from './jobs.js';
import { recordJobRecovery } from './job-recovery.js';

export async function containJobExecution(tx: Transaction, where: Prisma.JobWhereInput, reason: string) {
  const jobs = await tx.job.findMany({ where: { AND: [where, { paymentState: 'RESERVED', executionRevokedAt: null }] },
    select: { id: true, activeAttempt: { select: { workerId: true } } } });
  const ids = jobs.map(job => job.id);
  if (ids.length) {
    await tx.job.updateMany({ where: { id: { in: ids }, executionRevokedAt: null }, data: { executionRevokedAt: new Date() } });
    await tx.assetGrant.deleteMany({ where: { jobId: { in: ids } } });
    await tx.jobEvent.createMany({ data: jobs.map(job => ({ jobId: job.id, type: 'EXECUTION_REVOKED', message: reason })) });
    await tx.workerCommand.createMany({ data: jobs.flatMap(job => job.activeAttempt ? [{ workerId: job.activeAttempt.workerId, jobId: job.id, type: 'CANCEL_JOB' }] : []) });
  }
  return ids;
}

export async function releaseContainedJobs(ctx: ApiContext, ids: string[]) {
  for (const id of ids) {
    try {
      await serializable(ctx.db, async tx => {
        const job = await tx.job.findUnique({ where: { id } });
        if (job?.executionRevokedAt && job.paymentState === 'RESERVED') await failJob(tx, job, 'CANCELLED', 'Execution was revoked by an operator');
      });
      await ctx.db.platformSetting.deleteMany({ where: { key: `job-recovery-error:${id}` } });
    } catch (error) { await recordJobRecovery(ctx, id, error); }
  }
}
