import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionOutcomeScope } from "../src/components/execution-outcomes";
import type { OperationsDTO } from "../src/lib/operations";
import { contributionEstimate, executionFailureDisplay, microUsd, outcomeRate, providerEstimate, type SellerCostOperations, type SellerUsageTotals } from "../src/lib/operations";

describe("operations display units", () => {
  it("uses the authoritative started-job denominator rather than reconstructing it from all terminal counts", () => {
    const executionOutcomes = { basis: "STARTED_TERMINAL_JOBS" as const, decidedCount: 8, succeededCount: 6, failedCount: 2, timedOutCount: 1, excludedBeforeStartCount: 10, excludedInvalidTimingCount: 1, cancelledAfterStartCount: 2 };
    expect(executionFailureDisplay({ executionOutcomes, failureRate: 0.25 })).toEqual({ value: "25.0%", detail: "2 execution failures / 8 started, decided jobs" });
    expect(executionFailureDisplay({ executionOutcomes: { ...executionOutcomes, decidedCount: 0, failedCount: 0 }, failureRate: null }).value).toBe("No decided outcomes");
  });
  it("does not present an unscoped legacy rate as an execution failure rate", () => {
    expect(executionFailureDisplay({ failureRate: 0 })).toEqual({ value: "Cohort not reported", detail: "Execution outcome scope is unavailable" });
    expect(executionFailureDisplay({ failureRate: 0.25 }).value).toBe("Cohort not reported");
  });
  it("discloses excluded prestart outcomes and invalid timelines separately from executed timeouts and cancellations", () => {
    const jobs = { executionOutcomes: { basis: "STARTED_TERMINAL_JOBS", decidedCount: 8, succeededCount: 6, failedCount: 2, timedOutCount: 1, excludedBeforeStartCount: 10, excludedInvalidTimingCount: 1, cancelledAfterStartCount: 2 } } as OperationsDTO["jobs"];
    const html = renderToStaticMarkup(React.createElement(ExecutionOutcomeScope, { jobs }));
    for (const text of ["8 terminal jobs with valid recorded execution starts", "1 execution timeouts", "10 outcomes before execution", "1 invalid timelines", "2 cancellations after execution started remain separate"]) expect(html).toContain(text);
    expect(renderToStaticMarkup(React.createElement(ExecutionOutcomeScope, { jobs: { ...jobs, executionOutcomes: undefined } }))).toContain("terminal counts are not a substitute");
  });
  it("does not turn absent outcomes into a zero failure rate", () => {
    expect(outcomeRate(null)).toBe("No decided outcomes");
    expect(outcomeRate(0)).toBe("0.0%");
    expect(outcomeRate(0.25)).toBe("25.0%");
  });
  it("preserves unknown costs and micro-dollar precision", () => {
    expect(microUsd(null)).toBe("Not measured");
    expect(microUsd(0)).toBe("USD 0.000000");
    expect(microUsd(1)).toBe("USD 0.000001");
    expect(microUsd(1250000)).toBe("USD 1.250000");
  });
  it("keeps missing or wholly unpriced provider estimates unknown while preserving priced zero", () => {
    const usage: SellerUsageTotals = { reportedAttempts: 0, attemptedCalls: 0, successfulCalls: 0, unpricedCalls: 0, inputTokens: 0, outputTokens: 0, estimatedProviderCostMicroUsd: 0, reservedCostMicroUsd: 0 };
    expect(providerEstimate(usage)).toBe("Not measured");
    expect(providerEstimate({ ...usage, reportedAttempts: 1 })).toBe("USD 0.000000");
    expect(providerEstimate({ ...usage, reportedAttempts: 1, attemptedCalls: 1 })).toBe("USD 0.000000");
    expect(providerEstimate({ ...usage, reportedAttempts: 1, attemptedCalls: 1, unpricedCalls: 1 })).toBe("Not measured");
    expect(providerEstimate({ ...usage, reportedAttempts: 1, attemptedCalls: 2, unpricedCalls: 1, estimatedProviderCostMicroUsd: 12345 })).toBe("USD 0.012345");
  });
  it("requires complete priced coverage, not just a 100% receipt rate, for contribution", () => {
    const cost: SellerCostOperations = { providerCostMicroUsd: null, providerBilledCostMicroUsd: null, infrastructureCostMicroUsd: null, marginMicroUsd: null, reason: "WORKER_RATE_ESTIMATE_ONLY", costBasis: "WORKER_CONFIGURED_RATES", reportedAttempts: 1, attemptedCalls: 1, successfulCalls: 1, unpricedCalls: 0, inputTokens: 30, outputTokens: 20, estimatedProviderCostMicroUsd: 2000000, reservedCostMicroUsd: 3000000, estimatedContributionMarginMicroUsd: -100000, totalGroups: 0, truncated: false, byProvider: [], coverage: { acceptedAttempts: 1, finishedAttempts: 1, unfinishedAttempts: 0, missingReceiptAttempts: 0, invalidReceiptAttempts: 0, unpricedAttempts: 0, earningsJobsOutsideCohort: 0, receiptRate: 1, complete: true } };
    expect(contributionEstimate(cost)).toBe("USD -0.100000");
    expect(contributionEstimate({ ...cost, coverage: { ...cost.coverage, complete: false } })).toBe("Not measured");
    expect(contributionEstimate({ ...cost, unpricedCalls: 1 })).toBe("Not measured");
    expect(contributionEstimate({ ...cost, coverage: { ...cost.coverage, earningsJobsOutsideCohort: 1 } })).toBe("Not measured");
    expect(contributionEstimate({ ...cost, estimatedContributionMarginMicroUsd: null })).toBe("Not measured");
  });
});
