import { AssetDTOSchema, validateInput, validateOutput, type AssetDTO, type CapabilityExampleDTO, type InputField, type IOContract, type JobOutput } from "@kivro/contracts";
import { initialInput, prepareInput } from "./forms";

export interface ExampleTemplate { capabilityId: string; capabilityVersionId: string; input: Record<string, unknown>; assets: AssetDTO[] }
export interface ExampleJobPreview { jobId: string; capabilityVersionId: string; targetVersionId: string; input: Record<string, unknown>; outputValue: JobOutput; inputAssets: AssetDTO[]; outputAssets: AssetDTO[] }
export interface ExamplePublicationAsset { asset: AssetDTO; input: boolean; output: boolean }

export function exampleAssetUrl(capabilityId: string, exampleId: string, asset: AssetDTO): string | undefined {
  const expected = `/api/capabilities/${encodeURIComponent(capabilityId)}/examples/${encodeURIComponent(exampleId)}/assets/${encodeURIComponent(asset.id)}`;
  return asset.downloadUrl === expected ? expected : undefined;
}
export function exampleOutput(example: CapabilityExampleDTO, contract: IOContract): JobOutput {
  if (example.outputValue) return { ...example.outputValue, ...(example.outputAssets ? { assets: example.outputAssets.map(plainAsset) } : {}) };
  if (contract.output.type === "JSON") { try { return { json: JSON.parse(example.output) }; } catch { return { text: example.output }; } }
  return { text: example.output };
}
export function plainAsset(asset: AssetDTO): AssetDTO {
  return AssetDTOSchema.parse({ id: asset.id, filename: asset.filename, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, sha256: asset.sha256, ...(asset.downloadUrl ? { downloadUrl: asset.downloadUrl } : {}), ...(asset.expiresAt ? { expiresAt: asset.expiresAt } : {}) });
}
export function exampleFileIds(fields: ReadonlyArray<Pick<InputField, "key" | "type">>, values: Record<string, unknown>): string[] {
  return [...new Set(fields.flatMap(field => {
    const value = values[field.key];
    return field.type === "FILE" && typeof value === "string" ? [value] : field.type === "FILES" && Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  }))];
}
export function exampleTemplateValues(contract: IOContract, template: ExampleTemplate, capabilityId: string, versionId: string) {
  if (template.capabilityId !== capabilityId || template.capabilityVersionId !== versionId) throw new Error("The example version changed. Reload the capability before copying a template.");
  const assets = template.assets.map(plainAsset), available = new Set(assets.map(asset => asset.id));
  if (available.size !== assets.length) throw new Error("The template returned duplicate file records.");
  const values = initialInput(contract, template.input);
  for (const field of contract.inputs.filter(field => ["FILE", "FILES"].includes(field.type))) {
    if (template.input[field.key] === undefined) continue;
    const raw = template.input[field.key];
    if (field.type === "FILE" ? typeof raw !== "string" : !Array.isArray(raw) || raw.some(id => typeof id !== "string")) throw new Error("Template file references are malformed.");
    const ids = exampleFileIds([field], template.input);
    if (!ids.length || ids.some(id => !available.has(id))) throw new Error("Template file ownership was not confirmed. Reload the example.");
    values[field.key] = field.type === "FILE" ? ids[0] : ids;
  }
  return { values, assets };
}
export function exampleOutputFields(contract: IOContract): IOContract {
  return { schemaVersion: 1, inputs: (contract.output.fields || []).map(field => ({ ...field, type: field.type === "MARKDOWN" ? "LONG_TEXT" : field.type })), output: { type: "TEXT", description: "", required: false } };
}
export function exampleOutputFiles(contract: IOContract): IOContract {
  const limits = contract.output.files;
  return { schemaVersion: 1, inputs: limits ? [{ key: "attachments", label: "Additional output files", type: "FILES", required: false, order: 0, constraints: { ...limits, maxFileSizeBytes: Math.min(100 * 1024 ** 2, limits.maxTotalSizeBytes) } }] : [], output: { type: "TEXT", description: "", required: false } };
}
export function prepareExampleOutput(contract: IOContract, text: string, json: string, fields: Record<string, unknown>, attachments: Record<string, unknown>, uploaded: AssetDTO[]): JobOutput {
  const named = contract.output.fields?.length ? prepareInput(exampleOutputFields(contract), fields, uploaded) : undefined;
  const namedFiles = exampleFileIds(exampleOutputFields(contract).inputs, named || {});
  const ids = [...new Set([...namedFiles, ...exampleFileIds(exampleOutputFiles(contract).inputs, attachments)])];
  const assets = ids.map(id => { const asset = uploaded.find(item => item.id === id); if (!asset) throw new Error("An output file is missing its verified metadata."); return plainAsset(asset); });
  const output: JobOutput = {
    ...(["TEXT", "MIXED"].includes(contract.output.type) && text !== "" ? { text } : {}),
    ...(contract.output.jsonSchema && json.trim() ? { json: JSON.parse(json) } : {}),
    ...(named ? { fields: named } : {}), ...(assets.length ? { assets } : {}),
  };
  return validateOutput(contract, output);
}
export function publicationAssets(contract: IOContract, input: Record<string, unknown>, output: JobOutput, available: AssetDTO[]): ExamplePublicationAsset[] {
  const inputs = exampleFileIds(contract.inputs, input), outputs = (output.assets || []).map(asset => asset.id);
  const ids = [...new Set([...inputs, ...outputs])];
  if (ids.length > 40) throw new Error("An example may reference at most 40 files.");
  const rows = ids.map(id => { const asset = available.find(item => item.id === id); if (!asset) throw new Error("Every example file needs verified metadata before public consent."); return { asset: plainAsset(asset), input: inputs.includes(id), output: outputs.includes(id) }; });
  if (rows.reduce((size, item) => size + item.asset.sizeBytes, 0) > 100 * 1024 ** 2) throw new Error("An example may copy at most 100 MiB of files.");
  validateInput(contract, input, rows.map(row => row.asset)); validateOutput(contract, output);
  return rows;
}
export function publicationConsent(assets: ExamplePublicationAsset[], approved: string[], reusable: string[], confirmed: boolean) {
  const ids = assets.map(item => item.asset.id);
  if (!confirmed || new Set(approved).size !== approved.length || approved.length !== ids.length || ids.some(id => !approved.includes(id))) throw new Error("Approve every referenced file and confirm the publication rights.");
  if (new Set(reusable).size !== reusable.length || reusable.some(id => !assets.some(item => item.asset.id === id && item.input))) throw new Error("Only selected input files can be reusable templates.");
  return { approvedAssetIds: approved, reusableInputAssetIds: reusable, confirmPublic: true as const };
}
