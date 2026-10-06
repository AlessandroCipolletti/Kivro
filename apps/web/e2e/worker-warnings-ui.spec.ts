import { test, expect } from "@playwright/test";
import { warningFixture } from "../tests/support/worker-warnings";
import { workerFixture } from "../tests/support/workers";
import { noOverflow, uiFixtureSession } from "./ui-fixtures";

test("worker warnings expose actionable facts with source, blocking status and incomplete coverage", async ({ page }, info) => {
  await uiFixtureSession(page);
  const securityWarnings = warningFixture();
  await page.route("**/api/seller/workers", route => route.fulfill({ json: [workerFixture({ id: securityWarnings.items[0].affectedEntity.workerId, name: "Security evidence fixture", paused: true, securityWarnings })] }));
  expect((await page.goto("/selling/workers"))?.status()).toBe(200);
  const warnings = page.getByRole("region", { name: "Security warnings", exact: true });
  await expect(warnings.getByRole("heading", { name: "Worker version revoked", exact: true })).toBeVisible();
  await expect(warnings).toContainText("CRITICAL"); await expect(warnings).toContainText("Blocking"); await expect(warnings).toContainText("Non-blocking");
  await expect(warnings).toContainText("Authenticated Worker report, not an independent cloud probe");
  await expect(warnings).toContainText("First platform observation"); await expect(warnings).toContainText("Last observed");
  await expect(warnings).toContainText("Install an approved release; do not override the version restriction.");
  await expect(warnings).toContainText("stale; current local evidence is unavailable");
  await expect(warnings).toContainText("1 bound capability version only");
  await expect(warnings).toContainText("Device credential revocation schedule: unavailable");
  await expect(warnings.getByRole("link", { name: "Review capability" })).toHaveAttribute("href", `/selling/capabilities/${securityWarnings.items[1].affectedEntity.capabilityId}`);
  await expect(warnings.getByRole("button")).toHaveCount(0);
  await noOverflow(page);
  await page.screenshot({ path: `apps/web/verification/worker-warnings-fixture-${info.project.name}.png`, fullPage: true });
});

test("worker warnings preserve failure retry and missing or empty evidence never becomes all-clear", async ({ page }, info) => {
  await uiFixtureSession(page);
  let unavailable = true;
  const snapshot = warningFixture(); snapshot.items = []; snapshot.truncated = true;
  await page.route("**/api/seller/workers", route => unavailable ? route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Worker evidence unavailable." } } }) : route.fulfill({ json: [
    workerFixture({ name: "No warning report" }),
    workerFixture({ name: "Limited warning report", securityWarnings: snapshot }),
  ] }));
  expect((await page.goto("/selling/workers"))?.status()).toBe(200);
  await expect(page.getByRole("alert").filter({ hasText: "Worker evidence unavailable" })).toBeVisible();
  unavailable = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("Warning evidence has not been supplied. Absence of a report does not establish safety.", { exact: true })).toBeVisible();
  await expect(page.getByText("No active warnings in this reported scope. This is not a complete security assessment.", { exact: true })).toBeVisible();
  await expect(page.getByText("This warning snapshot is truncated; additional findings may not be shown.", { exact: true })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: `apps/web/verification/worker-warnings-empty-fixture-${info.project.name}.png`, fullPage: true });
});
