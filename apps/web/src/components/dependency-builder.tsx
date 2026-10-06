"use client";
import { Plus, Trash2 } from "lucide-react";
import type { Dependency } from "@/lib/types";
import { dependencyGraphErrors, invalidateDependencies } from "@/lib/dependencies";
import { Button, Field, IconButton, Notice, Status } from "./ui";

export function DependencyBuilder({ dependencies, onChange }: { dependencies: Dependency[]; onChange: (value: Dependency[]) => void }) {
  const graphErrors = dependencyGraphErrors(dependencies);
  function patch(id: string, value: Partial<Dependency>) {
    onChange(invalidateDependencies(dependencies.map(node => node.id === id ? { ...node, ...value } : node), [id]));
  }
  return <div>{graphErrors.length > 0 && <Notice tone="danger"><ul>{graphErrors.map(error => <li key={error}>{error}</li>)}</ul></Notice>}{dependencies.map(node => {
    const managed = /^(inference$|tool-|resource-|network-)/.test(node.id);
    return <section className="dependency-row" key={node.id} aria-label={`Dependency ${node.name}`}>
      <div className="row wrap"><div><strong>{node.name}</strong><small className="field-hint">{node.type} / {node.required ? "Required" : "Optional"}</small><small className="field-hint">Evidence: {node.confidence.toLowerCase()} / Certainty: {(node.certainty ?? "UNKNOWN").toLowerCase()}</small></div><Status value={node.healthy && node.supported ? "HEALTHY" : "NOT_READY"} text={node.healthy && node.supported ? "Reports ready" : "Readiness unverified"} />{!managed && <IconButton label={`Remove dependency ${node.name}`} onClick={() => onChange(invalidateDependencies(dependencies.filter(item => item.id !== node.id), [node.id]))}><Trash2 size={15} /></IconButton>}</div>
      {node.details && <p>{node.details}</p>}
      {node.grants && <dl className="metadata-list">{Object.entries(node.grants).map(([key, values]) => <div key={key}><dt>{key}</dt><dd>{values.join(", ")}</dd></div>)}</dl>}
      <details><summary>Graph & provenance</summary><div className="stack">
        {!managed && <div className="form-grid"><Field label="Dependency name"><input required maxLength={200} value={node.name} onChange={event => patch(node.id, { name: event.target.value })} /></Field><Field label="Dependency type"><select value={node.type} onChange={event => patch(node.id, { type: event.target.value })}>{[...new Set(["SKILL", "CREDENTIAL", "PLUGIN", "MCP_SERVER", "EXECUTABLE", "SYSTEM_BINARY", "MODEL_FILE", "ENVIRONMENT_VARIABLE", node.type])].map(type => <option key={type}>{type}</option>)}</select></Field><label className="checkbox-row"><input type="checkbox" checked={node.required} onChange={event => patch(node.id, { required: event.target.checked })} />Required dependency</label><div className="span-two"><Field label="Source reference"><input value={node.source || ""} maxLength={500} onChange={event => patch(node.id, { source: event.target.value || undefined })} /></Field></div><div className="span-two"><Field label="Content SHA-256 (optional)"><input className="code-input" value={node.contentHash || ""} pattern="[a-f0-9]{64}" onChange={event => patch(node.id, { contentHash: event.target.value || undefined })} /></Field></div></div>}
        {managed && <small className="mono">{node.source}</small>}
        <fieldset className="choice-list"><legend className="field-label">Prerequisites for {node.name}</legend>{dependencies.filter(item => item.id !== node.id).map(item => <label className="checkbox-row" key={item.id}><input type="checkbox" checked={node.dependsOn?.includes(item.id) || false} onChange={event => patch(node.id, { dependsOn: event.target.checked ? [...(node.dependsOn || []), item.id] : node.dependsOn?.filter(id => id !== item.id) })} />{item.name}</label>)}{dependencies.length === 1 && <small className="muted">No other dependencies.</small>}{node.dependsOn?.filter(id => !dependencies.some(item => item.id === id)).map(id => <label key={id} className="checkbox-row"><input type="checkbox" checked onChange={() => patch(node.id, { dependsOn: node.dependsOn?.filter(value => value !== id) })} />Missing: {id}</label>)}</fieldset>
      </div></details>
      <label className="checkbox-row align-start"><input type="checkbox" checked={node.approved} onChange={event => onChange(dependencies.map(item => item.id === node.id ? { ...item, approved: event.target.checked } : item))} />I approve {node.name}, its listed grants and prerequisites.</label>
    </section>;
  })}<Button className="builder-add" disabled={dependencies.length >= 100} onClick={() => onChange([...dependencies, { id: `dependency-${crypto.randomUUID()}`, name: "New dependency", type: "SKILL", required: true, approved: false, healthy: false, supported: false, confidence: "DECLARED", dependsOn: [] }])}><Plus size={15} />Add dependency</Button></div>;
}
