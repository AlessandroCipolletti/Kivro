import React from "react";
import { publicationEconomics, type PublicationInferenceEvidence } from "../lib/publication-economics";
import { money } from "../lib/format";
import type { PriceTier } from "../lib/types";
import { Field } from "./ui";

export function PublicationEconomics({ tier, estimate, onEstimate, expected, evidence }: { tier?: PriceTier; estimate: string; onEstimate: (value: string) => void; expected: { versionId?: string; manifestHash?: string; provider: string; model: string }; evidence?: PublicationInferenceEvidence }) {
  if (!tier) return null;
  const economics = publicationEconomics(tier, estimate, expected, evidence);
  const cost = (value: number | null) => value === null ? "Unknown" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value / 1_000_000);
  return <section className="stack" aria-label="Prepublication economics"><h3>Inference cost & margin</h3>
    <dl className="checkout-summary"><div><dt>Buyer price</dt><dd>{money(tier.buyerPriceMinor)}</dd></div><div><dt>Marketplace fee</dt><dd>{money(tier.platformFeeMinor)}</dd></div><div><dt>Seller proceeds before inference</dt><dd>{money(tier.sellerNetMinor)}</dd></div><div><dt>{economics.source === "LOCAL_NO_EXTERNAL_PROVIDER" ? "External inference cost" : "Estimated inference cost"}</dt><dd>{cost(economics.costMicroUsd)}</dd></div><div><dt>Estimated contribution margin</dt><dd>{cost(economics.marginMicroUsd)}</dd></div></dl>
    <p className="small muted">{economics.source === "SELLER_ESTIMATE" ? "Based on your estimate for this review, not measured provider usage. This estimate is not an enforced spending limit." : economics.source === "MEASURED_USAGE_CONFIGURED_RATES" ? `Based on measured test usage and configured rates, observed ${evidence?.observedAt}. Future jobs may cost more; this is not a provider invoice.` : economics.source === "LOCAL_NO_EXTERNAL_PROVIDER" ? "Verified local inference has no external provider charge. Local compute and electricity costs are not included." : "No priced test evidence is available for this exact version and inference configuration. Unknown cost does not mean zero."} Infrastructure costs, taxes and final profit are not included.</p>
    <Field label="Your inference estimate (USD per job)" hint="Optional estimate for this review; changing provider or model clears it."><input inputMode="decimal" value={estimate} onChange={event => onEstimate(event.target.value)} placeholder="Unknown" /></Field>
  </section>;
}
