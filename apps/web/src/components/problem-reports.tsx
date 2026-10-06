"use client";
import Link from "next/link";
import { useState } from "react";
import { Flag, RefreshCw } from "lucide-react";
import type { ProblemReport, ReportCategory, ReportStatus, ReportTarget } from "@/lib/types";
import { ApiError, post, put } from "@/lib/api";
import { dateTime, label } from "@/lib/format";
import { useAction, useResource } from "@/lib/hooks";
import { reportCategories, reportPayload, reportResolution, reportStatuses } from "@/lib/reports";
import { useApp } from "./provider";
import { Button, Dialog, Empty, ErrorNotice, Field, Loading, Notice, Status } from "./ui";

export function ReportButton({ target }: { target: ReportTarget }) {
  const { user, authenticate } = useApp();
  const [open, setOpen] = useState(false);
  return <><Button variant="ghost" onClick={() => { if (!user) authenticate(); else setOpen(true); }}><Flag size={14} />Report a problem</Button>
    {open && <ReportComposer target={target} close={() => setOpen(false)} />}</>;
}

function ReportComposer({ target, close }: { target: ReportTarget; close: () => void }) {
  const action = useAction();
  const [category, setCategory] = useState<ReportCategory>("OTHER");
  const [description, setDescription] = useState("");
  const [submitted, setSubmitted] = useState<ProblemReport>();
  return <Dialog open onClose={() => { if (!action.pending) close(); }} title="Report a problem">
    {submitted ? <div className="stack"><Notice tone="success">Report received. Reference {submitted.id}.</Notice><p>Status: {label(submitted.status)}. Updates and the operator&apos;s response appear in your account.</p><Link className="button secondary" href="/settings#reports" onClick={close}>View my reports</Link></div>
      : <form className="stack" onSubmit={event => { event.preventDefault(); void action.run(async () => setSubmitted(await post<ProblemReport>("/reports", reportPayload(target, category, description)))); }}>
        <p className="small muted">{target.jobId ? "Job" : "Capability"} <span className="mono">{target.jobId || target.capabilityId}</span></p>
        <Field label="Problem category"><select value={category} onChange={event => setCategory(event.target.value as ReportCategory)}>{reportCategories.map(value => <option key={value} value={value}>{label(value)}</option>)}</select></Field>
        <Field label="What happened?" hint="Describe the issue without including passwords, API keys or other secrets." required><textarea value={description} onChange={event => setDescription(event.target.value)} required minLength={10} maxLength={4000} rows={5} /></Field>
        <Notice>Submitting a report does not cancel work, issue a refund or change payment state.</Notice>
        <ErrorNotice error={action.error} /><Button variant="primary" type="submit" busy={action.pending} disabled={description.trim().length < 10}><Flag size={15} />Submit report</Button>
      </form>}
  </Dialog>;
}

function ReportDetails({ report, admin = false }: { report: ProblemReport; admin?: boolean }) {
  return <><div className="row between wrap"><div className="row wrap"><strong>{label(report.category)}</strong><Status value={report.status} /></div><time className="small muted">{dateTime(report.createdAt)}</time></div>
    <div className="row wrap report-reference"><span className="small mono">Reference {report.id}</span>{report.jobId ? <Link className="text-link" href={`/jobs/${report.jobId}`}>View job</Link> : report.capabilityId && <Link className="text-link" href={`/capabilities/${report.capabilityId}`}>View capability</Link>}</div>
    {admin && <p className="small muted mono">Reporter {report.reporterId} / Revision {report.revision}</p>}
    <p className="prewrap">{report.description}</p>
    {report.resolution && <div className="report-response"><h3>Operator response</h3><p className="prewrap">{report.resolution}</p><small className="muted">Updated {dateTime(report.updatedAt)}</small></div>}
  </>;
}

export function OwnReports() {
  const resource = useResource<ProblemReport[]>("/reports", 30000);
  return <section id="reports" className="settings-section"><div className="row between wrap"><h2>My problem reports</h2><Button variant="ghost" onClick={resource.refresh}><RefreshCw size={14} />Refresh reports</Button></div>
    <p>Your latest 100 reports and operator responses. Reports do not automatically change payments.</p>
    <ErrorNotice error={resource.error} retry={resource.refresh} />{resource.loading ? <Loading text="Loading your reports" /> : resource.data?.length ? resource.data.map(report => <article className="report-row" key={report.id}><ReportDetails report={report} /></article>) : !resource.error && <Empty title="No problem reports" description="Reports submitted from a job or capability will appear here." />}
  </section>;
}

export function AdminReports() {
  const [filter, setFilter] = useState<ReportStatus | "ALL">("OPEN");
  const resource = useResource<ProblemReport[]>(`/admin/reports${filter === "ALL" ? "" : `?status=${filter}`}`);
  const [selected, setSelected] = useState<ProblemReport>();
  return <section className="page-section"><div className="section-header"><h2>Problem report intake</h2><Button variant="ghost" onClick={resource.refresh}><RefreshCw size={14} />Refresh intake</Button></div>
    <div className="section-toolbar"><Field label="Report status"><select value={filter} onChange={event => setFilter(event.target.value as ReportStatus | "ALL")}><option value="ALL">All statuses</option>{reportStatuses.map(value => <option key={value} value={value}>{label(value)}</option>)}</select></Field><p className="small muted">Latest 200 matching reports. Responses are visible to the reporter.</p></div>
    <ErrorNotice error={resource.error} retry={resource.refresh} />{resource.loading ? <Loading text="Loading report intake" /> : resource.data?.length ? resource.data.map(report => <article className="report-row" key={report.id}><ReportDetails report={report} admin /><Button onClick={() => setSelected(report)}>Review report</Button></article>) : !resource.error && <p className="muted">No reports in this view.</p>}
    {selected && <ReportReview key={`${selected.id}:${selected.revision}`} report={selected} close={() => setSelected(undefined)} refresh={resource.refresh} />}
  </section>;
}

function ReportReview({ report, close, refresh }: { report: ProblemReport; close: () => void; refresh: () => void }) {
  const action = useAction();
  const [status, setStatus] = useState(report.status);
  const [resolution, setResolution] = useState(report.resolution || "");
  const [stale, setStale] = useState(false);
  return <Dialog open title="Review problem report" onClose={() => { if (!action.pending) close(); }}>
    <form className="stack" onSubmit={event => { event.preventDefault(); if (stale) return; void action.run(async () => {
      try { await put(`/admin/reports/${report.id}`, reportResolution(status, resolution, report.revision)); close(); refresh(); }
      catch (error) { if (error instanceof ApiError && error.code === "REPORT_CHANGED") setStale(true); throw error; }
    }); }}>
      <ReportDetails report={report} admin />
      <Field label="Updated status"><select value={status} disabled={stale || action.pending} onChange={event => setStatus(event.target.value as ReportStatus)}>{reportStatuses.map(value => <option key={value} value={value}>{label(value)}</option>)}</select></Field>
      <Field label="Response to reporter" required hint="This response is visible to the reporter, not an internal note."><textarea value={resolution} onChange={event => setResolution(event.target.value)} disabled={stale || action.pending} required minLength={10} maxLength={2000} rows={5} /></Field>
      <Notice>Changing report status has no automatic refund, cancellation or other financial effect.</Notice><ErrorNotice error={action.error} />
      {stale ? <><Notice tone="warning">Another operator changed this report. Your draft has not been submitted. Reload the intake before reviewing it again.</Notice><Button onClick={() => { close(); refresh(); }}>Discard draft & reload intake</Button></> : <Button type="submit" variant="primary" busy={action.pending} disabled={resolution.trim().length < 10}>Save report response</Button>}
    </form>
  </Dialog>;
}
