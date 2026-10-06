"use client";
import { SellerPayouts } from "./seller-payouts";
import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Blocks, CalendarClock, Copy, Monitor, Pause, Pencil, Play, Plus, RefreshCw, SlidersHorizontal, Unplug } from "lucide-react";
import { ScheduleSchema } from "@kivro/contracts";
import type { AuditEntry, Earnings, JobDTO, Schedule, SellerCapability, Worker } from "@/lib/types";
import { useAction, useResource } from "@/lib/hooks";
import { post, put } from "@/lib/api";
import { dateTime, label, money, terminalStates } from "@/lib/format";
import { RequireAuth, useApp } from "./provider";
import { Button, Confirm, Dialog, Empty, ErrorNotice, Field, IconButton, Loading, Metric, Notice, PageHeading, Status } from "./ui";
import { CategoryVisual } from "./marketplace";
import { JobList } from "./jobs";
import { ScheduleEditor } from "./schedule-editor";
import { WorkerHealthHistory } from "./worker-health-history";
import { workerStatus } from "@/lib/worker-health";
import { Operations, SellerEconomics } from "./operations";
import { PaymentPolicyDisclosure } from "./payment-disclosure";
import { CapacitySettings } from "./capacity-settings";
import { CapabilityHealth } from "./capability-health";

export function SellingOverview() { return <RequireAuth><Overview /></RequireAuth>; }
function Overview() {
  const workers = useResource<Worker[]>("/seller/workers", 10000);
  const jobs = useResource<JobDTO[]>("/seller/jobs", 8000);
  const capabilities = useResource<SellerCapability[]>("/seller/capabilities", 20000);
  const earnings = useResource<Earnings>("/seller/earnings", 20000);
  const active = jobs.data?.filter(job => !terminalStates.has(job.state) && job.state !== "SCHEDULED") || [];
  const scheduled = jobs.data?.filter(job => job.state === "SCHEDULED") || [];
  return <><PageHeading eyebrow="Selling" title="Your operations, at a glance." description="Capabilities, active work and the workers behind them." actions={<Link href="/selling/capabilities/new" className="button primary"><Plus size={16} />New capability</Link>} />
    <div className="worker-banner"><div className="row"><Monitor size={21} /><div><strong>{workers.data ? `${workers.data.filter(worker => !worker.revokedAt).length} paired workers` : "Worker overview"}</strong><p>{workers.data?.some(worker => worker.paused || worker.localPaused) ? "One or more workers are paused for new jobs." : "Check current telemetry before accepting new work."}</p></div></div><div className="row"><Link className="text-link" href="/selling/workers">Worker health<ArrowRight size={15} /></Link>{workers.data && <PauseAll workers={workers.data} jobs={scheduled} refresh={workers.refresh} />}</div></div><ErrorNotice error={workers.error} retry={workers.refresh} />
    <div className="metrics"><Metric label="Active jobs" value={jobs.data ? active.length : "-"} /><Metric label="Scheduled jobs" value={jobs.data ? scheduled.length : "-"} /><Metric label="Published capabilities" value={capabilities.data ? capabilities.data.filter(cap => cap.visibility !== "DRAFT").length : "-"} /><Metric label="Seller earnings" value={money(earnings.data?.earnedMinor)} detail="Settled proceeds" /></div><ErrorNotice error={earnings.error} retry={earnings.refresh} />
    <Operations />
    <div className="section-header"><h2>Active work</h2><Link className="text-link" href="/selling/jobs">All jobs<ArrowRight size={15} /></Link></div><ErrorNotice error={jobs.error} retry={jobs.refresh} />{jobs.loading ? <Loading text="Loading active jobs" /> : active.length ? <JobList jobs={active} seller refresh={jobs.refresh} /> : !jobs.error && <Empty title="No active jobs" description="Accepted and running jobs will appear here." />}
    {scheduled.length > 0 && <><div className="section-header"><h2>Scheduled demand</h2><span>{money(scheduled.reduce((sum, job) => sum + job.priceSnapshot.sellerNetMinor, 0))} potential proceeds</span></div><JobList jobs={scheduled} seller refresh={jobs.refresh} /></>}
    <div className="section-header"><h2>Your capabilities</h2><Link className="text-link" href="/selling/capabilities">Manage capabilities<ArrowRight size={15} /></Link></div><ErrorNotice error={capabilities.error} retry={capabilities.refresh} />{capabilities.loading ? <Loading text="Loading capabilities" /> : capabilities.data?.length ? <SellerCapabilityList capabilities={capabilities.data} refresh={capabilities.refresh} /> : !capabilities.error && <Empty icon={<Blocks size={26} />} title="No capabilities published" description="Define a service contract and connect a worker to start selling." href="/selling/capabilities/new" action="Create capability" />}
  </>;
}
function PauseAll({ workers, jobs = [], refresh }: { workers: Worker[]; jobs?: JobDTO[]; refresh: () => void }) {
  const action = useAction();
  const [open, setOpen] = useState(false);
  const available = workers.filter(worker => !worker.revokedAt);
  if (!available.length) return null;
  return <><Button onClick={() => { action.setError(undefined); setOpen(true); }}><Pause size={15} />Pause all new jobs</Button><Confirm open={open} title="Pause all new jobs?" description={`New and queued jobs will not start until you resume. Running jobs continue.${jobs.length ? ` ${jobs.length} scheduled jobs are waiting; prolonged pauses may release their reservations.` : ""}`} pending={action.pending} error={action.error} confirmText="Pause all new jobs" onClose={() => setOpen(false)} onConfirm={() => void action.run(async () => { const failures: string[] = []; for (const worker of available) { try { await post(`/seller/workers/${worker.id}/pause`); } catch { failures.push(worker.name); } } refresh(); if (failures.length) throw new Error(`Could not pause: ${failures.join(", ")}. Other workers were paused.`); setOpen(false); })} /></>;
}
export function SellerCapabilitiesPage() { return <RequireAuth><SellerCapabilities /></RequireAuth>; }
function SellerCapabilities() {
  const resource = useResource<SellerCapability[]>("/seller/capabilities", 20000);
  return <><PageHeading eyebrow="Selling" title="Capabilities" description="Manage your service contracts, versions and availability." actions={<Link className="button primary" href="/selling/capabilities/new"><Plus size={16} />New capability</Link>} /><ErrorNotice error={resource.error} retry={resource.refresh} />{resource.loading ? <Loading /> : resource.data?.length ? <SellerCapabilityList capabilities={resource.data} refresh={resource.refresh} /> : !resource.error && <Empty icon={<Blocks size={28} />} title="No capabilities yet" description="Create your first capability and prepare it for worker validation." href="/selling/capabilities/new" action="Create capability" />}</>;
}
function SellerCapabilityList({ capabilities, refresh }: { capabilities: SellerCapability[]; refresh: () => void }) {
  const { config } = useApp();
  const [scheduleCap, setScheduleCap] = useState<SellerCapability>();
  const [schedule, setSchedule] = useState<Schedule>();
  const [grantCap, setGrantCap] = useState<SellerCapability>();
  const [capacityCap, setCapacityCap] = useState<SellerCapability>();
  const [email, setEmail] = useState("");
  const [allowed, setAllowed] = useState(true);
  const [message, setMessage] = useState<string>();
  const action = useAction();
  return <><ErrorNotice error={action.error} />{message && <Notice tone="success">{message}</Notice>}{capabilities.map(cap => {
    const tier = config?.priceTiers.find(t => t.id === cap.priceTierId);
    return <article className="seller-cap-row" key={cap.id}><CategoryVisual category={cap.category} small /><div><Link className="strong-link" href={`/selling/capabilities/${cap.id}`}>{cap.title}</Link><small>{cap.category} / {label(cap.visibility)}</small></div><div><Status value={cap.availability.status} />{cap.availability.nextAvailableAt && <small>{dateTime(cap.availability.nextAvailableAt)}</small>}</div><div className="seller-price"><strong>{money(tier?.buyerPriceMinor)}</strong><small>Earn {money(tier?.sellerNetMinor)}</small></div><div className="seller-version">Version {cap.version}<small>{cap.testPassedAt ? "Validation passed" : "Validation required"}</small></div><div className="row wrap"><Link className="text-link" href={`/selling/capabilities/${cap.id}/versions`}>History</Link><Link href={`/selling/capabilities/${cap.id}`} className="icon-button" title="Edit capability" aria-label={`Edit ${cap.title}`}><Pencil size={16} /></Link><IconButton label={`Capacity ${cap.title}`} onClick={() => setCapacityCap(cap)}><SlidersHorizontal size={16} /></IconButton><IconButton label={`Schedule ${cap.title}`} onClick={() => { action.setError(undefined); setScheduleCap(cap); setSchedule(cap.schedule || { mode: "ALWAYS", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, windows: [], overrides: [] }); }}><CalendarClock size={16} /></IconButton><Button busy={action.pending} onClick={() => void action.run(async () => { await post(`/seller/capabilities/${cap.id}/pause`, { paused: !cap.paused }); refresh(); })}>{cap.paused ? <Play size={13} /> : <Pause size={13} />}{cap.paused ? "Resume" : "Pause"}</Button>{cap.visibility === "PRIVATE" && <Button onClick={() => { action.setError(undefined); setGrantCap(cap); }}>Access</Button>}</div></article>;
  })}
    {capacityCap && <CapacitySettings key={capacityCap.id} capability={capacityCap} onClose={() => setCapacityCap(undefined)} onSaved={() => { setMessage("Capacity settings updated. Existing jobs are unchanged."); refresh(); }} />}
    <Dialog open={Boolean(scheduleCap)} onClose={() => { if (!action.pending) setScheduleCap(undefined); }} title={`Availability / ${scheduleCap?.title || ""}`} wide>{schedule && <><ScheduleEditor value={schedule} onChange={setSchedule} /><ErrorNotice error={action.error} /><div className="dialog-actions"><Button variant="primary" busy={action.pending} onClick={() => void action.run(async () => { const parsed = ScheduleSchema.parse(schedule); await put(`/seller/capabilities/${scheduleCap!.id}/schedule`, parsed); setScheduleCap(undefined); refresh(); })}>Save schedule</Button></div></>}</Dialog>
    <Dialog open={Boolean(grantCap)} onClose={() => setGrantCap(undefined)} title="Private capability access"><form className="stack" onSubmit={event => { event.preventDefault(); void action.run(async () => { await post(`/seller/capabilities/${grantCap!.id}/grants`, { email, allowed }); setMessage(allowed ? "Buyer access granted." : "Buyer access removed."); setGrantCap(undefined); }); }}><Field label="Buyer email"><input type="email" value={email} onChange={event => setEmail(event.target.value)} required /></Field><Field label="Access"><select value={String(allowed)} onChange={event => setAllowed(event.target.value === "true")}><option value="true">Grant access</option><option value="false">Remove access</option></select></Field><ErrorNotice error={action.error} /><Button type="submit" variant="primary" busy={action.pending}>Update access</Button></form></Dialog>
  </>;
}
export function WorkersPage() { return <RequireAuth><Workers /></RequireAuth>; }
function Workers() {
  const resource = useResource<Worker[]>("/seller/workers", 8000);
  const caps = useResource<SellerCapability[]>("/seller/capabilities", 15000);
  const jobs = useResource<JobDTO[]>("/seller/jobs", 8000);
  const audit = useResource<AuditEntry[]>("/seller/audit", 30000);
  const [pair, setPair] = useState<{ code: string; expiresAt: string }>();
  const [control, setControl] = useState<{ worker: Worker; action: "pause" | "resume" | "revoke" }>();
  const [copied, setCopied] = useState(false);
  const action = useAction();
  return <><PageHeading eyebrow="Selling" title="Worker health" description="Readiness, connected devices and execution controls." actions={<><Button onClick={() => void action.run(async () => { setPair(await post("/seller/pairing-code")); setCopied(false); })} busy={action.pending}><Plus size={16} />Pair worker</Button>{resource.data && <PauseAll workers={resource.data} jobs={jobs.data?.filter(job => job.state === "SCHEDULED")} refresh={resource.refresh} />}</>} /><ErrorNotice error={resource.error} retry={resource.refresh} /><ErrorNotice error={action.error} />
    {resource.loading ? <Loading text="Reading worker telemetry" /> : resource.data?.length ? resource.data.map(worker => <article className="worker-item" key={worker.id}><div className="row between"><div className="row"><Monitor size={24} /><div><h2>{worker.name}</h2><small className="mono">{worker.id.slice(0,8)}</small></div></div><div className="row wrap"><Status value={workerStatus(worker)} text={workerStatus(worker) === "UNKNOWN" ? "Health not reported" : undefined} /><Button disabled={Boolean(worker.revokedAt)} onClick={() => { action.setError(undefined); setControl({ worker, action: worker.paused || worker.localPaused ? "resume" : "pause" }); }}>{worker.paused || worker.localPaused ? <Play size={15} /> : <Pause size={15} />}{worker.paused || worker.localPaused ? "Resume new jobs" : "Pause new jobs"}</Button><IconButton label={`Revoke ${worker.name}`} disabled={Boolean(worker.revokedAt)} onClick={() => { action.setError(undefined); setControl({ worker, action: "revoke" }); }}><Unplug size={16} /></IconButton></div></div><dl className="health-grid"><div><dt>Worker version</dt><dd>{worker.version || "Not reported"}</dd></div><div><dt>OpenClaw</dt><dd>{worker.openclawVersion || "Not reported"}</dd></div><div><dt>Sandbox, last report</dt><dd><Status value={worker.sandboxReady ? "HEALTHY" : "NOT_READY"} text={worker.sandboxReady ? "Ready" : "Not ready"} /></dd></div><div><dt>Last heartbeat</dt><dd>{dateTime(worker.lastSeenAt)}</dd></div><div><dt>Running jobs, last report</dt><dd>{worker.runningJobIds?.length ?? "Not reported"}</dd></div><div><dt>Local pause</dt><dd>{worker.localPaused ? "Acknowledged / paused" : "Not paused"}</dd></div></dl>{!worker.sandboxReady && !worker.revokedAt && <Notice tone="warning">Sandbox readiness has not passed. This worker must not receive paid work until its readiness checks succeed.</Notice>}{worker.paused && !worker.localPaused && <Notice>Cloud dispatch is paused. Local pause acknowledgement is pending.</Notice>}{worker.health && Object.keys(worker.health).length > 0 && <details className="health-detail"><summary>Reported health checks</summary><dl>{Object.entries(worker.health).filter(([, value]) => typeof value === "boolean" || typeof value === "number" || typeof value === "string").map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd>{typeof value === "boolean" ? value ? "Passed" : "Failed" : String(value)}</dd></div>)}</dl></details>}<WorkerHealthHistory worker={worker} /></article>) : !resource.error && <Empty icon={<Monitor size={29} />} title="No worker paired" description="Generate a pairing code and connect your local Kivro worker." />}
    <Operations />
    <section className="page-section" aria-label="Capability readiness"><div className="section-header"><h2>Capability readiness</h2><div className="row wrap"><Button onClick={caps.refresh} disabled={caps.loading}><RefreshCw size={14} />Refresh capability health</Button><Link href="/selling/capabilities" className="text-link">Manage<ArrowRight size={14} /></Link></div></div><ErrorNotice error={caps.error} retry={caps.refresh} />{caps.loading ? <Loading text="Reading capability health" rows={0} /> : caps.data?.length ? caps.data.map(cap => <CapabilityHealth key={cap.id} capability={cap} />) : !caps.error && <p className="small muted">No capabilities to inspect.</p>}</section>
    <div className="section-header"><h2>Running jobs</h2></div><ErrorNotice error={jobs.error} retry={jobs.refresh} />{jobs.data && <JobList jobs={jobs.data.filter(job => ["ACCEPTED", "RUNNING", "PAUSE_REQUESTED", "PAUSED", "RESUMING"].includes(job.state))} seller refresh={jobs.refresh} />}
    <div className="section-header"><h2>Recent operational events</h2><Button variant="ghost" onClick={audit.refresh}><RefreshCw size={13} />Refresh</Button></div><ErrorNotice error={audit.error} retry={audit.refresh} />{audit.data?.length ? audit.data.slice(0,30).map(event => <div className="audit-row" key={event.id}><span>{event.message || label(event.type || event.action || "Event")}</span><time>{dateTime(event.createdAt)}</time></div>) : !audit.loading && !audit.error && <p className="muted">No operational events recorded.</p>}
    <Dialog open={Boolean(pair)} onClose={() => setPair(undefined)} title="Pair a local worker">{pair && <div className="stack"><p className="small muted">Enter this one-time code in your local Kivro worker.</p><div className="pairing-code">{pair.code}</div><Button onClick={() => void action.run(async () => { await navigator.clipboard.writeText(pair.code); setCopied(true); })}><Copy size={15} />{copied ? "Copied" : "Copy pairing code"}</Button><small className="muted">Expires {dateTime(pair.expiresAt)}.</small><Notice>This authorizes a device to receive your marketplace work. Only pair a computer you control.</Notice></div>}</Dialog>
    <Confirm open={Boolean(control)} title={control ? `${label(control.action)} ${control.worker.name}?` : "Worker control"} description={control?.action === "revoke" ? "Revoke this device identity permanently. Its active jobs will fail and its pending reservations will be released by the platform. Re-pairing is required to use the device again." : control?.action === "pause" ? "Stop accepting new and queued work. Existing running jobs continue. Scheduled jobs may expire if the worker stays paused." : "Request that this worker resume receiving jobs after health and security checks. Readiness is confirmed by the worker."} confirmText={control ? `${label(control.action)} worker` : "Confirm"} danger={control?.action === "revoke"} error={action.error} pending={action.pending} onClose={() => setControl(undefined)} onConfirm={() => void action.run(async () => { await post(`/seller/workers/${control!.worker.id}/${control!.action}`); setControl(undefined); resource.refresh(); jobs.refresh(); audit.refresh(); })} />
  </>;
}
export function EarningsPage() { return <RequireAuth><EarningsContent /></RequireAuth>; }
function EarningsContent() {
  const { config } = useApp();
  const earnings = useResource<Earnings>("/seller/earnings", 15000);
  const jobs = useResource<JobDTO[]>("/seller/jobs", 15000);
  const action = useAction();
  async function onboard() {
    await action.run(async () => { const result = await post<{ url: string }>("/seller/billing/onboard"); const url = new URL(result.url); if (url.protocol !== "https:") throw new Error("Invalid onboarding link."); window.location.assign(url.href); });
  }
  return <><PageHeading eyebrow="Selling" title="Earnings" description="Exact tier proceeds and the jobs behind your balance." actions={<Button onClick={() => void onboard()} busy={action.pending}>Payout onboarding<ArrowRight size={15} /></Button>} />
    <ErrorNotice error={action.error} /><ErrorNotice error={earnings.error} retry={earnings.refresh} />
    {earnings.loading ? <Loading text="Loading earnings" /> : earnings.data && <>
      <div className="metrics three"><Metric label="Gross marketplace sales" value={money(earnings.data.grossSalesMinor)} /><Metric label="Marketplace fees" value={money(earnings.data.platformFeesMinor)} /><Metric label="Your earnings" value={money(earnings.data.earnedMinor)} detail="Before your external operating costs" /></div>
      <div className="metrics three"><Metric label="Pending proceeds" value={money(earnings.data.pendingMinor)} detail={`${earnings.data.pendingJobs} reserved jobs`} /><Metric label="Settled jobs" value={earnings.data.settledJobs} /><Metric label="Payout account" value={label(earnings.data.connectStatus)} detail={earnings.data.payoutsEnabled ? "Payouts enabled" : "Payouts not enabled"} /></div>
    </>}
    <PaymentPolicyDisclosure policy={config?.paymentPolicy} />
    <SellerEconomics />
    {earnings.data && <>
      <div className="section-header"><h2>Marketplace transfers</h2><strong>{money(earnings.data.transferredMinor)} transferred</strong></div><p className="small muted">Settled funds transferred to your connected account, not bank payouts.</p>
      {earnings.data.transfers.length ? earnings.data.transfers.map(transfer => <div className="integration-row" key={transfer.id}><div><Link className="strong-link" href={`/jobs/${transfer.jobId}`}>Job {transfer.jobId.slice(0,8)}</Link><small>{dateTime(transfer.createdAt)}</small></div><Status value={transfer.status || transfer.state || "PENDING"} /><strong>{money(transfer.amountMinor)}</strong></div>) : <Empty title="No transfers yet" description="Transfers to your payout account will appear here after settlement." />}
    </>}
    {earnings.data && <SellerPayouts earnings={earnings.data} refresh={earnings.refresh} />}
    <div className="section-header"><h2>Job settlement details</h2></div><ErrorNotice error={jobs.error} retry={jobs.refresh} />{jobs.data && <JobList jobs={jobs.data.filter(job => job.paymentState === "SETTLED" || job.paymentState === "REFUNDED")} seller refresh={jobs.refresh} />}
  </>;
}
