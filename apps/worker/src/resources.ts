import { lstat, realpath, open, mkdir, writeFile, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { z } from 'zod';
import { hashManifest } from '@kivro/contracts';
import { sha256 } from '@kivro/crypto';
import { sniffMime } from '@kivro/openclaw-adapter';
import type { WorkerState } from './state.ts';

export const ResourceSelectionSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/), path: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/), maxBytes: z.number().int().positive().max(8 * 1024 ** 2) }).strict();
export type ResourceSnapshot = { id: string; sha256: string; sizeBytes: number; mimeType: string; consentHash: string; approvedAt: string };
export async function approveResource(state: WorkerState, raw: unknown, approvedHash?: string): Promise<{ approvalHash: string; resource?: ResourceSnapshot }> {
  const selection = ResourceSelectionSchema.parse(raw), approvalHash = hashManifest(selection);
  if (approvedHash !== approvalHash) return { approvalHash };
  const path = resolve(selection.path), real = await realpath(path), stat = await lstat(path);
  if (real !== path || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > selection.maxBytes) throw new Error('UNSAFE_RESOURCE_FILE');
  if (/(?:^|\/)(?:\.ssh|\.aws|\.gnupg|\.docker|\.openclaw|\.config|\.env(?:\.[^/]*)?|Library)(?:\/|$)/i.test(path)) throw new Error('PERSONAL_SECRET_RESOURCE_DENIED');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let data: Buffer;
  try {
    const before = await handle.stat(); if (before.ino !== stat.ino || before.dev !== stat.dev || before.nlink !== 1) throw new Error('RESOURCE_CHANGED');
    data = Buffer.alloc(stat.size); let offset = 0;
    while (offset < data.length) { const read = await handle.read(data, offset, data.length - offset, offset); if (!read.bytesRead) throw new Error('RESOURCE_CHANGED'); offset += read.bytesRead; }
    const after = await handle.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || sha256(data) !== selection.sha256) throw new Error('RESOURCE_CHANGED');
  } finally { await handle.close(); }
  const mimeType = sniffMime(data, basename(path));
  if (!['text/plain', 'text/markdown', 'application/json', 'text/csv'].includes(mimeType)) throw new Error('RESOURCE_TEXT_TYPES_ONLY');
  const resource: ResourceSnapshot = { id: selection.id, sha256: selection.sha256, sizeBytes: data.length, mimeType, consentHash: approvalHash, approvedAt: new Date().toISOString() };
  if (state.get(`resource:${selection.id}`)) throw new Error('IMMUTABLE_RESOURCE_USE_NEW_ID');
  const dir = join(state.root, 'resources'); await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, selection.id), data, { flag: 'wx', mode: 0o400 });
  state.set(`resource:${selection.id}`, resource); state.audit('READ_ONLY_RESOURCE_CONSENT', 'LOCAL');
  return { approvalHash, resource };
}
export async function readResource(state: WorkerState, id: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)) throw new Error('INVALID_RESOURCE_ID');
  const resource = state.get<ResourceSnapshot>(`resource:${id}`); if (!resource) throw new Error('RESOURCE_NOT_APPROVED');
  const path = join(state.root, 'resources', id), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== resource.sizeBytes) throw new Error('RESOURCE_SNAPSHOT_CHANGED');
  const bytes = await readFile(path); if (sha256(bytes) !== resource.sha256) throw new Error('RESOURCE_SNAPSHOT_CHANGED'); return bytes;
}
