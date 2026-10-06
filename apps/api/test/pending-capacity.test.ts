import { describe, expect, it } from 'vitest';
import { appendPendingJob, assignPendingJobs, type PendingJob } from '../src/pending-capacity.js';

const job = (id: string, capabilityId: string, workerIds: string[], age: number): PendingJob => ({ id, capabilityId, workerIds, createdAt: new Date(age) });
const limits = (...caps: string[]) => new Map(caps.map(id => [id, { concurrency: 1, active: 0, maxQueue: 0 }]));

describe('compatible pending-slot matching', () => {
  it('moves flexible old work to a spare device without losing its reserved slot', () => {
    const jobs = [job('old', 'a', ['w1', 'w2'], 0), job('new', 'b', ['w1'], 1)];
    expect(assignPendingJobs(jobs, limits('a', 'b'))).toEqual(new Map([['old', 'w2'], ['new', 'w1']]));
    const three = [...jobs, job('third', 'c', ['w2', 'w3'], 2)];
    expect(assignPendingJobs(three, limits('a', 'b', 'c')).size).toBe(3);
  });
  it('does not count incompatible spare devices or self-reported jobs as capacity', () => {
    const jobs = [job('a1', 'a', ['w1'], 0), job('b1', 'b', ['w1'], 1), job('c1', 'c', ['w2'], 2)];
    expect(assignPendingJobs(jobs, limits('a', 'b', 'c'))).toEqual(new Map([['a1', 'w1'], ['c1', 'w2']]));
  });
  it('preserves per-capability FIFO across unready historical versions without blocking other capabilities', () => {
    const jobs = [job('old-version', 'a', [], 0), job('new-version', 'a', ['w1'], 1), job('other', 'b', ['w1'], 2)];
    expect(assignPendingJobs(jobs, limits('a', 'b'))).toEqual(new Map([['other', 'w1']]));
  });
  it('counts active capability jobs separately from available device edges and drains lower limits', () => {
    const capLimits = limits('a', 'b'); capLimits.set('a', { concurrency: 1, active: 2, maxQueue: 0 });
    const jobs = [job('waiting-a', 'a', ['w1'], 0)];
    const assigned = assignPendingJobs(jobs, capLimits); expect(assigned.size).toBe(0);
    expect(appendPendingJob(jobs, assigned, job('new-a', 'a', ['w1'], 1), capLimits)).toBeNull();
    expect(appendPendingJob(jobs, assigned, job('new-b', 'b', ['w2'], 1), capLimits)?.assignments.get('new-b')).toBe('w2');
  });
  it('allows only the declared positive queue allowance when another capability holds the device', () => {
    const capLimits = limits('a', 'b'); capLimits.set('b', { concurrency: 1, active: 0, maxQueue: 1 });
    const jobs = [job('a1', 'a', ['w1'], 0)], assigned = assignPendingJobs(jobs, capLimits);
    const first = appendPendingJob(jobs, assigned, job('b1', 'b', ['w1'], 1), capLimits)!;
    expect(first.assignments.get('a1')).toBe('w1'); expect(first.assignments.has('b1')).toBe(false);
    expect(appendPendingJob(first.jobs, first.assignments, job('b2', 'b', ['w1'], 2), capLimits)).toBeNull();
  });
  it('cannot promote an older due reservation by evicting an admitted zero-queue reservation', () => {
    const capLimits = limits('a', 'b'); capLimits.set('b', { concurrency: 1, active: 0, maxQueue: 1 });
    const jobs = [job('admitted', 'a', ['w1'], 2)], assigned = assignPendingJobs(jobs, capLimits);
    expect(appendPendingJob(jobs, assigned, job('older-due', 'b', ['w1'], 0), capLimits)).toBeNull();
    expect(appendPendingJob(jobs, assigned, job('older-compatible', 'b', ['w2'], 0), capLimits)?.assignments.size).toBe(2);
  });
  it('breaks matching ties by acceptance id, independent of input/device list ordering', () => {
    const jobs = [job('z', 'a', ['w2', 'w1'], 0), job('a', 'a', ['w1', 'w2'], 0)];
    expect(assignPendingJobs(jobs, limits('a'))).toEqual(new Map([['a', 'w1']]));
    expect(assignPendingJobs([...jobs].reverse(), limits('a'))).toEqual(assignPendingJobs(jobs, limits('a')));
  });
});
