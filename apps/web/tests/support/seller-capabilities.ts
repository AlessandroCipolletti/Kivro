import { parseApiResponse } from "@kivro/contracts/responses";
import type { SellerCapability } from "../../src/lib/types";
import { recommendationCapability } from "./recommendations";

export function sellerCapabilityFixture(overrides: Partial<SellerCapability> = {}): SellerCapability {
  const base = recommendationCapability("Seller capability fixture");
  const cap: SellerCapability = { ...base, visibility: "PRIVATE", lifecycleRevision: 0, concurrency: 2, maxQueue: 3, maxScheduled: 5,
    currentVersionId: base.versionId, draftVersionId: null,
    liveState: { observedAt: "2026-10-06T10:00:00Z", runningJobs: 0, queueDepth: 0, scheduledJobs: 0, effectiveConcurrency: 0, capacityLoad: 0, lastSuccess: null }, ...overrides };
  return (parseApiResponse("GET", "/api/seller/capabilities", 200, [cap]) as SellerCapability[])[0];
}
