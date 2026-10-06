import type { CapabilityDTO } from "@kivro/contracts";
import { Notice } from "./ui";
import { researchLimitFields } from "@/lib/research-limits";

export const pauseLabels = { FULL_RESUME: "Pause and resume supported", RESTART_STEP: "Resume restarts the current step", NOT_SUPPORTED: "Pause is not supported" } as const;
export function DataProcessing({ capability }: { capability: CapabilityDTO }) {
  const policy = capability.dataProcessing;
  return <section className="page-section"><h3>Processing & retention</h3>
    {policy ? <dl className="metadata-list"><div><dt>Execution</dt><dd>{policy.privateSellerRuntime ? "Private runtime on a seller-controlled computer" : "See declared runtime permissions"}</dd></div><div><dt>External inference</dt><dd>{policy.inferenceProvider} / {policy.inferenceModel}</dd></div><div><dt>Cloud file retention</dt><dd>{policy.assetRetentionDays} days; each delivered file shows its expiration.</dd></div><div><dt>Completed job content</dt><dd>{policy.jobContentRetentionDays} days after completion</dd></div>{capability.pauseSupport && <div><dt>Pause behavior</dt><dd>{pauseLabels[capability.pauseSupport]}</dd></div>}</dl> : <Notice>Detailed processing and retention metadata has not been supplied for this capability.</Notice>}
    <dl className="metadata-list"><div><dt>Public web research</dt><dd>{capability.permissions.network.mode === "RESEARCH" ? "Enabled" : "Not enabled"}</dd></div><div><dt>Network permission</dt><dd>{capability.permissions.network.mode === "NONE" ? "No general network access" : capability.permissions.network.mode === "RESEARCH" ? "Public research through approved tools" : "Declared connectors"}</dd></div><div><dt>Declared network domains</dt><dd>{capability.permissions.network.allowedDomains.length ? capability.permissions.network.allowedDomains.map(domain => <div className="mono" key={domain}>{domain}</div>) : "No domains declared"}</dd></div></dl>
    {capability.permissions.network.mode === "RESEARCH" && capability.permissions.network.researchLimits && <dl className="metadata-list">{researchLimitFields.filter(field => capability.permissions.network.researchLimits?.[field.key] !== undefined).map(field => <div key={field.key}><dt>{field.label}</dt><dd>{capability.permissions.network.researchLimits![field.key]}</dd></div>)}</dl>}
    <p className="small muted">Job inputs and outputs may be sent to the declared inference provider and permitted external services. Execution is seller-controlled, not a Kivro-hosted processing guarantee. Financial and audit metadata are retained separately. Cloud retention does not guarantee deletion from external providers, seller-held copies or any copies you download.</p>
  </section>;
}
