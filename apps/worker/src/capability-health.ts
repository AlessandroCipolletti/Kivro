import { hashManifest, executionManifestHash } from '@kivro/contracts';
import { assertPublishable } from '@kivro/policy-engine';
import { assertWorkerFileContract, assertWorkerPermissions, RESEARCH_DOWNLOAD_POLICY_VERSION } from '@kivro/openclaw-adapter';
import { createResourceBroker } from './resource-config.ts';
import { selectedConnectors } from './connectors.ts';
import type { LocalCapability } from './capabilities.ts';
import type { WorkerState } from './state.ts';
import type { SecretStore } from './secrets.ts';
import { assertImportedSkillConsent } from './imports.ts';
import { selectedResearchConsent } from './research-config.ts';
import { selectedResearchScanner } from './research-scanner.ts';

export function assertCapabilityConsent(state: WorkerState, capability: LocalCapability): void {
  assertImportedSkillConsent(state, capability, state.get(`skills:${capability.capabilityVersionId}`) ?? []);
  assertWorkerPermissions(capability.permissions); assertPublishable(capability.permissions, capability.dependencies);
  assertWorkerFileContract(capability.ioContract);
  if (executionManifestHash(capability) !== capability.manifestHash) throw new Error('LOCAL_MANIFEST_CHANGED');
  const consent = state.get<{ imageId: string; skillsHash: string; consentHash: string; resourceHashes: { id: string; hash: string }[] }>(`consent:${capability.capabilityVersionId}`);
  if (!consent || consent.consentHash !== capability.consentHash || consent.imageId !== state.get('approvedImageId') || hashManifest(state.get(`skills:${capability.capabilityVersionId}`) ?? []) !== consent.skillsHash) throw new Error('LOCAL_CONSENT_CHANGED');
  for (const resource of consent.resourceHashes) if (hashManifest(state.get(`resource:${resource.id}`) ?? state.get(`brokerResource:${resource.id}`)) !== resource.hash) throw new Error('RESOURCE_CONSENT_CHANGED');
  selectedConnectors(state, capability.permissions, capability.dependencies);
  selectedResearchConsent(state, capability);
  if (capability.permissions.network.downloads) {
    selectedResearchScanner(state);
    const proof = state.get<{ imageId: string; version: number; testedAt: number }>('sandboxDownloadProof');
    if (!proof || proof.imageId !== state.get('approvedImageId') || proof.version !== RESEARCH_DOWNLOAD_POLICY_VERSION || proof.testedAt > Date.now() || Date.now() - proof.testedAt > 86400000) throw new Error('SANDBOX_DOWNLOAD_UPDATE_REQUIRED');
  }
}
export async function checkCapabilityResources(state: WorkerState, secrets: SecretStore, capability: LocalCapability): Promise<void> {
  assertCapabilityConsent(state, capability);
  const broker = createResourceBroker(state, secrets, capability);
  try { await broker.checkHealth(); } finally { broker.close(); }
}
