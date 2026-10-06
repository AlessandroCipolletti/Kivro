import type { CapabilityDTO } from "./types";

export function checkoutAvailability(availability: CapabilityDTO["availability"]) {
  const schedulable = availability.status === "SCHEDULED_OFFLINE" && Boolean(availability.nextAvailableAt);
  const queueable = availability.canQueue === true;
  return { schedulable, queueable, available: availability.canRunNow || queueable || schedulable,
    reviewLabel: queueable && !availability.canRunNow ? "Review queued job" : "Review job" };
}
