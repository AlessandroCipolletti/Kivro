import React from "react";
import Link from "next/link";
import { observedCoverage, observedTime } from "../lib/availability-analytics";
import { dateTime } from "../lib/format";
import type { CapabilityAnalyticsDTO, CapabilityAnalyticsItem } from "../lib/operations";
import { Notice } from "./ui";

function Observations({ item, admin }: { item: CapabilityAnalyticsItem; admin: boolean }) {
  const facts: [string, string | number][] = [
    ["Coverage", observedCoverage(item.coverage.ratio)], ["Eligible interval", observedTime(item.coverage.eligibleMs)],
    ["Observed interval", observedTime(item.coverage.observedMs)], ["Unknown interval", observedTime(item.coverage.unknownMs)],
    ["Online, not busy", observedTime(item.durations.onlineMs)], ["Busy", observedTime(item.durations.busyMs)],
    ["Offline", observedTime(item.durations.offlineMs)], ["Scheduled offline", observedTime(item.durations.scheduledOfflineMs)],
    ["Paused", observedTime(item.durations.pausedMs)], ["Security blocked", observedTime(item.durations.securityBlockedMs)],
    ["Jobs accepted", item.jobsAccepted], ["Accepted attempts", item.acceptedAttempts],
    ["Queue-full rejects", item.queueFullCoverageFrom === null ? "Not tracked" : item.queueFullRejects],
    ["Median queue wait", observedTime(item.queueWait.medianSeconds === null ? null : item.queueWait.medianSeconds * 1000)],
    ["Median execution time", observedTime(item.execution.medianSeconds === null ? null : item.execution.medianSeconds * 1000)],
    ["Retained disconnect failures", item.disconnectFailures],
  ];
  return <details className="page-section"><summary>{item.capabilityTitle}</summary>
    <p><Link className="text-link" href={admin ? `/capabilities/${item.capabilityId}` : `/selling/capabilities/${item.capabilityId}`}>View capability</Link></p>
    <dl className="health-grid">{facts.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
    <p className="small muted">{item.coverage.observationCount} observations; {item.coverage.invalidObservationCount} invalid records excluded. First observed: {item.coverage.firstObservedAt ? dateTime(item.coverage.firstObservedAt) : "Not observed"}. Last observed: {item.coverage.lastObservedAt ? dateTime(item.coverage.lastObservedAt) : "Not observed"}.</p>
    <p className="small muted">Queue wait: {item.queueWait.sampleCount} samples; {item.queueWait.excludedCount} excluded. First queue entry to first execution start; ambiguous pre-start pauses are excluded. Execution: {item.execution.sampleCount} samples; {item.execution.excludedCount} excluded. Terminal elapsed execution excludes confirmed pause time and inconsistent attribution.</p>
    <p className="small muted">{item.queueFullCoverageFrom ? `Queue-full tracking covers ${dateTime(item.queueFullCoverageFrom)} onward within this period. Repeated requests with the same buyer, capability and purchase key count once.` : "Queue-full tracking has not started; absent tracking is not zero rejects."} Disconnect failures count retained platform reconnect-expiry events, not worker-reported text.</p>
  </details>;
}
export function AvailabilityAnalytics({ data, period, admin = false }: { data?: CapabilityAnalyticsDTO; period: { from: string; to: string }; admin?: boolean }) {
  return <section className="page-section" aria-label="Capability availability analytics">
    <h3>Capability availability</h3><p className="small muted">Selected UTC period: {period.from} to {period.to}.</p>
    {!data ? <p className="muted">Availability analytics were not supplied by this API. No historical uptime has been inferred.</p> : <>
      <p className="small muted">Intervals use the previous observed state only when consecutive observations are at most {observedTime(data.maxObservationGapMs)} apart. Time before the first observation, after the last and across larger gaps remains unknown. States are mutually exclusive; online excludes busy. This is bounded observation coverage, not exact uptime or a seller ranking.</p>
      {data.truncated && <Notice tone="warning">Showing {data.items.length} of {data.totalCapabilities} capabilities. Unlisted capabilities are not represented by the displayed totals.</Notice>}
      {data.items.length ? data.items.map(item => <Observations key={item.capabilityId} item={item} admin={admin} />) : <p className="muted">No capabilities in this reporting snapshot.</p>}
    </>}
  </section>;
}
