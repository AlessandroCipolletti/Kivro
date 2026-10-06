import { Temporal } from '@js-temporal/polyfill';
import { ScheduleSchema, type Schedule } from '@kivro/contracts';

type Interval = { start: Temporal.Instant; end: Temporal.Instant };
function localInstant(date: Temporal.PlainDate, time: string, zone: string): Temporal.Instant {
  const next = time === '24:00' ? date.add({ days: 1 }) : date;
  const [hour, minute] = (time === '24:00' ? '00:00' : time).split(':').map(Number);
  return Temporal.ZonedDateTime.from({ timeZone: zone, year: next.year, month: next.month, day: next.day, hour, minute }, { disambiguation: 'compatible' }).toInstant();
}
function intervals(schedule: Schedule, date: Temporal.PlainDate): Interval[] {
  const override = schedule.overrides.find(o => o.date === date.toString());
  if (override && !override.available) return [];
  const windows = override ? [{ start: override.start ?? '00:00', end: override.end ?? '24:00' }]
    : schedule.mode === 'ALWAYS' ? [{ start: '00:00', end: '24:00' }]
      : schedule.windows.filter(w => w.day === date.dayOfWeek % 7);
  return windows.map(w => {
    const endDate = w.end !== '24:00' && w.end <= w.start ? date.add({ days: 1 }) : date;
    return { start: localInstant(date, w.start, schedule.timezone), end: localInstant(endDate, w.end, schedule.timezone) };
  });
}
function asInstant(now: Date | string): Temporal.Instant { return Temporal.Instant.from(now instanceof Date ? now.toISOString() : now); }
export function isScheduleOpen(input: Schedule, now: Date | string = new Date()): boolean {
  const schedule = ScheduleSchema.parse(input);
  if (schedule.mode === 'MANUAL') return false;
  const instant = asInstant(now);
  const date = instant.toZonedDateTimeISO(schedule.timezone).toPlainDate();
  if (schedule.overrides.some(o => o.date === date.toString() && !o.available)) return false;
  const dates = schedule.overrides.some(o => o.date === date.toString()) ? [date] : [date.subtract({ days: 1 }), date];
  return dates.flatMap(d => intervals(schedule, d))
    .some(w => Temporal.Instant.compare(instant, w.start) >= 0 && Temporal.Instant.compare(instant, w.end) < 0);
}
export function nextScheduledTime(input: Schedule, now: Date | string = new Date()): string | null {
  const schedule = ScheduleSchema.parse(input);
  if (schedule.mode === 'MANUAL') return null;
  const instant = asInstant(now);
  if (isScheduleOpen(schedule, now)) return new Date(Number(instant.epochMilliseconds)).toISOString();
  const date = instant.toZonedDateTimeISO(schedule.timezone).toPlainDate();
  for (let day = 0; day <= 370; day++) {
    const candidates = intervals(schedule, date.add({ days: day })).filter(w => Temporal.Instant.compare(w.start, instant) > 0).sort((a, b) => Temporal.Instant.compare(a.start, b.start));
    if (candidates[0]) return new Date(Number(candidates[0].start.epochMilliseconds)).toISOString();
  }
  return null;
}
export function schedulePreview(schedule: Schedule, now: Date = new Date(), days = 7): { start: string; end: string }[] {
  const parsed = ScheduleSchema.parse(schedule);
  if (parsed.mode === 'MANUAL') return [];
  const date = asInstant(now).toZonedDateTimeISO(parsed.timezone).toPlainDate();
  return Array.from({ length: Math.max(1, Math.min(31, days)) }, (_, i) => intervals(parsed, date.add({ days: i }))).flat()
    .map(w => ({ start: w.start.toString(), end: w.end.toString() }));
}
