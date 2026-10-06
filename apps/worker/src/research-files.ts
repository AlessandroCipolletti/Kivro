import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256 } from '@kivro/crypto';
import { RESEARCH_FILE_EXTENSIONS, validateResearchFile, type ResearchFileDescriptor, type ResearchScanner } from '@kivro/openclaw-adapter';
import type { ResearchDownloadGrant } from '@kivro/contracts';
import type { PublicDownloadResult } from '@kivro/research-broker';
import type { Writable } from 'node:stream';
import { fileSink } from './file-transfer.ts';

/** Host-owned quarantine. Only the exact validated/scanned snapshot enters input/. */
export class ResearchFileStore {
  private readonly files = new Map<string, { descriptor: ResearchFileDescriptor; data: Buffer }>();
  private total = 0;
  constructor(readonly root: string, readonly grant: ResearchDownloadGrant, readonly scanner: ResearchScanner) {}
  async download(sourceId: string, transfer: (sink: Writable) => Promise<PublicDownloadResult>, signal: AbortSignal, deadline: () => number) {
    if (this.files.has(sourceId) || this.files.size >= this.grant.maxFiles) throw new Error('RESEARCH_DOWNLOAD_LIMIT');
    const root = resolve(this.root), stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) throw new Error('UNSAFE_RESEARCH_DIRECTORY');
    const path = join(root, `quarantine-${randomUUID()}`), handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const sink = fileSink(handle);
    try {
      const result = await transfer(sink); signal.throwIfAborted();
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== result.bytes || result.bytes > this.grant.maxFileBytes || this.total + result.bytes > this.grant.maxTotalBytes) throw new Error('RESEARCH_DOWNLOAD_LIMIT');
      const data = Buffer.alloc(result.bytes); let position = 0;
      while (position < data.length) { const read = await handle.read(data, position, data.length - position, position); if (!read.bytesRead) throw new Error('RESEARCH_FILE_TRUNCATED'); position += read.bytesRead; }
      const scan = await validateResearchFile(data, { mimeType: result.contentType, sha256: result.sha256, sizeBytes: result.bytes }, this.grant, this.scanner, signal, deadline());
      signal.throwIfAborted();
      const descriptor: ResearchFileDescriptor = { sourceId, path: `skills/kivro-public-data/${randomUUID()}${RESEARCH_FILE_EXTENSIONS[result.contentType]}`, mimeType: result.contentType, sizeBytes: result.bytes, sha256: result.sha256, untrusted: true };
      this.files.set(sourceId, { descriptor, data }); this.total += data.length;
      return { descriptor: { ...descriptor }, scan, provenance: { sourceId, publicPlanHash: result.publicPlanHash, destinationHost: result.destinationHost, status: 200, fetchedAt: result.fetchedAt, contentType: result.contentType, bytes: result.bytes, sha256: result.sha256, untrusted: true } };
    } finally { sink.destroy(); await handle.close(); await unlink(path).catch(() => {}); }
  }
  descriptors(): ResearchFileDescriptor[] { return [...this.files.values()].map(file => ({ ...file.descriptor })); }
  async install(inputDir: string, signal?: AbortSignal): Promise<void> {
    const root = resolve(inputDir);
    if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error('UNSAFE_RESEARCH_DIRECTORY');
    if (!this.files.size) return;
    const directory = join(root, 'research'); await mkdir(directory, { mode: 0o755 });
    for (const { data, descriptor } of this.files.values()) {
      signal?.throwIfAborted();
      if (sha256(data) !== descriptor.sha256) throw new Error('RESEARCH_FILE_INTEGRITY_FAILED');
      await writeFile(join(directory, descriptor.path.split('/').at(-1)!), data, { mode: 0o444, flag: 'wx' });
    }
  }
  clear(): void { for (const file of this.files.values()) file.data.fill(0); this.files.clear(); }
}
