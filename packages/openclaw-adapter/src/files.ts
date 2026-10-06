import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { sha256 } from '@kivro/crypto';
import { assertSafeRelativePath } from '@kivro/policy-engine';
import type { IOContract } from '@kivro/contracts';
import { readFileLimits } from '@kivro/contracts/file-limits';
import { inspectMedia, MEDIA_MIME_TYPES, MAX_MEDIA_BYTES } from '@kivro/storage/media';

export type CollectedFile = { filename: string; relativePath: string; mimeType: string; sizeBytes: number; sha256: string; data: Buffer };
export function assertResultPath(path: string): string {
  assertSafeRelativePath(path);
  if (path.split('/').length > 8 || path.split('/').some(name => !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(name) || name.includes('..'))) throw new Error('UNSAFE_RESULT_PATH');
  return path;
}
export function sniffMime(data: Buffer, filename: string): string {
  const ext = extname(filename).toLowerCase();
  const media = inspectMedia(data, filename); if (media) return media;
  if (data.subarray(0, 7).toString() === 'BLENDER' && ext === '.blend') return 'application/x-blender';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WAVE' && ext === '.wav') return 'audio/wav';
  if (data.subarray(0, 5).toString() === '%PDF-' && ext === '.pdf') return 'application/pdf';
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && ext === '.png') return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255 && ['.jpg', '.jpeg'].includes(ext)) return 'image/jpeg';
  const content = new TextDecoder('utf-8', { fatal: true }).decode(data);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content) || /^\s*(?:<svg|<!doctype|<html|<script|#!)/i.test(content)) throw new Error('UNSAFE_FILE_CONTENT');
  if (ext === '.json') { JSON.parse(content); return 'application/json'; }
  if (ext === '.txt') return 'text/plain';
  if (ext === '.md') return 'text/markdown';
  if (ext === '.csv') {
    if (content.split(/\r?\n/).some(line => line.split(',').some(cell => /^\s*["']?[=+@-]/.test(cell)))) throw new Error('CSV_FORMULA_DENIED');
    return 'text/csv';
  }
  throw new Error('UNSUPPORTED_FILE_CONTENT');
}
/** Text and legacy binary checks use bounded chunks. Structural media validation buffers
 * the full approved file (at most 100 MiB); JSON also retains its approved body.
 * Neither path is a constant-memory guarantee for the surrounding download. */
export async function sniffFileMime(path: string, filename: string, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MEDIA_BYTES) throw new Error('INPUT_BYTE_LIMIT');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes || await realpath(path) !== resolve(path)) throw new Error('UNSAFE_INPUT_FILE');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); if (before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size || before.nlink !== 1) throw new Error('INPUT_FILE_CHANGED');
    const ext = extname(filename).toLowerCase();
    let mimeType: string;
    if (MEDIA_MIME_TYPES[ext]) {
      // Containers require validation beyond a short signature, including late
      // moov atoms and references after 64 KiB. Allocate only the approved size.
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
        if (!read.bytesRead) throw new Error('INPUT_FILE_CHANGED'); offset += read.bytesRead;
      }
      mimeType = sniffMime(bytes, filename);
    } else if (!['.txt', '.md', '.csv', '.json'].includes(ext)) {
      const prefix = Buffer.alloc(Math.min(32, before.size)); let offset = 0;
      while (offset < prefix.length) { const read = await handle.read(prefix, offset, prefix.length - offset, offset); if (!read.bytesRead) throw new Error('INPUT_FILE_CHANGED'); offset += read.bytesRead; }
      mimeType = sniffMime(prefix, filename);
    }
    else {
      const decoder = new TextDecoder('utf-8', { fatal: true }), json: string[] = [];
      let leading: string | undefined = '', cellStart = true, cellQuoted = false, size = 0;
      const check = (text: string) => {
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('UNSAFE_FILE_CONTENT');
        if (leading !== undefined) {
          leading = (leading + text).trimStart();
          if (/^(?:<svg|<!doctype|<html|<script|#!)/i.test(leading)) throw new Error('UNSAFE_FILE_CONTENT');
          if (leading.length > 16) leading = undefined;
        }
        if (ext === '.json') json.push(text);
        if (ext === '.csv') for (const char of text) {
          if (',\r\n'.includes(char)) { cellStart = true; cellQuoted = false; }
          else if (cellStart) {
            if (/\s/.test(char)) continue;
            if (!cellQuoted && ['"', "'"].includes(char)) { cellQuoted = true; continue; }
            if ('=+@-'.includes(char)) throw new Error('CSV_FORMULA_DENIED');
            cellStart = false;
          }
        }
      };
      for await (const chunk of handle.createReadStream({ start: 0, autoClose: false, highWaterMark: 65536 })) { size += chunk.length; if (size > maxBytes) throw new Error('INPUT_BYTE_LIMIT'); check(decoder.decode(chunk, { stream: true })); }
      check(decoder.decode()); if (size !== before.size) throw new Error('INPUT_FILE_CHANGED');
      if (ext === '.json') JSON.parse(json.join(''));
      mimeType = { '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json' }[ext]!;
    }
    const after = await handle.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1) throw new Error('INPUT_FILE_CHANGED');
    return mimeType;
  } finally { await handle.close(); }
}
export function validateResultFiles(rawFiles: unknown, contract: IOContract, maxBytes: number): CollectedFile[] {
  const platform = readFileLimits(process.env);
  maxBytes = Math.min(maxBytes, platform.outputBytes);
  if (!Array.isArray(rawFiles) || rawFiles.length > (contract.output.files?.maxFiles ?? 0)) throw new Error('OUTPUT_FILE_COUNT');
  const limits = contract.output.files, names = new Set<string>(); let total = 0;
  return rawFiles.map(raw => {
    if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string' || typeof raw.data !== 'string') throw new Error('INVALID_RESULT_FILE');
    const relativePath = assertResultPath(raw.path);
    if (names.has(relativePath.toLowerCase())) throw new Error('DUPLICATE_OUTPUT_FILE'); names.add(relativePath.toLowerCase());
    if (raw.data.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.data)) throw new Error('INVALID_RESULT_ENCODING');
    const data = Buffer.from(raw.data, 'base64'); total += data.length;
    if (data.length !== raw.sizeBytes || data.length > platform.workerFileBytes || total > Math.min(maxBytes, limits?.maxTotalSizeBytes ?? 0)) throw new Error('OUTPUT_BYTE_LIMIT');
    const mimeType = sniffMime(data, relativePath);
    if (!limits?.allowedMimeTypes.includes(mimeType) || !limits.allowedExtensions.includes(extname(relativePath).toLowerCase())) throw new Error('OUTPUT_TYPE_NOT_ALLOWED');
    return { filename: relativePath.split('/').at(-1)!, relativePath, mimeType, sizeBytes: data.length, sha256: sha256(data), data };
  });
}

/** Call only after all sandbox writers have stopped. Never resolve result paths from agent text. */
export async function collectResultDirectory(root: string, contract: IOContract, maxBytes: number): Promise<CollectedFile[]> {
  const platform = readFileLimits(process.env);
  maxBytes = Math.min(maxBytes, platform.outputBytes);
  const canonical = await realpath(root);
  if ((await lstat(root)).isSymbolicLink()) throw new Error('SYMLINK_OUTPUT_ROOT');
  const files: { path: string; data: string; sizeBytes: number }[] = [];
  let total = 0;
  async function walk(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      const path = join(dir, name), rel = relative(canonical, path).split(sep).join('/'); assertResultPath(rel);
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || stat.nlink > 1 && !stat.isDirectory()) throw new Error('LINK_OUTPUT_DENIED');
      const real = await realpath(path);
      if (!real.startsWith(canonical + sep) || resolve(real) !== resolve(path)) throw new Error('OUTPUT_ESCAPE');
      if (stat.isDirectory()) { await walk(path); continue; }
      if (!stat.isFile() || stat.size > Math.min(maxBytes, platform.workerFileBytes) || files.length >= 20) throw new Error('SPECIAL_OR_OVERSIZE_OUTPUT');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const current = await handle.stat();
        if (!current.isFile() || current.nlink !== 1 || current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('OUTPUT_CHANGED');
        total += current.size; if (total > maxBytes) throw new Error('OUTPUT_BYTE_LIMIT');
        const data = Buffer.alloc(current.size);
        let offset = 0;
        while (offset < data.length) { const read = await handle.read(data, offset, data.length - offset, offset); if (!read.bytesRead) throw new Error('OUTPUT_TRUNCATED'); offset += read.bytesRead; }
        const after = await handle.stat();
        if (after.size !== current.size || after.mtimeMs !== current.mtimeMs) throw new Error('OUTPUT_CHANGED');
        files.push({ path: rel, data: data.toString('base64'), sizeBytes: data.length });
      } finally { await handle.close(); }
    }
  }
  await walk(canonical); return validateResultFiles(files, contract, maxBytes);
}
