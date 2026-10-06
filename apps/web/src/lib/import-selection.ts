import { ImportSelectionRecipeSchema, assertImportSelection, type ImportInventory, type ImportSelectionTarget } from "@kivro/contracts/import-exchange";
import type { Dependency } from "./types";

export function selectionRecipe(inventory: ImportInventory, selectedIds: string[], bindings: Record<string, Partial<ImportSelectionTarget>>) {
  const targets = selectedIds.flatMap(id => inventory.dependencies.find(node => node.id === id)?.type === "SKILL" ? [] : [{ discoveredId: id, kind: bindings[id]?.kind, ref: bindings[id]?.ref }]);
  const recipe = ImportSelectionRecipeSchema.parse({ kind: "KIVRO_IMPORT_SELECTION", schemaVersion: 1, discoveryHash: inventory.discoveryHash, selectedIds, targets });
  assertImportSelection(inventory, recipe);
  return recipe;
}

export function importedDeclarations(inventory: ImportInventory, selectedIds: string[], bindings: Record<string, Partial<ImportSelectionTarget>>): Dependency[] {
  return assertImportSelection(inventory, selectionRecipe(inventory, selectedIds, bindings)).map(node => ({
    id: node.id, name: node.name, type: node.type, required: node.type === "SKILL" || node.required,
    approved: false, healthy: false, supported: false, confidence: node.confidence,
    ...(node.certainty ? { certainty: node.certainty } : {}), dependsOn: node.dependsOn,
    source: `inventory:${inventory.discoveryHash}`, ...(node.contentHash ? { contentHash: node.contentHash } : {}),
  }));
}
