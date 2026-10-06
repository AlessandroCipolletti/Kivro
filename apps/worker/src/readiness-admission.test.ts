import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as adapter from '@kivro/openclaw-adapter';
import * as diagnostics from './diagnostics.ts';
import * as inference from './inference.ts';
import { WorkerState } from './state.ts';
import type { SecretStore } from './secrets.ts';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { readiness, workerStatus, refreshDailyAdmission } from './readiness.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-readiness-admission-'))), state = new WorkerState(root), docker = new adapter.DockerSandbox();
  cleanups.push(async () => { state.close(); await rm(root, { recursive: true, force: true }); });
  const imageId = `sha256:${'a'.repeat(64)}`, offer = fixtureOffer();
  vi.spyOn(adapter, 'scanRuntime').mockResolvedValue({ version: 'OpenClaw 2026.8.2 (0965053)', compatible: true, configReadable: true, dependencies: [], warnings: [] });
  vi.spyOn(docker, 'available').mockResolvedValue(); vi.spyOn(docker, 'imageId').mockResolvedValue(imageId);
  vi.spyOn(diagnostics, 'cloudReadiness').mockResolvedValue([{ id: 'cloud', status: 'PASS', code: 'CLOUD_READY' }]);
  vi.spyOn(inference, 'inferenceReady').mockResolvedValue({ ready: true });
  state.set('approvedImageId', imageId); state.set('sandboxProof', { imageId, policyVersion: adapter.ADAPTER_POLICY_VERSION, testedAt: Date.now() });
  state.set('sandboxTimingProof', { imageId, version: adapter.TIMING_POLICY_VERSION, testedAt: Date.now() });
  state.set('identity', { workerId: offer.workerId }); state.set('jobLimits', { dailyJobLimit: 1 }); state.resume('LOCAL');
  const secrets = { initialize: async () => {} } as unknown as SecretStore;
  return { state, docker, secrets, offer };
}

describe('daily admission readiness independent of active execution', () => {
  it('reports remaining capacity, blocks new jobs at exhaustion, keeps active execution intact and recovers on the next UTC day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-06T23:59:00Z'));
    const { state, docker, secrets, offer } = await fixture();
    const before = await readiness(state, secrets, docker, 'synthetic-image');
    expect(before.ready).toBe(true); expect(before.dailyJobs).toMatchObject({ dailyJobLimit: 1, claimedJobs: 0, remainingJobs: 1, date: '2026-10-06', timeZone: 'UTC' });
    state.claim(offer, 'synthetic-container'); state.transition(offer.jobId, 'RUNNING', false);
    const blocked = await readiness(state, secrets, docker, 'synthetic-image');
    expect(refreshDailyAdmission(before, state)).toMatchObject({ ready: false, dailyJobs: { remainingJobs: 0 } });
    expect(blocked.ready).toBe(false); expect(blocked.sandboxReady).toBe(true); expect(blocked.checks).toContainEqual(expect.objectContaining({ id: 'dailyJobs', status: 'FAIL', code: 'DAILY_JOB_LIMIT_REACHED' }));
    expect(workerStatus(blocked, false)).toMatchObject({ ready: false, dailyJobs: { remainingJobs: 0, claimedJobs: 1 } });
    expect(state.attempt(offer.jobId)?.state).toBe('RUNNING'); expect(state.paused()).toBe(false);
    vi.setSystemTime(new Date('2026-10-07T00:01:00Z'));
    expect(refreshDailyAdmission(blocked, state)).toMatchObject({ ready: true, dailyJobs: { remainingJobs: 1 } });
    const recovered = await readiness(state, secrets, docker, 'synthetic-image');
    expect(recovered.ready).toBe(true); expect(recovered.dailyJobs).toMatchObject({ date: '2026-10-07', remainingJobs: 1, claimedJobs: 0 });
    expect(state.attempt(offer.jobId)?.state).toBe('RUNNING');
  });
  it('refreshes only daily admission and preserves independent health blockers and unknown legacy failures', async () => {
    const { state, docker, secrets } = await fixture(), report = await readiness(state, secrets, docker, 'synthetic-image');
    const blocked = { ...report, ready: false, checks: [...report.checks, { id: 'inference', status: 'FAIL' as const, code: 'LOCAL_INFERENCE_OFFLINE' }] };
    expect(refreshDailyAdmission(blocked, state).ready).toBe(false);
    expect(refreshDailyAdmission({ ...report, ready: false, checks: [] }, state).ready).toBe(false);
    state.set('jobLimits', { dailyJobLimit: 'bad-secret' });
    const invalid = refreshDailyAdmission(report, state);
    expect(invalid.ready).toBe(false); expect(invalid.dailyJobs).toBeUndefined(); expect(invalid.sandboxReady).toBe(true);
  });
  it.each(['KIVRO_MAX_JOB_FILE_BYTES', 'KIVRO_MAX_JOB_INPUT_BYTES', 'KIVRO_MAX_JOB_OUTPUT_BYTES'])('blocks invalid %s before job acceptance without exposing the configured value', async key => {
    const { state, docker, secrets } = await fixture();
    vi.stubEnv(key, 'private-secret-invalid-limit');
    const blocked = await readiness(state, secrets, docker, 'synthetic-image');
    expect(blocked.ready).toBe(false); expect(blocked.sandboxReady).toBe(true);
    expect(blocked.checks).toContainEqual(expect.objectContaining({ id: 'fileLimits', status: 'FAIL', code: 'FILE_LIMIT_CONFIGURATION_INVALID' }));
    expect(JSON.stringify(blocked)).not.toContain('private-secret-invalid-limit');
    expect(refreshDailyAdmission(blocked, state).ready).toBe(false);
    vi.unstubAllEnvs(); expect((await readiness(state, secrets, docker, 'synthetic-image')).ready).toBe(true);
    expect(state.attempts()).toEqual([]);
  });
  it.each(['bad-config', 'clock-rollback', 'unexpected-error'] as const)('fails closed and redacts invalid daily capacity %s', async reason => {
    const { state, docker, secrets, offer } = await fixture();
    if (reason === 'bad-config') state.set('jobLimits', { dailyJobLimit: 'private-secret' });
    if (reason === 'clock-rollback') { state.claim(offer, 'synthetic-container'); vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 1000); }
    if (reason === 'unexpected-error') vi.spyOn(state, 'dailyJobs').mockImplementation(() => { throw new Error('private-path-and-secret'); });
    const report = await readiness(state, secrets, docker, 'synthetic-image');
    expect(report.ready).toBe(false); expect(report.dailyJobs).toBeUndefined();
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'dailyJobs', status: 'FAIL', code: reason === 'bad-config' ? 'INVALID_WORKER_JOB_LIMITS' : reason === 'clock-rollback' ? 'WORKER_CLOCK_ROLLBACK' : 'DAILY_JOB_STATUS_UNAVAILABLE' }));
    expect(JSON.stringify(report)).not.toMatch(/private-secret|private-path/);
  });
});
