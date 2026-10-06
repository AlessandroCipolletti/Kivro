import { describe, expect, it } from 'vitest';
import { SecurityPolicySchema, categoryPolicyBlocked, workerPolicyReason } from '../src/security-policy.js';

describe('operator execution policy', () => {
  const worker = { version: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)' };
  it('parses the actual pinned runtime output and compares numeric version components', () => {
    expect(workerPolicyReason(worker, SecurityPolicySchema.parse({}))).toBeNull();
    expect(workerPolicyReason(worker, SecurityPolicySchema.parse({ minimumWorkerVersion: '0.2.0' }))).toBe('WORKER_UPDATE_REQUIRED');
    expect(workerPolicyReason(worker, SecurityPolicySchema.parse({ minimumOpenClawVersion: '2026.10.1' }))).toBe('OPENCLAW_UPDATE_REQUIRED');
    expect(workerPolicyReason({ ...worker, openclawVersion: 'malformed' }, SecurityPolicySchema.parse({}))).toBe('OPENCLAW_UPDATE_REQUIRED');
  });
  it('honors explicit revocations and normalized category blocks without seller overrides', () => {
    expect(workerPolicyReason(worker, SecurityPolicySchema.parse({ revokedWorkerVersions: ['0.1.0'] }))).toBe('WORKER_VERSION_REVOKED');
    expect(workerPolicyReason(worker, SecurityPolicySchema.parse({ revokedOpenClawVersions: ['2026.8.2'] }))).toBe('OPENCLAW_VERSION_REVOKED');
    expect(categoryPolicyBlocked('Writing & Documents', SecurityPolicySchema.parse({ blockedCategories: ['writing & documents'] }))).toBe(true);
    expect(() => SecurityPolicySchema.parse({ minimumWorkerVersion: 'latest' })).toThrow();
  });
});
