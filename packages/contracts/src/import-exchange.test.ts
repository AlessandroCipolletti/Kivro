import { describe, expect, it } from 'vitest';
import { ImportInventorySchema, ImportSelectionRecipeSchema, assertImportSelection, importTargetKinds, parseImportInventoryJson, parseImportSelectionJson, IMPORT_EXCHANGE_MAX_DOCUMENT_BYTES,
  type ImportInventory, type ImportSelectionRecipe } from './import-exchange.ts';

const skillId = 'a'.repeat(64), inferenceId = 'b'.repeat(64), credentialId = 'c'.repeat(64), hash = 'd'.repeat(64);
function fixture() {
  const base = { required: true, confidence: 'DECLARED' as const, certainty: 'LIKELY' as const, support: 'REVIEW_REQUIRED' as const };
  const inventory: ImportInventory = { kind: 'KIVRO_IMPORT_INVENTORY', schemaVersion: 1, discoveryHash: hash, runtimeVersion: 'OpenClaw 2026.8.2 (0965053)', compatible: true,
    dependencies: [{ ...base, id: skillId, name: 'report', type: 'SKILL', dependsOn: [inferenceId], contentHash: hash },
      { ...base, id: inferenceId, name: 'configured', type: 'INFERENCE', dependsOn: [credentialId] },
      { ...base, id: credentialId, name: 'PROVIDER_KEY', type: 'CREDENTIAL', dependsOn: [] }] };
  const recipe: ImportSelectionRecipe = { kind: 'KIVRO_IMPORT_SELECTION', schemaVersion: 1, discoveryHash: hash, selectedIds: [skillId, inferenceId, credentialId],
    targets: [{ discoveredId: inferenceId, kind: 'INFERENCE', ref: 'configured' }, { discoveredId: credentialId, kind: 'CREDENTIAL', ref: 'dedicated-worker' }] };
  return { inventory, recipe };
}
describe('bounded browser import exchange without authority', () => {
  it('accepts explicit closed selection, leaves legacy certainty absent and never adds selected nodes', () => {
    const { inventory, recipe } = fixture(), selected = assertImportSelection(inventory, recipe);
    expect(selected.map(node => node.id)).toEqual(recipe.selectedIds); expect(recipe).not.toHaveProperty('permissions');
    const old = { ...inventory.dependencies[0]! }; delete old.certainty;
    expect(ImportInventorySchema.parse({ ...inventory, dependencies: [old] }).dependencies[0]).not.toHaveProperty('certainty');
  });
  it.each([{ sourcePath: '/private/SKILL.md' }, { content: 'private instructions' }, { credentials: 'secret' }, { approved: true }, { grants: {} }, { url: 'http://localhost:1234' }])('rejects inventory node field %j', change => {
    const { inventory } = fixture();
    expect(ImportInventorySchema.safeParse({ ...inventory, dependencies: [{ ...inventory.dependencies[0], ...change }] }).success).toBe(false);
  });
  it.each([{ permissions: {} }, { adaptations: [] }, { installs: [] }, { path: '/private/file' }, { credential: 'secret' }, { authority: {} }])('rejects recipe authority or content field %j', change => {
    const { recipe } = fixture(); expect(ImportSelectionRecipeSchema.safeParse({ ...recipe, ...change }).success).toBe(false);
  });
  it('rejects stale/tampered hashes, unknown IDs, duplicate IDs and unselected closure', () => {
    const { inventory, recipe } = fixture();
    expect(() => assertImportSelection(inventory, { ...recipe, discoveryHash: '0'.repeat(64) })).toThrow('IMPORT_DISCOVERY_CHANGED');
    expect(() => assertImportSelection(inventory, { ...recipe, selectedIds: ['0'.repeat(64)] })).toThrow('UNKNOWN_DEPENDENCY');
    expect(() => assertImportSelection(inventory, { ...recipe, selectedIds: [skillId] })).toThrow('REQUIRED_DEPENDENCY_NOT_SELECTED');
    expect(() => assertImportSelection(inventory, { ...recipe, selectedIds: [...recipe.selectedIds, skillId] })).toThrow('Duplicate selected');
    expect(ImportInventorySchema.safeParse({ ...inventory, dependencies: [...inventory.dependencies, inventory.dependencies[0]] }).success).toBe(false);
  });
  it('rejects blocked dependencies, unsupported runtime, unresolved children and cycles', () => {
    const { inventory, recipe } = fixture();
    expect(() => assertImportSelection({ ...inventory, compatible: false }, recipe)).toThrow('UNSUPPORTED_DISCOVERY_RUNTIME');
    const blocked = structuredClone(inventory); blocked.dependencies[2]!.support = 'UNSUPPORTED';
    expect(() => assertImportSelection(blocked, recipe)).toThrow('UNSUPPORTED_IMPORT_DEPENDENCY');
    const missing = structuredClone(inventory); missing.dependencies[0]!.dependsOn = ['0'.repeat(64)];
    expect(() => assertImportSelection(missing, recipe)).toThrow('UNKNOWN_DEPENDENCY');
    const cyclic = structuredClone(inventory); cyclic.dependencies[2]!.dependsOn = [skillId];
    expect(() => assertImportSelection(cyclic, recipe)).toThrow('DEPENDENCY_CYCLE');
  });
  it('requires one typed binding per selected non-skill node and refuses extras or mismatched types', () => {
    const { inventory, recipe } = fixture();
    expect(() => assertImportSelection(inventory, { ...recipe, targets: [] })).toThrow('IMPORT_DEPENDENCY_BINDING_REQUIRED');
    expect(() => assertImportSelection(inventory, { ...recipe, targets: [...recipe.targets, { discoveredId: skillId, kind: 'TOOL', ref: 'read' }] })).toThrow('UNSELECTED_IMPORT_BINDING');
    expect(() => assertImportSelection(inventory, { ...recipe, targets: [...recipe.targets, recipe.targets[0]] })).toThrow('Duplicate target');
    expect(() => assertImportSelection(inventory, { ...recipe, targets: recipe.targets.map(target => ({ ...target, kind: 'TOOL' })) })).toThrow('IMPORT_BINDING_TYPE_MISMATCH');
    expect(importTargetKinds('AI_MODEL')).toEqual(['INFERENCE']); expect(importTargetKinds('RESOURCE')).toEqual(['RESOURCE', 'CONNECTOR']); expect(importTargetKinds('SKILL')).toEqual([]);
  });
  it('bounds wire documents, node counts, selections, references and control characters without echoing malformed data', () => {
    const { inventory, recipe } = fixture();
    expect(parseImportInventoryJson(JSON.stringify(inventory))).toEqual(inventory); expect(parseImportSelectionJson(JSON.stringify(recipe))).toEqual(recipe);
    expect(() => parseImportInventoryJson('secret-invalid-json')).toThrow('INVALID_IMPORT_EXCHANGE_JSON');
    expect(() => parseImportSelectionJson('x'.repeat(IMPORT_EXCHANGE_MAX_DOCUMENT_BYTES + 1))).toThrow('IMPORT_EXCHANGE_DOCUMENT_TOO_LARGE');
    expect(ImportInventorySchema.safeParse({ ...inventory, dependencies: Array(401).fill(inventory.dependencies[0]) }).success).toBe(false);
    expect(ImportSelectionRecipeSchema.safeParse({ ...recipe, selectedIds: Array(101).fill(skillId) }).success).toBe(false);
    expect(ImportSelectionRecipeSchema.safeParse({ ...recipe, targets: [{ ...recipe.targets[0], ref: '../personal' }] }).success).toBe(false);
    expect(ImportInventorySchema.safeParse({ ...inventory, dependencies: [{ ...inventory.dependencies[0], name: 'Bearer secret\n' }] }).success).toBe(false);
  });
});
