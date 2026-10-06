import type { ApiContext } from './context.js';

export function failureCode(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return /^[A-Z0-9_]{2,80}$/.test(code) ? code : 'OPERATION_FAILED';
}

export async function recordJobRecovery(ctx: ApiContext, jobId: string, error: unknown) {
  const key = `job-recovery-error:${jobId}`;
  const prior = (await ctx.db.platformSetting.findUnique({ where: { key } }))?.value as { firstSeenAt?: string; attempts?: number } | undefined;
  const now = new Date().toISOString(), code = failureCode(error);
  const value = { code, firstSeenAt: prior?.firstSeenAt ?? now, lastSeenAt: now, attempts: (prior?.attempts ?? 0) + 1, nextRetryAt: Date.now() + 300_000 };
  await ctx.db.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  if (!prior) await ctx.db.auditEvent.create({ data: { jobId, type: 'JOB_RECOVERY_REQUIRED', metadata: { code } } });
  ctx.app.log.error({ jobId, code }, 'Job requires recovery review');
}
