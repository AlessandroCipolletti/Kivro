import type { CapabilityDTO } from "./types";
import { dateTime, duration } from "./format";

export function humanAvailability(availability: CapabilityDTO["availability"], estimatedWaitSeconds?: number | null): string {
  switch (availability.status) {
    case "ONLINE": return "Available now";
    case "SCHEDULED_OFFLINE": return availability.nextAvailableAt && Number.isFinite(Date.parse(availability.nextAvailableAt)) ? `Available ${dateTime(availability.nextAvailableAt)}` : "Available later; next time not reported";
    case "BUSY": return typeof estimatedWaitSeconds === "number" && Number.isFinite(estimatedWaitSeconds) && estimatedWaitSeconds >= 0 ? `Busy; about ${duration(estimatedWaitSeconds)} wait` : "Busy; wait estimate unavailable";
    case "PAUSED": return "Temporarily paused";
    case "OFFLINE": return "Provider offline";
    case "SECURITY_BLOCKED": return "Unavailable pending security review";
  }
}
