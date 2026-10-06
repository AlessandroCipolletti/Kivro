import { z } from 'zod';

export const IMPORT_EXCHANGE_MAX_DOCUMENT_BYTES = 512 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
export const ImportInventoryDependencySchema = z.object({
  id: digest, name: z.string().min(1).max(200).regex(/^[A-Za-z0-9_][A-Za-z0-9_./:@-]*$/),
  type: z.enum(['SKILL', 'AI_MODEL', 'CREDENTIAL', 'EXECUTABLE', 'PLUGIN', 'TOOL', 'RESOURCE', 'INFERENCE', 'NETWORK_DESTINATION', 'CONFIGURATION']),
  required: z.boolean(), confidence: z.enum(['DECLARED', 'DETECTED', 'INFERRED']),
  certainty: z.enum(['CONFIRMED', 'LIKELY', 'POSSIBLE', 'UNKNOWN']).optional(),
  support: z.enum(['SUPPORTED', 'REVIEW_REQUIRED', 'DEDICATED_CREDENTIAL_REQUIRED', 'UNSUPPORTED']),
  dependsOn: z.array(digest).max(100), contentHash: digest.optional(), adaptationRequired: z.boolean().optional(),
  reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,119}$/).optional(),
}).strict();
export const ImportInventorySchema = z.object({
  kind: z.literal('KIVRO_IMPORT_INVENTORY'), schemaVersion: z.literal(1), discoveryHash: digest,
  runtimeVersion: z.string().min(1).max(100).regex(/^[A-Za-z0-9 .()_-]+$/).nullable(), compatible: z.boolean(),
  dependencies: z.array(ImportInventoryDependencySchema).max(400),
}).strict().superRefine((inventory, ctx) => {
  if (new Set(inventory.dependencies.map(item => item.id)).size !== inventory.dependencies.length) ctx.addIssue({ code: 'custom', path: ['dependencies'], message: 'Duplicate inventory dependency ID' });
});
export const ImportSelectionTargetSchema = z.object({
  discoveredId: digest, kind: z.enum(['TOOL', 'INFERENCE', 'RESOURCE', 'CREDENTIAL', 'NETWORK', 'CONNECTOR']), ref: reference,
}).strict();
export const ImportSelectionRecipeSchema = z.object({
  kind: z.literal('KIVRO_IMPORT_SELECTION'), schemaVersion: z.literal(1), discoveryHash: digest,
  selectedIds: z.array(digest).min(1).max(100), targets: z.array(ImportSelectionTargetSchema).max(100),
}).strict().superRefine((recipe, ctx) => {
  if (new Set(recipe.selectedIds).size !== recipe.selectedIds.length) ctx.addIssue({ code: 'custom', path: ['selectedIds'], message: 'Duplicate selected dependency ID' });
  if (new Set(recipe.targets.map(item => item.discoveredId)).size !== recipe.targets.length) ctx.addIssue({ code: 'custom', path: ['targets'], message: 'Duplicate target binding' });
});
export type ImportInventory = z.infer<typeof ImportInventorySchema>;
export type ImportInventoryDependency = z.infer<typeof ImportInventoryDependencySchema>;
export type ImportSelectionRecipe = z.infer<typeof ImportSelectionRecipeSchema>;
export type ImportSelectionTarget = z.infer<typeof ImportSelectionTargetSchema>;

function parseDocument(text: string): unknown {
  if (new TextEncoder().encode(text).byteLength > IMPORT_EXCHANGE_MAX_DOCUMENT_BYTES) throw new Error('IMPORT_EXCHANGE_DOCUMENT_TOO_LARGE');
  try { return JSON.parse(text); } catch { throw new Error('INVALID_IMPORT_EXCHANGE_JSON'); }
}
export function parseImportInventoryJson(text: string): ImportInventory { return ImportInventorySchema.parse(parseDocument(text)); }
export function parseImportSelectionJson(text: string): ImportSelectionRecipe { return ImportSelectionRecipeSchema.parse(parseDocument(text)); }

export function importTargetKinds(type: ImportInventoryDependency['type']): ImportSelectionTarget['kind'][] {
  if (type === 'EXECUTABLE' || type === 'TOOL') return ['TOOL'];
  if (type === 'AI_MODEL' || type === 'INFERENCE') return ['INFERENCE'];
  if (type === 'CREDENTIAL') return ['CREDENTIAL'];
  if (type === 'RESOURCE') return ['RESOURCE', 'CONNECTOR'];
  if (type === 'NETWORK_DESTINATION') return ['NETWORK'];
  return [];
}

/** Selection must already include its entire reviewed closure; this never adds a node or a permission. */
export function assertImportSelection(rawInventory: unknown, rawRecipe: unknown): ImportInventoryDependency[] {
  const inventory = ImportInventorySchema.parse(rawInventory), recipe = ImportSelectionRecipeSchema.parse(rawRecipe);
  if (inventory.discoveryHash !== recipe.discoveryHash) throw new Error('IMPORT_DISCOVERY_CHANGED');
  if (!inventory.compatible) throw new Error('UNSUPPORTED_DISCOVERY_RUNTIME');
  const byId = new Map(inventory.dependencies.map(node => [node.id, node])), selected = new Set(recipe.selectedIds);
  const active = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) throw new Error('DEPENDENCY_CYCLE');
    if (visited.has(id)) return;
    const node = byId.get(id);
    if (!node) throw new Error('UNKNOWN_DEPENDENCY');
    if (!selected.has(id)) throw new Error('REQUIRED_DEPENDENCY_NOT_SELECTED');
    if (node.support === 'UNSUPPORTED') throw new Error('UNSUPPORTED_IMPORT_DEPENDENCY');
    active.add(id); node.dependsOn.forEach(visit); active.delete(id); visited.add(id);
  };
  recipe.selectedIds.forEach(visit);
  if (recipe.targets.some(target => !selected.has(target.discoveredId) || byId.get(target.discoveredId)?.type === 'SKILL')) throw new Error('UNSELECTED_IMPORT_BINDING');
  for (const id of recipe.selectedIds) {
    const node = byId.get(id)!;
    if (node.type === 'SKILL') continue;
    const target = recipe.targets.find(binding => binding.discoveredId === id);
    if (!target) throw new Error('IMPORT_DEPENDENCY_BINDING_REQUIRED');
    if (!importTargetKinds(node.type).includes(target.kind)) throw new Error('IMPORT_BINDING_TYPE_MISMATCH');
  }
  return recipe.selectedIds.map(id => byId.get(id)!);
}
