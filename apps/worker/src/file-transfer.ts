import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AssetDTO } from '@kivro/contracts';
import { FILE_SAFETY_CEILINGS } from '@kivro/contracts/file-limits';
import { streamingRequest } from './http.ts';

export const MAX_TRANSFER_BYTES = FILE_SAFETY_CEILINGS.singleFileBytes;
export type FileDescriptor = Pick<AssetDTO, 'filename' | 'mimeType' | 'sizeBytes' | 'sha256'>;
function verifier(file: Pick<FileDescriptor, 'sizeBytes' | 'sha256'>) {
  let bytes = 0; const hash = createHash('sha256');
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > file.sizeBytes) { callback(new Error('FILE_TRANSFER_SIZE_EXCEEDED')); return; }
    hash.update(chunk); callback(null, chunk);
  }, flush(callback) { callback(bytes === file.sizeBytes && hash.digest('hex') === file.sha256 ? undefined : new Error('FILE_TRANSFER_INTEGRITY_FAILED')); } });
}
export function fileSink(handle: FileHandle): Writable {
  let position = 0;
  return new Writable({ write(chunk: Buffer, _encoding, callback) {
    void (async () => {
      let offset = 0;
      while (offset < chunk.length) { const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, position); if (!bytesWritten) throw new Error('FILE_WRITE_FAILED'); offset += bytesWritten; position += bytesWritten; }
    })().then(() => callback(), callback);
  } });
}
export function assertTransferFile(file: FileDescriptor, maxBytes = MAX_TRANSFER_BYTES): void {
  if (!file.filename || file.filename.length > 180 || file.filename.startsWith('.') || /[\x00-\x1f\x7f/\\:]/.test(file.filename) || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(file.mimeType) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1 || file.sizeBytes > Math.min(maxBytes, MAX_TRANSFER_BYTES)) throw new Error('INVALID_TRANSFER_FILE');
}
export async function downloadFile(url: URL, headers: Record<string, string>, file: FileDescriptor, destination: string, maxBytes: number, signal?: AbortSignal): Promise<void> {
  assertTransferFile(file, maxBytes);
  const parent = dirname(resolve(destination)), directory = await lstat(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(parent) !== parent) throw new Error('UNSAFE_DOWNLOAD_DIRECTORY');
  const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let complete = false;
  try {
    await streamingRequest(url, { headers, signal, consume: async response => {
      if (response.statusCode !== 200 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('INPUT_ASSET_DOWNLOAD_FAILED');
      const length = response.headers['content-length']; if (length !== undefined && length !== String(file.sizeBytes)) throw new Error('FILE_TRANSFER_INTEGRITY_FAILED');
      await pipeline(response, verifier(file), fileSink(handle), { signal });
    } });
    await handle.sync(); await handle.chmod(0o444); complete = true;
  } finally { await handle.close(); if (!complete) await unlink(destination).catch(() => {}); }
}
async function sameFile(handle: FileHandle, before: Awaited<ReturnType<FileHandle['stat']>>): Promise<void> {
  const after = await handle.stat();
  if (!after.isFile() || after.nlink !== 1 || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('UPLOAD_FILE_CHANGED');
}
/** Revalidate the immutable local spool before requesting or using upload authority. */
export async function openUploadFile(path: string, file: FileDescriptor, signal?: AbortSignal): Promise<FileHandle> {
  assertTransferFile(file);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== file.sizeBytes || await realpath(path) !== resolve(path)) throw new Error('UNSAFE_UPLOAD_FILE');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    await sameFile(handle, before);
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, signal })) { size += chunk.length; if (size > file.sizeBytes) throw new Error('UPLOAD_FILE_CHANGED'); hash.update(chunk); }
    if (size !== file.sizeBytes || hash.digest('hex') !== file.sha256) throw new Error('FILE_TRANSFER_INTEGRITY_FAILED');
    await sameFile(handle, before); return handle;
  } catch (error) { await handle.close(); throw error; }
}
export async function uploadFile(url: URL, handle: FileHandle, file: FileDescriptor, localApproved: boolean, signal?: AbortSignal): Promise<void> {
  const before = await handle.stat(), source = handle.createReadStream({ autoClose: false, start: 0, end: file.sizeBytes - 1 });
  const checked = verifier(file), pumping = pipeline(source, checked, { signal });
  // Install the rejection handler before DNS/network awaits.
  void pumping.catch(() => {});
  try {
    await streamingRequest(url, { method: 'PUT', publicOnly: true, localApproved, signal, headers: { 'content-type': file.mimeType, 'content-length': String(file.sizeBytes) }, body: checked,
      consume: async response => {
        if (![200, 201, 204].includes(response.statusCode ?? 0)) throw new Error('DIRECT_UPLOAD_FAILED');
        let size = 0; for await (const chunk of response) { size += chunk.length; if (size > 65536) throw new Error('UPLOAD_RESPONSE_TOO_LARGE'); }
      },
    });
    await pumping; await sameFile(handle, before);
  } finally { source.destroy(); checked.destroy(); await pumping.catch(() => {}); }
}
