import { decimalToMinor } from "./format";
import type { PriceTier } from "./types";

export type PublicationInferenceEvidence = {
  capabilityVersionId: string; manifestHash: string; provider: string; model: string;
  mode: "LOCAL" | "REMOTE_PROVIDER"; observedAt: string;
  estimatedCostMicroUsd: number | null; basis: "MEASURED_USAGE_CONFIGURED_RATES" | "LOCAL_NO_EXTERNAL_PROVIDER";
};

export function publicationEconomics(tier: PriceTier, estimate: string, expected: { versionId?: string; manifestHash?: string; provider: string; model: string }, evidence?: PublicationInferenceEvidence) {
  const validEvidence = evidence && evidence.capabilityVersionId === expected.versionId && evidence.manifestHash === expected.manifestHash &&
    evidence.provider === expected.provider && evidence.model === expected.model && Number.isFinite(Date.parse(evidence.observedAt));
  if (validEvidence && evidence.mode === "LOCAL" && evidence.basis === "LOCAL_NO_EXTERNAL_PROVIDER") return { costMicroUsd: 0, marginMicroUsd: tier.sellerNetMinor * 10_000, source: "LOCAL_NO_EXTERNAL_PROVIDER" as const };
  if (validEvidence && evidence.mode === "REMOTE_PROVIDER" && evidence.basis === "MEASURED_USAGE_CONFIGURED_RATES" && evidence.estimatedCostMicroUsd !== null && Number.isSafeInteger(evidence.estimatedCostMicroUsd) && evidence.estimatedCostMicroUsd >= 0) {
    return { costMicroUsd: evidence.estimatedCostMicroUsd, marginMicroUsd: tier.sellerNetMinor * 10_000 - evidence.estimatedCostMicroUsd, source: "MEASURED_USAGE_CONFIGURED_RATES" as const };
  }
  const minor = decimalToMinor(estimate);
  return minor === null ? { costMicroUsd: null, marginMicroUsd: null, source: "UNKNOWN" as const } :
    { costMicroUsd: minor * 10_000, marginMicroUsd: (tier.sellerNetMinor - minor) * 10_000, source: "SELLER_ESTIMATE" as const };
}
