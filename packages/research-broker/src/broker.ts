import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';
import type { Writable } from 'node:stream';
import { z } from 'zod';
import { NetworkPolicyError, parsePublicUrl, SafeHttpClient, type HttpTransport } from './egress.js';
import { narrowResearchPolicy, ResearchPolicySchema, type ResearchPolicy } from './policy.js';
import { resolvePublicResearchRequest, type CompiledPublicResearchPlan } from './public-requests.js';
import { FetchRequestSchema, SearchRequestSchema, DownloadRequestSchema } from './requests.js';
export { ResearchPolicySchema, type ResearchPolicy } from './policy.js';

export const DataClassSchema = z.enum(['PUBLIC', 'BUYER_PRIVATE', 'SELLER_PRIVATE', 'SECRET', 'UNKNOWN']);
export type DataClass = z.infer<typeof DataClassSchema>;
export interface ResearchContext { userId: string; jobId: string; capabilityVersionId: string; attemptId?: string }
export interface EgressGrant {
  policy: ResearchPolicy;
  /** Labels supplied by the trusted Resource Broker, never by model or buyer input. */
  dataClasses: readonly DataClass[];
  /** Trusted, reviewed request capability. Never deserialize a token from sandbox/model input. */
  publicResearch?: CompiledPublicResearchPlan;
}
export interface ResearchAccounting {
  /** Atomically reserve worst-case bytes and request count, enforcing job duration,
   * per-user/host rate and concurrency limits. Failure must throw before egress. */
  reserve(request: { context: ResearchContext; operation: 'SEARCH' | 'FETCH' | 'DOWNLOAD' | 'CONNECTOR';
    host: string; maxBytes: number; policy: ResearchPolicy }): Promise<string>;
  finish(id: string, result: { bytes: number; ok: boolean; code?: string; status?: number;
    contentType?: string; queryHash?: string; provider?: string; destinationHost?: string;
    publicPlanHash?: string; publicSourceId?: string; responseSha256?: string; contentBytes?: number }): Promise<void>;
}
export interface SearchResult { url: string; title: string; snippet: string; accessedAt: string; untrusted: true }
export interface WebSearchProvider {
  readonly id: string;
  readonly host: string;
  readonly maxResponseBytes: number;
  /** Custom providers must enforce the supplied transport bounds before reading their response. */
  search(request: { query: string; maxResults: number; locale?: string; freshness?: string },
    limits?: { maxResponseBytes: number; timeoutMs: number }): Promise<{ results: SearchResult[]; bytes: number }>;
}
export interface WebPageResult {
  finalUrl: string; title?: string; text: string; contentType: string; fetchedAt: string;
  sha256: string; bytes: number; untrusted: true;
}
export interface PublicDownloadResult {
  sourceId: string; publicPlanHash: string; finalUrl: string; destinationHost: string; contentType: string;
  fetchedAt: string; sha256: string; bytes: number; untrusted: true;
}

export function assertDataFlow(classes: readonly DataClass[], allowed: readonly DataClass[] = ['PUBLIC']): void {
  if (!classes.length || classes.some(value => !DataClassSchema.safeParse(value).success ||
    value === 'SECRET' || value === 'UNKNOWN' || !allowed.includes(value))) {
    throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
  }
}

export function readableText(html: string): { text: string; title?: string } {
  const chunks: string[] = []; const title: string[] = []; let hidden = 0; let inTitle = false;
  const suppressed = new Set(['script', 'style', 'noscript', 'iframe', 'object', 'svg', 'math', 'template']);
  const parser = new Parser({
    onopentag(name) { if (suppressed.has(name)) hidden++; if (name === 'title') inTitle = true; },
    ontext(value) { if (!hidden) { if (inTitle) title.push(value); else chunks.push(value); } },
    onclosetag(name) {
      if (suppressed.has(name)) hidden = Math.max(0, hidden - 1);
      if (name === 'title') inTitle = false;
      if (['p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'tr', 'section'].includes(name)) chunks.push('\n');
    },
  }, { decodeEntities: true });
  parser.end(html);
  const clean = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
  return { text: clean(chunks.join(' ')), title: clean(title.join(' ')).slice(0, 300) || undefined };
}

export class BraveSearchProvider implements WebSearchProvider {
  readonly id = 'brave'; readonly host = 'api.search.brave.com'; readonly maxResponseBytes = 1_000_000;
  constructor(private readonly apiKey: string, private readonly http: HttpTransport = new SafeHttpClient()) {
    if (!apiKey.trim()) throw new NetworkPolicyError('PROVIDER_UNAVAILABLE');
  }
  toJSON(): { id: string; configured: true } { return { id: this.id, configured: true }; }
  async search(request: { query: string; maxResults: number; locale?: string; freshness?: string },
    limits = { maxResponseBytes: this.maxResponseBytes, timeoutMs: 10000 }): Promise<{ results: SearchResult[]; bytes: number }> {
    const parsed = SearchRequestSchema.parse(request);
    const bounds = z.object({ maxResponseBytes: z.number().int().min(1).max(this.maxResponseBytes), timeoutMs: z.number().int().min(1).max(30000) }).strict().parse(limits);
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', parsed.query); url.searchParams.set('count', String(parsed.maxResults));
    if (parsed.locale) url.searchParams.set('search_lang', parsed.locale);
    if (parsed.freshness) url.searchParams.set('freshness', parsed.freshness);
    const response = await this.http.request({ url: url.href, httpsOnly: true, maxRedirects: 0,
      allowedDomains: [this.host], headers: { 'x-subscription-token': this.apiKey, accept: 'application/json' },
      maxBytes: bounds.maxResponseBytes, timeoutMs: bounds.timeoutMs, allowedContentTypes: ['application/json'] });
    if (response.status !== 200) throw new NetworkPolicyError('PROVIDER_UNAVAILABLE');
    let data: unknown;
    try { data = JSON.parse(response.body.toString('utf8')); } catch { throw new NetworkPolicyError('PROVIDER_UNAVAILABLE'); }
    const body = z.object({ web: z.object({ results: z.array(z.object({ url: z.string(), title: z.string(), description: z.string().optional() })) }).optional() }).parse(data);
    const accessedAt = new Date().toISOString();
    const results = (body.web?.results ?? []).slice(0, parsed.maxResults).flatMap(item => {
      try {
        const resultUrl = parsePublicUrl(item.url);
        return [{ url: resultUrl.href, title: readableText(item.title).text.slice(0, 300),
          snippet: readableText(item.description ?? '').text.slice(0, 2000), accessedAt, untrusted: true as const }];
      } catch { return []; }
    });
    return { results, bytes: response.bytesReceived ?? response.body.length };
  }
}

export interface BrokerOptions {
  authorize(context: ResearchContext): Promise<EgressGrant>;
  accounting: ResearchAccounting;
  searchProvider?: WebSearchProvider;
  http?: HttpTransport;
  audit?(event: { context: ResearchContext; operation: 'SEARCH' | 'FETCH' | 'DOWNLOAD' | 'CONNECTOR'; code: string; outcome: 'DENIED' | 'FAILED' }): Promise<void>;
}
export class ResearchBroker {
  private readonly http: HttpTransport;
  private inFlight = 0;
  constructor(private readonly options: BrokerOptions) { this.http = options.http ?? new SafeHttpClient(); }

  async search(context: ResearchContext, raw: unknown): Promise<SearchResult[]> {
    return this.auditFailure(context, 'SEARCH', () => this.searchAuthorized(context, raw));
  }
  async searchPublic(context: ResearchContext, raw: unknown): Promise<SearchResult[]> {
    return this.auditFailure(context, 'SEARCH', () => this.searchAuthorized(context, raw, true));
  }
  private async searchAuthorized(context: ResearchContext, raw: unknown, reviewed = false): Promise<SearchResult[]> {
    const grant = await this.options.authorize(context);
    const proof = reviewed ? resolvePublicResearchRequest(grant.publicResearch, context, 'SEARCH', raw) : undefined;
    const request = SearchRequestSchema.parse(proof?.request ?? raw);
    const policy = proof ? narrowResearchPolicy(grant.policy, proof.limits) : ResearchPolicySchema.parse(grant.policy);
    if (policy.mode !== 'PUBLIC_WEB_RESEARCH' || !policy.searchEnabled) throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
    if (!proof) assertDataFlow(grant.dataClasses);
    if (!policy.maxQueries) throw new NetworkPolicyError('NETWORK_BUDGET_EXCEEDED');
    const provider = this.options.searchProvider;
    if (!provider) throw new NetworkPolicyError('PROVIDER_UNAVAILABLE');
    const maxBytes = Math.min(provider.maxResponseBytes, policy.maxResponseBytes, policy.maxTotalBytes);
    return this.perform(context, policy, 'SEARCH', provider.host, maxBytes, async () => {
      const result = await provider.search(request, { maxResponseBytes: maxBytes, timeoutMs: Math.min(30000, policy.maxDurationMs) });
      return { value: result.results, bytes: result.bytes, queryHash: createHash('sha256').update(request.query).digest('hex'), provider: provider.id,
        ...(proof ? { publicPlanHash: proof.publicPlanHash, publicSourceId: proof.publicSourceId } : {}) };
    });
  }

  async fetch(context: ResearchContext, raw: unknown): Promise<WebPageResult> {
    return this.auditFailure(context, 'FETCH', () => this.fetchAuthorized(context, raw));
  }
  async fetchPublic(context: ResearchContext, raw: unknown): Promise<WebPageResult> {
    return this.auditFailure(context, 'FETCH', () => this.fetchAuthorized(context, raw, true));
  }
  private async fetchAuthorized(context: ResearchContext, raw: unknown, reviewed = false): Promise<WebPageResult> {
    const grant = await this.options.authorize(context);
    const proof = reviewed ? resolvePublicResearchRequest(grant.publicResearch, context, 'FETCH', raw) : undefined;
    const request = FetchRequestSchema.parse(proof?.request ?? raw);
    const policy = proof ? narrowResearchPolicy(grant.policy, proof.limits) : ResearchPolicySchema.parse(grant.policy);
    if (policy.mode !== 'PUBLIC_WEB_RESEARCH' || !policy.fetchEnabled) throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
    if (!proof) assertDataFlow(grant.dataClasses);
    if (!policy.maxPages) throw new NetworkPolicyError('NETWORK_BUDGET_EXCEEDED');
    const url = parsePublicUrl(request.url, { allowedDomains: policy.allowedDomains });
    const maxBytes = Math.min(policy.maxResponseBytes, policy.maxTotalBytes);
    return this.perform(context, policy, 'FETCH', url.hostname, maxBytes, async () => {
      const response = await this.http.request({ ...request, allowedDomains: policy.allowedDomains,
        ...(proof ? { httpsOnly: true } : {}),
        maxBytes, timeoutMs: Math.min(30000, policy.maxDurationMs), allowedContentTypes: policy.allowedContentTypes });
      if (response.status < 200 || response.status >= 300) throw new NetworkPolicyError('NETWORK_UNAVAILABLE');
      const contentType = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      const source = response.body.toString('utf8');
      const readable = contentType === 'text/html' ? readableText(source) : { text: source.replace(/\u0000/g, '') };
      return { value: { ...readable, finalUrl: response.finalUrl, contentType, fetchedAt: new Date().toISOString(),
        sha256: createHash('sha256').update(response.body).digest('hex'), bytes: response.body.length, untrusted: true as const },
      bytes: response.bytesReceived ?? response.body.length, status: response.status, contentType, destinationHost: new URL(response.finalUrl).hostname,
      ...(proof ? { publicPlanHash: proof.publicPlanHash, publicSourceId: proof.publicSourceId } : {}) };
    });
  }

  /** Host-only prefetch: the sink remains quarantined until host validation and scanning succeed. */
  async downloadPublic(context: ResearchContext, raw: unknown, sink: Writable): Promise<PublicDownloadResult> {
    return this.auditFailure(context, 'DOWNLOAD', async () => {
      const grant = await this.options.authorize(context);
      const proof = resolvePublicResearchRequest(grant.publicResearch, context, 'DOWNLOAD', raw);
      const request = DownloadRequestSchema.parse(proof.request), policy = narrowResearchPolicy(grant.policy, proof.limits);
      if (policy.mode !== 'PUBLIC_WEB_RESEARCH' || !policy.downloads?.allowedMimeTypes.includes(request.expectedMimeType) || !this.http.download) throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
      const url = parsePublicUrl(request.url, { httpsOnly: true, allowedDomains: policy.allowedDomains });
      const maxBytes = Math.min(policy.maxResponseBytes, policy.maxTotalBytes, policy.downloads.maxFileBytes, policy.downloads.maxTotalBytes);
      return this.perform(context, policy, 'DOWNLOAD', url.hostname, maxBytes, async () => {
        const response = await this.http.download!({ url: url.href, method: 'GET', httpsOnly: true, allowedDomains: policy.allowedDomains,
          allowedContentTypes: [request.expectedMimeType], maxBytes, timeoutMs: Math.min(30000, policy.maxDurationMs) }, sink);
        const contentType = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        if (response.status !== 200 || contentType !== request.expectedMimeType || !Number.isSafeInteger(response.contentBytes) || response.contentBytes < 1 || response.contentBytes > maxBytes || !/^[a-f0-9]{64}$/.test(response.sha256) || request.expectedSha256 && response.sha256 !== request.expectedSha256) throw new NetworkPolicyError('CONTENT_TYPE_DENIED');
        const destinationHost = new URL(response.finalUrl).hostname;
        return { value: { sourceId: proof.publicSourceId, publicPlanHash: proof.publicPlanHash, finalUrl: response.finalUrl, destinationHost,
          contentType, fetchedAt: new Date().toISOString(), sha256: response.sha256, bytes: response.contentBytes, untrusted: true as const },
          bytes: response.bytesReceived ?? response.contentBytes, status: response.status, contentType, destinationHost,
          publicPlanHash: proof.publicPlanHash, publicSourceId: proof.publicSourceId, responseSha256: response.sha256, contentBytes: response.contentBytes };
      });
    });
  }

  private async auditFailure<T>(context: ResearchContext, operation: 'SEARCH' | 'FETCH' | 'DOWNLOAD', action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      const code = error instanceof NetworkPolicyError ? error.code : error instanceof z.ZodError ? 'NETWORK_POLICY_DENIED' : 'NETWORK_UNAVAILABLE';
      await this.options.audit?.({ context, operation, code, outcome: code.endsWith('DENIED') || code === 'METHOD_NOT_ALLOWED' ? 'DENIED' : 'FAILED' });
      throw error;
    }
  }

  private async perform<T>(context: ResearchContext, policy: ResearchPolicy, operation: 'SEARCH' | 'FETCH' | 'DOWNLOAD',
    host: string, maxBytes: number, action: () => Promise<{ value: T; bytes: number; status?: number; contentType?: string; queryHash?: string; provider?: string;
      destinationHost?: string; publicPlanHash?: string; publicSourceId?: string; responseSha256?: string; contentBytes?: number }>): Promise<T> {
    if (this.inFlight >= 8 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > policy.maxTotalBytes) {
      throw new NetworkPolicyError('NETWORK_BUDGET_EXCEEDED');
    }
    this.inFlight++;
    let reservation: string | undefined;
    try {
      reservation = await this.options.accounting.reserve({ context, operation, host, maxBytes, policy });
      let outcome: Awaited<ReturnType<typeof action>>;
      try { outcome = await action(); }
      catch (error) {
        await this.options.accounting.finish(reservation, { bytes: maxBytes, ok: false,
          code: error instanceof NetworkPolicyError ? error.code : 'NETWORK_UNAVAILABLE' });
        throw error;
      }
      if (outcome.bytes > maxBytes || outcome.bytes < 0 || !Number.isSafeInteger(outcome.bytes)) {
        await this.options.accounting.finish(reservation, { bytes: maxBytes, ok: false, code: 'NETWORK_BUDGET_EXCEEDED' });
        throw new NetworkPolicyError('NETWORK_BUDGET_EXCEEDED');
      }
      const { value, ...metadata } = outcome;
      await this.options.accounting.finish(reservation, { ...metadata, ok: true });
      return value;
    } finally { this.inFlight--; }
  }
}
