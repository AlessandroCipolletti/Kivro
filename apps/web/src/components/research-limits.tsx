import type { PermissionManifest } from "@kivro/contracts";
import { researchLimitFields, withResearchLimit } from "@/lib/research-limits";
import { Field } from "./ui";

export function ResearchLimits({ network, onChange }: { network: PermissionManifest["network"]; onChange: (network: PermissionManifest["network"]) => void }) {
  return <details><summary>Advanced research limits</summary><p className="small muted">Optional per-job restrictions, bound to the execution manifest. Blank values retain platform limits. Zero queries or pages disables that operation.</p><div className="form-grid">{researchLimitFields.map(field => <Field key={field.key} label={field.label}><input type="number" step={1} min={field.min} max={field.max} value={network.researchLimits?.[field.key] ?? ""} onChange={event => onChange(withResearchLimit(network, field.key, event.target.value === "" ? undefined : event.target.valueAsNumber))} /></Field>)}</div></details>;
}
