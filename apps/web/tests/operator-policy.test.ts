import { describe, expect, it } from "vitest";
import { policyChanges, policyList } from "../src/lib/operator-policy";
import type { SecurityPolicy } from "../src/lib/types";

const policy: SecurityPolicy = { revision: 4, minimumWorkerVersion: "0.1.0", minimumOpenClawVersion: "2026.8.2", revokedWorkerVersions: [], revokedOpenClawVersions: [], blockedCategories: [] };
describe("operator policy review", () => {
  it("normalizes bounded line lists without inventing versions", () => {
    expect(policyList(" 0.1.0\r\n\n0.2.0\n0.1.0 ")).toEqual(["0.1.0", "0.2.0"]);
    expect(() => policyList("a".repeat(101))).toThrow();
    expect(() => policyList(Array.from({ length: 101 }, (_, i) => `entry${i}`).join("\n"))).toThrow();
  });
  it("reviews every policy field but does not treat the server revision as a rule", () => {
    expect(policyChanges(policy, { ...policy, revision: 5 })).toEqual([]);
    expect(policyChanges(policy, { ...policy, minimumWorkerVersion: "0.2.0", blockedCategories: ["Video"] })).toEqual([
      { key: "minimumWorkerVersion", label: "Minimum Worker version", before: "0.1.0", after: "0.2.0" },
      { key: "blockedCategories", label: "Blocked capability categories", before: [], after: ["Video"] },
    ]);
  });
});
