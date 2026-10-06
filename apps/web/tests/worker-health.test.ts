import { describe, expect, it } from "vitest";
import { healthReason, workerStatus, workerUpdateRecommended } from "../src/lib/worker-health";
import type { Worker } from "../src/lib/types";

const worker: Worker = { id: "worker", name: "Test device", version: "0.1.0", paused: false, sandboxReady: true };
describe("recorded worker health", () => {
  it("compares stable supported releases numerically without inferring unknown or prerequisite formats", () => {
    expect(workerUpdateRecommended("0.9.0", "0.10.0")).toBe(true);
    expect(workerUpdateRecommended("1.0.0", "0.10.0")).toBe(false);
    expect(workerUpdateRecommended("1.0.0", "1.0.0")).toBe(false);
    expect(workerUpdateRecommended("1.0.0", undefined)).toBe(false);
    expect(workerUpdateRecommended("1.0.0-beta", "1.0.0")).toBe(false);
  });
  it("never infers health from installed versions or the sandbox flag alone", () => {
    expect(workerStatus(worker)).toBe("UNKNOWN");
    expect(workerStatus({ ...worker, healthStatus: "OFFLINE:HEARTBEAT_EXPIRED" })).toBe("OFFLINE");
    expect(workerStatus({ ...worker, healthStatus: "READY:HEARTBEAT_HEALTHY" })).toBe("READY");
  });
  it("gives explicit revocation, version policy and pause precedence over recorded readiness", () => {
    const ready = { ...worker, healthStatus: "READY:HEARTBEAT_HEALTHY" };
    expect(workerStatus({ ...ready, localPaused: true })).toBe("PAUSED");
    expect(workerStatus({ ...ready, paused: true, policyReason: "WORKER_VERSION_REVOKED" })).toBe("SECURITY_BLOCKED");
    expect(workerStatus({ ...ready, policyReason: "WORKER_VERSION_REVOKED", revokedAt: "2026-10-06" })).toBe("REVOKED");
  });
  it("preserves internal reason codes without inventing missing telemetry", () => {
    expect(healthReason("NOT_READY:RUNTIME_NOT_READY")).toBe("RUNTIME_NOT_READY");
    expect(healthReason(null)).toBeNull();
    expect(healthReason("NOT_READY")).toBeNull();
  });
});
