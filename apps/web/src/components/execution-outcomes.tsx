import React from "react";
import type { OperationsDTO } from "../lib/operations";

export function ExecutionOutcomeScope({ jobs }: { jobs: OperationsDTO["jobs"] }) {
  const cohort = jobs.executionOutcomes;
  return <p className="small muted">{cohort
    ? `Execution rates use ${cohort.decidedCount} terminal jobs with valid recorded execution starts. ${cohort.timedOutCount} execution timeouts are included in failures. ${cohort.excludedBeforeStartCount} outcomes before execution and ${cohort.excludedInvalidTimingCount} invalid timelines are excluded. ${cohort.cancelledAfterStartCount} cancellations after execution started remain separate.`
    : "Execution cohort details were not supplied; terminal counts are not a substitute for an execution failure rate."} Runtime is elapsed execution time, not measured CPU or GPU time.</p>;
}
