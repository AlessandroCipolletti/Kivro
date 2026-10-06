import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile, symlink, link, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashManifest } from '@kivro/contracts';
import { sha256 } from '@kivro/crypto';
import { ADAPTER_POLICY_VERSION, SUPPORTED_OPENCLAW } from '@kivro/openclaw-adapter';
import * as adapter from '@kivro/openclaw-adapter';
import * as localInference from './local-inference.ts';
import * as importExchange from './import-exchange.ts';
import { IMPORT_EXCHANGE_MAX_DOCUMENT_BYTES } from '@kivro/contracts/import-exchange';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { main } from './index.ts';
import { approveCapability, LocalCapabilitySchema } from './capabilities.ts';
import { validateInferenceConfig } from './inference.ts';
import { CAPABILITY_PACKAGE_MAX_BYTES, parseCapabilityPackage } from './capability-package.ts';
import { WorkerState } from './state.ts';

const roots: string[] = [], states: WorkerState[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const state of states.splice(0)) state.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-cli-packages-'))); roots.push(root);
  const state = new WorkerState(join(root, 'worker')); states.push(state);
  vi.stubEnv('KIVRO_WORKER_HOME', state.root);
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true), offer = fixtureOffer();
  const raw = LocalCapabilitySchema.parse({ capabilityVersionId: offer.capabilityVersionId, ioContract: offer.ioContract,
    permissions: offer.permissions, dependencies: offer.dependencies, internalInstructions: offer.internalInstructions });
  state.set('approvedImageId', `sha256:${'2'.repeat(64)}`);
  state.set('inference', validateInferenceConfig({ provider: 'openai-compatible', model: 'test-model', credentialRef: 'seller-inference',
    baseUrl: 'http://127.0.0.1:8080/v1', allowLocal: true, inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 }));
  const capability = approveCapability(state, raw, hashManifest(raw));
  const output = () => String(stdout.mock.calls.at(-1)![0]);
  const snapshot = () => ['settings', 'audit', 'attempts', 'outbox', 'commands'].map(table => state.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return { root, state, capability, stdout, output, snapshot };
}

describe('explicit package and seller-test CLI hooks', () => {
  it('exports only projected inventory and delegates bounded selection with explicit local authority and approval', async () => {
    const { root, capability, output, snapshot } = await fixture(), id = sha256('selected-skill');
    const discovery: adapter.RuntimeDiscovery = { version: SUPPORTED_OPENCLAW, compatible: true, configReadable: true, warnings: [],
      dependencies: [{ id, name: 'report', type: 'SKILL', required: true, selected: false, confidence: 'DETECTED', support: 'SUPPORTED', dependsOn: [],
        sourcePath: '/Users/private/selected/SKILL.md', contentHash: sha256('selected-content') }] };
    const scan = vi.spyOn(adapter, 'scanRuntime').mockResolvedValue(discovery), discover = vi.spyOn(localInference, 'discoverLocalInference');
    const before = snapshot(); await main(['scan', '--inventory', '--config-root', root]);
    const inventory = JSON.parse(output()); expect(inventory).toMatchObject({ kind: 'KIVRO_IMPORT_INVENTORY', discoveryHash: hashManifest(discovery) });
    expect(JSON.stringify(inventory)).not.toMatch(/sourcePath|\/Users\/private|selected-content/); expect(discover).not.toHaveBeenCalled();
    const recipe = { kind: 'KIVRO_IMPORT_SELECTION', schemaVersion: 1, discoveryHash: inventory.discoveryHash, selectedIds: [id], targets: [] };
    const file = join(root, 'selection.json'); await writeFile(file, JSON.stringify(recipe));
    const selection = vi.spyOn(importExchange, 'importSelectionRecipe').mockResolvedValue({ approved: false, approvalHash: 'review-hash',
      review: { schemaVersion: 1, discoveryHash: recipe.discoveryHash, selectedIds: [id], bindings: [], targets: [], permissions: capability.permissions,
        imageId: `sha256:${'2'.repeat(64)}`, dependencies: [], skills: [] } });
    const command = ['import', 'selection', capability.capabilityVersionId, '--file', file, '--config-root', root];
    await main(command); expect(scan).toHaveBeenLastCalledWith(undefined, root);
    expect(selection.mock.calls[0]!.slice(2)).toEqual([discovery, capability.capabilityVersionId, recipe, undefined]);
    await main([...command, '--approve', 'explicit-review-hash']);
    expect(selection.mock.calls[1]!.slice(2)).toEqual([discovery, capability.capabilityVersionId, recipe, 'explicit-review-hash']);
    expect(snapshot()).toEqual(before);
    selection.mockClear(); await writeFile(file, JSON.stringify({ ...recipe, permissions: capability.permissions }));
    await expect(main(command)).rejects.toThrow(); expect(selection).not.toHaveBeenCalled();
    await truncate(file, IMPORT_EXCHANGE_MAX_DOCUMENT_BYTES + 1); await expect(main(command)).rejects.toThrow('IMPORT_EXCHANGE_TOO_LARGE');
    await expect(main(['import', 'selection'])).rejects.toThrow('VERSION_ID_REQUIRED');
    await expect(main(['import', 'selection', capability.capabilityVersionId, '--file', file, '--ids', id])).rejects.toThrow('IMPORT_SELECTION_OR_LEGACY_IDS_NOT_BOTH');
    await expect(main(['health', '--inventory'])).rejects.toThrow('INVENTORY_REQUIRES_SCAN');
  });
  it('discovers local inference metadata read-only and keeps volatile availability outside the scan approval hash', async () => {
    const { root, output, snapshot } = await fixture(), before = snapshot();
    const candidate: adapter.LocalInferenceMetadata = { runtime: 'OLLAMA', provider: 'openai-compatible', endpoint: 'http://127.0.0.1:11434/v1',
      models: ['example-model'], requiredService: 'Ollama server', hardwareRequirements: null };
    const discovery: adapter.RuntimeDiscovery = { version: SUPPORTED_OPENCLAW, compatible: true, configReadable: true, dependencies: [], warnings: [], localInference: [candidate] };
    const scan = vi.spyOn(adapter, 'scanRuntime').mockResolvedValue(discovery);
    const discover = vi.spyOn(localInference, 'discoverLocalInference').mockResolvedValue([{ ...candidate, availability: 'AVAILABLE', checkedAt: 1, latencyMs: 1, minimalInferenceVerified: false }]);
    await main(['inference', 'discover', '--config-root', root]);
    expect(scan).toHaveBeenLastCalledWith(undefined, root, { skills: false }); expect(discover).toHaveBeenLastCalledWith([candidate]);
    expect(JSON.parse(output())).toMatchObject({ localInference: [{ availability: 'AVAILABLE', minimalInferenceVerified: false }] });
    await main(['scan', '--config-root', root]); const first = JSON.parse(output());
    expect(first.approvalHash).toBe(hashManifest(discovery));
    discover.mockResolvedValue([{ ...candidate, availability: 'UNREACHABLE', checkedAt: 2, latencyMs: 2000, minimalInferenceVerified: false }]);
    await main(['scan', '--config-root', root]); const second = JSON.parse(output());
    expect(second.approvalHash).toBe(first.approvalHash); expect(second.localInference[0].availability).toBe('UNREACHABLE');
    expect(snapshot()).toEqual(before);
    await expect(main(['inference', 'discover', '--approve', 'hash'])).rejects.toThrow('INVALID_INFERENCE_DISCOVERY_COMMAND');
    await expect(main(['inference', 'discover', 'extra'])).rejects.toThrow('INVALID_INFERENCE_DISCOVERY_COMMAND');
    await expect(main(['inference', 'configure', '--config-root', root])).rejects.toThrow('CONFIG_ROOT_ONLY_FOR_READ_ONLY_DISCOVERY');
  });
  it('reviews the exact package then exports raw JSON only with current approval, without changing Worker state', async () => {
    const { capability, output, snapshot } = await fixture(), before = snapshot();
    const command = ['capability', 'package-export', capability.capabilityVersionId, '--price-tier', 'USD_99'];
    await main(command); const review = JSON.parse(output()) as { package: unknown; approvalHash: string; approved: boolean };
    expect(review.approved).toBe(false); expect(parseCapabilityPackage(review.package).content.definition.capabilityVersionId).toBe(capability.capabilityVersionId);
    await expect(main([...command, '--approve', '0'.repeat(64)])).rejects.toThrow('CAPABILITY_PACKAGE_EXPORT_REVIEW_REQUIRED');
    await main([...command, '--approve', review.approvalHash]);
    const exported = JSON.parse(output()); expect(exported).toEqual(review.package); expect(typeof exported).toBe('object');
    expect(output().endsWith('\n')).toBe(true); expect(snapshot()).toEqual(before);
    await expect(main(['capability', 'package-export', capability.capabilityVersionId])).rejects.toThrow('PRICE_TIER_REQUIRED');
    await expect(main(['limits', 'status', '--price-tier', 'USD_99'])).rejects.toThrow('PACKAGE_OPTIONS_REQUIRE_EXPORT');
  });
  it('previews a new local package version without transferring approval, skills, secrets or proofs', async () => {
    const { root, capability, output, snapshot, state } = await fixture();
    await main(['capability', 'package-export', capability.capabilityVersionId, '--price-tier', 'USD_99']);
    const { package: pkg } = JSON.parse(output()), file = join(root, 'package.json'), id = randomUUID();
    await writeFile(file, `${JSON.stringify(pkg)}${' '.repeat(2 * 1024 ** 2)}`); const before = snapshot();
    await main(['capability', 'package-import-preview', id, '--file', file]);
    const preview = JSON.parse(output());
    expect(preview).toMatchObject({ status: 'REVIEW_REQUIRED', permissionsGranted: false, testsAccepted: false, definition: { capabilityVersionId: id } });
    expect(preview.definition.dependencies.every((node: { approved: boolean; healthy: boolean; supported: boolean }) => !node.approved && !node.healthy && !node.supported)).toBe(true);
    expect(snapshot()).toEqual(before); expect(state.get(`capability:${id}`)).toBeUndefined();
    await expect(main(['capability', 'package-import-preview', id, '--file', file, '--approve', hashManifest(pkg)])).rejects.toThrow('PACKAGE_PREVIEW_CANNOT_APPROVE');
    await expect(main(['capability', 'package-import-preview', capability.capabilityVersionId, '--file', file])).rejects.toThrow('CAPABILITY_PACKAGE_NEW_VERSION_REQUIRED');
  });
  it('binds the explicitly supplied publication evidence into both review and approved export', async () => {
    const { root, capability, state, output, snapshot } = await fixture();
    const config = state.get('inference'), testedAt = Date.now() - 1000;
    const evidence = { schemaVersion: 1, source: 'SIGNED_WORKER_VALIDATION', capabilityVersionId: capability.capabilityVersionId,
      manifestHash: capability.manifestHash, recordedAt: new Date().toISOString(), workerId: randomUUID(), workerVersion: '0.1.0',
      openclawVersion: SUPPORTED_OPENCLAW, workerConfig: { schemaVersion: 1, executionManifestHash: capability.manifestHash, inferenceConfigHash: hashManifest(config) },
      sandbox: { imageId: state.get('approvedImageId'), policyVersion: ADAPTER_POLICY_VERSION, testedAt }, inferenceTestedAt: testedAt,
      dependencyBundleHash: hashManifest(capability.dependencies), skills: [] };
    const publicationEvidence = { ...evidence, evidenceHash: hashManifest(evidence) }, file = join(root, 'evidence.json');
    await writeFile(file, JSON.stringify(publicationEvidence)); const before = snapshot();
    const base = ['capability', 'package-export', capability.capabilityVersionId, '--price-tier', 'USD_99'];
    const command = [...base, '--publication-evidence', file];
    await main(command); const review = JSON.parse(output()); expect(review.package.content.publicationEvidence).toEqual(publicationEvidence);
    await expect(main([...base, '--approve', review.approvalHash])).rejects.toThrow('CAPABILITY_PACKAGE_EXPORT_REVIEW_REQUIRED');
    await main([...command, '--approve', review.approvalHash]); expect(parseCapabilityPackage(output()).content.publicationEvidence).toEqual(publicationEvidence);
    expect(snapshot()).toEqual(before);
  });
  it('bounds the package before reading and rejects links, directories, malformed bytes and incomplete commands', async () => {
    const { root, snapshot } = await fixture(), id = randomUUID(), file = join(root, 'package.json'), linked = join(root, 'linked.json'), hard = join(root, 'hard.json');
    const command = ['capability', 'package-import-preview', id, '--file']; const before = snapshot();
    await writeFile(file, '{}'); await symlink(file, linked);
    await expect(main([...command, linked])).rejects.toThrow('UNSAFE_CAPABILITY_PACKAGE_FILE');
    await expect(main([...command, root])).rejects.toThrow('UNSAFE_CAPABILITY_PACKAGE_FILE');
    await link(file, hard); await expect(main([...command, file])).rejects.toThrow('UNSAFE_CAPABILITY_PACKAGE_FILE'); await rm(hard);
    await truncate(file, CAPABILITY_PACKAGE_MAX_BYTES + 1); await expect(main([...command, file])).rejects.toThrow('CAPABILITY_PACKAGE_TOO_LARGE');
    await writeFile(file, Buffer.from([0xff, 0xfe])); await expect(main([...command, file])).rejects.toThrow('CAPABILITY_PACKAGE_INVALID');
    await expect(main(['capability', 'package-import-preview', id])).rejects.toThrow('FILE_REQUIRED');
    await expect(main(['capability', 'package-import-preview'])).rejects.toThrow('VERSION_ID_REQUIRED');
    expect(snapshot()).toEqual(before);
  });
  it('allows portable test bundles above ordinary config size and rejects changed manifests before any execution', async () => {
    const { root, capability, state, snapshot } = await fixture(), bytes = Buffer.from('Test data\n'.repeat(220000)), id = randomUUID(), file = join(root, 'test.json');
    const bundle = { kind: 'KIVRO_SELLER_TEST', schemaVersion: 1, capabilityVersionId: capability.capabilityVersionId,
      manifestHash: '0'.repeat(64), input: { source: id }, assets: [{ id, filename: 'sample.txt', mimeType: 'text/plain',
        sizeBytes: bytes.length, sha256: sha256(bytes), contentBase64: bytes.toString('base64') }] };
    const json = JSON.stringify(bundle); expect(Buffer.byteLength(json)).toBeGreaterThan(2 * 1024 ** 2); await writeFile(file, json);
    const before = snapshot();
    await expect(main(['capability', 'test', capability.capabilityVersionId, '--file', file])).rejects.toThrow('SELLER_TEST_VERSION_MISMATCH');
    expect(snapshot()).toEqual(before); expect(state.get('inferenceProof')).toBeUndefined();
    await expect(main(['limits', 'configure', '--file', file])).rejects.toThrow('CONFIG_FILE_TOO_LARGE');
    await expect(main(['capability', 'test', capability.capabilityVersionId])).rejects.toThrow('FILE_REQUIRED');
  });
});
