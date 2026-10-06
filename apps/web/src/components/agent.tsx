"use client";
import { TermsAcceptance } from "./terms";
import { SynthesisControls, SynthesisResult } from "./agent-synthesis";
import { AgentConstraintFields, defaultAgentConstraints } from "./agent-constraints";
import { RecommendationRationale } from "./agent-recommendation";
import { AgentContractPreparation, AgentFileFields, AgentFileHistory } from "./agent-files";
import { requiredOutputFiles, type AgentContractMatch, type OutputFileDraft } from "../lib/agent-files";
import { ExplicitPlanRepair } from "./agent-repair";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, ArrowUpRight, CalendarClock, CheckCircle2, MessageSquareText, Plus, RefreshCw, Send } from "lucide-react";
import type { AgentMessage, AgentPlan, AgentRecommendation, AgentResponse, AgentSynthesis, AssetDTO, CapabilityDTO, Conversation } from "@/lib/types";
import { preferredCapabilityIds, recommendationFor } from "@/lib/agent-recommendations";
import { useAction, useResource } from "@/lib/hooks";
import { api, ApiError, post } from "@/lib/api";
import { dateTime, decimalToMinor, money } from "@/lib/format";
import { RequireAuth, useApp } from "./provider";
import { Button, ErrorNotice, Field, Loading, Notice, PageHeading, Status } from "./ui";
import { CapabilityCard } from "./marketplace";
import { Permissions } from "./permissions";
import { canRepairPlan, isUnavailablePlanError, planApprovalIssues, repairableSteps } from "@/lib/plans";

export function AgentPage() { return <RequireAuth><Agent /></RequireAuth>; }
function Agent() {
  const { config } = useApp();
  const conversations = useResource<Conversation[]>("/agent/conversations");
  const catalog = useResource<CapabilityDTO[]>("/capabilities");
  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [recommendations, setRecommendations] = useState<CapabilityDTO[]>([]);
  const [recommendationDetails, setRecommendationDetails] = useState<AgentRecommendation[]>([]);
  const [contractMatches, setContractMatches] = useState<AgentContractMatch[]>([]);
  const [inputAssetIds, setInputAssetIds] = useState<string[]>([]);
  const [inputAssets, setInputAssets] = useState<AssetDTO[]>([]);
  const [outputFiles, setOutputFiles] = useState<OutputFileDraft[]>([]);
  const [uploading, setUploading] = useState(false);
  const [fileFormKey, setFileFormKey] = useState(0);
  const [historyIds, setHistoryIds] = useState<string[] | null>(null);
  const [alternatives, setAlternatives] = useState<CapabilityDTO[]>([]);
  const [constraints, setConstraints] = useState(defaultAgentConstraints);
  const [message, setMessage] = useState("");
  const [budget, setBudget] = useState("20.00");
  const [timing, setTiming] = useState("IMMEDIATE");
  const [deadline, setDeadline] = useState("");
  const [mode, setMode] = useState("DISCOVERY");
  const [plan, setPlan] = useState<AgentPlan>();
  const [planId, setPlanId] = useState<string>();
  const action = useAction();
  const currentPlan = useResource<AgentPlan>(planId ? `/agent/plans/${planId}` : null, plan && ["COMPLETED", "FAILED", "CANCELLED"].includes(plan.status) ? 0 : 7000);
  useEffect(() => { const request = new URLSearchParams(window.location.search).get("request"); if (request) setMessage(request); }, []);
  useEffect(() => { if (currentPlan.data) setPlan(currentPlan.data); }, [currentPlan.data]);
  useEffect(() => { if (historyIds) setRecommendations(historyIds.map(id => catalog.data?.find(cap => cap.id === id)).filter((cap): cap is CapabilityDTO => Boolean(cap))); }, [catalog.data, historyIds]);
  function clearFiles() { setInputAssetIds([]); setInputAssets([]); setOutputFiles([]); setFileFormKey(key => key + 1); }
  async function send() {
    if (uploading || action.pending) return;
    const minor = decimalToMinor(budget);
    if (minor === null || minor < 0) { action.setError("Enter a valid maximum budget in USD."); return; }
    await action.run(async () => {
      if (timing === "DEADLINE" && (!deadline || Date.parse(deadline) <= Date.now())) throw new Error("Choose a future deadline.");
      const sent = message.trim();
      const perJob = constraints.perJob ? decimalToMinor(constraints.perJob) : undefined;
      if (constraints.perJob && (perJob === null || perJob === undefined || perJob < 0)) throw new Error("Enter a valid per-job limit.");
      const blockedSellers = constraints.blockedSellers.split(",").map(id => id.trim()).filter(Boolean);
      if (blockedSellers.some(id => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) || blockedSellers.length > 100) throw new Error("Blocked sellers must be up to 100 valid seller IDs.");
      const preferred = preferredCapabilityIds(constraints.preferredCapabilityIds);
      const requestedFiles = requiredOutputFiles(outputFiles);
      const response = await post<AgentResponse>("/agent/chat", { message: sent, ...(inputAssetIds.length ? { inputAssetIds } : {}), ...(requestedFiles ? { requiredOutputFiles: requestedFiles } : {}), timingMode: constraints.onlineOnly ? "IMMEDIATE" : timing, budgetMinor: minor, mode, allowScheduling: !constraints.onlineOnly && timing !== "IMMEDIATE" && constraints.allowScheduling, maxJobs: constraints.maxJobs, blockedSellers, noNetwork: constraints.noNetwork, onlineOnly: constraints.onlineOnly, ...(preferred.length ? { preferredCapabilityIds: preferred } : {}), maxQueueWaitSeconds: !constraints.onlineOnly && timing === "IMMEDIATE" ? constraints.maxQueueWait : 0, ...(perJob !== undefined ? { maxPerJobSpendMinor: perJob } : {}), ...(constraints.minRating ? { minRating: Number(constraints.minRating) } : {}), ...(constraints.maxRuntime ? { maxRuntimeSeconds: Number(constraints.maxRuntime) } : {}), ...(constraints.outputs.length ? { outputTypes: constraints.outputs } : {}), ...(timing === "DEADLINE" && !constraints.onlineOnly ? { deadlineAt: new Date(deadline).toISOString() } : {}), ...(conversationId ? { conversationId } : {}) });
      setHistoryIds(null); setRecommendationDetails(response.recommendationDetails || []); setContractMatches(response.contractMatches || []);
      setConversationId(response.conversationId); setMessages(items => [...items, { role: "user", content: sent, inputAssetIds, requiredOutputFiles: requestedFiles }, { role: "assistant", contractMatches: response.contractMatches, content: response.message, planId: response.plan?.id, capabilityIds: response.recommendations.map(cap => cap.id), recommendationDetails: response.recommendationDetails }]); setRecommendations(response.recommendations); setAlternatives(response.timingAlternatives || []); setPlan(response.plan); setPlanId(response.plan?.id); setMessage(""); clearFiles(); conversations.refresh();
    });
  }
  function selectConversation(conversation: Conversation) {
    clearFiles(); setConversationId(conversation.id); setMessages(conversation.messages || []); setRecommendations([]); setAlternatives([]); setPlan(undefined);
    const savedPlan = conversation.plan?.id || [...(conversation.messages || [])].reverse().find(item => item.planId)?.planId;
    setPlanId(savedPlan); action.setError(undefined);
    const saved = [...(conversation.messages || [])].reverse().find(item => item.role === "assistant" && (item.capabilityIds !== undefined || item.recommendationDetails !== undefined));
    setRecommendationDetails(saved?.recommendationDetails || []); setContractMatches(saved?.contractMatches || []);
    setHistoryIds([...new Set(saved?.capabilityIds || saved?.recommendationDetails?.map(detail => detail.capabilityId) || [])]);
  }
  return <><PageHeading eyebrow="Marketplace agent" title="What do you need done?" description="Find services for a task, compare the options, or review a plan." actions={<Button onClick={() => { setConversationId(undefined); setMessages([]); setPlan(undefined); setPlanId(undefined); setRecommendations([]); setRecommendationDetails([]); setContractMatches([]); clearFiles(); setHistoryIds(null); setAlternatives([]); setMessage(""); action.setError(undefined); }} disabled={action.pending || uploading}><Plus size={16} />New request</Button>} /><div className="agent-layout"><div className="agent-main">
    <form className="request-form" onSubmit={event => { event.preventDefault(); void send(); }}><label htmlFor="agent-request">Your request</label><textarea id="agent-request" value={message} onChange={event => setMessage(event.target.value)} required maxLength={12000} placeholder="Describe your goal, the inputs you have, and the result you need." disabled={action.pending} /><div className="request-controls"><Field label="Maximum budget (USD)"><input value={budget} onChange={event => setBudget(event.target.value)} inputMode="decimal" required /></Field><Field label="Execution timing"><select value={timing} disabled={constraints.onlineOnly} onChange={event => setTiming(event.target.value)}><option value="IMMEDIATE">Available now</option><option value="EARLIEST_AVAILABLE_ALLOWED">Earliest availability</option><option value="DEADLINE">By a deadline</option></select></Field><Field label="Request mode"><select value={mode} onChange={event => setMode(event.target.value)}><option value="DISCOVERY">Recommend services</option><option value="PLAN">Prepare a plan</option></select></Field>{timing === "DEADLINE" && <Field label="Deadline (your local time)"><input type="datetime-local" value={deadline} onChange={event => setDeadline(event.target.value)} required /></Field>}<Button variant="primary" type="submit" busy={action.pending} disabled={!message.trim() || uploading}><Send size={15} />{mode === "PLAN" ? "Prepare plan" : "Find services"}</Button></div><AgentConstraintFields value={constraints} onChange={value => { setConstraints(value); if (value.onlineOnly) setTiming("IMMEDIATE"); }} scheduled={timing !== "IMMEDIATE"} /><AgentFileFields key={fileFormKey} ids={inputAssetIds} assets={inputAssets} outputs={outputFiles} onIds={setInputAssetIds} onAssets={setInputAssets} onOutputs={setOutputFiles} onBusy={setUploading} disabled={action.pending} /></form><ErrorNotice error={action.error} />
    {action.pending && <div role="status" className="notice"><MessageSquareText size={17} />Finding matching capabilities and checking your constraints...</div>}
    {messages.map((item, index) => <article className={`conversation-entry ${item.role}`} key={`${conversationId}-${index}`}><span>{item.role === "user" ? "Your request" : "Kivro"}</span>{item.synthesis ? <SynthesisResult result={item.synthesis} /> : <p>{item.content || item.message}</p>}{item.role === "user" && <AgentFileHistory ids={item.inputAssetIds} outputs={item.requiredOutputFiles} />}</article>)}
    <ErrorNotice error={currentPlan.error} retry={currentPlan.refresh} />{currentPlan.loading && <Loading text="Loading plan" rows={0} />}{plan && <Plan plan={plan} onSynthesis={result => { setMessages(items => [...items, { role: "assistant", synthesis: result }]); conversations.refresh(); }} catalog={[...(catalog.data || []), ...recommendations]} onApproved={result => { setPlan(result); setPlanId(result.id); currentPlan.refresh(); conversations.refresh(); }} />}
    {(recommendations.length > 0 || recommendationDetails.length > 0) && <><div className="section-header"><h2>{historyIds ? "Saved recommendations" : "Recommended capabilities"}</h2></div><div className="agent-recommendations">{recommendations.map(cap => <div className="agent-recommendation" key={cap.id}><CapabilityCard capability={cap} tiers={config?.priceTiers} /><RecommendationRationale capability={cap} detail={recommendationFor(cap, recommendationDetails)} />{contractMatches.filter(match => match.capabilityId === cap.id).slice(0, 1).map(match => <AgentContractPreparation key={match.capabilityVersionId} match={match} capability={cap} />)}</div>)}{historyIds && recommendationDetails.filter(detail => !recommendations.some(cap => cap.id === detail.capabilityId)).map(detail => <article className="recommendation-archive" key={`${detail.capabilityId}:${detail.capabilityVersionId}`}><Link className="strong-link" href={`/capabilities/${detail.capabilityId}`}><h3>{detail.capabilityTitle}</h3></Link><RecommendationRationale detail={detail} /></article>)}</div></>}
    {alternatives.length > 0 && <section className="page-section"><h2>Future availability alternatives</h2><p className="small muted">These options have not been scheduled or purchased. Change your timing preference and explicitly allow scheduling to request a new plan.</p><div className="agent-recommendations">{alternatives.map(cap => <CapabilityCard key={cap.id} capability={cap} tiers={config?.priceTiers} />)}</div></section>}
    {!messages.length && !action.pending && <div className="page-section"><div className="row muted"><CheckCircle2 size={17} /><p className="small">No jobs are purchased until you choose a service or approve a plan.</p></div></div>}
  </div><aside className="agent-sidebar"><h2>Recent requests</h2><ErrorNotice error={conversations.error} retry={conversations.refresh} />{conversations.loading ? <Loading text="Loading requests" rows={0} /> : conversations.data?.length ? conversations.data.map(conversation => <button className="conversation-button" key={conversation.id} aria-pressed={conversationId === conversation.id} disabled={action.pending || uploading} onClick={() => selectConversation(conversation)}>{conversation.title || conversation.messages?.find(item => item.role === "user")?.content?.slice(0,100) || "Marketplace request"}<small>{dateTime(conversation.createdAt)}</small></button>) : !conversations.error && <p className="small muted">Your requests will be saved here.</p>}<div className="page-section"><Link href="/" className="text-link">Browse marketplace<ArrowRight size={14} /></Link></div></aside></div></>;
}
function Plan({ plan, catalog, onApproved, onSynthesis }: { plan: AgentPlan; catalog: CapabilityDTO[]; onApproved: (plan: AgentPlan) => void; onSynthesis: (result: AgentSynthesis) => void }) {
  const [consent, setConsent] = useState(false);
  const [termsReady, setTermsReady] = useState(false);
  const [repairedRevision, setRepairedRevision] = useState<number>();
  const repair = useAction();
  const [repairStep, setRepairStep] = useState<string>();
  const [repairReason, setRepairReason] = useState("");
  const [repairQuery, setRepairQuery] = useState("");
  const repairTarget = repairStep || repairableSteps(plan)[0]?.id;
  const action = useAction();
  const [now, setNow] = useState(Date.now);
  const [verifiedCapabilities, setVerifiedCapabilities] = useState<CapabilityDTO[]>([]);
  const [metadataError, setMetadataError] = useState<string>();
  const [unavailableCode, setUnavailableCode] = useState<string>();
  const reviewPlan = unavailableCode ? { ...plan, error: unavailableCode } : plan;
  const [checking, setChecking] = useState(true);
  const serviceIds = [...new Set(plan.steps.filter(step => !step.jobId).map(step => step.capabilityId))].sort().join(",");
  useEffect(() => {
    const controller = new AbortController(); setChecking(true); setMetadataError(undefined); setVerifiedCapabilities([]); setUnavailableCode(undefined);
    Promise.all(serviceIds.split(",").filter(Boolean).map(id => api<CapabilityDTO>(`/capabilities/${id}`, { signal: controller.signal }))).then(capabilities => {
      if (controller.signal.aborted) return;
      setVerifiedCapabilities(capabilities);
      if (plan.steps.some(step => !step.jobId && !capabilities.some(cap => cap.id === step.capabilityId && cap.versionId === step.capabilityVersionId))) setUnavailableCode("CAPABILITY_VERSION_UNAVAILABLE");
    }).catch(error => { if (!controller.signal.aborted) { setMetadataError(error instanceof Error ? error.message : "Service details could not be loaded."); if (error instanceof ApiError && error.status === 404) setUnavailableCode("CAPABILITY_NOT_FOUND"); } }).finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [serviceIds, plan.id, plan.revision]);
  useEffect(() => { setConsent(false); setRepairStep(undefined); }, [plan.id, plan.revision]);
  useEffect(() => { const interval = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(interval); }, []);
  const awaiting = plan.status === "AWAITING_APPROVAL";
  const approvalIssues = planApprovalIssues(reviewPlan, verifiedCapabilities, now);
  const newPurchaseMinor = plan.steps.filter(step => !step.jobId).reduce((sum, step) => sum + step.quote.amountMinor, 0);
  const priorSpendMinor = plan.estimatedCostMinor - newPurchaseMinor;
  return <section className="plan"><div className="plan-header"><div><h2>{awaiting ? "Proposed plan" : "Execution plan"}</h2><small className="muted">Revision {plan.revision}</small></div><Status value={plan.status} /></div><p className="small muted">{plan.goal}</p><ol className="plan-steps">{plan.steps.map((step, index) => {
    const cap = verifiedCapabilities.find(item => item.id === step.capabilityId) || catalog.find(item => item.id === step.capabilityId);
    return <li key={step.id}><span>{index + 1}</span><div><Link href={`/capabilities/${step.capabilityId}`} className="strong-link"><h3>{cap?.title || `Capability ${step.capabilityId.slice(0,8)}`}</h3></Link><p>Earliest execution: {dateTime(step.quote.earliestStartAt)}</p><p>Estimated result: {dateTime(step.quote.estimatedDeliveryAt)}</p>{step.dependsOn.length > 0 && <p>After {step.dependsOn.map(id => `step ${plan.steps.findIndex(item => item.id === id) + 1}`).join(", ")}</p>}<Status value={step.status} />{step.error && <Notice tone="danger">{step.error}</Notice>}<details><summary>Paid service, permissions & inputs</summary><small className="mono">Pinned version: {step.capabilityVersionId}</small>{cap?.versionId === step.capabilityVersionId ? <Permissions permissions={cap.permissions} /> : <p>Permissions for this pinned version are unavailable.</p>}<pre>{JSON.stringify(step.inputMapping, null, 2)}</pre></details>{step.jobId && <Link className="text-link" href={`/jobs/${step.jobId}`}>View job & results<ArrowUpRight size={13} /></Link>}</div><strong>{money(step.quote.amountMinor)}</strong></li>;
  })}</ol><div className="plan-total"><div>Estimated total<strong className="field-hint">{money(plan.estimatedCostMinor)}</strong></div>{priorSpendMinor > 0 && <div>Prior work & attempts<strong className="field-hint">{money(priorSpendMinor)}</strong></div>}<div>New purchases<strong className="field-hint">{money(newPurchaseMinor)}</strong></div><div>Maximum approved budget<strong className="field-hint">{money(plan.constraints.maxTotalSpendMinor)}</strong></div></div><div className="row small muted"><CalendarClock size={15} />Estimated completion: {dateTime(plan.estimatedCompletionAt)}</div>{plan.timing.mode !== "IMMEDIATE" && <Notice>This plan permits scheduled services. Execution times are earliest eligibility estimates.</Notice>}{plan.error && <Notice tone="danger">{plan.error}</Notice>}
    {canRepairPlan(reviewPlan) && <div className="page-section"><Notice tone="warning">A selected service failed or became unavailable. Repair searches for a replacement without rerunning completed work. Completed jobs and their results remain attached. Failed purchased attempts remain in the history and budget accounting. A new revision needs your approval before further purchases.</Notice><div className="stack"><Field label="Step to repair"><select value={repairTarget || ""} onChange={event => setRepairStep(event.target.value)}>{repairableSteps(plan).map(step => <option key={step.id} value={step.id}>{catalog.find(cap => cap.id === step.capabilityId)?.title || step.capabilityId} / {step.status.toLowerCase()}</option>)}</select></Field><Field label="Reason for repair"><textarea value={repairReason} onChange={event => setRepairReason(event.target.value)} maxLength={1000} placeholder="What failed or became unavailable?" /></Field><Field label="Alternative search (optional)"><input value={repairQuery} onChange={event => setRepairQuery(event.target.value)} maxLength={500} /></Field><ErrorNotice error={repair.error} /><Button busy={repair.pending} disabled={action.pending || !repairTarget || !repairReason.trim()} onClick={() => void repair.run(async () => {
      setConsent(false);
      const result = await post<AgentPlan>(`/agent/plans/${plan.id}/replan`, { expectedRevision: plan.revision, stepId: repairTarget, reason: repairReason.trim(), ...(repairQuery.trim() ? { query: repairQuery.trim() } : {}) });
      if (result.id !== plan.id || result.revision <= plan.revision || result.status !== "AWAITING_APPROVAL") throw new Error("Repair did not return a new reviewable revision. Refresh the plan before continuing.");
      setRepairedRevision(result.revision); onApproved(result);
    })}><RefreshCw size={15} />Request plan repair</Button></div></div>}
    {canRepairPlan(reviewPlan) && <ExplicitPlanRepair key={`repair:${plan.id}:${plan.revision}`} plan={plan} onRepaired={result => { setConsent(false); setRepairedRevision(result.revision); onApproved(result); }} />}
    {repairedRevision !== undefined && awaiting && <Notice tone="success">Revision {repairedRevision} is ready for review. No new purchases were authorized by the repair request.</Notice>}
    {awaiting && <div className="plan-approval"><Notice>Approval authorizes only these paid services within this budget. Successfully delivered steps can remain charged if a later step fails.</Notice>{checking ? <Loading text="Checking quoted service versions" rows={0} /> : <><ErrorNotice error={metadataError} />{approvalIssues.length > 0 && <Notice tone="warning"><ul>{approvalIssues.map(issue => <li key={issue}>{issue}</li>)}</ul></Notice>}</>}<TermsAcceptance onReady={setTermsReady} /><label className="checkbox-row align-start"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /><span>I approve the services, permissions, timing and maximum budget shown in this plan.</span></label><ErrorNotice error={action.error} /><Button variant="primary" disabled={!termsReady || !consent || repair.pending || checking || Boolean(metadataError) || approvalIssues.length > 0} busy={action.pending} onClick={() => void action.run(async () => {
      try { const result = await post<AgentPlan>(`/agent/plans/${plan.id}/approve`, { expectedRevision: plan.revision }); onApproved(result); }
      catch (error) { if (error instanceof ApiError && isUnavailablePlanError(error.code)) { setUnavailableCode(error.code); setConsent(false); } throw error; }
    })}>{priorSpendMinor > 0 ? "Approve remaining work" : "Approve & run"} / {money(newPurchaseMinor)}<ArrowRight size={15} /></Button></div>}
    {Boolean(plan.retainedWork?.length) && <details className="page-section"><summary>Retained result provenance</summary>{plan.retainedWork!.map(work => <div className="audit-row" key={work.stepId}><div><Link className="text-link" href={`/jobs/${work.jobId}`}>View retained result<ArrowUpRight size={13} /></Link><p className="small mono">Step: {work.stepId}</p><p className="small mono">Output SHA-256: {work.outputHash}</p></div></div>)}</details>}
    {Boolean(plan.retiredSteps?.length) && <div className="page-section"><h3>Previous attempts</h3>{plan.retiredSteps!.map(step => <div className="integration-row" key={step.id}><div><strong>{catalog.find(cap => cap.id === step.capabilityId)?.title || step.capabilityId}</strong><small className="mono">Pinned version: {step.capabilityVersionId}</small><Status value={step.status} />{step.error && <p className="small">{step.error}</p>}</div>{step.jobId && <Link className="text-link" href={`/jobs/${step.jobId}`}>View original job<ArrowUpRight size={13} /></Link>}</div>)}</div>}
    {Boolean(plan.repairHistory?.length) && <details className="page-section"><summary>Repair history</summary>{plan.repairHistory!.map(entry => <div className="audit-row" key={entry.id}><div><strong>After revision {entry.previous.revision}</strong><p>{entry.reason}</p><p>Committed {money(entry.committedSpendMinor)} / Remaining budget {money(entry.remainingBudgetMinor)}</p></div><time>{dateTime(entry.createdAt)}</time></div>)}</details>}
    <SynthesisControls key={`synthesis:${plan.id}:${plan.revision}`} plan={plan} onResult={onSynthesis} />
    {plan.status === "COMPLETED" && <Notice tone="success">All plan steps completed. Provider outputs and their provenance are available through the job links above.</Notice>}
  </section>;
}
