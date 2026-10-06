import type { CapabilityDTO } from "@kivro/contracts";
import { agentPlanResponseSchema, agentPlanStepResponseSchema, type AgentPlanResponseDTO } from "@kivro/contracts/responses";

export function planStepFixture(cap: CapabilityDTO, overrides: Partial<AgentPlanResponseDTO["steps"][number]> = {}) {
  const now = new Date().toISOString();
  return agentPlanStepResponseSchema.parse({
    id: crypto.randomUUID(), capabilityId: cap.id, capabilityVersionId: cap.versionId,
    dependsOn: [], inputMapping: [], status: "PLANNED", contractSnapshot: cap.ioContract,
    capabilityDefinitionHash: "a".repeat(64),
    quote: { id: crypto.randomUUID(), capabilityId: cap.id, capabilityVersionId: cap.versionId, amountMinor: 99,
      expiresAt: new Date(Date.now() + 300000).toISOString(), earliestStartAt: now, estimatedDeliveryAt: new Date(Date.now() + 60000).toISOString() },
    ...overrides,
  });
}

export function planFixture(userId: string, steps: AgentPlanResponseDTO["steps"], overrides: Partial<AgentPlanResponseDTO> = {}) {
  const now = new Date().toISOString();
  return agentPlanResponseSchema.parse({
    id: crypto.randomUUID(), userId, revision: 1, goal: "Review the fixture plan.", status: "AWAITING_APPROVAL", steps,
    estimatedCostMinor: steps.length * 99, constraints: { maxTotalSpendMinor: 400, maxJobs: 4, blockedSellers: [], noNetwork: false },
    timing: { mode: "IMMEDIATE", maxQueueWaitSeconds: 0 }, estimatedCompletionAt: new Date(Date.now() + 60000).toISOString(),
    createdAt: now, updatedAt: now, ...overrides,
  });
}
