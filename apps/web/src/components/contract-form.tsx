"use client";
import React, { useEffect, useId, useRef, useState } from "react";
import { File, Upload, X } from "lucide-react";
import type { AssetDTO, CapabilityDTO, InputField, IOContract } from "@/lib/types";
import { effectiveInputField } from "../lib/file-limits";
import { bytes, label } from "../lib/format";
import { checkFiles, isFileField, isVisible } from "../lib/forms";
import { Button, ErrorNotice, IconButton } from "./ui";
import { finalizeUpload, stageUpload } from "../lib/uploads";

function FileInput({ field, value, assets, onChange, onAssets, onBusy, selectLocalFiles, disabled, inputId, describedBy, validationError }: { field: InputField; value: unknown; assets: AssetDTO[]; onChange: (value: unknown) => void; onAssets: (assets: AssetDTO[]) => void; onBusy?: (busy: boolean) => void; selectLocalFiles?: (files: globalThis.File[]) => Promise<AssetDTO[]>; disabled?: boolean; inputId: string; describedBy: string; validationError?: string }) {
  const [error, setError] = useState<string>();
  const [phase, setPhase] = useState<string>();
  const [pendingFinalize, setPendingFinalize] = useState<{ id: string; name: string }>();
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const refs = Array.isArray(value) ? value : value ? [value] : [];
  const selected = assets.filter(asset => refs.includes(asset.id));
  const uploadErrorId = `${inputId}-upload-error`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); onBusy?.(false); }; }, []);
  async function upload(files: globalThis.File[]) {
    if (disabled || phase || pendingFinalize || !files.length) return;
    setError(undefined);
    try {
      checkFiles(field, files, selected);
      setPhase("Preparing files"); onBusy?.(true);
      if (selectLocalFiles) {
        const added = await selectLocalFiles(files);
        if (!mounted.current) return;
        checkFiles(field, added.map(asset => ({ name: asset.filename, type: asset.mimeType, size: asset.sizeBytes })), selected);
        onAssets(added); onChange(field.type === "FILE" ? added[0]?.id : [...refs, ...added.map(asset => asset.id)]);
        return;
      }
      const controller = new AbortController(); request.current = controller;
      const added: AssetDTO[] = [];
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const intent = await stageUpload(file, controller.signal, value => { if (mounted.current) setPhase(`${value} (${index + 1}/${files.length})`); });
        if (!mounted.current) return;
        setPendingFinalize({ id: intent.id, name: file.name }); setPhase("Verifying stored file");
        const asset = await finalizeUpload(intent.id);
        checkFiles(field, [{ name: asset.filename, type: asset.mimeType, size: asset.sizeBytes }], [...selected, ...added]);
        added.push(asset);
        if (mounted.current) { setPendingFinalize(undefined); onAssets([asset]); onChange(field.type === "FILE" ? asset.id : [...refs, ...added.map(item => item.id)]); }
      }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "Upload failed."); }
    finally { if (mounted.current) { setPhase(undefined); onBusy?.(false); } request.current = null; }
  }
  async function retryFinalize() {
    if (!pendingFinalize || phase) return;
    setError(undefined); setPhase("Verifying stored file"); onBusy?.(true);
    try { const asset = await finalizeUpload(pendingFinalize.id); checkFiles(field, [{ name: asset.filename, type: asset.mimeType, size: asset.sizeBytes }], selected); if (mounted.current) { onAssets([asset]); onChange(field.type === "FILE" ? asset.id : [...refs, asset.id]); setPendingFinalize(undefined); } }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "File verification failed."); }
    finally { if (mounted.current) { setPhase(undefined); onBusy?.(false); } }
  }
  return <div className="file-field">
    <label className={`upload-area ${disabled ? "disabled" : ""}`} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void upload(Array.from(event.dataTransfer.files)); }}>
      <Upload size={21} /><span>{phase || "Choose files or drop them here"}</span><small>{field.constraints?.allowedExtensions?.join(", ")}{field.constraints?.maxFileSizeBytes ? ` / ${bytes(field.constraints.maxFileSizeBytes)} per file` : ""}</small>
      <input id={inputId} name={field.key} aria-describedby={error ? `${describedBy} ${uploadErrorId}` : describedBy} aria-invalid={Boolean(error || validationError)} aria-required={field.required} type="file" accept={[...(field.constraints?.allowedExtensions || []), ...(field.constraints?.allowedMimeTypes || [])].join(",")} multiple={field.type === "FILES"} disabled={disabled || Boolean(phase) || Boolean(pendingFinalize)} onChange={event => { void upload(Array.from(event.target.files || [])); event.target.value = ""; }} />
    </label>
    {phase && <p className="small muted" role="status">{phase}</p>}
    {pendingFinalize && !phase && <div className="stack"><p className="small">{pendingFinalize.name} reached storage but is not ready for use. Retry verification before submitting it. Any remaining files must be selected again.</p><div className="row wrap"><Button disabled={disabled} onClick={() => void retryFinalize()}>Retry file verification</Button><Button disabled={disabled} variant="ghost" onClick={() => { setPendingFinalize(undefined); setError(undefined); }}>Discard pending file</Button></div></div>}
    {selected.map(asset => <div className="file-row" key={asset.id}><File size={17} /><div><strong>{asset.filename}</strong><small>{bytes(asset.sizeBytes)}</small></div><IconButton label={`Remove ${asset.filename}`} disabled={disabled || Boolean(phase)} onClick={() => onChange(field.type === "FILE" ? undefined : refs.filter(id => id !== asset.id))}><X size={15} /></IconButton></div>)}
    {error && <div id={uploadErrorId}><ErrorNotice error={error} /></div>}
  </div>;
}
export function ContractForm({ contract, values, onChange, errors = {}, assets = [], onAssets, onBusy, selectLocalFiles, executionFileLimits, disabled = false, uploadsEnabled = true }: { contract: IOContract; values: Record<string, unknown>; onChange: (values: Record<string, unknown>) => void; errors?: Record<string, string>; assets?: AssetDTO[]; onAssets?: (assets: AssetDTO[]) => void; onBusy?: (busy: boolean) => void; selectLocalFiles?: (files: globalThis.File[]) => Promise<AssetDTO[]>; executionFileLimits?: CapabilityDTO["executionFileLimits"]; disabled?: boolean; uploadsEnabled?: boolean }) {
  const formId = useId();
  const busyKeys = useRef(new Set<string>());
  const current = useRef({ values, assets });
  current.current = { values, assets };
  const fields = [...contract.inputs].sort((a,b) => a.order - b.order).filter(field => isVisible(field, values, contract.inputs));
  return <div className="contract-form">{fields.map((declaredField, index) => {
    const field = effectiveInputField(declaredField, executionFileLimits);
    const id = `${formId}-${field.key}`, helpId = `${id}-help`;
    const value = values[field.key], c = field.constraints || {};
    const change = (next: unknown) => { current.current.values = { ...current.current.values, [field.key]: next }; onChange(current.current.values); };
    const common = { id, name: field.key, disabled, required: field.required, "aria-describedby": helpId, "aria-invalid": Boolean(errors[field.key]) };
    return <div className="contract-field" key={field.key}>
      {field.group && field.group !== fields[index - 1]?.group && <h3 className="form-group-title">{field.group}</h3>}
      <label className="field-label" htmlFor={id}>{field.label}{field.required && <span className="required"> *</span>}</label>
      {isFileField(field) ? <FileInput field={field} value={value} assets={assets} onChange={change} onAssets={added => { current.current.assets = [...current.current.assets, ...added]; onAssets?.(current.current.assets); }} onBusy={busy => { if (busy) busyKeys.current.add(field.key); else busyKeys.current.delete(field.key); onBusy?.(busyKeys.current.size > 0); }} selectLocalFiles={selectLocalFiles} disabled={disabled || !uploadsEnabled} inputId={id} describedBy={helpId} validationError={errors[field.key]} />
        : field.type === "BOOLEAN" ? <div className="checkbox-row"><input {...common} required={false} type="checkbox" checked={value === true} onChange={event => change(event.target.checked)} /><span>{value ? "Yes" : "No"}</span></div>
        : field.type === "SELECT" ? <select {...common} value={typeof value === "string" ? value : ""} onChange={event => change(event.target.value)}><option value="">Choose an option</option>{c.allowedValues?.map(option => <option key={option}>{option}</option>)}</select>
        : field.type === "MULTI_SELECT" ? <fieldset className="choice-list" id={id} aria-describedby={helpId} aria-invalid={Boolean(errors[field.key])}><legend className="sr-only">{field.label}</legend>{c.allowedValues?.map(option => <label className="checkbox-row" key={option}><input type="checkbox" disabled={disabled} checked={Array.isArray(value) && value.includes(option)} onChange={event => change(event.target.checked ? [...(Array.isArray(value) ? value : []), option] : (Array.isArray(value) ? value : []).filter(item => item !== option))} />{option}</label>)}</fieldset>
        : field.type === "LONG_TEXT" || field.type === "JSON" ? <textarea {...common} rows={field.type === "JSON" ? 6 : 4} className={field.type === "JSON" ? "code-input" : ""} maxLength={c.maxLength} minLength={c.minLength} value={typeof value === "string" ? value : value != null ? JSON.stringify(value, null, 2) : ""} onChange={event => change(event.target.value)} spellCheck={field.type !== "JSON"} />
        : <input {...common} type={field.type === "URL" ? "url" : ["NUMBER", "INTEGER"].includes(field.type) ? "number" : "text"} min={c.minimum} max={c.maximum} step={field.type === "INTEGER" ? 1 : "any"} minLength={c.minLength} maxLength={c.maxLength} value={typeof value === "string" || typeof value === "number" ? value : ""} onChange={event => change(["NUMBER", "INTEGER"].includes(field.type) ? event.target.value === "" ? undefined : event.target.valueAsNumber : event.target.value)} />}
      <div id={helpId}>{field.description && <small className="field-hint">{field.description}</small>}{c.maxLength && <small className="field-hint">{typeof value === "string" ? value.length : 0} / {c.maxLength} characters</small>}{errors[field.key] && <small className="field-error">{errors[field.key]}</small>}</div>
    </div>;
  })}{!fields.length && <p className="muted">This capability does not require additional inputs.</p>}</div>;
}
export function ContractSummary({ contract }: { contract: IOContract }) {
  return <dl className="contract-summary">{contract.inputs.map(field => <div key={field.key}><dt>{field.label}{field.required && " *"}</dt><dd>{isFileField(field) ? field.constraints?.allowedExtensions?.join(", ") : label(field.type)}{field.description && <small>{field.description}</small>}</dd></div>)}<div><dt>What you receive</dt><dd>{contract.output.description || label(contract.output.type)}{contract.output.files && <small>{contract.output.files.allowedExtensions.join(", ")}</small>}</dd></div></dl>;
}
