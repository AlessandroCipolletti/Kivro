"use client";
import { useState } from "react";
import { Copy, FlaskConical, Plus, ShieldOff } from "lucide-react";
import type { AssetDTO, JobOutput } from "@kivro/contracts";
import type { CapabilityVersionDetail, CapabilityVersionHistory, JobDTO } from "@/lib/types";
import { api, post } from "@/lib/api";
import { useAction, useResource } from "@/lib/hooks";
import { bytes, dateTime, label } from "@/lib/format";
import { initialInput, prepareInput } from "@/lib/forms";
import { exampleOutputFields, exampleOutputFiles, prepareExampleOutput, publicationAssets, publicationConsent, type ExampleJobPreview, type ExamplePublicationAsset } from "@/lib/examples";
import { jobAssetUrl } from "@/lib/results";
import { useApp } from "./provider";
import { Button, Dialog, ErrorNotice, Field, Loading, Notice } from "./ui";
import { ContractForm } from "./contract-form";
import { ExampleDisplay, ExampleInputs } from "./capability-examples";
import { JobResult } from "./job-result";

type ReviewedExample = { input: Record<string, unknown>; outputValue: JobOutput; assets: ExamplePublicationAsset[]; jobId?: string };
export function SellerExamples({ version, revision, onChanged }: { version: CapabilityVersionDetail; revision: number; onChanged: (history?: CapabilityVersionHistory) => void }) {
  const [promotion, setPromotion] = useState<{ mode: "curated" | "job"; replaceId?: string }>();
  const [revoke, setRevoke] = useState<AssetDTO>();
  const [reason, setReason] = useState("");
  const action = useAction();
  return <section className="page-section seller-examples" aria-label="Version examples"><div className="section-header"><h3>Examples ({version.examples.length}/3)</h3><div className="row wrap"><Button disabled={version.examples.length >= 3} onClick={() => setPromotion({ mode: "curated" })}><Plus size={15} />Create curated example</Button><Button disabled={version.examples.length >= 3} onClick={() => setPromotion({ mode: "job" })}><FlaskConical size={15} />Use successful test job</Button></div></div>
    <p className="small muted">Two representative examples are recommended for public listings unless content is sensitive or impractical. Rerun examples after meaningful model, tool or runtime changes.</p>
    <Notice>Adding or replacing an example creates a new unpublished draft. The active listing stays unchanged until that draft passes validation and is explicitly published. Only the current published version can serve public example files.</Notice>
    {version.exampleIssues.length > 0 && <Notice tone="warning"><ul>{version.exampleIssues.map((issue, index) => <li key={`${issue.id}:${issue.code}:${index}`}>{version.examples.find(example => example.id === issue.id)?.title || "Examples"}: {label(issue.code)}</li>)}</ul></Notice>}
    {version.examples.map(example => <article className="example" key={example.id}><ExampleDisplay capabilityId={version.capabilityId} example={example} contract={version.ioContract} /><div className="row wrap"><Button onClick={() => setPromotion({ mode: "curated", replaceId: example.id })}><Copy size={15} />Replace example</Button><Button onClick={() => setPromotion({ mode: "job", replaceId: example.id })}><FlaskConical size={15} />Replace from test job</Button></div>{[...new Map([...(example.inputAssets || []), ...(example.outputAssets || [])].map(asset => [asset.id, asset])).values()].map(asset => <div className="audit-row" key={asset.id}><span>{asset.filename}</span><Button variant="ghost" onClick={() => { setRevoke(asset); setReason(""); action.setError(undefined); }}><ShieldOff size={15} />Revoke public file</Button></div>)}</article>)}
    {promotion && <PromotionDialog key={`${version.id}:${revision}:${promotion.mode}:${promotion.replaceId || "new"}`} version={version} revision={revision} {...promotion} onClose={() => setPromotion(undefined)} onCreated={history => { setPromotion(undefined); onChanged(history); }} />}
    <Dialog open={Boolean(revoke)} title="Revoke example file?" onClose={() => { if (!action.pending) setRevoke(undefined); }}><form className="stack" onSubmit={event => { event.preventDefault(); void action.run(async () => { await post(`/seller/capabilities/${version.capabilityId}/example-assets/${revoke!.id}/revoke`, { expectedRevision: revision, reason: reason.trim() }); setRevoke(undefined); onChanged(); }); }}><Notice tone="warning">Public access is denied immediately, including versions referencing this copy. Storage cleanup follows separately. This cannot retract downloaded files or copies already owned by buyers. Affected examples must be replaced or removed before publication.</Notice><p>{revoke?.filename}</p><Field label="Revocation reason"><textarea value={reason} onChange={event => setReason(event.target.value)} minLength={3} maxLength={1000} required /></Field><ErrorNotice error={action.error} /><div className="dialog-actions"><Button onClick={() => setRevoke(undefined)} disabled={action.pending}>Cancel</Button><Button type="submit" variant="danger" busy={action.pending} disabled={reason.trim().length < 3}>Revoke public file</Button></div></form></Dialog>
  </section>;
}

function PromotionDialog({ version, revision, mode, replaceId, onClose, onCreated }: { version: CapabilityVersionDetail; revision: number; mode: "curated" | "job"; replaceId?: string; onClose: () => void; onCreated: (history: CapabilityVersionHistory) => void }) {
  const { user } = useApp();
  const contract = version.ioContract, namedContract = exampleOutputFields(contract), filesContract = exampleOutputFiles(contract);
  const jobs = useResource<JobDTO[]>(mode === "job" ? "/seller/jobs" : null);
  const [title, setTitle] = useState(""), [description, setDescription] = useState("");
  const [input, setInput] = useState(() => initialInput(contract)), [fields, setFields] = useState(() => initialInput(namedContract)), [attachments, setAttachments] = useState<Record<string, unknown>>({});
  const [text, setText] = useState(""), [json, setJson] = useState("");
  const [assets, setAssets] = useState<AssetDTO[]>([]), [busy, setBusy] = useState<Record<string, boolean>>({});
  const [jobId, setJobId] = useState(""), [preview, setPreview] = useState<ExampleJobPreview>();
  const [reviewed, setReviewed] = useState<ReviewedExample>();
  const [approved, setApproved] = useState<string[]>([]), [reusable, setReusable] = useState<string[]>([]), [confirmed, setConfirmed] = useState(false);
  const action = useAction();
  const uploading = Object.values(busy).some(Boolean);
  const sourcePath = `/seller/capabilities/${version.capabilityId}/versions/${version.id}/examples`;
  const candidates = jobs.data?.filter(job => job.capabilityId === version.capabilityId && job.buyerId === user?.id && job.sellerId === user?.id && job.state === "SUCCEEDED" && job.paymentState === "SETTLED" && !job.contentDeletedAt) || [];
  const addAssets = (next: AssetDTO[]) => setAssets(current => [...new Map([...current, ...next].map(asset => [asset.id, asset])).values()]);
  function review() {
    if (!title.trim()) throw new Error("Enter an example title.");
    let value: ReviewedExample;
    if (mode === "job") {
      if (!preview || preview.jobId !== jobId || preview.targetVersionId !== version.id) throw new Error("Load and review an eligible completed self-owned job first.");
      value = { input: preview.input, outputValue: preview.outputValue, jobId, assets: publicationAssets(contract, preview.input, preview.outputValue, [...preview.inputAssets, ...preview.outputAssets]) };
    } else {
      const prepared = prepareInput(contract, input, assets), outputValue = prepareExampleOutput(contract, text, json, fields, attachments, assets);
      value = { input: prepared, outputValue, assets: publicationAssets(contract, prepared, outputValue, assets) };
    }
    setApproved([]); setReusable([]); setConfirmed(false); setReviewed(value);
  }
  return <Dialog open wide title={reviewed ? "Approve example publication" : mode === "job" ? "Example from a successful test" : "Create a curated example"} onClose={() => { if (!action.pending && !uploading) onClose(); }}><form className="stack" onSubmit={event => {
    event.preventDefault(); void action.run(async () => {
      if (uploading) return;
      if (!reviewed) { review(); return; }
      const consent = publicationConsent(reviewed.assets, approved, reusable, confirmed);
      const result = await post<CapabilityVersionHistory>(`${sourcePath}${reviewed.jobId ? "/from-job" : ""}`, { expectedRevision: revision, title: title.trim(), ...(description ? { description } : {}), ...(replaceId ? { replaceExampleId: replaceId } : {}), ...consent, ...(reviewed.jobId ? { jobId: reviewed.jobId } : { input: reviewed.input, outputValue: reviewed.outputValue }) });
      onCreated(result);
    });
  }}>
    {!reviewed ? <>
      <Field label="Example title"><input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required /></Field><Field label="Example description (optional)"><textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={2000} /></Field>
      {mode === "job" ? <><Notice>Only successful, settled jobs you own as both buyer and seller are eligible. Their manifest must match this version and their content must still be retained. No customer job is eligible.</Notice><ErrorNotice error={jobs.error} retry={jobs.refresh} />{jobs.loading ? <Loading rows={0} text="Loading seller tests" /> : <Field label="Completed self-owned test"><select value={jobId} onChange={event => { setJobId(event.target.value); setPreview(undefined); }}><option value="">Choose a test job</option>{candidates.map(job => <option key={job.id} value={job.id}>{dateTime(job.completedAt || job.createdAt)} / {job.id}</option>)}</select></Field>}<Field label="Test job ID"><input value={jobId} onChange={event => { setJobId(event.target.value); setPreview(undefined); }} placeholder="Exact self-owned job ID" /></Field><Button disabled={!jobId} busy={action.pending} onClick={() => void action.run(async () => { const result = await api<ExampleJobPreview>(`${sourcePath}/from-job/${encodeURIComponent(jobId)}`); if (result.jobId !== jobId || result.targetVersionId !== version.id) throw new Error("The test preview belongs to another job or version."); setPreview(result); })}>Load test preview</Button>{preview && <div className="page-section"><ExampleInputs contract={contract} input={preview.input} assets={preview.inputAssets} resolveUrl={jobAssetUrl} /><JobResult output={preview.outputValue} contract={contract.output} /><Notice tone="success">Eligible self-owned test loaded. Public file permissions have not been granted.</Notice></div>}</> : <>
        <section className="page-section"><h3>Example inputs</h3><ContractForm contract={contract} values={input} onChange={setInput} assets={assets} onAssets={addAssets} onBusy={value => setBusy(current => ({ ...current, input: value }))} disabled={action.pending} /></section>
        <section className="page-section"><h3>Example output</h3>{["TEXT", "MIXED"].includes(contract.output.type) && <Field label="Output text"><textarea value={text} onChange={event => setText(event.target.value)} rows={5} required={contract.output.required} /></Field>}{contract.output.jsonSchema && <Field label="Output JSON"><textarea className="code-input" value={json} onChange={event => setJson(event.target.value)} rows={6} required={contract.output.type === "JSON" && contract.output.required} /></Field>}{namedContract.inputs.length > 0 && <ContractForm contract={namedContract} values={fields} onChange={setFields} assets={assets} onAssets={addAssets} onBusy={value => setBusy(current => ({ ...current, fields: value }))} disabled={action.pending} />}{filesContract.inputs.length > 0 && <ContractForm contract={filesContract} values={attachments} onChange={setAttachments} assets={assets} onAssets={addAssets} onBusy={value => setBusy(current => ({ ...current, output: value }))} disabled={action.pending} />}</section>
      </>}
    </> : <>
      <h3>{title}</h3><p>{description}</p><ExampleInputs contract={contract} input={reviewed.input} assets={reviewed.assets.map(item => item.asset)} resolveUrl={jobAssetUrl} /><JobResult output={reviewed.outputValue} contract={contract.output} />
      <Notice tone="warning">The following content will be copied into this capability&apos;s example store. Publishing the new version can expose it to buyers under that capability&apos;s visibility. Never include secrets or customer data.</Notice>
      {reviewed.assets.map(({ asset, input: isInput, output }) => <fieldset key={asset.id} className="example-file-consent"><legend>{asset.filename}</legend><p className="small muted">{isInput && "Input"}{isInput && output && " and "}{output && "Output"} / {asset.mimeType} / {bytes(asset.sizeBytes)}</p><p className="small mono">SHA-256: {asset.sha256}</p><label className="checkbox-row align-start"><input type="checkbox" checked={approved.includes(asset.id)} disabled={action.pending} onChange={event => { setApproved(event.target.checked ? [...approved, asset.id] : approved.filter(id => id !== asset.id)); setConfirmed(false); if (!event.target.checked) setReusable(reusable.filter(id => id !== asset.id)); }} /><span>Approve public example copy of {asset.filename}</span></label>{isInput && <label className="checkbox-row align-start"><input type="checkbox" checked={reusable.includes(asset.id)} disabled={action.pending || !approved.includes(asset.id)} onChange={event => { setReusable(event.target.checked ? [...reusable, asset.id] : reusable.filter(id => id !== asset.id)); setConfirmed(false); }} /><span>Allow buyers to copy {asset.filename} as a reusable input template</span></label>}</fieldset>)}
      <label className="checkbox-row align-start"><input type="checkbox" checked={confirmed} disabled={action.pending} onChange={event => setConfirmed(event.target.checked)} /><span>I own or have the rights to publish all shown content and approve these exact public copies and reuse permissions.</span></label>
    </>}
    <ErrorNotice error={action.error} /><div className="dialog-actions">{reviewed && <Button disabled={action.pending} onClick={() => { setReviewed(undefined); setApproved([]); setReusable([]); setConfirmed(false); action.setError(undefined); }}>Edit content</Button>}<Button onClick={onClose} disabled={action.pending || uploading}>Cancel</Button><Button type="submit" variant="primary" busy={action.pending} disabled={uploading || Boolean(reviewed && (!confirmed || approved.length !== reviewed.assets.length))}>{reviewed ? "Create reviewed draft" : "Review public content"}</Button></div>
  </form></Dialog>;
}
