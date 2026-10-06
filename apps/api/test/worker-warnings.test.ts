import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WorkerWarningSignalsSchema, WorkerWarningSnapshotSchema, WORKER_WARNING_CATALOG } from '@kivro/contracts';
import type { WorkerDevice } from '@kivro/database';
import { ADAPTER_POLICY_VERSION } from '@kivro/openclaw-adapter';
import { projectWorkerWarnings } from '../src/worker-health.js';
import { SecurityPolicySchema } from '../src/security-policy.js';

const now = new Date('2026-10-06T12:00:00.000Z'), policy = SecurityPolicySchema.parse({}), ttl = 60000;
function fixture() {
  const worker: WorkerDevice = { id: randomUUID(), sellerId: randomUUID(), publicKey: 'private-test-key', name: 'private device label',
    version: '0.1.0', openclawVersion: 'OpenClaw 2026.8.2 (0965053)', sandboxReady: true, paused: false, localPaused: false,
    revokedAt: null, lastSeenAt: now, health: {}, healthStatus: 'READY:HEARTBEAT_HEALTHY', runningJobIds: [], createdAt: now };
  const binding: Parameters<typeof projectWorkerWarnings>[1][number] = { workerId: worker.id, capabilityVersionId: randomUUID(), healthy: true,
    validationStatus: 'PASSED', validatedManifestHash: 'a'.repeat(64), validatedAt: now, validationProof: { sandbox: { policyVersion: ADAPTER_POLICY_VERSION } },
    version: { id: randomUUID(), capabilityId: randomUUID(), manifestHash: 'a'.repeat(64), category: 'Writing', capability: { sellerId: worker.sellerId, securityBlocked: false } } };
  binding.version.id = binding.capabilityVersionId;
  return { worker, binding };
}
describe('first-class warning safe projection', () => {
  it('does not invent a specific self-test failure or credential revocation schedule from missing readiness', () => {
    const { worker } = fixture(); worker.sandboxReady = false; worker.health = { error: 'private secret path' };
    const result = projectWorkerWarnings(worker, [], policy, ttl, now);
    expect(result.items.map(item => item.code)).toEqual(['SANDBOX_NOT_READY']);
    expect(result.coverage).toEqual({ capabilityScope: 'BOUND_VERSIONS_ONLY', localSignals: 'UNAVAILABLE', ignoredSignalCount: 0, deviceRevocationSchedule: 'UNAVAILABLE' });
    expect(result.items[0]).toMatchObject({ ...WORKER_WARNING_CATALOG.SANDBOX_NOT_READY, detectedAt: now.toISOString(), lastObservedAt: now.toISOString(),
      detectedAtBasis: 'FIRST_PLATFORM_OBSERVATION', blocking: true, source: 'PLATFORM_STATE', affectedEntity: { workerId: worker.id, capabilityId: null, capabilityVersionId: null } });
    expect(JSON.stringify(result)).not.toMatch(/private secret path|private-test-key|private device label/);
  });
  it.each([
    ['WORKER_UPDATE_REQUIRED', { version: '0.0.1' }, {}],
    ['WORKER_VERSION_REVOKED', {}, { revokedWorkerVersions: ['0.1.0'] }],
    ['OPENCLAW_UPDATE_REQUIRED', { openclawVersion: null }, {}],
    ['OPENCLAW_VERSION_REVOKED', {}, { revokedOpenClawVersions: ['2026.8.2'] }],
    ['DEVICE_REVOKED', { revokedAt: now }, {}],
  ] as const)('projects authoritative %s with no permission to clear enforcement', (code, patch, settings) => {
    const { worker } = fixture(); Object.assign(worker, patch); const before = structuredClone(worker);
    const result = projectWorkerWarnings(worker, [], SecurityPolicySchema.parse(settings), ttl, now);
    expect(result.items).toContainEqual(expect.objectContaining({ code, severity: 'CRITICAL', blocking: true, source: 'PLATFORM_STATE' }));
    expect(worker).toEqual(before);
  });
  it('identifies exact binding revalidation, category/security restrictions and readiness independently', () => {
    const { worker, binding } = fixture(); binding.validatedManifestHash = 'b'.repeat(64); binding.healthy = false;
    binding.version.capability.securityBlocked = true;
    const result = projectWorkerWarnings(worker, [binding], SecurityPolicySchema.parse({ blockedCategories: ['writing'] }), ttl, now);
    expect(result.items.map(item => item.code).sort()).toEqual(['CAPABILITY_NOT_READY', 'CAPABILITY_REVALIDATION_REQUIRED', 'CAPABILITY_SECURITY_BLOCKED', 'CATEGORY_BLOCKED']);
    expect(result.items.every(item => item.affectedEntity.capabilityId === binding.version.capabilityId && item.affectedEntity.capabilityVersionId === binding.capabilityVersionId)).toBe(true);
  });
  it('keeps first observed time while active and starts a new episode after absence', () => {
    const { worker } = fixture(); worker.sandboxReady = false;
    const first = projectWorkerWarnings(worker, [], policy, ttl, now);
    const later = new Date(now.getTime() + 1000), repeat = projectWorkerWarnings(worker, [], policy, ttl, later, first);
    expect(repeat.items[0]!.detectedAt).toBe(now.toISOString()); expect(repeat.items[0]!.lastObservedAt).toBe(later.toISOString());
    const clear = projectWorkerWarnings({ ...worker, sandboxReady: true }, [], policy, ttl, later, repeat);
    expect(clear.items).toEqual([]);
    expect(projectWorkerWarnings(worker, [], policy, ttl, later, clear).items[0]!.detectedAt).toBe(later.toISOString());
  });
  it('labels reported warnings and derives blocking from current cloud gates, not the signal', () => {
    const { worker, binding } = fixture();
    worker.health = { warningSignals: [{ code: 'NETWORK_POLICY_VIOLATION', capabilityVersionId: binding.capabilityVersionId }] };
    const report = projectWorkerWarnings(worker, [binding], policy, ttl, now);
    expect(report.coverage.localSignals).toBe('REPORTED');
    expect(report.items[0]).toMatchObject({ code: 'NETWORK_POLICY_VIOLATION', source: 'WORKER_REPORT', blocking: false });
    expect(projectWorkerWarnings({ ...worker, sandboxReady: false }, [binding], policy, ttl, now).items.find(item => item.code === 'NETWORK_POLICY_VIOLATION')?.blocking).toBe(true);
  });
  it('discards foreign/unbound signal entity identifiers and does not enumerate another seller bindings', () => {
    const { worker, binding } = fixture(), foreign = fixture().binding;
    worker.health = { warningSignals: [{ code: 'DEPENDENCY_UNAVAILABLE', capabilityVersionId: foreign.capabilityVersionId }] };
    const result = projectWorkerWarnings(worker, [binding, foreign], policy, ttl, now);
    expect(result.capabilityVersionsChecked).toBe(1); expect(result.coverage.ignoredSignalCount).toBe(1); expect(result.items).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(foreign.capabilityVersionId);
  });
  it('does not present stale or malformed diagnostic reports as fresh observations', () => {
    const { worker } = fixture(); worker.health = { warningSignals: [{ code: 'UNEXPECTED_PERMISSION_USE' }] };
    const stale = projectWorkerWarnings({ ...worker, lastSeenAt: new Date(now.getTime() - ttl) }, [], policy, ttl, now);
    expect(stale.coverage.localSignals).toBe('STALE'); expect(stale.items.map(item => item.code)).toEqual(['HEARTBEAT_EXPIRED']);
    worker.health = { warningSignals: [{ code: 'UNEXPECTED_PERMISSION_USE', description: 'private path' }] };
    const malformed = projectWorkerWarnings(worker, [], policy, ttl, now);
    expect(malformed.coverage.localSignals).toBe('UNAVAILABLE'); expect(malformed.items).toEqual([]);
  });
  it('uses only canonical text even when previous durable display fields were corrupted', () => {
    const { worker } = fixture(); worker.sandboxReady = false;
    const old = projectWorkerWarnings(worker, [], policy, ttl, now); old.items[0]!.description = 'secret leaked through cache';
    expect(JSON.stringify(projectWorkerWarnings(worker, [], policy, ttl, now, old))).not.toContain('secret leaked');
  });
  it('bounds capability observation and exposes truncation rather than invented complete coverage', () => {
    const { worker, binding } = fixture(); const bindings = Array.from({ length: 101 }, () => ({ ...binding, capabilityVersionId: randomUUID(), healthy: false }));
    const result = projectWorkerWarnings(worker, bindings, policy, ttl, now);
    expect(result.capabilityVersionsChecked).toBe(100); expect(result.items).toHaveLength(100); expect(result.truncated).toBe(true);
  });
  it('rejects unknown signal codes, free-form diagnostic payloads and incomplete warning DTOs', () => {
    expect(WorkerWarningSignalsSchema.safeParse([{ code: 'API_KEY=private' }]).success).toBe(false);
    expect(WorkerWarningSignalsSchema.safeParse([{ code: 'INFERENCE_UNAVAILABLE', blocking: false }]).success).toBe(false);
    expect(WorkerWarningSignalsSchema.safeParse(Array.from({ length: 101 }, () => ({ code: 'INFERENCE_UNAVAILABLE' }))).success).toBe(false);
    const { worker } = fixture(); worker.revokedAt = now;
    const value = projectWorkerWarnings(worker, [], policy, ttl, now);
    expect(WorkerWarningSnapshotSchema.safeParse({ ...value, rawDiagnostic: 'private' }).success).toBe(false);
    const { requiredAction: _action, ...missing } = value.items[0]!;
    expect(WorkerWarningSnapshotSchema.safeParse({ ...value, items: [missing] }).success).toBe(false);
  });
});
