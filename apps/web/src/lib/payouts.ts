import type { PayoutSummary } from "./types";

export function payoutSummaryWarnings(summary: PayoutSummary): string[] {
  const warnings: string[] = [];
  if (!summary.available) return [summary.reason === "DEVELOPMENT_PAYMENTS" ? "Development payments do not produce real bank payouts." : summary.reason === "CONNECT_NOT_CONFIGURED" ? "Connect payout onboarding has not been completed." : "Live payout reporting is not configured."];
  if (!summary.historyComplete) warnings.push("Initial payout history is incomplete. Amounts below are partial recorded totals, not your complete payout history.");
  if (!summary.lastSyncedAt) warnings.push("No successful payout synchronization has been recorded.");
  if (summary.lastError) warnings.push(`The last payout reconciliation failed (${summary.lastError}). Recorded values may be stale.`);
  return warnings;
}

export function payoutAmount(amountMinor: number, currency: string): string {
  // Other currencies retain their exact integer until provider-specific units are supplied.
  if (["USD", "CHF", "EUR", "GBP"].includes(currency)) return new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "code" }).format(amountMinor / 100);
  return `${amountMinor.toLocaleString("en-US")} minor units (${currency})`;
}
