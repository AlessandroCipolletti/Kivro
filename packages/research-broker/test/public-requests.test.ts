import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BraveSearchProvider, compilePublicResearchPlan, createResearchRequestHandler, narrowResearchPolicy,
  publicResearchPlanHash, ResearchBroker, ResearchPolicySchema, reserveResearchUsage, SafeHttpClient, prefetchPublicResearchTools,
  type BrokerOptions, type CompiledPublicResearchPlan, type EgressGrant, type PublicResearchScope, type ResearchUsage } from '../src/index.js';

afterEach(() => vi.restoreAllMocks());
function setup() {
  const scope: PublicResearchScope = { userId: randomUUID(), jobId: randomUUID(), capabilityVersionId: randomUUID(), attemptId: randomUUID() };
  const policy = ResearchPolicySchema.parse({ mode: 'PUBLIC_WEB_RESEARCH', searchEnabled: true, fetchEnabled: true,
    allowedDomains: ['example.com'], maxQueries: 5, maxPages: 5, maxResponseBytes: 1000, maxTotalBytes: 5000, maxDurationMs: 60000 });
  const provenance = { kind: 'REVIEWED_PUBLIC_LITERAL' as const, sourceUrl: 'https://example.com/company', reviewedBy: randomUUID(), reviewedAt: new Date(Date.now() - 1000).toISOString() };
  const plan = { schemaVersion: 1, capabilityVersionId: scope.capabilityVersionId, dependencyBindingHash: 'a'.repeat(64),
    limits: { maxQueries: 1, maxPages: 1, maxResponseBytes: 100, maxTotalBytes: 200, maxDurationMs: 30000,
      allowedDomains: ['example.com'], allowedContentTypes: ['text/plain'] }, sources: [
      { id: 'company_search', operation: 'SEARCH', provenance, request: { query: 'Acme public annual report', maxResults: 2 } },
      { id: 'company_page', operation: 'FETCH', provenance, request: { url: 'https://example.com/company', method: 'GET' } },
    ] };
  const compilerInput = { plan, scope, approvedPlanHash: publicResearchPlanHash(plan), approvedDependencyBindingHash: plan.dependencyBindingHash,
    expiresAt: new Date(Date.now() + 60000).toISOString() };
  const token = compilePublicResearchPlan(compilerInput);
  const grant: EgressGrant = { policy, dataClasses: ['BUYER_PRIVATE', 'SELLER_PRIVATE'], publicResearch: token };
  let usage: ResearchUsage | undefined;
  const options: BrokerOptions = {
    authorize: vi.fn(async () => grant),
    accounting: { reserve: vi.fn(async request => {
      if (request.operation !== 'CONNECTOR') usage = reserveResearchUsage(usage, { operation: request.operation, maxBytes: request.maxBytes, nowMs: Date.now() }, request.policy);
      return 'reservation';
    }), finish: vi.fn(async () => {}) },
    http: { request: vi.fn(async () => ({ status: 200, headers: { 'content-type': 'text/plain' }, finalUrl: 'https://example.com/company', body: Buffer.from('Public company data') })) },
    searchProvider: { id: 'fixture', host: 'search.example', maxResponseBytes: 1000,
      search: vi.fn(async () => ({ results: [{ url: 'https://example.com/company', title: 'Acme', snippet: 'Public fact', accessedAt: new Date().toISOString(), untrusted: true as const }], bytes: 50 })) },
    audit: vi.fn(async () => {}),
  };
  const broker = new ResearchBroker(options);
  return { scope, plan, policy, token, compilerInput, options, grant, broker, usage: () => usage };
}

describe('R16 reviewed public requests in mixed private jobs', () => {
  it('uses fixed public requests and preserves private taint, budget, SSRF transport and provenance', async () => {
    const h = setup();
    await h.broker.searchPublic(h.scope, { reviewedSourceId: 'company_search' });
    const page = await h.broker.fetchPublic(h.scope, { reviewedSourceId: 'company_page' });
    expect(h.grant.dataClasses).toEqual(['BUYER_PRIVATE', 'SELLER_PRIVATE']);
    expect(h.options.searchProvider!.search).toHaveBeenCalledExactlyOnceWith({ query: 'Acme public annual report', maxResults: 2 }, { maxResponseBytes: 100, timeoutMs: 30000 });
    expect(h.options.http!.request).toHaveBeenCalledExactlyOnceWith({ url: 'https://example.com/company', method: 'GET', httpsOnly: true,
      allowedDomains: ['example.com'], maxBytes: 100, timeoutMs: 30000, allowedContentTypes: ['text/plain'] });
    expect(page).toMatchObject({ finalUrl: 'https://example.com/company', text: 'Public company data', untrusted: true });
    expect(h.options.accounting.finish).toHaveBeenCalledWith('reservation', expect.objectContaining({ publicPlanHash: h.token.planHash, publicSourceId: 'company_search' }));
    expect(h.usage()).toMatchObject({ queries: 1, pages: 1, reservedBytes: 200 });
    await expect(h.broker.search(h.scope, { query: 'private DB balance 123' })).rejects.toMatchObject({ code: 'NETWORK_POLICY_DENIED' });
    await expect(h.broker.fetch(h.scope, { url: 'https://example.com/?secret=123' })).rejects.toMatchObject({ code: 'NETWORK_POLICY_DENIED' });
    expect(h.options.searchProvider!.search).toHaveBeenCalledTimes(1); expect(h.options.http!.request).toHaveBeenCalledTimes(1);
  });
  it.each(['query', 'url', 'method', 'headers', 'body', 'dataClasses', 'proof', 'limits'])('rejects model-injected %s without budget reservation or network', async key => {
    const h = setup();
    await expect(h.broker.searchPublic(h.scope, { reviewedSourceId: 'company_search', [key]: 'private db value' })).rejects.toThrow();
    expect(h.options.accounting.reserve).not.toHaveBeenCalled(); expect(h.options.searchProvider!.search).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(h.options.audit!).mock.calls)).not.toContain('private db value');
  });
  it.each(['userId', 'jobId', 'attemptId', 'capabilityVersionId'] as const)('rejects a different %s binding before egress', async key => {
    const h = setup();
    await expect(h.broker.searchPublic({ ...h.scope, [key]: randomUUID() }, { reviewedSourceId: 'company_search' })).rejects.toMatchObject({ code: 'NETWORK_POLICY_DENIED' });
    expect(h.options.accounting.reserve).not.toHaveBeenCalled();
  });
  it('rejects missing attempt IDs, absent tokens, serialized/forged tokens and wrong operation/source IDs', async () => {
    const h = setup(); const { attemptId: _attempt, ...scope } = h.scope;
    await expect(h.broker.searchPublic(scope, { reviewedSourceId: 'company_search' })).rejects.toThrow();
    await expect(h.broker.fetchPublic(h.scope, { reviewedSourceId: 'company_search' })).rejects.toThrow();
    await expect(h.broker.searchPublic(h.scope, { reviewedSourceId: 'invented' })).rejects.toThrow();
    h.grant.publicResearch = structuredClone(h.token) as CompiledPublicResearchPlan;
    await expect(h.broker.searchPublic(h.scope, { reviewedSourceId: 'company_search' })).rejects.toThrow();
    delete h.grant.publicResearch;
    await expect(h.broker.searchPublic(h.scope, { reviewedSourceId: 'company_search' })).rejects.toThrow();
    expect(h.options.accounting.reserve).not.toHaveBeenCalled();
  });
  it('requires the original approved hash and dependency identity, and owns an immutable normalized copy', async () => {
    const h = setup();
    expect(() => compilePublicResearchPlan({ ...h.compilerInput, approvedPlanHash: 'b'.repeat(64) })).toThrow();
    expect(() => compilePublicResearchPlan({ ...h.compilerInput, approvedDependencyBindingHash: 'b'.repeat(64) })).toThrow();
    expect(() => compilePublicResearchPlan({ ...h.compilerInput, scope: { ...h.scope, capabilityVersionId: randomUUID() } })).toThrow();
    h.plan.sources[0]!.request.query = 'Injected secret'; h.plan.limits.maxQueries = 30;
    expect(() => compilePublicResearchPlan(h.compilerInput)).toThrow();
    await h.broker.searchPublic(h.scope, { reviewedSourceId: 'company_search' });
    expect(h.options.searchProvider!.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'Acme public annual report' }), expect.anything());
    expect(Object.isFrozen(h.token)).toBe(true); expect(Object.isFrozen(h.token.scope)).toBe(true); expect(Object.isFrozen(h.token.searchSourceIds)).toBe(true);
  });
  it('rejects expired capabilities and revocation even when a token remains in memory', async () => {
    const h = setup(); const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 61000);
    await expect(h.broker.fetchPublic(h.scope, { reviewedSourceId: 'company_page' })).rejects.toThrow();
    vi.restoreAllMocks(); h.grant.policy.mode = 'NO_NETWORK';
    await expect(h.broker.searchPublic(h.scope, { reviewedSourceId: 'company_search' })).rejects.toThrow();
    expect(h.options.accounting.reserve).not.toHaveBeenCalled();
  });
  it('rejects nonpublic source literals and never accepts proof supplied in an HTTP body', async () => {
    const h = setup(); h.plan.sources[1]!.request.url = 'https://127.0.0.1/';
    expect(() => publicResearchPlanHash(h.plan)).toThrow();
    const handler = createResearchRequestHandler({ broker: h.broker, authenticateActiveJob: async () => h.scope });
    await expect(handler({}, { operation: 'searchPublic', args: { reviewedSourceId: 'company_search' }, publicResearch: h.token })).rejects.toThrow();
    expect(h.options.accounting.reserve).not.toHaveBeenCalled();
  });
  it('rejects duplicate sources, future review timestamps and unbounded or expired token lifetimes', () => {
    const h = setup();
    expect(() => compilePublicResearchPlan({ ...h.compilerInput, expiresAt: new Date(Date.now() - 1000).toISOString() })).toThrow();
    expect(() => compilePublicResearchPlan({ ...h.compilerInput, expiresAt: new Date(Date.now() + 25 * 3600_000).toISOString() })).toThrow();
    expect(() => publicResearchPlanHash({ ...h.plan, sources: [h.plan.sources[0], h.plan.sources[0]] })).toThrow();
    h.plan.sources[0]!.provenance.reviewedAt = new Date(Date.now() + 60000).toISOString();
    expect(() => compilePublicResearchPlan({ ...h.compilerInput, approvedPlanHash: publicResearchPlanHash(h.plan) })).toThrow();
  });
  it('does not exempt approved public URLs from DNS/private-address checks', async () => {
    const h = setup(); const resolver = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    const broker = new ResearchBroker({ ...h.options, http: new SafeHttpClient({ resolver }) });
    await expect(broker.fetchPublic(h.scope, { reviewedSourceId: 'company_page' })).rejects.toMatchObject({ code: 'PRIVATE_DESTINATION_DENIED' });
    expect(resolver).toHaveBeenCalledWith('example.com');
    expect(h.options.accounting.finish).toHaveBeenCalledWith('reservation', expect.objectContaining({ ok: false, bytes: 100 }));
  });
  it('routes only authenticated public references through the signed-handler adapter', async () => {
    const h = setup(); const handler = createResearchRequestHandler({ broker: h.broker, authenticateActiveJob: async () => h.scope });
    expect(await handler({}, { operation: 'searchPublic', args: { reviewedSourceId: 'company_search' } })).toHaveLength(1);
    expect(h.options.authorize).toHaveBeenCalledWith(h.scope);
  });
  it('reapplies current domain restrictions and zero request budgets without weakening the approved policy', async () => {
    const h = setup(); h.grant.policy.allowedDomains = ['elsewhere.example'];
    await expect(h.broker.fetchPublic(h.scope, { reviewedSourceId: 'company_page' })).rejects.toThrow();
    h.grant.policy.maxQueries = 0;
    await expect(h.broker.searchPublic(h.scope, { reviewedSourceId: 'company_search' })).rejects.toMatchObject({ code: 'NETWORK_BUDGET_EXCEEDED' });
    expect(h.options.accounting.reserve).not.toHaveBeenCalled();
  });
  it('enforces seller query/page totals across broker calls without resetting after successful completion', async () => {
    const h = setup(); await h.broker.searchPublic(h.scope, { reviewedSourceId: 'company_search' });
    await expect(h.broker.searchPublic(h.scope, { reviewedSourceId: 'company_search' })).rejects.toMatchObject({ code: 'NETWORK_BUDGET_EXCEEDED' });
    await h.broker.fetchPublic(h.scope, { reviewedSourceId: 'company_page' });
    await expect(h.broker.fetchPublic(h.scope, { reviewedSourceId: 'company_page' })).rejects.toMatchObject({ code: 'NETWORK_BUDGET_EXCEEDED' });
    expect(h.options.searchProvider!.search).toHaveBeenCalledTimes(1); expect(h.options.http!.request).toHaveBeenCalledTimes(1);
  });
  it('prefetches the fixed public sequence before private access and exposes cache-only lookups afterward', async () => {
    const h = setup(); let privateAccess = false;
    const authorize = h.options.authorize;
    h.options.authorize = vi.fn(async context => { expect(privateAccess).toBe(false); return authorize(context); });
    const active = vi.fn(async () => {});
    const cached = await prefetchPublicResearchTools({ broker: new ResearchBroker(h.options), context: h.scope, plan: h.token, assertActive: active });
    privateAccess = true;
    const data = await cached.searchPublic({ reviewedSourceId: 'company_search' }); data[0]!.title = 'Mutated';
    expect((await cached.searchPublic({ reviewedSourceId: 'company_search' }))[0]!.title).toBe('Acme');
    expect(await cached.fetchPublic({ reviewedSourceId: 'company_page' })).toMatchObject({ text: 'Public company data' });
    await expect(cached.fetchPublic({ reviewedSourceId: 'company_page', url: 'https://example.com/private-secret' })).rejects.toThrow();
    await expect(cached.fetchPublic({ reviewedSourceId: 'company_search' })).rejects.toThrow();
    expect(h.options.searchProvider!.search).toHaveBeenCalledTimes(1); expect(h.options.http!.request).toHaveBeenCalledTimes(1);
    active.mockRejectedValue(new Error('JOB_NOT_ACTIVE'));
    await expect(cached.searchPublic({ reviewedSourceId: 'company_search' })).rejects.toThrow('JOB_NOT_ACTIVE');
  });
  it('does not return a partial prefetch cache if any approved request fails', async () => {
    const h = setup(); vi.mocked(h.options.http!.request).mockRejectedValue(new Error('Network failed'));
    await expect(prefetchPublicResearchTools({ broker: h.broker, context: h.scope, plan: h.token, assertActive: async () => {} })).rejects.toThrow('Network failed');
    expect(h.usage()).toMatchObject({ queries: 1, pages: 1, reservedBytes: 200 });
  });
});

describe('seller-only narrowing and transport limits', () => {
  it('intersects flags/domains/types, clamps numeric limits and cannot change network mode', () => {
    const h = setup();
    expect(narrowResearchPolicy(h.policy, { maxQueries: 30, maxPages: 0, searchEnabled: false,
      allowedDomains: ['EXAMPLE.COM', 'other.example'], allowedContentTypes: ['application/json'] })).toMatchObject({
      maxQueries: 5, maxPages: 0, searchEnabled: false, allowedDomains: ['example.com'], allowedContentTypes: [] });
    expect(narrowResearchPolicy({ ...h.policy, mode: 'NO_NETWORK', searchEnabled: false }, { searchEnabled: true }).mode).toBe('NO_NETWORK');
    expect(() => narrowResearchPolicy(h.policy, { mode: 'PUBLIC_WEB_RESEARCH' })).toThrow();
    expect(() => narrowResearchPolicy(h.policy, { allowedDomains: ['example.com/path'] })).toThrow();
  });
  it('bounds per-job duration, response/aggregate bytes and rejects a backward clock', () => {
    const h = setup(); const policy = narrowResearchPolicy(h.policy, h.plan.limits);
    const prior = reserveResearchUsage(undefined, { operation: 'SEARCH', maxBytes: 100, nowMs: 1000 }, policy);
    for (const request of [{ operation: 'FETCH' as const, maxBytes: 100, nowMs: 31000 }, { operation: 'FETCH' as const, maxBytes: 100, nowMs: 999 },
      { operation: 'FETCH' as const, maxBytes: 101, nowMs: 2000 }]) expect(() => reserveResearchUsage(prior, request, policy)).toThrow('NETWORK_BUDGET_EXCEEDED');
    expect(() => reserveResearchUsage({ ...prior, reservedBytes: 150 }, { operation: 'FETCH', maxBytes: 100, nowMs: 2000 }, policy)).toThrow();
  });
  it('passes reduced seller limits to the real Brave HTTP adapter instead of only rejecting an oversized result afterward', async () => {
    const request = vi.fn(async () => ({ status: 200, headers: { 'content-type': 'application/json' }, finalUrl: 'https://api.search.brave.com/res/v1/web/search', body: Buffer.from('{"web":{"results":[]}}') }));
    const provider = new BraveSearchProvider('fixture-key', { request });
    await provider.search({ query: 'Acme', maxResults: 1 }, { maxResponseBytes: 200, timeoutMs: 1000 });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 200, timeoutMs: 1000, maxRedirects: 0, allowedDomains: ['api.search.brave.com'] }));
  });
});
