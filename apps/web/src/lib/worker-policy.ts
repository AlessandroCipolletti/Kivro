import { executionFileCompatibilityIssues, SUPPORTED_EXECUTION_TOOLS, WORKER_FILE_FORMATS } from "@kivro/contracts";
import type { InputConstraints } from "@kivro/contracts";
import type { IOContract, PermissionManifest } from "./types";

function formats(...allowedExtensions: string[]): Required<Pick<InputConstraints, "allowedExtensions" | "allowedMimeTypes">> {
  return { allowedExtensions, allowedMimeTypes: [...new Set(allowedExtensions.map(extension => WORKER_FILE_FORMATS[extension]))] };
}
export const filePresets: Record<string, ReturnType<typeof formats>> = {
  Images: formats(".jpg", ".jpeg", ".png", ".webp"),
  Video: formats(".mp4", ".mov", ".webm"),
  Audio: formats(".wav", ".mp3", ".m4a"),
  Documents: formats(".pdf", ".txt", ".md"),
  Data: formats(".csv", ".json"),
  "3D / Blender": formats(".blend", ".obj", ".fbx"),
};

// Mirrors the current adapter until its bounds are exposed by the browser-safe contract.
export const WORKER_BYTE_LIMIT = 16 * 1024 ** 2;
export const workerLimitBounds: Record<keyof PermissionManifest["limits"], { min: number; max: number }> = {
  timeoutSeconds: { min: 5, max: 3600 }, memoryMb: { min: 1024, max: 8192 },
  cpu: { min: 0.1, max: 8 }, maxPids: { min: 64, max: 512 },
  maxInputBytes: { min: 1, max: WORKER_BYTE_LIMIT }, maxOutputBytes: { min: 1, max: WORKER_BYTE_LIMIT },
  maxTokens: { min: 1, max: 200000 },
};
export function defaultWorkerPermissions(): PermissionManifest {
  return { schemaVersion: 1, tools: [], network: { mode: "NONE", allowedDomains: [] }, resources: [],
    inference: { provider: "openai-compatible", model: "" },
    limits: { timeoutSeconds: 300, memoryMb: 1024, cpu: 1, maxPids: 64, maxInputBytes: WORKER_BYTE_LIMIT, maxOutputBytes: WORKER_BYTE_LIMIT, maxTokens: 8000 } };
}
export function workerCompatibilityIssues(permissions: PermissionManifest, contract?: IOContract): string[] {
  const issues = contract ? executionFileCompatibilityIssues(contract) : [];
  for (const [name, bounds] of Object.entries(workerLimitBounds)) {
    const value = permissions.limits[name as keyof PermissionManifest["limits"]];
    if (value < bounds.min || value > bounds.max) issues.push(`${name} must be between ${bounds.min} and ${bounds.max} for the current worker.`);
  }
  if (!["openai-compatible", "anthropic"].includes(permissions.inference.provider)) issues.push("The current worker supports openai-compatible and anthropic inference transports.");
  if (permissions.tools.some(tool => !(SUPPORTED_EXECUTION_TOOLS as readonly string[]).includes(tool))) issues.push("The selected tools include an unsupported execution tool.");
  if (permissions.tools.some(tool => tool.startsWith("research.")) && permissions.network.mode !== "RESEARCH") issues.push("Research tools require Public research broker network access.");
  if (permissions.tools.includes("connector.call") && permissions.network.mode !== "CONNECTORS") issues.push("connector.call requires Declared connectors network access.");
  if (permissions.network.mode !== "NONE" && !permissions.network.allowedDomains.length) issues.push("Network access requires explicit allowed domains.");
  if (permissions.network.mode === "NONE" && permissions.network.allowedDomains.length) issues.push("No network access cannot include allowed domains.");
  permissions.resources.forEach(resource => {
    if (!["LOCAL_FILE", "DATABASE"].includes(resource.type)) issues.push(`${resource.type} is unsupported by the current worker. Remove or replace ${resource.id} before execution.`);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(resource.id)) issues.push(`Resource ${resource.id || "ID"} must start with a letter and use at most 80 letters, digits, hyphens or underscores.`);
  });
  for (const field of contract?.inputs || []) {
    if (["FILE", "FILES"].includes(field.type) && [field.constraints?.maxFileSizeBytes, field.constraints?.maxTotalSizeBytes].some(value => value !== undefined && value > permissions.limits.maxInputBytes)) issues.push(`Input ${field.label} exceeds the worker's total input byte limit.`);
  }
  if (contract?.output.files && contract.output.files.maxTotalSizeBytes > permissions.limits.maxOutputBytes) issues.push("Output files exceed the worker's total output byte limit.");
  for (const field of contract?.output.fields || []) {
    if (["FILE", "FILES"].includes(field.type) && [field.constraints?.maxFileSizeBytes, field.constraints?.maxTotalSizeBytes].some(value => value !== undefined && value > permissions.limits.maxOutputBytes)) issues.push(`Output ${field.label} exceeds the worker's total output byte limit.`);
  }
  return issues;
}
