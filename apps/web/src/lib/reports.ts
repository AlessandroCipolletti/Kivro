import type { ReportCategory, ReportStatus, ReportTarget } from "./types";

export const reportCategories: ReportCategory[] = ["ABUSE", "PRIVACY", "QUALITY", "DELIVERY", "PAYMENT", "OTHER"];
export const reportStatuses: ReportStatus[] = ["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"];

export function reportPayload(target: ReportTarget, category: ReportCategory, description: string) {
  if (Boolean(target.jobId) === Boolean(target.capabilityId)) throw new Error("Select exactly one job or capability.");
  if (!reportCategories.includes(category)) throw new Error("Select a report category.");
  const text = description.trim();
  if (text.length < 10 || text.length > 4000) throw new Error("Describe the problem in 10 to 4,000 characters.");
  return { ...(target.jobId ? { jobId: target.jobId } : { capabilityId: target.capabilityId }), category, description: text };
}

export function reportResolution(status: ReportStatus, resolution: string, expectedRevision: number) {
  if (!reportStatuses.includes(status)) throw new Error("Select a report status.");
  const text = resolution.trim();
  if (text.length < 10 || text.length > 2000) throw new Error("Write a reporter-visible response in 10 to 2,000 characters.");
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("Reload this report before updating it.");
  return { status, resolution: text, expectedRevision };
}
