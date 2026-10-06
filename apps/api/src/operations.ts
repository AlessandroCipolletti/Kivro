import { Prisma, type Transaction } from '@kivro/database';
import { WorkerUsageReceiptSchema } from '@kivro/contracts';
import { operationsReportingResponseSchema, type ExecutionOutcomesResponse, type OperationsReportingResponse } from '@kivro/contracts/responses';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiContext } from './context.js';
import { requireAdmin, requireIdentity } from './auth.js';
import { ApiError } from './errors.js';
import { capacityAnalytics, type CapabilityAnalyticsDTO } from './capacity-telemetry.js';

export const OperationsQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).strict();
const count = z.number().int().nonnegative().safe();
const money = z.number().int().safe();
const terminalStates = ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'] as const;
const GROUP_LIMIT = 200;

export type OperationsJobSummary = { id: string; capabilityId: string; capabilityTitle: string; state: string; completedAt: string };
export type ScheduledOperationsGroup = {
  capabilityId: string; capabilityTitle: string; scheduledAt: string | null; jobCount: number;
  estimatedWorkSeconds: number; reservedBuyerValueMinor: number; estimatedSellerEarningsMinor: number; expiredReservationCount: number;
};
export type InferenceOperationsTotals = {
  finishedCalls: number; succeededCalls: number; failedCalls: number; unsettledCalls: number; invalidRecordCount: number;
  recordedCostMicroUsd: number; successfulUsageCostMicroUsd: number; failedCallBudgetChargeMicroUsd: number; reservedBudgetMicroUsd: number;
};
export type PlatformInferenceOperations = InferenceOperationsTotals & {
  costBasis: 'CONFIGURED_RATES_AND_FAILURE_BUDGETS'; providerBilledCostMicroUsd: null;
  totalGroups: number; truncated: boolean;
  byProvider: (InferenceOperationsTotals & { provider: string; model: string })[];
};
export type SellerUsageTotals = {
  reportedAttempts: number; attemptedCalls: number; successfulCalls: number; unpricedCalls: number;
  inputTokens: number; outputTokens: number; estimatedProviderCostMicroUsd: number; reservedCostMicroUsd: number;
};
export type SellerCostOperations = SellerUsageTotals & {
  costBasis: 'WORKER_CONFIGURED_RATES';
  coverage: {
    acceptedAttempts: number; finishedAttempts: number; unfinishedAttempts: number;
    missingReceiptAttempts: number; invalidReceiptAttempts: number; unpricedAttempts: number;
    earningsJobsOutsideCohort: number; receiptRate: number | null; complete: boolean;
  };
  estimatedContributionMarginMicroUsd: number | null;
  providerCostMicroUsd: null; providerBilledCostMicroUsd: null; infrastructureCostMicroUsd: null; marginMicroUsd: null;
  reason: 'NO_ACCEPTED_ATTEMPTS' | 'INCOMPLETE_USAGE_COVERAGE' | 'WORKER_RATE_ESTIMATE_ONLY';
  totalGroups: number; truncated: boolean;
  byProvider: (SellerUsageTotals & { provider: string; model: string })[];
};
export type OperationsDTO = {
  capabilityAnalytics?: CapabilityAnalyticsDTO;
  reporting?: OperationsReportingResponse;
  period: { from: string; to: string; days: number };
  jobs: {
    executionOutcomes?: ExecutionOutcomesResponse;
    todayCount: number; totalCount: number; todayTimeZone: 'UTC';
    createdCount: number; terminalCount: number; succeededCount: number; failedCount: number; timedOutCount: number; cancelledCount: number;
    failureRate: number | null; successRate: number | null; lastSuccess: OperationsJobSummary | null; lastFailure: OperationsJobSummary | null;
    runtime: { sampleCount: number; averageSeconds: number | null; totalSeconds: number };
  };
  finance: {
    currency: 'USD'; buyerCapturedMinor: number; buyerRefundedMinor: number; sellerEarningsMinor: number; sellerEarningsReversedMinor: number;
    netSellerEarningsMinor: number; platformFeesMinor: number; platformFeeReversalsMinor: number; netPlatformFeesMinor: number;
  };
  scheduled: {
    jobCount: number; estimatedWorkSeconds: number; reservedBuyerValueMinor: number; estimatedSellerEarningsMinor: number;
    expiredReservationCount: number; totalGroups: number; truncated: boolean; groups: ScheduledOperationsGroup[];
  };
  assets: {
    retainedAssetCount: number; retainedAssetBytes: number; expiredUndeletedCount: number;
    uploadedCount: number; uploadedBytes: number; downloadGrantCount: number; downloadGrantedBytes: number; downloadGrantUnknownSizeCount: number;
    storageCostMicroUsd: null; egressBytes: null; egressCostMicroUsd: null;
  };
  workers: {
    registeredCount: number; revokedCount: number; freshHeartbeatCount: number; staleHeartbeatCount: number;
    pausedCount: number; sandboxReadyFreshCount: number; lastSeenAt: string | null;
  };
  sellerCosts: SellerCostOperations;
  platformInference: PlatformInferenceOperations | null;
  manualRecoveryRequired: { count: number; truncated: boolean; items: { jobId: string | null; code: string }[] } | null;
  maintenanceErrors: { count: number; truncated: boolean; items: { task: string; code: string; lastSeenAt: string | null }[] } | null;
};

function emptySellerUsage(): SellerUsageTotals {
  return { reportedAttempts: 0, attemptedCalls: 0, successfulCalls: 0, unpricedCalls: 0,
    inputTokens: 0, outputTokens: 0, estimatedProviderCostMicroUsd: 0, reservedCostMicroUsd: 0 };
}
type AttemptUsageRow = { id: string; acceptedAt: Date; finishedAt: Date | null; usageReportedAt: Date | null; usageReceipt: unknown };

export function addWorkerUsageRecord(total: SellerUsageTotals, row: AttemptUsageRow, now: Date) {
  if (row.usageReportedAt && row.usageReportedAt > now) return { status: 'MISSING' as const };
  if (row.usageReceipt === null && row.usageReportedAt === null) return { status: 'MISSING' as const };
  const parsed = WorkerUsageReceiptSchema.safeParse(row.usageReceipt);
  if (!parsed.success || parsed.data.attemptId !== row.id || !row.finishedAt || row.finishedAt > now ||
    row.finishedAt < row.acceptedAt || !row.usageReportedAt || row.usageReportedAt < row.finishedAt) return { status: 'INVALID' as const };
  const receipt = parsed.data;
  const delta: SellerUsageTotals = { reportedAttempts: 1, attemptedCalls: receipt.attemptedCalls, successfulCalls: receipt.successfulCalls,
    unpricedCalls: receipt.unpricedCalls, inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens,
    estimatedProviderCostMicroUsd: receipt.estimatedCostMicroUsd, reservedCostMicroUsd: receipt.reservedCostMicroUsd };
  for (const field of Object.keys(delta) as (keyof SellerUsageTotals)[]) total[field] = count.parse(total[field] + delta[field]);
  return { status: 'RECORDED' as const, provider: receipt.provider, model: receipt.model, delta };
}

async function sellerCostMetrics(tx: Transaction, jobScope: Prisma.Sql, from: Date, to: Date, netSellerEarningsMinor: number): Promise<SellerCostOperations> {
  const totals = emptySellerUsage(), groups = new Map<string, SellerUsageTotals & { provider: string; model: string }>();
  const coverage: SellerCostOperations['coverage'] = { acceptedAttempts: 0, finishedAttempts: 0, unfinishedAttempts: 0,
    missingReceiptAttempts: 0, invalidReceiptAttempts: 0, unpricedAttempts: 0, earningsJobsOutsideCohort: 0, receiptRate: null, complete: false };
  // Include retries, not just the active attempt. Offers never accepted are not usage.
  const cohort = Prisma.sql`a."acceptedAt" IS NOT NULL AND a."acceptedAt" <= ${to} AND
    (a."acceptedAt" >= ${from} OR (a."finishedAt" >= ${from} AND a."finishedAt" <= ${to}))`;
  let cursor: string | undefined;
  for (;;) {
    const rows = await tx.$queryRaw<AttemptUsageRow[]>(Prisma.sql`
      SELECT a.id, a."acceptedAt", a."finishedAt", a."usageReportedAt", a."usageReceipt"
      FROM "JobAttempt" a JOIN "Job" j ON j.id = a."jobId"
      WHERE ${jobScope} AND (${cohort}) ${cursor ? Prisma.sql`AND a.id > ${cursor}::uuid` : Prisma.empty}
      ORDER BY a.id LIMIT 200`);
    for (const row of rows) {
      coverage.acceptedAttempts = count.parse(coverage.acceptedAttempts + 1);
      if (row.finishedAt && row.finishedAt <= to && row.finishedAt >= row.acceptedAt) coverage.finishedAttempts++;
      else coverage.unfinishedAttempts++;
      const result = addWorkerUsageRecord(totals, row, to);
      if (result.status === 'MISSING') { coverage.missingReceiptAttempts++; continue; }
      if (result.status === 'INVALID') { coverage.invalidReceiptAttempts++; continue; }
      if (result.delta.unpricedCalls > 0) coverage.unpricedAttempts++;
      const key = JSON.stringify([result.provider, result.model]);
      const group = groups.get(key) ?? { provider: result.provider, model: result.model, ...emptySellerUsage() };
      for (const field of Object.keys(result.delta) as (keyof SellerUsageTotals)[]) group[field] = count.parse(group[field] + result.delta[field]);
      groups.set(key, group);
    }
    if (rows.length < 200) break;
    cursor = rows.at(-1)!.id;
  }
  // Period ledger entries can refer to older jobs or legacy jobs without attempts.
  // Do not present their earnings minus an unrelated cost cohort as contribution.
  const [earnings] = await tx.$queryRaw<{ jobs: number }[]>(Prisma.sql`
    SELECT COUNT(*)::float8 AS jobs FROM "Job" j WHERE ${jobScope} AND EXISTS (
      SELECT 1 FROM "LedgerEntry" l WHERE l."jobId" = j.id AND l.currency = 'USD'
        AND l.type IN ('SELLER_EARNING', 'SELLER_EARNING_REVERSAL') AND l."createdAt" >= ${from} AND l."createdAt" <= ${to}
    ) AND (
      NOT EXISTS (SELECT 1 FROM "JobAttempt" a WHERE a."jobId" = j.id AND a."acceptedAt" IS NOT NULL AND a."acceptedAt" <= ${to})
      OR EXISTS (SELECT 1 FROM "JobAttempt" a WHERE a."jobId" = j.id AND a."acceptedAt" IS NOT NULL AND a."acceptedAt" <= ${to} AND NOT COALESCE((${cohort}), FALSE))
    )`);
  coverage.earningsJobsOutsideCohort = count.parse(earnings?.jobs);
  coverage.receiptRate = coverage.acceptedAttempts ? totals.reportedAttempts / coverage.acceptedAttempts : null;
  coverage.complete = coverage.acceptedAttempts > 0 && coverage.finishedAttempts === coverage.acceptedAttempts &&
    totals.reportedAttempts === coverage.acceptedAttempts && coverage.unpricedAttempts === 0 && coverage.earningsJobsOutsideCohort === 0;
  return { ...totals, costBasis: 'WORKER_CONFIGURED_RATES', coverage,
    estimatedContributionMarginMicroUsd: coverage.complete ? money.parse(money.parse(netSellerEarningsMinor * 10_000) - totals.estimatedProviderCostMicroUsd) : null,
    providerCostMicroUsd: null, providerBilledCostMicroUsd: null, infrastructureCostMicroUsd: null, marginMicroUsd: null,
    reason: coverage.complete ? 'WORKER_RATE_ESTIMATE_ONLY' : coverage.acceptedAttempts === 0 && coverage.earningsJobsOutsideCohort === 0 ? 'NO_ACCEPTED_ATTEMPTS' : 'INCOMPLETE_USAGE_COVERAGE',
    totalGroups: groups.size, truncated: groups.size > GROUP_LIMIT,
    byProvider: [...groups.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)).slice(0, GROUP_LIMIT) };
}

function emptyInference(): InferenceOperationsTotals {
  return { finishedCalls: 0, succeededCalls: 0, failedCalls: 0, unsettledCalls: 0, invalidRecordCount: 0,
    recordedCostMicroUsd: 0, successfulUsageCostMicroUsd: 0, failedCallBudgetChargeMicroUsd: 0, reservedBudgetMicroUsd: 0 };
}
const InferenceRecord = z.discriminatedUnion('state', [
  z.object({ state: z.literal('RESERVED'), provider: z.string().min(1).max(100), model: z.string().min(1).max(200), maxCostMicroUsd: count }),
  z.object({ state: z.literal('FINISHED'), provider: z.string().min(1).max(100), model: z.string().min(1).max(200),
    costMicroUsd: count, outcome: z.enum(['SUCCEEDED', 'FAILED']) }),
]);

// Request records are the source of truth. Daily budget totals include these
// requests already and must not be added a second time or called invoices.
export function addInferenceRecord(total: InferenceOperationsTotals, value: unknown): { provider: string; model: string; delta: InferenceOperationsTotals } | null {
  const parsed = InferenceRecord.safeParse(value);
  if (!parsed.success) { total.invalidRecordCount++; return null; }
  const record = parsed.data, delta = emptyInference();
  if (record.state === 'RESERVED') { delta.unsettledCalls = 1; delta.reservedBudgetMicroUsd = record.maxCostMicroUsd; }
  else {
    delta.finishedCalls = 1; delta.recordedCostMicroUsd = record.costMicroUsd;
    if (record.outcome === 'SUCCEEDED') { delta.succeededCalls = 1; delta.successfulUsageCostMicroUsd = record.costMicroUsd; }
    else { delta.failedCalls = 1; delta.failedCallBudgetChargeMicroUsd = record.costMicroUsd; }
  }
  for (const key of Object.keys(delta) as (keyof InferenceOperationsTotals)[]) total[key] = count.parse(total[key] + delta[key]);
  return { provider: record.provider, model: record.model, delta };
}

async function inferenceMetrics(tx: Transaction, from: Date, to: Date): Promise<PlatformInferenceOperations> {
  const totals = emptyInference(), groups = new Map<string, InferenceOperationsTotals & { provider: string; model: string }>();
  let cursor: string | undefined;
  for (;;) {
    const rows = await tx.platformSetting.findMany({ where: { key: { startsWith: 'inference-request:', ...(cursor ? { gt: cursor } : {}) },
      updatedAt: { lte: to }, OR: [{ updatedAt: { gte: from } }, { value: { path: ['state'], equals: 'RESERVED' } }] },
    select: { key: true, value: true }, orderBy: { key: 'asc' }, take: 200 });
    for (const row of rows) {
      const result = addInferenceRecord(totals, row.value);
      if (!result) continue;
      const key = JSON.stringify([result.provider, result.model]);
      const group = groups.get(key) ?? { provider: result.provider, model: result.model, ...emptyInference() };
      for (const field of Object.keys(result.delta) as (keyof InferenceOperationsTotals)[]) group[field] = count.parse(group[field] + result.delta[field]);
      groups.set(key, group);
    }
    if (rows.length < 200) break;
    cursor = rows.at(-1)!.key;
  }
  return { ...totals, costBasis: 'CONFIGURED_RATES_AND_FAILURE_BUDGETS', providerBilledCostMicroUsd: null, totalGroups: groups.size,
    truncated: groups.size > GROUP_LIMIT, byProvider: [...groups.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)).slice(0, GROUP_LIMIT) };
}

async function recoveryMetrics(tx: Transaction) {
  const read = async (prefix: string) => {
    const where = { key: { startsWith: prefix } };
    const total = await tx.platformSetting.count({ where });
    const rows = await tx.platformSetting.findMany({ where, select: { key: true, value: true }, orderBy: [{ updatedAt: 'desc' }, { key: 'asc' }], take: GROUP_LIMIT });
    return { count: total, truncated: total > GROUP_LIMIT, rows };
  };
  const safeError = z.object({ code: z.string().regex(/^[A-Z0-9_]{2,80}$/), lastSeenAt: z.string().datetime().optional() });
  const recovery = await read('job-recovery-error:'), maintenance = await read('maintenance-error:');
  return {
    manualRecoveryRequired: { count: recovery.count, truncated: recovery.truncated, items: recovery.rows.map(row => {
      const id = z.string().uuid().safeParse(row.key.slice('job-recovery-error:'.length)), value = safeError.safeParse(row.value);
      return { jobId: id.success ? id.data : null, code: id.success && value.success ? value.data.code : 'INVALID_RECOVERY_RECORD' };
    }) },
    maintenanceErrors: { count: maintenance.count, truncated: maintenance.truncated, items: maintenance.rows.map(row => {
      const task = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).safeParse(row.key.slice('maintenance-error:'.length)), value = safeError.safeParse(row.value);
      return { task: task.success ? task.data : 'UNKNOWN_TASK', code: value.success ? value.data.code : 'INVALID_MAINTENANCE_RECORD',
        lastSeenAt: value.success ? value.data.lastSeenAt ?? null : null };
    }) },
  };
}

const JobMetrics = z.object({ todayCount: count, totalCount: count, createdCount: count, terminalCount: count, succeededCount: count, failedCount: count, timedOutCount: count,
  cancelledCount: count, executionSucceededCount: count, executionFailedCount: count, executionTimedOutCount: count,
  excludedBeforeStartCount: count, excludedInvalidTimingCount: count, cancelledAfterStartCount: count,
  sampleCount: count, totalSeconds: z.number().finite().nonnegative(), averageSeconds: z.number().finite().nonnegative().nullable() });
const LedgerMetrics = z.object({ buyerCapturedMinor: count, buyerRefundedMinor: count, sellerEarningsMinor: count, sellerEarningsReversedMinor: count,
  platformFeesMinor: count, platformFeeReversalsMinor: count });
const ScheduledMetrics = z.object({ jobCount: count, estimatedWorkSeconds: count, reservedBuyerValueMinor: count, estimatedSellerEarningsMinor: count, expiredReservationCount: count });
const ScheduledGroup = ScheduledMetrics.extend({ capabilityId: z.string().uuid(), capabilityTitle: z.string(), scheduledAt: z.date().nullable(), totalGroups: count });
const AssetMetrics = z.object({ retainedAssetCount: count, retainedAssetBytes: count, expiredUndeletedCount: count, uploadedCount: count, uploadedBytes: count });
const DownloadMetrics = z.object({ downloadGrantCount: count, downloadGrantedBytes: count, downloadGrantUnknownSizeCount: count });
const WorkerMetrics = z.object({ registeredCount: count, revokedCount: count, freshHeartbeatCount: count, staleHeartbeatCount: count,
  pausedCount: count, sandboxReadyFreshCount: count, lastSeenAt: z.date().nullable() });

async function reportingMetrics(tx: Transaction, jobScope: Prisma.Sql, from: Date, to: Date): Promise<OperationsReportingResponse> {
  // First offers are per job, not per retry. This is queue-to-offer wall time,
  // not execution time, scheduled waiting before queuing, or network latency.
  const [dispatch] = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
    WITH first_offers AS (
      SELECT j."createdAt", j."queuedAt", MIN(a."createdAt") AS offered
      FROM "Job" j JOIN "JobAttempt" a ON a."jobId" = j.id
      WHERE ${jobScope} AND a."createdAt" <= ${to} GROUP BY j.id
    ), measured AS (
      SELECT *, CASE WHEN "queuedAt" >= "createdAt" AND offered >= "queuedAt"
        THEN EXTRACT(EPOCH FROM (offered - "queuedAt")) END AS seconds
      FROM first_offers WHERE offered >= ${from}
    ) SELECT COUNT(*)::float8 AS "cohortJobs", COUNT(seconds)::float8 AS "sampleCount",
      COUNT(*) FILTER (WHERE "queuedAt" IS NULL)::float8 AS "missingQueueTimestampCount",
      COUNT(*) FILTER (WHERE "queuedAt" IS NOT NULL AND seconds IS NULL)::float8 AS "invalidTimelineCount",
      AVG(seconds)::float8 AS "averageSeconds", percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds)::float8 AS "medianSeconds" FROM measured`);
  // Accepted/expired offers have a decision; withdrawn and still-live offers do
  // not count as refusals. Contradictory legacy timestamps remain unknown.
  const [offers] = await tx.$queryRaw<{ offeredCount: number; acceptedCount: number; expiredUnacceptedCount: number;
    withdrawnUnacceptedCount: number; pendingCount: number; unknownCount: number }[]>(Prisma.sql`
    WITH classified AS (
      SELECT CASE
        WHEN a."createdAt" < j."createdAt" OR a."expiresAt" <= a."createdAt"
          OR a."acceptedAt" < a."createdAt" OR a."acceptedAt" >= a."expiresAt"
          OR a."finishedAt" < a."createdAt" OR a."finishedAt" < a."acceptedAt"
          OR a.state = 'EXPIRED' AND a."acceptedAt" IS NOT NULL THEN 'UNKNOWN'
        WHEN a."acceptedAt" <= ${to} THEN 'ACCEPTED'
        WHEN a."finishedAt" <= ${to} AND a.state IN ('CANCELLED','FAILED','TIMED_OUT') THEN 'WITHDRAWN'
        WHEN a.state IN ('OFFERED','EXPIRED') AND a."expiresAt" <= ${to} THEN 'EXPIRED'
        WHEN a."expiresAt" > ${to} AND (a.state = 'OFFERED' OR a."acceptedAt" > ${to} OR a."finishedAt" > ${to}) THEN 'PENDING'
        ELSE 'UNKNOWN' END AS kind
      FROM "JobAttempt" a JOIN "Job" j ON j.id = a."jobId"
      WHERE ${jobScope} AND a."createdAt" >= ${from} AND a."createdAt" <= ${to}
    ) SELECT COUNT(*)::float8 AS "offeredCount", COUNT(*) FILTER (WHERE kind = 'ACCEPTED')::float8 AS "acceptedCount",
      COUNT(*) FILTER (WHERE kind = 'EXPIRED')::float8 AS "expiredUnacceptedCount",
      COUNT(*) FILTER (WHERE kind = 'WITHDRAWN')::float8 AS "withdrawnUnacceptedCount",
      COUNT(*) FILTER (WHERE kind = 'PENDING')::float8 AS "pendingCount", COUNT(*) FILTER (WHERE kind = 'UNKNOWN')::float8 AS "unknownCount" FROM classified`);
  const offerCounts = z.object({ offeredCount: count, acceptedCount: count, expiredUnacceptedCount: count,
    withdrawnUnacceptedCount: count, pendingCount: count, unknownCount: count }).parse(offers);
  const denominatorCount = count.parse(offerCounts.acceptedCount + offerCounts.expiredUnacceptedCount);

  // Only fixed messages generated by these platform transitions can become
  // categories. Never project arbitrary Worker errors, job inputs or event text.
  const causes = [
    ['WORKER', 'FAILED', 'Worker execution failed', 'WORKER_EXECUTION_FAILED'],
    ['WORKER', 'TIMED_OUT', 'Worker execution timed out', 'WORKER_EXECUTION_TIMEOUT'],
    ['PLATFORM', 'FAILED', 'Worker did not reconnect within the recovery period', 'RECONNECT_EXPIRED'],
    ['PLATFORM', 'TIMED_OUT', 'Maximum waiting period exceeded', 'WAIT_DEADLINE_EXCEEDED'],
    ['PLATFORM', 'TIMED_OUT', 'Cumulative pause budget exceeded', 'PAUSE_BUDGET_EXCEEDED'],
    ['PLATFORM', 'TIMED_OUT', 'Worker did not acknowledge the pause request', 'PAUSE_ACK_TIMEOUT'],
    ['PLATFORM', 'TIMED_OUT', 'Execution deadline exceeded', 'EXECUTION_DEADLINE_EXCEEDED'],
    ['PLATFORM', 'FAILED', 'An input asset expired before execution', 'INPUT_ASSET_EXPIRED'],
  ];
  const reason = Prisma.sql`CASE ${Prisma.join(causes.map(([source, state, message, code]) => Prisma.sql`
    WHEN e.metadata->>'source' = ${source} AND j.state::text = ${state} AND e.message = ${message} THEN ${code}`), ' ')} ELSE 'UNKNOWN' END`;
  const rows = await tx.$queryRaw<{ state: string; source: string; reason: string; count: number; missingEvents: number }[]>(Prisma.sql`
    SELECT j.state::text AS state,
      CASE WHEN e.metadata->>'source' IN ('PLATFORM','WORKER','ACCOUNT_API') THEN e.metadata->>'source' ELSE 'UNKNOWN' END AS source,
      ${reason} AS reason, COUNT(*)::float8 AS count, COUNT(*) FILTER (WHERE e.id IS NULL)::float8 AS "missingEvents"
    FROM "Job" j LEFT JOIN LATERAL (
      SELECT id, message, metadata FROM "JobEvent" WHERE "jobId" = j.id AND type = j.state::text
        AND "createdAt" >= j."createdAt" AND "createdAt" <= ${to} ORDER BY "createdAt" DESC, id DESC LIMIT 1
    ) e ON TRUE
    WHERE ${jobScope} AND j.state IN ('FAILED','TIMED_OUT','CANCELLED') AND j."completedAt" >= ${from} AND j."completedAt" <= ${to}
    GROUP BY j.state, source, reason ORDER BY source, reason, j.state`);
  const failures: OperationsReportingResponse['failures'] = { basis: 'RETAINED_TERMINAL_EVENTS', totalJobs: 0, knownReasonJobs: 0,
    unknownReasonJobs: 0, missingEventJobs: 0, groups: [] };
  const cancellations: OperationsReportingResponse['cancellations'] = { totalJobs: 0, platformJobs: 0, accountJobs: 0, workerJobs: 0, unknownSourceJobs: 0 };
  for (const row of rows) {
    count.parse(row.count); count.parse(row.missingEvents);
    if (row.state === 'CANCELLED') {
      cancellations.totalJobs += row.count;
      const key = row.source === 'PLATFORM' ? 'platformJobs' : row.source === 'WORKER' ? 'workerJobs' : row.source === 'ACCOUNT_API' ? 'accountJobs' : 'unknownSourceJobs';
      cancellations[key] += row.count; continue;
    }
    failures.totalJobs += row.count; failures.missingEventJobs += row.missingEvents;
    if (row.reason === 'UNKNOWN') failures.unknownReasonJobs += row.count;
    else failures.knownReasonJobs += row.count;
    const group = failures.groups.find(item => item.reason === row.reason && item.source === row.source);
    if (group) group.count += row.count;
    else failures.groups.push({ reason: row.reason as OperationsReportingResponse['failures']['groups'][number]['reason'],
      source: row.source as OperationsReportingResponse['failures']['groups'][number]['source'], count: row.count });
  }

  // Refund rate uses a matched capture cohort. Refunds of older captures and
  // top-up refunds cannot inflate this numerator. This is not reconciliation.
  const [refunds] = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
    WITH entries AS (
      SELECT j.id, j."createdAt",
        MIN(l."createdAt") FILTER (WHERE l.type = 'JOB_CAPTURE' AND l.currency = 'USD' AND l."amountMinor" < 0) AS captured,
        MIN(l."createdAt") FILTER (WHERE l.type = 'REFUND' AND l.currency = 'USD' AND l."amountMinor" > 0) AS refunded,
        COUNT(*) FILTER (WHERE l.type = 'JOB_CAPTURE') AS captures,
        COUNT(*) FILTER (WHERE l.type = 'REFUND') AS refunds,
        COUNT(*) FILTER (WHERE l.currency <> 'USD' OR l."userId" IS DISTINCT FROM j."buyerId"
          OR l.type = 'JOB_CAPTURE' AND l."amountMinor" >= 0 OR l.type = 'REFUND' AND l."amountMinor" <= 0) AS invalid
      FROM "Job" j JOIN "LedgerEntry" l ON l."jobId" = j.id
      WHERE ${jobScope} AND l.type IN ('JOB_CAPTURE','REFUND') AND l."createdAt" <= ${to} GROUP BY j.id
    ), measured AS (
      SELECT *, captured >= ${from} AS cohort,
        invalid = 0 AND captures = 1 AND refunds <= 1 AND captured >= "createdAt" AND (refunded IS NULL OR refunded >= captured) AS known FROM entries
    ) SELECT COUNT(*) FILTER (WHERE cohort)::float8 AS "capturedJobs",
      COUNT(*) FILTER (WHERE cohort AND known AND refunded IS NOT NULL)::float8 AS "refundedJobs",
      COUNT(*) FILTER (WHERE cohort AND known AND refunded IS NULL)::float8 AS "notRefundedJobs",
      COUNT(*) FILTER (WHERE cohort AND known IS NOT TRUE)::float8 AS "unknownOutcomeJobs",
      COUNT(*) FILTER (WHERE cohort AND known)::float8 AS "denominatorJobs",
      COUNT(*) FILTER (WHERE refunded >= ${from} AND captured < ${from})::float8 AS "periodRefundsOutsideCohortJobs",
      COUNT(*) FILTER (WHERE refunded >= ${from} AND captured IS NULL)::float8 AS "periodRefundsWithoutCaptureJobs",
      COALESCE(SUM(invalid), 0)::float8 AS "invalidLedgerRecordCount" FROM measured`);
  const refundCounts = operationsReportingResponseSchema.shape.refunds.omit({ basis: true, rate: true }).parse(refunds);
  return operationsReportingResponseSchema.parse({
    dispatchLatency: { basis: 'FIRST_OFFER_MINUS_INITIAL_QUEUE_WALL_TIME', ...dispatch },
    offerAcceptance: { basis: 'ACCEPTED_OR_EXPIRED_OFFERS_CREATED_IN_PERIOD', ...offerCounts, denominatorCount,
      rate: denominatorCount ? offerCounts.acceptedCount / denominatorCount : null }, failures, cancellations,
    refunds: { basis: 'JOBS_WITH_FIRST_USD_CAPTURE_IN_PERIOD', ...refundCounts,
      rate: refundCounts.denominatorJobs ? refundCounts.refundedJobs / refundCounts.denominatorJobs : null },
  });
}

export async function operationsSnapshot(ctx: Pick<ApiContext, 'db' | 'config'>, sellerId: string | undefined, days = 30, now = new Date()): Promise<OperationsDTO> {
  OperationsQuery.parse({ days });
  if (sellerId !== undefined) z.string().uuid().parse(sellerId);
  const from = new Date(now.getTime() - days * 86400_000), freshAfter = new Date(now.getTime() - ctx.config.heartbeatTtlMs);
  const todayFrom = new Date(now);
  todayFrom.setUTCHours(0, 0, 0, 0);
  return ctx.db.$transaction(async (tx): Promise<OperationsDTO> => {
    const jobScope = sellerId ? Prisma.sql`j."sellerId" = ${sellerId}::uuid` : Prisma.sql`TRUE`;
    const window = Prisma.sql`j."completedAt" >= ${from} AND j."completedAt" <= ${now}`;
    const outcomes = Prisma.sql`j.state::text IN (${Prisma.join(terminalStates)}) AND ${window}`;
    const validStart = Prisma.sql`j."startedAt" >= j."createdAt" AND j."startedAt" <= j."completedAt"`;
    const runtime = Prisma.sql`CASE WHEN ${outcomes} AND j."startedAt" IS NOT NULL AND j."completedAt" >= j."startedAt" THEN
      GREATEST(0, EXTRACT(EPOCH FROM (j."completedAt" - j."startedAt")) - j."pausedDurationMs" / 1000.0 -
        CASE WHEN j."pausedAt" IS NOT NULL THEN GREATEST(0, EXTRACT(EPOCH FROM (j."completedAt" - j."pausedAt"))) ELSE 0 END) END`;
    const [jobRaw] = await tx.$queryRaw<unknown[]>(Prisma.sql`
      SELECT COUNT(*) FILTER (WHERE j."createdAt" >= ${todayFrom} AND j."createdAt" <= ${now})::float8 AS "todayCount",
        COUNT(*) FILTER (WHERE j."createdAt" <= ${now})::float8 AS "totalCount",
        COUNT(*) FILTER (WHERE j."createdAt" >= ${from} AND j."createdAt" <= ${now})::float8 AS "createdCount",
        COUNT(*) FILTER (WHERE ${outcomes})::float8 AS "terminalCount",
        COUNT(*) FILTER (WHERE j.state = 'SUCCEEDED' AND ${window})::float8 AS "succeededCount",
        COUNT(*) FILTER (WHERE j.state IN ('FAILED', 'TIMED_OUT') AND ${window})::float8 AS "failedCount",
        COUNT(*) FILTER (WHERE j.state = 'TIMED_OUT' AND ${window})::float8 AS "timedOutCount",
        COUNT(*) FILTER (WHERE j.state = 'CANCELLED' AND ${window})::float8 AS "cancelledCount",
        COUNT(*) FILTER (WHERE j.state = 'SUCCEEDED' AND ${window} AND ${validStart})::float8 AS "executionSucceededCount",
        COUNT(*) FILTER (WHERE j.state IN ('FAILED','TIMED_OUT') AND ${window} AND ${validStart})::float8 AS "executionFailedCount",
        COUNT(*) FILTER (WHERE j.state = 'TIMED_OUT' AND ${window} AND ${validStart})::float8 AS "executionTimedOutCount",
        COUNT(*) FILTER (WHERE j.state IN ('SUCCEEDED','FAILED','TIMED_OUT') AND ${window} AND j."startedAt" IS NULL)::float8 AS "excludedBeforeStartCount",
        COUNT(*) FILTER (WHERE j.state IN ('SUCCEEDED','FAILED','TIMED_OUT') AND ${window} AND j."startedAt" IS NOT NULL AND NOT (${validStart}))::float8 AS "excludedInvalidTimingCount",
        COUNT(*) FILTER (WHERE j.state = 'CANCELLED' AND ${window} AND ${validStart})::float8 AS "cancelledAfterStartCount",
        COUNT(${runtime})::float8 AS "sampleCount", COALESCE(SUM(${runtime}), 0)::float8 AS "totalSeconds", AVG(${runtime})::float8 AS "averageSeconds"
      FROM "Job" j WHERE ${jobScope}`);
    const jobs = JobMetrics.parse(jobRaw);
    const last = async (states: ('SUCCEEDED' | 'FAILED' | 'TIMED_OUT')[]): Promise<OperationsJobSummary | null> => {
      const row = await tx.job.findFirst({ where: { ...(sellerId ? { sellerId } : {}), state: { in: states }, completedAt: { lte: now } },
        orderBy: [{ completedAt: 'desc' }, { id: 'desc' }], select: { id: true, capabilityId: true, state: true, completedAt: true, version: { select: { title: true } } } });
      return row ? { id: row.id, capabilityId: row.capabilityId, capabilityTitle: row.version.title, state: row.state, completedAt: row.completedAt!.toISOString() } : null;
    };
    const lastSuccess = await last(['SUCCEEDED']), lastFailure = await last(['FAILED', 'TIMED_OUT']);
    const [ledgerRaw] = await tx.$queryRaw<unknown[]>(Prisma.sql`
      SELECT -COALESCE(SUM(l."amountMinor") FILTER (WHERE l.type = 'JOB_CAPTURE'), 0)::float8 AS "buyerCapturedMinor",
        COALESCE(SUM(l."amountMinor") FILTER (WHERE l.type = 'REFUND'), 0)::float8 AS "buyerRefundedMinor",
        COALESCE(SUM(l."amountMinor") FILTER (WHERE l.type = 'SELLER_EARNING'), 0)::float8 AS "sellerEarningsMinor",
        -COALESCE(SUM(l."amountMinor") FILTER (WHERE l.type = 'SELLER_EARNING_REVERSAL'), 0)::float8 AS "sellerEarningsReversedMinor",
        COALESCE(SUM(l."amountMinor") FILTER (WHERE l.type = 'PLATFORM_FEE'), 0)::float8 AS "platformFeesMinor",
        -COALESCE(SUM(l."amountMinor") FILTER (WHERE l.type = 'PLATFORM_FEE_REVERSAL'), 0)::float8 AS "platformFeeReversalsMinor"
      FROM "LedgerEntry" l JOIN "Job" j ON j.id = l."jobId"
      WHERE ${jobScope} AND l.currency = 'USD' AND l."createdAt" >= ${from} AND l."createdAt" <= ${now}`);
    const ledger = LedgerMetrics.parse(ledgerRaw);
    const scheduledSelect = Prisma.sql`COUNT(*)::float8 AS "jobCount", COALESCE(SUM(v."estimatedDurationSeconds"), 0)::float8 AS "estimatedWorkSeconds",
      COALESCE(SUM(j."buyerPriceMinor"), 0)::float8 AS "reservedBuyerValueMinor", COALESCE(SUM(j."sellerNetMinor"), 0)::float8 AS "estimatedSellerEarningsMinor",
      COUNT(*) FILTER (WHERE j."waitDeadline" <= ${now})::float8 AS "expiredReservationCount"`;
    const scheduledWhere = Prisma.sql`${jobScope} AND j.state = 'SCHEDULED' AND j."paymentState" = 'RESERVED' AND j."createdAt" <= ${now}`;
    const [scheduledRaw] = await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT ${scheduledSelect} FROM "Job" j JOIN "CapabilityVersion" v ON v.id = j."capabilityVersionId" WHERE ${scheduledWhere}`);
    const groupRaw = await tx.$queryRaw<unknown[]>(Prisma.sql`
      SELECT j."capabilityId", MIN(v.title) AS "capabilityTitle", j."scheduledAt", ${scheduledSelect}, COUNT(*) OVER()::float8 AS "totalGroups"
      FROM "Job" j JOIN "CapabilityVersion" v ON v.id = j."capabilityVersionId" WHERE ${scheduledWhere}
      GROUP BY j."capabilityId", j."scheduledAt" ORDER BY j."scheduledAt" ASC NULLS LAST, j."capabilityId" ASC LIMIT ${GROUP_LIMIT}`);
    const groups = z.array(ScheduledGroup).parse(groupRaw), totalGroups = groups[0]?.totalGroups ?? 0;
    // Seller storage covers owned uploads and assets generated by their jobs;
    // it does not expose unrelated buyers' files, object keys or filenames.
    const assetScope = sellerId ? Prisma.sql`(a."ownerId" = ${sellerId}::uuid OR j."sellerId" = ${sellerId}::uuid)` : Prisma.sql`TRUE`;
    const [assetRaw] = await tx.$queryRaw<unknown[]>(Prisma.sql`
      SELECT COUNT(*) FILTER (WHERE a."deletedAt" IS NULL)::float8 AS "retainedAssetCount",
        COALESCE(SUM(a."sizeBytes") FILTER (WHERE a."deletedAt" IS NULL), 0)::float8 AS "retainedAssetBytes",
        COUNT(*) FILTER (WHERE a."deletedAt" IS NULL AND a."expiresAt" <= ${now})::float8 AS "expiredUndeletedCount",
        COUNT(*) FILTER (WHERE a."createdAt" >= ${from})::float8 AS "uploadedCount",
        COALESCE(SUM(a."sizeBytes") FILTER (WHERE a."createdAt" >= ${from}), 0)::float8 AS "uploadedBytes"
      FROM "Asset" a LEFT JOIN "Job" j ON j.id = a."jobId" WHERE ${assetScope} AND a."createdAt" <= ${now}`);
    const grantScope = sellerId ? Prisma.sql`(e."actorId" = ${sellerId}::uuid OR j."sellerId" = ${sellerId}::uuid)` : Prisma.sql`TRUE`;
    const grantedSize = Prisma.sql`CASE WHEN jsonb_typeof(e.metadata->'bytesGranted') = 'number' AND (e.metadata->>'bytesGranted') ~ '^[0-9]{1,15}$'
      THEN (e.metadata->>'bytesGranted')::bigint END`;
    const [downloadRaw] = await tx.$queryRaw<unknown[]>(Prisma.sql`
      SELECT COUNT(*)::float8 AS "downloadGrantCount", COALESCE(SUM(${grantedSize}), 0)::float8 AS "downloadGrantedBytes",
        (COUNT(*) - COUNT(${grantedSize}))::float8 AS "downloadGrantUnknownSizeCount"
      FROM "AuditEvent" e LEFT JOIN "Job" j ON j.id = e."jobId"
      WHERE e.type = 'ASSET_DOWNLOAD_GRANTED' AND ${grantScope} AND e."createdAt" >= ${from} AND e."createdAt" <= ${now}`);
    const workerScope = sellerId ? Prisma.sql`w."sellerId" = ${sellerId}::uuid` : Prisma.sql`TRUE`;
    const fresh = Prisma.sql`w."revokedAt" IS NULL AND w."lastSeenAt" >= ${freshAfter} AND w."lastSeenAt" <= ${now}`;
    const [workerRaw] = await tx.$queryRaw<unknown[]>(Prisma.sql`
      SELECT COUNT(*)::float8 AS "registeredCount", COUNT(*) FILTER (WHERE w."revokedAt" IS NOT NULL)::float8 AS "revokedCount",
        COUNT(*) FILTER (WHERE ${fresh})::float8 AS "freshHeartbeatCount",
        COUNT(*) FILTER (WHERE w."revokedAt" IS NULL AND (w."lastSeenAt" IS NULL OR w."lastSeenAt" < ${freshAfter} OR w."lastSeenAt" > ${now}))::float8 AS "staleHeartbeatCount",
        COUNT(*) FILTER (WHERE w."revokedAt" IS NULL AND (w.paused OR w."localPaused"))::float8 AS "pausedCount",
        COUNT(*) FILTER (WHERE ${fresh} AND w."sandboxReady")::float8 AS "sandboxReadyFreshCount", MAX(w."lastSeenAt") AS "lastSeenAt"
      FROM "WorkerDevice" w WHERE ${workerScope} AND w."createdAt" <= ${now}`);
    const workers = WorkerMetrics.parse(workerRaw), decided = jobs.executionSucceededCount + jobs.executionFailedCount;
    return {
      capabilityAnalytics: await capacityAnalytics(tx, sellerId, from, now, ctx.config.operationalAuditRetentionDays),
      reporting: await reportingMetrics(tx, jobScope, from, now),
      period: { from: from.toISOString(), to: now.toISOString(), days },
      jobs: { todayCount: jobs.todayCount, totalCount: jobs.totalCount, todayTimeZone: 'UTC',
        executionOutcomes: { basis: 'STARTED_TERMINAL_JOBS', decidedCount: decided, succeededCount: jobs.executionSucceededCount,
          failedCount: jobs.executionFailedCount, timedOutCount: jobs.executionTimedOutCount, excludedBeforeStartCount: jobs.excludedBeforeStartCount,
          excludedInvalidTimingCount: jobs.excludedInvalidTimingCount, cancelledAfterStartCount: jobs.cancelledAfterStartCount },
        createdCount: jobs.createdCount, terminalCount: jobs.terminalCount, succeededCount: jobs.succeededCount, failedCount: jobs.failedCount,
        timedOutCount: jobs.timedOutCount, cancelledCount: jobs.cancelledCount, failureRate: decided ? jobs.executionFailedCount / decided : null,
        successRate: decided ? jobs.executionSucceededCount / decided : null, lastSuccess, lastFailure,
        runtime: { sampleCount: jobs.sampleCount, averageSeconds: jobs.averageSeconds, totalSeconds: jobs.totalSeconds } },
      finance: { currency: 'USD', ...ledger, netSellerEarningsMinor: money.parse(ledger.sellerEarningsMinor - ledger.sellerEarningsReversedMinor),
        netPlatformFeesMinor: money.parse(ledger.platformFeesMinor - ledger.platformFeeReversalsMinor) },
      scheduled: { ...ScheduledMetrics.parse(scheduledRaw), totalGroups, truncated: totalGroups > GROUP_LIMIT,
        groups: groups.map(({ totalGroups: _total, scheduledAt, ...group }) => ({ ...group, scheduledAt: scheduledAt?.toISOString() ?? null })) },
      assets: { ...AssetMetrics.parse(assetRaw), ...DownloadMetrics.parse(downloadRaw), storageCostMicroUsd: null, egressBytes: null, egressCostMicroUsd: null },
      workers: { ...workers, lastSeenAt: workers.lastSeenAt?.toISOString() ?? null },
      sellerCosts: await sellerCostMetrics(tx, jobScope, from, now, money.parse(ledger.sellerEarningsMinor - ledger.sellerEarningsReversedMinor)),
      platformInference: sellerId ? null : await inferenceMetrics(tx, from, now),
      ...(sellerId ? { manualRecoveryRequired: null, maintenanceErrors: null } : await recoveryMetrics(tx)),
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 }).catch((error: unknown) => {
    if (error instanceof z.ZodError) throw new ApiError(500, 'OPERATIONS_DATA_INVALID', 'Stored operational metrics failed validation');
    throw error;
  });
}

export function registerOperations(app: FastifyInstance, ctx: ApiContext) {
  app.get('/api/seller/operations', async request => {
    const { user } = requireIdentity(request);
    const { days } = OperationsQuery.parse(request.query);
    return operationsSnapshot(ctx, user.id, days);
  });
  app.get('/api/admin/operations', async request => {
    requireAdmin(request);
    const { days } = OperationsQuery.parse(request.query);
    return operationsSnapshot(ctx, undefined, days);
  });
}
