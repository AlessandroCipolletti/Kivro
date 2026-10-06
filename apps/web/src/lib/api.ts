export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(`/api${path}`, { ...options, headers, credentials: "include", cache: "no-store" });
  const content = response.status === 204 ? null : await response.text();
  let body: unknown;
  try { body = content ? JSON.parse(content) : undefined; } catch { body = undefined; }
  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(body);
    const error = parsed.success ? parsed.data.error : undefined;
    throw new ApiError(response.status, error?.code || "REQUEST_FAILED", error?.message || (response.status >= 500 ? "The service is unavailable. Please try again." : `Request failed (${response.status}).`), error?.details);
  }
  try { return parseApiResponse(options.method ?? "GET", `/api${path}`, response.status, body) as T; }
  catch { throw new ApiError(response.status, "INVALID_RESPONSE", "The service returned an invalid response. Please try again."); }
}

export const post = <T>(path: string, body?: unknown, idempotencyKey?: string) => api<T>(path, {
  method: "POST", body: body === undefined ? undefined : JSON.stringify(body),
  headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined
});
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const remove = <T>(path: string, body: unknown) => api<T>(path, { method: "DELETE", body: JSON.stringify(body) });
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Something went wrong. Please try again."; }

// Retries of the same purchase retain their key; a changed payload gets a new key.
const pendingPurchases = new Map<string, { fingerprint: string; key: string }>();
export function purchaseKey(scope: string, payload: unknown): string {
  const fingerprint = hashManifest(payload);
  const memory = pendingPurchases.get(scope);
  if (memory?.fingerprint === fingerprint) return memory.key;
  const key = crypto.randomUUID();
  try {
    const existing = JSON.parse(sessionStorage.getItem(scope) || "null") as { fingerprint: string; key: string } | null;
    if (existing?.fingerprint === fingerprint) { pendingPurchases.set(scope, existing); return existing.key; }
    sessionStorage.setItem(scope, JSON.stringify({ fingerprint, key }));
  } catch { /* An in-memory key still protects retries when storage is unavailable. */ }
  pendingPurchases.set(scope, { fingerprint, key });
  return key;
}
export function clearPurchaseKey(scope: string) { pendingPurchases.delete(scope); try { sessionStorage.removeItem(scope); } catch { /* Storage can be disabled. */ } }
import { hashManifest } from "@kivro/contracts";
import { errorResponseSchema, parseApiResponse } from "@kivro/contracts/responses";
