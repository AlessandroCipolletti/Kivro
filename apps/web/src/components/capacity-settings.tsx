"use client";
import { useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { api, ApiError, put } from "../lib/api";
import { useAction } from "../lib/hooks";
import { CapacitySchema, capacityDraft, capacityFields, capacityPatch, capacitySnapshot, parseCapacity, type Capacity } from "../lib/capacity";
import type { SellerCapability } from "../lib/types";
import { Button, Dialog, ErrorNotice, Field, Notice } from "./ui";

export function CapacitySettings({ capability, onClose, onSaved }: { capability: SellerCapability; onClose: () => void; onSaved: () => void }) {
  const [snapshot, setSnapshot] = useState(() => capacitySnapshot(capability));
  const [draft, setDraft] = useState(() => capacityDraft(capacitySnapshot(capability)));
  const [errors, setErrors] = useState<Partial<Record<keyof Capacity, string>>>({});
  const [stale, setStale] = useState(false);
  const action = useAction();
  const parsed = parseCapacity(draft);
  const changed = snapshot && parsed.success ? capacityPatch(snapshot, parsed.data) : null;
  function save() {
    const result = parseCapacity(draft);
    if (!result.success) { setErrors(Object.fromEntries(result.error.issues.map(issue => [issue.path[0], issue.message]))); return; }
    if (!snapshot || stale) return;
    const body = capacityPatch(snapshot, result.data);
    if (!body) return;
    void action.run(async () => {
      try { await put(`/seller/capabilities/${capability.id}`, body); onSaved(); onClose(); }
      catch (error) { if (error instanceof ApiError && error.code === "CAPABILITY_CONFLICT") setStale(true); throw error; }
    });
  }
  function reload() {
    void action.run(async () => {
      const current = (await api<SellerCapability[]>("/seller/capabilities")).find(item => item.id === capability.id);
      if (!current) throw new Error("This capability is no longer available to your account.");
      const next = capacitySnapshot(current);
      if (!next) throw new Error("The API did not supply complete capacity settings and revision. No defaults have been substituted.");
      setSnapshot(next); setDraft(capacityDraft(next)); setStale(false); setErrors({});
    });
  }
  return <Dialog open title={`Capacity / ${capability.title}`} onClose={() => { if (!action.pending) onClose(); }}>
    <form className="stack" noValidate onSubmit={event => { event.preventDefault(); save(); }}>
      <p className="small muted">Changes affect new admission. Lower limits let existing accepted, queued and scheduled jobs drain unchanged; they do not cancel work, alter payments or create a capability version.</p>
      {!snapshot && <Notice tone="warning">Capacity settings or revision were not supplied. Reload before editing; missing limits are not assumed to be zero.</Notice>}
      {capacityFields.map(({ key, label, hint }) => <Field key={key} label={label} hint={hint} error={errors[key]} required><input type="number" min={CapacitySchema.shape[key].minValue ?? undefined} max={CapacitySchema.shape[key].maxValue ?? undefined} step={1} required value={draft[key]} disabled={!snapshot || stale || action.pending} onChange={event => { setDraft(value => ({ ...value, [key]: event.target.value })); setErrors(value => ({ ...value, [key]: undefined })); }} /></Field>)}
      <p className="small muted">These are seller settings, not a guarantee of effective device capacity. Worker readiness, safety limits and availability are checked by the server.</p>
      <ErrorNotice error={action.error} />
      {stale && <Notice tone="warning">Settings changed elsewhere. Your attempted values are retained. Reload latest settings to discard them and review the current revision; nothing is retried automatically.</Notice>}
      <div className="dialog-actions"><Button onClick={reload} disabled={action.pending}><RefreshCw size={15} />Reload latest settings</Button><Button type="submit" variant="primary" busy={action.pending} disabled={!snapshot || stale || (parsed.success && !changed)}><Save size={15} />Save capacity</Button></div>
    </form>
  </Dialog>;
}
