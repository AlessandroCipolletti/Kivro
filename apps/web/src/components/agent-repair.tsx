"use client";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { AgentPlan, AgentStep, CapabilityDTO, CatalogPage } from "@/lib/types";
import { post } from "@/lib/api";
import { useAction, useResource } from "@/lib/hooks";
import { repairableSteps } from "@/lib/plans";
import { money } from "@/lib/format";
import { useApp } from "./provider";
import { Button, ErrorNotice, Field, Loading, Notice } from "./ui";
import { Permissions } from "./permissions";
import { JsonEditor } from "./contract-builder";
import { ContractSummary } from "./contract-form";
import { CatalogPagination } from "./catalog-pagination";

interface Replacement { capability?: CapabilityDTO; inputMapping?: unknown }
export function ExplicitPlanRepair({ plan, onRepaired }: { plan: AgentPlan; onRepaired: (plan: AgentPlan) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(""), [search, setSearch] = useState("");
  const [pagination, setPagination] = useState<{ query: string; cursors: string[] }>({ query: "", cursors: [] });
  const [replacements, setReplacements] = useState<Record<string, Replacement>>({});
  const [reason, setReason] = useState("");
  const { config } = useApp();
  useEffect(() => { const timer = setTimeout(() => setSearch(query), 300); return () => clearTimeout(timer); }, [query]);
  const cursors = pagination.query === search ? pagination.cursors : [];
  const params = new URLSearchParams({ q: search }); if (cursors.length) params.set("cursor", cursors.at(-1)!);
  const catalog = useResource<CatalogPage>(open ? `/capabilities/page?${params}` : null);
  const action = useAction();
  const steps = repairableSteps(plan), selected = Object.entries(replacements);
  function update(stepId: string, patch: Partial<Replacement>) { setReplacements(current => ({ ...current, [stepId]: { ...current[stepId], ...patch } })); }
  return <details className="page-section" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>Choose replacements for multiple steps</summary>
    <form className="stack" onSubmit={event => { event.preventDefault(); void action.run(async () => {
      if (!selected.length || selected.length > 8 || selected.some(([,value]) => !value.capability)) throw new Error("Select one to eight steps and choose a replacement for each.");
      const body = selected.map(([stepId, value]) => {
        if (value.inputMapping !== undefined && !Array.isArray(value.inputMapping)) throw new Error("Input mappings must be a JSON array.");
        return { stepId, capabilityId: value.capability!.id, capabilityVersionId: value.capability!.versionId, ...(value.inputMapping === undefined ? {} : { inputMapping: value.inputMapping as AgentStep["inputMapping"] }) };
      });
      const result = await post<AgentPlan>(`/agent/plans/${plan.id}/repair`, { expectedRevision: plan.revision, reason: reason.trim(), replacements: body });
      if (result.id !== plan.id || result.revision <= plan.revision || result.status !== "AWAITING_APPROVAL") throw new Error("The response is not a new reviewable revision. Refresh this plan before continuing.");
      onRepaired(result);
    }); }}>
      <Notice>Only the selected failed or unpurchased steps are replaced. Completed work, original paid attempts and the existing total budget remain attached. The revised plan needs fresh approval; this action does not authorize purchases.</Notice>
      <Field label="Search replacement services"><input value={query} onChange={event => setQuery(event.target.value)} maxLength={200} /></Field><ErrorNotice error={catalog.error} retry={catalog.refresh} />{catalog.loading && <Loading text="Finding replacement services" rows={0} />}
      {steps.map((step, index) => {
        const replacement = replacements[step.id], cap = replacement?.capability;
        const options = [...(cap ? [cap] : []), ...(catalog.data?.items || []).filter(item => item.id !== cap?.id)];
        return <fieldset className="repair-step" key={step.id}><legend><label className="checkbox-row"><input type="checkbox" checked={Boolean(replacement)} disabled={!replacement && selected.length >= 8} onChange={event => { if (event.target.checked) update(step.id, {}); else setReplacements(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== step.id))); }} />Replace step {plan.steps.indexOf(step) + 1} / {step.status.toLowerCase()}</label></legend>{replacement && <div className="stack"><Field label={`Replacement service ${index + 1}`}><select value={cap?.id || ""} required onChange={event => update(step.id, { capability: options.find(item => item.id === event.target.value) })}><option value="">Select a current version</option>{options.map(item => <option key={item.id} value={item.id}>{item.title} / v{item.version} / {money(config?.priceTiers.find(tier => tier.id === item.priceTierId)?.buyerPriceMinor)}</option>)}</select></Field>{cap && <details><summary>Replacement permissions & contract</summary><p className="small mono">Pinned replacement version: {cap.versionId}</p><Permissions permissions={cap.permissions} /><ContractSummary contract={cap.ioContract} /></details>}<details><summary>Input mapping override (optional)</summary><p className="small muted">Existing mappings are preserved unless a replacement array is provided.</p><JsonEditor label={`Input mapping for step ${plan.steps.indexOf(step) + 1}`} value={replacement.inputMapping} onChange={value => update(step.id, { inputMapping: value })} /><details><summary>Current mappings</summary><pre>{JSON.stringify(step.inputMapping, null, 2)}</pre></details></details></div>}</fieldset>;
      })}
      {catalog.data && <CatalogPagination page={cursors.length} total={catalog.data.total} next={catalog.data.nextCursor} loading={catalog.loading} previous={() => setPagination({ query: search, cursors: cursors.slice(0,-1) })} advance={() => { if (catalog.data?.nextCursor) setPagination({ query: search, cursors: [...cursors, catalog.data.nextCursor] }); }} />}
      <Field label="Reason for selected replacements"><textarea value={reason} onChange={event => setReason(event.target.value)} required minLength={3} maxLength={1000} /></Field><ErrorNotice error={action.error} /><Button busy={action.pending} disabled={!selected.length || selected.some(([,value]) => !value.capability)} type="submit"><RefreshCw size={15} />Prepare replacement revision</Button>
    </form>
  </details>;
}
