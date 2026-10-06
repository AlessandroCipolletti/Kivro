import { CreateCapabilitySchema } from "@kivro/contracts";

export const CapacitySchema = CreateCapabilitySchema.pick({ concurrency: true, maxQueue: true, maxScheduled: true }).required();
export const capacityFields = [
  { key: "concurrency", label: "Maximum concurrent jobs", hint: "Seller limit; worker and platform safety limits still apply." },
  { key: "maxQueue", label: "Maximum queued jobs", hint: "Zero accepts only jobs with immediate execution capacity." },
  { key: "maxScheduled", label: "Maximum scheduled jobs", hint: "Zero prevents new future reservations." },
] as const;
export type Capacity = { concurrency: number; maxQueue: number; maxScheduled: number };
export type CapacitySnapshot = Capacity & { lifecycleRevision: number };
export type CapacityDraft = Record<keyof Capacity, string>;

export function capacitySnapshot(value: Partial<CapacitySnapshot>): CapacitySnapshot | null {
  const parsed = CapacitySchema.safeParse({ concurrency: value.concurrency, maxQueue: value.maxQueue, maxScheduled: value.maxScheduled });
  return parsed.success && Number.isSafeInteger(value.lifecycleRevision) && value.lifecycleRevision! >= 0
    ? { ...parsed.data, lifecycleRevision: value.lifecycleRevision! } : null;
}
export function capacityDraft(value: CapacitySnapshot | null): CapacityDraft {
  return { concurrency: value ? String(value.concurrency) : "", maxQueue: value ? String(value.maxQueue) : "", maxScheduled: value ? String(value.maxScheduled) : "" };
}
export function parseCapacity(value: CapacityDraft) {
  return CapacitySchema.safeParse(Object.fromEntries(capacityFields.map(({ key }) => [key, value[key].trim() ? Number(value[key]) : NaN])));
}
export function capacityPatch(previous: CapacitySnapshot, next: Capacity): (Partial<Capacity> & { expectedRevision: number }) | null {
  const changed = Object.fromEntries(capacityFields.filter(({ key }) => previous[key] !== next[key]).map(({ key }) => [key, next[key]]));
  // Sending an empty definition update would create a new draft version.
  return Object.keys(changed).length ? { ...changed, expectedRevision: previous.lifecycleRevision } : null;
}
