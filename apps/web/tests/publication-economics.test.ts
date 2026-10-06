import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PRICE_TIERS } from "@kivro/contracts";
import { publicationEconomics, type PublicationInferenceEvidence } from "../src/lib/publication-economics";
import { PublicationEconomics } from "../src/components/publication-economics";

const tier = PRICE_TIERS[0], expected = { versionId: "version-a", manifestHash: "a".repeat(64), provider: "openai-compatible", model: "local-model" };
const local: PublicationInferenceEvidence = { capabilityVersionId: expected.versionId, manifestHash: expected.manifestHash, provider: expected.provider, model: expected.model, mode: "LOCAL", observedAt: "2026-10-06T10:00:00Z", basis: "LOCAL_NO_EXTERNAL_PROVIDER", estimatedCostMicroUsd: null };
describe("prepublication inference economics", () => {
  it("keeps unknown configuration cost distinct from zero even for local-looking model names", () => {
    expect(publicationEconomics(tier, "", expected)).toMatchObject({ source: "UNKNOWN", costMicroUsd: null, marginMicroUsd: null });
    expect(publicationEconomics(tier, "bad", expected)).toMatchObject({ source: "UNKNOWN" });
  });
  it("labels explicit seller estimates and preserves negative margins", () => {
    expect(publicationEconomics(tier, "2.00", expected)).toEqual({ source: "SELLER_ESTIMATE", costMicroUsd: 2_000_000, marginMicroUsd: tier.sellerNetMinor * 10_000 - 2_000_000 });
    expect(publicationEconomics(tier, "0.00", expected).source).toBe("SELLER_ESTIMATE");
  });
  it("uses known-local zero only with exact version, manifest, provider, model and time evidence", () => {
    expect(publicationEconomics(tier, "", expected, local)).toMatchObject({ source: "LOCAL_NO_EXTERNAL_PROVIDER", costMicroUsd: 0 });
    for (const mismatch of [{ capabilityVersionId: "other" }, { manifestHash: "changed" }, { model: "other" }, { provider: "anthropic" }, { observedAt: "invalid" }, { mode: "REMOTE_PROVIDER" as const }]) expect(publicationEconomics(tier, "", expected, { ...local, ...mismatch }).source).toBe("UNKNOWN");
  });
  it("distinguishes priced measured usage from provider-billed facts", () => {
    const measured: PublicationInferenceEvidence = { ...local, mode: "REMOTE_PROVIDER", basis: "MEASURED_USAGE_CONFIGURED_RATES", estimatedCostMicroUsd: 220_000 };
    expect(publicationEconomics(tier, "", expected, measured).source).toBe("MEASURED_USAGE_CONFIGURED_RATES");
    const html = renderToStaticMarkup(React.createElement(PublicationEconomics, { tier, estimate: "", onEstimate: () => {}, expected, evidence: measured }));
    expect(html).toContain("measured test usage"); expect(html).toContain("not a provider invoice");
    expect(publicationEconomics(tier, "", expected, { ...measured, estimatedCostMicroUsd: null }).source).toBe("UNKNOWN");
  });
});
