import React from "react";
import Link from "next/link";
import type { SellerCapability } from "../lib/types";
import { dateTime } from "../lib/format";
import { Status } from "./ui";

export function CapabilityHealth({ capability: cap }: { capability: SellerCapability }) {
  const live = cap.liveState, success = live?.lastSuccess;
  const blockers = cap.dependencies.filter(dependency => (dependency.required || dependency.approved) && (!dependency.approved || !dependency.healthy || dependency.supported !== true))
    .map(dependency => `${dependency.name}: ${!dependency.approved ? "not approved" : dependency.supported !== true ? "support unverified" : "unhealthy"}`);
  return <article className="capability-health" aria-label={`Capability health: ${cap.title}`}>
    <div className="row between wrap"><Link className="strong-link" href={`/selling/capabilities/${cap.id}`}><h3>{cap.title}</h3></Link><Status value={cap.availability.status} /></div>
    <p className="small muted">Displayed definition: version {cap.version}. {blockers.join("; ") || cap.availability.reason || "No reported dependency blockers"}</p>
    {!live ? <p className="small muted">Live load and last-success evidence were not supplied. Missing values are not zero.</p> : <>
      <p className="small muted">Snapshot {dateTime(live.observedAt)}. Job counts span all versions of this capability.</p>
      <dl className="health-grid">
        <div><dt>Running jobs</dt><dd>{live.runningJobs}</dd></div>
        <div><dt>Configured concurrency</dt><dd>{cap.concurrency ?? "Not reported"}</dd></div>
        <div><dt>Effective concurrency</dt><dd>{live.effectiveConcurrency}</dd></div>
        <div><dt>Queued / configured limit</dt><dd>{live.queueDepth} / {cap.maxQueue ?? "not reported"}</dd></div>
        <div><dt>Scheduled / configured limit</dt><dd>{live.scheduledJobs} / {cap.maxScheduled ?? "not reported"}</dd></div>
        <div><dt>Admission capacity load</dt><dd>{live.capacityLoad}</dd></div>
      </dl>
      <p className="small muted">Admission capacity load includes pending work and occupancy shared across ready Workers. It is not this capability&apos;s running-job count or a reserved execution slot.</p>
      <div className="capability-last-success"><h4>Last successful job, any version</h4>{success ? <>
        <Link className="text-link" href={`/jobs/${success.jobId}`}>Inspect successful job {success.jobId.slice(0, 8)}</Link><p className="small">Completed {dateTime(success.completedAt)}</p>
        <p className="small mono">Recorded version: {success.capabilityVersionId}</p>
        <p className="small muted">{success.capabilityVersionId === cap.versionId ? "This success used the displayed version." : "This success used a different version from the displayed definition."} Historical delivery does not establish current validation or readiness.</p>
      </> : <p className="small muted">No recorded successful job.</p>}</div>
    </>}
  </article>;
}
