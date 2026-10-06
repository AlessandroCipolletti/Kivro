import { describe, expect, it, vi } from 'vitest';
import type { HttpTransport } from '@kivro/research-broker';
import { AnthropicPlatformProvider, createInferenceConfiguration, executeToolCalls, InferenceError, InferenceProfileSchema,
  OpenAIPlatformProvider, PlatformInferenceRouter, type InferenceAccounting, type PlatformInferenceProvider,
  type PlatformInferenceRequest, type PlatformInferenceResponse } from '../src/inference.js';
import { buyerId } from './fixtures.js';

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const request: PlatformInferenceRequest = { task: 'RECOMMENDATION', system: 'Return a result', messages: [{ role: 'user', content: 'request' }], responseSchema: schema, metadata: { userId: buyerId } };
const profile = InferenceProfileSchema.parse({ provider: 'openai', model: 'configured-model', inputMicroUsdPerMillionTokens: 1_000_000,
  outputMicroUsdPerMillionTokens: 4_000_000, structuredOutput: true });
function httpFixture(body: unknown, status = 200): HttpTransport {
  return { request: vi.fn(async () => ({ status, headers: { 'content-type': 'application/json' }, finalUrl: 'https://api.example', body: Buffer.from(JSON.stringify(body)) })) };
}
function setup() {
  const response: PlatformInferenceResponse = { provider: 'openai', model: 'configured-model', text: '{"answer":"ok"}', toolCalls: [],
    usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0 }, latencyMs: 1 };
  const provider: PlatformInferenceProvider = { id: 'openai', generate: vi.fn(async () => structuredClone(response)),
    healthCheck: vi.fn(async () => ({ configured: true, healthy: true })) };
  const accounting: InferenceAccounting = { reserve: vi.fn(async () => 'reserved'), finish: vi.fn(async () => {}) };
  const router = new PlatformInferenceRouter({ providers: [provider], profiles: { RECOMMENDATION: profile }, accounting, sleep: async () => {} });
  return { provider, response, accounting, router };
}

describe('official provider wire contracts', () => {
  it('uses OpenAI Responses, normalized function calls, store:false and native JSON schema', async () => {
    const http = httpFixture({ status: 'completed', model: 'actual-model', output: [
      { type: 'function_call', call_id: 'call-1', name: 'search_capabilities', arguments: '{"query":"company"}' },
      { type: 'reasoning', summary: [{ text: 'hidden' }] },
    ], usage: { input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 3 } } });
    const provider = new OpenAIPlatformProvider('test-platform-secret', http);
    const response = await provider.generate({ ...request, model: 'configured-model', maxOutputTokens: 100, timeoutMs: 1000,
      tools: [{ name: 'search_capabilities', description: 'Search', parameters: schema }] });
    expect(response.toolCalls).toEqual([{ id: 'call-1', name: 'search_capabilities', arguments: { query: 'company' } }]);
    expect(response.model).toBe('actual-model'); expect(JSON.stringify(response)).not.toContain('hidden');
    const sent = vi.mocked(http.request).mock.calls[0]![0]; const body = JSON.parse(sent.body!);
    expect(sent.url).toBe('https://api.openai.com/v1/responses'); expect(sent.maxRedirects).toBe(0);
    expect(body).toMatchObject({ store: false, max_output_tokens: 100, text: { format: { type: 'json_schema', strict: true } },
      tools: [{ type: 'function', strict: true, name: 'search_capabilities' }] });
  });
  it('uses Anthropic Messages with output_config.format and normalizes cache usage', async () => {
    const http = httpFixture({ model: 'actual-model', stop_reason: 'tool_use', content: [
      { type: 'thinking', thinking: 'hidden' }, { type: 'tool_use', id: 'call-1', name: 'search_capabilities', input: { query: 'company' } },
    ], usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 3 } });
    const response = await new AnthropicPlatformProvider('anthropic-secret', http).generate({ ...request, model: 'configured-model', maxOutputTokens: 100, timeoutMs: 1000,
      tools: [{ name: 'search_capabilities', description: 'Search', parameters: schema }],
      messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'prior', name: 'search_capabilities', arguments: {} }] },
        { role: 'tool', callId: 'prior', content: '[]' }] });
    expect(response.toolCalls[0]).toMatchObject({ id: 'call-1', name: 'search_capabilities', arguments: { query: 'company' } });
    expect(response.usage).toEqual({ inputTokens: 27, outputTokens: 10, cachedInputTokens: 4 });
    expect(JSON.stringify(response)).not.toContain('hidden');
    const sent = vi.mocked(http.request).mock.calls[0]![0]; const body = JSON.parse(sent.body!);
    expect(sent.url).toBe('https://api.anthropic.com/v1/messages'); expect(sent.headers!['anthropic-version']).toBe('2023-06-01');
    expect(body).toMatchObject({ output_config: { format: { type: 'json_schema', schema } }, tools: [{ strict: true, input_schema: schema }] });
    expect(body.messages[1]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'prior' }] });
  });
  it('rejects truncated and refused responses, excluding provider bodies from errors', async () => {
    const response = { model: 'model', stop_reason: 'refusal', content: [{ type: 'text', text: 'sensitive' }], usage: { input_tokens: 1, output_tokens: 1 } };
    const args = { ...request, model: 'model', maxOutputTokens: 100, timeoutMs: 1000 };
    await expect(new AnthropicPlatformProvider('key', httpFixture(response)).generate(args)).rejects.toMatchObject({ code: 'CONTENT_POLICY', message: 'CONTENT_POLICY' });
    response.stop_reason = 'max_tokens';
    await expect(new AnthropicPlatformProvider('key', httpFixture(response)).generate(args)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
describe('inference policy boundary', () => {
  it('validates structured output and records usage separately from purchases', async () => {
    const h = setup(); expect((await h.router.generate(request)).structuredOutput).toEqual({ answer: 'ok' });
    expect(h.accounting.reserve).toHaveBeenCalledWith(expect.objectContaining({ maxCostMicroUsd: 40192, metadata: { userId: buyerId } }));
    expect(h.accounting.finish).toHaveBeenCalledWith('reserved', expect.objectContaining({ costMicroUsd: 60, outcome: 'SUCCEEDED' }));
  });
  it('bounds malformed JSON retries and charges uncertain attempts', async () => {
    const h = setup(); h.response.text = '{bad';
    await expect(h.router.generate(request)).rejects.toThrow('INVALID_RESPONSE');
    expect(h.provider.generate).toHaveBeenCalledTimes(2); expect(h.accounting.reserve).toHaveBeenCalledTimes(2);
    expect(h.accounting.finish).toHaveBeenLastCalledWith('reserved', expect.objectContaining({ outcome: 'FAILED', costMicroUsd: 40192 }));
  });
  it('fails before contacting providers when the budget is exhausted', async () => {
    const h = setup(); vi.mocked(h.accounting.reserve).mockRejectedValue(new InferenceError('INFERENCE_BUDGET_EXCEEDED'));
    await expect(h.router.generate(request)).rejects.toThrow('INFERENCE_BUDGET_EXCEEDED'); expect(h.provider.generate).not.toHaveBeenCalled();
  });
  it.each(['AUTHENTICATION_ERROR', 'CONTENT_POLICY', 'INVALID_TOOL_CALL', 'INVALID_REQUEST', 'INFERENCE_BUDGET_EXCEEDED'] as const)('never retries %s', async code => {
    const h = setup(); vi.mocked(h.provider.generate).mockRejectedValue(new InferenceError(code));
    await expect(h.router.generate(request)).rejects.toThrow(code); expect(h.provider.generate).toHaveBeenCalledTimes(1);
  });
  it('falls back only on transient failures and records the actual provider', async () => {
    const h = setup(); vi.mocked(h.provider.generate).mockRejectedValue(new InferenceError('RATE_LIMITED', 0));
    const fallback: PlatformInferenceProvider = { ...h.provider, id: 'anthropic', generate: vi.fn(async () => ({ ...h.response, provider: 'anthropic' })) };
    const router = new PlatformInferenceRouter({ providers: [h.provider, fallback], profiles: { RECOMMENDATION: profile },
      fallbacks: { RECOMMENDATION: { ...profile, provider: 'anthropic' } }, accounting: h.accounting, sleep: async () => {} });
    expect((await router.generate(request)).provider).toBe('anthropic'); expect(fallback.generate).toHaveBeenCalledTimes(1);
  });
  it('blocks invented tools and malformed parameters before any executor', async () => {
    const h = setup(); h.response.toolCalls = [{ id: 'call-1', name: 'purchase_anything', arguments: {} }];
    await expect(h.router.generate(request)).rejects.toThrow('INVALID_TOOL_CALL'); expect(h.provider.generate).toHaveBeenCalledTimes(1);
  });
  it('authorizes the entire tool batch before invoking any tool', async () => {
    const execute = vi.fn(async () => ({ answer: 'ok' }));
    await expect(executeToolCalls([{ id: '1', name: 'read', arguments: { answer: 'ok' } }, { id: '2', name: 'buy', arguments: {} }],
      [{ definition: { name: 'read', description: 'read', parameters: schema }, authorize: async () => {}, execute }], buyerId)).rejects.toThrow('INVALID_TOOL_CALL');
    expect(execute).not.toHaveBeenCalled();
  });
  it('selects either provider alone with budgeted defaults and supports explicit custom profiles', () => {
    const pricing = { PLATFORM_INFERENCE_MODEL: 'configured', PLATFORM_INFERENCE_INPUT_MICRO_USD_PER_MILLION: '1000000', PLATFORM_INFERENCE_OUTPUT_MICRO_USD_PER_MILLION: '4000000' };
    expect(createInferenceConfiguration({ OPENAI_API_KEY: 'key' }).profiles.RECOMMENDATION).toMatchObject({ provider: 'openai', model: 'gpt-4.1-mini-2025-04-14', inputMicroUsdPerMillionTokens: 400000, outputMicroUsdPerMillionTokens: 1600000 });
    expect(createInferenceConfiguration({ ANTHROPIC_API_KEY: 'key' }).profiles.RECOMMENDATION).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 5000000 });
    expect(createInferenceConfiguration({ ...pricing, PLATFORM_INFERENCE_PROVIDER: 'openai', PLATFORM_OPENAI_API_KEY: 'key' }).providers.map(p => p.id)).toEqual(['openai']);
    expect(createInferenceConfiguration({ ...pricing, PLATFORM_INFERENCE_PROVIDER: 'anthropic', PLATFORM_ANTHROPIC_API_KEY: 'key' }).providers.map(p => p.id)).toEqual(['anthropic']);
    expect(JSON.stringify(createInferenceConfiguration({ PLATFORM_OPENAI_API_KEY: 'secret-value-to-redact' }))).not.toContain('secret-value-to-redact');
  });
  it('requires an explicit choice when both keys exist and never silently sends content to the other provider', () => {
    const keys = { OPENAI_API_KEY: 'openai-test-secret', ANTHROPIC_API_KEY: 'anthropic-test-secret' };
    expect(() => createInferenceConfiguration(keys)).toThrow('Both provider keys');
    for (const provider of ['openai', 'anthropic']) {
      const config = createInferenceConfiguration({ ...keys, PLATFORM_INFERENCE_PROVIDER: provider });
      expect(Object.values(config.profiles).every(profile => profile.provider === provider)).toBe(true);
      expect(JSON.stringify(config)).not.toContain('test-secret');
    }
    expect(() => createInferenceConfiguration({ OPENAI_API_KEY: 'key', PLATFORM_INFERENCE_PROVIDER: 'anthropic' })).toThrow('no API key');
    expect(() => createInferenceConfiguration({ OPENAI_API_KEY: 'key', PLATFORM_INFERENCE_PROVIDER: 'unknown' })).toThrow('must be openai or anthropic');
  });
  it('treats empty env template values as unset and does not guess prices for custom models', () => {
    expect(createInferenceConfiguration({ OPENAI_API_KEY: '  ', ANTHROPIC_API_KEY: '' }).profiles).toEqual({});
    expect(createInferenceConfiguration({ OPENAI_API_KEY: 'key', PLATFORM_INFERENCE_PROVIDER: '', PLATFORM_INFERENCE_MODEL: '', PLATFORM_OPENAI_API_KEY: '' }).providers.map(provider => provider.id)).toEqual(['openai']);
    expect(() => createInferenceConfiguration({ ANTHROPIC_API_KEY: 'key', PLATFORM_INFERENCE_MODEL: 'custom' })).toThrow('explicit input/output');
    expect(() => createInferenceConfiguration({ OPENAI_API_KEY: 'key', PLATFORM_INFERENCE_INPUT_MICRO_USD_PER_MILLION: '10' })).toThrow('both');
    expect(() => createInferenceConfiguration({ OPENAI_API_KEY: 'key', PLATFORM_INFERENCE_INPUT_MICRO_USD_PER_MILLION: '-1', PLATFORM_INFERENCE_OUTPUT_MICRO_USD_PER_MILLION: '0' })).toThrow();
  });
  it('rejects regex/recursive schema features before spending inference budget', async () => {
    const h = setup();
    await expect(h.router.generate({ ...request, responseSchema: { type: 'string', pattern: '^(a+)+$' } })).rejects.toThrow('INVALID_REQUEST');
    await expect(h.router.generate({ ...request, responseSchema: { type: 'object', dependencies: { a: { pattern: '^(a+)+$' } } } })).rejects.toThrow('INVALID_REQUEST');
    expect(h.accounting.reserve).not.toHaveBeenCalled(); expect(h.provider.generate).not.toHaveBeenCalled();
  });
});
