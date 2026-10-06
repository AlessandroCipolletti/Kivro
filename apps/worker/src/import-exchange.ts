import { hashManifest } from '@kivro/contracts';
import { ImportInventorySchema, ImportSelectionRecipeSchema, assertImportSelection, type ImportSelectionTarget } from '@kivro/contracts/import-exchange';
import type { RuntimeDiscovery } from '@kivro/openclaw-adapter';
import type { WorkerState } from './state.ts';
import type { SecretStore } from './secrets.ts';
import { LocalCapabilitySchema, type LocalCapability } from './capabilities.ts';
import { assertCapabilityConsent } from './capability-health.ts';
import { approvedResources } from './resource-config.ts';
import { importDependencySkills } from './imports.ts';

/** Explicit allowlist projection; the full read-only scan stays local. */
export function projectImportInventory(discovery: RuntimeDiscovery) {
  return ImportInventorySchema.parse({ kind: 'KIVRO_IMPORT_INVENTORY', schemaVersion: 1, discoveryHash: hashManifest(discovery),
    runtimeVersion: discovery.version, compatible: discovery.compatible,
    dependencies: discovery.dependencies.map(node => ({ id: node.id, name: node.name, type: node.type, required: node.required,
      confidence: node.confidence, support: node.support, dependsOn: node.dependsOn,
      ...(node.certainty ? { certainty: node.certainty } : {}), ...(node.contentHash ? { contentHash: node.contentHash } : {}),
      ...(node.adaptationRequired !== undefined ? { adaptationRequired: node.adaptationRequired } : {}), ...(node.reason ? { reason: node.reason } : {}) })),
  });
}

export async function importSelectionRecipe(state: WorkerState, secrets: SecretStore, discovery: RuntimeDiscovery, localCapabilityVersionId: string, raw: unknown, approvalHash?: string) {
  const recipe = ImportSelectionRecipeSchema.parse(raw), selected = assertImportSelection(projectImportInventory(discovery), recipe);
  const local = state.get<LocalCapability>(`capability:${localCapabilityVersionId}`);
  if (!local) throw new Error('CAPABILITY_NOT_APPROVED');
  assertCapabilityConsent(state, local);
  const capability = LocalCapabilitySchema.parse({ capabilityVersionId: local.capabilityVersionId, ioContract: local.ioContract,
    permissions: local.permissions, internalInstructions: local.internalInstructions, dependencies: local.dependencies, selectedSkills: local.selectedSkills });
  if (capability.capabilityVersionId !== localCapabilityVersionId) throw new Error('IMPORT_CAPABILITY_BINDING_MISMATCH');
  if (selected.some(node => node.adaptationRequired)) throw new Error('IMPORT_SELECTION_REVIEWED_ADAPTATION_REQUIRED');
  const resources = approvedResources(state, capability.permissions);
  const dependencyId = (target: ImportSelectionTarget): string => {
    switch (target.kind) {
      case 'TOOL': return `tool:${target.ref}`;
      case 'INFERENCE': return 'inference';
      case 'CREDENTIAL': return `credential:${target.ref}`;
      case 'NETWORK': return `domain:${target.ref}`;
      case 'CONNECTOR': return `connector:${target.ref}`;
      case 'RESOURCE': {
        const resource = resources.find(item => item.id === target.ref);
        if (!resource) throw new Error('IMPORT_RESOURCE_NOT_APPROVED');
        return resource.dependencyId;
      }
    }
  };
  const targets = [...new Map(recipe.targets.map(({ kind, ref }) => [`${kind}:${ref}`, { kind, ref }])).values()];
  // Only authority already approved in local capability/resource configuration can enter this plan.
  const plan = { schemaVersion: 1, discoveryHash: recipe.discoveryHash, selectedIds: recipe.selectedIds,
    permissions: capability.permissions, targets, bindings: recipe.targets.map(target => ({ discoveredId: target.discoveredId, dependencyId: dependencyId(target) })), adaptations: [] };
  return importDependencySkills(state, secrets, discovery, plan, approvalHash);
}
