import type { Worker } from "./types";

export function workerStatus(worker: Worker) {
  if (worker.revokedAt) return "REVOKED";
  if (worker.policyReason) return "SECURITY_BLOCKED";
  if (worker.paused || worker.localPaused) return "PAUSED";
  return worker.healthStatus?.split(":", 1)[0] || worker.status || "UNKNOWN";
}

export function healthReason(marker?: string | null) {
  if (!marker) return null;
  const separator = marker.indexOf(":");
  return separator >= 0 ? marker.slice(separator + 1) || null : null;
}

// Only stable numeric releases are compared; unsupported formats remain unknown.
export function workerUpdateRecommended(installed: string, supported?: string): boolean {
  const parse = (version?: string) => {
    if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return null;
    const parts = version.split(".").map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
  };
  const current = parse(installed), latest = parse(supported);
  if (!current || !latest) return false;
  for (let i = 0; i < 3; i++) if (current[i] !== latest[i]) return current[i] < latest[i];
  return false;
}
