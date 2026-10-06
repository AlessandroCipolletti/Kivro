import { test, expect } from "@playwright/test";
import type { ProblemReport, SecurityPolicy } from "../src/lib/types";
import { noOverflow, uiFixtureSession } from "./ui-fixtures";

test("operator policy review uses CAS and device/capability actions require reasons", async ({ page }, info) => {
  const user = await uiFixtureSession(page, true);
  let policy: SecurityPolicy = { revision: 3, minimumWorkerVersion: "0.1.0", minimumOpenClawVersion: "2026.8.2", revokedWorkerVersions: [], revokedOpenClawVersions: [], blockedCategories: [] };
  const updates: unknown[] = [];
  await page.route("**/api/admin/security-policy", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: policy });
    const body = route.request().postDataJSON(); updates.push(body);
    if (updates.length === 1) { policy = { ...policy, revision: 4 }; return route.fulfill({ status: 409, json: { error: { code: "POLICY_CHANGED", message: "Policy changed; reload it." } } }); }
    expect(body.expectedRevision).toBe(4); policy = { ...body.policy, revision: 5 };
    return route.fulfill({ json: policy });
  });
  const workerId = crypto.randomUUID(), capId = crypto.randomUUID();
  let revoked = false, blocked = false;
  await page.route("**/api/admin/workers", route => route.fulfill({ json: [{ id: workerId, sellerId: user.id, name: "Boundary worker", version: "0.1.0", openclawVersion: "2026.8.2", paused: false, localPaused: false, revokedAt: revoked ? new Date().toISOString() : null, sandboxReady: false, lastSeenAt: null, policyReason: null, minimumWorkerVersion: "0.1.0", minimumOpenClawVersion: "2026.8.2" }] }));
  await page.route(`**/api/admin/workers/${workerId}/revoke`, route => { expect(route.request().postDataJSON()).toEqual({ reason: "Revoke synthetic fixture device." }); revoked = true; return route.fulfill({ json: { ok: true } }); });
  await page.route("**/api/admin/capabilities", route => route.fulfill({ json: [{ id: capId, sellerId: user.id, paused: false, securityBlocked: blocked, visibility: "PUBLIC", currentVersion: { title: "Boundary capability", category: "Documents", version: 1 } }] }));
  await page.route(`**/api/admin/capabilities/${capId}/security`, route => { expect(route.request().postDataJSON()).toEqual({ blocked: true, reason: "Block synthetic fixture capability." }); blocked = true; return route.fulfill({ json: { ok: true } }); });
  expect((await page.goto("/admin"))?.status()).toBe(200);
  await page.getByLabel("Minimum Worker version", { exact: true }).fill("0.2.0");
  await page.getByLabel("Reason for policy change").fill("Require a tested worker security update.");
  await page.getByRole("button", { name: "Review policy change" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("0.2.0"); expect(updates).toHaveLength(0);
  await dialog.getByRole("button", { name: "Apply reviewed policy" }).click();
  await expect(dialog.getByRole("button", { name: "Apply reviewed policy" })).toBeDisabled();
  expect(updates[0]).toMatchObject({ expectedRevision: 3, policy: { minimumWorkerVersion: "0.2.0" } });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Discard edits & reload policy" }).click();
  await expect(page.getByLabel("Minimum Worker version", { exact: true })).toHaveValue("0.1.0");
  await page.getByLabel("Minimum Worker version", { exact: true }).fill("0.2.0");
  await page.getByLabel("Reason for policy change").fill("Reviewed again after the policy changed.");
  await page.getByRole("button", { name: "Review policy change" }).click();
  await dialog.getByRole("button", { name: "Apply reviewed policy" }).click();
  await expect(page.getByText("Security policy revision 5 saved.")).toBeVisible();
  await page.getByRole("tab", { name: "Worker devices" }).click();
  await page.getByRole("button", { name: "Revoke device", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Revoke reviewed device" })).toBeDisabled();
  await dialog.getByLabel("Reason for worker revocation").fill("Revoke synthetic fixture device.");
  await dialog.getByRole("button", { name: "Revoke reviewed device" }).click();
  await expect(page.locator(".operator-row")).toContainText("Revoked");
  await page.getByRole("tab", { name: "Capabilities", exact: true }).click();
  await page.getByRole("button", { name: "Block capability", exact: true }).click();
  await expect(dialog).toContainText("reserved running work");
  await dialog.getByLabel("Reason for capability security change").fill("Block synthetic fixture capability.");
  await dialog.getByRole("button", { name: "Apply reviewed block" }).click();
  await expect(page.getByRole("button", { name: "Remove security block" })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: `apps/web/verification/operator-fixture-${info.project.name}.png`, fullPage: true });
});

test("report intake preserves a stale draft until explicit reload and publishes a CAS response", async ({ page }, info) => {
  const user = await uiFixtureSession(page, true);
  let report: ProblemReport = { id: crypto.randomUUID(), reporterId: user.id, jobId: crypto.randomUUID(), capabilityId: null, category: "DELIVERY", description: "The delivered artifact could not be opened.", status: "OPEN", revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resolution: null };
  await page.route("**/api/admin/security-policy", route => route.fulfill({ json: { revision: 0, minimumWorkerVersion: "0.1.0", minimumOpenClawVersion: "2026.8.2", revokedWorkerVersions: [], revokedOpenClawVersions: [], blockedCategories: [] } }));
  await page.route("**/api/admin/reports?*", route => route.fulfill({ json: [report] }));
  let updates = 0;
  await page.route(`**/api/admin/reports/${report.id}`, route => {
    const body = route.request().postDataJSON(); updates++;
    if (updates === 1) { report = { ...report, revision: 1 }; return route.fulfill({ status: 409, json: { error: { code: "REPORT_CHANGED", message: "Report changed; reload before editing." } } }); }
    expect(body).toEqual({ status: "IN_REVIEW", resolution: "We are investigating this delivery report.", expectedRevision: 1 });
    report = { ...report, status: body.status, resolution: body.resolution, revision: 2 }; return route.fulfill({ json: report });
  });
  await page.goto("/admin");
  await page.getByRole("button", { name: "Review report", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Updated status").selectOption("IN_REVIEW");
  await dialog.getByLabel("Response to reporter").fill("We are investigating this delivery report.");
  await dialog.getByRole("button", { name: "Save report response" }).click();
  await expect(dialog.getByLabel("Response to reporter")).toHaveValue("We are investigating this delivery report.");
  await expect(dialog.getByRole("button", { name: "Save report response" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Discard draft & reload intake" }).click();
  await page.getByRole("button", { name: "Review report", exact: true }).click();
  await dialog.getByLabel("Updated status").selectOption("IN_REVIEW");
  await dialog.getByLabel("Response to reporter").fill("We are investigating this delivery report.");
  await dialog.getByRole("button", { name: "Save report response" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".report-response")).toContainText("We are investigating");
  await noOverflow(page);
  await page.screenshot({ path: `apps/web/verification/report-intake-fixture-${info.project.name}.png`, fullPage: true });
});
