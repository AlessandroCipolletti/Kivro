import { WORKER_WARNING_CATALOG, WorkerWarningSnapshotSchema, type WorkerWarningSnapshot } from "@kivro/contracts";

export function warningFixture(): WorkerWarningSnapshot {
  const observedAt = "2026-10-06T10:00:00.000Z", workerId = "e0000000-0000-4000-8000-000000000001";
  return WorkerWarningSnapshotSchema.parse({ schemaVersion: 1, observedAt, capabilityVersionsChecked: 1, truncated: false,
    coverage: { capabilityScope: "BOUND_VERSIONS_ONLY", localSignals: "STALE", ignoredSignalCount: 1, deviceRevocationSchedule: "UNAVAILABLE" },
    items: [{ id: "worker-policy", code: "WORKER_VERSION_REVOKED", ...WORKER_WARNING_CATALOG.WORKER_VERSION_REVOKED, affectedEntity: { workerId, capabilityId: null, capabilityVersionId: null }, detectedAt: "2026-10-05T10:00:00.000Z", lastObservedAt: observedAt, detectedAtBasis: "FIRST_PLATFORM_OBSERVATION", source: "PLATFORM_STATE", blocking: true },
      { id: "worker-dependency", code: "DEPENDENCY_UNAVAILABLE", ...WORKER_WARNING_CATALOG.DEPENDENCY_UNAVAILABLE, affectedEntity: { workerId, capabilityId: "e0000000-0000-4000-8000-000000000002", capabilityVersionId: "e0000000-0000-4000-8000-000000000003" }, detectedAt: observedAt, lastObservedAt: observedAt, detectedAtBasis: "FIRST_PLATFORM_OBSERVATION", source: "WORKER_REPORT", blocking: false }],
  });
}
