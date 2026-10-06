import { describe, expect, it } from "vitest";
import type { AgentPlan, CapabilityDTO } from "../src/lib/types";
import { canRepairPlan, planApprovalIssues } from "../src/lib/plans";

const step: AgentPlan["steps"][number] = { id: "step", capabilityId: "cap", capabilityVersionId: "v1", dependsOn: [], inputMapping: [], status: "PLANNED", quote: { id: "quote", capabilityId: "cap", capabilityVersionId: "v1", amountMinor: 99, expiresAt: "2030-01-01T01:00:00Z", earliestStartAt: "2030-01-01T00:00:00Z", estimatedDeliveryAt: "2030-01-01T00:01:00Z" } };
const plan: AgentPlan = { id: "plan", revision: 1, goal: "Task", status: "AWAITING_APPROVAL", steps: [step], estimatedCostMinor: 99, constraints: { maxTotalSpendMinor: 99 }, timing: { mode: "IMMEDIATE" }, estimatedCompletionAt: step.quote.estimatedDeliveryAt };
const caps = [{ id: "cap", versionId: "v1" }] as CapabilityDTO[];
const now = Date.parse("2030-01-01T00:00:00Z");
describe("plan purchase approval", () => {
  it("allows only reconciled, current quoted services under budget", () => expect(planApprovalIssues(plan, caps, now)).toEqual([]));
  it("blocks over-budget plans and totals that do not reconcile", () => {
    expect(planApprovalIssues({ ...plan, estimatedCostMinor: 100 }, caps, now)).toHaveLength(2);
  });
  it("blocks expired quotes, wrong versions and missing paid services", () => {
    expect(planApprovalIssues(plan, caps, now + 3600000).join(" ")).toContain("expired");
    expect(planApprovalIssues(plan, [], now).join(" ")).toContain("changed");
    expect(planApprovalIssues({ ...plan, steps: [{ ...step, quote: { ...step.quote, capabilityVersionId: "v2" } }] }, caps, now).join(" ")).toContain("pinned");
    expect(planApprovalIssues({ ...plan, steps: [] }, caps, now).join(" ")).toContain("no paid services");
  });
  it("offers repair only for interrupted unavailable plans with unpurchased work", () => {
    expect(canRepairPlan({ ...plan, error: "NOT_TIMING_ELIGIBLE" })).toBe(true);
    expect(canRepairPlan({ ...plan, error: "UPSTREAM_JOB_FAILED" })).toBe(false);
    expect(canRepairPlan({ ...plan, status: "FAILED", error: "UPSTREAM_JOB_FAILED" })).toBe(true);
    expect(canRepairPlan({ ...plan, error: "NOT_TIMING_ELIGIBLE", status: "RUNNING" })).toBe(false);
    expect(canRepairPlan({ ...plan, error: "NOT_TIMING_ELIGIBLE", steps: [{ ...step, status: "COMPLETED", jobId: "purchased" }] })).toBe(false);
  });
  it("does not revalidate already paid completed quotes for a repaired plan", () => {
    const completed = { ...step, id: "completed", capabilityId: "old-cap", capabilityVersionId: "old-version", status: "COMPLETED", jobId: "paid-job", quote: { ...step.quote, expiresAt: "2000-01-01T00:00:00Z" } };
    expect(planApprovalIssues({ ...plan, steps: [completed, step], estimatedCostMinor: 198, constraints: { maxTotalSpendMinor: 200 } }, caps, now)).toEqual([]);
  });
});
