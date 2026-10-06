import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile, symlink, link, truncate } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SellerTestBundleSchema, SELLER_TEST_MAX_DOCUMENT_BYTES, type SellerTestBundle } from '@kivro/contracts/seller-test';
import { sha256 } from '@kivro/crypto';
import { executionManifestHash } from '@kivro/contracts';
import { DEFAULT_FILE_LIMITS } from '@kivro/contracts/file-limits';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { prepareSellerTestBundle, readSellerTestInput } from './seller-test-bundle.ts';
import { prepareValidationInput, testCapability } from './validation.ts';
import type { WorkerState } from './state.ts';
import type { SecretStore } from './secrets.ts';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory() { const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-seller-bundle-'))); roots.push(root); return root; }
function fixture(type: 'FILE' | 'FILES' = 'FILE') {
  const cap = fixtureOffer(), id = randomUUID(), bytes = Buffer.from('Explicit selected test data');
  cap.ioContract.inputs = [{ key: 'source', label: 'Source', type, required: true, order: 0,
    constraints: { allowedExtensions: ['.txt'], allowedMimeTypes: ['text/plain'], maxFileSizeBytes: 1024, maxFiles: 2 } }];
  cap.manifestHash = executionManifestHash(cap);
  const bundle = SellerTestBundleSchema.parse({ kind: 'KIVRO_SELLER_TEST', schemaVersion: 1, capabilityVersionId: cap.capabilityVersionId,
    manifestHash: cap.manifestHash, input: { source: type === 'FILE' ? id : [id] },
    assets: [{ id, filename: 'sample.txt', mimeType: 'text/plain', sizeBytes: bytes.length, sha256: sha256(bytes), contentBase64: bytes.toString('base64') }] });
  return { cap, bundle, id, bytes };
}

describe('explicit portable local seller tests', () => {
  it.each(['FILE', 'FILES'] as const)('routes selected %s bytes into existing validation without exposing bundle fields to the model', async type => {
    const { cap, bundle, id, bytes } = fixture(type), result = await prepareValidationInput(cap, bundle);
    expect(result.values).toEqual(bundle.input); expect(result.files.get(id)).toEqual(bytes);
    expect(result.assets).toEqual([{ id, filename: 'sample.txt', mimeType: 'text/plain', sizeBytes: bytes.length, sha256: sha256(bytes) }]);
    expect(result.values).not.toHaveProperty('manifestHash'); expect(result.assets[0]).not.toHaveProperty('contentBase64');
  });
  it('accepts scalar-only preview input without manufacturing file identifiers', async () => {
    const cap = fixtureOffer();
    const bundle = { kind: 'KIVRO_SELLER_TEST', schemaVersion: 1, capabilityVersionId: cap.capabilityVersionId, manifestHash: cap.manifestHash, input: { question: 'Test' }, assets: [] };
    bundle.input = { [cap.ioContract.inputs[0]!.key]: 'Test' } as typeof bundle.input;
    expect((await prepareValidationInput(cap, bundle)).files.size).toBe(0);
  });
  it.each(['version', 'manifest', 'missing-local-binding'] as const)('rejects %s before acquiring a lease or checking readiness/inference', async change => {
    const { cap, bundle } = fixture();
    if (change === 'version') bundle.capabilityVersionId = randomUUID();
    if (change === 'manifest') bundle.manifestHash = '0'.repeat(64);
    const local = change === 'missing-local-binding' ? { ...cap, manifestHash: undefined } : cap;
    const state = { get: vi.fn(() => local), acquireLease: vi.fn() };
    await expect(testCapability(state as unknown as WorkerState, {} as SecretStore, cap.capabilityVersionId, bundle, 'unused', true)).rejects.toThrow('SELLER_TEST_VERSION_MISMATCH');
    expect(state.acquireLease).not.toHaveBeenCalled();
  });
  it('rejects unknown/duplicate/unreferenced IDs and missing files', () => {
    const { cap, bundle } = fixture();
    expect(() => prepareSellerTestBundle(cap, { ...bundle, input: { source: randomUUID() } })).toThrow();
    expect(() => prepareSellerTestBundle(cap, { ...bundle, assets: [] })).toThrow();
    expect(() => prepareSellerTestBundle(cap, { ...bundle, assets: [...bundle.assets, bundle.assets[0]] })).toThrow();
    expect(() => prepareSellerTestBundle(cap, { ...bundle, assets: [...bundle.assets, { ...bundle.assets[0], id: randomUUID() }] })).toThrow('UNDECLARED_TEST_ASSET');
  });
  it('enforces frozen MIME/extension/count/size and total input limits before decoding', () => {
    const { cap, bundle } = fixture('FILES');
    for (const change of [{ filename: 'sample.pdf' }, { mimeType: 'application/pdf' }, { sizeBytes: 2048 }]) {
      expect(() => prepareSellerTestBundle(cap, { ...bundle, assets: [{ ...bundle.assets[0], ...change }] })).toThrow();
    }
    const two = { ...bundle, assets: [...bundle.assets, { ...bundle.assets[0]!, id: randomUUID() }] };
    two.input = { source: two.assets.map(asset => asset.id) }; cap.ioContract.inputs[0]!.constraints!.maxFiles = 1;
    expect(() => prepareSellerTestBundle(cap, two)).toThrow();
    cap.permissions.limits.maxInputBytes = bundle.assets[0]!.sizeBytes;
    expect(() => prepareSellerTestBundle(cap, bundle)).toThrow('TEST_INPUT_LIMIT');
  });
  it.each([{ sha256: '0'.repeat(64) }, { contentBase64: Buffer.from('different selected content').toString('base64') },
    { filename: 'sample.txt', mimeType: 'text/plain', contentBase64: Buffer.from('<script>x</script>').toString('base64'), sizeBytes: 18, sha256: sha256('<script>x</script>') }])('rejects integrity or unsafe content %j', change => {
    const { cap, bundle } = fixture();
    expect(() => prepareSellerTestBundle(cap, { ...bundle, assets: [{ ...bundle.assets[0], ...change }] })).toThrow();
  });
  it('rejects inactive conditional fields and unsupported archive contracts', () => {
    const { cap, bundle } = fixture();
    cap.ioContract.inputs.unshift({ key: 'attach', label: 'Attach', type: 'BOOLEAN', required: true, order: 0 });
    cap.ioContract.inputs[1]!.visibleWhen = { key: 'attach', equals: true };
    expect(() => prepareSellerTestBundle(cap, { ...bundle, input: { attach: false, ...bundle.input } })).toThrow('Check the capability inputs');
    cap.ioContract.inputs[1]!.constraints = { allowedExtensions: ['.zip'], allowedMimeTypes: ['application/zip'], maxFileSizeBytes: 1024 };
    expect(() => prepareSellerTestBundle(cap, bundle)).toThrow('UNSUPPORTED_FILE_CONTRACT');
  });
  it('keeps explicit legacy local-file test input compatible', async () => {
    const root = await directory(), { cap, bundle, id, bytes } = fixture(), path = join(root, 'selected.txt');
    await writeFile(path, bytes);
    const { contentBase64: _base64, ...metadata } = bundle.assets[0]!;
    expect((await prepareValidationInput(cap, { input: bundle.input, assets: [{ ...metadata, path }] })).files.get(id)).toEqual(bytes);
  });
  it('rejects lowered per-file and aggregate limits before allocating decoded bundle bytes or opening legacy files', async () => {
    const { cap, bundle } = fixture(), decode = vi.spyOn(Buffer, 'from');
    expect(() => prepareSellerTestBundle(cap, bundle, { ...DEFAULT_FILE_LIMITS, workerFileBytes: 1 })).toThrow('TEST_FILE_LIMIT');
    expect(() => prepareSellerTestBundle(cap, bundle, { ...DEFAULT_FILE_LIMITS, inputBytes: 1 })).toThrow('TEST_INPUT_LIMIT');
    expect(decode).not.toHaveBeenCalled(); decode.mockRestore();
    const { contentBase64: _base64, ...metadata } = bundle.assets[0]!;
    const open = vi.spyOn(fs, 'open');
    await expect(prepareValidationInput(cap, { input: bundle.input, assets: [{ ...metadata, path: '/missing-selected-file' }] }, { ...DEFAULT_FILE_LIMITS, workerFileBytes: 1 })).rejects.toThrow('TEST_FILE_LIMIT');
    await expect(prepareValidationInput(cap, { input: bundle.input, assets: [{ ...metadata, path: '/missing-selected-file' }] }, { ...DEFAULT_FILE_LIMITS, inputBytes: 1 })).rejects.toThrow('TEST_INPUT_LIMIT');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('bounded CLI test file reading', () => {
  it('accepts an explicit portable file larger than the unchanged ordinary config limit', async () => {
    const root = await directory(), path = join(root, 'preview.json'), { bundle } = fixture();
    const bytes = Buffer.alloc(2 * 1024 ** 2, 120);
    const larger: SellerTestBundle = { ...bundle, assets: [{ ...bundle.assets[0]!, sizeBytes: bytes.length, sha256: sha256(bytes), contentBase64: bytes.toString('base64') }] };
    await writeFile(path, JSON.stringify(larger));
    expect(await readSellerTestInput(path)).toEqual(larger);
  });
  it('keeps legacy JSON input bounded to two MiB and never prints malformed input contents', async () => {
    const root = await directory(), path = join(root, 'preview.json');
    await writeFile(path, JSON.stringify({ text: 'test' })); expect(await readSellerTestInput(path)).toEqual({ text: 'test' });
    await writeFile(path, JSON.stringify({ text: 'x'.repeat(2 * 1024 ** 2) }));
    await expect(readSellerTestInput(path)).rejects.toThrow('CONFIG_FILE_TOO_LARGE');
    await writeFile(path, 'secret-invalid-json');
    await expect(readSellerTestInput(path)).rejects.toThrow('INVALID_TEST_INPUT_JSON');
    await writeFile(path, Buffer.from([0xff]));
    await expect(readSellerTestInput(path)).rejects.toThrow('INVALID_TEST_INPUT_JSON');
  });
  it('applies lower current limits to a portable document before decoding its assets', async () => {
    const root = await directory(), path = join(root, 'preview.json'), { bundle } = fixture();
    await writeFile(path, JSON.stringify(bundle));
    await expect(readSellerTestInput(path, { ...DEFAULT_FILE_LIMITS, workerFileBytes: 1 })).rejects.toThrow('TEST_FILE_LIMIT');
    await expect(readSellerTestInput(path, { ...DEFAULT_FILE_LIMITS, inputBytes: 1 })).rejects.toThrow('TEST_INPUT_LIMIT');
    await truncate(path, 2 * 1024 ** 2 + 1);
    await expect(readSellerTestInput(path, { ...DEFAULT_FILE_LIMITS, inputBytes: 1 })).rejects.toThrow('TEST_INPUT_FILE_TOO_LARGE');
  });
  it('rejects oversized files before allocation, directories, hardlinks and symlinks', async () => {
    const root = await directory(), path = join(root, 'preview.json');
    await writeFile(path, '{}'); await truncate(path, SELLER_TEST_MAX_DOCUMENT_BYTES + 1);
    await expect(readSellerTestInput(path)).rejects.toThrow('TEST_INPUT_FILE_TOO_LARGE');
    await writeFile(path, '{}'); const linked = join(root, 'linked.json'); await symlink(path, linked);
    await expect(readSellerTestInput(linked)).rejects.toThrow('UNSAFE_TEST_INPUT_FILE');
    await rm(linked); await link(path, linked);
    await expect(readSellerTestInput(linked)).rejects.toThrow('UNSAFE_TEST_INPUT_FILE');
    await expect(readSellerTestInput(root)).rejects.toThrow('UNSAFE_TEST_INPUT_FILE');
  });
  it.each(['before-read', 'after-read'] as const)('rejects file mutation %s across the checked open descriptor', async phase => {
    const root = await directory(), path = join(root, 'preview.json'), originalOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    await writeFile(path, '{"text":"original"}');
    const opened = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (phase === 'before-read') await writeFile(path, '{"text":"changed before reading"}');
      else {
        const originalStat = handle.stat.bind(handle); let calls = 0;
        vi.spyOn(handle, 'stat').mockImplementation(async () => {
          if (++calls === 2) await writeFile(path, '{"text":"changed after reading"}');
          return originalStat();
        });
      }
      return handle;
    });
    await expect(readSellerTestInput(path)).rejects.toThrow('TEST_INPUT_FILE_CHANGED');
    expect(opened).toHaveBeenCalledOnce();
  });
});
