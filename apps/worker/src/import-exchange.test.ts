import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { hashManifest } from '@kivro/contracts';
import { ImportSelectionRecipeSchema } from '@kivro/contracts/import-exchange';
import { scanRuntime } from '@kivro/openclaw-adapter';
import * as process from '../../../packages/openclaw-adapter/src/process.ts';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { WorkerState } from './state.ts';
import { SecretStore } from './secrets.ts';
import { LocalCapabilitySchema, approveCapability } from './capabilities.ts';
import { validateInferenceConfig } from './inference.ts';
import { importSelectionRecipe, projectImportInventory } from './import-exchange.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  vi.stubEnv('KIVRO_WORKER_MASTER_KEY', '1'.repeat(64));
  vi.spyOn(process, 'runProcess').mockResolvedValue({ code: 0, stdout: 'OpenClaw 2026.8.2 (0965053)', stderr: '' });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-import-exchange-'))), state = new WorkerState(join(root, 'state'));
  cleanups.push(async () => { state.close(); await rm(root, { recursive: true, force: true }); });
  const personal = join(root, 'personal'), source = join(personal, 'skills', 'report', 'SKILL.md');
  await mkdir(join(personal, 'skills', 'report'), { recursive: true });
  await writeFile(join(personal, 'openclaw.json'), JSON.stringify({ env: { SECRET: 'personal-secret-never-export' } }));
  await writeFile(source, '---\nmetadata: {kivro: {requires: {inference: true}}}\n---\nUse only approved inference for this report.');
  const secrets = new SecretStore(state); await secrets.put('seller-inference', 'dedicated-test-credential');
  const offer = fixtureOffer(), config = validateInferenceConfig({ provider: offer.permissions.inference.provider, model: offer.permissions.inference.model,
    credentialRef: offer.permissions.inference.credentialRef, baseUrl: 'https://provider.example/v1', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 });
  state.set('inference', config); state.set('inferenceProof', { hash: hashManifest(config), testedAt: Date.now() });
  state.set('approvedImageId', `sha256:${'a'.repeat(64)}`); state.set('sandboxProof', { imageId: state.get('approvedImageId'), policyVersion: 1, testedAt: Date.now() });
  const manifest = LocalCapabilitySchema.parse({ capabilityVersionId: randomUUID(), permissions: offer.permissions, ioContract: offer.ioContract,
    dependencies: offer.dependencies, internalInstructions: 'Explicit bootstrap authority for reviewed inference; no selected skills.', selectedSkills: [] });
  const capability = approveCapability(state, manifest, hashManifest(manifest));
  const discovery = await scanRuntime(undefined, personal), inventory = projectImportInventory(discovery);
  const inference = inventory.dependencies.find(node => node.type === 'INFERENCE')!, credential = inventory.dependencies.find(node => node.type === 'CREDENTIAL')!;
  const recipe = ImportSelectionRecipeSchema.parse({ kind: 'KIVRO_IMPORT_SELECTION', schemaVersion: 1, discoveryHash: inventory.discoveryHash,
    selectedIds: inventory.dependencies.map(node => node.id), targets: [{ discoveredId: inference.id, kind: 'INFERENCE', ref: 'configured' }, { discoveredId: credential.id, kind: 'CREDENTIAL', ref: config.credentialRef }] });
  return { state, secrets, capability, discovery, recipe, inventory, source, personal };
}
describe('local rescanned selection import with existing approved authority', () => {
  it('exports an allowlist inventory and imports only after the existing review hash, leaving personal source and local capability unchanged', async () => {
    const { state, secrets, capability, discovery, recipe, inventory, source, personal } = await fixture();
    const before = await readFile(source, 'utf8'), personalConfig = await readFile(join(personal, 'openclaw.json'), 'utf8');
    expect(JSON.stringify(inventory)).not.toMatch(/sourcePath|personal-secret|Use only|\/personal\/|selected|approved|healthy/);
    const preview = await importSelectionRecipe(state, secrets, discovery, capability.capabilityVersionId, recipe);
    expect(preview.approved).toBe(false); expect(state.get('importedSkills')).toBeUndefined();
    const result = await importSelectionRecipe(state, secrets, discovery, capability.capabilityVersionId, recipe, preview.approvalHash);
    expect(result.approved).toBe(true); expect(state.get<{ name: string }[]>('importedSkills')?.map(skill => skill.name)).toEqual(['report']);
    expect(state.get(`capability:${capability.capabilityVersionId}`)).toEqual(capability);
    expect(await readFile(source, 'utf8')).toBe(before); expect(await readFile(join(personal, 'openclaw.json'), 'utf8')).toBe(personalConfig);
  });
  it('rejects stale rescans, tampered recipes, new authority and source changes without importing', async () => {
    const { state, secrets, capability, discovery, recipe, source } = await fixture();
    await expect(importSelectionRecipe(state, secrets, { ...discovery, version: 'changed' }, capability.capabilityVersionId, recipe)).rejects.toThrow('IMPORT_DISCOVERY_CHANGED');
    await expect(importSelectionRecipe(state, secrets, discovery, capability.capabilityVersionId, { ...recipe, permissions: capability.permissions })).rejects.toThrow();
    await expect(importSelectionRecipe(state, secrets, discovery, capability.capabilityVersionId, { ...recipe, targets: recipe.targets.map(target => ({ ...target, ref: 'not-configured' })) })).rejects.toThrow('IMPORT_INFERENCE_REFERENCE_INVALID');
    const preview = await importSelectionRecipe(state, secrets, discovery, capability.capabilityVersionId, recipe);
    await expect(importSelectionRecipe(state, secrets, discovery, capability.capabilityVersionId, recipe, '0'.repeat(64))).rejects.toThrow('IMPORT_CONSENT_MISMATCH');
    await writeFile(source, 'changed source since review');
    await expect(importSelectionRecipe(state, secrets, discovery, capability.capabilityVersionId, recipe, preview.approvalHash)).rejects.toThrow('SKILL_CHANGED_REVIEW_REQUIRED');
    expect(state.get('importedSkills')).toBeUndefined();
  });
  it('requires exact locally approved consent and blocks missing/local-modified capability contexts before inference', async () => {
    const { state, secrets, capability, discovery, recipe } = await fixture();
    await expect(importSelectionRecipe(state, secrets, discovery, randomUUID(), recipe)).rejects.toThrow('CAPABILITY_NOT_APPROVED');
    state.set(`capability:${capability.capabilityVersionId}`, { ...capability, internalInstructions: 'tampered local instructions' });
    const readSecret = vi.spyOn(secrets, 'get');
    await expect(importSelectionRecipe(state, secrets, discovery, capability.capabilityVersionId, recipe)).rejects.toThrow('LOCAL_MANIFEST_CHANGED');
    expect(readSecret).not.toHaveBeenCalled(); expect(state.get('importedSkills')).toBeUndefined();
  });
  it('requires a separate reviewed local adaptation and never strips native requirements from the browser recipe', async () => {
    const { state, secrets, capability, discovery, recipe } = await fixture();
    const changed = { ...discovery, dependencies: discovery.dependencies.map(node => node.type === 'SKILL' ? { ...node, adaptationRequired: true } : node) };
    await expect(importSelectionRecipe(state, secrets, changed, capability.capabilityVersionId, { ...recipe, discoveryHash: hashManifest(changed) })).rejects.toThrow('IMPORT_SELECTION_REVIEWED_ADAPTATION_REQUIRED');
    expect(state.get('importedSkills')).toBeUndefined();
  });
});
