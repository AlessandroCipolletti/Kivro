"use client";
import Link from "next/link";
import { useState } from "react";
import { Archive, ArrowLeft, ArrowRight, CheckCircle2, History, Pencil, Play, RefreshCw } from "lucide-react";
import type { CapabilityVersionDetail, CapabilityVersionDiff, CapabilityVersionHistory, CapabilityVersionSummary } from "@/lib/types";
import { api, post } from "@/lib/api";
import { useAction, useResource } from "@/lib/hooks";
import { dateTime, label, money } from "@/lib/format";
import { activationBlockers, versionActionError } from "@/lib/versions";
import { RequireAuth, useApp } from "./provider";
import { Button, Dialog, Empty, ErrorNotice, Field, Loading, Notice, PageHeading, Status } from "./ui";
import { Permissions } from "./permissions";
import { VersionChanges } from "./version-diff";
import { SellerExamples } from "./seller-examples";

export function CapabilityVersions({ id }: { id: string }) { return <RequireAuth><Versions id={id} /></RequireAuth>; }

function Versions({ id }: { id: string }) {
  const { config } = useApp();
  const path = `/seller/capabilities/${encodeURIComponent(id)}/versions`;
  const history = useResource<CapabilityVersionHistory>(path);
  const [selectedId, setSelectedId] = useState<string>();
  const [compareId, setCompareId] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [control, setControl] = useState<"activate" | "retire" | "testing" | "visibility">();
  const [reason, setReason] = useState("");
  const [reviewedHash, setReviewedHash] = useState<string>();
  const [deactivate, setDeactivate] = useState(false);
  const [visibility, setVisibility] = useState<CapabilityVersionHistory["visibility"]>("PRIVATE");
  const action = useAction(), more = useAction();
  const current = history.data;
  const versionId = selectedId || current?.currentVersionId || current?.draftVersionId || current?.versions[0]?.id;
  const detail = useResource<CapabilityVersionDetail>(versionId ? `${path}/${versionId}` : null);
  const comparison = useResource<CapabilityVersionDiff>(versionId ? `${path}/${versionId}/diff${compareId ? `?fromVersionId=${encodeURIComponent(compareId)}` : ""}` : null);
  const activeDiff = useResource<CapabilityVersionDiff>(control === "activate" && versionId ? `${path}/${versionId}/diff` : null);
  const selected = current?.versions.find(version => version.id === versionId);
  const blockers = selected && current ? activationBlockers(selected, current, activeDiff.data) : [];

  function open(actionName: typeof control) {
    setControl(actionName); setReason(""); setReviewedHash(undefined); setDeactivate(false); setVisibility(current?.visibility || "PRIVATE"); action.setError(undefined);
  }
  async function mutate() {
    if (!current || !selected) return;
    try {
      let result: CapabilityVersionHistory;
      if (control === "visibility") result = await post(`/seller/capabilities/${id}/visibility`, { expectedRevision: current.lifecycleRevision, visibility });
      else if (control === "activate") {
        if (blockers.length || !activeDiff.data || reviewedHash !== activeDiff.data.diffHash) throw new Error("Review the current diff and resolve readiness blockers before activation.");
        result = await post(`${path}/${selected.id}/activate`, { expectedRevision: current.lifecycleRevision, reason: reason.trim(), reviewedDiffHash: reviewedHash });
      } else if (control === "retire") result = await post(`${path}/${selected.id}/retire`, { expectedRevision: current.lifecycleRevision, reason: reason.trim(), ...(selected.isActive && deactivate ? { deactivate: true } : {}) });
      else result = await post(`${path}/${selected.id}/testing`, { expectedRevision: current.lifecycleRevision });
      history.setData(result); detail.refresh(); comparison.refresh(); setControl(undefined);
      setMessage(control === "activate" ? `Version ${selected.version} is active for new jobs.` : control === "retire" ? `Version ${selected.version} retired. Existing jobs retain their purchased version.` : control === "testing" ? "Validation state reset. A new worker self-test is required." : `Visibility changed to ${visibility.toLowerCase()}.`);
    } catch (error) { throw versionActionError(error); }
  }
  function selectVersion(version: CapabilityVersionSummary) { setSelectedId(version.id); setCompareId(undefined); setMessage(undefined); setReviewedHash(undefined); }

  return <><Link className="back-link" href="/selling/capabilities"><ArrowLeft size={15} />Capabilities</Link>
    <PageHeading eyebrow="Selling / Immutable definitions" title="Capability versions" description={detail.data?.title} actions={<><Button onClick={() => { history.refresh(); detail.refresh(); comparison.refresh(); activeDiff.refresh(); setReviewedHash(undefined); }}><RefreshCw size={15} />Refresh</Button><Link className="button secondary" href={`/selling/capabilities/${id}`}><Pencil size={15} />Edit draft</Link></>} />
    {message && <Notice tone="success">{message}</Notice>}<ErrorNotice error={history.error} retry={history.refresh} />
    {history.loading ? <Loading text="Loading version history" /> : current && <>
      <div className="section-toolbar"><div className="row wrap"><Status value={current.visibility} /><span className="small muted">Lifecycle revision {current.lifecycleRevision}</span></div><Button disabled={!selected} onClick={() => open("visibility")}>Change visibility</Button></div>
      {!current.versions.length ? <Empty icon={<History size={24} />} title="No versions" /> : <div className="version-layout"><nav aria-label="Capability version history" className="version-list">{current.versions.map(version => <button key={version.id} aria-pressed={versionId === version.id} onClick={() => selectVersion(version)}><div className="row between"><strong>Version {version.version}</strong>{version.isActive && <span className="small">Active</span>}</div><Status value={version.state} /><small>{dateTime(version.createdAt)}</small></button>)}{current.nextCursor && <Button busy={more.pending} onClick={() => void more.run(async () => { const next = await api<CapabilityVersionHistory>(`${path}?cursor=${encodeURIComponent(current.nextCursor!)}`); if (next.lifecycleRevision !== current.lifecycleRevision) { history.refresh(); throw new Error("The history changed. Review the refreshed version list."); } history.setData({ ...next, versions: [...current.versions, ...next.versions.filter(version => !current.versions.some(item => item.id === version.id))] }); })}>Older versions<ArrowRight size={14} /></Button>}<ErrorNotice error={more.error} /></nav>
      <div className="version-detail"><ErrorNotice error={detail.error} retry={detail.refresh} />{detail.loading ? <Loading text="Loading immutable definition" rows={2} /> : detail.data && selected && <>
        <div className="section-header"><h2>Version {detail.data.version}</h2><div className="row wrap"><Status value={detail.data.state} />{selected.isActive && <Status value="ONLINE" text="Active version" />}</div></div>
        <dl className="health-grid"><div><dt>Version ID</dt><dd className="mono">{detail.data.id}</dd></div><div><dt>Published</dt><dd>{dateTime(detail.data.publishedAt)}</dd></div><div><dt>Buyer price</dt><dd>{money(config?.priceTiers.find(tier => tier.id === detail.data!.priceTierId)?.buyerPriceMinor)}</dd></div><div><dt>Manifest SHA-256</dt><dd className="mono">{detail.data.manifestHash}</dd></div></dl>
        {selected.readiness.ready ? <Notice tone="success"><CheckCircle2 size={16} />Current worker validation passed for this exact version.</Notice> : <Notice tone="warning"><strong>Not ready for new activation</strong><ul>{selected.readiness.reasons.map(reason => <li key={reason}>{label(reason)}</li>)}</ul></Notice>}
        <div className="row wrap"><Button disabled={selected.isActive || selected.state !== "PUBLISHED" || !selected.readiness.ready} onClick={() => open("activate")}><Play size={15} />Make version {selected.version} active</Button>{!["PUBLISHED", "RETIRED"].includes(selected.state) && <Button onClick={() => open("testing")}><RefreshCw size={15} />Start new validation</Button>}<Button disabled={selected.state === "RETIRED"} onClick={() => open("retire")}><Archive size={15} />Retire version</Button></div>
        <section className="page-section"><h3>Compare frozen definitions</h3><Field label="Compare with"><select value={compareId || ""} onChange={event => setCompareId(event.target.value || undefined)}><option value="">Current active version</option>{current.versions.filter(version => version.id !== versionId).map(version => <option key={version.id} value={version.id}>Version {version.version} / {label(version.state)}</option>)}</select></Field><ErrorNotice error={comparison.error} retry={comparison.refresh} />{comparison.loading ? <Loading text="Calculating version changes" rows={0} /> : comparison.data && <VersionChanges diff={comparison.data} fromLabel={comparison.data.fromVersionId ? `Version ${current.versions.find(version => version.id === comparison.data!.fromVersionId)?.version || comparison.data.fromVersionId.slice(0,8)}` : "Initial definition"} toLabel={`Version ${selected.version}`} />}</section>
        <SellerExamples key={`${detail.data.id}:${current.lifecycleRevision}`} version={detail.data} revision={current.lifecycleRevision} onChanged={result => { if (result) { history.setData(result); setSelectedId(result.draftVersionId || versionId); setCompareId(undefined); setMessage("Example saved in a new unpublished draft. Fresh validation and explicit publication are required."); } else { history.refresh(); setMessage("Public file access revoked. Review affected examples before further publication."); } detail.refresh(); comparison.refresh(); }} />
        <details className="page-section"><summary>Complete frozen definition</summary><Permissions permissions={detail.data.permissions} /><dl className="metadata-list"><div><dt>Title</dt><dd>{detail.data.title}</dd></div><div><dt>Summary</dt><dd>{detail.data.summary}</dd></div><div><dt>Category</dt><dd>{detail.data.category}</dd></div></dl>{[{ title: "Input and output contract", value: detail.data.ioContract }, { title: "Dependencies and provenance", value: detail.data.dependencies }, { title: "Permission manifest", value: detail.data.permissions }, { title: "Private execution instructions", value: detail.data.internalInstructions }, { title: "Examples", value: detail.data.examples }].map(section => <details key={section.title}><summary>{section.title}</summary><pre>{typeof section.value === "string" ? section.value : JSON.stringify(section.value, null, 2)}</pre></details>)}</details>
      </>}</div></div>}
    </>}
    <Dialog open={Boolean(control)} onClose={() => { if (!action.pending) setControl(undefined); }} title={control === "activate" ? `Activate version ${selected?.version}?` : control === "retire" ? `Retire version ${selected?.version}?` : control === "testing" ? "Start new validation?" : "Change capability visibility"} wide={control === "activate"}>
      {current && selected && <form className="stack" onSubmit={event => { event.preventDefault(); void action.run(mutate); }}>
        {control === "activate" && <><Notice>Only new jobs use the newly active version. Existing jobs retain their purchased version. Activation requires fresh readiness for this exact manifest.</Notice><ErrorNotice error={activeDiff.error} retry={activeDiff.refresh} />{activeDiff.loading ? <Loading text="Loading activation diff" rows={0} /> : activeDiff.data && <VersionChanges diff={activeDiff.data} toLabel={`Version ${selected.version}`} />}{blockers.length > 0 && <Notice tone="warning"><ul>{blockers.map(reason => <li key={reason}>{label(reason)}</li>)}</ul></Notice>}<label className="checkbox-row align-start"><input type="checkbox" checked={Boolean(activeDiff.data && reviewedHash === activeDiff.data.diffHash)} onChange={event => setReviewedHash(event.target.checked ? activeDiff.data?.diffHash : undefined)} disabled={!activeDiff.data || activeDiff.loading} /><span>I reviewed this version&apos;s full permission, contract and price changes.</span></label></>}
        {control === "retire" && <><Notice tone="warning">Retirement prevents this version from becoming active again. Existing and queued jobs keep their original version and are not cancelled.</Notice>{selected.isActive && <label className="checkbox-row align-start"><input type="checkbox" checked={deactivate} onChange={event => setDeactivate(event.target.checked)} required /><span>Deactivate this capability and change its visibility to DRAFT, stopping new purchases.</span></label>}</>}
        {(control === "activate" || control === "retire") && <Field label="Reason"><textarea value={reason} onChange={event => setReason(event.target.value)} required minLength={3} maxLength={1000} /></Field>}
        {control === "testing" && <Notice tone="warning">Previous validation will be invalidated. This records a pending test; it does not execute the worker self-test or certify readiness.</Notice>}
        {control === "visibility" && <><Field label="Capability visibility"><select value={visibility} onChange={event => setVisibility(event.target.value as typeof visibility)}><option value="DRAFT">Draft / seller only</option><option value="PRIVATE">Private / approved accounts</option><option value="UNLISTED">Unlisted / direct link</option><option value="PUBLIC">Public / marketplace</option></select></Field><Notice>Visibility changes apply to discovery and new purchases. Existing jobs and their history remain unchanged. Increased exposure requires fresh publication checks.</Notice></>}
        <ErrorNotice error={action.error} /><div className="dialog-actions"><Button onClick={() => setControl(undefined)} disabled={action.pending}>Cancel</Button><Button type="submit" variant={control === "retire" ? "danger" : "primary"} busy={action.pending} disabled={control === "activate" && (blockers.length > 0 || activeDiff.loading || reviewedHash !== activeDiff.data?.diffHash) || control === "retire" && selected.isActive && !deactivate}>{control === "activate" ? "Activate reviewed version" : control === "retire" ? "Retire version" : control === "testing" ? "Start new validation" : "Update visibility"}</Button></div>
      </form>}
    </Dialog>
  </>;
}
