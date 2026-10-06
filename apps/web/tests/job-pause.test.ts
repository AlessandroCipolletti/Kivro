import { describe, expect, it } from "vitest";
import { canPauseJob, pauseBudgetText, pauseTime } from "../src/lib/job-pause";

describe("cumulative job pause disclosure", () => {
  it("offers pause only for a seller's running execution, never accepted work", () => {
    expect(canPauseJob({ state: "RUNNING", pauseSupport: "FULL_RESUME" }, true)).toBe(true);
    expect(canPauseJob({ state: "ACCEPTED", pauseSupport: "FULL_RESUME" }, true)).toBe(false);
    expect(canPauseJob({ state: "RUNNING", pauseSupport: "FULL_RESUME" }, false)).toBe(false);
    expect(canPauseJob({ state: "RUNNING", pauseSupport: "NOT_SUPPORTED" }, true)).toBe(false);
  });
  it("uses the purchased limit and preserves prior usage across resume", () => {
    const text = pauseBudgetText({ state: "RUNNING", maxPauseMs: 900000, pausedDurationMs: 120000, pausedAt: null, completedAt: null }, 0);
    expect(text).toContain("15 min for the entire job, shared across all pauses");
    expect(text).toContain("Recorded total used: 2 min; remaining: 13 min");
    expect(text).toContain("Resuming does not reset it");
    expect(pauseTime(61000)).toBe("1 min 1 sec");
  });
  it("includes the active interval, freezes terminal usage and does not turn an exceeded budget negative", () => {
    const job = { state: "PAUSED" as const, maxPauseMs: 60000, pausedDurationMs: 20000, pausedAt: "2026-10-06T10:00:00Z", completedAt: null };
    expect(pauseBudgetText(job, Date.parse("2026-10-06T10:00:30Z"))).toContain("Estimated total used: 50 sec; estimated remaining: 10 sec");
    expect(pauseBudgetText(job, Date.parse("2026-10-06T10:01:00Z"))).toContain("estimated remaining: 0 sec");
    expect(pauseBudgetText({ ...job, state: "TIMED_OUT", completedAt: "2026-10-06T10:00:40Z" }, Date.parse("2026-10-06T11:00:00Z"))).toContain("Recorded total used: 1 min; remaining: 0 sec");
  });
  it("does not invent a default limit or zero usage for historical snapshots", () => {
    expect(pauseBudgetText({ state: "RUNNING", completedAt: null }, 0)).toContain("limit was not supplied");
    expect(pauseBudgetText({ state: "RUNNING", completedAt: null, maxPauseMs: 1000 }, 0)).toContain("1 sec for the entire job");
    expect(pauseBudgetText({ state: "RUNNING", completedAt: null, maxPauseMs: 1000 }, 0)).toContain("usage is unavailable");
  });
});
