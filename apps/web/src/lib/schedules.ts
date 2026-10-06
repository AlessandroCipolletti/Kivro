import type { Schedule } from "./types";

export type DateOverride = Schedule["overrides"][number];
export type OverrideMode = "UNAVAILABLE" | "ALL_DAY" | "TIMED";

export function overrideMode(value: DateOverride): OverrideMode {
  if (!value.available) return "UNAVAILABLE";
  return (value.start ?? "00:00") === "00:00" && (value.end ?? "24:00") === "24:00" ? "ALL_DAY" : "TIMED";
}

export function setOverrideMode(value: DateOverride, mode: OverrideMode): DateOverride {
  if (mode !== "TIMED") return { date: value.date, available: mode === "ALL_DAY" };
  return { date: value.date, available: true,
    start: overrideMode(value) === "TIMED" ? value.start ?? "00:00" : "09:00",
    end: overrideMode(value) === "TIMED" ? value.end ?? "24:00" : "17:00" };
}

export function overrideDescription(value: DateOverride): string {
  const mode = overrideMode(value);
  if (mode === "UNAVAILABLE") return "Unavailable";
  if (mode === "ALL_DAY") return "Available all day";
  const start = value.start ?? "00:00", end = value.end ?? "24:00";
  return `${start} - ${end}${end !== "24:00" && end <= start ? " next day" : ""}`;
}
