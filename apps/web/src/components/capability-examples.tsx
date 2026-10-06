"use client";
import { useState } from "react";
import { ArrowRight, Copy } from "lucide-react";
import type { AssetDTO, CapabilityDTO, CapabilityExampleDTO, IOContract } from "@kivro/contracts";
import { ApiError, post } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { bytes, dateTime } from "@/lib/format";
import { isVisible } from "@/lib/forms";
import { exampleAssetUrl, exampleFileIds, exampleOutput, exampleTemplateValues, type ExampleTemplate } from "@/lib/examples";
import type { AssetUrlResolver } from "@/lib/results";
import { useApp } from "./provider";
import { Button, Dialog, Empty, ErrorNotice, Notice } from "./ui";
import { JobResult, ResultAsset } from "./job-result";

export function ExampleInputs({ contract, input, assets, resolveUrl }: { contract: IOContract; input: Record<string, unknown>; assets: AssetDTO[]; resolveUrl: AssetUrlResolver }) {
  return <dl className="example-input">{[...contract.inputs].sort((a,b) => a.order - b.order).filter(field => isVisible(field, input, contract.inputs)).map(field => {
    const value = input[field.key], ids = exampleFileIds([field], input);
    return <div key={field.key}><dt>{field.label}</dt><dd>{["FILE", "FILES"].includes(field.type) ? ids.length ? ids.map(id => {
      const asset = assets.find(item => item.id === id);
      return asset ? <ResultAsset key={id} asset={asset} resolveUrl={resolveUrl} /> : <p key={id} className="field-error">Example file unavailable.</p>;
    }) : "Not supplied" : value === undefined ? "Not supplied" : typeof value === "boolean" ? value ? "Yes" : "No" : typeof value === "object" ? <pre>{JSON.stringify(value, null, 2)}</pre> : String(value)}</dd></div>;
  })}</dl>;
}

export function ExampleDisplay({ capabilityId, example, contract }: { capabilityId: string; example: CapabilityExampleDTO; contract: IOContract }) {
  const resolveUrl: AssetUrlResolver = asset => exampleAssetUrl(capabilityId, example.id, asset);
  return <>
    <h3>{example.title}</h3><p className="small muted">{example.source === "REAL_EXECUTION" ? "Successful seller test execution" : "Seller-curated example"}</p>
    {example.description && <p className="prewrap">{example.description}</p>}
    {example.provenance && <details><summary>Execution provenance</summary><dl className="metadata-list"><div><dt>Version</dt><dd className="mono">{example.provenance.capabilityVersionId}</dd></div><div><dt>Manifest SHA-256</dt><dd className="mono">{example.provenance.manifestHash}</dd></div><div><dt>Completed</dt><dd>{dateTime(example.provenance.completedAt)}</dd></div></dl></details>}
    <details open><summary>Example inputs</summary><ExampleInputs contract={contract} input={example.input} assets={example.inputAssets || []} resolveUrl={resolveUrl} /></details>
    <details><summary>Example result</summary><JobResult output={exampleOutput(example, contract)} contract={contract.output} resolveUrl={resolveUrl} /></details>
  </>;
}

export function CapabilityExamples({ capability, onTemplate, reload }: { capability: CapabilityDTO; onTemplate: (template: ExampleTemplate) => void; reload: () => void }) {
  const [selected, setSelected] = useState<CapabilityExampleDTO>();
  return <>{capability.examples.length ? <><p className="muted">Examples show representative outputs. Actual results depend on your inputs; required deliverables remain part of the output contract.</p>{[...capability.examples].sort((a,b) => (a.order || 0) - (b.order || 0)).map(example => <article key={example.id} className="example"><ExampleDisplay capabilityId={capability.id} example={example} contract={capability.ioContract} /><Button onClick={() => setSelected(example)}><Copy size={15} />Use as template<ArrowRight size={15} /></Button></article>)}</> : <Empty title="No examples published" description="Review the input and output contract before submitting a job." />}
    {selected && <TemplateDialog key={`${capability.versionId}:${selected.id}`} capability={capability} example={selected} onClose={() => setSelected(undefined)} onTemplate={template => { onTemplate(template); setSelected(undefined); }} reload={reload} />}
  </>;
}

function TemplateDialog({ capability: cap, example, onClose, onTemplate, reload }: { capability: CapabilityDTO; example: CapabilityExampleDTO; onClose: () => void; onTemplate: (template: ExampleTemplate) => void; reload: () => void }) {
  const { user, authenticate } = useApp();
  const action = useAction();
  const [selected, setSelected] = useState<string[]>([]), [consent, setConsent] = useState(false), [stale, setStale] = useState(false);
  const reusable = (example.inputAssets || []).filter(asset => asset.reusableTemplate && exampleAssetUrl(cap.id, example.id, asset));
  return <Dialog open title="Use example as a template" onClose={() => { if (!action.pending) onClose(); }}><form className="stack" onSubmit={event => {
    event.preventDefault(); if (!user) { onClose(); authenticate(); return; }
    void action.run(async () => {
      if (stale || selected.length && !consent) return;
      try {
        const result = await post<ExampleTemplate>(`/capabilities/${cap.id}/examples/${encodeURIComponent(example.id)}/template`, { capabilityVersionId: cap.versionId, ...(selected.length ? { assetIds: selected, confirmCopy: true } : {}) });
        exampleTemplateValues(cap.ioContract, result, cap.id, cap.versionId); onTemplate(result);
      } catch (error) { if (error instanceof ApiError && ["EXAMPLE_VERSION_CHANGED", "EXAMPLE_ASSET_UNAVAILABLE", "NOT_FOUND"].includes(error.code)) setStale(true); throw error; }
    });
  }}><Notice>This replaces your current form inputs. It does not create a job, reserve credits or authorize a purchase. All inputs remain editable.</Notice>
    <p><strong>{example.title}</strong> / version {cap.version}</p>
    {reusable.length ? <fieldset className="choice-list"><legend>Optional reusable input files</legend>{reusable.map(asset => <label className="checkbox-row align-start" key={asset.id}><input type="checkbox" checked={selected.includes(asset.id)} disabled={action.pending || stale} onChange={event => { setSelected(event.target.checked ? [...selected, asset.id] : selected.filter(id => id !== asset.id)); setConsent(false); }} /><span>{asset.filename}<small className="field-hint">{asset.mimeType} / {bytes(asset.sizeBytes)}</small></span></label>)}</fieldset> : <p className="small muted">No reusable files are available. Only scalar values will be copied; upload your own required files.</p>}
    {selected.length > 0 && <label className="checkbox-row align-start"><input type="checkbox" checked={consent} disabled={action.pending || stale} onChange={event => setConsent(event.target.checked)} /><span>I approve copying the selected example files into my account as new uploads, subject to their displayed expiration.</span></label>}
    <ErrorNotice error={action.error} />{stale && <Button onClick={() => { onClose(); reload(); }}>Reload current examples</Button>}
    <div className="dialog-actions"><Button disabled={action.pending} onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={action.pending} disabled={stale || selected.length > 0 && !consent}>{user ? selected.length ? "Copy selected files & apply" : "Apply scalar values" : "Sign in to use template"}</Button></div>
  </form></Dialog>;
}
