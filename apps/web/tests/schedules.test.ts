import { describe, expect, it } from "vitest";
import { ScheduleSchema, type Schedule } from "@kivro/contracts";
import { isScheduleOpen } from "../../../packages/policy-engine/src/index";
import { overrideDescription, overrideMode, setOverrideMode } from "../src/lib/schedules";

const base: Schedule = { mode: "WEEKLY", timezone: "Europe/Zurich", windows: [], overrides: [] };
describe("seller date overrides", () => {
  it("removes stale times when switching between timed, all-day and unavailable", () => {
    const timed = { date: "2026-10-06", available: true, start: "20:00", end: "07:00" };
    expect(overrideMode(timed)).toBe("TIMED");
    expect(overrideDescription(timed)).toBe("20:00 - 07:00 next day");
    expect(setOverrideMode(timed, "ALL_DAY")).toEqual({ date: timed.date, available: true });
    expect(setOverrideMode(timed, "UNAVAILABLE")).toEqual({ date: timed.date, available: false });
    expect(setOverrideMode({ date: timed.date, available: false }, "TIMED")).toEqual({ date: timed.date, available: true, start: "09:00", end: "17:00" });
  });
  it("preserves loaded midnight and partial ranges with their actual policy defaults", () => {
    expect(overrideMode({ date: "2026-10-06", available: true, start: "00:00", end: "24:00" })).toBe("ALL_DAY");
    expect(overrideDescription({ date: "2026-10-06", available: true, start: "19:00", end: "24:00" })).toBe("19:00 - 24:00");
    expect(setOverrideMode({ date: "2026-10-06", available: true, end: "12:00" }, "TIMED").start).toBe("00:00");
  });
  it("serializes a real overnight exception under the schedule policy and manual pause wins", () => {
    const schedule = ScheduleSchema.parse({ ...base, overrides: [{ date: "2026-10-06", available: true, start: "20:00", end: "07:00" }] });
    expect(isScheduleOpen(schedule, "2026-10-06T18:30:00Z")).toBe(true);
    expect(isScheduleOpen(schedule, "2026-10-07T04:30:00Z")).toBe(true);
    expect(isScheduleOpen(schedule, "2026-10-07T06:00:00Z")).toBe(false);
    expect(isScheduleOpen({ ...schedule, mode: "MANUAL" }, "2026-10-06T18:30:00Z")).toBe(false);
  });
  it("rejects duplicate dates and invalid dates before saving", () => {
    expect(ScheduleSchema.safeParse({ ...base, overrides: [{ date: "2026-02-30", available: true }] }).success).toBe(false);
    expect(ScheduleSchema.safeParse({ ...base, overrides: [{ date: "2026-10-06", available: false }, { date: "2026-10-06", available: true }] }).success).toBe(false);
  });
});
