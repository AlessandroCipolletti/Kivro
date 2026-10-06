import type { AgentPlan, CapabilityDTO } from "./types";

export function isUnavailablePlanError(code?: string): boolean {
  return ["NOT_TIMING_ELIGIBLE", "CAPABILITY_VERSION_UNAVAILABLE", "CAPABILITY_NOT_FOUND", "DEPENDENCY_UNAVAILABLE", "NOT_PUBLIC"].includes(code || "");
}
export function canRepairPlan(plan: AgentPlan): boolean {
  return (plan.status === "FAILED" || plan.status === "AWAITING_APPROVAL" && isUnavailablePlanError(plan.error)) && !plan.steps.some(step => step.status === "RUNNING") && repairableSteps(plan).length > 0;
}
export function repairableSteps(plan: AgentPlan) { return plan.steps.filter(step => step.status === "FAILED" || !step.jobId && step.status !== "COMPLETED"); }

export function planApprovalIssues(plan: AgentPlan, capabilities: CapabilityDTO[], now = Date.now()): string[] {
  const issues: string[] = [];
  const remaining = plan.steps.filter(step => !step.jobId && step.status !== "COMPLETED");
  if (!plan.steps.length) issues.push("The plan has no paid services.");
  if (plan.estimatedCostMinor > plan.constraints.maxTotalSpendMinor) issues.push("This plan exceeds your maximum budget.");
  if ([...plan.steps, ...(plan.retiredSteps || [])].reduce((sum, step) => sum + step.quote.amountMinor, 0) !== plan.estimatedCostMinor) issues.push("The quoted step amounts do not match the plan total.");
  if (remaining.some(step => !Number.isFinite(Date.parse(step.quote.expiresAt)) || Date.parse(step.quote.expiresAt) <= now)) issues.push("One or more quotes expired. Prepare a fresh plan before approval.");
  if (remaining.some(step => !capabilities.some(cap => cap.id === step.capabilityId && cap.versionId === step.capabilityVersionId))) issues.push("A quoted service version is unavailable or has changed. Prepare a fresh plan to review its current permissions.");
  if (remaining.some(step => step.quote.capabilityId !== step.capabilityId || step.quote.capabilityVersionId !== step.capabilityVersionId)) issues.push("A quote does not match its pinned service version.");
  if (canRepairPlan(plan)) issues.push("Availability changed. Repair this plan before approval.");
  return issues;
}
