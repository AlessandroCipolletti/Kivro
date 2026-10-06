import type { Dependency, IOContract, PermissionManifest } from "./types";

export function workerManifest(capabilityVersionId: string, draft: { ioContract: IOContract; permissions: PermissionManifest; internalInstructions: string; dependencies: Dependency[] }) {
  return { capabilityVersionId, ioContract: draft.ioContract, permissions: draft.permissions, internalInstructions: draft.internalInstructions, dependencies: draft.dependencies, selectedSkills: [] as string[] };
}
