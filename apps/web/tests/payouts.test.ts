import { describe, expect, it } from "vitest";
import { payoutAmount, payoutSummaryWarnings } from "../src/lib/payouts";
import type { PayoutSummary } from "../src/lib/types";

const summary: PayoutSummary = { available: true, reason: null, currency: "USD", accountWide: true, paidOutMinor: 0, pendingMinor: 0, failedMinor: 0, canceledMinor: 0, historyComplete: true, lastSyncedAt: "2026-10-06T09:00:00Z", lastError: null };
describe("payout reporting boundaries", () => {
  it("distinguishes observed zero from incomplete and stale history", () => {
    expect(payoutSummaryWarnings(summary)).toEqual([]);
    const warnings = payoutSummaryWarnings({ ...summary, historyComplete: false, lastSyncedAt: null, lastError: "PROVIDER_UNAVAILABLE" });
    expect(warnings).toHaveLength(3);
    expect(warnings.join(" ")).toMatch(/partial recorded totals.*No successful.*stale/);
  });
  it("never describes development payments as bank payouts", () => {
    expect(payoutSummaryWarnings({ ...summary, available: false, reason: "DEVELOPMENT_PAYMENTS" })).toEqual(["Development payments do not produce real bank payouts."]);
  });
  it("formats known currencies and retains exact units for unsupported exponents", () => {
    expect(payoutAmount(12345, "USD").replace(/\s/g, " ")).toBe("USD 123.45");
    expect(payoutAmount(0, "CHF").replace(/\s/g, " ")).toBe("CHF 0.00");
    expect(payoutAmount(12345, "HUF")).toBe("12,345 minor units (HUF)");
    expect(payoutAmount(123, "JPY")).toBe("123 minor units (JPY)");
  });
});
