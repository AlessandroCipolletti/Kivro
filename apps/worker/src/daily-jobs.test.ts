import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hashManifest } from '@kivro/contracts';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { WorkerState } from './state.ts';
import { approveJobLimits, DEFAULT_DAILY_JOB_LIMIT } from './job-limits.ts';
import { main } from './index.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-daily-jobs-'))), state = new WorkerState(root);
  cleanups.push(async () => { state.close(); await rm(root, { recursive: true, force: true }); });
  state.resume('LOCAL'); return { root, state };
}
function configure(state: WorkerState, dailyJobLimit: number) {
  const config = { dailyJobLimit }; return approveJobLimits(state, config, hashManifest(config));
}
function claim(state: WorkerState) { const offer = fixtureOffer(); state.claim(offer, `kivro-job-${offer.attemptId}`); return offer; }
function finish(state: WorkerState) { const offer = claim(state); state.transition(offer.jobId, 'FAILED'); return offer; }

describe('durable daily Worker admission', () => {
  it('applies a finite legacy-compatible default and never imports inference budgets', async () => {
    const { state } = await fixture(); state.set('inference', { dailyUsdLimit: 10, dailyTokenLimit: 500000 });
    expect(state.dailyJobs()).toMatchObject({ dailyJobLimit: DEFAULT_DAILY_JOB_LIMIT, claimedJobs: 0, remainingJobs: 100, timeZone: 'UTC' });
    finish(state); expect(state.dailyJobs().claimedJobs).toBe(1);
    expect(state.get('inference')).toEqual({ dailyUsdLimit: 10, dailyTokenLimit: 500000 });
  });
  it('counts failed and cancelled jobs across capabilities and rejects before any accepted event or attempt', async () => {
    const { state } = await fixture(); configure(state, 2); finish(state); const second = claim(state); state.transition(second.jobId, 'CANCELLED');
    const before = state.pending(), audit = state.db.prepare('SELECT COUNT(*) AS count FROM audit').get();
    expect(() => claim(state)).toThrow('DAILY_JOB_LIMIT_EXCEEDED');
    expect(state.attempts()).toHaveLength(2); expect(state.pending()).toEqual(before);
    expect(state.db.prepare('SELECT COUNT(*) AS count FROM audit').get()).toEqual(audit);
    expect(state.dailyJobs()).toMatchObject({ claimedJobs: 2, remainingJobs: 0 });
  });
  it('does not refund successful jobs, pause/resume, or repeated terminal acknowledgements', async () => {
    const { state } = await fixture(); configure(state, 1); const offer = claim(state);
    state.transition(offer.jobId, 'RUNNING'); state.transition(offer.jobId, 'UPLOADING_RESULTS'); state.transition(offer.jobId, 'SUCCEEDED');
    state.transition(offer.jobId, 'SUCCEEDED'); state.pause('LOCAL'); state.resume('LOCAL');
    for (const event of state.pending()) state.acknowledge(event.id);
    expect(() => claim(state)).toThrow('DAILY_JOB_LIMIT_EXCEEDED'); expect(state.dailyJobs().claimedJobs).toBe(1);
  });
  it('preserves history across reopen, invalid replay and limit changes without resetting consumption', async () => {
    const { root, state } = await fixture(); configure(state, 3); const offer = finish(state);
    expect(() => state.claim(offer, 'replay')).toThrow(); expect(state.dailyJobs().claimedJobs).toBe(1);
    const reopened = new WorkerState(root); cleanups.push(async () => reopened.close());
    expect(reopened.dailyJobs().claimedJobs).toBe(1); configure(reopened, 1);
    expect(() => claim(reopened)).toThrow('DAILY_JOB_LIMIT_EXCEEDED'); configure(reopened, 2); finish(reopened);
    expect(state.dailyJobs()).toMatchObject({ dailyJobLimit: 2, claimedJobs: 2, remainingJobs: 0 });
  });
  it('counts existing legacy attempts when a new limit is configured', async () => {
    const { root, state } = await fixture(); finish(state); finish(state); expect(state.get('jobLimits')).toBeUndefined();
    const reopened = new WorkerState(root); cleanups.push(async () => reopened.close()); configure(reopened, 1);
    expect(reopened.dailyJobs()).toMatchObject({ claimedJobs: 2, remainingJobs: 0 }); expect(() => claim(reopened)).toThrow('DAILY_JOB_LIMIT_EXCEEDED');
  });
  it('starts a fresh UTC allowance only at midnight and rejects clock rollback after reopening', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-06T23:59:59.999Z');
    const { root, state } = await fixture(); configure(state, 1); finish(state); expect(() => claim(state)).toThrow('DAILY_JOB_LIMIT_EXCEEDED');
    vi.setSystemTime('2026-10-07T00:00:00.000Z'); expect(state.dailyJobs()).toMatchObject({ date: '2026-10-07', claimedJobs: 0 }); finish(state);
    vi.setSystemTime('2026-10-06T12:00:00.000Z'); const reopened = new WorkerState(root); cleanups.push(async () => reopened.close());
    expect(() => claim(reopened)).toThrow('WORKER_CLOCK_ROLLBACK'); expect(reopened.attempts()).toHaveLength(2);
  });
  it.each([0, -1, 1.5, Infinity, NaN, '2', null, 10001])('fails closed for invalid local configured limit %s', async invalid => {
    const { state } = await fixture(); expect(() => approveJobLimits(state, { dailyJobLimit: invalid })).toThrow('INVALID_WORKER_JOB_LIMITS');
    state.set('jobLimits', { dailyJobLimit: invalid }); expect(() => claim(state)).toThrow('INVALID_WORKER_JOB_LIMITS');
    expect(state.attempts()).toEqual([]); expect(state.pending()).toEqual([]);
  });
  it('rejects unknown configuration fields and requires the exact preview hash without changing usage', async () => {
    const { state } = await fixture(); finish(state);
    expect(() => approveJobLimits(state, { dailyJobLimit: 2, dailyUsdLimit: 99 })).toThrow('INVALID_WORKER_JOB_LIMITS');
    const preview = approveJobLimits(state, { dailyJobLimit: 2 }); expect(preview.approved).toBe(false); expect(state.get('jobLimits')).toBeUndefined();
    expect(() => approveJobLimits(state, { dailyJobLimit: 3 }, preview.approvalHash)).toThrow('JOB_LIMITS_APPROVAL_MISMATCH');
    expect(state.get('jobLimits')).toBeUndefined(); configure(state, 2); expect(state.dailyJobs().claimedJobs).toBe(1);
  });
  it('rolls admission back atomically when outbox persistence fails', async () => {
    const { state } = await fixture(); configure(state, 1);
    const enqueue = vi.spyOn(state, 'enqueue').mockImplementation(() => { throw new Error('SYNTHETIC_OUTBOX_FAILURE'); });
    expect(() => claim(state)).toThrow('SYNTHETIC_OUTBOX_FAILURE'); expect(state.attempts()).toEqual([]); expect(state.dailyJobs().claimedJobs).toBe(0);
    enqueue.mockRestore(); finish(state); expect(state.dailyJobs().claimedJobs).toBe(1);
  });
  it('does not consume admission for paused or busy offers', async () => {
    const { state } = await fixture(); configure(state, 2); state.pause('LOCAL'); expect(() => claim(state)).toThrow('WORKER_PAUSED');
    expect(state.dailyJobs().claimedJobs).toBe(0); state.resume('LOCAL'); claim(state);
    expect(() => claim(state)).toThrow('WORKER_BUSY'); expect(state.dailyJobs().claimedJobs).toBe(1);
  });
  it('serializes independent process admissions at the durable SQLite budget', async () => {
    const { root, state } = await fixture(); configure(state, 5);
    const program = `import {WorkerState} from ${JSON.stringify(new URL('./state.ts', import.meta.url).href)};
      import {fixtureOffer} from ${JSON.stringify(new URL('../../../packages/job-protocol/src/fixtures.ts', import.meta.url).href)};
      const state=new WorkerState(process.argv[1]); let accepted=0;
      try { for(let index=0;index<100;index++) { const offer=fixtureOffer();
        try { state.claim(offer,'synthetic-'+offer.attemptId); accepted++; state.transition(offer.jobId,'FAILED'); }
        catch(error) { if(error.message==='DAILY_JOB_LIMIT_EXCEEDED') break; if(error.message!=='WORKER_BUSY') throw error; }
        await new Promise(resolve=>setTimeout(resolve,2));
      } console.log(JSON.stringify({accepted})); } finally {state.close();}`;
    const run = promisify(execFile);
    const results = await Promise.all(Array.from({ length: 3 }, () => run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, root], { timeout: 15000 })));
    expect(results.reduce((total, result) => total + (JSON.parse(result.stdout) as { accepted: number }).accepted, 0)).toBe(5);
    expect(state.dailyJobs()).toMatchObject({ claimedJobs: 5, remainingJobs: 0 }); expect(state.activeAttempts()).toEqual([]);
    expect(state.pending().filter(event => (event.body as { type: string }).type === 'ACCEPTED')).toHaveLength(5);
  });
  it('exposes preview, explicit approval and durable status through the real CLI without secrets or daemon startup', async () => {
    const { root, state } = await fixture(), file = join(root, 'limits.json'), config = { dailyJobLimit: 2 };
    await writeFile(file, JSON.stringify(config)); vi.stubEnv('KIVRO_WORKER_HOME', root);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await main(['limits', 'configure', '--file', file]); expect(state.get('jobLimits')).toBeUndefined();
    const preview = JSON.parse(String(stdout.mock.calls.at(-1)![0])) as { approvalHash: string; approved: boolean }; expect(preview.approved).toBe(false);
    await main(['limits', 'configure', '--file', file, '--approve', preview.approvalHash]); expect(state.get('jobLimits')).toEqual(config);
    finish(state); await main(['limits', 'status']); expect(JSON.parse(String(stdout.mock.calls.at(-1)![0]))).toMatchObject({ dailyJobLimit: 2, claimedJobs: 1, remainingJobs: 1, timeZone: 'UTC' });
    await expect(main(['limits', 'status', 'extra'])).rejects.toThrow('INVALID_LIMITS_COMMAND');
    await expect(main(['limits', 'unknown'])).rejects.toThrow('UNKNOWN_LIMITS_COMMAND');
    expect(state.get('identity')).toBeUndefined(); expect(state.get('inference')).toBeUndefined();
  });
  it('refreshes CLI health admission immediately, preserves active execution and recovers at UTC midnight without clearing other blockers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-06T23:59:59.999Z');
    const { root, state } = await fixture(); configure(state, 1); vi.stubEnv('KIVRO_WORKER_HOME', root);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true), output = () => JSON.parse(String(stdout.mock.calls.at(-1)![0]));
    const report = { ready: true, sandboxReady: true, openclawVersion: 'synthetic', checkedAt: new Date().toISOString(), checks: [{ id: 'inference', status: 'PASS', code: 'DEDICATED_INFERENCE_VERIFIED' }] };
    state.set('health', report); const offer = claim(state); state.transition(offer.jobId, 'RUNNING', false);
    await main(['health']); expect(output()).toMatchObject({ ready: false, sandboxReady: true, dailyJobs: { remainingJobs: 0, claimedJobs: 1 }, jobs: [{ jobId: offer.jobId, state: 'RUNNING' }] });
    expect(output().checks).toContainEqual(expect.objectContaining({ id: 'dailyJobs', status: 'FAIL', code: 'DAILY_JOB_LIMIT_REACHED' }));
    expect(state.get('health')).toEqual(report); expect(state.paused()).toBe(false);
    vi.setSystemTime('2026-10-07T00:00:00.000Z'); await main(['health']);
    expect(output()).toMatchObject({ ready: true, dailyJobs: { remainingJobs: 1, claimedJobs: 0 }, jobs: [{ jobId: offer.jobId, state: 'RUNNING' }] });
    state.set('health', { ...report, ready: false, checks: [{ id: 'inference', status: 'FAIL', code: 'LOCAL_INFERENCE_OFFLINE' }] });
    await main(['health']); expect(output().ready).toBe(false); expect(output().dailyJobs.remainingJobs).toBe(1);
    state.set('jobLimits', { dailyJobLimit: 'private-secret' }); await main(['health']);
    expect(output().ready).toBe(false); expect(output().dailyJobs).toBeUndefined(); expect(JSON.stringify(output())).not.toContain('private-secret');
  });
});
