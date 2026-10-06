import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, readFile, lstat, chmod, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashManifest, type Dependency } from '@kivro/contracts';
import { sha256 } from '@kivro/crypto';
import { discoveryId, scanRuntime, type RuntimeDiscovery } from '@kivro/openclaw-adapter';
import * as process from '../../../packages/openclaw-adapter/src/process.ts';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { WorkerState } from './state.ts';
import { SecretStore } from './secrets.ts';
import { approveResource } from './resources.ts';
import { validateInferenceConfig } from './inference.ts';
import { LocalCapabilitySchema, approveCapability, discoveredDependencyGrants } from './capabilities.ts';
import { assertCapabilityConsent } from './capability-health.ts';
import { importDependencySkills, reviewSkillImport, revokeImportedSkill, SkillImportPlanSchema, type ImportedSkill } from './imports.ts';

const cleanup: { root: string; state: WorkerState }[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const item of cleanup.splice(0)) { item.state.close(); await rm(item.root, { recursive: true, force: true }); } });
async function fixture(native = false) {
  vi.stubEnv('KIVRO_WORKER_MASTER_KEY', '1'.repeat(64));
  vi.spyOn(process, 'runProcess').mockResolvedValue({ code: 0, stdout: 'OpenClaw 2026.8.2 (0965053)', stderr: '' });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-import-'))), state = new WorkerState(join(root, 'state')); cleanup.push({ root, state });
  const personal = join(root, 'personal'), source = join(personal, 'skills', 'report', 'SKILL.md');
  await mkdir(join(personal, 'skills', 'report'), { recursive: true });
  await writeFile(join(personal, 'openclaw.json'), JSON.stringify({ env: { PROVIDER_KEY: 'personal-secret-must-not-be-imported' } }));
  await writeFile(join(personal, 'auth-profiles.json'), 'personal-auth-never-read');
  await writeFile(source, `---\nmetadata: ${JSON.stringify({ kivro: { requires: { tools: ['resource.read'], resources: ['document'], inference: true } }, ...(native ? { openclaw: { requires: { bins: ['blender'], env: ['PROVIDER_KEY'] } } } : {}) })}\n---\nRead the approved document with resource.read.`);
  const document = join(root, 'document.txt'); await writeFile(document, 'approved resource');
  const selection = { id: 'document', path: document, sha256: sha256('approved resource'), maxBytes: 1000 };
  await approveResource(state, selection, hashManifest(selection));
  const secrets = new SecretStore(state); await secrets.put('seller-inference', 'dedicated-unit-test-secret');
  const permissions = fixtureOffer().permissions; permissions.tools = ['resource.read', ...(native ? ['blender.render'] : [])]; permissions.resources = [{ id: 'document', type: 'LOCAL_FILE', access: 'READ_ONLY' }];
  const config = validateInferenceConfig({ provider: 'openai-compatible', model: 'test-model', credentialRef: 'seller-inference', baseUrl: 'https://example.com/v1', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 });
  // Unit-test fixtures only. Production proofs come from sandbox/inference tests.
  state.set('inference', config); state.set('inferenceProof', { hash: hashManifest(config), testedAt: Date.now() });
  state.set('approvedImageId', `sha256:${'2'.repeat(64)}`); state.set('sandboxProof', { imageId: state.get('approvedImageId'), policyVersion: 1, testedAt: Date.now() });
  const discovery = await scanRuntime(undefined, personal);
  const bindings = discovery.dependencies.filter(node => node.type !== 'SKILL').map(node => ({ discoveredId: node.id, dependencyId: node.type === 'CREDENTIAL' ? 'credential:seller-inference' : node.type === 'EXECUTABLE' ? 'tool:blender.render' : node.type === 'INFERENCE' ? 'inference' : node.type === 'RESOURCE' ? 'resource:document' : `tool:${node.name}` }));
  const plan = SkillImportPlanSchema.parse({ schemaVersion: 1, discoveryHash: hashManifest(discovery), permissions, selectedIds: discovery.dependencies.map(node => node.id), bindings,
    targets: [{ kind: 'INFERENCE', ref: 'configured' }, { kind: 'CREDENTIAL', ref: 'seller-inference' }, { kind: 'TOOL', ref: 'resource.read' }, { kind: 'RESOURCE', ref: 'document' }, ...(native ? [{ kind: 'TOOL', ref: 'blender.render' }] : [])],
  });
  return { root, state, secrets, personal, source, config, discovery, plan };
}
function manifest(dependencies: Dependency[], permissions: ReturnType<typeof fixtureOffer>['permissions']) {
  const offer = fixtureOffer(); return LocalCapabilitySchema.parse({ capabilityVersionId: offer.capabilityVersionId, ioContract: offer.ioContract, permissions, dependencies, internalInstructions: 'Use the reviewed report skill.', selectedSkills: ['report'] });
}
async function approved() {
  const context = await fixture(), review = await reviewSkillImport(context.state, context.secrets, context.discovery, context.plan);
  await importDependencySkills(context.state, context.secrets, context.discovery, context.plan, review.approvalHash);
  const raw = manifest(review.review.dependencies, context.plan.permissions), capability = approveCapability(context.state, raw, hashManifest(raw));
  context.state.set(`capabilityProof:${capability.capabilityVersionId}`, { fixture: true });
  return { ...context, capability, raw, review };
}
describe('explicit dependency-bearing skill import', () => {
  it('previews without importing, binds approved dependencies/content, and leaves personal content and metadata unchanged', async () => {
    const { state, secrets, discovery, plan, source, personal } = await fixture();
    const paths = [source, join(personal, 'openclaw.json'), join(personal, 'auth-profiles.json')];
    const before = await Promise.all(paths.map(async path => ({ text: await readFile(path, 'utf8'), stat: await lstat(path) })));
    const preview = await importDependencySkills(state, secrets, discovery, plan); expect(preview.approved).toBe(false); expect(state.get('importedSkills')).toBeUndefined();
    const result = await importDependencySkills(state, secrets, discovery, plan, preview.approvalHash); expect(result.approved).toBe(true);
    const imported = state.get<ImportedSkill[]>('importedSkills')!; expect(imported).toHaveLength(1);
    expect(imported[0]!.dependencies.every(node => node.contentHash && node.approved && node.supported && node.healthy)).toBe(true);
    expect(imported[0]!.content).not.toMatch(/personal-secret|personal-auth|apiKey|metadata:/);
    expect(imported[0]!.content).toContain('resource.read'); expect(imported[0]!.sourceHash).toBe(discovery.dependencies.find(node => node.type === 'SKILL')!.contentHash);
    for (let index = 0; index < paths.length; index++) {
      const path = paths[index]!, stat = await lstat(path), previous = before[index]!;
      expect(await readFile(path, 'utf8')).toBe(previous.text);
      expect([stat.mode, stat.ino, stat.mtimeMs, stat.ctimeMs]).toEqual([previous.stat.mode, previous.stat.ino, previous.stat.mtimeMs, previous.stat.ctimeMs]);
    }
    const raw = manifest(imported[0]!.dependencies, plan.permissions), cap = approveCapability(state, raw, hashManifest(raw)); expect(() => assertCapabilityConsent(state, cap)).not.toThrow();
    const suggested = discoveredDependencyGrants(state, raw); expect(suggested.find(node => node.id === 'skill:report')!.dependsOn).toContain('resource:document'); expect(new Set(suggested.map(node => node.id)).size).toBe(suggested.length);
  });
  it('requires selected closure, selected targets, scoped grants and exact type bindings', async () => {
    const { state, secrets, discovery, plan } = await fixture();
    await expect(reviewSkillImport(state, secrets, discovery, { ...plan, selectedIds: [discoveryId('SKILL', 'report')] })).rejects.toThrow('REQUIRED_DEPENDENCY_NOT_SELECTED');
    await expect(reviewSkillImport(state, secrets, discovery, { ...plan, targets: plan.targets.filter(target => target.kind !== 'CREDENTIAL') })).rejects.toThrow('IMPORT_TARGET_CHILD_NOT_SELECTED');
    await expect(reviewSkillImport(state, secrets, discovery, { ...plan, bindings: [] })).rejects.toThrow('IMPORT_DEPENDENCY_BINDING_REQUIRED');
    await expect(reviewSkillImport(state, secrets, discovery, { ...plan, bindings: plan.bindings.map(binding => ({ ...binding, dependencyId: 'inference' })) })).rejects.toThrow('IMPORT_BINDING_TYPE_MISMATCH');
    await expect(reviewSkillImport(state, secrets, discovery, { ...plan, bindings: [...plan.bindings, plan.bindings[0]] })).rejects.toThrow('DUPLICATE_IMPORT_BINDING');
    await expect(reviewSkillImport(state, secrets, discovery, { ...plan, targets: [...plan.targets, { kind: 'TOOL', ref: 'exec' }] })).rejects.toThrow('IMPORT_TOOL_NOT_APPROVED');
    expect(state.get('importedSkills')).toBeUndefined();
  });
  it('rejects stale discovery, content, consent, permission edits and changed dependencies between preview/approval', async () => {
    const { state, secrets, discovery, plan, source, config } = await fixture();
    const preview = await reviewSkillImport(state, secrets, discovery, plan);
    await expect(importDependencySkills(state, secrets, discovery, plan, '0'.repeat(64))).rejects.toThrow('IMPORT_CONSENT_MISMATCH');
    await expect(reviewSkillImport(state, secrets, { ...discovery, version: 'changed' }, plan)).rejects.toThrow('IMPORT_DISCOVERY_CHANGED');
    const changedPermissions = { ...plan.permissions, limits: { ...plan.permissions.limits, maxTokens: 63000 } };
    await expect(importDependencySkills(state, secrets, discovery, { ...plan, permissions: changedPermissions }, preview.approvalHash)).rejects.toThrow('IMPORT_CONSENT_MISMATCH');
    state.set('inference', { ...config, maxCallsPerJob: 3 }); state.set('inferenceProof', { hash: hashManifest(state.get('inference')), testedAt: Date.now() });
    await expect(importDependencySkills(state, secrets, discovery, plan, preview.approvalHash)).rejects.toThrow('IMPORT_CONSENT_MISMATCH');
    await writeFile(source, 'different instructions'); await expect(reviewSkillImport(state, secrets, discovery, plan)).rejects.toThrow('SKILL_CHANGED_REVIEW_REQUIRED');
  });
  it('requires fresh image/inference proofs and actual bounded read-only resource health', async () => {
    const { state, secrets, discovery, plan } = await fixture();
    state.delete('inferenceProof'); await expect(reviewSkillImport(state, secrets, discovery, plan)).rejects.toThrow('IMPORT_INFERENCE_TEST_REQUIRED');
    state.set('inferenceProof', { hash: hashManifest(state.get('inference')), testedAt: Date.now() });
    state.set('sandboxProof', { imageId: state.get('approvedImageId'), policyVersion: 1, testedAt: 0 }); await expect(reviewSkillImport(state, secrets, discovery, plan)).rejects.toThrow('IMPORT_SANDBOX_APPROVAL_REQUIRED');
    state.set('sandboxProof', { imageId: state.get('approvedImageId'), policyVersion: 1, testedAt: Date.now() });
    const file = join(state.root, 'resources', 'document'); await chmod(file, 0o600); await writeFile(file, 'tampered'); await chmod(file, 0o400);
    await expect(reviewSkillImport(state, secrets, discovery, plan)).rejects.toThrow(); expect(state.get('importedSkills')).toBeUndefined();
  });
  it('requires explicit reviewed adaptation for native binary/environment requirements, without copying secrets or shell commands', async () => {
    const { state, secrets, discovery, plan, source } = await fixture(true), skill = discovery.dependencies.find(node => node.type === 'SKILL')!;
    await expect(reviewSkillImport(state, secrets, discovery, plan)).rejects.toThrow('IMPORT_REVIEWED_ADAPTATION_REQUIRED');
    const adaptation = { skillId: skill.id, sourceHash: skill.contentHash!, instructions: 'Read resource document; use only blender.render with declared paths. Inference uses the dedicated broker.' };
    const original = await readFile(source, 'utf8');
    const review = await reviewSkillImport(state, secrets, discovery, { ...plan, adaptations: [adaptation] });
    await importDependencySkills(state, secrets, discovery, { ...plan, adaptations: [adaptation] }, review.approvalHash);
    expect(await readFile(source, 'utf8')).toBe(original); expect(review.imported[0]!.content).toContain(adaptation.instructions);
    expect(review.imported[0]!.content).not.toMatch(/PROVIDER_KEY|requires:|bins:/);
    await expect(reviewSkillImport(state, secrets, discovery, { ...plan, adaptations: [{ ...adaptation, sourceHash: '0'.repeat(64) }] })).rejects.toThrow('IMPORT_ADAPTATION_SOURCE_CHANGED');
  });
  it('invalidates proof immediately on credential rotation and requires fresh import consent/new immutable capability version', async () => {
    const { state, secrets, discovery, plan, capability, raw } = await approved();
    await secrets.put('seller-inference', 'rotated-dedicated-unit-secret');
    expect(state.get(`capabilityProof:${capability.capabilityVersionId}`)).toBeUndefined(); expect(state.get('inferenceProof')).toBeUndefined();
    expect(() => assertCapabilityConsent(state, capability)).toThrow('SKILL_IMPORT_DEPENDENCY_CHANGED');
    state.set('inferenceProof', { hash: hashManifest(state.get('inference')), testedAt: Date.now() });
    const review = await reviewSkillImport(state, secrets, discovery, plan); await importDependencySkills(state, secrets, discovery, plan, review.approvalHash);
    const changed = { ...raw, dependencies: review.review.dependencies };
    expect(() => approveCapability(state, changed, hashManifest(changed))).toThrow('IMMUTABLE_CAPABILITY_VERSION');
    const next = { ...changed, capabilityVersionId: randomUUID() }; expect(() => approveCapability(state, next, hashManifest(next))).not.toThrow();
    expect(state.get(`capabilityProof:${next.capabilityVersionId}`)).toBeUndefined();
  });
  it('invalidates changed resource/config/graph approval and revocation without mutating historical snapshots', async () => {
    const { state, capability, raw } = await approved();
    const pinned = state.get(`skills:${capability.capabilityVersionId}`);
    const altered = { ...raw, dependencies: raw.dependencies.map(dependency => dependency.type === 'SKILL' ? { ...dependency, dependsOn: [] } : dependency), capabilityVersionId: randomUUID() };
    expect(() => approveCapability(state, altered, hashManifest(altered))).toThrow('SKILL_IMPORT_GRAPH_MISMATCH');
    state.set('inference', { ...state.get<object>('inference'), maxCallsPerJob: 2 });
    expect(() => assertCapabilityConsent(state, capability)).toThrow('SKILL_IMPORT_DEPENDENCY_CHANGED');
    expect(state.get(`capabilityProof:${capability.capabilityVersionId}`)).toBeUndefined();
    expect(revokeImportedSkill(state, 'report')).toEqual([capability.capabilityVersionId]);
    expect(() => assertCapabilityConsent(state, capability)).toThrow('SKILL_IMPORT_REVOKED_OR_CHANGED');
    expect(state.get(`skills:${capability.capabilityVersionId}`)).toEqual(pinned);
  });
  it('requires every skill in the explicit transitive skill closure to be selected for capability execution', async () => {
    const { state, secrets, discovery, plan } = await fixture();
    const report = discovery.dependencies.find(node => node.type === 'SKILL')!;
    const missing: RuntimeDiscovery = { ...discovery, dependencies: discovery.dependencies.map(node => node.id === report.id ? { ...node, dependsOn: [...node.dependsOn, discoveryId('SKILL', 'absent')] } : node) };
    await expect(reviewSkillImport(state, secrets, missing, { ...plan, discoveryHash: hashManifest(missing) })).rejects.toThrow('UNKNOWN_DEPENDENCY');
  });
});
