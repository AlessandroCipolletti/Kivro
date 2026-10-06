import React from "react";
import Link from "next/link";
import { AlertTriangle, Info, ShieldAlert } from "lucide-react";
import type { WorkerWarningSnapshot } from "@kivro/contracts";
import { dateTime } from "../lib/format";

export function WorkerWarnings({ snapshot }: { snapshot?: WorkerWarningSnapshot }) {
  return <section className="worker-warnings" aria-label="Security warnings"><h3>Security warnings</h3>
    {!snapshot ? <p className="small muted">Warning evidence has not been supplied. Absence of a report does not establish safety.</p> : <>
      <p className="small muted">Observed {dateTime(snapshot.observedAt)}. Coverage: {snapshot.capabilityVersionsChecked} bound capability version{snapshot.capabilityVersionsChecked === 1 ? "" : "s"} only.</p>
      {snapshot.items.length ? <ul className="worker-warning-list">{snapshot.items.map(warning => {
        const Icon = warning.severity === "CRITICAL" ? ShieldAlert : warning.severity === "WARNING" ? AlertTriangle : Info;
        return <li key={warning.id} data-severity={warning.severity}>
          <div className="row wrap"><Icon size={17} aria-hidden="true" /><strong>{warning.severity}</strong><span>{warning.blocking ? "Blocking" : "Non-blocking"}</span></div>
          <h4>{warning.title}</h4><p>{warning.description}</p>
          <dl className="warning-facts"><div><dt>Affected device</dt><dd className="mono">{warning.affectedEntity.workerId}</dd></div>
            {warning.affectedEntity.capabilityId && <div><dt>Capability</dt><dd><Link href={`/selling/capabilities/${warning.affectedEntity.capabilityId}`}>Review capability</Link><small className="mono">{warning.affectedEntity.capabilityVersionId}</small></dd></div>}
            <div><dt>Evidence source</dt><dd>{warning.source === "WORKER_REPORT" ? "Authenticated Worker report, not an independent cloud probe" : "Platform state"}</dd></div>
            <div><dt>First platform observation</dt><dd>{dateTime(warning.detectedAt)}</dd></div><div><dt>Last observed</dt><dd>{dateTime(warning.lastObservedAt)}</dd></div>
          </dl><p><strong>Required action: </strong>{warning.requiredAction}</p>
        </li>;
      })}</ul> : <p className="small">No active warnings in this reported scope. This is not a complete security assessment.</p>}
      <p className="small muted">Local security signals: {snapshot.coverage.localSignals === "REPORTED" ? "reported by the Worker" : snapshot.coverage.localSignals === "STALE" ? "stale; current local evidence is unavailable" : "unavailable"}. Device credential revocation schedule: unavailable.</p>
      {snapshot.coverage.ignoredSignalCount > 0 && <p className="small">{snapshot.coverage.ignoredSignalCount} reported signal{snapshot.coverage.ignoredSignalCount === 1 ? " was" : "s were"} outside the accepted scope.</p>}
      {snapshot.truncated && <p className="small field-error">This warning snapshot is truncated; additional findings may not be shown.</p>}
    </>}
  </section>;
}
