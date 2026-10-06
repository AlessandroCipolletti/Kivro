"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { CatalogPage } from "@/lib/types";
import { useResource } from "@/lib/hooks";
import { movePreference } from "@/lib/agent-recommendations";
import { CatalogPagination } from "./catalog-pagination";
import { ErrorNotice, Field, IconButton, Loading } from "./ui";

export function PreferredCapabilities({ value, onChange, disabled = false }: { value: string[]; onChange: (value: string[]) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [search, setSearch] = useState("");
  const [pagination, setPagination] = useState<{ key: string; cursors: string[] }>({ key: "", cursors: [] });
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 250); return () => clearTimeout(timer); }, [query]);
  const cursors = pagination.key === search ? pagination.cursors : [];
  const params = new URLSearchParams({ q: search, limit: "8", sort: "RELEVANCE" });
  if (cursors.length) params.set("cursor", cursors.at(-1)!);
  const resource = useResource<CatalogPage>(open ? `/capabilities/page?${params}` : null);
  useEffect(() => { if (resource.data) setNames(previous => ({ ...previous, ...Object.fromEntries(resource.data!.items.map(cap => [cap.id, cap.title])) })); }, [resource.data]);
  return <details className="preferred-capabilities" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Preferred capabilities ({value.length})</summary>
    <p className="small muted">Preference order applies only to relevant, eligible services. Budget, blocked sellers and availability limits still apply.</p>
    {value.length > 0 && <ol className="preferred-selection">{value.map((id, index) => <li key={id}><span>{index + 1}.</span><Link href={`/capabilities/${id}`}>{names[id] || id}</Link><div className="row"><IconButton label={`Move ${names[id] || id} up`} disabled={disabled || index === 0} onClick={() => onChange(movePreference(value, index, -1))}><ArrowUp size={15} /></IconButton><IconButton label={`Move ${names[id] || id} down`} disabled={disabled || index === value.length - 1} onClick={() => onChange(movePreference(value, index, 1))}><ArrowDown size={15} /></IconButton><IconButton label={`Remove preference ${names[id] || id}`} disabled={disabled} onClick={() => onChange(value.filter(item => item !== id))}><X size={15} /></IconButton></div></li>)}</ol>}
    <Field label="Find preferred capabilities"><input type="search" value={query} onChange={event => setQuery(event.target.value)} maxLength={200} disabled={disabled} /></Field>
    <ErrorNotice error={resource.error} retry={resource.refresh} />{resource.loading ? <Loading text="Finding preferred capabilities" rows={0} /> : resource.data && !resource.error && <>
      <fieldset className="choice-list preferred-options" disabled={disabled}><legend className="sr-only">Matching preferred capabilities</legend>{resource.data.items.map(cap => <label className="checkbox-row align-start" key={cap.id}><input type="checkbox" checked={value.includes(cap.id)} disabled={!value.includes(cap.id) && value.length >= 100} onChange={event => onChange(event.target.checked ? [...value, cap.id] : value.filter(id => id !== cap.id))} /><span>{cap.title}<small className="field-hint">{cap.seller.name} / {cap.category}</small></span></label>)}</fieldset>
      {!resource.data.items.length && <p className="small muted">No matching capabilities.</p>}
      <CatalogPagination page={cursors.length} total={resource.data.total} next={resource.data.nextCursor} loading={resource.loading || disabled} previous={() => setPagination({ key: search, cursors: cursors.slice(0,-1) })} advance={() => { if (resource.data?.nextCursor) setPagination({ key: search, cursors: [...cursors, resource.data.nextCursor] }); }} />
    </>}
  </details>;
}
