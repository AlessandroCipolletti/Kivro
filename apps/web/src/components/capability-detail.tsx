"use client";
import { TermsAcceptance } from "./terms";
import { PaymentPolicyDisclosure } from "./payment-disclosure";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CalendarClock, CheckCircle2, Clock3, FileText, ShieldCheck, Star } from "lucide-react";
import type { AssetDTO, CapabilityDTO, CatalogPage, JobDTO, Quote, Review } from "@/lib/types";
import { useResource, useAction } from "@/lib/hooks";
import { clearPurchaseKey, post, purchaseKey } from "@/lib/api";
import { dateTime, duration, money } from "@/lib/format";
import { fieldErrors, initialInput, prepareInput } from "@/lib/forms";
import { checkoutAvailability } from "@/lib/checkout";
import { useApp } from "./provider";
import { Button, Empty, ErrorNotice, Loading, Notice, PageHeading, Status } from "./ui";
import { ContractForm, ContractSummary } from "./contract-form";
import { CategoryVisual, FavoriteButton, CapabilityCard } from "./marketplace";
import { Permissions } from "./permissions";
import { CatalogPagination } from "./catalog-pagination";
import { DataProcessing } from "./data-processing";
import { ReviewDistribution } from "./reviews";
import { ReportButton } from "./problem-reports";
import { CapabilityExamples } from "./capability-examples";
import { exampleTemplateValues, type ExampleTemplate } from "@/lib/examples";

export function CapabilityDetail({ id }: { id: string }) {
  const resource = useResource<CapabilityDTO>(`/capabilities/${encodeURIComponent(id)}`, 30000);
  return <><Link className="back-link" href="/"><ArrowLeft size={15} />Marketplace</Link><ErrorNotice error={resource.error} retry={resource.refresh} />{resource.loading ? <Loading text="Loading capability" /> : resource.data && <CapabilityContent key={`${resource.data.id}:${resource.data.versionId}`} capability={resource.data} reload={resource.refresh} />}</>;
}
function CapabilityContent({ capability: cap, reload }: { capability: CapabilityDTO; reload: () => void }) {
  const reviews = useResource<Review[]>(`/capabilities/${cap.id}/reviews`);
  const [tab, setTab] = useState("overview");
  const [template, setTemplate] = useState<ExampleTemplate>();
  const checkoutRef = useRef<HTMLElement>(null);
  return <>
    <div className="capability-heading"><CategoryVisual category={cap.category} /><div><div className="eyebrow">{cap.category} / Version {cap.version}</div><h1>{cap.title}</h1><div className="row wrap muted"><Link href={`/sellers/${cap.seller.id}`}>By {cap.seller.name}</Link><span className="row"><Star size={14} />{cap.rating === null ? "Not rated yet" : `${cap.rating.toFixed(1)} (${cap.reviewCount} reviews)`}</span><span>{cap.completedJobs.toLocaleString()} completed jobs</span></div></div><FavoriteButton capability={cap} /></div>
    <div className="detail-layout"><div className="detail-main">
      <p className="detail-summary">{cap.summary}</p>
      <div className="detail-facts"><div><Clock3 size={17} /><span>Processing time<strong>~{duration(cap.estimatedDurationSeconds)}</strong></span></div><div><FileText size={17} /><span>Output<strong>{cap.ioContract.output.type.toLowerCase()}</strong></span></div><div><CheckCircle2 size={17} /><span>Success rate<strong>{cap.successRate === null ? "Not available" : `${(cap.successRate <= 1 ? cap.successRate * 100 : cap.successRate).toFixed(0)}%`}</strong></span></div></div>
      <div className="tabs" role="tablist" aria-label="Capability information">{["overview", "examples", "permissions", "reviews"].map(value => <button key={value} role="tab" aria-selected={tab === value} aria-controls={`panel-${value}`} id={`tab-${value}`} onClick={() => setTab(value)}>{value.charAt(0).toUpperCase() + value.slice(1)}{value === "reviews" && <span>{cap.reviewCount}</span>}</button>)}</div>
      <section className="tab-panel" id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "overview" && <><h2>About this capability</h2><p className="prose prewrap">{cap.description}</p><h2 className="section-title">Inputs & deliverables</h2><ContractSummary contract={cap.ioContract} /><DataProcessing capability={cap} /><div className="disclosure"><ShieldCheck size={18} /><p>Your inputs are processed on the seller&apos;s computer in an isolated worker environment. Share only data you are authorized to provide. Failed, undelivered jobs follow the platform&apos;s release or refund policy.</p></div><Link className="text-link" href={`/agent?request=${encodeURIComponent(`Help me decide whether ${cap.title} fits my task. Capability: ${cap.id}`)}`}>Ask Kivro about this capability<ArrowRight size={15} /></Link></>}
        {tab === "examples" && <CapabilityExamples capability={cap} reload={reload} onTemplate={value => { setTemplate(value); checkoutRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }} />}
        {tab === "permissions" && <><h2>Data & permissions</h2><Permissions permissions={cap.permissions} /><p className="muted">These permissions belong to version {cap.version}. Your job is pinned to the version confirmed at checkout.</p></>}
        {tab === "reviews" && <><ReviewDistribution capabilityId={cap.id} /><ErrorNotice error={reviews.error} retry={reviews.refresh} />{reviews.loading ? <Loading text="Loading verified reviews" /> : reviews.data?.length ? reviews.data.map(review => <article className="review" key={review.id}><div className="row between"><strong>{review.user?.name || "Verified buyer"}</strong><span className="row"><Star size={14} />{review.rating}/5</span></div><p>{review.comment || "No written comment."}</p><small className="muted">{dateTime(review.createdAt)} / Verified job</small></article>) : <Empty title="No reviews yet" description="Only buyers with a completed, paid job can leave a review." />}</>}
      </section>
      <ReportButton target={{ capabilityId: cap.id }} />
    </div><section ref={checkoutRef} className="checkout" aria-label="Create a job"><Checkout key={`${cap.id}:${cap.versionId}`} capability={cap} template={template} /></section></div>
  </>;
}
function Checkout({ capability: cap, template }: { capability: CapabilityDTO; template?: ExampleTemplate }) {
  const { user, config, authenticate } = useApp();
  const router = useRouter();
  const [values, setValues] = useState(() => initialInput(cap.ioContract));
  const [assets, setAssets] = useState<AssetDTO[]>([]);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<Quote>();
  const [quotedMode, setQuotedMode] = useState<"NOW" | "SCHEDULED">();
  const [prepared, setPrepared] = useState<Record<string, unknown>>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [termsReady, setTermsReady] = useState(false);
  const [expired, setExpired] = useState(false);
  const action = useAction();
  useEffect(() => {
    if (!template) return;
    try { const result = exampleTemplateValues(cap.ioContract, template, cap.id, cap.versionId); setValues(result.values); setAssets(result.assets); setErrors({}); action.setError(undefined); }
    catch (error) { action.setError(error instanceof Error ? error.message : "Template unavailable."); }
    setQuote(undefined); setQuotedMode(undefined); setPrepared(undefined); setAcknowledged(false);
  }, [template, cap.versionId]);
  useEffect(() => { if (!quote) { setExpired(false); return; } const check = () => setExpired(Date.now() >= Date.parse(quote.expiresAt)); check(); const interval = setInterval(check, 1000); return () => clearInterval(interval); }, [quote]);
  const { schedulable, queueable, available, reviewLabel } = checkoutAvailability(cap.availability);
  const scheduled = quote ? quotedMode === "SCHEDULED" : schedulable;
  const mode = scheduled ? "SCHEDULED" : "NOW";
  const price = config?.priceTiers.find(tier => tier.id === cap.priceTierId);
  const actionName = scheduled ? "Schedule" : queueable && !cap.availability.canRunNow ? "Join queue" : "Run now";
  async function review() {
    if (!user) return authenticate();
    setErrors({});
    let input: Record<string, unknown>;
    try { input = prepareInput(cap.ioContract, values, assets); }
    catch (error) { setErrors(fieldErrors(error)); action.setError(error instanceof Error ? error.message : "Check the inputs."); return; }
    await action.run(async () => { const result = await post<Quote>(`/capabilities/${cap.id}/quote`, { executionMode: mode }); setQuote(result); setQuotedMode(mode); setPrepared(input); setAcknowledged(false); });
  }
  async function purchase() {
    if (!quote || expired || !prepared || !acknowledged || !termsReady) return;
    await action.run(async () => {
      const payload = { capabilityId: cap.id, input: prepared, executionMode: mode, quoteId: quote.id, ...(scheduled ? { scheduledAt: quote.earliestStartAt } : {}) };
      const scope = `kivro-job:${user?.id}:${cap.id}`;
      const job = await post<JobDTO>("/jobs", payload, purchaseKey(scope, payload));
      clearPurchaseKey(scope); router.push(`/jobs/${job.id}`);
    });
  }
  return <><div className="checkout-price"><strong>{money(quote?.priceSnapshot.buyerTotalMinor ?? quote?.priceSnapshot.buyerPriceMinor ?? price?.buyerPriceMinor)}</strong><span>per job</span></div><Status value={cap.availability.status} />{cap.availability.reason && <p className="muted">{cap.availability.reason}</p>}
    {scheduled && <div className="schedule-callout"><CalendarClock size={19} /><div><strong>Earliest availability</strong><span>{dateTime(quote?.earliestStartAt || cap.availability.nextAvailableAt)}</span><small>~{duration(cap.estimatedDurationSeconds)} processing after execution starts</small></div></div>}
    {!quote ? <form onSubmit={event => { event.preventDefault(); void review(); }}><h2>Your job inputs</h2><ContractForm contract={cap.ioContract} executionFileLimits={cap.executionFileLimits} values={values} onChange={setValues} errors={errors} assets={assets} onAssets={setAssets} onBusy={setUploading} disabled={action.pending} /><ErrorNotice error={action.error} /><Button className="full-width" variant="primary" type="submit" disabled={!available || uploading} busy={action.pending}>{available ? reviewLabel : "Currently unavailable"}<ArrowRight size={16} /></Button>{!available && <p className="field-hint">Save this capability to check its availability later.</p>}</form>
      : <div className="stack"><h2>Confirm your {scheduled ? "scheduled job" : "job"}</h2><dl className="checkout-summary"><div><dt>Earliest execution</dt><dd>{dateTime(quote.earliestStartAt)}</dd></div><div><dt>Processing time</dt><dd>~{duration(cap.estimatedDurationSeconds)}</dd></div><div><dt>Estimated result</dt><dd>{dateTime(quote.estimatedDeliveryAt)}</dd></div><div><dt>Version</dt><dd>{cap.version}</dd></div><div><dt>Total reserved</dt><dd>{money(quote.priceSnapshot.buyerTotalMinor ?? quote.priceSnapshot.buyerPriceMinor)}</dd></div></dl><Notice>Credits are reserved now and settled after successful delivery.{scheduled && " This is the earliest eligible time, not a guaranteed start. You can cancel before execution for a credit release."}</Notice><PaymentPolicyDisclosure policy={config?.paymentPolicy} /><details><summary>Review your inputs</summary><pre>{JSON.stringify(prepared, null, 2)}</pre></details><TermsAcceptance onReady={setTermsReady} /><label className="checkbox-row align-start"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>I approve this job, its price, timing and declared permissions.</span></label>{expired && <Notice tone="warning">This quote has expired. Refresh it to confirm the current price and availability.</Notice>}<ErrorNotice error={action.error} /><Button variant="primary" className="full-width" onClick={() => void purchase()} busy={action.pending} disabled={!termsReady || !acknowledged || expired || !available}>{actionName} for {money(quote.priceSnapshot.buyerTotalMinor ?? quote.priceSnapshot.buyerPriceMinor)}<ArrowRight size={16} /></Button><Button onClick={() => { setQuote(undefined); setPrepared(undefined); action.setError(undefined); }} disabled={action.pending}>{expired ? "Refresh quote" : "Edit inputs"}</Button><small className="muted">Quote expires {dateTime(quote.expiresAt)}.</small></div>}
    <div className="checkout-footer"><ShieldCheck size={15} /><span>Fixed price. Payment after validated delivery.</span></div></>;
}
export function SellerProfile({ id }: { id: string }) {
  const [cursors, setCursors] = useState<string[]>([]);
  const params = new URLSearchParams({ sellerId: id });
  if (cursors.length) params.set("cursor", cursors[cursors.length - 1]);
  const resource = useResource<CatalogPage>(`/capabilities/page?${params}`);
  const { config } = useApp();
  const items = resource.data?.items || [];
  const seller = items[0]?.seller;
  return <><Link className="back-link" href="/"><ArrowLeft size={15} />Marketplace</Link><PageHeading eyebrow="Seller profile" title={seller?.name || "Seller"} description={seller?.bio} /><ErrorNotice error={resource.error} retry={resource.refresh} />{resource.loading ? <Loading /> : items.length ? <><div className="section-header"><h2>Published capabilities</h2><span>{resource.data?.total} services</span></div><div className="capability-grid">{items.map(cap => <CapabilityCard key={cap.id} capability={cap} tiers={config?.priceTiers} />)}</div></> : !resource.error && <Empty title="No public capabilities" description="This seller has no publicly listed capabilities available." />}{resource.data && <CatalogPagination page={cursors.length} total={resource.data.total} next={resource.data.nextCursor} loading={resource.loading} previous={() => setCursors(cursors.slice(0, -1))} advance={() => { if (resource.data?.nextCursor) setCursors([...cursors, resource.data.nextCursor]); }} />}</>;
}
