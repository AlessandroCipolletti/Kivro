import { z } from 'zod';
import type { Dependency, JobOffer } from '@kivro/contracts';
import { readFileLimits } from '@kivro/contracts/file-limits';
import { ResearchBroker, BraveSearchProvider, ConnectorRegistry, compilePublicResearchPlan, prefetchPublicResearchTools, PublicResearchReferenceSchema, SafeHttpClient, NetworkPolicyError, type EgressGrant, type ConnectorDefinition, type ResearchContext, type CompiledPublicResearchPlan, type HttpTransport, type WebSearchProvider } from '@kivro/research-broker';
import type { WorkerState } from './state.ts';
import type { SecretStore } from './secrets.ts';
import { createResourceBroker } from './resource-config.ts';
import { selectedConnectors, connectorDefinition } from './connectors.ts';
import { needsSellerAuthority, privateResearch, researchPolicy, selectedResearchConsent } from './research-config.ts';
import { researchAccounting, recordResearchPage } from './research-usage.ts';
import { ResearchFileStore } from './research-files.ts';
import { selectedResearchScanner } from './research-scanner.ts';

export interface ResourceExecutor { execute(request: { jobId: string; resourceId: string; operation: string; input: unknown; permissions: JobOffer['permissions']; dependencies: Dependency[] }, signal?: AbortSignal): Promise<unknown>; close(): void }
export class JobToolBroker {
  readonly usedResources = new Set<string>();
  readonly usedResourceOperations = new Map<string, Set<string>>();
  private paused = false; private stopped = false; private active?: Promise<unknown>;
  private readonly controller: AbortController;
  private readonly networkController: AbortController;
  private networkTimer?: ReturnType<typeof setTimeout>;
  private networkDeadline = Infinity;
  private readonly research: ResearchBroker;
  private readonly connectors: ConnectorRegistry;
  private readonly context?: ResearchContext;
  private readonly plan?: CompiledPublicResearchPlan;
  private readonly consentState: WorkerState;
  private prelude = false;
  private preludeAttempted = false;
  private cachedResearch?: Awaited<ReturnType<typeof prefetchPublicResearchTools>>;
  private researchFiles?: ResearchFileStore;
  private readonly downloads = new Map<string, Awaited<ReturnType<ResearchFileStore['download']>>>();
  constructor(readonly offer: JobOffer, readonly state: WorkerState, readonly dependencies: Dependency[], searchProvider?: WebSearchProvider, readonly resourceBroker?: ResourceExecutor, connectors: ConnectorDefinition[] = [], options: { consentState?: WorkerState; http?: HttpTransport; controller?: AbortController; networkController?: AbortController } = {}) {
    this.controller = options.controller ?? new AbortController(); this.networkController = options.networkController ?? new AbortController(); this.consentState = options.consentState ?? state;
    if (needsSellerAuthority(offer.permissions)) {
      if (!z.string().uuid().safeParse(offer.sellerId).success) throw new Error('AUTHENTICATED_SELLER_REQUIRED');
      this.context = { userId: offer.sellerId!, jobId: offer.jobId, capabilityVersionId: offer.capabilityVersionId, attemptId: offer.attemptId };
      const consent = selectedResearchConsent(this.consentState, offer, offer.sellerId);
      if (consent) this.plan = compilePublicResearchPlan({ plan: consent.plan, scope: { ...this.context, attemptId: offer.attemptId }, approvedPlanHash: consent.planHash, approvedDependencyBindingHash: consent.dependencyBindingHash, expiresAt: new Date(state.attempt(offer.jobId)?.deadline ?? 0).toISOString() });
    }
    const authorize = async (requested: ResearchContext): Promise<EgressGrant> => {
      this.assertActive();
      const context = this.networkContext();
      if (requested.jobId !== context.jobId || requested.userId !== context.userId || requested.capabilityVersionId !== context.capabilityVersionId || requested.attemptId !== context.attemptId) throw new Error('BROKER_JOB_BINDING_MISMATCH');
      if (this.plan && selectedResearchConsent(this.consentState, offer, offer.sellerId)?.planHash !== this.plan.planHash) throw new Error('RESEARCH_CONSENT_MISMATCH');
      const grant: EgressGrant = { policy: researchPolicy(offer.permissions, connectors.map(item => item.id)), dataClasses: !privateResearch(offer) && !offer.assets.length ? ['PUBLIC'] : offer.permissions.resources.length ? ['BUYER_PRIVATE', 'SELLER_PRIVATE'] : ['BUYER_PRIVATE'], publicResearch: this.prelude ? this.plan : undefined };
      return grant;
    };
    const baseAccounting = this.context ? researchAccounting(state, this.context, () => this.assertActive()) : { reserve: async () => { throw new Error('NETWORK_NOT_AUTHORIZED'); }, finish: async () => { throw new Error('NETWORK_NOT_AUTHORIZED'); } };
    const accounting: typeof baseAccounting = { ...baseAccounting, reserve: async request => {
      if (this.networkController.signal.aborted) throw new NetworkPolicyError('NETWORK_CANCELLED');
      const id = await baseAccounting.reserve(request);
      const started = request.operation === 'CONNECTOR' ? state.get<{ started: number }>(`connectorUsage:${offer.jobId}`)!.started : state.get<{ startedAtMs: number }>(`research:${offer.jobId}`)!.startedAtMs;
      this.networkDeadline = Math.min(this.networkDeadline, started + request.policy.maxDurationMs, state.attempt(offer.jobId)!.deadline);
      clearTimeout(this.networkTimer);
      if (Date.now() >= this.networkDeadline) { this.networkController.abort(); throw new NetworkPolicyError('NETWORK_CANCELLED'); }
      this.networkTimer = setTimeout(() => this.networkController.abort(), this.networkDeadline - Date.now()); this.networkTimer.unref();
      return id;
    } };
    const audit = async (event: { code: string }) => { state.audit(`RESEARCH_${/^[A-Z][A-Z0-9_]{0,99}$/.test(event.code) ? event.code : 'FAILED'}`, 'BROKER', offer.jobId); };
    const http = options.http ?? new SafeHttpClient({ signal: this.networkController.signal });
    this.research = new ResearchBroker({ accounting, searchProvider, authorize, http, audit });
    this.connectors = new ConnectorRegistry({ accounting, authorize, http, audit });
    for (const connector of connectors) this.connectors.register(connector);
  }
  static async create(offer: JobOffer, state: WorkerState, secrets: SecretStore, dependencies: Dependency[], resourceBroker?: ResourceExecutor, consentState = state): Promise<JobToolBroker> {
    if (needsSellerAuthority(offer.permissions) && !z.string().uuid().safeParse(offer.sellerId).success) throw new Error('AUTHENTICATED_SELLER_REQUIRED');
    if (offer.permissions.tools.includes('research.search') && !dependencies.some(dep => dep.type === 'CREDENTIAL' && dep.approved && dep.healthy && dep.supported === true && dep.grants?.credentialRefs?.includes('research-brave'))) throw new Error('RESEARCH_CREDENTIAL_CONSENT_REQUIRED');
    const controller = new AbortController(), networkController = new AbortController(), http = new SafeHttpClient({ signal: networkController.signal });
    const search = offer.permissions.tools.includes('research.search') ? new BraveSearchProvider(await secrets.get('research-brave'), http) : undefined;
    const connectors = selectedConnectors(state, offer.permissions, dependencies).map(config => connectorDefinition(config, secrets));
    return new JobToolBroker(offer, state, dependencies, search, resourceBroker ?? createResourceBroker(state, secrets, { capabilityVersionId: offer.capabilityVersionId, permissions: offer.permissions, dependencies }), connectors, { consentState, controller, networkController, http });
  }
  private assertActive(preparing = false): void {
    const attempt = this.state.attempt(this.offer.jobId);
    if (this.paused || this.stopped || this.controller.signal.aborted || attempt?.attemptId !== this.offer.attemptId || !['RUNNING', ...(this.prelude || preparing ? ['ACCEPTED'] : [])].includes(attempt.state)) throw new Error('TOOL_EXECUTION_PAUSED');
    if (Date.now() >= attempt.deadline) throw new Error('TIMED_OUT');
    if (this.plan && selectedResearchConsent(this.consentState, this.offer, this.offer.sellerId)?.planHash !== this.plan.planHash) throw new Error('RESEARCH_CONSENT_MISMATCH');
  }
  private networkContext(): ResearchContext { if (!this.context) throw new Error('AUTHENTICATED_SELLER_REQUIRED'); return this.context; }
  researchTools(): { searchSourceIds: readonly string[]; fetchSourceIds: readonly string[]; downloadSourceIds?: readonly string[] } | undefined {
    return this.plan ? { searchSourceIds: this.plan.searchSourceIds, fetchSourceIds: this.plan.fetchSourceIds, ...(this.plan.downloadSourceIds.length ? { downloadSourceIds: this.plan.downloadSourceIds } : {}) } : undefined;
  }
  downloadedFiles() { return this.researchFiles?.descriptors() ?? []; }
  async installResearchFiles(inputDir: string): Promise<void> { this.assertActive(true); await this.researchFiles?.install(inputDir, this.controller.signal); this.assertActive(true); }
  async preparePublicResearch(jobRoot?: string): Promise<void> {
    if (!this.plan) return;
    if (this.preludeAttempted || this.active) throw new Error('RESEARCH_PRELUDE_ALREADY_ATTEMPTED');
    if (this.state.attempt(this.offer.jobId)?.state !== 'ACCEPTED') throw new Error('RESEARCH_PRELUDE_BEFORE_PRIVATE_EXECUTION_REQUIRED');
    this.preludeAttempted = true; this.prelude = true;
    this.active = (async () => {
      this.cachedResearch = await prefetchPublicResearchTools({ broker: this.research, context: this.networkContext(), plan: this.plan!, assertActive: async () => this.assertActive() });
      if (this.plan!.downloadSourceIds.length) {
        if (!jobRoot || !this.offer.permissions.network.downloads) throw new Error('RESEARCH_DOWNLOAD_GRANT_REQUIRED');
        const platform = readFileLimits(process.env);
        const inputLimit = Math.min(platform.inputBytes, this.offer.permissions.limits.maxInputBytes);
        let total = this.offer.assets.reduce((sum, asset) => sum + asset.sizeBytes, Buffer.byteLength(JSON.stringify(this.offer.input)));
        const remaining = inputLimit - total;
        if (remaining < 1) throw new Error('RESEARCH_INPUT_LIMIT');
        const approved = this.offer.permissions.network.downloads;
        this.researchFiles = new ResearchFileStore(jobRoot, {
          ...approved,
          maxFileBytes: Math.min(approved.maxFileBytes, approved.maxTotalBytes, platform.workerFileBytes, remaining),
          maxTotalBytes: Math.min(approved.maxTotalBytes, remaining),
        }, selectedResearchScanner(this.consentState));
        for (const sourceId of this.plan!.downloadSourceIds) {
          this.assertActive();
          const result = await this.researchFiles.download(sourceId, sink => this.research.downloadPublic(this.networkContext(), { reviewedSourceId: sourceId }, sink), this.networkController.signal,
            () => Math.min(this.networkDeadline, this.state.attempt(this.offer.jobId)!.deadline));
          this.assertActive(); total += result.descriptor.sizeBytes;
          if (total > inputLimit) throw new Error('RESEARCH_INPUT_LIMIT');
          this.downloads.set(sourceId, result);
          this.state.set(`researchFile:${this.offer.jobId}:${sourceId}`, { descriptor: result.descriptor, scan: result.scan, provenance: result.provenance });
          this.state.audit('RESEARCH_FILE_SCANNED', 'BROKER', this.offer.jobId);
        }
      }
    })();
    try {
      await this.active; this.assertActive();
      for (const reviewedSourceId of this.plan.fetchSourceIds) recordResearchPage(this.state, this.networkContext(), await this.cachedResearch!.fetchPublic({ reviewedSourceId }), reviewedSourceId);
    }
    catch (error) { this.cachedResearch = undefined; this.downloads.clear(); this.researchFiles?.clear(); throw error; }
    finally { this.prelude = false; this.active = undefined; }
  }
  async execute(name: string, raw: Record<string, unknown>): Promise<unknown> {
    this.assertActive(); if (this.active || !this.offer.permissions.tools.includes(name)) throw new Error('TOOL_NOT_AUTHORIZED');
    this.active = this.dispatch(name, raw);
    try { const result = await this.active; if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error('TOOL_RESULT_TOO_LARGE'); return result; }
    finally { this.active = undefined; }
  }
  private async dispatch(name: string, raw: Record<string, unknown>): Promise<unknown> {
    if (name === 'research.download') {
      const { reviewedSourceId } = PublicResearchReferenceSchema.parse(raw), result = this.downloads.get(reviewedSourceId);
      if (!this.plan || !this.cachedResearch || !result) throw new Error('RESEARCH_DOWNLOAD_CACHE_MISS');
      return structuredClone(result);
    }
    if (name === 'research.search' || name === 'research.fetch') {
      if (this.plan) {
        if (!this.cachedResearch) throw new Error('RESEARCH_PRELUDE_REQUIRED');
        return name === 'research.search' ? this.cachedResearch.searchPublic(raw) : this.cachedResearch.fetchPublic(raw);
      }
      if (name === 'research.search') return this.research.search(this.networkContext(), raw);
      const result = await this.research.fetch(this.networkContext(), raw); recordResearchPage(this.state, this.networkContext(), result); return result;
    }
    if (name === 'connector.call') {
      const request = z.object({ connectorId: z.string(), input: z.record(z.unknown()) }).strict().parse(raw);
      return this.connectors.execute(this.networkContext(), request.connectorId, request.input);
    }
    if (name === 'resource.read') {
      const request = z.object({ resourceId: z.string() }).strict().parse(raw);
      if (!this.offer.permissions.resources.some(resource => resource.id === request.resourceId && resource.type === 'LOCAL_FILE')) throw new Error('RESOURCE_NOT_AUTHORIZED');
      if (!this.resourceBroker) throw new Error('RESOURCE_BROKER_NOT_CONFIGURED');
      const result = await this.resourceBroker.execute({ jobId: this.offer.jobId, resourceId: request.resourceId, operation: 'read', input: { selectionId: request.resourceId }, permissions: this.offer.permissions, dependencies: this.dependencies }, this.controller.signal);
      this.usedResources.add(request.resourceId); this.usedResourceOperations.set(request.resourceId, new Set([...(this.usedResourceOperations.get(request.resourceId) ?? []), 'read'])); return result;
    }
    if (name === 'resource.query') {
      const request = z.object({ resourceId: z.string(), operation: z.string().min(1).max(100), input: z.record(z.unknown()) }).strict().parse(raw);
      if (!this.resourceBroker) throw new Error('RESOURCE_BROKER_NOT_CONFIGURED');
      const result = await this.resourceBroker.execute({ ...request, jobId: this.offer.jobId, permissions: this.offer.permissions, dependencies: this.dependencies }, this.controller.signal);
      this.usedResources.add(request.resourceId); this.usedResourceOperations.set(request.resourceId, new Set([...(this.usedResourceOperations.get(request.resourceId) ?? []), request.operation])); return result;
    }
    throw new Error('UNSUPPORTED_BROKER_OPERATION');
  }
  async pause(): Promise<void> { this.paused = true; try { await this.active; } catch { /* Bounded operation failure propagates to its caller. */ } }
  resume(): void { if (this.stopped) throw new Error('BROKER_CANCELLED'); this.paused = false; }
  cancel(): void { this.stopped = true; this.paused = true; clearTimeout(this.networkTimer); this.networkController.abort(); this.controller.abort(); this.resourceBroker?.close(); this.researchFiles?.clear(); }
}
