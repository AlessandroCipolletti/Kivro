import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashManifest } from '@kivro/contracts';
import { NetworkPolicyError, SafeHttpClient, type HttpTransport, type ReviewedPublicResearchPlan } from '@kivro/research-broker';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { WorkerState } from './state.ts';
import { JobToolBroker } from './tools.ts';
import { approveResearchPlan, revokeResearchPlan, selectedResearchConsent, researchPolicy } from './research-config.ts';
import { researchAccounting, recordResearchPage } from './research-usage.ts';
import { WorkerDiagnosticsSchema } from './transport.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-research-'))), state = new WorkerState(root), offer = fixtureOffer();
  cleanups.push(async () => { state.close(); await rm(root, { recursive: true, force: true }); });
  offer.sellerId = randomUUID(); offer.permissions.tools = ['research.fetch', 'resource.query'];
  offer.permissions.network = { mode: 'RESEARCH', allowedDomains: ['example.com'], researchLimits: { maxQueries: 0, maxPages: 2, maxResponseBytes: 1000, maxTotalBytes: 2000, maxDurationMs: 10000 } };
  offer.permissions.resources = [{ id: 'private-db', type: 'DATABASE', access: 'READ_ONLY' }];
  offer.dependencies.push({ id: 'private-db', name: 'Private DB', type: 'DATABASE', required: true, approved: true, supported: true, healthy: true, confidence: 'DECLARED', contentHash: 'a'.repeat(64), grants: { resources: ['private-db'] } });
  state.set(`capability:${offer.capabilityVersionId}`, offer); state.resume('LOCAL'); state.claim(offer, `kivro-job-${offer.attemptId}`);
  const plan: ReviewedPublicResearchPlan = { schemaVersion: 1, capabilityVersionId: offer.capabilityVersionId, dependencyBindingHash: hashManifest(offer.dependencies), limits: {}, sources: [
    { id: 'public-docs', operation: 'FETCH', request: { url: 'https://example.com/docs', method: 'GET' }, provenance: { kind: 'REVIEWED_PUBLIC_LITERAL', sourceUrl: 'https://example.com/docs', reviewedBy: offer.sellerId, reviewedAt: new Date().toISOString() } },
  ] };
  const approve = () => { const preview = approveResearchPlan(state, plan, offer.sellerId!); return approveResearchPlan(state, plan, offer.sellerId!, preview.approvalHash); };
  const request = vi.fn<HttpTransport['request']>().mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<title>Public</title><p>public source</p><script>bad()</script>'), finalUrl: 'https://example.com/docs' });
  const resource = { execute: vi.fn().mockResolvedValue({ rows: [{ private: 'seller-private-canary' }], metadata: { dataClasses: ['SELLER_PRIVATE'] } }), close: vi.fn() };
  const tools = () => new JobToolBroker(offer, state, offer.dependencies, undefined, resource, [], { http: { request } });
  return { state, offer, plan, approve, request, resource, tools };
}

describe('reviewed research plus private resources', () => {
  it.each(['cancel', 'network-deadline'])('aborts real transport DNS promptly on %s and retains unknown traffic accounting', async reason => {
    const { state, offer, plan, approve, resource } = await fixture(); plan.limits.maxDurationMs = 1000; approve();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const networkController = new AbortController(); let started!: () => void; const pending = new Promise<void>(resolve => { started = resolve; });
    const http = new SafeHttpClient({ signal: networkController.signal, resolver: () => { started(); return new Promise(() => {}); } });
    const broker = new JobToolBroker(offer, state, offer.dependencies, undefined, resource, [], { http, networkController });
    const action = broker.preparePublicResearch(), outcome = expect(action).rejects.toThrow(/^NETWORK_CANCELLED$/); await pending;
    if (reason === 'cancel') broker.cancel();
    else { await vi.advanceTimersByTimeAsync(999); expect(networkController.signal.aborted).toBe(false); await vi.advanceTimersByTimeAsync(1); }
    await outcome; const id = state.get<string[]>(`researchRequests:${offer.jobId}`)![0];
    expect(state.get(`researchRequest:${id}`)).toMatchObject({ ok: false, code: 'NETWORK_CANCELLED', actualBytes: null, reservedBytes: 1000 }); broker.cancel();
  });
  it('keeps immutable cache access available after the outbound research deadline', async () => {
    const { state, offer, approve, request, tools } = await fixture(); approve(); vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); const broker = tools();
    await broker.preparePublicResearch(); state.transition(offer.jobId, 'RUNNING'); await vi.advanceTimersByTimeAsync(10000);
    expect(await broker.execute('research.fetch', { reviewedSourceId: 'public-docs' })).toMatchObject({ untrusted: true }); expect(request).toHaveBeenCalledOnce(); broker.cancel();
  });
  it('binds sequential direct-fetch hashes once and fails closed on ambiguous concurrent receipts', async () => {
    const { state, offer } = await fixture(), context = { userId: offer.sellerId!, jobId: offer.jobId, capabilityVersionId: offer.capabilityVersionId, attemptId: offer.attemptId };
    const accounting = researchAccounting(state, context, () => {}), request = { context, operation: 'FETCH' as const, host: 'example.com', maxBytes: 100, policy: { ...researchPolicy(offer.permissions), maxPages: 5 } };
    const page = (sha256: string) => ({ sha256: sha256.repeat(64), bytes: 5, fetchedAt: new Date().toISOString() });
    const first = await accounting.reserve(request); await accounting.finish(first, { ok: true, bytes: 5 }); recordResearchPage(state, context, page('a'));
    const second = await accounting.reserve(request); await accounting.finish(second, { ok: true, bytes: 5 }); recordResearchPage(state, context, page('b'));
    expect(state.get(`researchRequest:${first}`)).toMatchObject({ responseSha256: 'a'.repeat(64) }); expect(state.get(`researchRequest:${second}`)).toMatchObject({ responseSha256: 'b'.repeat(64) });
    expect(() => recordResearchPage(state, context, page('c'))).toThrow('AMBIGUOUS');
    for (let index = 0; index < 2; index++) { const id = await accounting.reserve(request); await accounting.finish(id, { ok: true, bytes: 5 }); }
    expect(() => recordResearchPage(state, context, page('d'))).toThrow('AMBIGUOUS');
  });
  it('requires explicit seller review and invalidates existing publication proof, without silently granting tools', async () => {
    const { state, offer, plan, approve } = await fixture();
    expect(() => selectedResearchConsent(state, offer)).toThrow('REVIEWED_PUBLIC_RESEARCH_PLAN_REQUIRED');
    const permissions = structuredClone(offer.permissions), preview = approveResearchPlan(state, plan, offer.sellerId!);
    expect(preview.approved).toBe(false); expect(state.get(`researchPlan:${offer.capabilityVersionId}`)).toBeUndefined();
    state.set(`capabilityProof:${offer.capabilityVersionId}`, { fixture: true }); approve();
    expect(state.get(`capabilityProof:${offer.capabilityVersionId}`)).toBeUndefined(); expect(offer.permissions).toEqual(permissions);
    expect(selectedResearchConsent(state, offer, offer.sellerId)?.planHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('binds immutable plan, reviewer, dependency revisions, capability and seller identity', async () => {
    const { state, offer, plan, approve } = await fixture(); approve();
    expect(() => selectedResearchConsent(state, offer, randomUUID())).toThrow('RESEARCH_CONSENT_MISMATCH');
    offer.dependencies[0]!.contentHash = 'b'.repeat(64); expect(() => selectedResearchConsent(state, offer, offer.sellerId)).toThrow('RESEARCH_CONSENT_MISMATCH'); delete offer.dependencies[0]!.contentHash;
    const changed = structuredClone(plan); changed.sources[0]!.provenance.reviewedBy = randomUUID(); expect(() => approveResearchPlan(state, changed, offer.sellerId!)).toThrow('RESEARCH_CONSENT_MISMATCH');
    changed.sources[0]!.provenance.reviewedBy = offer.sellerId!; changed.sources[0]!.request = { url: 'https://example.com/changed', method: 'GET' };
    const preview = approveResearchPlan(state, changed, offer.sellerId!); expect(() => approveResearchPlan(state, changed, offer.sellerId!, preview.approvalHash)).toThrow('IMMUTABLE_RESEARCH_PLAN_USE_NEW_VERSION');
    revokeResearchPlan(state, offer.capabilityVersionId); expect(() => selectedResearchConsent(state, offer)).toThrow('REQUIRED'); expect(approve().approved).toBe(true);
  });
  it('prefetches a fixed public sequence before private access; later arbitrary arguments cannot cause egress', async () => {
    const { state, offer, approve, request, resource, tools } = await fixture(); approve(); const broker = tools();
    request.mockImplementation(async input => {
      expect(state.attempt(offer.jobId)?.state).toBe('ACCEPTED'); expect(resource.execute).not.toHaveBeenCalled(); expect(JSON.stringify(input)).not.toMatch(/private-canary|untrusted marker/);
      return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('public only'), finalUrl: 'https://example.com/docs' };
    });
    await expect(broker.execute('resource.query', { resourceId: 'private-db', operation: 'lookup', input: {} })).rejects.toThrow('PAUSED');
    await broker.preparePublicResearch(); expect(request).toHaveBeenCalledOnce();
    state.transition(offer.jobId, 'RUNNING'); await broker.execute('resource.query', { resourceId: 'private-db', operation: 'lookup', input: {} });
    const result = await broker.execute('research.fetch', { reviewedSourceId: 'public-docs' }) as { text: string; untrusted: boolean };
    expect(result).toMatchObject({ text: 'public only', untrusted: true }); result.text = 'mutated';
    expect(await broker.execute('research.fetch', { reviewedSourceId: 'public-docs' })).toMatchObject({ text: 'public only' });
    for (const input of [{ url: 'https://example.com/?leak=seller-private-canary' }, { reviewedSourceId: 'public-docs', query: 'seller-private-canary' }, { reviewedSourceId: 'model-chosen' }]) await expect(broker.execute('research.fetch', input)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce(); expect(resource.execute).toHaveBeenCalledOnce();
    await expect(broker.preparePublicResearch()).rejects.toThrow('ALREADY_ATTEMPTED'); broker.cancel();
  });
  it('refuses private-model execution without prefetch and blocks revoked cache access', async () => {
    const { state, offer, approve, request, tools } = await fixture(); approve(); const broker = tools();
    state.transition(offer.jobId, 'RUNNING'); await expect(broker.execute('research.fetch', { reviewedSourceId: 'public-docs' })).rejects.toThrow('RESEARCH_PRELUDE_REQUIRED');
    await expect(broker.preparePublicResearch()).rejects.toThrow('BEFORE_PRIVATE'); expect(request).not.toHaveBeenCalled(); broker.cancel();
    const other = await fixture(); other.approve(); const cached = other.tools(); await cached.preparePublicResearch(); other.state.transition(other.offer.jobId, 'RUNNING'); revokeResearchPlan(other.state, other.offer.capabilityVersionId);
    await expect(cached.execute('research.fetch', { reviewedSourceId: 'public-docs' })).rejects.toThrow('REQUIRED'); expect(other.request).toHaveBeenCalledOnce(); cached.cancel();
  });
  it('requires authenticated sellerId for both research and connector execution', async () => {
    const { offer, tools } = await fixture(); delete offer.sellerId;
    expect(tools).toThrow('AUTHENTICATED_SELLER_REQUIRED'); offer.permissions.tools = ['connector.call']; offer.permissions.network.mode = 'CONNECTORS'; expect(tools).toThrow('AUTHENTICATED_SELLER_REQUIRED');
  });
  it('rejects private/LAN literals and plans exceeding declared tools/domains/budgets before egress', async () => {
    const { state, offer, plan, request } = await fixture();
    for (const url of ['https://127.0.0.1/', 'https://metadata.google.internal/', 'https://example.net/']) {
      const changed = structuredClone(plan); changed.sources[0]!.request = { url, method: 'GET' }; expect(() => approveResearchPlan(state, changed, offer.sellerId!)).toThrow();
    }
    const tooMany = structuredClone(plan); tooMany.sources = [0, 1, 2].map(index => ({ ...plan.sources[0]!, id: `source${index}` })); expect(() => approveResearchPlan(state, tooMany, offer.sellerId!)).toThrow('BUDGET'); expect(request).not.toHaveBeenCalled();
  });
  it('records host/status/measured bytes without URLs, queries or private resource contents', async () => {
    const { state, offer, approve, tools } = await fixture(); approve(); const broker = tools(); await broker.preparePublicResearch();
    const ids = state.get<string[]>(`researchRequests:${offer.jobId}`)!; expect(ids).toHaveLength(1);
    const receipt = state.get(`researchRequest:${ids[0]}`); expect(receipt).toMatchObject({ context: { userId: offer.sellerId, attemptId: offer.attemptId }, host: 'example.com', operation: 'FETCH', reservedBytes: 1000, status: 200, contentType: 'text/html', destinationHost: 'example.com', ok: true, actualBytes: 63, contentBytes: 63, responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/), publicSourceId: 'public-docs' });
    expect(JSON.stringify(receipt)).not.toMatch(/https?:|public source|seller-private-canary|bad\(\)/); broker.cancel();
  });
  it('retains failed reservations as unknown bytes and cannot retry a partial prelude', async () => {
    const { state, offer, approve, tools, request } = await fixture(); approve(); request.mockRejectedValue(new NetworkPolicyError('NETWORK_UNAVAILABLE')); const broker = tools();
    await expect(broker.preparePublicResearch()).rejects.toThrow('NETWORK_UNAVAILABLE'); await expect(broker.preparePublicResearch()).rejects.toThrow('ALREADY_ATTEMPTED');
    const id = state.get<string[]>(`researchRequests:${offer.jobId}`)![0]; expect(state.get(`researchRequest:${id}`)).toMatchObject({ ok: false, reservedBytes: 1000, actualBytes: null });
    expect(state.get(`research:${offer.jobId}`)).toMatchObject({ pages: 1, reservedBytes: 1000 }); broker.cancel();
  });
  it('keeps the per-job budget across attempts and enforces manifest narrowing and elapsed time', async () => {
    const { state, offer } = await fixture(); const policy = researchPolicy(offer.permissions), context = { userId: offer.sellerId!, jobId: offer.jobId, capabilityVersionId: offer.capabilityVersionId, attemptId: offer.attemptId };
    expect(policy).toMatchObject({ maxPages: 2, maxQueries: 0, maxTotalBytes: 2000, maxDurationMs: 10000 });
    const first = researchAccounting(state, context, () => {}); const reserve = { context, operation: 'FETCH' as const, host: 'example.com', maxBytes: 1000, policy };
    await first.reserve(reserve); const next = { ...context, attemptId: randomUUID() }, retry = researchAccounting(state, next, () => {});
    await retry.reserve({ ...reserve, context: next }); await expect(retry.reserve({ ...reserve, context: next })).rejects.toThrow('NETWORK_BUDGET_EXCEEDED');
    const another = { ...context, jobId: randomUUID() }, timed = researchAccounting(state, another, () => {}); vi.useFakeTimers(); await timed.reserve({ ...reserve, context: another }); vi.setSystemTime(Date.now() + 10000);
    await expect(timed.reserve({ ...reserve, context: another })).rejects.toThrow('NETWORK_BUDGET_EXCEEDED');
  });
  it('quarantines malformed telemetry instead of logging untrusted data', async () => {
    const { state, offer } = await fixture(), context = { userId: offer.sellerId!, jobId: offer.jobId, capabilityVersionId: offer.capabilityVersionId, attemptId: offer.attemptId };
    const accounting = researchAccounting(state, context, () => {}), id = await accounting.reserve({ context, operation: 'FETCH', host: 'example.com', maxBytes: 1000, policy: researchPolicy(offer.permissions) });
    await accounting.finish(id, { ok: true, bytes: 5000, code: 'secret-canary https://private.example/' });
    expect(state.get(`researchRequest:${id}`)).toMatchObject({ code: 'INVALID_RESEARCH_TELEMETRY', actualBytes: null }); expect(JSON.stringify(state.get(`researchRequest:${id}`))).not.toContain('secret-canary');
  });
  it('parses only UUID seller identities from authenticated diagnostics while old API remains non-research compatible', () => {
    const raw = { serverTime: new Date().toISOString(), workerId: randomUUID(), minimumWorkerVersion: '0.1.0', minimumOpenClawVersion: '2026.8.2', revokedWorkerVersions: [], revokedOpenClawVersions: [], policyReason: null };
    expect(WorkerDiagnosticsSchema.parse(raw).sellerId).toBeUndefined(); expect(WorkerDiagnosticsSchema.parse({ ...raw, sellerId: randomUUID() }).sellerId).toBeDefined(); expect(() => WorkerDiagnosticsSchema.parse({ ...raw, sellerId: 'untrusted-seller' })).toThrow();
  });
});
