import { describe, expect, it } from 'vitest';
import { DEFAULT_SCHEDULE, ScheduleSchema, type Schedule, type PermissionManifest, type Dependency } from '@kivro/contracts';
import { assertPublishable, assertSafeRelativePath, assertProductionConfiguration, assertTransition, canTransition, evaluateAvailability, isPublicAddress, isScheduleOpen, nextScheduledTime, resolvePublicUrl } from './index.js';

const overnight: Schedule = { mode: 'WEEKLY', timezone: 'Europe/Zurich', windows: [{ day: 1, start: '20:00', end: '07:00' }], overrides: [] };
describe('seller-local scheduling', () => {
  it('keeps overnight windows on the seller wall clock', () => {
    expect(isScheduleOpen(overnight, '2026-10-05T18:00:00Z')).toBe(true);
    expect(isScheduleOpen(overnight, '2026-10-06T04:59:59Z')).toBe(true);
    expect(isScheduleOpen(overnight, '2026-10-06T05:00:00Z')).toBe(false);
    expect(nextScheduledTime(overnight, '2026-10-05T12:00:00Z')).toBe('2026-10-05T18:00:00.000Z');
  });
  it('handles 23 and 25 hour days without fixed UTC offsets', () => {
    const allSunday: Schedule = { mode: 'WEEKLY', timezone: 'Europe/Zurich', windows: [{ day: 0, start: '00:00', end: '24:00' }], overrides: [] };
    expect(isScheduleOpen(allSunday, '2026-03-28T23:00:00Z')).toBe(true);
    expect(isScheduleOpen(allSunday, '2026-03-29T21:59:59Z')).toBe(true);
    expect(isScheduleOpen(allSunday, '2026-03-29T22:00:00Z')).toBe(false);
    expect(isScheduleOpen(allSunday, '2026-10-25T22:59:59Z')).toBe(true);
    expect(isScheduleOpen(allSunday, '2026-10-25T23:00:00Z')).toBe(false);
  });
  it('honors full-day closure even for an overnight window', () => {
    expect(isScheduleOpen({ ...overnight, overrides: [{ date: '2026-10-06', available: false }] }, '2026-10-06T02:00:00Z')).toBe(false);
    expect(nextScheduledTime({ ...overnight, mode: 'MANUAL' }, '2026-10-05T12:00:00Z')).toBeNull();
  });
  it('never turns a sleeping or insecure worker online because its schedule is open', () => {
    const ctx = { schedule: DEFAULT_SCHEDULE, workerOnline: true, sandboxReady: true, dependenciesHealthy: true, paused: false, securityBlocked: false, runningJobs: 0, concurrency: 1, queueDepth: 0, maxQueue: 5 };
    expect(evaluateAvailability(ctx).canRunNow).toBe(true);
    expect(evaluateAvailability({ ...ctx, workerOnline: false }).status).toBe('OFFLINE');
    expect(evaluateAvailability({ ...ctx, sandboxReady: false }).canRunNow).toBe(false);
    expect(evaluateAvailability({ ...ctx, paused: true }).status).toBe('PAUSED');
    expect(evaluateAvailability({ ...ctx, securityBlocked: true }).status).toBe('SECURITY_BLOCKED');
    expect(evaluateAvailability({ ...ctx, runningJobs: 1 }).status).toBe('BUSY');
    expect(evaluateAvailability({ ...ctx, queueDepth: 5 }).canRunNow).toBe(false);
    expect(evaluateAvailability({ ...ctx, dependenciesHealthy: undefined }).canRunNow).toBe(false);
  });
  it('replaces overnight spillover when the day has an explicit narrow override', () => {
    const overridden = { ...overnight, overrides: [{ date: '2026-10-06', available: true, start: '12:00', end: '13:00' }] };
    expect(isScheduleOpen(overridden, '2026-10-06T02:00:00Z')).toBe(false);
    expect(isScheduleOpen(overridden, '2026-10-06T10:30:00Z')).toBe(true);
  });
  it('rejects invalid and ambiguous calendar overrides before policy evaluation', () => {
    expect(ScheduleSchema.safeParse({ ...overnight, overrides: [{ date: '2026-02-29', available: false }] }).success).toBe(false);
    expect(ScheduleSchema.safeParse({ ...overnight, overrides: [{ date: '2028-02-29', available: false }] }).success).toBe(true);
    expect(ScheduleSchema.safeParse({ ...overnight, overrides: [{ date: '2026-10-06', available: false }, { date: '2026-10-06', available: true }] }).success).toBe(false);
  });
  it('distinguishes queued admission from immediate execution using the capacity bound', () => {
    const ctx = { schedule: DEFAULT_SCHEDULE, workerOnline: true, sandboxReady: true, dependenciesHealthy: true, paused: false, securityBlocked: false, runningJobs: 1, concurrency: 1, queueDepth: 1, maxQueue: 2 };
    expect(evaluateAvailability(ctx)).toMatchObject({ status: 'BUSY', canRunNow: false, canQueue: true });
    expect(evaluateAvailability({ ...ctx, queueDepth: 2 }).canQueue).toBe(false);
    expect(evaluateAvailability({ ...ctx, paused: true }).canQueue).toBe(false);
    expect(evaluateAvailability({ ...ctx, workerOnline: false }).canQueue).toBe(false);
    expect(evaluateAvailability({ ...ctx, maxQueue: 0 }).canQueue).toBe(false);
  });
});
describe('security policy', () => {
  it('requires exact permission grants and an approved supported transitive graph', () => {
    const permissions: PermissionManifest = { schemaVersion: 1, tools: ['read'], network: { mode: 'NONE', allowedDomains: [] }, resources: [], inference: { provider: 'openai-compatible', model: 'configured-model', credentialRef: 'dedicated' }, limits: { timeoutSeconds: 120, memoryMb: 1024, cpu: 1, maxPids: 64, maxInputBytes: 1024, maxOutputBytes: 1024, maxTokens: 1000 } };
    const dependencies: Dependency[] = [
      { id: 'inference', name: 'Dedicated inference', type: 'INFERENCE', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { inferenceProviders: ['openai-compatible'], credentialRefs: ['dedicated'] } },
      { id: 'read', name: 'Read approved job files', type: 'TOOL', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { tools: ['read'] }, dependsOn: ['inference'] },
    ];
    expect(() => assertPublishable(permissions, dependencies)).not.toThrow();
    expect(() => assertPublishable({ ...permissions, tools: ['process'] }, dependencies)).toThrow();
    expect(() => assertPublishable({ ...permissions, resources: [{ id: 'private-db', type: 'DATABASE', access: 'READ_ONLY' }] }, dependencies)).toThrow();
    expect(() => assertPublishable(permissions, dependencies.map(d => d.id === 'read' ? { ...d, approved: false } : d))).toThrow();
    expect(() => assertPublishable(permissions, dependencies.map(d => ({ ...d, supported: undefined })))).toThrow();
    expect(() => assertPublishable(permissions, dependencies.map(d => d.id === 'inference' ? { ...d, dependsOn: ['read'] } : d))).toThrow('acyclic');
    expect(() => assertPublishable(permissions, dependencies.map(d => d.id === 'read' ? { ...d, dependsOn: ['missing'] } : d))).toThrow();
  });
  it.each(['../private', '/etc/passwd', 'a/../b', 'a//b', './a', 'C:\\Windows', 'a\\b', '%2e%2e/x', 'a\0b'])('rejects unsafe result path %s', path => expect(() => assertSafeRelativePath(path)).toThrow());
  it('allows ordinary output-relative file paths', () => expect(assertSafeRelativePath('images/front.png')).toBe('images/front.png'));
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.2.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2002:7f00:1::'])('blocks nonpublic address %s', address => expect(isPublicAddress(address)).toBe(false));
  it('recognizes globally routable addresses', () => { expect(isPublicAddress('8.8.8.8')).toBe(true); expect(isPublicAddress('2606:4700:4700::1111')).toBe(true); });
  it.each(['http://127.1', 'http://0x7f000001', 'http://2130706433', 'http://[::ffff:127.0.0.1]', 'http://user:pass@example.com', 'file:///etc/passwd', 'http://localhost', 'http://printer.local', 'http://8.8.8.8:8080'])('blocks URL normalization bypass %s', async url => { await expect(resolvePublicUrl(url)).rejects.toThrow(); });
  it('fails production startup with development shortcuts', () => {
    for (const env of [{ NODE_ENV: 'production', DEV_AUTH_ENABLED: 'true' }, { NODE_ENV: 'production', PAYMENT_MODE: 'fake' }, { KIVRO_ENV: 'production', PAYMENT_MODE: 'stripe', SESSION_SECRET: 'local' }]) expect(() => assertProductionConfiguration(env)).toThrow();
    expect(() => assertProductionConfiguration({ NODE_ENV: 'development', PAYMENT_MODE: 'fake', DEV_AUTH_ENABLED: 'true' })).not.toThrow();
  });
  it('requires validation before success and keeps terminal jobs terminal', () => {
    expect(canTransition('RUNNING', 'SUCCEEDED')).toBe(false);
    expect(canTransition('VALIDATING_RESULTS', 'SUCCEEDED')).toBe(true);
    expect(canTransition('PAUSED', 'SUCCEEDED')).toBe(false);
    expect(canTransition('SUCCEEDED', 'RUNNING')).toBe(false);
    expect(() => assertTransition('CANCELLED', 'QUEUED')).toThrow();
    expect(canTransition('SUCCEEDED', 'SUCCEEDED')).toBe(true);
  });
});
