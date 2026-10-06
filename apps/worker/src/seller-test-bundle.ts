import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateInput } from '@kivro/contracts';
import { readFileLimits, type FileLimits } from '@kivro/contracts/file-limits';
import { SellerTestBundleSchema, SELLER_TEST_MAX_DOCUMENT_BYTES, SELLER_TEST_MAX_TOTAL_BYTES, isSellerTestBundle } from '@kivro/contracts/seller-test';
import { sha256 } from '@kivro/crypto';
import { assertWorkerFileContract, sniffMime } from '@kivro/openclaw-adapter';
import type { LocalCapability } from './capabilities.ts';

export type SellerTestCapability = Pick<LocalCapability, 'ioContract' | 'permissions'> & Partial<Pick<LocalCapability, 'capabilityVersionId' | 'manifestHash'>>;

export function prepareSellerTestBundle(capability: SellerTestCapability, raw: unknown, limits: FileLimits = readFileLimits(process.env)) {
  const bundle = SellerTestBundleSchema.parse(raw);
  if (!capability.capabilityVersionId || bundle.capabilityVersionId !== capability.capabilityVersionId ||
    !capability.manifestHash || bundle.manifestHash !== capability.manifestHash) throw new Error('SELLER_TEST_VERSION_MISMATCH');
  assertWorkerFileContract(capability.ioContract);
  const assets = bundle.assets.map(({ contentBase64: _content, ...asset }) => asset);
  const values = validateInput(capability.ioContract, bundle.input, assets);
  const referenced = new Set(capability.ioContract.inputs.filter(field => ['FILE', 'FILES'].includes(field.type)).flatMap(field => {
    const value = values[field.key]; return value === undefined || value === null || value === '' ? [] : Array.isArray(value) ? value : [value];
  }));
  if (assets.some(asset => !referenced.has(asset.id))) throw new Error('UNDECLARED_TEST_ASSET');
  const total = assets.reduce((sum, asset) => sum + asset.sizeBytes, Buffer.byteLength(JSON.stringify(values)));
  if (assets.some(asset => asset.sizeBytes > limits.workerFileBytes)) throw new Error('TEST_FILE_LIMIT');
  if (total > Math.min(SELLER_TEST_MAX_TOTAL_BYTES, limits.inputBytes, capability.permissions.limits.maxInputBytes)) throw new Error('TEST_INPUT_LIMIT');
  const files = new Map<string, Buffer>();
  for (const asset of bundle.assets) {
    const bytes = Buffer.from(asset.contentBase64, 'base64');
    if (bytes.length !== asset.sizeBytes || bytes.toString('base64') !== asset.contentBase64 ||
      sha256(bytes) !== asset.sha256 || sniffMime(bytes, asset.filename) !== asset.mimeType) throw new Error('TEST_ASSET_INTEGRITY_FAILED');
    files.set(asset.id, bytes);
  }
  return { values, assets, files };
}

/** Explicit CLI input only. Never used by ordinary configuration/credential commands. */
export async function readSellerTestInput(rawPath: string, limits: FileLimits = readFileLimits(process.env)): Promise<unknown> {
  const path = resolve(rawPath), stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || await realpath(path) !== path) throw new Error('UNSAFE_TEST_INPUT_FILE');
  const documentLimit = Math.min(SELLER_TEST_MAX_DOCUMENT_BYTES, Math.max(2 * 1024 ** 2, Math.ceil(limits.inputBytes / 3) * 4 + 256 * 1024 + 64 * 1024));
  if (stat.size > documentLimit) throw new Error('TEST_INPUT_FILE_TOO_LARGE');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size || before.mtimeMs !== stat.mtimeMs) throw new Error('TEST_INPUT_FILE_CHANGED');
    const data = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < data.length) {
      const read = await handle.read(data, offset, data.length - offset, offset);
      if (!read.bytesRead) break; offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== stat.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1) throw new Error('TEST_INPUT_FILE_CHANGED');
    let input: unknown;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, offset))); }
    catch { throw new Error('INVALID_TEST_INPUT_JSON'); }
    if (isSellerTestBundle(input)) {
      const bundle = SellerTestBundleSchema.parse(input);
      if (bundle.assets.some(asset => asset.sizeBytes > limits.workerFileBytes)) throw new Error('TEST_FILE_LIMIT');
      if (bundle.assets.reduce((sum, asset) => sum + asset.sizeBytes, Buffer.byteLength(JSON.stringify(bundle.input))) > limits.inputBytes) throw new Error('TEST_INPUT_LIMIT');
      return bundle;
    }
    if (offset > 2 * 1024 ** 2) throw new Error('CONFIG_FILE_TOO_LARGE');
    return input;
  } finally { await handle.close(); }
}
