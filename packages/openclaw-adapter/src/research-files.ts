import { scanWithClamAv } from '@kivro/storage/scanner';
import { inspectFile } from '@kivro/storage/validation';
import { sha256 } from '@kivro/crypto';
import { ResearchDownloadGrantSchema } from '@kivro/contracts';
import { sniffMime } from './files.ts';

export const RESEARCH_DOWNLOAD_POLICY_VERSION = 1;
export const RESEARCH_FILE_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'application/pdf': '.pdf', 'text/csv': '.csv' });
export type ResearchFileDescriptor = { sourceId: string; path: string; mimeType: string; sizeBytes: number; sha256: string; untrusted: true };
export type ResearchScanner = { schemaVersion: 1; host: '127.0.0.1' | '::1'; port: number };

export async function validateResearchFile(data: Buffer, expected: { mimeType: string; sha256: string; sizeBytes: number }, grant: unknown, scanner: ResearchScanner, signal: AbortSignal, deadline: number) {
  signal.throwIfAborted();
  const policy = ResearchDownloadGrantSchema.parse(grant), extension = RESEARCH_FILE_EXTENSIONS[expected.mimeType];
  if (!extension || !policy.allowedMimeTypes.includes(expected.mimeType as typeof policy.allowedMimeTypes[number]) || data.length !== expected.sizeBytes || data.length > policy.maxFileBytes || sha256(data) !== expected.sha256) throw new Error('RESEARCH_FILE_INTEGRITY_FAILED');
  // Neither MIME sniffing nor a clean antivirus verdict claims to sanitize PDF content.
  const filename = `public${extension}`;
  if (await inspectFile(data, filename, expected.mimeType, policy.maxFileBytes) !== expected.mimeType || sniffMime(data, filename) !== expected.mimeType) throw new Error('RESEARCH_FILE_TYPE_DENIED');
  signal.throwIfAborted();
  await scanWithClamAv(data, scanner.host, scanner.port, { signal, deadline, maxBytes: policy.maxFileBytes });
  signal.throwIfAborted(); if (Date.now() >= deadline) throw new Error('RESEARCH_DOWNLOAD_TIMEOUT');
  return { engine: 'CLAMAV' as const, verdict: 'CLEAN' as const, scannedAt: new Date().toISOString() };
}

export async function testResearchScanner(scanner: ResearchScanner, signal?: AbortSignal, deadline = Date.now() + 10000): Promise<void> {
  await scanWithClamAv(Buffer.from('Kivro public-file scanner readiness canary.\n'), scanner.host, scanner.port, { signal, deadline, maxBytes: 256 });
  // Standard harmless antivirus test string; never executed or written into a job.
  const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
  try { await scanWithClamAv(eicar, scanner.host, scanner.port, { signal, deadline, maxBytes: 256 }); }
  catch (error) { if (error instanceof Error && error.message === 'FILE_SCAN_INFECTED') return; throw error; }
  throw new Error('SCANNER_SELF_TEST_FAILED');
}
