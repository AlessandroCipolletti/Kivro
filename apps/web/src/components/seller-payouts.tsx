"use client";
import { useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import type { Earnings, PayoutPage } from "@/lib/types";
import { useResource } from "@/lib/hooks";
import { dateTime, money } from "@/lib/format";
import { payoutAmount, payoutSummaryWarnings } from "@/lib/payouts";
import { Button, Empty, ErrorNotice, Loading, Metric, Notice, Status } from "./ui";

export function SellerPayouts({ earnings, refresh }: { earnings: Earnings; refresh: () => void }) {
  const [cursors, setCursors] = useState<string[]>([]);
  const page = useResource<PayoutPage>(cursors.length ? `/seller/payouts?after=${encodeURIComponent(cursors.at(-1)!)}` : null);
  const summary = earnings.payoutSummary;
  const rows = cursors.length ? page.data?.items : earnings.payouts;
  const hasMore = cursors.length ? page.data?.hasMore : earnings.payoutsHasMore;
  const nextCursor = cursors.length ? page.data?.nextCursor : earnings.payoutsNextCursor;
  return <section className="page-section settings-section"><div className="section-header"><h2>Connected account payouts</h2><Button onClick={() => { setCursors([]); refresh(); }}><RefreshCw size={15} />Refresh payouts</Button></div>
    <p className="small muted">These are account-wide bank payouts and may include funds from outside Kivro. They are separate from job settlement and marketplace transfers. Summary amounts below include USD only.</p>
    {!summary ? <Notice>Payout reporting has not been supplied by the payment service.</Notice> : <>{payoutSummaryWarnings(summary).map(message => <Notice key={message} tone={summary.available ? "warning" : "neutral"}>{message}</Notice>)}{summary.available && <>
      <p className="small muted">Last synchronized {dateTime(summary.lastSyncedAt)}.</p>
      <div className="metrics"><Metric label={summary.historyComplete ? "Recorded paid payouts (USD)" : "Partial paid payouts (USD)"} value={money(summary.paidOutMinor)} detail="Provider-reported paid status" /><Metric label="Pending / in transit (USD)" value={money(summary.pendingMinor)} /><Metric label="Failed payouts (USD)" value={money(summary.failedMinor)} /><Metric label="Cancelled payouts (USD)" value={money(summary.canceledMinor)} /></div>
      <ErrorNotice error={page.error} retry={page.refresh} />{page.loading ? <Loading text="Loading payout history" rows={0} /> : rows?.length ? <div className="payout-list">{rows.map(row => <article key={row.id} className="payout-row"><div><strong>{payoutAmount(row.amountMinor, row.currency)}</strong><p className="small mono">{row.id}</p><p className="small muted">Provider created {dateTime(row.providerCreatedAt)}</p></div><div><Status value={row.status.toUpperCase()} /><p className="small">Expected arrival {dateTime(row.arrivalDate)}</p>{row.paidAt && <p className="small muted">Paid status observed {dateTime(row.paidAt)}</p>}{row.failureCode && <p className="small field-error">{row.failureCode}</p>}<p className="small muted">Last verified {dateTime(row.lastSyncedAt)}</p></div></article>)}</div> : !page.error && <Empty title="No payout records" description={summary.historyComplete ? "No bank payouts have been recorded for this connected account." : "Payout history is still being synchronized."} />}
      <div className="row between wrap"><span className="small muted">Page {cursors.length + 1}</span><div className="row"><Button disabled={!cursors.length || page.loading} onClick={() => setCursors(cursors.slice(0,-1))}><ChevronLeft size={16} />Previous payouts</Button><Button disabled={!hasMore || !nextCursor || page.loading} onClick={() => setCursors([...cursors, nextCursor!])}>Next payouts<ChevronRight size={16} /></Button></div></div>
      <p className="small muted">Expected arrival is an estimate. Paid status is the provider state last verified by Kivro, not independent confirmation of receipt by your bank.</p>
    </>}</>}
  </section>;
}
