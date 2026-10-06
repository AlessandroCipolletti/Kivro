import { ApiError } from "./api";
import type { CapabilityVersionDiff, CapabilityVersionHistory, CapabilityVersionSummary } from "./types";

export function activationBlockers(version: CapabilityVersionSummary, history: CapabilityVersionHistory, diff?: CapabilityVersionDiff): string[] {
  const reasons: string[] = [];
  if (version.state !== "PUBLISHED") reasons.push("Only an unretired published version can become active.");
  if (version.isActive) reasons.push("This version is already active.");
  if (!version.readiness.ready) reasons.push(...version.readiness.reasons, "Fresh worker validation is required before activation.");
  if (!diff || diff.toVersionId !== version.id || diff.fromVersionId !== history.currentVersionId || diff.lifecycleRevision !== history.lifecycleRevision) reasons.push("Refresh and review the diff against the current active version.");
  return reasons;
}

export function versionActionError(error: unknown): Error {
  if (!(error instanceof ApiError)) return error instanceof Error ? error : new Error("The version action could not be completed.");
  const reasons = (error.details as { reasons?: unknown })?.reasons;
  return new Error(`${error.message}${Array.isArray(reasons) ? `: ${reasons.filter(item => typeof item === "string").join(", ")}` : ""}`);
}

export function reviewedVersionDiff(diff: CapabilityVersionDiff | undefined, versionId: string, revision: number | undefined, reviewedHash: string | undefined): boolean {
  return Boolean(diff && diff.toVersionId === versionId && diff.lifecycleRevision === revision && reviewedHash === diff.diffHash);
}
