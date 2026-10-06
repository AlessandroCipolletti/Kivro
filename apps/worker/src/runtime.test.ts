import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionManifestHash, hashManifest } from '@kivro/contracts';
import { generateDeviceIdentity, signMessage, stableStringify } from '@kivro/crypto';
import { signOffer } from '@kivro/job-protocol';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { WorkerState } from './state.ts';
import { WorkerRuntime } from './runtime.ts';
import { SecretStore } from './secrets.ts';
import { approveCapability, LocalCapabilitySchema } from './capabilities.ts';
import { validateInferenceConfig } from './inference.ts';
import * as http from './http.ts';
import * as diagnostics from './readiness.ts';
import { MAX_JOB_PAUSE_MS } from '@kivro/openclaw-adapter';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(maxPauseMs = MAX_JOB_PAUSE_MS) {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-deadline-'))), state = new WorkerState(root), secrets = new SecretStore(state), offer = fixtureOffer();
  cleanups.push(async () => { state.close(); await rm(root, { recursive: true, force: true }); });
  offer.permissions.limits.timeoutSeconds = 30; offer.maxPauseMs = maxPauseMs; offer.manifestHash = executionManifestHash(offer);
  const keys = generateDeviceIdentity(), imageId = `sha256:${'a'.repeat(64)}`;
  state.set('identity', { workerId: offer.workerId, serverPublicKey: keys.publicKey, publicKey: keys.publicKey, apiUrl: 'http://127.0.0.1:4000' });
  state.set('approvedImageId', imageId); state.resume('LOCAL');
  const manifest = LocalCapabilitySchema.parse({ capabilityVersionId: offer.capabilityVersionId, permissions: offer.permissions, ioContract: offer.ioContract, dependencies: offer.dependencies, internalInstructions: offer.internalInstructions });
  approveCapability(state, manifest, hashManifest(manifest));
  const config = validateInferenceConfig({ provider: offer.permissions.inference.provider, model: offer.permissions.inference.model, credentialRef: offer.permissions.inference.credentialRef, baseUrl: 'https://provider.example/v1', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 });
  state.set('inference', config); state.set('inferenceProof', { hash: hashManifest(config), testedAt: Date.now() });
  state.set(`capabilityProof:${offer.capabilityVersionId}`, { manifestHash: offer.manifestHash, imageId, inferenceHash: hashManifest(config), testedAt: Date.now() });
  state.set(`capabilityHealth:${offer.capabilityVersionId}`, { ready: true, checkedAt: Date.now() });
  vi.spyOn(secrets, 'get').mockResolvedValue('test-only-dedicated-credential');
  const runtime = new WorkerRuntime(state, secrets, 'test-only-image', true), request = vi.fn().mockResolvedValue({});
  const acceptedPayload = vi.fn().mockResolvedValue(signOffer(offer, keys.privateKey));
  const report = { ready: true, imageId, sandboxReady: true, openclawVersion: 'OpenClaw 2026.8.2 (0965053)', checks: [{ id: 'inference', status: 'PASS' as const, code: 'DEDICATED_INFERENCE_VERIFIED' }], checkedAt: new Date().toISOString() };
  Object.assign(runtime, { report, transport: { request, acceptedPayload } });
  const remove = vi.spyOn(runtime.docker, 'remove').mockResolvedValue();
  const { input: _input, assets: _assets, internalInstructions: _instructions, ...metadata } = offer;
  const notice = { ...metadata, payloadHash: hashManifest(offer) };
  return { offer, state, runtime, remove, request, acceptedPayload, imageId, report, signed: { payload: notice, signature: signMessage(stableStringify(notice), keys.privateKey) } };
}
async function pausedFixture(maxPauseMs = MAX_JOB_PAUSE_MS, dailyJobLimit?: number) {
  const context = await fixture(maxPauseMs), started = deferred(), { runtime, imageId } = context;
  if (dailyJobLimit !== undefined) context.state.set('jobLimits', { dailyJobLimit });
  vi.spyOn(runtime.docker, 'pause').mockResolvedValue(); vi.spyOn(runtime.docker, 'resume').mockResolvedValue();
  vi.spyOn(diagnostics, 'readiness').mockResolvedValue({ ready: true, imageId, sandboxReady: true, openclawVersion: 'OpenClaw 2026.8.2 (0965053)', checks: [], checkedAt: new Date().toISOString() });
  vi.spyOn(runtime.adapter, 'execute').mockImplementation(async (_spec, _offer, _inference, signal, onStarted) => {
    await onStarted(); started.resolve(); await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); return { text: '', files: [] };
  });
  expect(await runtime.accept(context.signed)).toBe(true); const task = runtime.active.get(context.offer.jobId)!.task; await started.promise;
  const command = (type: 'PAUSE_JOB' | 'RESUME_JOB' | 'CANCEL_JOB') => runtime.controlJob({ id: context.offer.attemptId, jobId: context.offer.jobId, type });
  return { ...context, task, command };
}

describe('fresh Worker daily admission', () => {
  it('withdraws ready capabilities immediately after the final claim and preserves the existing paused job', async () => {
    const context = await pausedFixture(MAX_JOB_PAUSE_MS, 1), { offer, state, runtime, command, task, report } = context;
    expect(state.dailyJobs().remainingJobs).toBe(0);
    expect(runtime.readyCapabilityIds()).toEqual([]);
    expect(runtime.active.get(offer.jobId)?.abort.signal.aborted).toBe(false);
    expect(state.attempt(offer.jobId)?.state).toBe('RUNNING');
    await command('PAUSE_JOB');
    vi.mocked(diagnostics.readiness).mockResolvedValue(diagnostics.refreshDailyAdmission(report, state));
    await command('RESUME_JOB');
    expect(state.attempt(offer.jobId)?.state).toBe('RUNNING');
    expect(runtime.docker.resume).toHaveBeenCalledOnce();
    expect(state.dailyJobs().claimedJobs).toBe(1);
    expect(runtime.readyCapabilityIds()).toEqual([]);
    await command('CANCEL_JOB'); await task;
  });
  it('uses fresh UTC usage and limit edits without clearing a separate inference blocker', async () => {
    const { offer, state, runtime, report, signed, acceptedPayload } = await fixture();
    vi.setSystemTime('2026-10-06T23:59:59.000Z');
    state.set(`capabilityHealth:${offer.capabilityVersionId}`, { ready: true, checkedAt: Date.now() });
    state.set('jobLimits', { dailyJobLimit: 1 });
    state.claim(offer, `kivro-job-${offer.attemptId}`); state.transition(offer.jobId, 'FAILED');
    expect(runtime.readyCapabilityIds()).toEqual([]);
    expect(await runtime.accept(signed)).toBe(false); expect(acceptedPayload).not.toHaveBeenCalled();
    vi.setSystemTime('2026-10-07T00:00:00.000Z');
    expect(runtime.readyCapabilityIds()).toEqual([offer.capabilityVersionId]);
    Object.assign(runtime, { report: { ...report, ready: false, checks: [{ id: 'inference', status: 'FAIL', code: 'LOCAL_INFERENCE_OFFLINE' }, { id: 'dailyJobs', status: 'FAIL', code: 'DAILY_JOB_LIMIT_REACHED' }] } });
    state.set('jobLimits', { dailyJobLimit: 2 });
    expect(runtime.readyCapabilityIds()).toEqual([]);
    expect(await runtime.accept(signed)).toBe(false); expect(acceptedPayload).not.toHaveBeenCalled();
  });
  it('reports daily exhaustion without claiming inference failure or polling for new offers', async () => {
    const { offer, state, runtime, report, request, acceptedPayload } = await fixture();
    state.set('jobLimits', { dailyJobLimit: 1 });
    state.claim(offer, `kivro-job-${offer.attemptId}`); state.transition(offer.jobId, 'FAILED');
    vi.spyOn(runtime, 'initialize').mockResolvedValue();
    vi.spyOn(diagnostics, 'readiness').mockResolvedValue(report);
    const offers = vi.fn().mockResolvedValue({ offers: [] });
    const heartbeat = vi.fn().mockImplementation(async () => { state.set('stopRequested', true); return { commands: [] }; });
    Object.assign(runtime, { transport: { request, acceptedPayload, offers, heartbeat } });
    const task = runtime.start(); await vi.advanceTimersByTimeAsync(1000); await task;
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(heartbeat.mock.calls[0]![0]).toMatchObject({ sandboxReady: true, capabilities: [], runningJobIds: [], health: { ready: false, inference: 'READY', dailyJobLimit: 1, dailyJobsClaimed: 1, dailyJobsRemaining: 0 } });
    expect(offers).not.toHaveBeenCalled();
  });
  it('fails closed after clock rollback or invalid limits and cannot resume an existing job through those failures', async () => {
    const context = await pausedFixture(MAX_JOB_PAUSE_MS, 1), { offer, state, runtime, command, task, report } = context;
    await command('PAUSE_JOB');
    state.set('jobLimits', { dailyJobLimit: 0 });
    expect(runtime.readyCapabilityIds()).toEqual([]);
    vi.mocked(diagnostics.readiness).mockResolvedValue(diagnostics.refreshDailyAdmission(report, state));
    await expect(command('RESUME_JOB')).rejects.toThrow('RESUME_NOT_READY');
    state.set('jobLimits', { dailyJobLimit: 2 }); vi.setSystemTime(state.attempt(offer.jobId)!.createdAt - 1);
    expect(runtime.readyCapabilityIds()).toEqual([]);
    vi.mocked(diagnostics.readiness).mockResolvedValue(diagnostics.refreshDailyAdmission(report, state));
    await expect(command('RESUME_JOB')).rejects.toThrow('RESUME_NOT_READY');
    expect(runtime.docker.resume).not.toHaveBeenCalled();
    await command('CANCEL_JOB'); await task;
  });
});

describe('authoritative Worker deadlines', () => {
  it('requires explicit one-job confirmation under global pause and leaves new acceptance blocked', async () => {
    const { offer, state, runtime, command, task, signed } = await pausedFixture();
    await command('PAUSE_JOB'); state.pause('LOCAL'); state.pause('REMOTE');
    await vi.advanceTimersByTimeAsync(10000);
    await expect(command('RESUME_JOB')).rejects.toThrow('CLEAR_GLOBAL_PAUSE_BEFORE_JOB_RESUME');
    expect(runtime.docker.resume).not.toHaveBeenCalled(); expect(state.attempt(offer.jobId)?.state).toBe('PAUSED');
    await runtime.controlJob({ id: offer.attemptId, jobId: offer.jobId, type: 'RESUME_JOB', resumeWhilePaused: true });
    expect(runtime.docker.resume).toHaveBeenCalledOnce(); expect(state.attempt(offer.jobId)?.state).toBe('RUNNING');
    const resumed = state.attempt(offer.jobId)!;
    await vi.advanceTimersByTimeAsync(1000); await command('RESUME_JOB');
    expect(state.attempt(offer.jobId)).toEqual(resumed); expect(runtime.docker.resume).toHaveBeenCalledOnce();
    expect(state.get('localPause')).toBe(true); expect(state.get('remotePause')).toBe(true); expect(state.paused()).toBe(true);
    expect(await runtime.accept(signed)).toBe(false);
    expect(state.db.prepare("SELECT jobId FROM audit WHERE event='JOB_RESUME_GLOBAL_PAUSE_CONFIRMED'").all()).toEqual([{ jobId: offer.jobId }]);
    await command('CANCEL_JOB'); await task;
  });
  it('never lets the confirmed per-job override bypass a security block', async () => {
    const { offer, state, runtime, command, task } = await pausedFixture();
    await command('PAUSE_JOB'); state.pause('SECURITY');
    await expect(runtime.controlJob({ id: offer.attemptId, jobId: offer.jobId, type: 'RESUME_JOB', resumeWhilePaused: true })).rejects.toThrow('SECURITY_BLOCK');
    expect(runtime.docker.resume).not.toHaveBeenCalled(); expect(state.attempt(offer.jobId)?.state).toBe('PAUSED');
    expect(state.get('securityBlock')).toBeTruthy(); await command('CANCEL_JOB'); await task;
  });
  it('rechecks security after the cloud RUNNING acknowledgement before thaw', async () => {
    const { offer, state, runtime, command, task, request } = await pausedFixture();
    await command('PAUSE_JOB'); await runtime.flush(); state.pause('LOCAL');
    request.mockImplementation(async (_method, _path, body) => { if (body.type === 'RUNNING') state.pause('SECURITY'); return {}; });
    await expect(runtime.controlJob({ id: offer.attemptId, jobId: offer.jobId, type: 'RESUME_JOB', resumeWhilePaused: true })).rejects.toThrow('SECURITY_BLOCK');
    await task; expect(runtime.docker.resume).not.toHaveBeenCalled(); expect(state.attempt(offer.jobId)?.state).toBe('CANCELLED');
    expect(state.get('localPause')).toBe(true); expect(state.get('securityBlock')).toBeTruthy();
  });
  it('uses the immutable signed lower budget cumulatively across repeated pauses and duplicate commands', async () => {
    const { offer, state, task, command } = await pausedFixture(5001);
    expect(state.attempt(offer.jobId)?.maxPauseMs).toBe(5001);
    await vi.advanceTimersByTimeAsync(5000); await command('PAUSE_JOB');
    await vi.advanceTimersByTimeAsync(3000); await command('RESUME_JOB');
    expect(state.attempt(offer.jobId)?.pausedDurationMs).toBe(3000);
    await vi.advanceTimersByTimeAsync(2000); await command('PAUSE_JOB');
    await vi.advanceTimersByTimeAsync(1000); await command('PAUSE_JOB');
    await vi.advanceTimersByTimeAsync(1000); expect(state.attempt(offer.jobId)?.state).toBe('PAUSED');
    await vi.advanceTimersByTimeAsync(1); await task;
    expect(state.attempt(offer.jobId)?.state).toBe('TIMED_OUT');
    expect(state.pending().filter(item => (item.body as { type?: string }).type === 'TIMED_OUT')).toHaveLength(1);
    expect(state.hasPendingResult(offer.jobId)).toBe(false);
  });
  it('excludes a confirmed pause longer than the original execution deadline and retains remaining time', async () => {
    const { offer, state, task, command } = await pausedFixture();
    const deadline = state.attempt(offer.jobId)!.deadline;
    await vi.advanceTimersByTimeAsync(5000); await command('PAUSE_JOB');
    await vi.advanceTimersByTimeAsync(70000); expect(state.attempt(offer.jobId)?.state).toBe('PAUSED');
    await command('RESUME_JOB');
    expect(state.attempt(offer.jobId)).toMatchObject({ deadline: deadline + 70000, pausedDurationMs: 70000, pausedAt: null });
    await vi.advanceTimersByTimeAsync(24999); expect(state.attempt(offer.jobId)?.state).toBe('RUNNING');
    await vi.advanceTimersByTimeAsync(1); await task;
    expect(state.attempt(offer.jobId)?.state).toBe('TIMED_OUT'); expect(state.hasPendingResult(offer.jobId)).toBe(false);
  });
  it('enforces the bounded pause expiry without requiring cloud connectivity', async () => {
    const { offer, state, task, command, remove } = await pausedFixture();
    await vi.advanceTimersByTimeAsync(5000); await command('PAUSE_JOB');
    await vi.advanceTimersByTimeAsync(MAX_JOB_PAUSE_MS - 1); expect(state.attempt(offer.jobId)?.state).toBe('PAUSED');
    await vi.advanceTimersByTimeAsync(1); await task;
    expect(state.attempt(offer.jobId)?.state).toBe('TIMED_OUT'); expect(remove).toHaveBeenCalledOnce();
    expect(state.pending().filter(item => (item.body as { type?: string }).type === 'TIMED_OUT')).toHaveLength(1);
  });
  it('does not replenish active execution time over repeated or duplicate pause/resume commands', async () => {
    const { offer, state, task, command } = await pausedFixture();
    for (let cycle = 0; cycle < 2; cycle++) {
      await vi.advanceTimersByTimeAsync(5000); await command('PAUSE_JOB'); await vi.advanceTimersByTimeAsync(10000); await command('PAUSE_JOB');
      await vi.advanceTimersByTimeAsync(10000); await command('RESUME_JOB'); await command('RESUME_JOB');
    }
    expect(state.attempt(offer.jobId)?.pausedDurationMs).toBe(40000);
    await vi.advanceTimersByTimeAsync(19999); expect(state.attempt(offer.jobId)?.state).toBe('RUNNING');
    await vi.advanceTimersByTimeAsync(1); await task; expect(state.attempt(offer.jobId)?.state).toBe('TIMED_OUT');
  });
  it('cancels while paused with no resume or later timeout', async () => {
    const { offer, state, runtime, command, task } = await pausedFixture();
    await command('PAUSE_JOB'); await vi.advanceTimersByTimeAsync(40000); await command('CANCEL_JOB'); await task;
    await vi.advanceTimersByTimeAsync(MAX_JOB_PAUSE_MS); expect(state.attempt(offer.jobId)?.state).toBe('CANCELLED');
    expect(runtime.docker.resume).not.toHaveBeenCalled(); expect(state.get(`timeout:${offer.jobId}`)).toBeUndefined();
  });
  it('keeps the pause bound when readiness fails and refuses thaw after a late health check', async () => {
    const { offer, state, runtime, task, command, imageId } = await pausedFixture();
    await command('PAUSE_JOB');
    vi.mocked(diagnostics.readiness).mockResolvedValueOnce({ ready: false, sandboxReady: true, openclawVersion: 'UNKNOWN', checks: [], checkedAt: new Date().toISOString() });
    await expect(command('RESUME_JOB')).rejects.toThrow('RESUME_NOT_READY'); expect(state.attempt(offer.jobId)?.state).toBe('PAUSED');
    vi.mocked(diagnostics.readiness).mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + MAX_JOB_PAUSE_MS); return { ready: true, imageId, sandboxReady: true, openclawVersion: 'OpenClaw 2026.8.2 (0965053)', checks: [], checkedAt: new Date().toISOString() }; });
    await expect(command('RESUME_JOB')).rejects.toThrow('TIMED_OUT'); await task;
    expect(runtime.docker.resume).not.toHaveBeenCalled(); expect(state.attempt(offer.jobId)?.state).toBe('TIMED_OUT');
  });
  it('charges pause-request draining time and never acknowledges PAUSED after active expiry', async () => {
    const { offer, state, runtime, task, command } = await pausedFixture(), drain = deferred();
    vi.spyOn(runtime.active.get(offer.jobId)!.broker, 'pause').mockImplementationOnce(() => drain.promise);
    await vi.advanceTimersByTimeAsync(5000);
    const pause = command('PAUSE_JOB'), rejection = expect(pause).rejects.toThrow('TIMED_OUT');
    await vi.advanceTimersByTimeAsync(25000); drain.resolve(); await rejection; await task;
    expect(state.attempt(offer.jobId)?.state).toBe('TIMED_OUT');
    expect(state.pending().filter(item => (item.body as { type?: string }).type === 'PAUSED')).toHaveLength(0);
  });
  it('awaits cloud RUNNING acknowledgement before thaw and fails closed on resume rejection', async () => {
    const { offer, state, runtime, task, command, request } = await pausedFixture(), ack = deferred(), entered = deferred();
    await command('PAUSE_JOB'); await runtime.flush();
    request.mockImplementation(async (_method, _path, body) => { if (body.type === 'RUNNING') { entered.resolve(); await ack.promise; throw new Error('CLOUD_RESUME_DENIED'); } return {}; });
    const resume = command('RESUME_JOB'), rejection = expect(resume).rejects.toThrow('CLOUD_RESUME_DENIED'); await entered.promise;
    expect(runtime.docker.resume).not.toHaveBeenCalled(); ack.resolve(); await rejection; await task;
    expect(runtime.docker.resume).not.toHaveBeenCalled(); expect(state.attempt(offer.jobId)?.state).toBe('CANCELLED');
  });
  it('does not resume against changed sandbox consent', async () => {
    const { offer, state, runtime, task, command } = await pausedFixture();
    await command('PAUSE_JOB'); state.set('approvedImageId', `sha256:${'b'.repeat(64)}`);
    await expect(command('RESUME_JOB')).rejects.toThrow('LOCAL_CONSENT_CHANGED');
    expect(runtime.docker.resume).not.toHaveBeenCalled(); expect(state.attempt(offer.jobId)?.state).toBe('PAUSED');
    await command('CANCEL_JOB'); await task;
  });
  it('does not substitute a newly approved manifest for the accepted paused attempt', async () => {
    const { offer, state, runtime, task, command } = await pausedFixture();
    await command('PAUSE_JOB');
    const capability = state.get<Record<string, unknown>>(`capability:${offer.capabilityVersionId}`)!;
    state.set(`capability:${offer.capabilityVersionId}`, { ...capability, manifestHash: 'b'.repeat(64) });
    await expect(command('RESUME_JOB')).rejects.toThrow('RESUME_MANIFEST_CHANGED'); expect(runtime.docker.resume).not.toHaveBeenCalled();
    await command('CANCEL_JOB'); await task;
  });
  it('aborts held inference at the advertised 30s wall limit and durably reports TIMED_OUT, not provider failure', async () => {
    const { offer, state, runtime, signed, remove } = await fixture(), started = deferred(), aborted = vi.fn();
    const upstream = vi.spyOn(http, 'boundedRequest').mockImplementation(async (_url, options) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => { aborted(); reject(options.signal!.reason); }, { once: true }); started.resolve();
    }));
    vi.spyOn(runtime.adapter, 'execute').mockImplementation(async (_spec, _offer, inference, _signal, onStarted) => {
      await onStarted(); await inference({ model: offer.permissions.inference.model, messages: [{ role: 'user', content: 'test fixture' }], max_tokens: 8 });
      return { text: 'must not deliver', files: [] };
    });
    expect(await runtime.accept(signed)).toBe(true); const task = runtime.active.get(offer.jobId)!.task; await started.promise;
    const attempt = state.attempt(offer.jobId)!; expect(attempt.deadline - attempt.createdAt).toBe(30000);
    await vi.advanceTimersByTimeAsync(29999); expect(aborted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await task;
    expect(aborted).toHaveBeenCalledOnce(); expect(upstream).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce();
    expect(state.attempt(offer.jobId)?.state).toBe('TIMED_OUT'); expect(state.hasPendingResult(offer.jobId)).toBe(false);
    expect(state.pending().map(item => item.body)).toContainEqual({ attemptId: offer.attemptId, type: 'TIMED_OUT' });
    expect(state.get('inferenceProof')).toBeDefined();
    expect(state.db.prepare('SELECT event FROM audit WHERE event LIKE ?').all('EXECUTION_STOPPED_%')).toEqual([{ event: 'EXECUTION_STOPPED_TIMED_OUT' }]);
    expect(state.get(`usageReceipt:${offer.attemptId}`)).toMatchObject({ attemptedCalls: 1, unpricedCalls: 1 });
    expect(runtime.active.size).toBe(0);
  });
  it('does not start Docker when the budget expires during payload download', async () => {
    const { offer, state, runtime, signed, acceptedPayload } = await fixture(), started = deferred();
    acceptedPayload.mockImplementation(async (_jobId, _attemptId, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }); started.resolve();
    }));
    const execute = vi.spyOn(runtime.adapter, 'execute');
    expect(await runtime.accept(signed)).toBe(true); const task = runtime.active.get(offer.jobId)!.task; await started.promise;
    await vi.advanceTimersByTimeAsync(30000); await task;
    expect(execute).not.toHaveBeenCalled(); expect(state.attempt(offer.jobId)?.state).toBe('TIMED_OUT');
  });
  it('checks the absolute deadline before accepting a result even if the event loop has not fired the timer', async () => {
    const { offer, state, runtime, signed } = await fixture();
    vi.spyOn(runtime.adapter, 'execute').mockImplementation(async (_spec, _offer, _inference, _signal, onStarted) => {
      await onStarted(); vi.setSystemTime(Date.now() + 30001); return { text: 'late', files: [] };
    });
    expect(await runtime.accept(signed)).toBe(true); await runtime.active.get(offer.jobId)!.task;
    expect(state.attempt(offer.jobId)?.state).toBe('TIMED_OUT'); expect(state.hasPendingResult(offer.jobId)).toBe(false);
  });
  it('keeps manual cancellation distinct and does not change it to timeout during cleanup', async () => {
    const { offer, state, runtime, signed } = await fixture(), started = deferred();
    vi.spyOn(runtime.adapter, 'execute').mockImplementation(async (_spec, _offer, _inference, signal, onStarted) => {
      await onStarted(); started.resolve(); await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('CANCELLED')), { once: true }));
      return { text: '', files: [] };
    });
    expect(await runtime.accept(signed)).toBe(true); const active = runtime.active.get(offer.jobId)!; await started.promise;
    active.abort.abort(); await vi.advanceTimersByTimeAsync(30000); await active.task;
    expect(state.attempt(offer.jobId)?.state).toBe('CANCELLED'); expect(state.get(`timeout:${offer.jobId}`)).toBeUndefined();
  });
  it('does not expire an immutable result queued on time while its cloud acknowledgement is delayed', async () => {
    const { offer, state, runtime, signed, request } = await fixture(), queued = deferred(), delivered = deferred();
    request.mockImplementation(async (_method, path) => { if (path.endsWith('/result')) { queued.resolve(); await delivered.promise; } return {}; });
    vi.spyOn(runtime.adapter, 'execute').mockImplementation(async (_spec, _offer, _inference, _signal, onStarted) => { await onStarted(); return { text: 'on time', files: [] }; });
    expect(await runtime.accept(signed)).toBe(true); const task = runtime.active.get(offer.jobId)!.task; await queued.promise;
    await vi.advanceTimersByTimeAsync(90000); expect(state.get(`timeout:${offer.jobId}`)).toBeUndefined();
    expect(state.attempt(offer.jobId)?.state).toBe('UPLOADING_RESULTS'); delivered.resolve(); await task;
    expect(state.attempt(offer.jobId)?.state).toBe('SUCCEEDED');
  });
  it('recovers an expired unfinished attempt as timeout without executing it again', async () => {
    const { offer, state, runtime } = await fixture(); state.claim(offer, `kivro-job-${offer.attemptId}`); state.transition(offer.jobId, 'RUNNING');
    vi.setSystemTime(Date.now() + 30001); const execute = vi.spyOn(runtime.adapter, 'execute'); await runtime.recover(offer.workerId);
    expect(execute).not.toHaveBeenCalled(); expect(state.attempt(offer.jobId)?.state).toBe('TIMED_OUT');
  });
});
