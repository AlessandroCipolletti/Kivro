import { describe, expect, it } from "vitest";
import { capacityDraft, capacityPatch, capacitySnapshot, parseCapacity } from "../src/lib/capacity";

describe("live seller capacity settings", () => {
  const snapshot = { concurrency: 1, maxQueue: 3, maxScheduled: 20, lifecycleRevision: 4 };
  it("requires every reported limit and a revision, never filling legacy defaults", () => {
    expect(capacitySnapshot(snapshot)).toEqual(snapshot);
    expect(capacitySnapshot({ concurrency: 1, maxQueue: 3, lifecycleRevision: 4 })).toBeNull();
    expect(capacitySnapshot({ ...snapshot, lifecycleRevision: undefined })).toBeNull();
    expect(capacitySnapshot({ ...snapshot, lifecycleRevision: -1 })).toBeNull();
    expect(capacityDraft(null)).toEqual({ concurrency: "", maxQueue: "", maxScheduled: "" });
  });
  it("uses shared schema bounds including zero queues and reservations", () => {
    expect(parseCapacity({ concurrency: "4", maxQueue: "0", maxScheduled: "0" }).success).toBe(true);
    for (const draft of [
      { concurrency: "0", maxQueue: "3", maxScheduled: "20" },
      { concurrency: "5", maxQueue: "3", maxScheduled: "20" },
      { concurrency: "1", maxQueue: "11", maxScheduled: "20" },
      { concurrency: "1", maxQueue: "3", maxScheduled: "21" },
      { concurrency: "1.5", maxQueue: "3", maxScheduled: "20" },
      { concurrency: "1", maxQueue: "", maxScheduled: "20" },
    ]) expect(parseCapacity(draft).success).toBe(false);
  });
  it("sends only changed capacity fields with CAS and suppresses draft-producing no-ops", () => {
    expect(capacityPatch(snapshot, snapshot)).toBeNull();
    expect(capacityPatch(snapshot, { ...snapshot, maxQueue: 0 })).toEqual({ expectedRevision: 4, maxQueue: 0 });
    expect(capacityPatch(snapshot, { concurrency: 4, maxQueue: 10, maxScheduled: 0 })).toEqual({ expectedRevision: 4, concurrency: 4, maxQueue: 10, maxScheduled: 0 });
  });
});
