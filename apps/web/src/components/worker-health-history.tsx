import type { Worker } from "@/lib/types";
import { dateTime, label } from "@/lib/format";
import { healthReason, workerUpdateRecommended } from "@/lib/worker-health";
import { Notice, Status } from "./ui";
import { WorkerWarnings } from "./worker-warnings";

export function WorkerHealthHistory({ worker }: { worker: Worker }) {
  const reason = healthReason(worker.healthStatus);
  return <div className="worker-history">
    <WorkerWarnings snapshot={worker.securityWarnings} />
    {worker.policyReason && <Notice tone="danger"><strong>New paid work blocked by version policy</strong><p>{label(worker.policyReason)}. Update or revalidate the affected runtime before accepting work.</p><code>{worker.policyReason}</code></Notice>}
    {!worker.policyReason && !worker.revokedAt && workerUpdateRecommended(worker.version, worker.latestSupportedWorkerVersion) && <Notice tone="warning"><strong>Worker update recommended</strong><p>Installed {worker.version}; supported release {worker.latestSupportedWorkerVersion}. This recommendation does not block paid work or override current readiness.</p></Notice>}
    <dl className="health-grid">
      <div><dt>Minimum Worker version</dt><dd>{worker.minimumWorkerVersion || "Not supplied"}</dd></div>
      <div><dt>Supported Worker release</dt><dd>{worker.latestSupportedWorkerVersion || "Not supplied"}</dd></div>
      <div><dt>Minimum OpenClaw version</dt><dd>{worker.minimumOpenClawVersion || "Not supplied"}</dd></div>
      <div><dt>Supported OpenClaw release</dt><dd>{worker.latestSupportedOpenClawVersion || "Not supplied"}</dd></div>
      <div><dt>Last recorded cloud health</dt><dd className="mono">{worker.healthStatus || "No status recorded"}</dd></div>
      {reason && <div><dt>Recorded reason</dt><dd>{label(reason)}</dd></div>}
    </dl>
    <p className="small muted">Supported releases are tested by Kivro, not necessarily the newest upstream releases. Version information does not replace worker self-tests or current readiness checks.</p>
    <details className="health-detail"><summary>Health transitions ({worker.healthHistory?.length ?? 0})</summary>
      <p className="small muted">Latest 50 transitions. Transition history is retained for 90 days.</p>
      {worker.healthHistory?.length ? <ol className="health-transitions">{worker.healthHistory.map(event => <li key={event.id}>
        <div className="row between wrap"><Status value={event.metadata.status || "UNKNOWN"} /><time className="small">{dateTime(event.createdAt)}</time></div>
        <p>{event.metadata.reason ? label(event.metadata.reason) : "No reason supplied"}</p>
        <p className="small muted mono">{event.metadata.previous ? `Previous: ${event.metadata.previous}` : "First recorded state"}</p>
        <small className="muted">Worker {event.metadata.version || "not reported"} / OpenClaw {event.metadata.openclawVersion || "not reported"}</small>
      </li>)}</ol> : <p className="muted">No retained health transitions supplied.</p>}
    </details>
  </div>;
}
