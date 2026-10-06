"use client";
import { useState } from "react";
import { ArrowLeft, ArrowRight, Download, Upload } from "lucide-react";
import { IMPORT_EXCHANGE_MAX_DOCUMENT_BYTES, parseImportInventoryJson, importTargetKinds, type ImportInventory, type ImportSelectionTarget } from "@kivro/contracts/import-exchange";
import type { Dependency } from "../lib/types";
import { importedDeclarations, selectionRecipe } from "../lib/import-selection";
import { downloadJson } from "../lib/seller-test";
import { useAction } from "../lib/hooks";
import { LocalExecutionConsent } from "./local-execution-consent";
import { Button, Dialog, ErrorNotice, Field, Notice } from "./ui";

const selectionErrors: Record<string, string> = {
  REQUIRED_DEPENDENCY_NOT_SELECTED: "Select every required prerequisite explicitly before continuing.",
  UNSUPPORTED_IMPORT_DEPENDENCY: "A selected dependency is unsupported. Remove it or adapt the capability locally before scanning again.",
  UNSUPPORTED_DISCOVERY_RUNTIME: "This inventory has an unsupported runtime. Update it and scan again.",
  IMPORT_DEPENDENCY_BINDING_REQUIRED: "Bind each selected resource, model or tool to an existing Worker reference.",
  IMPORT_BINDING_TYPE_MISMATCH: "A selected reference has an incompatible type.",
  DEPENDENCY_CYCLE: "The dependency graph has a cycle. Correct the local capability and scan again.",
};

export function ImportWizard({ onClose, onApply }: { onClose: () => void; onApply: (declarations: Dependency[]) => void }) {
  const [step, setStep] = useState(0), [ack, setAck] = useState(false);
  const [inventory, setInventory] = useState<ImportInventory>();
  const [selected, setSelected] = useState<string[]>([]);
  const [bindings, setBindings] = useState<Record<string, Partial<ImportSelectionTarget>>>({});
  const action = useAction();
  let reviewError: string | undefined;
  if (inventory && selected.length) {
    try { selectionRecipe(inventory, selected, bindings); }
    catch (error) { reviewError = error instanceof Error && selectionErrors[error.message] || "Select the complete graph and valid Worker references for each non-skill dependency."; }
  } else reviewError = "Choose at least one starting skill or capability dependency.";
  return <Dialog open title="Import from OpenClaw" onClose={onClose} wide><div className="stack">
    <p className="small muted">{["1 / Local execution", "2 / Local inventory", "3 / Dependencies & resources", "4 / Review selection"][step]}</p>
    {step === 0 && <LocalExecutionConsent checked={ack} onChange={setAck} />}
    {step === 1 && <><h3>Local OpenClaw inventory</h3><p>The read-only Worker scan exports names and dependency metadata. It excludes personal files, skill contents and credentials.</p><code>pnpm worker scan --inventory</code><label className="upload-area"><Upload size={20} /><span>Choose Worker inventory</span><input aria-label="OpenClaw inventory file" type="file" accept=".json,application/json" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
      void action.run(async () => { if (file.size > IMPORT_EXCHANGE_MAX_DOCUMENT_BYTES) throw new Error("Inventory files cannot exceed 512 KiB."); const parsed = parseImportInventoryJson(await file.text()); setInventory(parsed); setSelected([]); setBindings({}); });
    }} /></label>{inventory && <dl className="health-grid"><div><dt>Detected runtime</dt><dd>{inventory.runtimeVersion ?? "Unknown"}</dd></div><div><dt>Compatibility</dt><dd>{inventory.compatible ? "Supported for review" : "Unsupported"}</dd></div><div><dt>Discovered dependencies</dt><dd>{inventory.dependencies.length}</dd></div></dl>}</>}
    {step === 2 && inventory && <><h3>Choose the capability and its dependencies</h3><Notice>Every choice starts unchecked. Bindings name existing dedicated Worker references; they do not grant access or copy credentials.</Notice>
      {inventory.dependencies.map(node => {
        const chosen = selected.includes(node.id), kinds = importTargetKinds(node.type), binding = bindings[node.id];
        return <section className="dependency-row" key={node.id} aria-label={`Import dependency ${node.name}`}><label className="checkbox-row align-start"><input type="checkbox" checked={chosen} disabled={node.support === "UNSUPPORTED" || !chosen && selected.length >= 100} onChange={event => { setSelected(values => event.target.checked ? [...values, node.id] : values.filter(id => id !== node.id)); setBindings(values => { const next = { ...values }; delete next[node.id]; return next; }); }} /><span><strong>{node.name}</strong><small className="field-hint">{node.type} / {node.required ? "Required" : "Optional"} / Evidence: {node.confidence.toLowerCase()} / Certainty: {(node.certainty ?? "UNKNOWN").toLowerCase()}</small></span></label>
          <p className="small muted">{node.support === "SUPPORTED" ? "Supported metadata; health needs testing" : node.support === "DEDICATED_CREDENTIAL_REQUIRED" ? "Dedicated Worker inference or credential reference required" : node.support === "UNSUPPORTED" ? "Blocked under current runtime policy" : "Local adaptation and review required"}</p>
          {node.dependsOn.length > 0 && <p className="small">Required prerequisites: {node.dependsOn.map(id => inventory.dependencies.find(item => item.id === id)?.name ?? "Missing dependency").join(", ")}</p>}
          {chosen && node.type !== "SKILL" && <div className="form-grid"><Field label={`Reference type for ${node.name}`}><select value={binding?.kind ?? ""} onChange={event => setBindings(values => ({ ...values, [node.id]: { discoveredId: node.id, kind: event.target.value as ImportSelectionTarget["kind"], ref: "" } }))}><option value="">Choose reference type</option>{kinds.map(kind => <option key={kind}>{kind}</option>)}</select></Field><Field label={`Worker reference for ${node.name}`} hint="An existing reference name, never a secret or local path."><input value={binding?.ref ?? ""} maxLength={100} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,99}" onChange={event => setBindings(values => ({ ...values, [node.id]: { ...values[node.id], ref: event.target.value } }))} /></Field></div>}
        </section>;
      })}
      {reviewError && <p className="field-error">{reviewError}</p>}
    </>}
    {step === 3 && inventory && <><h3>Review the selected graph</h3><p>{selected.length} explicitly selected dependencies.</p><ul>{inventory.dependencies.filter(node => selected.includes(node.id)).map(node => <li key={node.id}>{node.name}{bindings[node.id] && ` / ${bindings[node.id].kind}: ${bindings[node.id].ref}`}</li>)}</ul><p className="small mono">Discovery snapshot: {inventory.discoveryHash}</p>
      <Notice>The Worker rescans locally, checks existing approvals and requires a separate review-hash confirmation. Dependency health, representative execution, security tests and observed-versus-declared graph checks still precede publication.</Notice>
      <code>pnpm worker import selection LOCAL_APPROVED_VERSION_UUID --file kivro-import-selection.json</code>
      <Button onClick={() => void action.run(async () => downloadJson(selectionRecipe(inventory, selected, bindings), "kivro-import-selection.json"))}><Download size={15} />Export selection recipe</Button>
      <Button variant="primary" onClick={() => { onApply(importedDeclarations(inventory, selected, bindings)); onClose(); }}><ArrowRight size={15} />Use selected dependency declarations</Button>
    </>}
    <ErrorNotice error={action.error} /><div className="dialog-actions"><Button disabled={step === 0} onClick={() => setStep(value => value - 1)}><ArrowLeft size={15} />Back</Button>{step < 3 && <Button variant="primary" disabled={step === 0 ? !ack : step === 1 ? !inventory : Boolean(reviewError)} onClick={() => setStep(value => value + 1)}>Continue<ArrowRight size={15} /></Button>}</div>
  </div></Dialog>;
}
