"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import type { AgentPlan, AgentSynthesis, SynthesisPreview } from "@/lib/types";
import { ApiError, post } from "@/lib/api";
import { useAction, useResource } from "@/lib/hooks";
import { bytes, dateTime } from "@/lib/format";
import { Button, ErrorNotice, Loading, Notice } from "./ui";

export function SynthesisResult({ result }: { result: AgentSynthesis }) {
  return <section className="page-section synthesis-result"><h3>Marketplace agent synthesis</h3><p className="small muted">Separate from the original paid provider outputs. Generated {dateTime(result.createdAt)} using {result.provider.provider} / {result.provider.model}.</p><p className="prewrap">{result.message}</p><details><summary>Sources & processing consent</summary>{result.sources.map(source => <div className="audit-row" key={source.jobId}><div><Link href={`/jobs/${source.jobId}`} className="text-link">Original provider output<ArrowUpRight size={14} /></Link><p className="small mono">Version: {source.capabilityVersionId}</p><p className="small mono">Output SHA-256: {source.outputHash}</p></div></div>)}<p className="small">Authorized {dateTime(result.consent.acceptedAt)} for {result.consent.processingDestinations.map(item => `${item.provider} / ${item.model}`).join(", ")}. File contents were not processed.</p><p className="small mono">Reviewed sources: {result.consent.sourceManifestHash}</p></details></section>;
}

export function SynthesisControls({ plan, onResult }: { plan: AgentPlan; onResult: (value: AgentSynthesis) => void }) {
  const [open, setOpen] = useState(false), [consent, setConsent] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const preview = useResource<SynthesisPreview>(open ? `/agent/plans/${plan.id}/synthesis-preview` : null);
  const action = useAction();
  useEffect(() => { setConsent(false); setSelected([]); }, [preview.data?.sourceManifestHash, preview.data?.revision, plan.revision]);
  if (plan.status !== "COMPLETED") return null;
  return <section className="page-section"><div className="section-header"><h3>Combine completed results</h3><Button onClick={() => { setConsent(false); setSelected([]); if (open) preview.refresh(); else setOpen(true); }} disabled={action.pending}><RefreshCw size={15} />{open ? "Refresh source review" : "Review synthesis sources"}</Button></div>
    {open && <div className="stack"><ErrorNotice error={preview.error} retry={preview.refresh} />{preview.loading ? <Loading text="Loading source and provider disclosure" rows={0} /> : preview.data && <>
      <Notice>Selected job text, JSON, named fields, file metadata and this plan&apos;s goal will be processed by the providers listed below. File contents are not sent. No jobs are purchased by this action.</Notice>
      <dl className="metadata-list"><div><dt>Goal</dt><dd>{plan.goal}</dd></div><div><dt>Processing providers</dt><dd>{preview.data.processingDestinations.length ? preview.data.processingDestinations.map(item => `${item.provider} / ${item.model}`).join(", ") : "No synthesis provider configured"}</dd></div><div><dt>Maximum source content</dt><dd>{bytes(preview.data.maxContentBytes)}</dd></div></dl>
      {!preview.data.available && <Notice tone="warning">Synthesis is unavailable for the current provider configuration.</Notice>}
      <fieldset className="choice-list"><legend className="field-label">Results to share for synthesis</legend>{preview.data.sources.map(source => <div className="synthesis-source" key={source.jobId}><label className="checkbox-row align-start"><input type="checkbox" checked={selected.includes(source.jobId)} onChange={event => { setConsent(false); setSelected(event.target.checked ? [...selected, source.jobId] : selected.filter(id => id !== source.jobId)); }} /><span>Job {source.jobId.slice(0,8)}<small className="field-hint">{[source.hasText && "Text", source.hasJson && "JSON", ...source.fieldKeys, source.assets.length > 0 && `${source.assets.length} file metadata records`].filter(Boolean).join(" / ") || "No text fields"}</small></span></label><Link href={`/jobs/${source.jobId}`} target="_blank" className="text-link">Inspect original result<ArrowUpRight size={14} /></Link><details><summary>Source provenance</summary><p className="small mono">Purchased version: {source.capabilityVersionId}</p><p className="small mono">Output SHA-256: {source.outputHash}</p>{source.assets.map(asset => <p className="small" key={asset.id}>{asset.filename} / {asset.mimeType} / {bytes(asset.sizeBytes)}</p>)}</details></div>)}</fieldset>
      <label className="checkbox-row align-start"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={!selected.length || !preview.data.available} /><span>I authorize the selected results and plan goal to be processed by the listed providers for this synthesis.</span></label><ErrorNotice error={action.error} />
      <Button variant="primary" disabled={!consent || !selected.length || !preview.data.available || preview.data.revision !== plan.revision} busy={action.pending} onClick={() => void action.run(async () => {
        const reviewed = preview.data!; setConsent(false);
        try { const result = await post<AgentSynthesis>(`/agent/plans/${plan.id}/synthesize`, { expectedRevision: reviewed.revision, sourceManifestHash: reviewed.sourceManifestHash, sourceJobIds: selected, consentToProviderProcessing: true }); onResult(result); setOpen(false); }
        catch (error) { if (error instanceof ApiError && error.code === "SYNTHESIS_CONSENT_STALE") { setSelected([]); preview.refresh(); throw new Error("The sources or processing providers changed. Review the refreshed disclosure and give consent again."); } throw error; }
      })}>Create agent synthesis</Button>
    </>}</div>}
  </section>;
}
