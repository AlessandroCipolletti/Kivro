import type { AssetDTO, JobOutput, OutputContract, OutputField } from "@kivro/contracts";
import { safeAssetUrl } from "./format";

export type AssetUrlResolver = (asset: AssetDTO) => string | undefined;
export const jobAssetUrl: AssetUrlResolver = asset => safeAssetUrl(asset.id);
export function resultHref(value: string, assets: readonly AssetDTO[] = [], resolveUrl: AssetUrlResolver = jobAssetUrl): string | undefined {
  if (/[\x00-\x20\x7f]/.test(value)) return undefined;
  if (/^#[A-Za-z0-9_:.-]+$/.test(value)) return value;
  if (assets.some(asset => resolveUrl(asset) === value)) return value;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export function namedResultFields(output: JobOutput, contract?: OutputContract): { field: OutputField; value: unknown; present: boolean }[] {
  if (!contract?.fields) return [];
  return [...contract.fields].sort((a, b) => a.order - b.order).map(field => ({
    field, value: output.fields?.[field.key], present: Object.hasOwn(output.fields || {}, field.key),
  }));
}

export function fieldAssets(value: unknown, assets: readonly AssetDTO[], multiple: boolean): { assets: AssetDTO[]; missing: boolean } {
  const ids = multiple && Array.isArray(value) ? value : !multiple && typeof value === "string" ? [value] : [];
  const resolved = ids.flatMap(id => typeof id === "string" ? assets.filter(asset => asset.id === id) : []);
  return { assets: [...new Map(resolved.map(asset => [asset.id, asset])).values()], missing: ids.length === 0 || resolved.length !== ids.length };
}

export function extraResultFields(output: JobOutput, contract?: OutputContract): Record<string, unknown> {
  const declared = new Set(contract?.fields?.map(field => field.key) || []);
  return Object.fromEntries(Object.entries(output.fields || {}).filter(([key]) => !declared.has(key)));
}
