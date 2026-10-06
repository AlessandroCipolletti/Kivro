import { describe, expect, it } from "vitest";
import { hashManifest, PermissionManifestSchema } from "@kivro/contracts";
import { researchLimitFields, withResearchLimit } from "../src/lib/research-limits";
import { defaultWorkerPermissions } from "../src/lib/worker-policy";

describe("explicit per-job research limits", () => {
  it("preserves zero limits, removes blank overrides and changes the permission hash", () => {
    const network = { mode: "RESEARCH" as const, allowedDomains: ["example.com"] };
    const limited = withResearchLimit(network, "maxQueries", 0);
    expect(limited.researchLimits?.maxQueries).toBe(0);
    expect(hashManifest(limited)).not.toBe(hashManifest(network));
    expect(withResearchLimit(limited, "maxQueries", undefined)).toEqual(network);
  });
  it("matches the shared numeric bounds without treating absent controls as defaults", () => {
    const p = defaultWorkerPermissions(); p.inference.model = "synthetic-model";
    for (const field of researchLimitFields) {
      for (const value of [field.min, field.max]) expect(PermissionManifestSchema.safeParse({ ...p, network: withResearchLimit(p.network, field.key, value) }).success).toBe(true);
      for (const value of [field.min - 1, field.max + 1, 1.5]) expect(PermissionManifestSchema.safeParse({ ...p, network: withResearchLimit(p.network, field.key, value) }).success).toBe(false);
    }
  });
});
