import { expect, type Page } from "@playwright/test";
import { PREPAID_PAYMENT_POLICY, PRICE_TIERS } from "@kivro/contracts";
import type { OperationsDTO } from "../src/lib/operations";

export function operationsFixture(admin = false): OperationsDTO {
  return {
    period: { days: 30, from: "2026-09-06T09:00:00Z", to: "2026-10-06T09:00:00Z" },
    jobs: { todayCount: 0, totalCount: 0, todayTimeZone: "UTC", createdCount: 0, terminalCount: 0, succeededCount: 0, failedCount: 0, timedOutCount: 0, cancelledCount: 0, failureRate: null, successRate: null, lastSuccess: null, lastFailure: null, runtime: { sampleCount: 0, averageSeconds: null, totalSeconds: 0 }, executionOutcomes: { basis: "STARTED_TERMINAL_JOBS", decidedCount: 0, succeededCount: 0, failedCount: 0, timedOutCount: 0, excludedBeforeStartCount: 0, excludedInvalidTimingCount: 0, cancelledAfterStartCount: 0 } },
    finance: { currency: "USD", buyerCapturedMinor: 0, buyerRefundedMinor: 0, sellerEarningsMinor: 0, sellerEarningsReversedMinor: 0, netSellerEarningsMinor: 0, platformFeesMinor: 0, platformFeeReversalsMinor: 0, netPlatformFeesMinor: 0 },
    scheduled: { jobCount: 0, estimatedWorkSeconds: 0, reservedBuyerValueMinor: 0, estimatedSellerEarningsMinor: 0, expiredReservationCount: 0, totalGroups: 0, truncated: false, groups: [] },
    assets: { retainedAssetCount: 0, retainedAssetBytes: 0, expiredUndeletedCount: 0, uploadedCount: 0, uploadedBytes: 0, downloadGrantCount: 0, downloadGrantedBytes: 0, downloadGrantUnknownSizeCount: 0, storageCostMicroUsd: null, egressBytes: null, egressCostMicroUsd: null },
    workers: { registeredCount: 0, revokedCount: 0, freshHeartbeatCount: 0, staleHeartbeatCount: 0, pausedCount: 0, sandboxReadyFreshCount: 0, lastSeenAt: null },
    sellerCosts: { providerCostMicroUsd: null, providerBilledCostMicroUsd: null, infrastructureCostMicroUsd: null, marginMicroUsd: null, reason: "NO_ACCEPTED_ATTEMPTS", costBasis: "WORKER_CONFIGURED_RATES", reportedAttempts: 0, attemptedCalls: 0, successfulCalls: 0, unpricedCalls: 0, inputTokens: 0, outputTokens: 0, estimatedProviderCostMicroUsd: 0, reservedCostMicroUsd: 0, estimatedContributionMarginMicroUsd: null, totalGroups: 0, truncated: false, byProvider: [], coverage: { acceptedAttempts: 0, finishedAttempts: 0, unfinishedAttempts: 0, missingReceiptAttempts: 0, invalidReceiptAttempts: 0, unpricedAttempts: 0, earningsJobsOutsideCohort: 0, receiptRate: null, complete: false } },
    platformInference: admin ? { costBasis: "CONFIGURED_RATES_AND_FAILURE_BUDGETS", providerBilledCostMicroUsd: null, totalGroups: 0, truncated: false, byProvider: [], finishedCalls: 0, succeededCalls: 0, failedCalls: 0, unsettledCalls: 0, invalidRecordCount: 0, recordedCostMicroUsd: 0, successfulUsageCostMicroUsd: 0, failedCallBudgetChargeMicroUsd: 0, reservedBudgetMicroUsd: 0 } : null,
    manualRecoveryRequired: admin ? { count: 0, truncated: false, items: [] } : null, maintenanceErrors: admin ? { count: 0, truncated: false, items: [] } : null,
  };
}

// Browser rendering/consent boundary only. Unexpected API writes never reach
// the backend and these identities are not real authenticated accounts.
export async function uiFixtureSession(page: Page, isAdmin = false) {
  const user = { id: crypto.randomUUID(), name: "Boundary verification", email: "boundary@example.test", isAdmin, bio: null, emailVerifiedAt: null, termsAcceptedVersion: "fixture", termsAcceptedAt: null };
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      "/api/auth/me": { user },
      "/api/config": { priceTiers: PRICE_TIERS, devMode: false, paymentMode: "stripe", categories: [], paymentPolicy: PREPAID_PAYMENT_POLICY },
      "/api/wallet": { availableMinor: 0, reservedMinor: 0, spentMinor: 0, earnedMinor: 0, ledger: [] },
      "/api/favorites": [], "/api/seller/jobs": [], "/api/seller/audit": [], "/api/seller/capabilities": [],
      "/api/admin/overview": { dispatchEnabled: false, users: 1, capabilities: 0, jobs: 0, activeJobs: 0, platformFeeMinor: 0 },
      "/api/admin/reports": [],
      "/api/seller/operations": operationsFixture(), "/api/admin/operations": operationsFixture(true),
    };
    expect(route.request().method(), `Unexpected mutation: ${path}`).toBe("GET");
    return path in responses ? route.fulfill({ json: responses[path] }) : route.fulfill({ status: 404, json: { error: { code: "UNFIXTURED", message: `No response fixture for ${path}` } } });
  });
  return user;
}

export async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
