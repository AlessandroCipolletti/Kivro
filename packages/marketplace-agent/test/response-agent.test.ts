import { randomUUID } from 'node:crypto';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  agentChatResponseSchema, agentConversationsResponseSchema, agentContractMatchResponseSchema, agentPlanResponseSchema,
  agentRequiredOutputFilesResponseSchema, agentResponseRoutes, agentSynthesisPreviewResponseSchema, agentSynthesisResponseSchema,
  type AgentChatResponseDTO, type AgentPlanResponseDTO, type AgentSynthesisResponseDTO,
} from '../../contracts/src/response-agent.js';
import { MarketplaceAgent, type AgentChatResponse } from '../src/agent.js';
import { matchDirectContract, RequiredOutputFilesSchema } from '../src/contract-matching.js';
import { InferenceProfileSchema, PlatformInferenceRouter } from '../src/inference.js';
import { AgentSynthesisPreviewSchema, AgentSynthesisResponseSchema, type AgentSynthesisResponse } from '../src/synthesis.js';
import { BuyerConstraintsSchema, type Conversation, type OrchestrationPlan } from '../src/types.js';
import { buyerId, capability, harness } from './fixtures.js';

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
async function fixture() {
  const cap = capability(), alternate = capability(), h = harness([cap, alternate]);
  const conversation: Conversation = { id: randomUUID(), userId: buyerId, createdAt: new Date().toISOString(), messages: [] };
  const conversations = { create: vi.fn(async () => conversation), get: vi.fn(async () => conversation), list: vi.fn(async () => [conversation]),
    append: vi.fn(async (_id: string, _userId: string, messages: Conversation['messages']) => { conversation.messages.push(...messages); }) };
  const agent = new MarketplaceAgent({ catalog: h.catalog, orchestration: h.service, conversations });
  const request = { userId: buyerId, message: 'company', budgetMinor: 500 };
  const chat = await agent.chat(request);
  const plan = await h.service.createDraft({ userId: buyerId, conversationId: conversation.id, goal: 'company',
    timing: { mode: 'IMMEDIATE', maxQueueWaitSeconds: 0 }, constraints: BuyerConstraintsSchema.parse({ maxTotalSpendMinor: 500 }),
    steps: [{ id: randomUUID(), capabilityId: cap.id, capabilityVersionId: cap.versionId, dependsOn: [],
      inputMapping: [{ kind: 'literal', targetInput: 'subject', value: 'Acme' }] }] });
  return { ...h, cap, alternate, conversation, conversations, agent, request, chat, plan };
}

describe('browser-safe exact agent response contracts', () => {
  it('types the wire DTOs as the corresponding service response without importing server code into the schema', () => {
    expectTypeOf<AgentChatResponseDTO>().toMatchTypeOf<AgentChatResponse>();
    expectTypeOf<AgentPlanResponseDTO>().toMatchTypeOf<OrchestrationPlan>();
    expectTypeOf<AgentSynthesisResponseDTO>().toMatchTypeOf<AgentSynthesisResponse>();
  });
  it('accepts actual discovery records and stored conversations with exact JSON roundtrip', async () => {
    const h = await fixture();
    expect(agentChatResponseSchema.parse(wire(h.chat))).toEqual(wire(h.chat));
    expect(agentConversationsResponseSchema.parse(wire([h.conversation]))).toEqual(wire([h.conversation]));
    const unavailable = await h.agent.chat({ ...h.request, mode: 'PLAN' });
    expect(agentChatResponseSchema.parse(wire(unavailable))).toEqual(wire(unavailable));
  });
  it('accepts each actual plan lifecycle response and the immutable repair audit', async () => {
    const h = await fixture();
    expect(agentPlanResponseSchema.parse(wire(h.plan))).toEqual(wire(h.plan));
    const repaired = await h.service.repair({ planId: h.plan.id, userId: buyerId, expectedRevision: 0, reason: 'Explicit replacement',
      replacements: [{ stepId: h.plan.steps[0]!.id, capabilityId: h.alternate.id, capabilityVersionId: h.alternate.versionId }] });
    expect(agentPlanResponseSchema.parse(wire(repaired))).toEqual(wire(repaired));
    const approved = await h.service.approve({ planId: repaired.id, userId: buyerId, expectedRevision: repaired.revision });
    expect(agentPlanResponseSchema.parse(wire(approved))).toEqual(wire(approved));
    const running = await h.service.execute({ planId: repaired.id, userId: buyerId });
    expect(agentPlanResponseSchema.parse(wire(running))).toEqual(wire(running));
    const id = running.steps[0]!.jobId!; h.jobs.set(id, { id, state: 'SUCCEEDED', output: { text: 'done' } });
    const done = await h.service.execute({ planId: repaired.id, userId: buyerId });
    expect(agentPlanResponseSchema.parse(wire(done))).toEqual(wire(done));
  });
  it('rejects public quote priceSnapshot leaking into a persisted internal plan quote or repair audit', async () => {
    const h = await fixture();
    const plan = wire(h.plan);
    Object.assign(plan.steps[0]!.quote, { priceSnapshot: { buyerPriceMinor: 99 } });
    const rejected = agentPlanResponseSchema.safeParse(plan);
    expect(rejected.success).toBe(false);
    if (!rejected.success) expect(rejected.error.issues).toContainEqual(expect.objectContaining({
      code: 'unrecognized_keys', keys: ['priceSnapshot'], path: ['steps', 0, 'quote'],
    }));
    const repaired = wire(await h.service.repair({ planId: h.plan.id, userId: buyerId, expectedRevision: 0, reason: 'Explicit replacement',
      replacements: [{ stepId: h.plan.steps[0]!.id, capabilityId: h.alternate.id, capabilityVersionId: h.alternate.versionId }] }));
    Object.assign(repaired.repairHistory![0]!.previous.steps[0]!.quote, { priceSnapshot: { buyerPriceMinor: 99 } });
    expect(agentPlanResponseSchema.safeParse(repaired).success).toBe(false);
  });
  it('accepts deterministic replan and retained-work responses, including retired failed jobs', async () => {
    const h = await fixture();
    const replanned = await h.service.replan({ planId: h.plan.id, userId: buyerId, expectedRevision: 0,
      reason: 'Alternative company report', stepId: h.plan.steps[0]!.id, query: 'company' });
    expect(agentPlanResponseSchema.parse(wire(replanned))).toEqual(wire(replanned));
    await h.service.approve({ planId: replanned.id, userId: buyerId, expectedRevision: replanned.revision });
    const running = await h.service.execute({ planId: replanned.id, userId: buyerId }); const id = running.steps[0]!.jobId!;
    h.jobs.set(id, { id, state: 'FAILED' }); const failed = await h.service.execute({ planId: replanned.id, userId: buyerId });
    const repaired = await h.service.repair({ planId: failed.id, userId: buyerId, expectedRevision: failed.revision,
      reason: 'Explicit retry with another provider', replacements: [{ stepId: failed.steps[0]!.id, capabilityId: h.cap.id, capabilityVersionId: h.cap.versionId }] });
    expect(repaired.retiredSteps).toHaveLength(1);
    expect(agentPlanResponseSchema.parse(wire(repaired))).toEqual(wire(repaired));
  });
  it('accepts attachment preparation and rejects invented issue enums, statuses and leaked metadata fields', async () => {
    const h = await fixture(); const match = { capabilityId: h.cap.id, capabilityVersionId: h.cap.versionId,
      ...matchDirectContract({ contract: h.cap.ioContract, assets: [] }) };
    expect(agentContractMatchResponseSchema.parse(wire(match))).toEqual(wire(match));
    for (const bad of [{ ...match, status: 'BUY_NOW' }, { ...match, fileBytes: 'private' },
      { ...match, issues: [{ code: 'MODEL_SAYS_FINE', severity: 'CLARIFICATION' }] }]) expect(agentContractMatchResponseSchema.safeParse(bad).success).toBe(false);
    const messages = [...h.conversation.messages, { id: randomUUID(), role: 'user', content: 'attached', createdAt: new Date().toISOString(),
      inputAssetIds: [randomUUID()], requiredOutputFiles: [{ extension: '.pdf', count: 1 }] },
    { id: randomUUID(), role: 'assistant', content: 'missing', createdAt: new Date().toISOString(), contractMatches: [match] }];
    expect(agentConversationsResponseSchema.safeParse(wire([{ ...h.conversation, messages }])).success).toBe(true);
  });
  it('preserves input attachment metadata but rejects download URLs or file bodies inside frozen plan inputs', async () => {
    const h = await fixture(); const inputAsset = { id: randomUUID(), filename: 'scene.blend', mimeType: 'application/x-blender', sizeBytes: 500, sha256: 'a'.repeat(64) };
    const plan = { ...h.plan, inputAssets: [inputAsset] };
    expect(agentPlanResponseSchema.parse(wire(plan))).toEqual(wire(plan));
    for (const leak of [{ downloadUrl: 'https://private.invalid' }, { bytes: 'raw' }, { ownerId: buyerId }]) {
      expect(agentPlanResponseSchema.safeParse(wire({ ...plan, inputAssets: [{ ...inputAsset, ...leak }] })).success).toBe(false);
    }
  });
  it('accepts real synthesis preview/consented result/conversation and agrees with server synthesis schemas', async () => {
    const h = await fixture();
    await h.service.approve({ planId: h.plan.id, userId: buyerId, expectedRevision: 0 });
    const running = await h.service.execute({ planId: h.plan.id, userId: buyerId }); const id = running.steps[0]!.jobId!;
    h.jobs.set(id, { id, state: 'SUCCEEDED', output: { text: 'Buyer-authorized summary input' } });
    await h.service.execute({ planId: h.plan.id, userId: buyerId });
    const profile = InferenceProfileSchema.parse({ provider: 'openai', model: 'local-fixture', structuredOutput: true, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1 });
    const inference = new PlatformInferenceRouter({ providers: [{ id: 'openai', healthCheck: async () => ({ configured: true, healthy: true }), generate: async () => ({
      provider: 'openai', model: 'local-fixture', text: JSON.stringify({ summary: 'Summary', sourceJobIds: [id] }), toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 }, latencyMs: 1,
    }) }], profiles: { RESULT_SYNTHESIS: profile }, accounting: { reserve: async () => 'fixture', finish: async () => {} } });
    const agent = new MarketplaceAgent({ catalog: h.catalog, orchestration: h.service, conversations: h.conversations, inference });
    const preview = await agent.getSynthesisPreview({ planId: h.plan.id, userId: buyerId });
    expect(agentSynthesisPreviewResponseSchema.parse(wire(preview))).toEqual(AgentSynthesisPreviewSchema.parse(wire(preview)));
    const result = await agent.synthesize({ planId: h.plan.id, userId: buyerId, expectedRevision: preview.revision,
      sourceManifestHash: preview.sourceManifestHash, sourceJobIds: [id], consentToProviderProcessing: true });
    expect(agentSynthesisResponseSchema.parse(wire(result))).toEqual(AgentSynthesisResponseSchema.parse(wire(result)));
    expect(agentConversationsResponseSchema.parse(wire([h.conversation]))).toEqual(wire([h.conversation]));
    expect(agentSynthesisResponseSchema.safeParse({ ...result, fileContentsProcessed: true }).success).toBe(false);
    expect(agentSynthesisResponseSchema.safeParse({ ...result, consent: { ...result.consent, sourceJobIds: [id, id] } }).success).toBe(false);
    expect(agentSynthesisPreviewResponseSchema.safeParse({ ...preview, sources: [{ ...preview.sources[0], secret: 'raw' }] }).success).toBe(false);
  });
  it.each(['outer', 'step', 'quote', 'approval', 'constraints', 'timing', 'literal'] as const)('rejects malformed %s plan response fields instead of stripping them', async level => {
    const h = await fixture(); const approved = wire(await h.service.approve({ planId: h.plan.id, userId: buyerId, expectedRevision: 0 }));
    if (level === 'outer') Object.assign(approved, { privateCredential: 'secret' });
    if (level === 'step') approved.steps[0]!.status = 'HIDDEN' as never;
    if (level === 'quote') approved.steps[0]!.quote.amountMinor = -1;
    if (level === 'approval') approved.approval!.planHash = 'not-sha256';
    if (level === 'constraints') Reflect.deleteProperty(approved.constraints, 'maxJobs');
    if (level === 'timing') approved.timing = { mode: 'EARLIEST_AVAILABLE_ALLOWED', allowScheduling: false } as never;
    if (level === 'literal') (approved.steps[0]!.inputMapping[0] as { value: unknown }).value = () => 'not JSON';
    expect(agentPlanResponseSchema.safeParse(approved).success).toBe(false);
  });
  it('rejects incorrect nested chat/conversation types and accepts every current permission network mode', async () => {
    const h = await fixture();
    for (const mode of ['NONE', 'RESEARCH', 'CONNECTORS'] as const) {
      const response = wire(h.chat); response.recommendationDetails![0]!.permissions.networkMode = mode;
      expect(agentChatResponseSchema.safeParse(response).success).toBe(true);
    }
    expect(agentChatResponseSchema.safeParse({ ...h.chat, recommendations: [{ ...h.cap, privateSecret: 'secret' }] }).success).toBe(false);
    expect(agentChatResponseSchema.safeParse({ ...h.chat, recommendations: [{ ...h.cap, seller: { ...h.cap.seller, privateSecret: 'secret' } }] }).success).toBe(false);
    expect(agentConversationsResponseSchema.safeParse([{ ...h.conversation, messages: [{ ...h.conversation.messages[0], role: 'system' }] }]).success).toBe(false);
    expect(agentChatResponseSchema.safeParse({ ...h.chat, inferenceStatus: 'ASSUMED' }).success).toBe(false);
  });
  it('keeps file-output wire and service validators aligned for accepted and adversarial requests', () => {
    for (const request of [[{ extension: '.pdf', count: 1 }], [{ mimeType: 'image/png', count: 20 }], [{ extension: 'PDF', count: 1 }],
      [{ extension: '.pdf', count: 21 }], [{ count: 1 }], [{ extension: '.pdf', count: 1 }, { extension: '.pdf', count: 1 }]]) {
      expect(agentRequiredOutputFilesResponseSchema.safeParse(request).success).toBe(RequiredOutputFilesSchema.safeParse(request).success);
    }
  });
  it('registers all eight current agent response routes with the exact corresponding schema', () => {
    expect(agentResponseRoutes.map(route => `${route.method} ${route.path}`).sort()).toEqual([
      'GET /api/agent/conversations', 'GET /api/agent/plans/:id', 'GET /api/agent/plans/:id/synthesis-preview',
      'POST /api/agent/chat', 'POST /api/agent/plans/:id/approve', 'POST /api/agent/plans/:id/repair',
      'POST /api/agent/plans/:id/replan', 'POST /api/agent/plans/:id/synthesize',
    ]);
    for (const action of ['approve', 'repair', 'replan']) expect(agentResponseRoutes.find(route => route.path.endsWith(action))!.schema).toBe(agentPlanResponseSchema);
  });
});
