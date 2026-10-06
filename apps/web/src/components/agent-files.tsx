"use client";
import React from "react";
import { Plus, X } from "lucide-react";
import type { AssetDTO, CapabilityDTO, IOContract } from "../lib/types";
import type { AgentContractMatch, OutputFileDraft, RequiredOutputFile } from "../lib/agent-files";
import { contractIssueText } from "../lib/agent-files";
import { MAX_DIRECT_UPLOAD_BYTES } from "../lib/uploads";
import { ContractForm } from "./contract-form";
import { Button, Field, IconButton, Notice } from "./ui";

const attachmentsContract: IOContract = { schemaVersion: 1, inputs: [{ key: "attachments", label: "Attach input files", type: "FILES", required: false, order: 0, constraints: { maxFiles: 20, maxFileSizeBytes: MAX_DIRECT_UPLOAD_BYTES } }], output: { type: "TEXT", description: "", required: false } };

export function AgentFileFields({ ids, assets, outputs, onIds, onAssets, onOutputs, onBusy, disabled }: {
  ids: string[]; assets: AssetDTO[]; outputs: OutputFileDraft[]; onIds: (ids: string[]) => void; onAssets: (assets: AssetDTO[]) => void;
  onOutputs: (outputs: OutputFileDraft[]) => void; onBusy: (busy: boolean) => void; disabled?: boolean;
}) {
  return <details className="agent-file-fields"><summary>Files & required deliverables ({ids.length} attached)</summary><div className="stack">
    <ContractForm contract={attachmentsContract} values={{ attachments: ids }} assets={assets} onAssets={onAssets} onChange={values => onIds(Array.isArray(values.attachments) ? values.attachments as string[] : [])} onBusy={onBusy} disabled={disabled} />
    <p className="small muted">Attached files are selected for this request only. Matching uses verified file metadata; execution requires a separate purchase or plan approval.</p>
    <h3>Required output files</h3>
    {outputs.map((row, index) => <div className="agent-output-row" key={row.id}>
      <Field label={`Extension ${index + 1}`}><input value={row.extension} disabled={disabled} maxLength={40} placeholder=".pdf" onChange={event => onOutputs(outputs.map(item => item.id === row.id ? { ...item, extension: event.target.value } : item))} /></Field>
      <Field label={`MIME type ${index + 1}`}><input value={row.mimeType} disabled={disabled} maxLength={150} placeholder="application/pdf" onChange={event => onOutputs(outputs.map(item => item.id === row.id ? { ...item, mimeType: event.target.value } : item))} /></Field>
      <Field label={`File count ${index + 1}`}><input type="number" min={1} max={20} step={1} required value={row.count} disabled={disabled} onChange={event => onOutputs(outputs.map(item => item.id === row.id ? { ...item, count: event.target.value } : item))} /></Field>
      <IconButton label={`Remove output format ${index + 1}`} disabled={disabled} onClick={() => onOutputs(outputs.filter(item => item.id !== row.id))}><X size={16} /></IconButton>
    </div>)}
    <div><Button disabled={disabled || outputs.length >= 20} onClick={() => onOutputs([...outputs, { id: crypto.randomUUID(), extension: "", mimeType: "", count: "1" }])}><Plus size={15} />Add output format</Button></div>
  </div></details>;
}

export function AgentFileHistory({ ids, outputs }: { ids?: string[]; outputs?: RequiredOutputFile[] }) {
  if (!ids?.length && !outputs?.length) return null;
  return <div className="small muted agent-file-history">{Boolean(ids?.length) && <p>{ids!.length} input file{ids!.length === 1 ? "" : "s"} selected for this recorded request. Not attached to the next request.</p>}{outputs?.length ? <ul>{outputs.map((file, index) => <li key={index}>{file.count} required output file{file.count === 1 ? "" : "s"}: {[file.extension, file.mimeType].filter(Boolean).join(" / ")}</li>)}</ul> : null}</div>;
}

export function AgentContractPreparation({ match, capability }: { match: AgentContractMatch; capability: CapabilityDTO }) {
  const current = match.capabilityId === capability.id && match.capabilityVersionId === capability.versionId;
  const fieldLabel = (key: string) => current ? capability.ioContract.inputs.find(field => field.key === key)?.label || key : key;
  const issues = [...match.issues, ...match.output.issues].filter((issue, index, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(issue)) === index);
  return <section className="agent-contract-preparation" aria-label={`Contract compatibility for ${capability.title}`}>
    <h3>Input & output compatibility</h3>
    {!current && <Notice tone="warning">This matching record belongs to an earlier version. Check the current service contract before continuing.</Notice>}
    <p className="small"><strong>{match.status === "READY" ? "Inputs prepared" : match.status === "NEEDS_INPUT" ? "More input required" : "Incompatible inputs"}</strong>. {match.output.compatible ? match.output.guaranteed ? "Requested output requirements match the contract." : "Output compatibility is not a delivery guarantee." : "Requested output is incompatible."}</p>
    {issues.length > 0 && <ul className="small">{issues.map((issue, index) => <li key={index}>{issue.inputKey && <strong>{fieldLabel(issue.inputKey)}: </strong>}{issue.requirementIndex !== undefined && `Output format ${issue.requirementIndex + 1}: `}{contractIssueText(issue)}</li>)}</ul>}
    {match.appliedDefaults.length > 0 && <p className="small">Seller defaults applied: {match.appliedDefaults.map(fieldLabel).join(", ")}</p>}
    {match.assetOptions.some(option => option.inputKeys.length > 1) && <p className="small">Possible file inputs: {[...new Set(match.assetOptions.flatMap(option => option.inputKeys))].map(fieldLabel).join(", ")}</p>}
    {Object.keys(match.preparedInput).length > 0 && <details><summary>Prepared input values</summary><pre>{JSON.stringify(match.preparedInput, null, 2)}</pre></details>}
    <p className="small muted">{match.status === "READY" ? "Review these values against the current service form before purchase." : "Complete the required fields in the service form before purchase."} No job or payment has been authorized by this match.</p>
  </section>;
}
