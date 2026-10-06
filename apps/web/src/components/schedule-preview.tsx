"use client";
import { useEffect, useState } from "react";
import { ScheduleSchema } from "@kivro/contracts";
import { isScheduleOpen, nextScheduledTime, schedulePreview } from "@kivro/policy-engine/schedule";
import type { Schedule } from "../lib/types";
import { overrideDescription } from "../lib/schedules";

function localDay(value: Date | string, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function windowLabel(window: { start: string; end: string }, timezone: string) {
  const format = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${format.format(new Date(window.start))} to ${format.format(new Date(window.end))}`;
}

export function SchedulePreview({ value, at }: { value: Schedule; at?: string }) {
  const [clock, setClock] = useState(() => new Date(at ?? Date.now()));
  useEffect(() => { if (at) return; const timer = setInterval(() => setClock(new Date()), 60_000); return () => clearInterval(timer); }, [at]);
  const parsed = ScheduleSchema.safeParse(value);
  if (!parsed.success) return <p className="field-error">Complete the schedule and date overrides to preview effective service hours.</p>;
  const schedule = parsed.data, open = isScheduleOpen(schedule, clock), nextAt = nextScheduledTime(schedule, clock);
  const windows = schedulePreview(schedule, clock, 7);
  const recent = schedulePreview(schedule, new Date(clock.getTime() - 26 * 3600_000), 3);
  const next = nextAt ? [...recent, ...windows, ...schedulePreview(schedule, new Date(nextAt), 1)].find(window => Date.parse(window.start) <= Date.parse(nextAt) && Date.parse(window.end) > Date.parse(nextAt)) : undefined;
  const startDay = new Date(`${localDay(clock, schedule.timezone)}T12:00:00Z`);
  const dates = Array.from({ length: 7 }, (_, index) => new Date(startDay.getTime() + index * 86400_000));
  return <section className="schedule-preview" aria-label="Effective schedule preview"><h3>Schedule preview / {schedule.timezone}</h3>
    <div><span>Current schedule</span><strong>{open ? "Open now" : schedule.mode === "MANUAL" ? "Manually unavailable" : "Scheduled offline"}</strong></div>
    <div><span>{open ? "Current window" : "Next window"}</span><span>{next ? windowLabel(next, schedule.timezone) : nextAt ? new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(nextAt)) : "No upcoming window"}</span></div>
    <h4>Next 7 days</h4>{dates.map(date => {
      const key = date.toISOString().slice(0, 10), override = schedule.overrides.find(item => item.date === key);
      const dayWindows = windows.filter(window => localDay(window.start, schedule.timezone) === key);
      return <div key={key}><span>{new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(date)}</span><span>{dayWindows.length ? dayWindows.map(window => windowLabel(window, schedule.timezone)).join("; ") : "Unavailable"}{override && <small className="field-hint">Date override: {overrideDescription(override)}{schedule.mode === "MANUAL" ? "; manual unavailability takes precedence" : ""}</small>}</span></div>;
    })}
    <p className="small muted">Times use the seller timezone. Date overrides take precedence over recurring windows. Actual execution also requires Worker readiness and no pause.</p>
  </section>;
}
