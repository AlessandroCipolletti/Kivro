"use client";
import { Field } from "./ui";
import { PreferredCapabilities } from "./agent-preferences";
export interface AgentConstraints { perJob: string; maxJobs: number; minRating: string; maxRuntime: string; maxQueueWait: number; blockedSellers: string; outputs: string[]; noNetwork: boolean; allowScheduling: boolean; onlineOnly: boolean; preferredCapabilityIds: string[] }
export const defaultAgentConstraints: AgentConstraints = { perJob: "", maxJobs: 8, minRating: "", maxRuntime: "", maxQueueWait: 0, blockedSellers: "", outputs: [], noNetwork: false, allowScheduling: false, onlineOnly: false, preferredCapabilityIds: [] };

export function AgentConstraintFields({ value, onChange, scheduled }: { value: AgentConstraints; onChange: (value: AgentConstraints) => void; scheduled: boolean }) {
  const update = (patch: Partial<AgentConstraints>) => onChange({ ...value, ...patch });
  return <><details className="agent-constraints"><summary>Budget, service & privacy limits</summary><div className="form-grid">
    <Field label="Maximum per job (USD)"><input value={value.perJob} onChange={event => update({ perJob: event.target.value })} inputMode="decimal" /></Field>
    <Field label="Maximum paid jobs"><input type="number" min={1} max={32} step={1} value={value.maxJobs} onChange={event => update({ maxJobs: event.target.valueAsNumber })} required /></Field>
    <Field label="Minimum service rating"><select value={value.minRating} onChange={event => update({ minRating: event.target.value })}><option value="">Any rating</option><option value="4">4.0</option><option value="4.5">4.5</option><option value="4.8">4.8</option></select></Field>
    <Field label="Maximum runtime (seconds)"><input type="number" min={1} max={604800} step={1} value={value.maxRuntime} onChange={event => update({ maxRuntime: event.target.value })} /></Field>
    <Field label="Maximum queue wait"><select value={value.maxQueueWait} onChange={event => update({ maxQueueWait: Number(event.target.value) })} disabled={scheduled || value.onlineOnly}><option value={0}>Do not queue</option><option value={60}>1 minute</option><option value={300}>5 minutes</option><option value={900}>15 minutes</option><option value={1800}>30 minutes</option></select></Field>
    <Field label="Blocked seller IDs (comma separated)"><input value={value.blockedSellers} onChange={event => update({ blockedSellers: event.target.value })} maxLength={3800} /></Field>
    <fieldset className="choice-list"><legend className="field-label">Allowed output types</legend>{["TEXT", "JSON", "FILES", "MIXED"].map(type => <label key={type} className="checkbox-row"><input type="checkbox" checked={value.outputs.includes(type)} onChange={event => update({ outputs: event.target.checked ? [...value.outputs, type] : value.outputs.filter(item => item !== type) })} />{type}</label>)}</fieldset>
    <label className="checkbox-row"><input type="checkbox" checked={value.noNetwork} onChange={event => update({ noNetwork: event.target.checked })} />Only services without network access</label>
    <label className="checkbox-row"><input type="checkbox" checked={value.onlineOnly} onChange={event => update({ onlineOnly: event.target.checked, ...(event.target.checked ? { maxQueueWait: 0, allowScheduling: false } : {}) })} />Only online services ready now</label>
    <div className="span-two"><PreferredCapabilities value={value.preferredCapabilityIds} onChange={preferredCapabilityIds => update({ preferredCapabilityIds })} /></div>
  </div></details>{scheduled && <label className="checkbox-row align-start"><input type="checkbox" checked={value.allowScheduling} onChange={event => update({ allowScheduling: event.target.checked })} /><span>I allow this request to include services scheduled for future availability. A plan still requires approval before any purchase.</span></label>}</>;
}
