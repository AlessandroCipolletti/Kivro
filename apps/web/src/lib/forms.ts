import { ContractError, validateContractDefinition, validateInput } from "@kivro/contracts";
import type { AssetDTO, InputField, IOContract } from "./types";

export const isFileField = (field: InputField) => field.type === "FILE" || field.type === "FILES";
export function isVisible(field: InputField, input: Record<string, unknown>, fields: InputField[] = [], visited = new Set<string>()): boolean {
  if (!field.visibleWhen) return true;
  if (visited.has(field.key)) return false;
  visited.add(field.key);
  const parent = fields.find(item => item.key === field.visibleWhen!.key);
  return (!parent || isVisible(parent, input, fields, visited)) && input[field.visibleWhen.key] === field.visibleWhen.equals;
}
export function contractDefinitionError(contract: IOContract): string | undefined {
  try { validateContractDefinition(contract); return undefined; }
  catch (error) {
    if (error instanceof ContractError) {
      const fields = fieldErrors(error);
      return Object.keys(fields).length ? `${error.message} ${Object.entries(fields).map(([key, message]) => `${key}: ${message}`).join("; ")}` : error.message;
    }
    if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)) return error.issues.map(issue => `${issue.path?.join(".") || "Contract"}: ${issue.message}`).join("; ");
    return error instanceof Error ? error.message : "The contract definition is invalid.";
  }
}
export function initialInput(contract: IOContract, template: Record<string, unknown> = {}) {
  const result: Record<string, unknown> = {};
  for (const field of contract.inputs) {
    if (isFileField(field)) continue;
    const value = template[field.key] ?? field.default;
    if (value !== undefined) result[field.key] = field.type === "JSON" ? JSON.stringify(value, null, 2) : value;
    else if (field.type === "BOOLEAN") result[field.key] = false;
  }
  return result;
}
export function prepareInput(contract: IOContract, values: Record<string, unknown>, assets?: AssetDTO[]) {
  const input: Record<string, unknown> = {};
  for (const field of contract.inputs) {
    if (!isVisible(field, values, contract.inputs)) continue;
    const value = values[field.key];
    if (value === undefined || value === "") continue;
    if (field.type === "JSON" && typeof value === "string") {
      try { input[field.key] = JSON.parse(value); }
      catch { throw new ContractError("INVALID_INPUT", "Check the capability inputs.", [{ key: field.key, message: "Enter valid JSON." }]); }
    } else input[field.key] = value;
  }
  return validateInput(contract, input, assets);
}
export function fieldErrors(error: unknown): Record<string, string> {
  if (error instanceof ContractError && Array.isArray(error.details)) return Object.fromEntries(error.details.map((item: { key: string; message: string }) => [item.key, item.message]));
  return {};
}
export function checkFiles(field: InputField, files: { name: string; size: number; type: string }[], existing: AssetDTO[] = []) {
  const c = field.constraints || {};
  if (files.length + existing.length > (field.type === "FILE" ? 1 : c.maxFiles ?? 10)) throw new Error(`Choose at most ${field.type === "FILE" ? 1 : c.maxFiles ?? 10} file(s).`);
  const total = files.reduce((sum, file) => sum + file.size, 0) + existing.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (c.maxTotalSizeBytes && total > c.maxTotalSizeBytes) throw new Error("The combined file size exceeds this field's limit.");
  for (const file of files) {
    if (c.maxFileSizeBytes && file.size > c.maxFileSizeBytes) throw new Error(`${file.name} exceeds the file size limit.`);
    if (c.allowedExtensions?.length && !c.allowedExtensions.some(extension => file.name.toLowerCase().endsWith(extension))) throw new Error(`${file.name} has an unsupported extension.`);
    if (file.type && c.allowedMimeTypes?.length && !c.allowedMimeTypes.includes(file.type)) throw new Error(`${file.name} has an unsupported file type.`);
  }
}
