import { describe, expect, it, vi } from 'vitest';
import { SellerTestBundleSchema, SellerTestAssetSchema, isSellerTestBundle, SELLER_TEST_MAX_FILE_BYTES,
  SELLER_TEST_MAX_TOTAL_BYTES, SELLER_TEST_MAX_INPUT_JSON_BYTES } from './seller-test.ts';

const id = '11111111-1111-4111-8111-111111111111';
const bundle = () => ({ kind: 'KIVRO_SELLER_TEST', schemaVersion: 1, capabilityVersionId: id, manifestHash: 'a'.repeat(64), input: { source: id },
  assets: [{ id, filename: 'example.txt', mimeType: 'text/plain', sizeBytes: 1, sha256: 'b'.repeat(64), contentBase64: 'eA==' }] });

describe('portable seller test wire contract', () => {
  it('preserves only the explicit preview data and version binding without adding authority', () => {
    expect(SellerTestBundleSchema.parse(bundle())).toEqual(bundle());
    expect(SellerTestBundleSchema.parse({ ...bundle(), input: { enabled: true, count: 4, data: { selected: ['a', null] } }, assets: [] }).assets).toEqual([]);
    expect(isSellerTestBundle(bundle())).toBe(true);
    expect(isSellerTestBundle({ kind: 'another-kind' })).toBe(false);
  });
  it.each([{ kind: 'job' }, { schemaVersion: 2 }, { capabilityVersionId: 'not-uuid' }, { manifestHash: 'a' },
    { permissions: {} }, { internalInstructions: 'override' }, { inference: { model: 'replacement' } }, { url: 'https://example.com' }, { path: '/tmp/file' }])('rejects changed identity or added authority %j', change => {
    expect(SellerTestBundleSchema.safeParse({ ...bundle(), ...change }).success).toBe(false);
  });
  it.each([{ path: '/tmp/file' }, { url: 'https://example.com' }, { filename: '../example.txt' }, { filename: 'a..txt' },
    { filename: '.env' }, { filename: 'a/b.txt' }, { filename: 'a\\b.txt' }, { sizeBytes: -1 }, { sizeBytes: 2 }, { sha256: 'wrong' }])('rejects unbounded or path-bearing asset metadata %j', change => {
    const asset = bundle().assets[0]!;
    expect(SellerTestAssetSchema.safeParse({ ...asset, ...change }).success).toBe(false);
  });
  it.each(['eB==', 'eA=', 'eA', 'eA==\n', 'eA== ', 'eA==AAAA', 'eA--', 'eA__', '!!!!', '===='])('rejects noncanonical base64 %j without decoding', contentBase64 => {
    expect(SellerTestAssetSchema.safeParse({ ...bundle().assets[0], contentBase64 }).success).toBe(false);
  });
  it('enforces unique IDs and independent file/count/aggregate ceilings', () => {
    const original = bundle();
    expect(SellerTestBundleSchema.safeParse({ ...original, assets: [original.assets[0], original.assets[0]] }).success).toBe(false);
    expect(SellerTestBundleSchema.safeParse({ ...original, assets: Array(21).fill(original.assets[0]) }).success).toBe(false);
    expect(SellerTestAssetSchema.safeParse({ ...original.assets[0], sizeBytes: SELLER_TEST_MAX_FILE_BYTES + 1 }).success).toBe(false);
    const large = { ...original.assets[0]!, sizeBytes: SELLER_TEST_MAX_FILE_BYTES, contentBase64: Buffer.alloc(SELLER_TEST_MAX_FILE_BYTES).toString('base64') };
    expect(SellerTestAssetSchema.safeParse(large).success).toBe(true);
    expect(large.sizeBytes * 2).toBe(SELLER_TEST_MAX_TOTAL_BYTES);
    expect(SellerTestBundleSchema.safeParse({ ...original, assets: [large, { ...large, id: '22222222-2222-4222-8222-222222222222' }] }).success).toBe(false);
  });
  it('rejects oversized, deeply nested, cyclic and non-JSON input without throwing or invoking accessors', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    let deep: unknown = true; for (let index = 0; index < 25; index++) deep = { value: deep };
    const getter = vi.fn(() => 'must not read'); const accessors = Object.defineProperty({}, 'secret', { enumerable: true, get: getter });
    for (const input of [cyclic, { deep }, { value: 'x'.repeat(SELLER_TEST_MAX_INPUT_JSON_BYTES) }, { value: BigInt(1) }, { value: NaN },
      { value: new Date() }, { value: () => 1 }, { value: undefined }, { value: Array(10_001).fill(null) }, accessors,
      Object.defineProperty({}, 'toJSON', { get: getter }),
      JSON.parse('{"constructor":{}}'), JSON.parse('{"__proto__":{"polluted":true}}')]) {
      expect(SellerTestBundleSchema.safeParse({ ...bundle(), input }).success).toBe(false);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(isSellerTestBundle(Object.defineProperty({}, 'kind', { get: getter }))).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
});
