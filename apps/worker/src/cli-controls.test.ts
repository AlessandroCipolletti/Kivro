import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { main } from './index.ts';
import { WorkerState } from './state.ts';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('explicit local per-job global pause confirmation', () => {
  it.each([false, true])('persists only the requested one-job resume authority: %s', async confirmed => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-cli-controls-'))); roots.push(root);
    vi.stubEnv('KIVRO_WORKER_HOME', root); vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const offer = fixtureOffer(), state = new WorkerState(root);
    state.resume('LOCAL'); state.claim(offer, `kivro-job-${offer.attemptId}`); state.pause('LOCAL'); state.close();
    const persist = WorkerState.prototype.command;
    const command = vi.spyOn(WorkerState.prototype, 'command').mockImplementation(function (this: WorkerState, value) { persist.call(this, value); this.finishCommand(value.id); });
    await main(['job', 'resume', offer.jobId, ...(confirmed ? ['--confirm-global-pause'] : [])]);
    expect(command).toHaveBeenCalledOnce(); expect(command.mock.calls[0]![0]).toMatchObject({ jobId: offer.jobId, type: 'RESUME_JOB', source: 'LOCAL' });
    expect(command.mock.calls[0]![0].resumeWhilePaused).toBe(confirmed ? true : undefined);
    const reopened = new WorkerState(root);
    try { expect(reopened.get('localPause')).toBe(true); expect(reopened.paused()).toBe(true); } finally { reopened.close(); }
  });
  it.each([
    ['resume', '--all'], ['pause', '--all'], ['job', 'pause', 'id'], ['job', 'cancel', 'id'], ['job', 'resume'],
    ['job', 'resume', 'id', 'other-id'], ['job', 'resume', 'id', '--all'],
  ])('rejects confirmation outside exactly one job resume: %j', async (...args) => {
    const command = vi.spyOn(WorkerState.prototype, 'command');
    await expect(main([...args, '--confirm-global-pause'])).rejects.toThrow('CONFIRM_GLOBAL_PAUSE_REQUIRES_ONE_JOB_RESUME');
    expect(command).not.toHaveBeenCalled();
  });
});
