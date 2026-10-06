import { describe, expect, it } from "vitest";
import { activationBlockers, reviewedVersionDiff, versionActionError } from "../src/lib/versions";
import { ApiError } from "../src/lib/api";
import type { CapabilityVersionDiff, CapabilityVersionHistory, CapabilityVersionSummary } from "../src/lib/types";

const version = { id: "target", state: "PUBLISHED", isActive: false, readiness: { ready: true, reasons: [] } } as unknown as CapabilityVersionSummary;
const history = { currentVersionId: "active", lifecycleRevision: 7 } as CapabilityVersionHistory;
const diff = { fromVersionId: "active", toVersionId: "target", lifecycleRevision: 7, diffHash: "hash" } as CapabilityVersionDiff;
describe("reviewed immutable version activation", () => {
  it("requires the exact target, active predecessor and current lifecycle revision", () => {
    expect(activationBlockers(version, history, diff)).toEqual([]);
    for (const changed of [{ ...diff, toVersionId: "other" }, { ...diff, fromVersionId: "old" }, { ...diff, lifecycleRevision: 6 }]) expect(activationBlockers(version, history, changed)).not.toEqual([]);
    expect(activationBlockers(version, history)).not.toEqual([]);
  });
  it("blocks retired, untested and already active versions independently of reviewed diffs", () => {
    expect(activationBlockers({ ...version, state: "RETIRED" }, history, diff).join()).toContain("unretired");
    expect(activationBlockers({ ...version, readiness: { ready: false, reasons: ["WORKER_OFFLINE"] } }, history, diff)).toContain("WORKER_OFFLINE");
    expect(activationBlockers({ ...version, isActive: true }, history, diff).join()).toContain("already active");
  });
  it("invalidates publication consent when revision, version or definition hash changes", () => {
    expect(reviewedVersionDiff(diff, "target", 7, "hash")).toBe(true);
    expect(reviewedVersionDiff(diff, "other", 7, "hash")).toBe(false);
    expect(reviewedVersionDiff(diff, "target", 8, "hash")).toBe(false);
    expect(reviewedVersionDiff(diff, "target", 7, "old-hash")).toBe(false);
  });
  it("surfaces authoritative readiness reasons", () => {
    expect(versionActionError(new ApiError(409, "ROLLBACK_NOT_READY", "Not ready", { reasons: ["WORKER_OFFLINE"] })).message).toContain("WORKER_OFFLINE");
  });
});
