import { post } from "./api";
import type { AssetDTO } from "./types";

export interface UploadIntent { id: string; uploadUrl: string; method: "PUT"; headers: Record<string, string>; expiresAt: string; uploadUrlExpiresAt: string }
export const MAX_DIRECT_UPLOAD_BYTES = 100 * 1024 * 1024;

export async function stageUpload(file: File, signal: AbortSignal, phase: (value: string) => void): Promise<UploadIntent> {
  if (file.size > MAX_DIRECT_UPLOAD_BYTES) throw new Error("Files cannot exceed 100 MiB.");
  phase("Calculating file checksum");
  const bytes = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  if (signal.aborted) throw new Error("Upload cancelled.");
  phase("Preparing secure upload");
  const intent = await post<UploadIntent>("/assets/uploads", { filename: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size, sha256 });
  const url = new URL(intent.uploadUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || intent.method !== "PUT" || Object.keys(intent.headers).some(key => /^(authorization|cookie|x-api-key)$/i.test(key))) throw new Error("The upload service returned an unsafe storage request.");
  if ([intent.expiresAt, intent.uploadUrlExpiresAt].some(expiry => !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now())) throw new Error("The storage upload link has expired. Choose the file again.");
  phase("Uploading to storage");
  const response = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.headers, body: file, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal });
  if (!response.ok) throw new Error(`Storage upload failed (${response.status}). Choose the file again to retry.`);
  return intent;
}

export const finalizeUpload = (id: string) => post<AssetDTO>(`/assets/uploads/${encodeURIComponent(id)}/finalize`, {});
