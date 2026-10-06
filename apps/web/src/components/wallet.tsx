"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, CreditCard, Plus, Wallet as WalletIcon } from "lucide-react";
import type { LedgerEntry, Wallet } from "@/lib/types";
import { useAction, useResource } from "@/lib/hooks";
import { clearPurchaseKey, post, purchaseKey } from "@/lib/api";
import { dateTime, decimalToMinor, label, money } from "@/lib/format";
import { RequireAuth, useApp } from "./provider";
import { Button, Dialog, Empty, ErrorNotice, Field, Loading, Metric, Notice, PageHeading } from "./ui";
import { Billing } from "./billing";

export function Ledger({ entries }: { entries: LedgerEntry[] }) {
  return entries.length ? <div className="ledger-list">{entries.map(entry => <article key={entry.id} className="ledger-row"><span className="ledger-icon"><CreditCard size={18} /></span><div><strong>{entry.description || label(entry.type)}</strong><small>{dateTime(entry.createdAt)}</small></div><span>{entry.jobId && <Link href={`/jobs/${entry.jobId}`} className="text-link">Job {entry.jobId.slice(0,8)}<ArrowUpRight size={13} /></Link>}</span><strong className="tabular">{money(entry.amountMinor)}</strong></article>)}</div> : <Empty title="No transactions yet" description="Your balance movements will be recorded here." />;
}
export function WalletPage() { return <RequireAuth><WalletContent /></RequireAuth>; }
function WalletContent() {
  const resource = useResource<Wallet>("/wallet", 15000);
  const { config, user } = useApp();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("20.00");
  const [message, setMessage] = useState<string>();
  const action = useAction();
  const devPayment = config?.devMode === true && /fake|dev/i.test(config.paymentMode);
  async function topup() {
    const amountMinor = decimalToMinor(amount);
    if (!amountMinor || amountMinor < 100) { action.setError("Enter at least $1.00, with no more than two decimal places."); return; }
    await action.run(async () => {
      const scope = `kivro-topup:${user?.id}`;
      const result = await post<{ url?: string }>("/wallet/topup", { amountMinor }, purchaseKey(scope, { amountMinor }));
      if (result.url) {
        const url = new URL(result.url, window.location.origin);
        if (url.protocol !== "https:" && url.origin !== window.location.origin) throw new Error("The payment service returned an invalid checkout link.");
        clearPurchaseKey(scope); window.location.assign(url.href);
      } else {
        clearPurchaseKey(scope); setOpen(false); setMessage(devPayment ? "Development credits added." : "Top-up request received. Your balance updates after payment confirmation."); resource.refresh();
      }
    });
  }
  return <><PageHeading eyebrow="Account" title="Wallet" description="Your available credits, reserved payments and purchase history." actions={<Button variant="primary" onClick={() => { action.setError(undefined); setOpen(true); }}><Plus size={16} />Add credits</Button>} />{message && <Notice tone="success">{message}</Notice>}<ErrorNotice error={resource.error} retry={resource.refresh} />{resource.loading ? <Loading text="Loading wallet" /> : resource.data && <><div className="wallet-balance"><WalletIcon size={26} /><div><span>Available credits</span><strong>{money(resource.data.availableMinor)}</strong></div><Link href="/" className="button secondary">Find a capability<ArrowUpRight size={16} /></Link></div><div className="metrics three"><Metric label="Reserved for jobs" value={money(resource.data.reservedMinor)} /><Metric label="Total spent" value={money(resource.data.spentMinor)} /><Metric label="Seller earnings" value={money(resource.data.earnedMinor)} detail="Accounted for separately from buyer credits" /></div><div className="section-header"><h2>Transactions</h2><Link href="/selling/earnings" className="text-link">Seller earnings<ArrowUpRight size={15} /></Link></div><Ledger entries={resource.data.ledger} /></>}
    <Dialog open={open} onClose={() => { if (!action.pending) setOpen(false); }} title="Add marketplace credits"><form className="stack" onSubmit={event => { event.preventDefault(); void topup(); }}><Field label="Amount in USD"><input type="text" inputMode="decimal" required value={amount} onChange={event => setAmount(event.target.value)} /></Field><div className="amount-options">{["10.00","20.00","50.00","100.00"].map(value => <button type="button" key={value} aria-pressed={amount === value} onClick={() => setAmount(value)}>${Number(value)}</button>)}</div>{devPayment ? <Notice tone="warning">Development credits only. No real card will be charged.</Notice> : <Notice>Continue to secure checkout. Credits become available after the payment is confirmed.</Notice>}<ErrorNotice error={action.error} /><Button type="submit" variant="primary" busy={action.pending}>{devPayment ? "Add development credits" : "Continue to payment"}<ArrowUpRight size={16} /></Button></form></Dialog>
    <Billing />
  </>;
}
