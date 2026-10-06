import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DependencySchema, PermissionManifestSchema, hashManifest, type Dependency, type PermissionManifest } from '@kivro/contracts';
import { sha256 } from '@kivro/crypto';
import { assertPublishable } from '@kivro/policy-engine';
import { ADAPTER_POLICY_VERSION, SUPPORTED_OPENCLAW, SUPPORTED_COMMIT, SUPPORTED_TOOLS, assertWorkerPermissions, selectedDependencyClosure, readSelectedSkill, skillMetadata, type RuntimeDiscovery, type SelectedSkill } from '@kivro/openclaw-adapter';
import { LocalResourceBroker, hashResourceConfiguration } from '@kivro/resource-broker';
import { approvedResources, resourceGrantsForApproval } from './resource-config.ts';
import { ConnectorConfigSchema } from './connectors.ts';
import { inferenceReady, validateInferenceConfig } from './inference.ts';
import type { WorkerState } from './state.ts';
import type { SecretStore } from './secrets.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ImportTargetSchema = z.object({ kind: z.enum(['TOOL', 'INFERENCE', 'RESOURCE', 'CREDENTIAL', 'NETWORK', 'CONNECTOR']), ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/) }).strict();
export type ImportTarget = z.infer<typeof ImportTargetSchema>;
export const SkillImportPlanSchema = z.object({
  schemaVersion: z.literal(1), discoveryHash: digest,
  selectedIds: z.array(digest).min(1).max(100), permissions: PermissionManifestSchema,
  targets: z.array(ImportTargetSchema).min(1).max(90),
  bindings: z.array(z.object({ discoveredId: digest, dependencyId: z.string().min(1).max(128) }).strict()).max(100),
  adaptations: z.array(z.object({ skillId: digest, sourceHash: digest, instructions: z.string().min(1).max(64000) }).strict()).max(10).default([]),
}).strict();
export type ImportedSkill = SelectedSkill & { sourceHash: string; importHash: string; dependencies: Dependency[]; targets: ImportTarget[]; permissionsHash: string; imageId: string };
const provenance = 'KIVRO_REVIEWED_IMPORT_V1';
const credentialId = (ref: string) => `credential:${ref}`;

function targetDependencies(state: WorkerState, targets: ImportTarget[], permissions: PermissionManifest): Dependency[] {
  const resources = approvedResources(state, permissions);
  const dependencies = targets.map(target => {
    const base: Dependency = { id: '', name: target.ref, type: target.kind, required: true, approved: true, supported: true, healthy: true, confidence: 'DECLARED', source: provenance, dependsOn: [] };
    switch (target.kind) {
      case 'TOOL':
        if (!SUPPORTED_TOOLS.has(target.ref) || !permissions.tools.includes(target.ref)) throw new Error('IMPORT_TOOL_NOT_APPROVED');
        return { ...base, id: `tool:${target.ref}`, contentHash: hashManifest({ tool: target.ref, policyVersion: ADAPTER_POLICY_VERSION, runtime: SUPPORTED_OPENCLAW, commit: SUPPORTED_COMMIT }), grants: { tools: [target.ref] }, dependsOn: target.ref === 'research.search' ? [credentialId('research-brave')] : [] };
      case 'INFERENCE': {
        if (target.ref !== 'configured') throw new Error('IMPORT_INFERENCE_REFERENCE_INVALID');
        const config = validateInferenceConfig(state.get('inference'));
        if (config.provider !== permissions.inference.provider || config.model !== permissions.inference.model || config.credentialRef !== permissions.inference.credentialRef) throw new Error('IMPORT_INFERENCE_MISMATCH');
        return { ...base, id: 'inference', name: `${config.provider}/${config.model}`, contentHash: hashManifest(config), grants: { inferenceProviders: [config.provider] }, dependsOn: [credentialId(config.credentialRef)] };
      }
      case 'RESOURCE': {
        const resource = resources.find(item => item.id === target.ref);
        if (!resource) throw new Error('IMPORT_RESOURCE_NOT_APPROVED');
        return { ...base, id: resource.dependencyId, type: resource.type, contentHash: hashResourceConfiguration(resource), grants: { resources: [resource.id] }, dependsOn: resource.type === 'DATABASE' ? [credentialId(resource.credentialRef)] : [] };
      }
      case 'CREDENTIAL': {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(target.ref)) throw new Error('INVALID_SECRET_REFERENCE');
        const sealed = state.get(`secret:${target.ref}`);
        if (!sealed) throw new Error('IMPORT_DEDICATED_SECRET_REQUIRED');
        return { ...base, id: credentialId(target.ref), contentHash: hashManifest({ ref: target.ref, revision: hashManifest(sealed) }), grants: { credentialRefs: [target.ref] } };
      }
      case 'NETWORK':
        if (!permissions.network.allowedDomains.includes(target.ref)) throw new Error('IMPORT_DOMAIN_NOT_APPROVED');
        return { ...base, id: `domain:${target.ref}`, type: 'NETWORK_DESTINATION', contentHash: hashManifest({ domain: target.ref, mode: permissions.network.mode }), grants: { domains: [target.ref] } };
      case 'CONNECTOR': {
        const config = ConnectorConfigSchema.parse(state.get(`connector:${target.ref}`)), domain = new URL(config.endpoint).hostname;
        if (!permissions.tools.includes('connector.call') || !permissions.network.allowedDomains.includes(domain)) throw new Error('IMPORT_CONNECTOR_NOT_APPROVED');
        return { ...base, id: `connector:${config.id}`, name: config.id, contentHash: hashManifest(config), grants: { tools: ['connector.call'], domains: [domain] }, dependsOn: ['tool:connector.call', `domain:${domain}`, ...(config.credentialRef ? [credentialId(config.credentialRef)] : [])] };
      }
    }
  });
  if (new Set(dependencies.map(item => item.id)).size !== dependencies.length) throw new Error('DUPLICATE_IMPORT_TARGET');
  for (const dependency of dependencies) {
    if (dependency.dependsOn?.some(id => !dependencies.some(item => item.id === id))) throw new Error('IMPORT_TARGET_CHILD_NOT_SELECTED');
    if (dependency.type === 'CREDENTIAL' && !dependencies.some(item => item.dependsOn?.includes(dependency.id))) throw new Error('IMPORT_UNUSED_CREDENTIAL');
  }
  assertPublishable(permissions, dependencies);
  return dependencies.map(item => DependencySchema.parse(item)).sort((a, b) => a.id.localeCompare(b.id));
}

export function invalidateImportCapabilities(state: WorkerState, names: string[], reason: string): string[] {
  const affected: string[] = [];
  for (const id of state.get<string[]>('capabilityIds') ?? []) {
    const capability = state.get<{ selectedSkills: string[] }>(`capability:${id}`);
    if (!capability?.selectedSkills.some(name => names.includes(name))) continue;
    state.delete(`capabilityProof:${id}`); state.set(`capabilityHealth:${id}`, { ready: false, checkedAt: Date.now() });
    state.set(`revalidationRequired:${id}`, reason); state.audit(reason, 'LOCAL', id); affected.push(id);
  }
  return affected;
}
export function storeImportedSkills(state: WorkerState, skills: SelectedSkill[], consent: unknown): string[] {
  return state.transaction(() => {
    const existing = state.get<SelectedSkill[]>('importedSkills') ?? [];
    const changed = skills.filter(skill => hashManifest(existing.find(item => item.name === skill.name) ?? null) !== hashManifest(skill)).map(skill => skill.name);
    state.set('importedSkills', [...existing.filter(item => !skills.some(skill => skill.name === item.name)), ...skills]);
    state.set(`importConsent:${hashManifest(consent)}`, consent);
    const affected = invalidateImportCapabilities(state, changed, 'SKILL_IMPORT_REVALIDATION_REQUIRED');
    state.audit('SKILL_IMPORT_CONSENT', 'LOCAL'); return affected;
  });
}
export function revokeImportedSkill(state: WorkerState, name: string): string[] {
  return state.transaction(() => {
    const skills = state.get<SelectedSkill[]>('importedSkills') ?? [];
    if (!skills.some(skill => skill.name === name)) throw new Error('IMPORTED_SKILL_NOT_FOUND');
    state.set('importedSkills', skills.filter(skill => skill.name !== name));
    return invalidateImportCapabilities(state, [name], 'SKILL_IMPORT_REVOKED');
  });
}

export async function reviewSkillImport(state: WorkerState, secrets: SecretStore, discovery: RuntimeDiscovery, raw: unknown) {
  const plan = SkillImportPlanSchema.parse(raw);
  if (hashManifest(discovery) !== plan.discoveryHash) throw new Error('IMPORT_DISCOVERY_CHANGED');
  const selected = selectedDependencyClosure(discovery, plan.selectedIds);
  const skillNodes = selected.filter(item => item.type === 'SKILL');
  if (!skillNodes.length || skillNodes.length > 10) throw new Error('IMPORT_SKILL_COUNT');
  assertWorkerPermissions(plan.permissions);
  if (new Set(plan.bindings.map(item => item.discoveredId)).size !== plan.bindings.length || new Set(plan.adaptations.map(item => item.skillId)).size !== plan.adaptations.length) throw new Error('DUPLICATE_IMPORT_BINDING');
  if (plan.bindings.some(binding => !selected.some(item => item.id === binding.discoveredId && item.type !== 'SKILL')) || plan.adaptations.some(adaptation => !skillNodes.some(item => item.id === adaptation.skillId))) throw new Error('UNSELECTED_IMPORT_BINDING');
  const dependencies = targetDependencies(state, plan.targets, plan.permissions);
  const imageId = state.get<string>('approvedImageId'), sandbox = state.get<{ imageId: string; policyVersion: number; testedAt: number }>('sandboxProof');
  if (!imageId || sandbox?.imageId !== imageId || sandbox.policyVersion !== ADAPTER_POLICY_VERSION || Date.now() - sandbox.testedAt > 24 * 3600_000) throw new Error('IMPORT_SANDBOX_APPROVAL_REQUIRED');
  if (!(await inferenceReady(state, secrets)).ready) throw new Error('IMPORT_INFERENCE_TEST_REQUIRED');
  for (const node of selected.filter(item => item.type !== 'SKILL')) {
    const binding = plan.bindings.find(item => item.discoveredId === node.id);
    const target = dependencies.find(item => item.id === binding?.dependencyId);
    if (!target) throw new Error('IMPORT_DEPENDENCY_BINDING_REQUIRED');
    const executable = { blender: 'blender.render', ffmpeg: 'ffmpeg.transcode', psql: 'resource.query' } as Record<string, string>;
    const matches = node.type === 'EXECUTABLE' ? target.type === 'TOOL' && target.name === executable[node.name]
      : node.type === 'TOOL' ? target.type === 'TOOL' && target.name === node.name
        : node.type === 'RESOURCE' ? ['DATABASE', 'LOCAL_FILE', 'CONNECTOR'].includes(target.type) && target.name === node.name
          : ['AI_MODEL', 'INFERENCE'].includes(node.type) ? target.type === 'INFERENCE'
            : node.type === 'CREDENTIAL' ? target.type === 'CREDENTIAL'
              : node.type === 'NETWORK_DESTINATION' ? target.type === 'NETWORK_DESTINATION' && target.name === node.name : false;
    if (!matches) throw new Error('IMPORT_BINDING_TYPE_MISMATCH');
    if (node.type === 'EXECUTABLE' && node.name === 'psql' && !dependencies.some(item => item.type === 'DATABASE')) throw new Error('IMPORT_PSQL_REQUIRES_PREPARED_RESOURCE');
  }
  const resources = approvedResources(state, plan.permissions);
  const broker = new LocalResourceBroker({ resources, approval: { capabilityVersionId: randomUUID(), permissions: plan.permissions, dependencies, grants: resourceGrantsForApproval(state, plan.permissions) }, secretResolver: ref => secrets.get(ref) });
  try { await broker.checkHealth(); } finally { broker.close(); }
  const skills: (SelectedSkill & { sourceHash: string; dependency: Dependency })[] = [];
  for (const node of skillNodes) {
    const original = await readSelectedSkill(node), metadata = skillMetadata(original);
    const adaptation = plan.adaptations.find(item => item.skillId === node.id);
    if (node.adaptationRequired && !adaptation) throw new Error('IMPORT_REVIEWED_ADAPTATION_REQUIRED');
    if (adaptation && adaptation.sourceHash !== node.contentHash) throw new Error('IMPORT_ADAPTATION_SOURCE_CHANGED');
    // Strip native loader/install/environment gates only from this new reviewed
    // instruction snapshot, never by modifying the personal source skill.
    const body = adaptation?.instructions ?? metadata.body;
    const content = `---\nname: ${node.name}\ndescription: ${JSON.stringify(metadata.description)}\n---\n${body}\n\nApproved Worker references (no host secrets or shell execution):\n${JSON.stringify(dependencies.map(item => ({ id: item.id, name: item.name, type: item.type, grants: item.grants })))}`;
    const dependency: Dependency = { id: `skill:${node.name}`, name: node.name, type: 'SKILL', required: true, approved: true, supported: true, healthy: true, confidence: 'DECLARED', contentHash: sha256(content), source: `${provenance}:${node.contentHash}`, dependsOn: [...dependencies.map(item => item.id), ...node.dependsOn.filter(id => selected.find(item => item.id === id)?.type === 'SKILL').map(id => `skill:${selected.find(item => item.id === id)!.name}`)].sort() };
    skills.push({ name: node.name, content, sha256: sha256(content), sourceHash: node.contentHash!, dependency });
  }
  const graph = [...dependencies, ...skills.map(skill => skill.dependency)].sort((a, b) => a.id.localeCompare(b.id));
  assertPublishable(plan.permissions, graph);
  const review = { schemaVersion: 1, discoveryHash: plan.discoveryHash, selectedIds: [...plan.selectedIds].sort(), bindings: [...plan.bindings].sort((a, b) => a.discoveredId.localeCompare(b.discoveredId)), targets: [...plan.targets].sort((a, b) => `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`)), permissions: plan.permissions, imageId, dependencies: graph, skills: skills.map(({ dependency: _dependency, ...skill }) => skill) };
  const approvalHash = hashManifest(review);
  const imported: ImportedSkill[] = skills.map(({ dependency: _dependency, ...skill }) => ({ ...skill, importHash: approvalHash, dependencies: graph, targets: review.targets, permissionsHash: hashManifest(plan.permissions), imageId }));
  return { review, approvalHash, imported };
}

export async function importDependencySkills(state: WorkerState, secrets: SecretStore, discovery: RuntimeDiscovery, raw: unknown, approvalHash?: string) {
  const result = await reviewSkillImport(state, secrets, discovery, raw);
  if (approvalHash !== undefined && approvalHash !== result.approvalHash) throw new Error('IMPORT_CONSENT_MISMATCH');
  if (!approvalHash) return { approved: false, approvalHash: result.approvalHash, review: result.review };
  const affected = storeImportedSkills(state, result.imported, { approvalHash, review: result.review, actor: state.get('identity') ?? { localDeviceId: state.get('localDeviceId') }, approvedAt: new Date().toISOString() });
  return { approved: true, approvalHash, dependencies: result.review.dependencies, imported: result.imported.map(skill => ({ name: skill.name, sha256: skill.sha256, sourceHash: skill.sourceHash })), revalidationRequired: affected };
}

export function assertImportedSkillConsent(state: WorkerState, capability: { capabilityVersionId: string; selectedSkills: string[]; permissions: PermissionManifest; dependencies: Dependency[] }, selectedSkills: SelectedSkill[]): void {
  const imported = state.get<(SelectedSkill | ImportedSkill)[]>('importedSkills') ?? [];
  try {
    for (const name of capability.selectedSkills) {
      const skill = selectedSkills.find(item => item.name === name), current = imported.find(item => item.name === name);
      if (!skill || !current || hashManifest(skill) !== hashManifest(current) || sha256(skill.content) !== skill.sha256) throw new Error('SKILL_IMPORT_REVOKED_OR_CHANGED');
      if (!('importHash' in current)) continue;
      if (current.permissionsHash !== hashManifest(capability.permissions) || current.imageId !== state.get('approvedImageId')) throw new Error('SKILL_IMPORT_POLICY_CHANGED');
      const now = targetDependencies(state, current.targets, capability.permissions);
      const expected = current.dependencies.filter(item => item.type !== 'SKILL');
      if (hashManifest(now) !== hashManifest(expected)) throw new Error('SKILL_IMPORT_DEPENDENCY_CHANGED');
      for (const dependency of current.dependencies) if (hashManifest(capability.dependencies.find(item => item.id === dependency.id) ?? null) !== hashManifest(dependency)) throw new Error('SKILL_IMPORT_GRAPH_MISMATCH');
    }
  } catch (error) {
    state.delete(`capabilityProof:${capability.capabilityVersionId}`);
    state.set(`capabilityHealth:${capability.capabilityVersionId}`, { ready: false, checkedAt: Date.now() });
    state.set(`revalidationRequired:${capability.capabilityVersionId}`, 'SKILL_IMPORT_REVALIDATION_REQUIRED');
    throw error;
  }
}
