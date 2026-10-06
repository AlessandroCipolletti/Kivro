import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PREPAID_PAYMENT_POLICY, prepaidFinancialBreakdown, PRICE_TIERS } from "@kivro/contracts";
import { JobFinancialBreakdown, PaymentPolicyDisclosure } from "../src/components/payment-disclosure";

describe("payment and tax disclosure", () => {
  it("keeps unassessed tax and unattributed processing fees separate from quoted money", () => {
    const html = renderToStaticMarkup(React.createElement(JobFinancialBreakdown, { breakdown: prepaidFinancialBreakdown(PRICE_TIERS[0]) }));
    expect(html).toContain("<dt>Tax</dt><dd>Not assessed</dd>");
    expect(html).toContain("<dt>Payment-processing fee</dt><dd>Not attributed to this job</dd>");
    expect(html).toContain("<dt>Total prepaid credits</dt><dd>$0.99</dd>");
    expect(html).toContain("<dt>Seller entitlement</dt><dd>$0.80</dd>");
    expect(html).toContain("<dt>Marketplace fee</dt><dd>$0.19</dd>");
    expect(html).toContain("not a final tax invoice or proof of settlement");
  });
  it("discloses platform fee bearer and no settlement without validated delivery", () => {
    const html = renderToStaticMarkup(React.createElement(PaymentPolicyDisclosure, { policy: PREPAID_PAYMENT_POLICY }));
    expect(html).toContain("from its marketplace share");
    expect(html).toContain("not recorded as zero or exempt");
    expect(html).toContain("No settlement occurs without validated delivery");
  });
  it("does not backfill missing historical policy or snapshot amounts", () => {
    const html = renderToStaticMarkup(React.createElement(JobFinancialBreakdown));
    expect(html).toContain("was not recorded"); expect(html).not.toContain("$0.00");
    expect(renderToStaticMarkup(React.createElement(PaymentPolicyDisclosure))).toContain("has not been supplied");
  });
});
