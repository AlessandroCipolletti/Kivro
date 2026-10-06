// Read-only wire DTO mirrored from apps/api/src/operations.ts; no server imports.
import type { ExecutionOutcomesResponse, OperationsReportingResponse } from "@kivro/contracts/responses";
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
  costBasis: "WORKER_CONFIGURED_RATES";
  coverage: { acceptedAttempts: number; finishedAttempts: number; unfinishedAttempts: number; missingReceiptAttempts: number; invalidReceiptAttempts: number; unpricedAttempts: number; earningsJobsOutsideCohort: number; receiptRate: number | null; complete: boolean };
  estimatedContributionMarginMicroUsd: number | null;
  providerCostMicroUsd: null; providerBilledCostMicroUsd: null; infrastructureCostMicroUsd: null; marginMicroUsd: null;
  reason: "NO_ACCEPTED_ATTEMPTS" | "INCOMPLETE_USAGE_COVERAGE" | "WORKER_RATE_ESTIMATE_ONLY";
  totalGroups: number; truncated: boolean;
  byProvider: (SellerUsageTotals & { provider: string; model: string })[];
};
export type CapabilityAnalyticsItem = {
  capabilityId: string; capabilityTitle: string;
  durations: { onlineMs: number; busyMs: number; offlineMs: number; scheduledOfflineMs: number; pausedMs: number; securityBlockedMs: number };
  coverage: { eligibleMs: number; observedMs: number; unknownMs: number; ratio: number | null; firstObservedAt: string | null; lastObservedAt: string | null; observationCount: number; invalidObservationCount: number };
  jobsAccepted: number; acceptedAttempts: number; queueFullRejects: number; queueFullCoverageFrom: string | null;
  queueWait: { sampleCount: number; medianSeconds: number | null; excludedCount: number };
  execution: { sampleCount: number; medianSeconds: number | null; excludedCount: number };
  disconnectFailures: number;
};
export type CapabilityAnalyticsDTO = {
  method: 'BOUNDED_PREVIOUS_OBSERVATION'; maxObservationGapMs: number;
  disconnectFailureBasis: 'RETAINED_PLATFORM_RECONNECT_EXPIRY_EVENTS';
  totalCapabilities: number; truncated: boolean; items: CapabilityAnalyticsItem[];
};
export type OperationsDTO = {
  period: { from: string; to: string; days: number };
  jobs: {
    todayCount?: number; totalCount?: number; todayTimeZone?: 'UTC';
    executionOutcomes?: ExecutionOutcomesResponse;
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
  capabilityAnalytics?: CapabilityAnalyticsDTO;
  reporting?: OperationsReportingResponse;
  platformInference: PlatformInferenceOperations | null;
  manualRecoveryRequired: { count: number; truncated: boolean; items: { jobId: string | null; code: string }[] } | null;
  maintenanceErrors: { count: number; truncated: boolean; items: { task: string; code: string; lastSeenAt: string | null }[] } | null;
};

export function outcomeRate(value: number | null): string {
  return value === null ? "No decided outcomes" : `${(value * 100).toFixed(1)}%`;
}
export function executionFailureDisplay(jobs: Pick<OperationsDTO["jobs"], "executionOutcomes" | "failureRate">): { value: string; detail: string } {
  const cohort = jobs.executionOutcomes;
  if (!cohort) return { value: "Cohort not reported", detail: "Execution outcome scope is unavailable" };
  return { value: outcomeRate(jobs.failureRate), detail: `${cohort.failedCount} execution failures / ${cohort.decidedCount} started, decided jobs` };
}
export function microUsd(value: number | null): string {
  return value === null ? "Not measured" : `USD ${(value / 1_000_000).toFixed(6)}`;
}
export function providerEstimate(cost: SellerUsageTotals): string {
  if (!cost.reportedAttempts || (cost.attemptedCalls > 0 && cost.unpricedCalls === cost.attemptedCalls && cost.estimatedProviderCostMicroUsd === 0)) return "Not measured";
  return microUsd(cost.estimatedProviderCostMicroUsd);
}
export function contributionEstimate(cost: SellerCostOperations): string {
  return !cost.coverage.complete || cost.unpricedCalls > 0 || cost.coverage.earningsJobsOutsideCohort > 0 ? "Not measured" : microUsd(cost.estimatedContributionMarginMicroUsd);
}
