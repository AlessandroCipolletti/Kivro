import { describe, expect, it } from 'vitest';
import { DEFAULT_SCHEDULE, type Schedule } from '@kivro/contracts';
import { estimatedCarryover, reservationWindow, windowReservationLimit } from '../src/scheduling.js';

describe('conservative execution-window reservation policy', () => {
  it('uses real IANA day lengths for continuous availability, including DST', () => {
    const schedule = { ...DEFAULT_SCHEDULE, timezone: 'Europe/Zurich' };
    const spring = reservationWindow(schedule, new Date('2026-03-29T10:00:00Z'))!;
    const fall = reservationWindow(schedule, new Date('2026-10-25T10:00:00Z'))!;
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 3600_000);
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * 3600_000);
    expect(reservationWindow(schedule, new Date('2026-03-29T22:00:00Z'))!.start.toISOString()).toBe('2026-03-29T22:00:00.000Z');
  });
  it('merges overlapping overnight windows but clips the spill at a closed date override', () => {
    const schedule: Schedule = { mode: 'WEEKLY', timezone: 'UTC', windows: [{ day: 1, start: '22:00', end: '02:00' }, { day: 1, start: '23:00', end: '03:00' }], overrides: [] };
    expect(reservationWindow(schedule, new Date('2026-10-06T01:00:00Z'))).toEqual({ start: new Date('2026-10-05T22:00:00Z'), end: new Date('2026-10-06T03:00:00Z') });
    schedule.overrides.push({ date: '2026-10-06', available: false });
    expect(reservationWindow(schedule, new Date('2026-10-05T23:00:00Z'))!.end.toISOString()).toBe('2026-10-06T00:00:00.000Z');
    expect(reservationWindow(schedule, new Date('2026-10-06T01:00:00Z'))).toBeNull();
  });
  it('respects a narrow date override and exclusive closing boundaries', () => {
    const schedule: Schedule = { mode: 'WEEKLY', timezone: 'UTC', windows: [{ day: 1, start: '22:00', end: '02:00' }],
      overrides: [{ date: '2026-10-06', available: true, start: '12:00', end: '13:00' }] };
    expect(reservationWindow(schedule, new Date('2026-10-06T01:00:00Z'))).toBeNull();
    expect(reservationWindow(schedule, new Date('2026-10-06T12:30:00Z'))).toEqual({ start: new Date('2026-10-06T12:00:00Z'), end: new Date('2026-10-06T13:00:00Z') });
    expect(reservationWindow(schedule, new Date('2026-10-06T13:00:00Z'))).toBeNull();
    expect(reservationWindow({ ...schedule, mode: 'MANUAL' }, new Date('2026-10-06T12:30:00Z'))).toBeNull();
  });
  it('bounds starts by effective concurrency, queue maximum, duration and reservation maximum', () => {
    const input = { concurrency: 2, maxQueue: 8, maxScheduled: 20, remainingMs: 60_000, estimatedDurationSeconds: 60 };
    expect(windowReservationLimit(input)).toBe(2);
    expect(windowReservationLimit({ ...input, remainingMs: 120_000 })).toBe(4);
    expect(windowReservationLimit({ ...input, remainingMs: 3600_000 })).toBe(10);
    expect(windowReservationLimit({ ...input, remainingMs: 3600_000, maxScheduled: 3 })).toBe(3);
    expect(windowReservationLimit({ ...input, maxQueue: 0, remainingMs: 3600_000 })).toBe(2);
    expect(windowReservationLimit({ ...input, remainingMs: 1 })).toBe(2);
    expect(windowReservationLimit({ ...input, remainingMs: 0 })).toBe(0);
    expect(windowReservationLimit({ ...input, concurrency: 0 })).toBe(0);
  });
  it('estimates current work draining before a later window without treating closed hours as capacity', () => {
    const now = new Date('2026-10-06T10:00:00Z');
    expect(estimatedCarryover(DEFAULT_SCHEDULE, 3, 2, 60, now, new Date('2026-10-06T11:00:00Z'))).toBe(0);
    expect(estimatedCarryover(DEFAULT_SCHEDULE, 3, 2, 60, now, new Date('2026-10-06T10:01:00Z'))).toBe(1);
    expect(estimatedCarryover(DEFAULT_SCHEDULE, 3, 2, 60, now, new Date('2026-10-06T10:00:59Z'))).toBe(3);
    const schedule: Schedule = { mode: 'WEEKLY', timezone: 'UTC', windows: [{ day: 2, start: '11:00', end: '12:00' }], overrides: [] };
    expect(estimatedCarryover(schedule, 3, 2, 60, now, new Date('2026-10-06T11:00:00Z'))).toBe(3);
    expect(estimatedCarryover(schedule, 3, 2, 60, now, new Date('2026-10-06T11:01:00Z'))).toBe(1);
    expect(estimatedCarryover(DEFAULT_SCHEDULE, 3, 0, 60, now, new Date('2026-10-06T11:00:00Z'))).toBe(3);
  });
});
