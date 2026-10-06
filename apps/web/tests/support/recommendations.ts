import { PRICE_TIERS, type CapabilityDTO } from "@kivro/contracts";
import type { AgentRecommendation } from "../../src/lib/types";
import { defaultWorkerPermissions } from "../../src/lib/worker-policy";

export function recommendationCapability(title = "Document research", id = "b0000000-0000-4000-8000-000000000001"): CapabilityDTO {
  const permissions = defaultWorkerPermissions(); permissions.inference.model = "synthetic-recommendation-fixture";
  return { id, slug: id, title, summary: "Synthetic catalog record for recommendation UI acceptance.", description: "No live work is executed.", category: "Documents", tags: ["research"], seller: { id: "b0000000-0000-4000-8000-000000000003", name: "Boundary seller" }, visibility: "PUBLIC", version: 1, versionId: "b0000000-0000-4000-8000-000000000002", priceTierId: PRICE_TIERS[0].id, permissions, dependencies: [], examples: [], availability: { status: "ONLINE", canRunNow: true, canQueue: false, nextAvailableAt: null, reason: null }, estimatedDurationSeconds: 60, successRate: null, completedJobs: 0, rating: null, reviewCount: 0, ioContract: { schemaVersion: 1, inputs: [{ key: "brief", label: "Brief", type: "SHORT_TEXT", required: true, order: 0 }], output: { type: "TEXT", required: true, description: "A structured summary" } } };
}
export function recommendationDetail(cap = recommendationCapability()): AgentRecommendation {
  return { capabilityId: cap.id, capabilityVersionId: cap.versionId, capabilityTitle: cap.title, generatedAt: "2026-10-06T10:00:00Z", reason: "Buyer-preferred capability. Public catalog keywords match: document, research. Matches the selected catalog constraints.", matchedTerms: ["document", "research"], preferred: true,
    price: { currency: "USD", amountMinor: 99, label: "$0.99 USD per job" }, rating: { value: null, reviewCount: 0, label: "Not rated (0 reviews)" },
    timing: { status: "ONLINE", estimatedRuntimeSeconds: 60, canRunNow: true, canQueue: false, nextAvailableAt: null, estimatedQueueWaitSeconds: null, label: "ONLINE; estimated runtime 60 seconds" },
    permissions: { networkMode: "NONE", tools: [], resourceCount: 0, label: "Sandbox network: NONE; tools: none; declared read-only resources: 0" },
    io: { requiredInputs: [{ key: "brief", type: "SHORT_TEXT" }], outputType: "TEXT", allowedMimeTypes: [], allowedExtensions: [], label: "1 required inputs; TEXT output" },
    tradeoffs: ["Estimated runtime is 15 seconds longer than the fastest compared match."],
    limitations: ["Requires buyer input: brief (SHORT_TEXT).", "PDF file output is not declared by this contract.", "Runtime and availability are estimates at recommendation time, not a reserved execution slot."] };
}
