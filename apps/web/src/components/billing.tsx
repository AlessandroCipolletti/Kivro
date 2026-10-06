"use client";
import { useState } from "react";
import { CreditCard, ExternalLink, Plus, RefreshCw, Star, Trash2 } from "lucide-react";
import { api, clearPurchaseKey, post, purchaseKey } from "@/lib/api";
import { useAction, useResource } from "@/lib/hooks";
import { dateTime, label, money } from "@/lib/format";
import { useApp } from "./provider";
import { Button, Confirm, Dialog, Empty, ErrorNotice, IconButton, Loading, Notice } from "./ui";

interface PendingOperation { key: string; action: "setup" | "default" | "remove"; paymentMethodId: string | null; consentVersion: string | null; retryAfter: string }
interface PaymentMethod { id: string; type: "card"; brand: string; last4: string; expMonth: number; expYear: number; isDefault: boolean }
interface Methods { available: boolean; reason: string | null; methods: PaymentMethod[]; defaultPaymentMethodId: string | null; hasMore: boolean; nextCursor: string | null; consent: { version: string; text: string }; pendingOperation: PendingOperation | null }
interface Receipt { id: string; amountMinor: number; currency: "USD"; status: string; refundedMinor: number; createdAt: string; receiptAvailable: boolean }
interface Receipts { available: boolean; reason: string | null; items: Receipt[]; hasMore: boolean; nextCursor: string | null }
function billingLink(value: string) { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password) throw new Error("The payment provider returned an invalid link."); return url.href; }
function unavailable(reason: string | null) { return reason === "DEVELOPMENT_PAYMENTS" ? "Development payment mode does not save cards or issue real payment receipts." : "Live payment processing is not configured. No card setup or charge has been created."; }

export function Billing() {
  const { user } = useApp();
  const methods = useResource<Methods>("/billing/payment-methods");
  const [receiptCursors, setReceiptCursors] = useState<string[]>([]);
  const receipts = useResource<Receipts>(`/billing/receipts${receiptCursors.length ? `?after=${encodeURIComponent(receiptCursors.at(-1)!)}` : ""}`);
  const [setup, setSetup] = useState(false), [consentVersion, setConsentVersion] = useState<string>();
  const [removal, setRemoval] = useState<PaymentMethod>();
  const [message, setMessage] = useState<string>();
  const action = useAction(), more = useAction(), receiptAction = useAction();
  const [links, setLinks] = useState<Record<string, string>>({});
  const scope = `kivro-billing:${user?.id}`;
  async function mutate(kind: PendingOperation["action"], methodId?: string, pending?: PendingOperation) {
    const version = pending?.consentVersion || consentVersion;
    if (kind === "setup" && (!version || !pending && version !== methods.data?.consent.version)) throw new Error("Review and accept the current card setup consent first.");
    const body = kind === "setup" ? { consentVersion: version, consentAccepted: true } : {};
    const key = pending?.key || purchaseKey(scope, { kind, methodId, body });
    try {
      const response = await post<{ url?: string }>(kind === "setup" ? "/billing/payment-methods/setup" : `/billing/payment-methods/${encodeURIComponent(methodId!)}/${kind}`, body, key);
      if (kind === "setup") { if (!response.url) throw new Error("The payment provider did not return a setup link."); const url = billingLink(response.url); clearPurchaseKey(scope); window.location.assign(url); return; }
      clearPurchaseKey(scope); setRemoval(undefined); setMessage(kind === "default" ? "Default payment method updated." : "Payment method removed.");
    } finally { methods.refresh(); }
  }
  const pending = methods.data?.pendingOperation;
  return <>
    <section className="page-section settings-section"><div className="section-header"><h2>Payment methods</h2><div className="row"><IconButton label="Refresh payment methods" onClick={methods.refresh}><RefreshCw size={16} /></IconButton><Button disabled={!methods.data?.available || Boolean(pending) || action.pending} onClick={() => { setConsentVersion(undefined); action.setError(undefined); setSetup(true); }}><Plus size={15} />Add card</Button></div></div>
      <ErrorNotice error={methods.error} retry={methods.refresh} /><ErrorNotice error={action.error} />{message && <Notice tone="success">{message}</Notice>}
      {methods.loading ? <Loading text="Loading payment methods" rows={0} /> : methods.data && (!methods.data.available ? <Notice>{unavailable(methods.data.reason)}</Notice> : <>
        {pending && <Notice tone="warning"><p>A previous {label(pending.action).toLowerCase()} request is awaiting provider confirmation. Retry the same request to avoid duplicate operations. Retry after {dateTime(pending.retryAfter)}.</p><Button busy={action.pending} onClick={() => void action.run(() => mutate(pending.action, pending.paymentMethodId || undefined, pending))}><RefreshCw size={15} />Retry pending request</Button></Notice>}
        {methods.data.methods.length ? methods.data.methods.map(method => <div className="integration-row" key={method.id}><div className="row"><CreditCard size={20} /><div><strong>{label(method.brand)} ending {method.last4}</strong><small>Expires {String(method.expMonth).padStart(2, "0")}/{method.expYear}{method.isDefault && " / Default"}</small></div></div><div className="row wrap">{!method.isDefault && <Button disabled={Boolean(pending) || action.pending} onClick={() => void action.run(() => mutate("default", method.id))}><Star size={14} />Make default</Button>}<IconButton label={`Remove card ending ${method.last4}`} disabled={Boolean(pending) || action.pending} onClick={() => { action.setError(undefined); setRemoval(method); }}><Trash2 size={16} /></IconButton></div></div>) : <Empty title="No saved cards" />}
        {methods.data.hasMore && methods.data.nextCursor && <Button busy={more.pending} onClick={() => void more.run(async () => { const current = methods.data!; const next = await api<Methods>(`/billing/payment-methods?after=${encodeURIComponent(current.nextCursor!)}`); methods.setData({ ...next, methods: [...current.methods, ...next.methods.filter(method => !current.methods.some(item => item.id === method.id))] }); })}>Load more cards</Button>}<ErrorNotice error={more.error} />
      </>)}
    </section>
    <section className="page-section settings-section"><div className="section-header"><h2>Payment receipts</h2><IconButton label="Refresh receipts" onClick={receipts.refresh}><RefreshCw size={16} /></IconButton></div><ErrorNotice error={receipts.error} retry={receipts.refresh} /><ErrorNotice error={receiptAction.error} />
      {receipts.loading ? <Loading text="Loading payment receipts" rows={0} /> : receipts.data && (!receipts.data.available ? <Notice>{unavailable(receipts.data.reason)}</Notice> : <>{receipts.data.items.length ? receipts.data.items.map(receipt => <div className="integration-row" key={receipt.id}><div><strong>{money(receipt.amountMinor)}</strong><small>{dateTime(receipt.createdAt)} / {label(receipt.status)}{receipt.refundedMinor > 0 && ` / Refunded ${money(receipt.refundedMinor)}`}</small></div>{receipt.receiptAvailable && (links[receipt.id] ? <a href={links[receipt.id]} target="_blank" rel="noopener noreferrer" className="text-link">Open receipt<ExternalLink size={14} /></a> : <Button busy={receiptAction.pending} onClick={() => void receiptAction.run(async () => { const result = await api<{ url: string }>(`/billing/receipts/${encodeURIComponent(receipt.id)}`); setLinks(current => ({ ...current, [receipt.id]: billingLink(result.url) })); })}>Get receipt<ExternalLink size={14} /></Button>)}</div>) : <Empty title="No payment receipts" />}<div className="row"><Button disabled={!receiptCursors.length} onClick={() => setReceiptCursors(receiptCursors.slice(0,-1))}>Previous</Button><Button disabled={!receipts.data.hasMore || !receipts.data.nextCursor} onClick={() => setReceiptCursors([...receiptCursors, receipts.data!.nextCursor!])}>Next</Button></div></>)}
    </section>
    <Dialog open={setup} onClose={() => { if (!action.pending) setSetup(false); }} title="Save a payment method"><div className="stack"><Notice>Card details are entered on the payment provider&apos;s secure page. Saving a card does not buy credits or authorize automatic top-ups.</Notice><p>{methods.data?.consent.text}</p><label className="checkbox-row align-start"><input type="checkbox" checked={Boolean(consentVersion && consentVersion === methods.data?.consent.version)} onChange={event => setConsentVersion(event.target.checked ? methods.data?.consent.version : undefined)} /><span>I agree to the payment method consent shown above.</span></label><ErrorNotice error={action.error} /><Button variant="primary" busy={action.pending} disabled={!consentVersion || consentVersion !== methods.data?.consent.version || Boolean(pending)} onClick={() => void action.run(() => mutate("setup"))}>Continue to secure card setup<ExternalLink size={15} /></Button></div></Dialog>
    <Confirm open={Boolean(removal)} onClose={() => setRemoval(undefined)} title={`Remove card ending ${removal?.last4}?`} description="This removes the saved payment method. Existing jobs and completed payments are not cancelled." confirmText="Remove payment method" danger pending={action.pending} error={action.error} onConfirm={() => void action.run(() => mutate("remove", removal?.id))} />
  </>;
}
