import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { preferredCapabilityIds, movePreference, recommendationFor } from "../src/lib/agent-recommendations";
import { RecommendationRationale } from "../src/components/agent-recommendation";
import { recommendationCapability, recommendationDetail } from "./support/recommendations";

describe("request preferences and recorded recommendation facts", () => {
  it("preserves explicit priority order and bounds IDs without adding authority", () => {
    const ids = [recommendationCapability().id, "b0000000-0000-4000-8000-000000000004"];
    expect(preferredCapabilityIds(ids)).toEqual(ids);
    expect(preferredCapabilityIds([])).toEqual([]);
    expect(() => preferredCapabilityIds([...ids, ids[0]])).toThrow("distinct");
    expect(() => preferredCapabilityIds(["arbitrary service"])).toThrow("distinct");
    expect(() => preferredCapabilityIds(Array.from({ length: 101 }, (_, i) => `b0000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`))).toThrow("100");
  });
  it("reorders within bounds without mutating selected preferences", () => {
    const ids = ["a", "b", "c"];
    expect(movePreference(ids, 1, -1)).toEqual(["b", "a", "c"]);
    expect(movePreference(ids, 1, 1)).toEqual(["a", "c", "b"]);
    expect(movePreference(ids, 0, -1)).toEqual(ids);
    expect(movePreference(ids, 2, 1)).toEqual(ids);
    expect(ids).toEqual(["a", "b", "c"]);
  });
  it("matches exact versions and refuses ambiguous or cross-capability records", () => {
    const cap = recommendationCapability(), detail = recommendationDetail(cap), older = { ...detail, capabilityVersionId: "old-version" };
    expect(recommendationFor(cap, [older, detail])).toBe(detail);
    expect(recommendationFor(cap, [older])).toBe(older);
    expect(recommendationFor(cap, [detail, detail])).toBeUndefined();
    expect(recommendationFor(cap, [{ ...detail, capabilityId: "other" }])).toBeUndefined();
  });
  it("renders recorded facts and limitations as escaped text without creating links or factual claims", () => {
    const cap = recommendationCapability(), detail = recommendationDetail(cap);
    detail.reason = "<script>window.injected=true</script>";
    const html = renderToStaticMarkup(React.createElement(RecommendationRationale, { capability: cap, detail }));
    expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>");
    expect(html).toContain("$0.99 USD per job"); expect(html).toContain("Not rated (0 reviews)");
    expect(html).toContain("PDF file output is not declared"); expect(html).toContain("Not an execution quote or reserved slot");
  });
  it("marks unavailable, changed-version and absent historical rationale honestly", () => {
    const cap = recommendationCapability(), detail = recommendationDetail(cap);
    const render = (props: Parameters<typeof RecommendationRationale>[0]) => renderToStaticMarkup(React.createElement(RecommendationRationale, props));
    expect(render({ capability: { ...cap, versionId: "changed" }, detail })).toContain("earlier version, not the current listing");
    expect(render({ detail })).toContain("No current listing is loaded");
    expect(render({ capability: cap })).toContain("No selection explanation was recorded");
    expect(render({ capability: { ...cap, id: "other" }, detail })).not.toContain(detail.reason);
  });
});
