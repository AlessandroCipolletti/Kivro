import { test, expect } from "@playwright/test";
import type { CapabilityDTO } from "@kivro/contracts";
import { agentPlanResponseSchema } from "@kivro/contracts/responses";
import { planFixture, planStepFixture } from "../tests/support/agent-plans";
import { register } from "./auth";

// Repair/approval UI contract tests, not live provider or payment tests.
for (const unavailableAtApproval of [false, true]) {
test(`${unavailableAtApproval ? "unavailable approval" : "failed step"} repair preserves provenance and requires new revision consent`, async ({ page }) => {
  const catalog = await (await page.request.get("/api/capabilities")).json() as CapabilityDTO[];
  test.skip(!catalog.length, "The boundary test needs one real catalog definition.");
  const cap = catalog[0];
  const { user } = await register(page, "plan");
  const step = () => planStepFixture(cap);
  const complete = planStepFixture(cap, { status: "COMPLETED", jobId: crypto.randomUUID() });
  complete.quote.expiresAt = "2000-01-01T00:00:00Z";
  const failed = planStepFixture(cap, { status: unavailableAtApproval ? "PLANNED" : "FAILED", error: unavailableAtApproval ? undefined : "JOB_FAILED", jobId: unavailableAtApproval ? undefined : crypto.randomUUID() });
  let plan = planFixture(user.id, [complete, failed], { goal: "Repair interrupted work without repeating successful delivery.", status: unavailableAtApproval ? "AWAITING_APPROVAL" : "FAILED", error: unavailableAtApproval ? undefined : "UPSTREAM_JOB_FAILED" });
  let approvals = 0;
  await page.route("**/api/agent/chat", route => route.fulfill({ json: { conversationId: crypto.randomUUID(), message: "This plan needs a replacement for its failed step.", recommendations: [], inferenceStatus: "UNAVAILABLE", plan } }));
  await page.route(`**/api/agent/plans/${plan.id}`, route => route.fulfill({ json: plan }));
  await page.route(`**/api/agent/plans/${plan.id}/replan`, async route => {
    expect(route.request().postDataJSON()).toEqual({ expectedRevision: 1, stepId: failed.id, reason: "Replace the failed service." });
    const replacement = step();
    const previous = { revision: plan.revision, status: plan.status, goal: plan.goal, constraints: plan.constraints, timing: plan.timing, estimatedCostMinor: plan.estimatedCostMinor, estimatedCompletionAt: plan.estimatedCompletionAt, steps: plan.steps, retiredSteps: [] };
    plan = agentPlanResponseSchema.parse({ ...plan, revision: 2, status: "AWAITING_APPROVAL", error: undefined, steps: [complete, replacement], retiredSteps: failed.jobId ? [failed] : [], estimatedCostMinor: failed.jobId ? 297 : 198, retainedWork: [{ stepId: complete.id, jobId: complete.jobId!, outputHash: "a".repeat(64) }], repairHistory: [{ id: crypto.randomUUID(), userId: user.id, createdAt: new Date().toISOString(), reason: "Replace the failed service.", mode: "DETERMINISTIC_REPLAN", previousPlanHash: "b".repeat(64), previous, committedSpendMinor: failed.jobId ? 198 : 99, remainingBudgetMinor: failed.jobId ? 202 : 301, replacements: [{ previousStepId: failed.id, stepId: replacement.id, capabilityId: cap.id, capabilityVersionId: cap.versionId }] }] });
    await route.fulfill({ json: plan });
  });
  await page.route(`**/api/agent/plans/${plan.id}/approve`, async route => {
    if (plan.revision === 1 && unavailableAtApproval) {
      expect(route.request().postDataJSON()).toEqual({ expectedRevision: 1 });
      await route.fulfill({ status: 400, json: { error: { code: "NOT_TIMING_ELIGIBLE", message: "This service is no longer available." } } });
      return;
    }
    expect(route.request().postDataJSON()).toEqual({ expectedRevision: 2 });
    approvals++;
    plan = { ...plan, revision: 3, status: "APPROVED" };
    await route.fulfill({ json: plan });
  });
  await page.goto("/agent");
  await page.getByLabel("Your request").fill("Review the existing interrupted plan.");
  await page.getByRole("button", { name: "Find services", exact: true }).click();
  if (unavailableAtApproval) {
    await expect(page.getByRole("button", { name: "Request plan repair" })).toHaveCount(0);
    await page.getByLabel("I approve the services, permissions, timing and maximum budget shown in this plan.").check();
    await page.getByRole("button", { name: "Approve remaining work / $0.99" }).click();
    await expect(page.getByText("This service is no longer available.")).toBeVisible();
  }
  await page.getByLabel("Reason for repair").fill("Replace the failed service.");
  await page.getByRole("button", { name: "Request plan repair" }).click();
  await expect(page.getByText("Revision 2", { exact: true })).toBeVisible();
  expect(approvals).toBe(0);
  await expect(page.getByRole("link", { name: "View job & results" })).toHaveAttribute("href", `/jobs/${complete.jobId}`);
  if (failed.jobId) await expect(page.getByRole("link", { name: "View original job" })).toHaveAttribute("href", `/jobs/${failed.jobId}`);
  await page.getByText("Retained result provenance", { exact: true }).click();
  await expect(page.getByRole("link", { name: "View retained result" })).toHaveAttribute("href", `/jobs/${complete.jobId}`);
  await expect(page.getByText(`Output SHA-256: ${"a".repeat(64)}`)).toBeVisible();
  await page.getByText("Repair history", { exact: true }).click();
  await expect(page.getByText("After revision 1")).toBeVisible();
  const approve = page.getByRole("button", { name: "Approve remaining work / $0.99" });
  await expect(approve).toBeDisabled();
  await page.getByLabel("I approve the services, permissions, timing and maximum budget shown in this plan.").check();
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect.poll(() => approvals).toBe(1);
});
}
