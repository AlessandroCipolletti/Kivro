"use client";
import { useState } from "react";
import { Pause, Play, RefreshCw, ShieldCheck } from "lucide-react";
import type { AdminOverview, JobDTO } from "@/lib/types";
import { useAction, useResource } from "@/lib/hooks";
import { api, clearPurchaseKey, post, purchaseKey } from "@/lib/api";
import { money } from "@/lib/format";
import { RequireAuth } from "./provider";
import { Button, Confirm, ErrorNotice, Field, Loading, Metric, Notice, PageHeading, Status } from "./ui";
import { AdminSecurity } from "./admin-security";
import { AdminReports } from "./problem-reports";
import { Operations } from "./operations";

export function AdminPage() { return <RequireAuth admin><Admin /></RequireAuth>; }
function Admin() {
  const overview = useResource<AdminOverview>("/admin/overview", 15000);
  const action = useAction();
  const [confirm, setConfirm] = useState<"dispatch" | "suspend" | "refund" | null>(null);
  const [userId, setUserId] = useState("");
  const [suspended, setSuspended] = useState(true);
  const [accountReason, setAccountReason] = useState("");
  const [jobId, setJobId] = useState("");
  const [reason, setReason] = useState("");
  const [inspectId, setInspectId] = useState<string>();
  const [message, setMessage] = useState<string>();
  const job = useResource<JobDTO>(inspectId ? `/jobs/${encodeURIComponent(inspectId)}` : null);
  return <><PageHeading eyebrow="Platform operations" title="Administration" description="Dispatch control, account access and payment remedies." actions={<Button onClick={overview.refresh}><RefreshCw size={15} />Refresh</Button>} />{message && <Notice tone="success">{message}</Notice>}<ErrorNotice error={overview.error} retry={overview.refresh} />{overview.loading ? <Loading text="Loading platform status" /> : overview.data && <><div className="worker-banner"><div className="row"><ShieldCheck size={23} /><div><h2>Marketplace dispatch</h2><p>{overview.data.dispatchEnabled ? "The platform may assign eligible jobs to workers." : "New dispatch is disabled across the marketplace."}</p></div></div><Button variant={overview.data.dispatchEnabled ? "secondary" : "primary"} onClick={() => { action.setError(undefined); setConfirm("dispatch"); }}>{overview.data.dispatchEnabled ? <Pause size={15} /> : <Play size={15} />}{overview.data.dispatchEnabled ? "Pause dispatch" : "Enable dispatch"}</Button></div><div className="metrics"><Metric label="Accounts" value={overview.data.users} /><Metric label="Capabilities" value={overview.data.capabilities} /><Metric label="Total jobs" value={overview.data.jobs} /><Metric label="Active jobs" value={overview.data.activeJobs} /></div><p className="muted small">Net platform fees: {money(overview.data.platformFeeMinor)}</p></>}
    <div className="operational-grid"><section className="page-section"><h2>Account access</h2><form className="stack" onSubmit={event => { event.preventDefault(); action.setError(undefined); setConfirm("suspend"); }}><Field label="Account ID"><input value={userId} onChange={event => setUserId(event.target.value)} required pattern="[0-9a-fA-F-]{36}" placeholder="UUID" /></Field><Field label="Action"><select value={String(suspended)} onChange={event => setSuspended(event.target.value === "true")}><option value="true">Suspend account</option><option value="false">Restore account</option></select></Field>{!suspended && <Field label="Reason for restoration"><textarea value={accountReason} onChange={event => setAccountReason(event.target.value)} required minLength={10} maxLength={1000} /></Field>}<Button type="submit" disabled={!suspended && accountReason.trim().length < 10}>Review account action</Button></form></section><section className="page-section"><h2>Job payment</h2><form className="stack" onSubmit={event => { event.preventDefault(); setInspectId(jobId); }}><Field label="Job ID"><input value={jobId} onChange={event => setJobId(event.target.value)} required pattern="[0-9a-fA-F-]{36}" placeholder="UUID" /></Field><Button type="submit">Inspect job</Button></form><ErrorNotice error={job.error} retry={job.refresh} />{job.loading && <Loading text="Looking up job" rows={0} />}{job.data && <div className="stack page-section"><strong>{job.data.capabilityTitle}</strong><div className="row"><Status value={job.data.state} /><Status value={job.data.paymentState} /><span>{money(job.data.priceSnapshot.buyerPriceMinor)}</span></div><Field label="Reason for refund"><textarea value={reason} onChange={event => setReason(event.target.value)} minLength={3} maxLength={500} /></Field><Button variant="danger" disabled={reason.trim().length < 3 || ["REFUNDED", "RELEASED"].includes(job.data.paymentState)} onClick={() => { action.setError(undefined); setConfirm("refund"); }}>Review refund</Button></div>}</section></div>
    <AdminSecurity />
    <Operations admin />
    <AdminReports />
    <Confirm open={Boolean(confirm)} title={confirm === "dispatch" ? overview.data?.dispatchEnabled ? "Pause platform dispatch?" : "Enable platform dispatch?" : confirm === "suspend" ? suspended ? "Suspend account?" : "Restore account?" : "Refund this job?"} description={confirm === "dispatch" ? "This affects assignment of new jobs across the entire marketplace. Already running jobs continue." : confirm === "suspend" ? suspended ? `Suspend ${userId}, invalidate sessions and API keys, and cancel reserved jobs involving this account.` : `Restore access for ${userId}. Reason: ${accountReason.trim()} Revoked sessions and API keys remain revoked.` : `Refund or release ${money(job.data?.priceSnapshot.buyerPriceMinor)} for job ${job.data?.id}. Reason: ${reason}`} danger={confirm !== "dispatch" || Boolean(overview.data?.dispatchEnabled)} pending={action.pending} error={action.error} onClose={() => setConfirm(null)} onConfirm={() => void action.run(async () => {
      if (confirm === "dispatch") { await post("/admin/dispatch", { enabled: !overview.data!.dispatchEnabled }); setMessage("Platform dispatch updated."); }
      if (confirm === "suspend") {
        const path = `/admin/users/${encodeURIComponent(userId)}`;
        if (suspended) { await post(`${path}/suspend`, { suspended: true }); setMessage("Account suspended."); }
        else {
          const scope = `admin:restore:${userId}`, payload = { reason: accountReason.trim() };
          await post(`${path}/restore`, payload, purchaseKey(scope, payload));
          const review = await api<{ user: { suspendedAt: string | null } }>(`${path}/billing-review`);
          clearPurchaseKey(scope);
          setMessage(review.user.suspendedAt ? "Restoration recorded; a current account hold remains." : "Account restored.");
          setAccountReason("");
        }
      }
      if (confirm === "refund") { await post(`/admin/jobs/${job.data!.id}/refund`, { reason }); setMessage("Job payment remedy applied."); job.refresh(); }
      setConfirm(null); overview.refresh();
    })} />
  </>;
}
