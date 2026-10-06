import { sellerWorkerResponseSchema } from "@kivro/contracts/responses";
type WorkerResponse = ReturnType<typeof sellerWorkerResponseSchema.parse>;

export function workerFixture(overrides: Partial<WorkerResponse> = {}): WorkerResponse {
  return sellerWorkerResponseSchema.parse({ id: crypto.randomUUID(), name: "Recorded worker fixture", version: "0.1.0", openclawVersion: "2026.8.2",
    sandboxReady: false, paused: false, localPaused: false, revokedAt: null, lastSeenAt: null, health: {}, healthStatus: "OFFLINE:HEARTBEAT_EXPIRED", runningJobIds: [], createdAt: "2026-10-06T10:00:00.000Z", bindings: [],
    minimumWorkerVersion: "0.1.0", minimumOpenClawVersion: "2026.8.2", latestSupportedWorkerVersion: "0.1.0", latestSupportedOpenClawVersion: "2026.8.2", policyReason: null, healthHistory: [], ...overrides });
}
