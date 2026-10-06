"use client";
import type { CapabilityVersionDiff } from "@/lib/types";
import { label } from "@/lib/format";
import { Notice } from "./ui";

const categories = ["SKILLS", "INFERENCE", "PERMISSIONS", "INPUTS", "OUTPUTS", "PRICE", "RUNTIME", "METADATA", "EXAMPLES"] as const;
const warningLabels: Record<string, string> = {
  PERMISSION_EXPANSION: "Expanded permissions", NEW_NETWORK_ACCESS: "New network access", NEW_PRIVATE_RESOURCE: "New private resource", NEW_CREDENTIAL: "New credential reference",
  INPUT_CONTRACT_CHANGED: "Input contract changed; check existing integrations", OUTPUT_CONTRACT_CHANGED: "Output contract changed; check dependent workflows", PRICE_CHANGED: "Price tier changed", RERUN_EXAMPLES_RECOMMENDED: "Examples should be revalidated against this version",
};
const valueText = (value: unknown) => value === null || value === undefined ? "Not set" : typeof value === "string" ? value : JSON.stringify(value, null, 2);

export function VersionChanges({ diff, fromLabel = "Previous version", toLabel = "Selected version" }: { diff: CapabilityVersionDiff; fromLabel?: string; toLabel?: string }) {
  return <div className="version-changes">
    {diff.warnings.length > 0 && <Notice tone="warning"><ul>{diff.warnings.map((warning, index) => <li key={`${warning.code}-${warning.path}-${index}`}><strong>{warningLabels[warning.code] || label(warning.code)}</strong><span className="small mono"> / {warning.path}</span></li>)}</ul></Notice>}
    {!diff.changes.length ? <p className="small muted">No frozen definition changes.</p> : categories.map(category => {
      const changes = diff.changes.filter(change => change.category === category);
      if (!changes.length) return null;
      return <details key={category} className="version-diff-category" open={diff.warnings.some(warning => changes.some(change => warning.path.startsWith(change.path) || change.path.startsWith(warning.path)))}><summary>{category === "SKILLS" ? "Skills & dependencies" : label(category)} <span className="muted">({changes.length})</span></summary>
        {changes.map(change => <div className="version-change" key={change.path}><h4 className="mono">{change.path}</h4><div className="version-comparison"><div><span className="field-hint">{fromLabel}</span><pre>{valueText(change.before)}</pre></div><div><span className="field-hint">{toLabel}</span><pre>{valueText(change.after)}</pre></div></div></div>)}
      </details>;
    })}
  </div>;
}
