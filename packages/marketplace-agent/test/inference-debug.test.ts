import { describe, expect, it, vi } from 'vitest';
import { createDevelopmentInferenceDebug, InferenceProfileSchema, PlatformInferenceRouter,
  type InferenceAccounting, type PlatformInferenceRequest } from '../src/inference.js';
import type { InferenceDebugEvent, InferenceDebugWarning } from '../src/inference-debug.js';
import { buyerId } from './fixtures.js';

describe('development-only redacted inference diagnostics', () => {
  it.each([undefined, '', 'false'])('is disabled by default or %j without emitting a warning', flag => {
    const write = vi.fn();
    expect(createDevelopmentInferenceDebug({ PLATFORM_INFERENCE_DEBUG: flag }, write)).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });
  it.each([
    {}, { NODE_ENV: 'production' }, { KIVRO_ENV: 'production', NODE_ENV: 'test' },
    { NODE_ENV: 'production', KIVRO_ENV: 'development' }, { KIVRO_ENV: 'staging', NODE_ENV: 'test' },
    { KIVRO_ENV: 'preview', NODE_ENV: 'development' }, { KIVRO_ENV: 'unknown' },
  ])('rejects debug in nondevelopment configuration %j before logging', env => {
    const write = vi.fn();
    expect(() => createDevelopmentInferenceDebug({ ...env, PLATFORM_INFERENCE_DEBUG: 'true' }, write)).toThrow('restricted');
    expect(write).not.toHaveBeenCalled();
  });
  it.each(['1', 'yes', 'TRUE', 'invalid-private-value'])('rejects invalid flags without echoing %j', value => {
    const write = vi.fn();
    expect(() => createDevelopmentInferenceDebug({ NODE_ENV: 'test', PLATFORM_INFERENCE_DEBUG: value }, write)).toThrow('must be true or false');
    expect(write).not.toHaveBeenCalled();
  });
  const profile = InferenceProfileSchema.parse({ provider: 'openai', model: 'synthetic-model', inputMicroUsdPerMillionTokens: 1_000_000,
    outputMicroUsdPerMillionTokens: 4_000_000, structuredOutput: true, maxAttempts: 1 });
  const privateMarker = 'private-prompt-response-api-key-and-tool-argument';
  const request: PlatformInferenceRequest = { task: 'RECOMMENDATION', system: privateMarker,
    messages: [{ role: 'user', content: privateMarker }, { role: 'assistant', content: privateMarker,
      toolCalls: [{ id: privateMarker, name: 'private_tool_name', arguments: { secret: privateMarker } }] },
    { role: 'tool', callId: privateMarker, content: privateMarker }],
    tools: [{ name: 'private_tool_name', description: privateMarker, parameters: { type: 'object', properties: {} } }],
    responseSchema: { type: 'object', properties: { private_schema_field: { type: 'string' } }, required: ['private_schema_field'], additionalProperties: false },
    metadata: { userId: buyerId } };
  function fixture(write: (event: InferenceDebugEvent | InferenceDebugWarning) => void) {
    const debug = createDevelopmentInferenceDebug({ NODE_ENV: 'test', PLATFORM_INFERENCE_DEBUG: 'true' }, write);
    const provider = { id: 'openai', generate: vi.fn(async () => ({ provider: 'openai', model: 'synthetic-model',
      text: JSON.stringify({ private_schema_field: privateMarker }), toolCalls: [], latencyMs: 7,
      usage: { inputTokens: 50, outputTokens: 15, cachedInputTokens: 0 } })),
    healthCheck: async () => ({ configured: true, healthy: true }) };
    const accounting: InferenceAccounting = { reserve: vi.fn(async () => 'reservation'), finish: vi.fn(async () => {}) };
    return { router: new PlatformInferenceRouter({ providers: [provider], profiles: { RECOMMENDATION: profile }, accounting, debug }), provider, accounting };
  }
  it('warns once, correlates requests and fully removes sensitive content from debug and accounting', async () => {
    const events: (InferenceDebugEvent | InferenceDebugWarning)[] = [];
    const { router, accounting } = fixture(event => events.push(event));
    const response = await router.generate(request);
    expect(response.text).toContain(privateMarker);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ event: 'DEVELOPMENT_INFERENCE_DEBUG_ENABLED', warning: expect.stringContaining('DEVELOPMENT ONLY') });
    expect(events[1]).toMatchObject({ phase: 'REQUEST', contentRedacted: true, messageCount: 3, toolDefinitionCount: 1, structuredOutputRequested: true });
    expect(events[2]).toMatchObject({ phase: 'RESPONSE', contentRedacted: true, toolCallCount: 0 });
    const sent = vi.mocked(accounting.reserve).mock.calls[0]![0];
    expect(events[1]).toMatchObject({ requestId: sent.requestId, metadata: sent.metadata });
    expect(events[2]).toMatchObject({ requestId: sent.requestId });
    expect(accounting.finish).toHaveBeenCalledWith('reservation', expect.objectContaining({ outcome: 'SUCCEEDED', toolCallCount: 0 }));
    const logged = JSON.stringify({ events, accounting: vi.mocked(accounting.finish).mock.calls });
    for (const secret of [privateMarker, 'private_tool_name', 'private_schema_field']) expect(logged).not.toContain(secret);
  });
  it('logs only normalized failure codes and preserves failed-attempt accounting', async () => {
    const events: (InferenceDebugEvent | InferenceDebugWarning)[] = [], h = fixture(event => events.push(event));
    h.provider.generate.mockRejectedValue(new Error(privateMarker));
    await expect(h.router.generate(request)).rejects.toThrow('UNKNOWN_PROVIDER_ERROR');
    expect(events.at(-1)).toMatchObject({ phase: 'ERROR', code: 'UNKNOWN_PROVIDER_ERROR', contentRedacted: true });
    expect(JSON.stringify(events)).not.toContain(privateMarker);
    expect(h.accounting.finish).toHaveBeenCalledTimes(1);
  });
  it('does not retry or change settlement if the debug sink fails', async () => {
    const h = fixture(() => { throw new Error(privateMarker); });
    await expect(h.router.generate(request)).resolves.toMatchObject({ provider: 'openai' });
    expect(h.provider.generate).toHaveBeenCalledTimes(1);
    expect(h.accounting.reserve).toHaveBeenCalledTimes(1);
    expect(h.accounting.finish).toHaveBeenCalledTimes(1);
  });
});
