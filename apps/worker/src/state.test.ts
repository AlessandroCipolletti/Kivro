import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerState } from './state.ts';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { MAX_JOB_PAUSE_MS, attemptDeadline } from '@kivro/openclaw-adapter';

describe('durable worker controls', () => {
  it('snapshots a lower per-job budget immutably and preserves exact milliseconds after reopen', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-state-budget-'))); let state = new WorkerState(root);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const offer = fixtureOffer(); offer.maxPauseMs = 1501; state.resume('LOCAL'); state.claim(offer, `kivro-job-${offer.attemptId}`);
      state.transition(offer.jobId, 'RUNNING'); state.transition(offer.jobId, 'PAUSE_REQUESTED'); state.transition(offer.jobId, 'PAUSED');
      vi.setSystemTime(Date.now() + 1000); state.transition(offer.jobId, 'RESUMING'); state.transition(offer.jobId, 'RUNNING');
      state.close(); state = new WorkerState(root);
      expect(state.attempt(offer.jobId)).toMatchObject({ maxPauseMs: 1501, pausedDurationMs: 1000 });
      expect(() => state.db.prepare('UPDATE attempts SET maxPauseMs=?').run(MAX_JOB_PAUSE_MS)).toThrow('IMMUTABLE_PAUSE_BUDGET');
      state.transition(offer.jobId, 'PAUSE_REQUESTED'); state.transition(offer.jobId, 'PAUSED');
      expect(attemptDeadline(state.attempt(offer.jobId)!)).toBe(Date.now() + 501);
      vi.setSystemTime(Date.now() + 501); state.transition(offer.jobId, 'RESUMING');
      expect(() => state.transition(offer.jobId, 'RUNNING')).toThrow('TIMED_OUT');
      expect(state.attempt(offer.jobId)?.pausedAt).not.toBeNull();
    } finally { vi.useRealTimers(); state.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('migrates legacy attempts without resetting their deadline, pause origin or replay identity', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-state-legacy-'))); let state = new WorkerState(root);
    try {
      const offer = fixtureOffer(); state.resume('LOCAL'); state.claim(offer, `kivro-job-${offer.attemptId}`); state.transition(offer.jobId, 'RUNNING'); state.transition(offer.jobId, 'PAUSE_REQUESTED'); state.transition(offer.jobId, 'PAUSED');
      const before = state.attempt(offer.jobId)!;
      state.db.exec('DROP TRIGGER immutable_attempt_pause_budget; ALTER TABLE attempts DROP COLUMN maxPauseMs; ALTER TABLE attempts DROP COLUMN pausedDurationMs');
      state.close(); state = new WorkerState(root);
      expect(state.attempt(offer.jobId)).toEqual({ ...before, maxPauseMs: MAX_JOB_PAUSE_MS, pausedDurationMs: 0 });
      expect(() => state.claim(offer, 'replay')).toThrow('WORKER_BUSY');
    } finally { state.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('persists confirmed pause time through RESUMING without resetting consumed execution time', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-state-pause-')));
    let state = new WorkerState(root);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const offer = fixtureOffer(); state.resume('LOCAL'); state.claim(offer, `kivro-job-${offer.attemptId}`); state.transition(offer.jobId, 'RUNNING');
      const initial = state.attempt(offer.jobId)!;
      vi.setSystemTime(initial.createdAt + 5000); state.transition(offer.jobId, 'PAUSE_REQUESTED'); state.transition(offer.jobId, 'PAUSED');
      const pausedAt = Date.now(); vi.setSystemTime(pausedAt + 40000); state.transition(offer.jobId, 'PAUSED'); state.transition(offer.jobId, 'RESUMING');
      state.close(); state = new WorkerState(root);
      expect(state.attempt(offer.jobId)).toMatchObject({ pausedAt, pausedDurationMs: 0, deadline: initial.deadline, state: 'RESUMING' });
      state.transition(offer.jobId, 'RUNNING'); state.transition(offer.jobId, 'RUNNING');
      expect(state.attempt(offer.jobId)).toMatchObject({ pausedAt: null, pausedDurationMs: 40000, deadline: initial.deadline + 40000 });
      vi.setSystemTime(Date.now() + 5000); state.transition(offer.jobId, 'PAUSE_REQUESTED'); state.transition(offer.jobId, 'PAUSED');
      vi.setSystemTime(Date.now() + 20000); state.transition(offer.jobId, 'RESUMING'); state.transition(offer.jobId, 'RUNNING');
      expect(state.attempt(offer.jobId)).toMatchObject({ pausedAt: null, pausedDurationMs: 60000, deadline: initial.deadline + 60000 });
      expect(state.attempt(offer.jobId)!.deadline - Date.now()).toBe(offer.permissions.limits.timeoutSeconds * 1000 - 10000);
    } finally { vi.useRealTimers(); state.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('persists local pause, blocks replay, and prevents remote resume overriding local pause', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-state-')));
    let state = new WorkerState(root);
    try {
      expect(state.paused()).toBe(true); state.resume('REMOTE'); expect(state.paused()).toBe(true);
      state.resume('LOCAL'); const offer = fixtureOffer(); state.claim(offer, `kivro-job-${offer.attemptId}`);
      expect(state.pending()).toHaveLength(1); expect(() => state.claim(offer, 'duplicate')).toThrow();
      state.transition(offer.jobId, 'FAILED'); expect(() => state.claim(offer, 'replay')).toThrow();
      state.pause('LOCAL'); state.close(); state = new WorkerState(root); expect(state.paused()).toBe(true); expect(state.pending()).toHaveLength(2);
      state.pause('SECURITY'); expect(() => state.resume('LOCAL')).toThrow('SECURITY_BLOCK');
    } finally { state.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('fails closed when another daemon owns the durable lease', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-lease-'))), state = new WorkerState(root);
    try { state.acquireLease('one'); expect(() => state.acquireLease('two')).toThrow(); state.heartbeatLease('one'); expect(() => state.heartbeatLease('two')).toThrow(); state.releaseLease('one'); state.acquireLease('two'); }
    finally { state.close(); await rm(root, { recursive: true, force: true }); }
  });
});
