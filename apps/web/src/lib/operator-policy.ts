import type { SecurityPolicy } from "./types";

export const policyFields = [
  { key: "minimumWorkerVersion", label: "Minimum Worker version" },
  { key: "minimumOpenClawVersion", label: "Minimum OpenClaw version" },
  { key: "revokedWorkerVersions", label: "Revoked Worker versions" },
  { key: "revokedOpenClawVersions", label: "Revoked OpenClaw versions" },
  { key: "blockedCategories", label: "Blocked capability categories" },
] as const;
export function policyList(text: string): string[] {
  const items = [...new Set(text.split(/\r?\n/).map(item => item.trim()).filter(Boolean))];
  if (items.length > 100 || items.some(item => item.length > 100)) throw new Error("Use at most 100 entries, each no longer than 100 characters.");
  return items;
}
export function policyChanges(before: SecurityPolicy, after: SecurityPolicy) {
  return policyFields.filter(({ key }) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(({ key, label }) => ({ key, label, before: before[key], after: after[key] }));
}
