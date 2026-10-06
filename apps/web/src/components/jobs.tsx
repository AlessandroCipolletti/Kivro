"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, ArrowRight, BriefcaseBusiness, File, Pause, Play, RefreshCw, Search, X } from "lucide-react";
import type { JobDTO } from "@/lib/types";
import { JobReview } from "./reviews";
import { ReportButton } from "./problem-reports";
import { JobResult } from "./job-result";
import { JobInputs } from "./job-inputs";
import { JobSeller } from "./job-seller";
import { JobFinancialBreakdown } from "./payment-disclosure";
import { JobPauseBudget, usePauseBudgetText } from "./job-pause-budget";
import { pauseLabels } from "./data-processing";
import { useAction, useResource } from "@/lib/hooks";
import { ApiError, post } from "@/lib/api";
import { dateTime, money, terminalStates } from "@/lib/format";
import { canPauseJob } from "@/lib/job-pause";
import { JobWait } from "./job-wait";
import { RequireAuth, useApp } from "./provider";
import { Button, Confirm, Empty, ErrorNotice, Loading, Notice, PageHeading, Status } from "./ui";

export function JobControls({ job, seller = false, refresh }: { job: JobDTO; seller?: boolean; refresh: () => void }) {
  const [control, setControl] = useState<"cancel" | "pause" | "resume" | null>(null);
  const [globalPauseConfirmation, setGlobalPauseConfirmation] = useState(false);
  const action = useAction();
  const pauseBudget = usePauseBudgetText(job);
  const cancel = !terminalStates.has(job.state);
  const pause = canPauseJob(job, seller);
  const resume = seller && job.pauseSupport !== "NOT_SUPPORTED" && job.state === "PAUSED";
  const descriptions = {
    cancel: "Cancel this job permanently? Any reserved credits are released according to the current job and payment state.",
    pause: `Request a pause for this job. Execution is only paused once the worker acknowledges it. Existing provider requests may take time to stop. ${pauseBudget}`,
    resume: `Resume this existing job after the worker rechecks readiness? Schedule and security restrictions still apply. ${pauseBudget}`,
  };
  function open(next: NonNullable<typeof control>) {
    action.setError(undefined); setGlobalPauseConfirmation(false); setControl(next);
  }
  async function applyControl() {
    await action.run(async () => {
      try {
        await post(`/jobs/${job.id}/${control}`, control === "resume" && globalPauseConfirmation ? { confirmGlobalPause: true } : undefined);
        setControl(null); setGlobalPauseConfirmation(false); refresh();
      } catch (error) {
        if (control === "resume" && error instanceof ApiError && error.code === "GLOBAL_PAUSE_CONFIRMATION_REQUIRED") {
          setGlobalPauseConfirmation(true);
          return;
        }
        throw error;
      }
    });
  }
  return <><div className="row wrap">
    {pause && <Button onClick={() => open("pause")}><Pause size={15} />Pause job</Button>}
    {resume && <Button onClick={() => open("resume")}><Play size={15} />Resume job</Button>}
    {cancel && <Button variant="ghost" onClick={() => open("cancel")}><X size={15} />{job.state === "SCHEDULED" ? "Cancel scheduled job" : "Cancel job"}</Button>}
  </div><Confirm open={Boolean(control)}
    title={globalPauseConfirmation ? "Worker paused for new jobs. Resume this existing job?" : control === "cancel" ? "Cancel this job?" : control === "pause" ? "Pause this job?" : "Resume this job?"}
    description={globalPauseConfirmation ? `Resume only this already-running job. The worker remains paused for new jobs; this does not override schedule or security restrictions. ${pauseBudget}` : control ? descriptions[control] : ""}
    confirmText={globalPauseConfirmation ? "Resume existing job" : control === "cancel" ? "Cancel job" : control === "pause" ? "Request pause" : "Resume job"}
    danger={control === "cancel"} pending={action.pending} error={action.error}
    onClose={() => { setControl(null); setGlobalPauseConfirmation(false); }} onConfirm={() => void applyControl()} /></>;
}
export function JobList({ jobs, seller = false, refresh }: { jobs: JobDTO[]; seller?: boolean; refresh: () => void }) {
  return <div className="job-list"><div className="list-header"><span>Capability / job</span><span>Status</span><span>{seller ? "You earn" : "Price"}</span><span>Created</span><span /></div>{jobs.map(job => <article className="job-row" key={job.id}><div className="job-identity"><span className="job-icon"><BriefcaseBusiness size={18} /></span><div><Link href={`/jobs/${job.id}`} className="strong-link">{job.capabilityTitle}</Link><small>Seller at purchase: <JobSeller job={job} /></small><small className="mono">{job.id.slice(0,8)}<span className="not-mono">{job.scheduledAt && ` / ${dateTime(job.scheduledAt)}`}</span></small></div></div><div><Status value={job.state} /><small className="muted">{job.paymentState.toLowerCase()}</small></div><strong>{money(seller ? job.priceSnapshot.sellerNetMinor : job.priceSnapshot.buyerPriceMinor)}</strong><span className="muted small">{dateTime(job.createdAt)}</span><div className="job-row-actions">{seller && <JobControls job={job} seller refresh={refresh} />}<Link href={`/jobs/${job.id}`} className="icon-button" aria-label={`View ${job.capabilityTitle}`} title="View job"><ArrowRight size={17} /></Link></div></article>)}</div>;
}
export function Jobs({ seller = false }: { seller?: boolean }) { return <RequireAuth><JobsContent seller={seller} /></RequireAuth>; }
function JobsContent({ seller }: { seller: boolean }) {
  const resource = useResource<JobDTO[]>(seller ? "/seller/jobs" : "/jobs", 8000);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const jobs = (resource.data || []).filter(job => (filter === "all" || filter === "active" && !terminalStates.has(job.state) || filter === "completed" && job.state === "SUCCEEDED" || filter === "scheduled" && job.state === "SCHEDULED" || filter === "failed" && ["FAILED", "TIMED_OUT", "CANCELLED"].includes(job.state)) && `${job.capabilityTitle} ${job.id} ${job.sellerName || ""} ${job.sellerId}`.toLowerCase().includes(search.toLowerCase()));
  return <><PageHeading eyebrow={seller ? "Selling" : "Your workspace"} title={seller ? "Seller jobs" : "My jobs"} description="Track work, inspect results and pick up where you left off." actions={<Link href="/" className="button secondary">Browse capabilities<ArrowRight size={16} /></Link>} /><div className="section-toolbar"><div className="tabs">{["all", "active", "scheduled", "completed", "failed"].map(value => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === "failed" ? "Failed / cancelled" : value.charAt(0).toUpperCase() + value.slice(1)}</button>)}</div><label className="inline-search"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} aria-label="Search jobs" placeholder="Find a job" /></label></div><ErrorNotice error={resource.error} retry={resource.refresh} />{resource.loading ? <Loading text="Loading your jobs" /> : jobs.length ? <JobList jobs={jobs} seller={seller} refresh={resource.refresh} /> : !resource.error && <Empty icon={<BriefcaseBusiness size={27} />} title="No jobs to show" description={filter === "all" ? "Your purchased jobs and their results will appear here." : "No jobs match this view."} href="/" action="Find a capability" />}</>;
}
export function JobDetail({ id }: { id: string }) { return <RequireAuth><JobDetailContent id={id} /></RequireAuth>; }
function JobDetailContent({ id }: { id: string }) {
  const resource = useResource<JobDTO>(`/jobs/${encodeURIComponent(id)}`, 5000);
  const { user } = useApp();
  const job = resource.data;
  return <><Link className="back-link" href="/jobs"><ArrowLeft size={15} />My jobs</Link><ErrorNotice error={resource.error} retry={resource.refresh} />{resource.loading ? <Loading text="Loading job" /> : job && <>
    <PageHeading eyebrow={`Job ${job.id.slice(0,8)}`} title={job.capabilityTitle} actions={<><Link className="button secondary" href={`/capabilities/${job.capabilityId}`}><RefreshCw size={15} />Run again</Link><JobControls job={job} seller={user?.id === job.sellerId} refresh={resource.refresh} /></>} />
    <div className="job-state-bar"><Status value={job.state} /><span>{money(job.priceSnapshot.buyerPriceMinor)}</span><Status value={job.paymentState} /><span className="muted">Created {dateTime(job.createdAt)}</span></div>
    <JobWait job={job} />
    {job.state === "PAUSED" && <Notice tone="warning">Paused by the provider. Payment remains reserved while this job is paused.</Notice>}
    {job.state === "PAUSE_REQUESTED" && <Notice tone="warning">Pause requested. Waiting for the worker to confirm that execution is paused.</Notice>}
    {job.error && <Notice tone="danger">{job.error}</Notice>}
    {job.contentDeletedAt && <Notice tone="warning">Input and output content was deleted under the cloud retention policy on {dateTime(job.contentDeletedAt)}. Financial records and job metadata remain. This does not claim deletion of external-provider or downloaded copies.</Notice>}
    {job.pauseSupport && <p className="small muted">{pauseLabels[job.pauseSupport]}</p>}
    {(job.maxPauseMs !== undefined || (job.pauseSupport && job.pauseSupport !== "NOT_SUPPORTED")) && <JobPauseBudget job={job} />}
    {!job.contentDeletedAt && job.contentExpiresAt && <p className="small muted">Cloud job inputs and outputs expire {dateTime(job.contentExpiresAt)}. Financial and job metadata are retained separately.</p>}
    <div className="job-detail-layout"><div>
      <section className="page-section"><h2>Result</h2>{job.output ? <JobResult output={job.output} contract={job.outputContract} /> : <div className="pending-result"><File size={22} /><p>{job.contentDeletedAt ? "Result content is no longer retained." : terminalStates.has(job.state) ? "No result was delivered for this job." : "Results will appear after the provider completes your job and delivery is validated."}</p></div>}</section>
      <details className="page-section"><summary>Financial breakdown</summary><JobFinancialBreakdown breakdown={job.financialBreakdown} /></details>
      <details className="page-section"><summary>Submitted inputs</summary>{job.contentDeletedAt ? <p className="muted">Input content is no longer retained.</p> : <JobInputs input={job.input} contract={job.inputContract} />}</details>
      {job.buyerId === user?.id && job.sellerId !== user?.id && <JobReview key={`${job.id}:${job.state}:${job.paymentState}`} jobId={job.id} />}
      {(job.buyerId === user?.id || job.sellerId === user?.id) && <div className="page-section"><ReportButton target={{ jobId: job.id }} /></div>}
    </div><aside className="job-activity"><h2>Activity</h2><ol className="timeline">{job.events.map(event => <li key={event.id}><span className="timeline-dot" /><strong>{event.message || event.type.replaceAll("_", " ")}</strong><time dateTime={event.createdAt}>{dateTime(event.createdAt)}</time></li>)}</ol>{!job.events.length && <p className="muted">No events have been recorded yet.</p>}<dl className="metadata-list"><div><dt>Seller at purchase</dt><dd><JobSeller job={job} /></dd></div><div><dt>Purchased version</dt><dd>{job.capabilityVersionNumber && <span>Version {job.capabilityVersionNumber}<br /></span>}<span className="mono">{job.capabilityVersionId}</span></dd></div>{job.originalScheduledAt && <div><dt>Originally scheduled</dt><dd>{dateTime(job.originalScheduledAt)}</dd></div>}{job.eligibleAt && <div><dt>Became eligible</dt><dd>{dateTime(job.eligibleAt)}</dd></div>}{job.queuedAt && <div><dt>Entered queue</dt><dd>{dateTime(job.queuedAt)}</dd></div>}<div><dt>Started</dt><dd>{dateTime(job.startedAt)}</dd></div><div><dt>Completed</dt><dd>{dateTime(job.completedAt)}</dd></div><div><dt>Last update</dt><dd>{dateTime(job.updatedAt)}</dd></div></dl>{job.sellerId === user?.id && <dl className="metadata-list"><div><dt>Buyer price</dt><dd>{money(job.priceSnapshot.buyerPriceMinor)}</dd></div><div><dt>Marketplace fee</dt><dd>{money(job.priceSnapshot.platformFeeMinor)}</dd></div><div><dt>Seller proceeds</dt><dd>{money(job.priceSnapshot.sellerNetMinor)}</dd></div></dl>}</aside></div>
  </>}</>;
}
