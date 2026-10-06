import { test, expect } from "@playwright/test";
import { sellerCapabilityFixture } from "../tests/support/seller-capabilities";
import { noOverflow, uiFixtureSession } from "./ui-fixtures";

test("capability health separates shared load and configured limits and pins historical last-success provenance", async ({ page }, info) => {
  await uiFixtureSession(page);
  const cap = sellerCapabilityFixture({ concurrency: 4, maxQueue: 5, maxScheduled: 10,
    liveState: { observedAt: "2026-10-06T10:00:00Z", runningJobs: 1, queueDepth: 2, scheduledJobs: 3, effectiveConcurrency: 2, capacityLoad: 4, lastSuccess: { jobId: crypto.randomUUID(), capabilityVersionId: crypto.randomUUID(), completedAt: "2026-10-05T09:00:00Z" } } });
  await page.route("**/api/seller/workers", route => route.fulfill({ json: [] }));
  await page.route("**/api/seller/capabilities", route => route.fulfill({ json: [cap] }));
  expect((await page.goto("/selling/workers"))?.status()).toBe(200);
  const row = page.getByRole("article", { name: `Capability health: ${cap.title}`, exact: true });
  for (const [label, value] of [["Running jobs", "1"], ["Configured concurrency", "4"], ["Effective concurrency", "2"], ["Queued / configured limit", "2 / 5"], ["Scheduled / configured limit", "3 / 10"], ["Admission capacity load", "4"]]) await expect(row.getByText(label, { exact: true }).locator("..").locator("dd")).toHaveText(value);
  await expect(row).toContainText("Job counts span all versions"); await expect(row).toContainText("occupancy shared across ready Workers");
  await expect(row).toContainText("different version from the displayed definition"); await expect(row).toContainText("does not establish current validation or readiness");
  await expect(row).toContainText(cap.liveState!.lastSuccess!.capabilityVersionId);
  await expect(row.getByRole("link", { name: /^Inspect successful job/ })).toHaveAttribute("href", `/jobs/${cap.liveState!.lastSuccess!.jobId}`);
  await noOverflow(page);
  await page.screenshot({ path: `apps/web/verification/capability-health-fixture-${info.project.name}.png`, fullPage: true });
});

test("capability health loading and retry do not invent zero, while measured zero and no success remain explicit", async ({ page }, info) => {
  await uiFixtureSession(page);
  const cap = sellerCapabilityFixture(); let unavailable = true, empty = false;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/seller/workers", route => route.fulfill({ json: [] }));
  await page.route("**/api/seller/capabilities", async route => {
    if (unavailable) { await gate; return route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Capability load unavailable." } } }); }
    return route.fulfill({ json: empty ? [] : [cap] });
  });
  expect((await page.goto("/selling/workers"))?.status()).toBe(200);
  const scope = page.getByRole("region", { name: "Capability readiness", exact: true });
  try { await expect(scope.getByText("Reading capability health", { exact: true })).toBeVisible(); await expect(scope.getByRole("article")).toHaveCount(0); } finally { release(); }
  await expect(scope.getByRole("alert")).toContainText("Capability load unavailable");
  unavailable = false; await scope.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(scope.getByText("Effective concurrency", { exact: true }).locator("..").locator("dd")).toHaveText("0");
  await expect(scope.getByText("Running jobs", { exact: true }).locator("..").locator("dd")).toHaveText("0");
  await expect(scope).toContainText("No recorded successful job");
  await expect(scope.getByRole("link", { name: /^Inspect successful job/ })).toHaveCount(0);
  await noOverflow(page);
  await page.screenshot({ path: `apps/web/verification/capability-health-empty-fixture-${info.project.name}.png`, fullPage: true });
  empty = true; await scope.getByRole("button", { name: "Refresh capability health", exact: true }).click();
  await expect(scope.getByText("No capabilities to inspect.", { exact: true })).toBeVisible();
  await expect(scope.getByRole("article")).toHaveCount(0);
});
