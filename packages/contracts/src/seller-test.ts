import { z } from 'zod';
import { FILE_SAFETY_CEILINGS } from './file-limits.ts';

export const SELLER_TEST_BUNDLE_KIND = 'KIVRO_SELLER_TEST' as const;
export const SELLER_TEST_MAX_FILES = FILE_SAFETY_CEILINGS.maxFiles;
export const SELLER_TEST_MAX_FILE_BYTES = FILE_SAFETY_CEILINGS.workerFileBytes;
export const SELLER_TEST_MAX_TOTAL_BYTES = FILE_SAFETY_CEILINGS.workerInputBytes;
export const SELLER_TEST_MAX_INPUT_JSON_BYTES = 256 * 1024;
export const SELLER_TEST_MAX_DOCUMENT_BYTES = Math.ceil(SELLER_TEST_MAX_TOTAL_BYTES / 3) * 4 + SELLER_TEST_MAX_INPUT_JSON_BYTES + 64 * 1024;

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function canonicalBase64Length(value: string): number | null {
  if (value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (padding && (value.length < 4 || (alphabet.indexOf(value[value.length - padding - 1]!) & (padding === 2 ? 15 : 3)))) return null;
  return value.length / 4 * 3 - padding;
}

// Bound traversal before serialization; no functions, accessors, cycles or non-JSON objects.
function boundedInput(value: Record<string, unknown>): boolean {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }], seen = new Set<object>();
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 10_000 || item.depth > 20) return false;
    if (item.value === null || typeof item.value === 'boolean') continue;
    if (typeof item.value === 'string') { if (item.value.length > SELLER_TEST_MAX_INPUT_JSON_BYTES) return false; continue; }
    if (typeof item.value === 'number') { if (!Number.isFinite(item.value)) return false; continue; }
    if (typeof item.value !== 'object' || seen.has(item.value)) return false;
    const object = item.value, proto = Object.getPrototypeOf(object);
    if (!Array.isArray(object) && proto !== Object.prototype && proto !== null) return false;
    seen.add(object);
    if (Object.getOwnPropertySymbols(object).length) return false;
    const keys = Object.getOwnPropertyNames(object).filter(key => !(Array.isArray(object) && key === 'length'));
    if (nodes + pending.length + keys.length > 10_000 || Array.isArray(object) && object.length !== keys.length) return false;
    for (const key of keys) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) return false;
      const property = Object.getOwnPropertyDescriptor(object, key)!;
      if (!Object.hasOwn(property, 'value') || !property.enumerable) return false;
      pending.push({ value: property.value, depth: item.depth + 1 });
    }
  }
  return new TextEncoder().encode(JSON.stringify(value)).length <= SELLER_TEST_MAX_INPUT_JSON_BYTES;
}

export const SellerTestAssetSchema = z.object({
  id: z.string().uuid(),
  filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/).refine(name => !name.includes('..'), 'Unsafe filename'),
  mimeType: z.string().min(1).max(150),
  sizeBytes: z.number().int().nonnegative().max(SELLER_TEST_MAX_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentBase64: z.string().max(Math.ceil(SELLER_TEST_MAX_FILE_BYTES / 3) * 4),
}).strict().superRefine((asset, ctx) => {
  if (canonicalBase64Length(asset.contentBase64) !== asset.sizeBytes) ctx.addIssue({ code: 'custom', path: ['contentBase64'], message: 'Expected canonical base64 with the declared byte length' });
});

export const SellerTestBundleSchema = z.object({
  kind: z.literal(SELLER_TEST_BUNDLE_KIND), schemaVersion: z.literal(1),
  capabilityVersionId: z.string().uuid(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  input: z.custom<Record<string, unknown>>(value => !!value && typeof value === 'object' && !Array.isArray(value) && boundedInput(value as Record<string, unknown>), 'Expected bounded JSON input'),
  assets: z.array(SellerTestAssetSchema).max(SELLER_TEST_MAX_FILES),
}).strict().superRefine((bundle, ctx) => {
  if (!boundedInput(bundle.input)) return;
  if (new Set(bundle.assets.map(asset => asset.id)).size !== bundle.assets.length) ctx.addIssue({ code: 'custom', path: ['assets'], message: 'Duplicate asset ID' });
  const inputBytes = new TextEncoder().encode(JSON.stringify(bundle.input)).length;
  if (bundle.assets.reduce((total, asset) => total + asset.sizeBytes, inputBytes) > SELLER_TEST_MAX_TOTAL_BYTES) ctx.addIssue({ code: 'custom', path: ['assets'], message: 'Seller test input limit exceeded' });
});
export type SellerTestBundle = z.infer<typeof SellerTestBundleSchema>;
export type SellerTestAsset = z.infer<typeof SellerTestAssetSchema>;

export function isSellerTestBundle(value: unknown): boolean {
  return !!value && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'kind')?.value === SELLER_TEST_BUNDLE_KIND;
}
