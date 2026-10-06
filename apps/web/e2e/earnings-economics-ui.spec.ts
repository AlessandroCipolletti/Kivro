import { test, expect, type Locator, type Page } from "@playwright/test";
import { noOverflow, operationsFixture, uiFixtureSession } from "./ui-fixtures";

async function earningsFixture(page: Page) {
  await uiFixtureSession(page);
  await page.route("**/api/seller/earnings", route => route.fulfill({ json: {
    grossSalesMinor: 9900, platformFeesMinor: 1900, earnedMinor: 8000, pendingMinor: 1600, pendingJobs: 2,
    settledJobs: 100, transferredMinor: 6400, transfers: [], connectStatus: "ACTIVE", payoutsEnabled: true,
    payoutSummary: { available: true, reason: null, currency: "USD", accountWide: true, paidOutMinor: 3200,
      pendingMinor: 500, failedMinor: 0, canceledMinor: 0, lastSyncedAt: "2026-10-06T09:00:00Z", historyComplete: true, lastError: null },
    payouts: [], payoutsHasMore: false, payoutsNextCursor: null,
  } }));
}
function metric(scope: Page | Locator, name: string) {
  return scope.getByText(name, { exact: true }).locator("..").locator("strong");
}

test("earnings reuses scoped cost coverage and outcomes without changing ledger or payout totals", async ({ page }, info) => {
  await earningsFixture(page);
  const snapshot = operationsFixture();
  Object.assign(snapshot.jobs, { todayCount: 3, totalCount: 42, createdCount: 17, terminalCount: 14, succeededCount: 6, failedCount: 6,
    timedOutCount: 4, cancelledCount: 2, failureRate: 0.25, successRate: 0.75, runtime: { sampleCount: 8, averageSeconds: 95, totalSeconds: 760 } });
  snapshot.jobs.executionOutcomes = { basis: "STARTED_TERMINAL_JOBS", decidedCount: 8, succeededCount: 6, failedCount: 2, timedOutCount: 1, excludedBeforeStartCount: 3, excludedInvalidTimingCount: 1, cancelledAfterStartCount: 2 };
  snapshot.sellerCosts = { ...snapshot.sellerCosts, reportedAttempts: 1, attemptedCalls: 2, successfulCalls: 1, unpricedCalls: 1,
    estimatedProviderCostMicroUsd: 12345, estimatedContributionMarginMicroUsd: 999999, reason: "INCOMPLETE_USAGE_COVERAGE",
    coverage: { ...snapshot.sellerCosts.coverage, acceptedAttempts: 2, finishedAttempts: 1, unfinishedAttempts: 1, missingReceiptAttempts: 1, unpricedAttempts: 1, receiptRate: 0.5 } };
  let requests = 0;
  await page.route("**/api/seller/operations?*", route => {
    expect(route.request().method()).toBe("GET");
    expect(new URL(route.request().url()).searchParams.get("days")).toBe("30");
    requests++; return route.fulfill({ json: snapshot });
  });
  expect((await page.goto("/selling/earnings"))?.status()).toBe(200);
  const economics = page.getByRole("region", { name: "Seller economics", exact: true });
  await expect(metric(economics, "Jobs today (UTC)")).toHaveText("3");
  await expect(metric(economics, "Jobs total")).toHaveText("42");
  await expect(metric(economics, "Jobs created in period")).toHaveText("17");
  await expect(economics.getByText(/Last 30 days, rolling UTC period: 2026-09-06T09:00:00Z to 2026-10-06T09:00:00Z/)).toBeVisible();
  await expect(metric(economics, "Execution failure rate")).toHaveText("25.0%");
  await expect(economics.getByText("Last 30 days; 2 execution failures / 8 started, decided jobs", { exact: true })).toBeVisible();
  await expect(metric(economics, "Average runtime")).toHaveText("2 min");
  await expect(economics.getByText("Last 30 days; 8 completed executions; pauses excluded", { exact: true })).toBeVisible();
  await expect(metric(economics, "Estimated provider costs")).toHaveText("USD 0.012345");
  await expect(economics.getByText(/recorded estimates only, incomplete coverage/)).toBeVisible();
  await expect(economics.getByText(/3 outcomes before execution and 1 invalid timelines are excluded/)).toBeVisible();
  await expect(economics.getByText(/2 cancellations after execution started remain separate/)).toBeVisible();
  await expect(economics.getByText(/1 of 2 accepted attempts have receipts; 1 missing, 0 invalid, 1 unpriced and 1 unfinished/)).toBeVisible();
  await economics.getByText("Seller inference estimates & coverage", { exact: true }).click();
  const contribution = economics.getByText("Estimated contribution", { exact: true }).locator("..").locator("dd");
  await expect(contribution).toHaveText("Not measured");
  await expect(economics.getByText("50.0%", { exact: true })).toBeVisible();
  await expect(economics.getByText(/Receipt coverage is not priced coverage/)).toBeVisible();
  await expect(metric(page, "Gross marketplace sales")).toHaveText("$99.00");
  await expect(metric(page, "Marketplace fees")).toHaveText("$19.00");
  await expect(metric(page, "Your earnings")).toHaveText("$80.00");
  await expect(page.locator(".payment-policy")).toContainText("from its marketplace share");
  await expect(page.locator(".payment-policy")).toContainText("not recorded as zero or exempt");
  await expect(metric(page, "Pending proceeds")).toHaveText("$16.00");
  await expect(page.getByText("$64.00 transferred", { exact: true })).toBeVisible();
  await expect(metric(page, "Recorded paid payouts (USD)")).toHaveText("$32.00");
  await expect(page.getByText(/account-wide bank payouts and may include funds from outside Kivro/)).toBeVisible();
  await noOverflow(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: `apps/web/verification/earnings-economics-fixture-${info.project.name}.png`, fullPage: true });

  snapshot.finance.netSellerEarningsMinor = 100;
  Object.assign(snapshot.sellerCosts, { reportedAttempts: 2, attemptedCalls: 2, unpricedCalls: 0, estimatedProviderCostMicroUsd: 1250000, estimatedContributionMarginMicroUsd: -250000, reason: "WORKER_RATE_ESTIMATE_ONLY" });
  Object.assign(snapshot.sellerCosts.coverage, { finishedAttempts: 2, unfinishedAttempts: 0, missingReceiptAttempts: 0, unpricedAttempts: 0, receiptRate: 1, complete: true });
  const beforeRefresh = requests;
  await economics.getByRole("button", { name: "Refresh economics" }).click();
  await expect(metric(economics, "Estimated provider costs")).toHaveText("USD 1.250000");
  await expect(economics.getByText(/recorded estimates only, complete priced coverage/)).toBeVisible();
  await economics.getByText("Seller inference estimates & coverage", { exact: true }).click();
  await expect(contribution).toHaveText("USD -0.250000");
  await expect(metric(page, "Your earnings")).toHaveText("$80.00");
  expect(requests).toBe(beforeRefresh + 1);
  await noOverflow(page);
});

test("earnings telemetry loads, retries errors and distinguishes unavailable metrics from zero", async ({ page }, info) => {
  await earningsFixture(page);
  const snapshot = operationsFixture();
  delete snapshot.jobs.todayCount; delete snapshot.jobs.totalCount; delete snapshot.jobs.todayTimeZone;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  let unavailable = true;
  await page.route("**/api/seller/operations?days=30", async route => {
    requests++;
    if (unavailable) { await gate; return route.fulfill({ status: 503, json: { error: { code: "TEMPORARY_UNAVAILABLE", message: "Economics snapshot temporarily unavailable." } } }); }
    return route.fulfill({ json: snapshot });
  });
  expect((await page.goto("/selling/earnings"))?.status()).toBe(200);
  const economics = page.getByRole("region", { name: "Seller economics", exact: true });
  try {
    await expect(economics.getByText("Loading job economics", { exact: true })).toBeVisible();
    await expect(economics.locator(".metric")).toHaveCount(0);
  } finally { release(); }
  await expect(economics.getByRole("alert")).toContainText("Economics snapshot temporarily unavailable.");
  await expect(economics.locator(".metric")).toHaveCount(0);
  await expect(metric(page, "Gross marketplace sales")).toHaveText("$99.00");
  unavailable = false;
  const beforeRetry = requests;
  await economics.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(economics.getByRole("alert")).toContainText("The service returned an invalid response");
  await expect(economics.locator(".metric")).toHaveCount(0);
  expect(requests).toBe(beforeRetry + 1);

  Object.assign(snapshot.jobs, { todayCount: 0, totalCount: 0, todayTimeZone: "UTC" });
  delete snapshot.jobs.executionOutcomes;
  await economics.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(metric(economics, "Jobs today (UTC)")).toHaveText("0");
  await expect(metric(economics, "Jobs total")).toHaveText("0");
  await expect(metric(economics, "Execution failure rate")).toHaveText("Cohort not reported");
  await expect(metric(economics, "Average runtime")).toHaveText("No samples");
  await expect(metric(economics, "Estimated provider costs")).toHaveText("Not measured");
  await expect(economics.getByRole("alert")).toHaveCount(0);
  expect(requests).toBe(beforeRetry + 2);
  await noOverflow(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: `apps/web/verification/earnings-empty-fixture-${info.project.name}.png`, fullPage: true });
});
