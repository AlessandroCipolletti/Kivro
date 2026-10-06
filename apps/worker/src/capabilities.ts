import { z } from 'zod';
import { hashManifest, IOContractSchema, PermissionManifestSchema, DependencySchema, type Dependency } from '@kivro/contracts';
import { assertWorkerFileContract, assertWorkerPermissions, buildOpenClawConfig, SUPPORTED_OPENCLAW, SUPPORTED_COMMIT } from '@kivro/openclaw-adapter';
import { assertPublishable } from '@kivro/policy-engine';
import { offerManifestHash } from '@kivro/job-protocol';
import type { WorkerState } from './state.ts';
import { resourceGrantsForApproval } from './resource-config.ts';
import { selectedConnectors } from './connectors.ts';
import { assertImportedSkillConsent, type ImportedSkill } from './imports.ts';

export const LocalCapabilitySchema = z.object({ capabilityVersionId: z.string().uuid(), ioContract: IOContractSchema, permissions: PermissionManifestSchema, internalInstructions: z.string().min(1).max(50000), dependencies: z.array(DependencySchema).max(100).default([]), selectedSkills: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/)).max(10).default([]) }).strict();
export type LocalCapability = z.infer<typeof LocalCapabilitySchema> & { manifestHash: string; consentHash: string; approvedAt: string; skillsHash: string };
export function approveCapability(state: WorkerState, raw: unknown, approvalHash: string): LocalCapability {
  const manifest = LocalCapabilitySchema.parse(raw); assertWorkerPermissions(manifest.permissions);
  assertWorkerFileContract(manifest.ioContract);
  assertPublishable(manifest.permissions, manifest.dependencies);
  const hash = hashManifest(manifest);
  if (approvalHash !== hash) throw new Error(`CAPABILITY_APPROVAL_REQUIRED:${hash}`);
  const skills = state.get<{ name: string; sha256: string; content: string }[]>('importedSkills') ?? [];
  for (const name of manifest.selectedSkills) {
    const skill = skills.find(skill => skill.name === name);
    if (!skill) throw new Error('SKILL_EXPLICIT_IMPORT_REQUIRED');
    if (!manifest.dependencies.some(dep => dep.type === 'SKILL' && dep.name === name && dep.contentHash === skill.sha256 && dep.approved && dep.healthy && dep.supported === true)) throw new Error('SKILL_DEPENDENCY_HASH_REQUIRED');
  }
  if (manifest.dependencies.some(dep => dep.type === 'SKILL' && dep.approved && !manifest.selectedSkills.includes(dep.name))) throw new Error('UNSELECTED_SKILL_DEPENDENCY');
  assertImportedSkillConsent(state, manifest, skills.filter(skill => manifest.selectedSkills.includes(skill.name)));
  for (const resource of manifest.permissions.resources) if (!state.get(`resource:${resource.id}`) && !state.get(`brokerResource:${resource.id}`)) throw new Error('RESOURCE_EXPLICIT_APPROVAL_REQUIRED');
  const dependencyIds = new Set(manifest.dependencies.map(dependency => dependency.id));
  for (const dependency of manifest.dependencies) {
    if (dependency.required && (!dependency.approved || dependency.supported !== true)) throw new Error('DEPENDENCY_CONSENT_REQUIRED');
    if (dependency.dependsOn?.some(id => !dependencyIds.has(id))) throw new Error('UNRESOLVED_DEPENDENCY_CLOSURE');
  }
  const existing = state.get<LocalCapability>(`capability:${manifest.capabilityVersionId}`);
  const resourceGrants = resourceGrantsForApproval(state, manifest.permissions);
  selectedConnectors(state, manifest.permissions, manifest.dependencies);
  const approved = { ...manifest, manifestHash: offerManifestHash(manifest), consentHash: hash, approvedAt: new Date().toISOString(), skillsHash: hashManifest(skills.filter(skill => manifest.selectedSkills.includes(skill.name))) };
  if (existing && (existing.consentHash !== hash || existing.skillsHash !== approved.skillsHash)) throw new Error('IMMUTABLE_CAPABILITY_VERSION');
  state.transaction(() => {
    state.set(`capability:${manifest.capabilityVersionId}`, approved);
    state.set(`resourceGrants:${manifest.capabilityVersionId}`, resourceGrants);
    state.set(`skills:${manifest.capabilityVersionId}`, skills.filter(skill => manifest.selectedSkills.includes(skill.name)));
    state.set(`consent:${manifest.capabilityVersionId}`, { actor: state.get('identity') ?? { localDeviceId: state.get('localDeviceId') }, manifestHash: approved.manifestHash, consentHash: approved.consentHash, approvedAt: approved.approvedAt, dependencies: manifest.dependencies, skillsHash: approved.skillsHash, imageId: state.get('approvedImageId'), resourceHashes: manifest.permissions.resources.map(resource => ({ id: resource.id, hash: hashManifest(state.get(`resource:${resource.id}`) ?? state.get(`brokerResource:${resource.id}`)) })) });
    const ids = state.get<string[]>('capabilityIds') ?? []; state.set('capabilityIds', [...new Set([...ids, manifest.capabilityVersionId])]);
    state.audit('CAPABILITY_PERMISSION_CONSENT', 'LOCAL', manifest.capabilityVersionId);
  });
  return approved;
}

export function discoveredDependencyGrants(state: WorkerState, capability: z.infer<typeof LocalCapabilitySchema>): Dependency[] {
  const inference = capability.permissions.inference;
  const imported = (state.get<ImportedSkill[]>('importedSkills') ?? []).filter(skill => capability.selectedSkills.includes(skill.name)).flatMap(skill => skill.dependencies ?? []);
  const approvedGraph = [...new Map(imported.map(dependency => [dependency.id, dependency])).values()];
  const suggestions: Dependency[] = [
    { id: 'openclaw-runtime', name: `OpenClaw ${SUPPORTED_OPENCLAW} (${SUPPORTED_COMMIT})`, type: 'RUNTIME', required: true, approved: false, healthy: !!state.get('sandboxProof'), confidence: 'DETECTED', supported: true, contentHash: hashManifest({ version: SUPPORTED_OPENCLAW, commit: SUPPORTED_COMMIT, config: buildOpenClawConfig(capability.permissions) }), source: 'KIVRO_PINNED_CONTAINER_CONFIG', dependsOn: [] },
    ...(state.get<{ name: string; sha256: string }[]>('importedSkills') ?? []).filter(skill => capability.selectedSkills.includes(skill.name)).map(skill => ({ id: `skill:${skill.name}`, name: skill.name, type: 'SKILL', required: true, approved: false, healthy: true, confidence: 'DETECTED' as const, supported: true, contentHash: skill.sha256, source: 'EXPLICIT_LOCAL_SNAPSHOT', dependsOn: [] })),
    { id: 'inference', name: `${inference.provider}/${inference.model}`, type: 'INFERENCE', required: true, approved: false, healthy: !!state.get('inferenceProof'), confidence: 'DECLARED', supported: true, dependsOn: ['inference-credential'], grants: { inferenceProviders: [inference.provider] } },
    { id: 'inference-credential', name: 'Dedicated seller credential', type: 'CREDENTIAL', required: true, approved: false, healthy: !!state.get(`secret:${inference.credentialRef}`), confidence: 'DECLARED', supported: true, dependsOn: [], grants: { credentialRefs: inference.credentialRef ? [inference.credentialRef] : [] } },
    ...capability.permissions.tools.map(tool => ({ id: `tool:${tool}`, name: tool, type: 'TOOL', required: true, approved: false, healthy: true, confidence: 'DECLARED' as const, supported: true, dependsOn: [], grants: { tools: [tool] } })),
    ...capability.permissions.resources.map(resource => ({ id: `resource:${resource.id}`, name: resource.id, type: resource.type, required: true, approved: false, healthy: !!state.get(`resource:${resource.id}`) || !!state.get(`brokerResource:${resource.id}`), confidence: 'DECLARED' as const, supported: true, dependsOn: [], grants: { resources: [resource.id] } })),
    ...capability.permissions.network.allowedDomains.map(domain => ({ id: `domain:${domain}`, name: domain, type: 'NETWORK_DESTINATION', required: true, approved: false, healthy: true, confidence: 'DECLARED' as const, supported: true, dependsOn: [], grants: { domains: [domain] } })),
  ];
  return [...approvedGraph.map(dependency => ({ ...dependency, approved: false })), ...suggestions.filter(dependency => !approvedGraph.some(imported => imported.id === dependency.id || (dependency.type === 'CREDENTIAL' && imported.grants?.credentialRefs?.some(ref => dependency.grants?.credentialRefs?.includes(ref)))))];
}
