import { test, expect } from "@playwright/test";
import { noOverflow, uiFixtureSession } from "./ui-fixtures";
import { workerFixture } from "../tests/support/workers";

test("payouts distinguish partial account-wide totals, exact currency units and worker transitions", async ({ page }, info) => {
  await uiFixtureSession(page);
  const now = new Date().toISOString(), firstId = crypto.randomUUID(), nextId = crypto.randomUUID();
  const row = { id: firstId, amountMinor: 12345, currency: "USD", status: "paid", providerCreatedAt: now, arrivalDate: now, paidAt: now, failureCode: null, lastSyncedAt: now };
  await page.route("**/api/seller/earnings", route => route.fulfill({ json: { grossSalesMinor: 0, platformFeesMinor: 0, earnedMinor: 0, pendingMinor: 0, pendingJobs: 0, settledJobs: 0, transfers: [], transferredMinor: 0, connectStatus: "ACTIVE", payoutsEnabled: true, payoutSummary: { available: true, reason: null, currency: "USD", accountWide: true, paidOutMinor: 12345, pendingMinor: 0, failedMinor: 0, canceledMinor: 0, lastSyncedAt: now, historyComplete: false, lastError: "PROVIDER_UNAVAILABLE" }, payouts: [row], payoutsHasMore: true, payoutsNextCursor: firstId } }));
  await page.route(`**/api/seller/payouts?after=${firstId}`, route => route.fulfill({ json: { available: true, reason: null, items: [{ ...row, id: nextId, currency: "HUF", status: "pending", paidAt: null }], hasMore: false, nextCursor: null } }));
  await page.goto("/selling/earnings");
  await expect(page.getByText(/partial recorded totals/)).toBeVisible();
  await expect(page.getByText(/Recorded values may be stale/)).toBeVisible();
  await expect(page.locator(".payout-row")).toContainText("USD 123.45");
  await expect(page.locator(".payout-row")).toContainText("Paid status observed");
  await page.getByRole("button", { name: "Next payouts" }).click();
  await expect(page.locator(".payout-row")).toContainText("12,345 minor units (HUF)");
  await expect(page.getByRole("button", { name: "Next payouts" })).toBeDisabled();
  await noOverflow(page);
  await page.screenshot({ path: `apps/web/verification/payout-fixture-${info.project.name}.png`, fullPage: true });
  await page.getByRole("button", { name: "Previous payouts" }).click();
  await expect(page.locator(".payout-row")).toContainText("USD 123.45");

  await page.route("**/api/seller/workers", route => route.fulfill({ json: [workerFixture({ id: crypto.randomUUID(), name: "Recorded boundary device", version: "0.1.0", openclawVersion: "2026.8.2", paused: false, localPaused: false, sandboxReady: true, revokedAt: null, lastSeenAt: now, healthStatus: "READY:HEARTBEAT_HEALTHY", policyReason: "WORKER_VERSION_REVOKED", minimumWorkerVersion: "0.1.0", minimumOpenClawVersion: "2026.8.2", latestSupportedWorkerVersion: "0.1.0", latestSupportedOpenClawVersion: "2026.8.2", healthHistory: [{ id: crypto.randomUUID(), createdAt: now, metadata: { previous: "READY:HEARTBEAT_HEALTHY", status: "SECURITY_BLOCKED", reason: "WORKER_VERSION_REVOKED", version: "0.1.0", openclawVersion: "2026.8.2" } }] })] }));
  await page.goto("/selling/workers");
  await expect(page.locator(".worker-item > .row").getByText("Security block", { exact: true })).toBeVisible();
  await expect(page.getByText("New paid work blocked by version policy", { exact: true })).toBeVisible();
  await expect(page.getByText(/not necessarily the newest upstream releases/)).toBeVisible();
  await page.getByText("Health transitions (1)", { exact: true }).click();
  await expect(page.locator(".health-transitions")).toContainText("Worker Version Revoked");
  await expect(page.locator(".health-transitions")).toContainText("Previous: READY:HEARTBEAT_HEALTHY");
  await noOverflow(page);
  await page.screenshot({ path: `apps/web/verification/worker-health-fixture-${info.project.name}.png`, fullPage: true });
});
