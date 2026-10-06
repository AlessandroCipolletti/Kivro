import { describe, expect, it } from "vitest";
import { checkoutAvailability } from "../src/lib/checkout";

describe("checkout eligibility", () => {
  const unavailable = { status: "OFFLINE", canRunNow: false, nextAvailableAt: null, reason: null };
  it("permits queued review only when the API explicitly grants canQueue", () => {
    expect(checkoutAvailability({ ...unavailable, status: "BUSY", canQueue: true })).toMatchObject({ available: true, queueable: true, reviewLabel: "Review queued job" });
    expect(checkoutAvailability({ ...unavailable, status: "BUSY" }).available).toBe(false);
    for (const status of ["OFFLINE", "PAUSED", "BUSY", "SECURITY_BLOCKED"] as const) expect(checkoutAvailability({ ...unavailable, status, canQueue: false }).available).toBe(false);
  });
  it("permits immediate and explicitly schedulable jobs independently", () => {
    expect(checkoutAvailability({ ...unavailable, status: "ONLINE", canRunNow: true }).available).toBe(true);
    expect(checkoutAvailability({ ...unavailable, status: "SCHEDULED_OFFLINE", nextAvailableAt: "2030-01-01T12:00:00Z" }).schedulable).toBe(true);
    expect(checkoutAvailability({ ...unavailable, status: "SCHEDULED_OFFLINE" }).available).toBe(false);
  });
});
