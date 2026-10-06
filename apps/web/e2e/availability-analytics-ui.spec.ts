import { test, expect } from "@playwright/test";
import { noOverflow, operationsFixture, uiFixtureSession } from "./ui-fixtures";
import type { CapabilityAnalyticsItem } from "../src/lib/operations";

test("availability analytics preserves bounded coverage, missing tracking and timing samples across reporting periods", async ({ page }, info) => {
  await uiFixtureSession(page);
  await page.route("**/api/seller/workers", route => route.fulfill({ json: [] }));
  const snapshot = operationsFixture();
  const item: CapabilityAnalyticsItem = {
    capabilityId: crypto.randomUUID(), capabilityTitle: "Synthetic research capability with a deliberately long descriptive title",
    durations: { onlineMs: 120000, busyMs: 60000, offlineMs: 30000, scheduledOfflineMs: 15000, pausedMs: 10000, securityBlockedMs: 5000 },
    coverage: { eligibleMs: 480000, observedMs: 240000, unknownMs: 240000, ratio: 0.5, firstObservedAt: snapshot.period.from, lastObservedAt: snapshot.period.to, observationCount: 10, invalidObservationCount: 2 },
    jobsAccepted: 7, acceptedAttempts: 9, queueFullRejects: 3, queueFullCoverageFrom: snapshot.period.from,
    queueWait: { sampleCount: 4, medianSeconds: 0.125, excludedCount: 1 }, execution: { sampleCount: 3, medianSeconds: 90, excludedCount: 2 }, disconnectFailures: 2,
  };
  snapshot.capabilityAnalytics = { method: "BOUNDED_PREVIOUS_OBSERVATION", maxObservationGapMs: 120000, disconnectFailureBasis: "RETAINED_PLATFORM_RECONNECT_EXPIRY_EVENTS", totalCapabilities: 201, truncated: true, items: [item, { ...item, capabilityId: crypto.randomUUID(), capabilityTitle: "No observation history", durations: { onlineMs: 0, busyMs: 0, offlineMs: 0, scheduledOfflineMs: 0, pausedMs: 0, securityBlockedMs: 0 }, coverage: { eligibleMs: 480000, observedMs: 0, unknownMs: 480000, ratio: null, firstObservedAt: null, lastObservedAt: null, observationCount: 0, invalidObservationCount: 0 }, queueFullRejects: 0, queueFullCoverageFrom: null, queueWait: { sampleCount: 0, medianSeconds: null, excludedCount: 0 }, execution: { sampleCount: 1, medianSeconds: 0, excludedCount: 0 } }] };
  const requested: string[] = [];
  await page.route("**/api/seller/operations?*", route => {
    const days = new URL(route.request().url()).searchParams.get("days")!; requested.push(days);
    return route.fulfill({ json: { ...snapshot, period: { ...snapshot.period, days: Number(days) } } });
  });
  expect((await page.goto("/selling/workers"))?.status()).toBe(200);
  const analytics = page.getByRole("region", { name: "Capability availability analytics", exact: true });
  await expect(analytics.getByText(/not exact uptime or a seller ranking/)).toBeVisible();
  await expect(analytics.getByText(/Showing 2 of 201 capabilities/)).toBeVisible();
  await analytics.getByText(item.capabilityTitle, { exact: true }).click();
  const detail = analytics.locator("details").filter({ has: page.locator("summary", { hasText: item.capabilityTitle }) });
  const fact = (name: string) => detail.locator(".health-grid > div").filter({ has: page.locator("dt", { hasText: new RegExp(`^${name}$`) }) }).locator("dd");
  await expect(fact("Coverage")).toHaveText("50.0% observed");
  await expect(fact("Unknown interval")).toHaveText("4 min");
  await expect(fact("Online, not busy")).toHaveText("2 min"); await expect(fact("Busy")).toHaveText("1 min");
  await expect(fact("Jobs accepted")).toHaveText("7"); await expect(fact("Accepted attempts")).toHaveText("9");
  await expect(fact("Queue-full rejects")).toHaveText("3"); await expect(fact("Median queue wait")).toHaveText("0.125 sec");
  await expect(fact("Median execution time")).toHaveText("1 min 30 sec"); await expect(fact("Retained disconnect failures")).toHaveText("2");
  await expect(detail.getByText(/4 samples; 1 excluded/)).toBeVisible();
  await expect(detail.getByText(/Repeated requests.*count once/)).toBeVisible();
  await expect(detail.getByRole("link", { name: "View capability", exact: true })).toHaveAttribute("href", `/selling/capabilities/${item.capabilityId}`);
  await analytics.getByText("No observation history", { exact: true }).click();
  const unknown = analytics.locator("details").filter({ has: page.locator("summary", { hasText: "No observation history" }) });
  await expect(unknown.getByText("Not tracked", { exact: true })).toBeVisible();
  await expect(unknown.getByText("No samples", { exact: true })).toHaveCount(1);
  await expect(unknown.locator(".health-grid > div").filter({ has: page.locator("dt", { hasText: "Median execution time" }) }).locator("dd")).toHaveText("0 sec");
  await expect(unknown.getByText(/absent tracking is not zero rejects/)).toBeVisible();
  await page.getByLabel("Reporting period", { exact: true }).selectOption("7");
  await expect.poll(() => requested.at(-1)).toBe("7");
  await analytics.getByText(item.capabilityTitle, { exact: true }).click();
  await noOverflow(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: `apps/web/verification/availability-analytics-fixture-${info.project.name}.png`, fullPage: true });
});

test("availability analytics loading, retry, missing API and empty snapshot stay distinct", async ({ page }, info) => {
  await uiFixtureSession(page);
  await page.route("**/api/seller/workers", route => route.fulfill({ json: [] }));
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let unavailable = true, empty = false;
  await page.route("**/api/seller/operations?*", async route => {
    if (unavailable) { await gate; return route.fulfill({ status: 503, json: { error: { code: "TEMPORARY", message: "Availability snapshot unavailable" } } }); }
    const snapshot = operationsFixture();
    if (empty) snapshot.capabilityAnalytics = { method: "BOUNDED_PREVIOUS_OBSERVATION", maxObservationGapMs: 120000, disconnectFailureBasis: "RETAINED_PLATFORM_RECONNECT_EXPIRY_EVENTS", totalCapabilities: 0, truncated: false, items: [] };
    return route.fulfill({ json: snapshot });
  });
  await page.goto("/selling/workers");
  await expect(page.getByText("Loading operations snapshot", { exact: true })).toBeVisible();
  release();
  const telemetry = page.getByRole("region", { name: "Seller operations telemetry", exact: true });
  await expect(telemetry.getByText("Availability snapshot unavailable", { exact: true })).toBeVisible();
  unavailable = false;
  await telemetry.getByRole("button", { name: "Try again", exact: true }).click();
  const analytics = page.getByRole("region", { name: "Capability availability analytics", exact: true });
  await expect(analytics.getByText(/were not supplied by this API/)).toBeVisible();
  empty = true;
  await telemetry.getByRole("button", { name: "Refresh telemetry", exact: true }).click();
  await expect(analytics.getByText("No capabilities in this reporting snapshot.", { exact: true })).toBeVisible();
  await noOverflow(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: `apps/web/verification/availability-empty-fixture-${info.project.name}.png`, fullPage: true });
});
