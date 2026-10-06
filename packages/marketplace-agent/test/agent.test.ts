import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AgentChatBodySchema, MarketplaceAgent } from '../src/agent.js';
import { InferenceProfileSchema, PlatformInferenceRouter, type PlatformInferenceRequest } from '../src/inference.js';
import type { Conversation, ConversationRepository } from '../src/types.js';
import { buyerId, capability, harness } from './fixtures.js';

function setup() {
  const cap = capability(); const h = harness([cap]); const conversation: Conversation = { id: randomUUID(), userId: buyerId, createdAt: new Date().toISOString(), messages: [] };
  const conversations: ConversationRepository = { create: vi.fn(async () => conversation), get: vi.fn(async () => conversation),
    list: vi.fn(async () => [conversation]), append: vi.fn(async () => {}) };
  const options = { catalog: h.catalog, orchestration: h.service, conversations };
  return { ...h, cap, conversations, options, agent: new MarketplaceAgent(options) };
}
describe('marketplace agent', () => {
  it('keeps deterministic discovery useful and honest with no provider', async () => {
    const h = setup(); const result = await h.agent.chat({ userId: buyerId, message: 'company research', budgetMinor: 500 });
    expect(result.inferenceStatus).toBe('UNAVAILABLE'); expect(result.recommendations).toHaveLength(1);
    expect(result.message).toContain('deterministic'); expect(result.plan).toBeUndefined(); expect(h.executor.createJob).not.toHaveBeenCalled();
    expect(h.conversations.append).toHaveBeenCalledTimes(1);
  });
  it('reports explicit orchestration unavailability and creates no plan', async () => {
    const h = setup(); const result = await h.agent.chat({ userId: buyerId, message: 'run research', budgetMinor: 500, mode: 'PLAN' });
    expect(result.message).toContain('AI orchestration is unavailable'); expect(result.plan).toBeUndefined(); expect(h.plans.size).toBe(0);
  });
  it('requires explicit scheduling consent and verifies conversation owner', async () => {
    const h = setup();
    await expect(h.agent.chat({ userId: buyerId, message: 'research', budgetMinor: 500, timingMode: 'EARLIEST_AVAILABLE_ALLOWED' })).rejects.toThrow('EXPLICIT_SCHEDULING_CONSENT_REQUIRED');
    await expect(h.agent.chat({ userId: randomUUID(), conversationId: randomUUID(), message: 'research', budgetMinor: 500 })).rejects.toThrow('CONVERSATION_NOT_FOUND');
  });
  it('never transmits completed job data for synthesis without explicit consent', async () => {
    const h = setup();
    // @ts-expect-error Runtime callers must not bypass the consent-bound request contract.
    await expect(h.agent.synthesize({ planId: randomUUID(), userId: buyerId, consentToProviderProcessing: false })).rejects.toThrow('PROVIDER_PROCESSING_CONSENT_REQUIRED');
    expect(h.repository.get).not.toHaveBeenCalled(); expect(h.executor.createJob).not.toHaveBeenCalled();
  });
  it('continues scanning after unavailable top search results', async () => {
    const h = setup(); const unavailable = capability({ availability: { status: 'OFFLINE', canRunNow: false, nextAvailableAt: null, reason: null } });
    vi.mocked(h.catalog.search).mockResolvedValueOnce({ capabilities: [unavailable], nextCursor: 'next' }).mockResolvedValueOnce({ capabilities: [h.cap] });
    const result = await h.agent.chat({ userId: buyerId, message: 'company', budgetMinor: 500, mode: 'PLAN' });
    expect(result.recommendations.map(c => c.id)).toEqual([h.cap.id]); expect(h.catalog.search).toHaveBeenCalledTimes(2);
  });
  it('provider failure and invalid plans have zero purchase side effects', async () => {
    const h = setup();
    const profile = InferenceProfileSchema.parse({ provider: 'openai', model: 'configured', inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1, structuredOutput: true });
    const inference = new PlatformInferenceRouter({ providers: [{ id: 'openai', healthCheck: async () => ({ configured: true, healthy: true }),
      generate: vi.fn(async () => { throw new Error('failed'); }) }], profiles: { INTENT_EXTRACTION: profile, ORCHESTRATION_PLANNING: profile },
      accounting: { reserve: async () => 'id', finish: async () => {} } });
    const result = await new MarketplaceAgent({ ...h.options, inference }).chat({ userId: buyerId, message: 'run company research', budgetMinor: 500, mode: 'PLAN' });
    expect(result.inferenceStatus).toBe('FAILED'); expect(h.plans.size).toBe(0); expect(h.executor.createJob).not.toHaveBeenCalled();
  });
  it('sends only public whitelisted records to platform inference', async () => {
    const h = setup(); const seen: PlatformInferenceRequest[] = [];
    const profile = InferenceProfileSchema.parse({ provider: 'openai', model: 'configured', inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1, structuredOutput: true });
    const inference = new PlatformInferenceRouter({ providers: [{ id: 'openai', healthCheck: async () => ({ configured: true, healthy: true }),
      generate: async req => {
        seen.push(req);
        return { provider: 'openai', model: 'configured', text: JSON.stringify(req.task === 'INTENT_EXTRACTION' ?
          { query: 'company', maxSpendMinor: 999999, maxPerJobSpendMinor: null, maxJobs: null, minRating: null, maxRuntimeSeconds: null, noNetwork: false, onlineOnly: null } : { capabilityIds: [h.cap.id] }),
        toolCalls: [], usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 }, latencyMs: 1 };
      } }], profiles: { INTENT_EXTRACTION: profile, RECOMMENDATION: profile }, accounting: { reserve: async () => 'id', finish: async () => {} } });
    const result = await new MarketplaceAgent({ ...h.options, inference }).chat({ userId: buyerId, message: 'company', budgetMinor: 500 });
    expect(result.inferenceStatus).toBe('READY'); expect(JSON.stringify(seen)).not.toContain('never-send-seller-secret');
    expect(JSON.stringify(seen)).toContain('"maxTotalSpendMinor\\":500');
    expect(h.executor.createJob).not.toHaveBeenCalled();
  });
  it('exposes strict chat constraints without accepting a body-supplied identity', async () => {
    const body = { message: 'company', budgetMinor: 500, maxPerJobSpendMinor: 98, maxJobs: 1, blockedSellers: [], outputTypes: ['TEXT'] };
    expect(AgentChatBodySchema.parse(body)).toMatchObject({ ...body, maxQueueWaitSeconds: 0 });
    expect(AgentChatBodySchema.safeParse({ ...body, userId: buyerId }).success).toBe(false);
    expect(AgentChatBodySchema.safeParse({ ...body, maxJobs: 0 }).success).toBe(false);
    const h = setup();
    expect((await h.agent.chat({ ...AgentChatBodySchema.parse(body), userId: buyerId })).recommendations).toEqual([]);
    expect((await h.agent.chat({ userId: buyerId, message: 'company', budgetMinor: 500, blockedSellers: [h.cap.seller.id] })).recommendations).toEqual([]);
    expect((await h.agent.chat({ userId: buyerId, message: 'company', budgetMinor: 500, outputTypes: ['JSON'] })).recommendations).toEqual([]);
    expect(h.executor.createJob).not.toHaveBeenCalled();
  });
  it('never lets model-extracted constraints raise the buyer max-jobs or per-job ceiling', async () => {
    const h = setup(); const seen: PlatformInferenceRequest[] = [];
    const profile = InferenceProfileSchema.parse({ provider: 'openai', model: 'configured', inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1, structuredOutput: true });
    const inference = new PlatformInferenceRouter({ providers: [{ id: 'openai', healthCheck: async () => ({ configured: true, healthy: true }), generate: async req => {
      seen.push(req);
      return { provider: 'openai', model: 'configured', toolCalls: [], usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 }, latencyMs: 1,
        text: JSON.stringify(req.task === 'INTENT_EXTRACTION' ? { query: 'company', maxSpendMinor: 9999, maxPerJobSpendMinor: 9999,
          maxJobs: 32, minRating: null, maxRuntimeSeconds: null, noNetwork: false, onlineOnly: null } : { clarification: null, steps: ['a', 'b'].map(key => ({
          key, capabilityId: h.cap.id, capabilityVersionId: h.cap.versionId, dependsOn: [], inputMapping: [{ kind: 'literal', targetInput: 'subject',
            valueJson: '"Acme"', sourceStepKey: null, pointer: null, assetIndex: null, sourceField: null }],
        })) }) };
    } }], profiles: { INTENT_EXTRACTION: profile, ORCHESTRATION_PLANNING: profile }, accounting: { reserve: async () => 'id', finish: async () => {} } });
    const result = await new MarketplaceAgent({ ...h.options, inference }).chat({ userId: buyerId, message: 'company', budgetMinor: 500,
      mode: 'PLAN', maxJobs: 1, maxPerJobSpendMinor: 99 });
    expect(result.inferenceStatus).toBe('FAILED'); expect(result.plan).toBeUndefined();
    const context = JSON.parse(seen[1]!.messages.at(-1)!.content);
    expect(context.constraints).toMatchObject({ maxJobs: 1, maxPerJobSpendMinor: 99, maxTotalSpendMinor: 500 });
    expect(h.catalog.quote).not.toHaveBeenCalled(); expect(h.executor.createJob).not.toHaveBeenCalled();
  });
  it('offers future choices without inferring scheduling consent or relaxing hard constraints', async () => {
    const h = setup(); const future = new Date(Date.now() + 3600_000).toISOString();
    h.cap.availability = { status: 'SCHEDULED_OFFLINE', canRunNow: false, nextAvailableAt: future, reason: null };
    const result = await h.agent.chat({ userId: buyerId, message: 'company', budgetMinor: 500, mode: 'PLAN' });
    expect(result.timingAlternatives?.map(c => c.id)).toEqual([h.cap.id]); expect(result.recommendations).toEqual([]);
    expect(result.message).toContain('explicit choice'); expect(result.inferenceStatus).toBe('UNAVAILABLE');
    expect(result.plan).toBeUndefined(); expect(h.catalog.quote).not.toHaveBeenCalled(); expect(h.plans.size).toBe(0);
    expect(h.executor.createJob).not.toHaveBeenCalled();
    expect((await h.agent.chat({ userId: buyerId, message: 'company', budgetMinor: 500, maxPerJobSpendMinor: 98, mode: 'PLAN' })).timingAlternatives).toBeUndefined();
  });
  it('requires explicit queue bounds at chat and never promotes a busy queue to future scheduling', async () => {
    const h = setup(); h.cap.availability = { status: 'BUSY', canRunNow: false, canQueue: true, estimatedQueueWaitSeconds: 20, nextAvailableAt: null, reason: null };
    const request = { userId: buyerId, message: 'company', budgetMinor: 500, mode: 'PLAN' as const };
    expect((await h.agent.chat(request)).recommendations).toEqual([]);
    expect((await h.agent.chat({ ...request, maxQueueWaitSeconds: 20 })).recommendations).toHaveLength(1);
    expect((await h.agent.chat({ ...request, maxQueueWaitSeconds: 19 })).recommendations).toEqual([]);
    expect(h.catalog.quote).not.toHaveBeenCalled(); expect(h.executor.createJob).not.toHaveBeenCalled();
  });
});
