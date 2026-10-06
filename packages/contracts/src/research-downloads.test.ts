import { describe, expect, it } from 'vitest';
import { PermissionManifestSchema, ResearchDownloadGrantSchema, hashManifest } from './index.ts';

const grant = { schemaVersion: 1, allowedMimeTypes: ['text/csv'], maxFiles: 2, maxFileBytes: 1000, maxTotalBytes: 2000 };
const permissions = { schemaVersion: 1, tools: ['research.download'], network: { mode: 'RESEARCH', allowedDomains: ['example.com'], downloads: grant }, resources: [], inference: { provider: 'openai-compatible', model: 'test' }, limits: { timeoutSeconds: 30, memoryMb: 1024, cpu: 1, maxPids: 64, maxInputBytes: 5000, maxOutputBytes: 5000, maxTokens: 1000 } };
describe('distinct public-download consent', () => {
  it('never silently adds grants to legacy signed manifests', () => {
    const legacy = { ...permissions, tools: ['research.fetch'], network: { mode: 'RESEARCH', allowedDomains: ['example.com'] } };
    expect(PermissionManifestSchema.parse(legacy)).toEqual(legacy); expect(hashManifest(PermissionManifestSchema.parse(legacy))).toBe(hashManifest(legacy));
  });
  it('requires grant/tool/network together', () => {
    expect(PermissionManifestSchema.safeParse(permissions).success).toBe(true);
    expect(PermissionManifestSchema.safeParse({ ...permissions, tools: [] }).success).toBe(false);
    expect(PermissionManifestSchema.safeParse({ ...permissions, network: { ...permissions.network, downloads: undefined } }).success).toBe(false);
    expect(PermissionManifestSchema.safeParse({ ...permissions, network: { ...permissions.network, mode: 'NONE' } }).success).toBe(false);
  });
  it.each([{ schemaVersion: 2 }, { maxFiles: 6 }, { maxFileBytes: 500001 }, { maxTotalBytes: 5000001 }, { allowedMimeTypes: ['image/svg+xml'] }, { allowedMimeTypes: ['application/zip'] }, { allowedMimeTypes: ['text/csv', 'text/csv'] }, { maxTotalBytes: 1 }])('rejects broadening %j', change => {
    expect(ResearchDownloadGrantSchema.safeParse({ ...grant, ...change }).success).toBe(false);
  });
});
