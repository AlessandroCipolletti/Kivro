"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { useResource } from "@/lib/hooks";
import { dateTime, duration, money } from "@/lib/format";
import { contributionEstimate, executionFailureDisplay, microUsd, outcomeRate, providerEstimate, type OperationsDTO, type OperationsJobSummary, type SellerCostOperations } from "@/lib/operations";
import { Button, ErrorNotice, Field, Loading, Metric, Notice } from "./ui";
import { AvailabilityAnalytics } from "./availability-analytics";
import { ExecutionOutcomeScope } from "./execution-outcomes";

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="health-grid">{rows.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>;
}
function LastJob({ title, job }: { title: string; job: OperationsJobSummary | null }) {
  return <div><h3>{title}</h3>{job ? <><Link className="text-link" href={`/jobs/${job.id}`}>{job.capabilityTitle}</Link><p className="small muted">{dateTime(job.completedAt)}</p></> : <p className="small muted">No recorded outcome</p>}</div>;
}
export function Operations({ admin = false }: { admin?: boolean }) {
  const [days, setDays] = useState(30);
  const resource = useResource<OperationsDTO>(`/${admin ? "admin" : "seller"}/operations?days=${days}`);
  const data = resource.data;
  return <section className="page-section operations" aria-label={admin ? "Platform operations telemetry" : "Seller operations telemetry"}>
    <div className="section-header"><h2>Operations telemetry</h2><div className="row wrap"><Field label="Reporting period"><select value={days} onChange={event => setDays(Number(event.target.value))}>{[1,7,30,90].map(value => <option key={value} value={value}>Last {value === 1 ? "24 hours" : `${value} days`}</option>)}</select></Field><Button onClick={resource.refresh}><RefreshCw size={14} />Refresh telemetry</Button></div></div>
    <ErrorNotice error={resource.error} retry={resource.refresh} />{resource.loading ? <Loading text="Loading operations snapshot" rows={0} /> : data && <>
      <p className="small muted">Rolling UTC period: {data.period.from} to {data.period.to}. Current reservations and worker state are snapshots, not period totals.</p>
      {admin && <OperationalHolds data={data} />}
      <div className="metrics"><Metric label="Jobs created in period" value={data.jobs.createdCount} /><Metric label="Successful executions" value={data.jobs.executionOutcomes?.succeededCount ?? "Not reported"} detail={data.jobs.executionOutcomes ? `${outcomeRate(data.jobs.successRate)} execution success rate` : "Execution cohort not supplied"} /><Metric label="Execution failure rate" value={executionFailureDisplay(data.jobs).value} detail={executionFailureDisplay(data.jobs).detail} /><Metric label="Average active elapsed time" value={data.jobs.runtime.averageSeconds === null ? "No samples" : duration(data.jobs.runtime.averageSeconds)} detail={`${data.jobs.runtime.sampleCount} completed executions; pauses excluded`} /></div>
      <p className="small muted">{data.jobs.terminalCount} terminal outcomes completed in this period, including {data.jobs.failedCount} failures and {data.jobs.cancelledCount} cancellations across all stages.</p><ExecutionOutcomeScope jobs={data.jobs} />
      <div className="operational-grid page-section"><LastJob title="Last successful job, all time" job={data.jobs.lastSuccess} /><LastJob title="Last failed job, all time" job={data.jobs.lastFailure} /></div>
      <details className="page-section"><summary>Ledger settlements & costs</summary><p className="small muted">USD ledger postings in the selected period. Reversals may relate to older jobs; net amounts can be negative.</p><Facts rows={[
        ["Buyer captures", money(data.finance.buyerCapturedMinor)], ["Buyer refunds", money(data.finance.buyerRefundedMinor)],
        ["Seller earnings", money(data.finance.sellerEarningsMinor)], ["Earnings reversed", money(data.finance.sellerEarningsReversedMinor)], ["Net seller earnings", money(data.finance.netSellerEarningsMinor)],
        ["Platform fees", money(data.finance.platformFeesMinor)], ["Fee reversals", money(data.finance.platformFeeReversalsMinor)], ["Net platform fees", money(data.finance.netPlatformFeesMinor)],
        ["Seller provider cost", microUsd(data.sellerCosts.providerCostMicroUsd)], ["Seller infrastructure cost", microUsd(data.sellerCosts.infrastructureCostMicroUsd)], ["Seller margin", microUsd(data.sellerCosts.marginMicroUsd)],
      ]} /><p className="small muted">Provider invoices, infrastructure costs and final margin are not measured. Marketplace earnings are not profit.</p></details>
      <SellerCostAccounting cost={data.sellerCosts} />
      <AvailabilityAnalytics data={data.capabilityAnalytics} period={data.period} admin={admin} />
      <details className="page-section"><summary>Scheduled reservations ({data.scheduled.jobCount})</summary><Notice>Reservations are not earned revenue or guaranteed start times. Workload and potential proceeds are estimates from each purchased version.</Notice><Facts rows={[
        ["Estimated workload", duration(data.scheduled.estimatedWorkSeconds)], ["Buyer value reserved", money(data.scheduled.reservedBuyerValueMinor)], ["Potential seller proceeds", money(data.scheduled.estimatedSellerEarningsMinor)], ["Expired, pending reconciliation", data.scheduled.expiredReservationCount],
      ]} />{data.scheduled.truncated && <Notice tone="warning">Showing the earliest 200 of {data.scheduled.totalGroups} eligibility groups. Summary totals include all groups.</Notice>}
        {data.scheduled.groups.length ? data.scheduled.groups.map(group => <article className="operator-row" key={`${group.capabilityId}:${group.scheduledAt}`}><div><Link className="strong-link" href={admin ? `/capabilities/${group.capabilityId}` : `/selling/capabilities/${group.capabilityId}`}>{group.capabilityTitle}</Link><p className="small">Eligible {dateTime(group.scheduledAt)}</p><p className="small muted">{group.jobCount} reservations / ~{duration(group.estimatedWorkSeconds)} work / {group.expiredReservationCount} expired</p></div><div><strong>{money(group.reservedBuyerValueMinor)} reserved</strong><p className="small muted">{money(group.estimatedSellerEarningsMinor)} potential seller proceeds</p></div></article>) : <p className="muted">No scheduled reservations.</p>}
      </details>
      <details className="page-section"><summary>Files & worker snapshot</summary><Facts rows={[
        ["Retained file records", data.assets.retainedAssetCount], ["Retained file bytes", data.assets.retainedAssetBytes.toLocaleString()], ["Expired, awaiting deletion", data.assets.expiredUndeletedCount], ["Files finalized in period", data.assets.uploadedCount], ["Finalized upload bytes", data.assets.uploadedBytes.toLocaleString()],
        ["Download grants in period", data.assets.downloadGrantCount], ["Known bytes granted", data.assets.downloadGrantedBytes.toLocaleString()], ["Grants with unknown size", data.assets.downloadGrantUnknownSizeCount], ["Actual transfer bytes", "Not measured"], ["Storage cost", microUsd(data.assets.storageCostMicroUsd)], ["Egress cost", microUsd(data.assets.egressCostMicroUsd)],
        ["Registered devices", data.workers.registeredCount], ["Revoked devices", data.workers.revokedCount], ["Fresh heartbeats", data.workers.freshHeartbeatCount], ["Stale heartbeats", data.workers.staleHeartbeatCount], ["Paused devices", data.workers.pausedCount], ["Fresh sandbox-ready reports", data.workers.sandboxReadyFreshCount], ["Last device contact", dateTime(data.workers.lastSeenAt)],
      ]} /><p className="small muted">Retained bytes describe asset records, not an object-store inventory. Download grants are access permissions, not measured traffic. A fresh heartbeat or sandbox flag alone does not establish capability readiness.</p></details>
      {admin && data.platformInference && <InferenceAccounting inference={data.platformInference} />}
    </>}
  </section>;
}

export function SellerEconomics() {
  const resource = useResource<OperationsDTO>("/seller/operations?days=30");
  const data = resource.data;
  return <section className="page-section operations seller-economics" aria-label="Seller economics">
    <div className="section-header"><h2>Job economics</h2><Button onClick={resource.refresh} disabled={resource.loading}><RefreshCw size={14} />Refresh economics</Button></div>
    <ErrorNotice error={resource.error} retry={resource.refresh} />{resource.loading ? <Loading text="Loading job economics" rows={0} /> : data && <>
      <p className="small muted">Last {data.period.days} days, rolling UTC period: {data.period.from} to {data.period.to}. Jobs today uses the UTC calendar day; jobs total is all time. These counts do not use the rolling period.</p>
      <div className="metrics three"><Metric label="Jobs today (UTC)" value={data.jobs.todayTimeZone === "UTC" ? data.jobs.todayCount ?? "Not reported" : "Not reported"} detail="Created since 00:00 UTC" /><Metric label="Jobs total" value={data.jobs.totalCount ?? "Not reported"} detail="All created jobs at snapshot time" /><Metric label="Jobs created in period" value={data.jobs.createdCount} detail={`Last ${data.period.days} days`} /></div>
      <div className="metrics three"><Metric label="Execution failure rate" value={executionFailureDisplay(data.jobs).value} detail={`Last ${data.period.days} days; ${executionFailureDisplay(data.jobs).detail}`} /><Metric label="Average runtime" value={data.jobs.runtime.averageSeconds === null ? "No samples" : duration(data.jobs.runtime.averageSeconds)} detail={`Last ${data.period.days} days; ${data.jobs.runtime.sampleCount} completed executions; pauses excluded`} /><Metric label="Estimated provider costs" value={providerEstimate(data.sellerCosts)} detail={`Last ${data.period.days} days; recorded estimates only, ${data.sellerCosts.coverage.complete ? "complete priced coverage" : "incomplete coverage"}`} /></div>
      <ExecutionOutcomeScope jobs={data.jobs} />
      <p className="small muted">Provider costs use worker-configured rates, not invoices. {data.sellerCosts.reportedAttempts} of {data.sellerCosts.coverage.acceptedAttempts} accepted attempts have receipts; {data.sellerCosts.coverage.missingReceiptAttempts} missing, {data.sellerCosts.coverage.invalidReceiptAttempts} invalid, {data.sellerCosts.coverage.unpricedAttempts} unpriced and {data.sellerCosts.coverage.unfinishedAttempts} unfinished. Marketplace earnings are not profit.</p>
      <SellerCostAccounting cost={data.sellerCosts} />
    </>}
  </section>;
}

function SellerCostAccounting({ cost }: { cost: SellerCostOperations }) {
  return <details className="page-section"><summary>Seller inference estimates & coverage</summary><Notice>Worker-configured rate estimates, not provider invoices. Attempts accepted or finished in this period are included, including retries. Reserved budgets are not finished spend. Infrastructure costs are excluded.</Notice><Facts rows={[
    ["Recorded provider estimate", providerEstimate(cost)], ["Reserved inference budget", microUsd(cost.reservedCostMicroUsd)], ["Estimated contribution", contributionEstimate(cost)],
    ["Accepted attempts", cost.coverage.acceptedAttempts], ["Receipt reports", cost.reportedAttempts], ["Receipt coverage", cost.coverage.receiptRate === null ? "No accepted attempts" : `${(cost.coverage.receiptRate * 100).toFixed(1)}%`],
    ["Finished attempts", cost.coverage.finishedAttempts], ["Unfinished attempts", cost.coverage.unfinishedAttempts], ["Missing receipts", cost.coverage.missingReceiptAttempts], ["Invalid receipts", cost.coverage.invalidReceiptAttempts], ["Unpriced attempts", cost.coverage.unpricedAttempts], ["Earnings jobs outside cohort", cost.coverage.earningsJobsOutsideCohort],
    ["Attempted calls", cost.attemptedCalls], ["Successful calls", cost.successfulCalls], ["Unpriced calls", cost.unpricedCalls], ["Reported input tokens", cost.inputTokens], ["Reported output tokens", cost.outputTokens],
  ]} /><p className="small muted">Receipt coverage is not priced coverage. {cost.coverage.complete ? "This cohort has complete priced coverage. Estimated contribution subtracts recorded provider estimates from net seller ledger earnings; it can be negative and is not final profit." : "Coverage is incomplete or no attempts are recorded. Contribution is unavailable; recorded estimates may represent only part of actual usage."}</p>
    {cost.truncated && <p className="small muted">Showing 200 of {cost.totalGroups} provider/model groups. Totals include all groups.</p>}{cost.byProvider.map(group => <article className="operator-row" key={JSON.stringify([group.provider, group.model])}><div><h3>{group.provider} / {group.model}</h3><p className="small">{group.reportedAttempts} receipts / {group.attemptedCalls} attempted calls / {group.successfulCalls} successful / {group.unpricedCalls} unpriced</p><p className="small muted">{group.inputTokens} input tokens / {group.outputTokens} output tokens</p></div><div><strong>{microUsd(group.estimatedProviderCostMicroUsd)} estimated</strong><p className="small muted">{microUsd(group.reservedCostMicroUsd)} budget reserved</p></div></article>)}
  </details>;
}

function OperationalHolds({ data }: { data: OperationsDTO }) {
  const recovery = data.manualRecoveryRequired, maintenance = data.maintenanceErrors;
  return <>{recovery && recovery.count > 0 && <div className="operational-hold"><Notice tone="danger"><strong>{recovery.count} jobs require manual recovery</strong><p>These holds have not been resolved by this dashboard.</p></Notice>{recovery.truncated && <p className="small muted">Showing the latest 200 holds.</p>}{recovery.items.map((item, index) => <div className="audit-row" key={`${item.jobId}:${index}`}>{item.jobId ? <Link className="text-link" href={`/jobs/${item.jobId}`}>Inspect job {item.jobId}</Link> : <span>Job reference unavailable</span>}<code>{item.code}</code></div>)}</div>}
    {maintenance && maintenance.count > 0 && <details className="page-section" open><summary>Maintenance failures ({maintenance.count})</summary>{maintenance.truncated && <p className="small muted">Showing the latest 200 failures.</p>}{maintenance.items.map(item => <div className="audit-row" key={item.task}><div><strong>{item.task}</strong><p><code>{item.code}</code></p></div><time>{dateTime(item.lastSeenAt)}</time></div>)}</details>}
  </>;
}
function InferenceAccounting({ inference }: { inference: NonNullable<OperationsDTO["platformInference"]> }) {
  return <details className="page-section"><summary>Platform inference accounting</summary><Notice>Configured-rate estimates and failed-call budget charges, not verified provider invoices. Outstanding reservations are not finished spend.</Notice><Facts rows={[
    ["Finished calls", inference.finishedCalls], ["Successful calls", inference.succeededCalls], ["Failed calls", inference.failedCalls], ["Unsettled calls", inference.unsettledCalls], ["Invalid accounting records", inference.invalidRecordCount], ["Recorded estimated cost", microUsd(inference.recordedCostMicroUsd)], ["Successful usage estimate", microUsd(inference.successfulUsageCostMicroUsd)], ["Failed-call budget charge", microUsd(inference.failedCallBudgetChargeMicroUsd)], ["Outstanding budget reserved", microUsd(inference.reservedBudgetMicroUsd)], ["Provider-billed cost", microUsd(inference.providerBilledCostMicroUsd)],
  ]} />{inference.truncated && <p className="small muted">Showing 200 of {inference.totalGroups} provider/model groups. Totals include all groups.</p>}{inference.byProvider.map(group => <article className="operator-row" key={`${group.provider}:${group.model}`}><div><h3>{group.provider} / {group.model}</h3><p className="small">{group.succeededCalls} successful / {group.failedCalls} failed / {group.unsettledCalls} unsettled</p></div><div><strong>{microUsd(group.recordedCostMicroUsd)} estimated</strong><p className="small muted">{microUsd(group.reservedBudgetMicroUsd)} budget reserved</p></div></article>)}</details>;
}
