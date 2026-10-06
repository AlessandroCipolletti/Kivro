import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as adapter from '@kivro/openclaw-adapter';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { anthropicRequest, anthropicResponse } from './anthropic.ts';
import { InferenceRequestSchema } from './inference-protocol.ts';
import { InferenceBroker, inferenceReady, validateInferenceConfig } from './inference.ts';
import { SecretStore } from './secrets.ts';
import { WorkerState } from './state.ts';
import * as http from './http.ts';
import { usageReceipt } from './usage.ts';

const secret = 'test-only-dedicated-anthropic-key', marker = 'PRIVATE_FIXTURE_CONTENT';
const tool = { type: 'function', function: { name: 'resource_read', description: 'Read approved snapshot', parameters: { type: 'object', properties: { resourceId: { type: 'string' } }, required: ['resourceId'] } } };
const raw = { model: 'claude-sonnet-4-6', messages: [{ role: 'system', content: 'Trusted system' }, { role: 'developer', content: 'Trusted developer' }, { role: 'user', content: marker }], tools: [tool], max_tokens: 100, stream: true };
const request = () => InferenceRequestSchema.parse(raw);
const reply = (changes: Record<string, unknown> = {}) => ({ id: 'msg_fixture', type: 'message', role: 'assistant', model: raw.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 2 }, ...changes });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(overrides: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-anthropic-'))), state = new WorkerState(root), offer = fixtureOffer();
  const config = validateInferenceConfig({ provider: 'anthropic', model: raw.model, baseUrl: 'https://api.anthropic.com/v1', credentialRef: 'seller-anthropic', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1, ...overrides });
  offer.permissions.inference = { provider: config.provider, model: config.model, credentialRef: config.credentialRef }; offer.permissions.tools = ['resource.read'];
  const broker = new InferenceBroker(config, secret, offer.permissions, state, offer.attemptId);
  cleanups.push(async () => { broker.cancel(); state.close(); await rm(root, { recursive: true, force: true }); });
  return { root, state, config, offer, broker };
}
describe('native Anthropic bridge', () => {
  it('converts system/developer, text, client tools and immediate grouped tool results without enabling server features', () => {
    const body = request(); body.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'toolu_one', type: 'function', function: { name: 'resource_read', arguments: '{"resourceId":"approved"}' } }, { id: 'toolu_two', type: 'function', function: { name: 'resource_read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'toolu_one', content: 'result one' }, { role: 'tool', tool_call_id: 'toolu_two', content: [{ type: 'text', text: 'result two' }] });
    const converted = anthropicRequest(body, 100);
    expect(converted.system).toEqual([{ type: 'text', text: 'Trusted system' }, { type: 'text', text: 'Trusted developer' }]);
    expect(converted.messages).toHaveLength(3); expect(converted.messages.at(-1)?.content.map(block => block.type)).toEqual(['tool_result', 'tool_result']);
    expect(converted.tools?.[0]?.input_schema).toEqual(tool.function.parameters);
    expect(converted).toMatchObject({ thinking: { type: 'disabled' }, service_tier: 'standard_only', stream: false, tool_choice: { type: 'auto', disable_parallel_tool_use: true } });
    expect(JSON.stringify(converted)).not.toMatch(/cache_control|authorization|stream_options|"store"|"n"/);
  });
  it.each(['unknown-result', 'missing-result', 'duplicate-id', 'invalid-arguments', 'late-system', 'unknown-tool', 'interleaved-message'])('rejects ambiguous tool histories before egress: %s', kind => {
    const body = request(), call = { id: 'toolu_one', type: 'function' as const, function: { name: 'resource_read', arguments: '{}' } };
    body.messages.push({ role: 'assistant', tool_calls: [call] }, { role: 'tool', tool_call_id: 'toolu_one', content: 'result' });
    if (kind === 'unknown-result') body.messages.at(-1)!.tool_call_id = 'unknown';
    if (kind === 'missing-result') body.messages.pop();
    if (kind === 'duplicate-id') body.messages[3]!.tool_calls!.push(call);
    if (kind === 'invalid-arguments') call.function.arguments = '[]';
    if (kind === 'late-system') body.messages.push({ role: 'system', content: 'late' });
    if (kind === 'unknown-tool') call.function.name = 'exec';
    if (kind === 'interleaved-message') body.messages.splice(4, 0, { role: 'user', content: 'interrupt' });
    expect(() => anthropicRequest(body, 100)).toThrow('ANTHROPIC_TOOL_HISTORY_INVALID');
  });
  it('maps native tool_use replies and all input/cache usage to the internal OpenAI protocol', () => {
    const result = anthropicResponse(reply({ content: [{ type: 'text', text: 'Reading' }, { type: 'tool_use', id: 'toolu_one', name: 'resource_read', input: { resourceId: 'approved' } }], stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 } }), request());
    expect(result.choices[0]?.message).toMatchObject({ role: 'assistant', content: 'Reading', tool_calls: [{ id: 'toolu_one', type: 'function', function: { name: 'resource_read', arguments: '{"resourceId":"approved"}' } }] });
    expect(result.choices[0]?.finish_reason).toBe('tool_calls'); expect(result.usage).toEqual({ prompt_tokens: 32, completion_tokens: 10, total_tokens: 42 });
  });
  it.each(['thinking', 'server_tool_use', 'refusal', 'max_tokens', 'pause_turn', 'unknown-tool', 'wrong-stop', 'duplicate-id', 'server-charges'])('fails closed on unsupported or inconsistent provider response: %s', kind => {
    const call = { type: 'tool_use', id: 'toolu_one', name: 'resource_read', input: {} };
    let response: unknown = reply({ stop_reason: kind });
    if (['thinking', 'server_tool_use'].includes(kind)) response = reply({ content: [{ type: kind, text: 'do not discard' }] });
    if (kind === 'unknown-tool') response = reply({ content: [{ ...call, name: 'exec' }], stop_reason: 'tool_use' });
    if (kind === 'wrong-stop') response = reply({ content: [call] });
    if (kind === 'duplicate-id') response = reply({ content: [call, call], stop_reason: 'tool_use' });
    if (kind === 'server-charges') response = reply({ usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 1 } } });
    expect(() => anthropicResponse(response, request())).toThrow();
  });
  it('performs a real bounded HTTP tool round trip with native auth and durable conservative accounting', async () => {
    const bodies: Record<string, unknown>[] = [], errors: unknown[] = [];
    const server = createServer(async (req, res) => {
      try {
        expect(req.url).toBe('/v1/messages'); expect(req.headers['x-api-key']).toBe(secret); expect(req.headers['anthropic-version']).toBe('2023-06-01'); expect(req.headers.authorization).toBeUndefined();
        const parts: Buffer[] = []; for await (const chunk of req) parts.push(chunk); bodies.push(JSON.parse(Buffer.concat(parts).toString()));
        res.end(JSON.stringify(bodies.length === 1 ? reply({ content: [{ type: 'tool_use', id: 'toolu_one', name: 'resource_read', input: { resourceId: 'approved' } }], stop_reason: 'tool_use' }) : reply()));
      } catch (error) { errors.push(error); res.writeHead(500).end(); }
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const address = server.address(); if (!address || typeof address === 'string') throw new Error('TEST_ADDRESS');
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); expect(errors).toEqual([]); });
    const { broker, state, offer, root } = await fixture({ baseUrl: `http://127.0.0.1:${address.port}/v1`, allowLocal: true });
    const first = await broker.request(raw) as { choices: { message: unknown }[] };
    const second = await broker.request({ ...raw, messages: [...raw.messages, first.choices[0]!.message, { role: 'tool', tool_call_id: 'toolu_one', content: 'approved snapshot' }] });
    expect(second).toMatchObject({ choices: [{ message: { content: 'OK' } }] }); expect(bodies).toHaveLength(2);
    expect(usageReceipt(state, offer.attemptId)).toMatchObject({ successfulCalls: 2, inputTokens: 40, outputTokens: 4, estimatedCostMicroUsd: 44 });
    const usage = broker.usage(); expect(usage.calls).toBe(2); expect(usage.reservedUsd).toBeCloseTo(((usage.reservedTokens - 200) * 2 + 200) / 1000000);
    expect(state.get(`budget:${new Date().toISOString().slice(0, 10)}`)).toEqual({ tokens: usage.reservedTokens, usd: usage.reservedUsd });
    for (const name of ['state.sqlite', 'state.sqlite-wal']) { const data = await readFile(join(root, name)).catch(() => Buffer.alloc(0)); expect(data.includes(Buffer.from(marker))).toBe(false); expect(data.includes(Buffer.from(secret))).toBe(false); }
  });
  it.each([[400, 'INFERENCE_REQUEST_REJECTED'], [401, 'INFERENCE_CREDENTIAL_INVALID'], [403, 'INFERENCE_CREDENTIAL_INVALID'], [402, 'INFERENCE_QUOTA_EXCEEDED'], [429, 'INFERENCE_QUOTA_EXCEEDED'], [404, 'INFERENCE_MODEL_UNAVAILABLE'], [529, 'INFERENCE_UNAVAILABLE']])('redacts provider status %s, retains reservation and never retries', async (status, code) => {
    const { broker, state } = await fixture(); state.set('inferenceProof', { testedAt: Date.now() });
    const spy = vi.spyOn(http, 'boundedRequest').mockResolvedValue({ status: Number(status), body: Buffer.from(`${secret} ${marker}`), headers: {} });
    await expect(broker.request(raw)).rejects.toThrow(String(code)); expect(spy).toHaveBeenCalledOnce(); expect(broker.usage().reservedTokens).toBeGreaterThan(0);
    if ([401, 402, 403, 429].includes(Number(status))) expect(state.get('inferenceProof')).toBeUndefined();
  });
  it('redacts malformed bodies, secret reflection, transport failures and refuses accounting overruns', async () => {
    const { broker } = await fixture();
    const spy = vi.spyOn(http, 'boundedRequest').mockResolvedValue({ status: 200, body: Buffer.from(secret), headers: {} });
    await expect(broker.request(raw)).rejects.toThrow('INFERENCE_RESPONSE_INVALID');
    spy.mockResolvedValue({ status: 200, body: Buffer.from(JSON.stringify(reply({ content: [{ type: 'text', text: secret }] }))), headers: {} });
    await expect(broker.request(raw)).rejects.toThrow('PROVIDER_SECRET_DISCLOSURE_DENIED');
    spy.mockResolvedValue({ status: 200, body: Buffer.from(JSON.stringify(reply({ usage: { input_tokens: 1, output_tokens: 101 } }))), headers: {} });
    await expect(broker.request(raw)).rejects.toThrow('PROVIDER_TOKEN_BOUND_VIOLATION');
    spy.mockRejectedValue(new Error(`${secret} ${marker}`)); await expect(broker.request(raw)).rejects.toThrow('INFERENCE_UNAVAILABLE');
    broker.cancel(); await expect(broker.request(raw)).rejects.toThrow('INFERENCE_PAUSED');
  });
  it('denies custom native endpoints, mismatched grants, unreviewed sampling and budgets before network calls', async () => {
    const { config, state, offer, broker } = await fixture({ maxUsdPerJob: 0.00001 });
    const spy = vi.spyOn(http, 'boundedRequest');
    expect(() => validateInferenceConfig({ ...config, baseUrl: 'https://other.example/v1' })).toThrow('ANTHROPIC_OFFICIAL_ENDPOINT_REQUIRED');
    expect(() => new InferenceBroker(config, secret, { ...offer.permissions, inference: { ...offer.permissions.inference, provider: 'openai-compatible' } }, state, offer.attemptId)).toThrow('PERMISSION_MISMATCH');
    await expect(broker.request({ ...raw, temperature: 0 })).rejects.toThrow('SAMPLING_UNSUPPORTED');
    await expect(broker.request(raw)).rejects.toThrow('BUDGET_EXCEEDED'); expect(spy).not.toHaveBeenCalled();
    expect(adapter.assertWorkerPermissions(offer.permissions).inference.provider).toBe('anthropic');
    expect(adapter.buildOpenClawConfig(offer.permissions)).toMatchObject({ models: { providers: { kivro: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:18789/v1' } } } });
  });
  it('counts cached input against the same durable token bound and invalidates unavailable local inference', async () => {
    const { broker, state } = await fixture({ allowLocal: true, baseUrl: 'http://127.0.0.1:12345/v1' });
    const spy = vi.spyOn(http, 'boundedRequest').mockResolvedValue({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(reply({ usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 200000 } }))) });
    await expect(broker.request(raw)).rejects.toThrow('PROVIDER_TOKEN_BOUND_VIOLATION'); expect(broker.usage().reservedTokens).toBeGreaterThan(0);
    state.set('inferenceProof', { testedAt: Date.now() }); spy.mockRejectedValue(new Error('local private path diagnostic'));
    await expect(broker.request(raw)).rejects.toThrow('LOCAL_INFERENCE_OFFLINE'); expect(state.get('inferenceProof')).toBeUndefined();
  });
  it('rejects concurrency and cancellation aborts the active native request without refunds or retries', async () => {
    const { broker, state } = await fixture(); state.set('inferenceProof', { testedAt: Date.now() });
    const spy = vi.spyOn(http, 'boundedRequest').mockImplementation((_url, options) => new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error(secret)), { once: true })));
    const active = broker.request(raw), rejected = expect(active).rejects.toThrow('INFERENCE_CANCELLED');
    await expect(broker.request(raw)).rejects.toThrow('CONCURRENT_INFERENCE_DENIED'); broker.cancel(); await rejected;
    expect(spy).toHaveBeenCalledOnce(); expect(broker.usage().reservedTokens).toBeGreaterThan(0); expect(state.get('inferenceProof')).toBeTruthy();
  });
  it('uses explicit seller secret storage, never env provider keys, and invalidates rotated proof (mock Keychain only)', async () => {
    const { state, config } = await fixture(); state.set('inference', config);
    vi.stubEnv('ANTHROPIC_API_KEY', secret); vi.stubEnv('OPENAI_API_KEY', secret); vi.stubEnv('KIVRO_WORKER_MASTER_KEY', '');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const keychain = vi.spyOn(adapter, 'runProcess').mockResolvedValue({ code: 0, stdout: `${'ab'.repeat(32)}\n`, stderr: '' });
    const secrets = new SecretStore(state);
    expect((await inferenceReady(state, secrets)).ready).toBe(false); expect(secrets.has(config.credentialRef)).toBe(false);
    await secrets.put(config.credentialRef, secret); expect(await secrets.get(config.credentialRef)).toBe(secret);
    expect(JSON.stringify(state.get(`secret:${config.credentialRef}`))).not.toContain(secret);
    expect(keychain).toHaveBeenCalledWith('/usr/bin/security', expect.arrayContaining(['find-generic-password', 'io.kivro.worker.master']));
    state.set('inferenceProof', { hash: 'previous', testedAt: Date.now() }); await secrets.put(config.credentialRef, 'rotated-test-only-secret'); expect(state.get('inferenceProof')).toBeUndefined();
  });
});
