import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilityDTO } from '@kivro/contracts';
import { MarketplaceAgent } from '../src/agent.js';
import { InferenceProfileSchema, PlatformInferenceRouter, type PlatformInferenceRequest } from '../src/inference.js';
import { describeRecommendation, rankCandidates } from '../src/policy.js';
import { publicDiscoveryContent, publicDiscoveryContext, publicDiscoveryText } from '../src/public-discovery.js';
import { BuyerConstraintsSchema, type Conversation, type ConversationRepository } from '../src/types.js';
import { buyerId, capability, harness, now } from './fixtures.js';

const constraints = BuyerConstraintsSchema.parse({ maxTotalSpendMinor: 500 });
const base = () => capability({ title: 'Document service', summary: 'Prepare business documents', description: '', category: 'Documents', tags: [] });
const example = () => ({ id: 'public-example', title: 'Public demonstration', input: { subject: 'Published example company' }, output: 'Public output' });

describe('public contract and example discovery', () => {
  it.each([
    ['description', (cap: CapabilityDTO) => { cap.description = 'Specialized actuarial analysis'; }, 'actuarial'],
    ['input label', (cap: CapabilityDTO) => { cap.ioContract.inputs[0]!.label = 'Archaeology material'; }, 'archaeology'],
    ['input description', (cap: CapabilityDTO) => { cap.ioContract.inputs[0]!.description = 'Inspect meteorology observations'; }, 'meteorology'],
    ['semantic type', (cap: CapabilityDTO) => { cap.ioContract.inputs[0]!.constraints = { semanticType: 'genealogy' }; }, 'genealogy'],
    ['schema property', (cap: CapabilityDTO) => { cap.ioContract.inputs[0]!.constraints = { jsonSchema: { type: 'object', properties: { crystallography: { type: 'string' } } } }; }, 'crystallography'],
    ['output description', (cap: CapabilityDTO) => { cap.ioContract.output.description = 'Typography report'; }, 'typography'],
    ['output format', (cap: CapabilityDTO) => { cap.ioContract.output = { type: 'FILES', description: '', required: true, files: { allowedExtensions: ['.pdf'], allowedMimeTypes: ['application/pdf'], maxFiles: 1, maxTotalSizeBytes: 1000 } }; }, 'pdf'],
    ['example title', (cap: CapabilityDTO) => { cap.examples = [{ ...example(), title: 'Palaeontology demo' }]; }, 'palaeontology'],
    ['example input', (cap: CapabilityDTO) => { cap.examples = [{ ...example(), input: { subject: 'Agronomy sample' } }]; }, 'agronomy'],
    ['example output', (cap: CapabilityDTO) => { cap.examples = [{ ...example(), output: 'Seismology findings' }]; }, 'seismology'],
  ] as const)('finds a capability matching only its %s', (_field, change, query) => {
    const cap = base(); change(cap);
    expect(rankCandidates([base(), cap], query, constraints).map(item => item.id)).toEqual([cap.id]);
    expect(describeRecommendation(cap, query, constraints).matchedTerms).toEqual([query]);
  });

  it('uses complete Unicode query words rather than splitting accented terms into unrelated fragments', () => {
    const cap = base(); cap.description = 'R\u00e9sum\u00e9 review';
    expect(rankCandidates([base(), cap], 'r\u00e9sum\u00e9', constraints).map(item => item.id)).toEqual([cap.id]);
    expect(describeRecommendation(cap, 'r\u00e9sum\u00e9', constraints).matchedTerms).toEqual(['r\u00e9sum\u00e9']);
  });

  it('never indexes private seller configuration, unknown example inputs or asset delivery credentials', () => {
    const cap = base();
    Object.assign(cap, { internalInstructions: 'privateinstructionmarker', localPath: '/private/localpathmarker' });
    cap.seller.bio = 'sellerprofilemarker'; cap.permissions.inference.credentialRef = 'credentialmarker';
    cap.permissions.resources = [{ id: 'privateresourcemarker', type: 'DATABASE', access: 'READ_ONLY' }];
    cap.examples = [{ ...example(), input: { subject: 'Public data', undeclared: 'undeclaredmarker' },
      inputAssets: [{ id: randomUUID(), filename: 'public.csv', mimeType: 'text/csv', sha256: 'a'.repeat(64), sizeBytes: 1, reusableTemplate: false, downloadUrl: 'https://storage.invalid/signedtokenmarker' }] }];
    const serialized = JSON.stringify(publicDiscoveryContent(cap));
    for (const marker of ['privateinstructionmarker', 'localpathmarker', 'sellerprofilemarker', 'credentialmarker', 'privateresourcemarker', 'undeclaredmarker', 'signedtokenmarker']) {
      expect(serialized).not.toContain(marker); expect(rankCandidates([cap], marker, constraints)).toEqual([]);
    }
    expect(serialized).toContain('public.csv');
  });

  it('does not redisclose file-input IDs or synthesize contents from example assets', () => {
    const cap = base(); cap.ioContract.inputs.push({ key: 'file', label: 'Document', type: 'FILE', required: false, order: 1,
      constraints: { allowedExtensions: ['.pdf'], allowedMimeTypes: ['application/pdf'], maxFileSizeBytes: 1000 } });
    cap.examples = [{ ...example(), input: { subject: 'Public scalar', file: 'privatefileidmarker' } }];
    expect(JSON.stringify(publicDiscoveryContent(cap))).not.toContain('privatefileidmarker');
  });

  it('immediately removes private versions and revoked examples without a stale persistent index', () => {
    const cap = base(); cap.examples = [{ ...example(), title: 'revocableexamplemarker' }];
    expect(publicDiscoveryText(cap)).toContain('revocableexamplemarker');
    cap.examples = []; expect(publicDiscoveryText(cap)).not.toContain('revocableexamplemarker');
    for (const visibility of ['DRAFT', 'PRIVATE', 'UNLISTED'] as const) {
      cap.visibility = visibility; expect(publicDiscoveryContent(cap)).toBeNull(); expect(publicDiscoveryContext(cap)).toBeNull(); expect(publicDiscoveryText(cap)).toBe('');
    }
  });

  it('keeps public example relevance subordinate to every hard purchase constraint', () => {
    const cap = base(); cap.examples = [{ ...example(), output: 'uniqueexamplemarker' }];
    expect(rankCandidates([cap], 'uniqueexamplemarker', { ...constraints, maxTotalSpendMinor: 98 })).toEqual([]);
    expect(rankCandidates([cap], 'uniqueexamplemarker', { ...constraints, blockedSellers: [cap.seller.id] })).toEqual([]);
    cap.availability.status = 'OFFLINE'; cap.availability.canRunNow = false;
    expect(rankCandidates([cap], 'uniqueexamplemarker', constraints, { mode: 'IMMEDIATE', maxQueueWaitSeconds: 0 }, now)).toEqual([]);
  });

  it('bounds model context separately from the fuller deterministic public index', () => {
    const cap = base(); cap.description = 'd'.repeat(12000);
    cap.examples = Array.from({ length: 10 }, () => ({ ...example(), output: 'o'.repeat(10000), input: { subject: 's'.repeat(2000) } }));
    const context = publicDiscoveryContext(cap)!;
    expect(context.description.length).toBeLessThanOrEqual(512); expect(context.examples).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(768);
    expect(context.examples[0]!.output.length).toBeLessThan(10000); expect(context.examples[0]!.input[0]!.value.length).toBeLessThan(2000);
    expect(publicDiscoveryContent(cap)!.examples).toHaveLength(10);
  });

  it('keeps escaped control and multibyte metadata inside the same serialized context ceiling', () => {
    const cap = base(); cap.description = '\u0001\u6587'.repeat(1000);
    cap.examples = Array.from({ length: 10 }, () => ({ ...example(), title: '\u6587'.repeat(200), description: '\u0001'.repeat(2000),
      input: { subject: '\u0001'.repeat(2000) }, output: '\u6587'.repeat(10000) }));
    expect(Buffer.byteLength(JSON.stringify(publicDiscoveryContext(cap)))).toBeLessThanOrEqual(768);
  });

  it('sends whitelisted public context to recommendation inference without granting purchase or file authority', async () => {
    const cap = base(); cap.description = 'Specialized actuarial analysis'; cap.examples = [{ ...example(), output: 'Actuarial example findings' }];
    Object.assign(cap, { internalInstructions: 'privateinstructionmarker' });
    const h = harness([cap]), seen: PlatformInferenceRequest[] = [];
    const conversation: Conversation = { id: randomUUID(), userId: buyerId, createdAt: now.toISOString(), messages: [] };
    const conversations: ConversationRepository = { create: async () => conversation, get: async () => conversation, list: async () => [conversation], append: vi.fn(async () => {}) };
    const profile = InferenceProfileSchema.parse({ provider: 'openai', model: 'configured', structuredOutput: true, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1 });
    const inference = new PlatformInferenceRouter({ profiles: { INTENT_EXTRACTION: profile, RECOMMENDATION: profile },
      accounting: { reserve: async () => 'public-discovery', finish: async () => {} }, providers: [{ id: 'openai', healthCheck: async () => ({ configured: true, healthy: true }), generate: async request => {
        seen.push(request);
        const reply = request.task === 'INTENT_EXTRACTION' ? { query: 'actuarial', maxSpendMinor: null, maxPerJobSpendMinor: null, maxJobs: null, minRating: null, maxRuntimeSeconds: null, noNetwork: false, onlineOnly: null } : { capabilityIds: [cap.id] };
        return { provider: 'openai', model: 'configured', text: JSON.stringify(reply), toolCalls: [], usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 }, latencyMs: 1 };
      } }] });
    const result = await new MarketplaceAgent({ catalog: h.catalog, orchestration: h.service, conversations, inference }).chat({ userId: buyerId, message: 'actuarial', budgetMinor: 500 });
    expect(result.inferenceStatus).toBe('READY'); expect(result.recommendations.map(item => item.id)).toEqual([cap.id]);
    const records = JSON.parse(seen[1]!.messages.at(-1)!.content).untrustedMarketplaceRecords;
    expect(records[0].description).toBe(cap.description); expect(records[0].examples[0].output).toBe(cap.examples[0]!.output);
    expect(JSON.stringify(seen)).not.toContain('privateinstructionmarker'); expect(JSON.stringify(seen)).not.toContain('never-send-seller-secret');
    expect(h.catalog.quote).not.toHaveBeenCalled(); expect(h.executor.createJob).not.toHaveBeenCalled();
  });
});
