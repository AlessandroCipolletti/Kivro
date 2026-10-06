import React from "react";
import type { FinancialBreakdown } from "@kivro/contracts";
import type { PaymentPolicy } from "../lib/types";
import { money } from "../lib/format";

export function PaymentPolicyDisclosure({ policy }: { policy?: PaymentPolicy }) {
  if (!policy) return <p className="payment-policy small muted">Payment and tax policy has not been supplied.</p>;
  return <div className="payment-policy small muted"><p>Kivro absorbs payment-processing fees from its marketplace share. Tax has not been assessed; it is not recorded as zero or exempt. The total is prepaid credits reserved, not a final tax invoice.</p><p>No settlement occurs without validated delivery.</p></div>;
}

export function JobFinancialBreakdown({ breakdown }: { breakdown?: FinancialBreakdown }) {
  if (!breakdown) return <p className="small muted">An itemized financial snapshot was not recorded for this job. No tax or processing-fee amount is inferred.</p>;
  return <section className="financial-breakdown" aria-label="Purchased financial snapshot"><dl className="metadata-list">
    <div><dt>Currency</dt><dd>{breakdown.currency}</dd></div>
    <div><dt>Base retail price</dt><dd>{money(breakdown.baseRetailMinor)}</dd></div>
    <div><dt>Tax</dt><dd>Not assessed</dd></div>
    <div><dt>Total prepaid credits</dt><dd>{money(breakdown.buyerTotalMinor)}</dd></div>
    <div><dt>Seller entitlement</dt><dd>{money(breakdown.sellerEntitlementMinor)}</dd></div>
    <div><dt>Marketplace fee</dt><dd>{money(breakdown.marketplaceFeeMinor)}</dd></div>
    <div><dt>Payment-processing fee</dt><dd>Not attributed to this job</dd></div>
  </dl><p className="small muted">Kivro absorbs payment-processing fees from its marketplace share. Tax is unassessed, not zero or exempt. These purchased-version amounts describe prepaid credit reservation and allocation, not a final tax invoice or proof of settlement.</p></section>;
}
