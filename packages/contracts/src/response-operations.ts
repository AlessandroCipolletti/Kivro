import { z } from 'zod';
import { count, isoDate, money, uuid, type ResponseRoute } from './response-common.ts';

const nonnegative = z.number().finite().nonnegative();
const ratio = z.number().finite().min(0).max(1).nullable();
const groupLimit = 200;
const timing = z.object({ sampleCount: count, medianSeconds: nonnegative.nullable(), excludedCount: count }).strict();

export const executionOutcomesResponseSchema = z.object({
  basis: z.literal('STARTED_TERMINAL_JOBS'), decidedCount: count, succeededCount: count, failedCount: count, timedOutCount: count,
  excludedBeforeStartCount: count, excludedInvalidTimingCount: count, cancelledAfterStartCount: count,
}).strict();
export const operationFailureReasonSchema = z.enum(['WORKER_EXECUTION_FAILED', 'WORKER_EXECUTION_TIMEOUT', 'RECONNECT_EXPIRED',
  'WAIT_DEADLINE_EXCEEDED', 'PAUSE_BUDGET_EXCEEDED', 'PAUSE_ACK_TIMEOUT', 'EXECUTION_DEADLINE_EXCEEDED', 'INPUT_ASSET_EXPIRED', 'UNKNOWN']);
export const operationsReportingResponseSchema = z.object({
  dispatchLatency: z.object({ basis: z.literal('FIRST_OFFER_MINUS_INITIAL_QUEUE_WALL_TIME'), cohortJobs: count, sampleCount: count,
    missingQueueTimestampCount: count, invalidTimelineCount: count, averageSeconds: nonnegative.nullable(), medianSeconds: nonnegative.nullable() }).strict(),
  offerAcceptance: z.object({ basis: z.literal('ACCEPTED_OR_EXPIRED_OFFERS_CREATED_IN_PERIOD'), offeredCount: count, acceptedCount: count,
    expiredUnacceptedCount: count, withdrawnUnacceptedCount: count, pendingCount: count, unknownCount: count,
    denominatorCount: count, rate: ratio }).strict(),
  failures: z.object({ basis: z.literal('RETAINED_TERMINAL_EVENTS'), totalJobs: count, knownReasonJobs: count, unknownReasonJobs: count,
    missingEventJobs: count, groups: z.array(z.object({ reason: operationFailureReasonSchema,
      source: z.enum(['PLATFORM', 'WORKER', 'ACCOUNT_API', 'UNKNOWN']), count }).strict()).max(36) }).strict(),
  cancellations: z.object({ totalJobs: count, platformJobs: count, accountJobs: count, workerJobs: count, unknownSourceJobs: count }).strict(),
  refunds: z.object({ basis: z.literal('JOBS_WITH_FIRST_USD_CAPTURE_IN_PERIOD'), capturedJobs: count, refundedJobs: count,
    notRefundedJobs: count, unknownOutcomeJobs: count, denominatorJobs: count, rate: ratio,
    periodRefundsOutsideCohortJobs: count, periodRefundsWithoutCaptureJobs: count, invalidLedgerRecordCount: count }).strict(),
}).strict();
export type ExecutionOutcomesResponse = z.infer<typeof executionOutcomesResponseSchema>;
export type OperationsReportingResponse = z.infer<typeof operationsReportingResponseSchema>;

export const capabilityAnalyticsItemResponseSchema = z.object({
  capabilityId: uuid, capabilityTitle: z.string(),
  durations: z.object({ onlineMs: count, busyMs: count, offlineMs: count, scheduledOfflineMs: count,
    pausedMs: count, securityBlockedMs: count }).strict(),
  coverage: z.object({ eligibleMs: count, observedMs: count, unknownMs: count, ratio,
    firstObservedAt: isoDate.nullable(), lastObservedAt: isoDate.nullable(),
    observationCount: count, invalidObservationCount: count }).strict(),
  jobsAccepted: count, acceptedAttempts: count, queueFullRejects: count, queueFullCoverageFrom: isoDate.nullable(),
  queueWait: timing, execution: timing, disconnectFailures: count,
}).strict();
export const capabilityAnalyticsResponseSchema = z.object({
  method: z.literal('BOUNDED_PREVIOUS_OBSERVATION'), maxObservationGapMs: count,
  disconnectFailureBasis: z.literal('RETAINED_PLATFORM_RECONNECT_EXPIRY_EVENTS'),
  totalCapabilities: count, truncated: z.boolean(), items: z.array(capabilityAnalyticsItemResponseSchema).max(groupLimit),
}).strict();

const jobSummary = z.object({ id: uuid, capabilityId: uuid, capabilityTitle: z.string(),
  state: z.enum(['SUCCEEDED', 'FAILED', 'TIMED_OUT']), completedAt: isoDate }).strict();
const scheduledMetrics = z.object({ jobCount: count, estimatedWorkSeconds: count,
  reservedBuyerValueMinor: count, estimatedSellerEarningsMinor: count, expiredReservationCount: count }).strict();
export const scheduledOperationsGroupResponseSchema = scheduledMetrics.extend({
  capabilityId: uuid, capabilityTitle: z.string(), scheduledAt: isoDate.nullable(),
}).strict();

const inferenceTotals = z.object({
  finishedCalls: count, succeededCalls: count, failedCalls: count, unsettledCalls: count, invalidRecordCount: count,
  recordedCostMicroUsd: count, successfulUsageCostMicroUsd: count, failedCallBudgetChargeMicroUsd: count, reservedBudgetMicroUsd: count,
}).strict();
export const platformInferenceOperationsResponseSchema = inferenceTotals.extend({
  costBasis: z.literal('CONFIGURED_RATES_AND_FAILURE_BUDGETS'), providerBilledCostMicroUsd: z.null(),
  totalGroups: count, truncated: z.boolean(),
  byProvider: z.array(inferenceTotals.extend({ provider: z.string().min(1).max(100), model: z.string().min(1).max(200) }).strict()).max(groupLimit),
}).strict();

const sellerUsageTotals = z.object({ reportedAttempts: count, attemptedCalls: count, successfulCalls: count, unpricedCalls: count,
  inputTokens: count, outputTokens: count, estimatedProviderCostMicroUsd: count, reservedCostMicroUsd: count }).strict();
export const sellerCostOperationsResponseSchema = sellerUsageTotals.extend({
  costBasis: z.literal('WORKER_CONFIGURED_RATES'),
  coverage: z.object({ acceptedAttempts: count, finishedAttempts: count, unfinishedAttempts: count,
    missingReceiptAttempts: count, invalidReceiptAttempts: count, unpricedAttempts: count,
    earningsJobsOutsideCohort: count, receiptRate: ratio, complete: z.boolean() }).strict(),
  estimatedContributionMarginMicroUsd: money.nullable(),
  providerCostMicroUsd: z.null(), providerBilledCostMicroUsd: z.null(), infrastructureCostMicroUsd: z.null(), marginMicroUsd: z.null(),
  reason: z.enum(['NO_ACCEPTED_ATTEMPTS', 'INCOMPLETE_USAGE_COVERAGE', 'WORKER_RATE_ESTIMATE_ONLY']),
  totalGroups: count, truncated: z.boolean(),
  byProvider: z.array(sellerUsageTotals.extend({ provider: z.string().min(1).max(100), model: z.string().min(1).max(200) }).strict()).max(groupLimit),
}).strict();

export const operationsRecoveryResponseSchema = z.object({ count, truncated: z.boolean(),
  items: z.array(z.object({ jobId: uuid.nullable(), code: z.string().regex(/^[A-Z0-9_]{2,80}$/) }).strict()).max(groupLimit),
}).strict();
export const operationsMaintenanceResponseSchema = z.object({ count, truncated: z.boolean(),
  items: z.array(z.object({ task: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), code: z.string().regex(/^[A-Z0-9_]{2,80}$/),
    lastSeenAt: isoDate.nullable() }).strict()).max(groupLimit),
}).strict();

export const operationsResponseSchema = z.object({
  capabilityAnalytics: capabilityAnalyticsResponseSchema.optional(),
  reporting: operationsReportingResponseSchema.optional(),
  period: z.object({ from: isoDate, to: isoDate, days: z.number().int().min(1).max(90) }).strict(),
  jobs: z.object({ todayCount: count, totalCount: count, todayTimeZone: z.literal('UTC'),
    executionOutcomes: executionOutcomesResponseSchema.optional(),
    createdCount: count, terminalCount: count, succeededCount: count, failedCount: count, timedOutCount: count, cancelledCount: count,
    failureRate: ratio, successRate: ratio, lastSuccess: jobSummary.extend({ state: z.literal('SUCCEEDED') }).strict().nullable(),
    lastFailure: jobSummary.extend({ state: z.enum(['FAILED', 'TIMED_OUT']) }).strict().nullable(),
    runtime: z.object({ sampleCount: count, averageSeconds: nonnegative.nullable(), totalSeconds: nonnegative }).strict(),
  }).strict(),
  finance: z.object({ currency: z.literal('USD'), buyerCapturedMinor: count, buyerRefundedMinor: count,
    sellerEarningsMinor: count, sellerEarningsReversedMinor: count, netSellerEarningsMinor: money,
    platformFeesMinor: count, platformFeeReversalsMinor: count, netPlatformFeesMinor: money }).strict(),
  scheduled: scheduledMetrics.extend({ totalGroups: count, truncated: z.boolean(),
    groups: z.array(scheduledOperationsGroupResponseSchema).max(groupLimit) }).strict(),
  assets: z.object({ retainedAssetCount: count, retainedAssetBytes: count, expiredUndeletedCount: count,
    uploadedCount: count, uploadedBytes: count, downloadGrantCount: count, downloadGrantedBytes: count, downloadGrantUnknownSizeCount: count,
    storageCostMicroUsd: z.null(), egressBytes: z.null(), egressCostMicroUsd: z.null() }).strict(),
  workers: z.object({ registeredCount: count, revokedCount: count, freshHeartbeatCount: count, staleHeartbeatCount: count,
    pausedCount: count, sandboxReadyFreshCount: count, lastSeenAt: isoDate.nullable() }).strict(),
  sellerCosts: sellerCostOperationsResponseSchema,
  platformInference: platformInferenceOperationsResponseSchema.nullable(),
  manualRecoveryRequired: operationsRecoveryResponseSchema.nullable(),
  maintenanceErrors: operationsMaintenanceResponseSchema.nullable(),
}).strict();

export const sellerOperationsResponseSchema = operationsResponseSchema.extend({
  platformInference: z.null(), manualRecoveryRequired: z.null(), maintenanceErrors: z.null(),
}).strict();
export const adminOperationsResponseSchema = operationsResponseSchema.extend({
  platformInference: platformInferenceOperationsResponseSchema,
  manualRecoveryRequired: operationsRecoveryResponseSchema, maintenanceErrors: operationsMaintenanceResponseSchema,
}).strict();

export const operationsResponseRoutes: ResponseRoute[] = [
  { method: 'GET', path: '/api/seller/operations', schema: sellerOperationsResponseSchema },
  { method: 'GET', path: '/api/admin/operations', schema: adminOperationsResponseSchema },
];
