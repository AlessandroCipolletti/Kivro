import { describe, expect, it } from 'vitest';
import { jobPauseExpired } from '../src/job-timing.js';

describe('cumulative confirmed pause budget', () => {
  it('combines completed pauses and the current pause without extending from duplicate commands', () => {
    const job = { maxPauseMs: 900000, pausedDurationMs: 600000, pausedAt: new Date(1000) };
    expect(jobPauseExpired(job, 300999)).toBe(false);
    expect(jobPauseExpired(job, 301000)).toBe(true);
    expect(jobPauseExpired(job, 301001)).toBe(true);
  });
  it('does not replenish prior pause usage on backward clock movement', () => {
    expect(jobPauseExpired({ maxPauseMs: 1000, pausedDurationMs: 1000, pausedAt: new Date(2000) }, 1000)).toBe(true);
  });
  it('permits an already-running job exactly at its pause allowance but rejects excess', () => {
    expect(jobPauseExpired({ maxPauseMs: 1000, pausedDurationMs: 1000, pausedAt: null })).toBe(false);
    expect(jobPauseExpired({ maxPauseMs: 1000, pausedDurationMs: 1001, pausedAt: null })).toBe(true);
  });
});
