import { WORKER_FILE_FORMATS } from "@kivro/contracts";
import { SellerTestAssetSchema, SellerTestBundleSchema, SELLER_TEST_MAX_FILES, SELLER_TEST_MAX_FILE_BYTES, SELLER_TEST_MAX_TOTAL_BYTES, type SellerTestAsset } from "@kivro/contracts/seller-test";
import type { CapabilityDTO, IOContract, PermissionManifest } from "./types";
import { isFileField, prepareInput } from "./forms";

export async function sellerTestAsset(file: File): Promise<SellerTestAsset> {
  if (file.size > SELLER_TEST_MAX_FILE_BYTES) throw new Error("Local test files cannot exceed 8 MiB.");
  const extension = Object.keys(WORKER_FILE_FORMATS).find(extension => file.name.toLowerCase().endsWith(extension));
  const mimeType = extension ? WORKER_FILE_FORMATS[extension] : undefined;
  if (!mimeType || (file.type && file.type !== mimeType)) throw new Error("Choose a file in a reviewed Worker format with a matching media type.");
  const buffer = await file.arrayBuffer(), data = new Uint8Array(buffer);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  let binary = "";
  for (let offset = 0; offset < data.length; offset += 8192) binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
  return SellerTestAssetSchema.parse({ id: crypto.randomUUID(), filename: file.name, mimeType, sizeBytes: data.length,
    sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""), contentBase64: btoa(binary) });
}

export function sellerTestBundle(saved: { versionId: string; manifestHash?: string; ioContract: IOContract; permissions: PermissionManifest; executionFileLimits?: CapabilityDTO["executionFileLimits"] }, values: Record<string, unknown>, selected: SellerTestAsset[]) {
  if (!saved.manifestHash) throw new Error("Refresh the saved version to obtain its frozen manifest hash.");
  const metadata = selected.map(({ contentBase64: _content, ...asset }) => asset);
  const input = prepareInput(saved.ioContract, values, metadata);
  const referenced = new Set(saved.ioContract.inputs.filter(isFileField).flatMap(field => {
    const value = input[field.key]; return value == null ? [] : Array.isArray(value) ? value : [value];
  }));
  const assets = selected.filter(asset => referenced.has(asset.id));
  if (assets.length > SELLER_TEST_MAX_FILES) throw new Error("Select at most 20 local test files.");
  const total = new TextEncoder().encode(JSON.stringify(input)).length + assets.reduce((sum, asset) => sum + asset.sizeBytes, 0);
  if (assets.some(asset => asset.sizeBytes > (saved.executionFileLimits?.singleFileBytes ?? SELLER_TEST_MAX_FILE_BYTES))) throw new Error("A selected file exceeds the effective Worker file limit.");
  if (total > Math.min(SELLER_TEST_MAX_TOTAL_BYTES, saved.permissions.limits.maxInputBytes, saved.executionFileLimits?.inputBytes ?? SELLER_TEST_MAX_TOTAL_BYTES)) throw new Error("The selected files and inputs exceed the saved Worker's local test limit.");
  return SellerTestBundleSchema.parse({ kind: "KIVRO_SELLER_TEST", schemaVersion: 1, capabilityVersionId: saved.versionId, manifestHash: saved.manifestHash, input, assets });
}

export function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
