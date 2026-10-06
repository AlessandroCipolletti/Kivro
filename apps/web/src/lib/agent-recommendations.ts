import type { AgentRecommendation, CapabilityDTO } from "./types";

export function preferredCapabilityIds(ids: readonly string[]): string[] {
  if (ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))) {
    throw new Error("Choose up to 100 distinct preferred capabilities.");
  }
  return [...ids];
}

export function movePreference(ids: readonly string[], index: number, direction: -1 | 1): string[] {
  const next = [...ids], target = index + direction;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function recommendationFor(capability: Pick<CapabilityDTO, "id" | "versionId">, details: AgentRecommendation[]): AgentRecommendation | undefined {
  const matching = details.filter(detail => detail.capabilityId === capability.id);
  const exact = matching.filter(detail => detail.capabilityVersionId === capability.versionId);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  return matching.length === 1 ? matching[0] : undefined;
}
