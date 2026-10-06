import React from "react";
import type { InputConstraints, InputField } from "@kivro/contracts";
import { label } from "../lib/format";

const constraintLabels: [Exclude<keyof InputConstraints, "jsonSchema">, string][] = [
  ["minLength", "Minimum characters"], ["maxLength", "Maximum characters"],
  ["minimum", "Minimum value"], ["maximum", "Maximum value"], ["allowedValues", "Allowed values"],
  ["minFiles", "Minimum files"], ["maxFiles", "Maximum files"],
  ["maxFileSizeBytes", "Maximum bytes per file"], ["maxTotalSizeBytes", "Maximum total bytes"],
  ["allowedMimeTypes", "Allowed MIME types"], ["allowedExtensions", "Allowed extensions"],
  ["semanticType", "Semantic type"],
];

export function JobInputs({ input, contract }: { input: Record<string, unknown>; contract?: InputField[] }) {
  if (!contract) return <><p className="small muted">The purchased input contract was not recorded. Values are shown without inferred labels or constraints.</p><pre>{JSON.stringify(input, null, 2)}</pre></>;
  const extra = Object.fromEntries(Object.entries(input).filter(([key]) => !contract.some(field => field.key === key)));
  return <div className="job-inputs"><p className="small muted">Labels and constraints from the purchased version, not the current listing.</p>
    {[...contract].sort((a, b) => a.order - b.order).map(field => {
      const value = input[field.key], present = Object.hasOwn(input, field.key) && value !== undefined;
      const constraints = field.constraints || {};
      const facts = constraintLabels.filter(([key]) => constraints[key] !== undefined);
      return <section key={field.key} className="named-result" aria-label={`Submitted input: ${field.label}`}>
        <h3>{field.label}</h3><p className="small muted">{label(field.type)} / {field.required ? "Required" : "Optional"} / <code>{field.key}</code></p>
        {field.description && <p className="small muted">{field.description}</p>}
        {!present ? <p className="small muted">Not supplied.</p> : typeof value === "boolean" ? <p>{value ? "Yes" : "No"}</p> : typeof value === "object" ? <pre>{JSON.stringify(value, null, 2)}</pre> : <p className="prewrap">{String(value)}</p>}
        {(facts.length > 0 || constraints.jsonSchema || field.visibleWhen) && <details><summary>Purchased input constraints</summary>
          <dl className="metadata-list">{facts.map(([key, name]) => <div key={key}><dt>{name}</dt><dd>{Array.isArray(constraints[key]) ? constraints[key].join(", ") : String(constraints[key])}</dd></div>)}
            {field.visibleWhen && <div><dt>Visible when</dt><dd>{contract.find(item => item.key === field.visibleWhen!.key)?.label || field.visibleWhen.key} equals {String(field.visibleWhen.equals)}</dd></div>}
          </dl>{constraints.jsonSchema && <><h4>JSON Schema</h4><pre>{JSON.stringify(constraints.jsonSchema, null, 2)}</pre></>}
        </details>}
      </section>;
    })}
    {!contract.length && <p className="small muted">No inputs were declared for this version.</p>}
    {Object.keys(extra).length > 0 && <details><summary>Additional submitted values</summary><pre>{JSON.stringify(extra, null, 2)}</pre></details>}
  </div>;
}
