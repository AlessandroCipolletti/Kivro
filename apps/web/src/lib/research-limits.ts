import type { PermissionManifest } from "@kivro/contracts";

export type ResearchLimitKey = keyof NonNullable<PermissionManifest["network"]["researchLimits"]>;
export const researchLimitFields: { key: ResearchLimitKey; label: string; min: number; max: number }[] = [
  { key: "maxQueries", label: "Maximum research queries", min: 0, max: 5 },
  { key: "maxPages", label: "Maximum fetched pages", min: 0, max: 5 },
  { key: "maxResponseBytes", label: "Maximum bytes per response", min: 1, max: 500000 },
  { key: "maxTotalBytes", label: "Maximum total research bytes", min: 1, max: 5000000 },
  { key: "maxDurationMs", label: "Maximum research duration (ms)", min: 1, max: 60000 },
];
export function withResearchLimit(network: PermissionManifest["network"], key: ResearchLimitKey, value: number | undefined): PermissionManifest["network"] {
  const limits = { ...network.researchLimits };
  if (value === undefined) delete limits[key]; else limits[key] = value;
  const { researchLimits: _old, ...rest } = network;
  return Object.keys(limits).length ? { ...rest, researchLimits: limits } : rest;
}
