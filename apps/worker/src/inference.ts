import { z } from 'zod';
import { hashManifest, type PermissionManifest } from '@kivro/contracts';
import { boundedRequest } from './http.ts';
import type { SecretStore } from './secrets.ts';
import type { WorkerState } from './state.ts';
import { InferenceRequestSchema } from './inference-protocol.ts';
import { anthropicRequest, anthropicResponse } from './anthropic.ts';
import { initializeUsage, reserveUsage, reportUsage, usageSummary, tokenCostMicroUsd, usdToMicroUsd } from './usage.ts';
import { checkLocalInference } from './local-inference.ts';

export const InferenceConfigSchema = z.object({
  provider: z.enum(['openai-compatible', 'anthropic']), model: z.string().regex(/^[A-Za-z0-9_./:@-]{1,200}$/),
  baseUrl: z.string().url(), credentialRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
  allowLocal: z.boolean().default(false), maxCallsPerJob: z.number().int().min(1).max(32).default(8),
  maxTokensPerJob: z.number().int().min(1000).max(200000).default(64000),
  dailyTokenLimit: z.number().int().min(1000).max(10000000).default(500000),
  maxOutputTokensPerCall: z.number().int().min(1).max(16384).default(4096),
  inputUsdPerMillionTokens: z.number().nonnegative().max(1000), outputUsdPerMillionTokens: z.number().nonnegative().max(1000),
  maxUsdPerJob: z.number().positive().max(100).default(1), dailyUsdLimit: z.number().positive().max(10000).default(10),
}).strict();
export type InferenceConfig = z.infer<typeof InferenceConfigSchema>;
export function validateInferenceConfig(raw: unknown): InferenceConfig {
  const config = InferenceConfigSchema.parse(raw), url = new URL(config.baseUrl);
  if (url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9/_-]*$/.test(url.pathname)) throw new Error('UNSAFE_INFERENCE_ENDPOINT');
  const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (config.allowLocal ? !loopback : url.protocol !== 'https:') throw new Error('INFERENCE_HTTPS_OR_EXPLICIT_LOOPBACK_REQUIRED');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('UNSAFE_INFERENCE_PROTOCOL');
  if (config.provider === 'anthropic' && !config.allowLocal && (url.origin !== 'https://api.anthropic.com' || !['/v1', '/v1/'].includes(url.pathname))) throw new Error('ANTHROPIC_OFFICIAL_ENDPOINT_REQUIRED');
  return config;
}

const CompletionSchema = z.object({ id: z.string(), created: z.number().optional(), model: z.string(), choices: z.array(z.object({ index: z.number(), message: z.record(z.unknown()), finish_reason: z.string().nullable() })).length(1), usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative() }) });

export class InferenceBroker {
  private paused = false;
  private controller = new AbortController();
  private active?: Promise<unknown>;
  private calls = 0;
  private reservedTokens = 0;
  private reservedCostMicroUsd = 0;
  constructor(readonly config: InferenceConfig, readonly credential: string, readonly permissions: PermissionManifest, readonly state: WorkerState, readonly attemptId: string) {
    validateInferenceConfig(config);
    if (!credential || credential.length > 16384 || /[^\x21-\x7e]/.test(credential)) throw new Error('INFERENCE_CREDENTIAL_FORMAT_INVALID');
    if (permissions.inference.provider !== config.provider || permissions.inference.model !== config.model || permissions.inference.credentialRef !== config.credentialRef) throw new Error('INFERENCE_PERMISSION_MISMATCH');
    initializeUsage(state, attemptId, { provider: config.provider, model: config.model, inputUsdPerMillionTokens: config.inputUsdPerMillionTokens, outputUsdPerMillionTokens: config.outputUsdPerMillionTokens });
    const previous = usageSummary(state, attemptId); this.calls = previous.calls; this.reservedTokens = previous.reservedTokens; this.reservedCostMicroUsd = previous.reservedCostMicroUsd;
  }
  async request(raw: Record<string, unknown>): Promise<unknown> {
    if (this.paused || this.controller.signal.aborted) throw new Error('INFERENCE_PAUSED');
    if (this.active) throw new Error('CONCURRENT_INFERENCE_DENIED');
    this.active = this.perform(raw);
    try { return await this.active; } finally { this.active = undefined; }
  }
  private async perform(raw: Record<string, unknown>): Promise<unknown> {
    const parsed = InferenceRequestSchema.safeParse(raw);
    if (!parsed.success) throw new Error('INFERENCE_REQUEST_INVALID');
    const body = parsed.data;
    if (body.model !== this.config.model) throw new Error('INFERENCE_MODEL_DENIED');
    if (body.tools?.some(tool => !this.permissions.tools.map(name => name.replaceAll('.', '_')).includes(tool.function.name))) throw new Error('INFERENCE_TOOL_DENIED');
    const outputTokens = Math.min(body.max_completion_tokens ?? body.max_tokens ?? this.config.maxOutputTokensPerCall, this.config.maxOutputTokensPerCall);
    const nativeAnthropic = this.config.provider === 'anthropic';
    const upstream = nativeAnthropic ? anthropicRequest(body, outputTokens) : { model: body.model, messages: body.messages, ...(body.tools?.length ? { tools: body.tools, tool_choice: body.tool_choice ?? 'auto' } : {}), ...(body.temperature !== undefined ? { temperature: body.temperature } : {}), ...(body.top_p !== undefined ? { top_p: body.top_p } : {}), max_tokens: outputTokens, stream: false, n: 1, store: false };
    if (this.calls >= this.config.maxCallsPerJob) throw new Error('INFERENCE_CALL_LIMIT');
    // UTF-8 bytes plus per-message framing is a conservative upper bound for
    // supported byte-tokenized chat models; reservations are never refunded.
    const inputTokens = Math.max(Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools ?? [] })), nativeAnthropic ? Buffer.byteLength(JSON.stringify(upstream)) : 0) + body.messages.length * 64 + 1024;
    const reserve = inputTokens + outputTokens;
    // Cache creation is not requested. Reserve its maximum 2x input price too,
    // so reported cache writes cannot escape the configured seller cost limit.
    const reservedCostMicroUsd = tokenCostMicroUsd(inputTokens, outputTokens, this.config, nativeAnthropic ? 2 : 1);
    if (this.reservedTokens + reserve > Math.min(this.config.maxTokensPerJob, this.permissions.limits.maxTokens) || this.reservedCostMicroUsd + reservedCostMicroUsd > usdToMicroUsd(this.config.maxUsdPerJob)) throw new Error('INFERENCE_BUDGET_EXCEEDED');
    const day = new Date().toISOString().slice(0, 10);
    const callId = this.state.transaction(() => {
      const budget = this.state.get<{ tokens: number; usd: number }>(`budget:${day}`) ?? { tokens: 0, usd: 0 };
      const dayCost = usdToMicroUsd(budget.usd, true) + reservedCostMicroUsd;
      if (budget.tokens + reserve > this.config.dailyTokenLimit || dayCost > usdToMicroUsd(this.config.dailyUsdLimit)) throw new Error('DAILY_INFERENCE_BUDGET_EXCEEDED');
      this.state.set(`budget:${day}`, { tokens: budget.tokens + reserve, usd: dayCost / 1000000 });
      this.state.audit('INFERENCE_BUDGET_RESERVED', 'BROKER', this.attemptId);
      return reserveUsage(this.state, this.attemptId, reserve, reservedCostMicroUsd);
    });
    this.calls++; this.reservedTokens += reserve; this.reservedCostMicroUsd += reservedCostMicroUsd;
    const url = new URL(`${this.config.baseUrl.replace(/\/$/, '')}/${nativeAnthropic ? 'messages' : 'chat/completions'}`);
    let response: Awaited<ReturnType<typeof boundedRequest>>;
    try { response = await boundedRequest(url, { method: 'POST', headers: { ...(nativeAnthropic ? { 'x-api-key': this.credential, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${this.credential}` }), 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(upstream)), maxBytes: Math.min(8 * 1024 ** 2, this.permissions.limits.maxOutputBytes + 1024 * 1024), timeoutMs: 60_000, signal: this.controller.signal, publicOnly: true, localApproved: this.config.allowLocal }); }
    catch {
      if (this.controller.signal.aborted) throw new Error('INFERENCE_CANCELLED');
      this.state.delete('inferenceProof'); throw new Error(this.config.allowLocal ? 'LOCAL_INFERENCE_OFFLINE' : 'INFERENCE_UNAVAILABLE');
    }
    if ([401, 403].includes(response.status)) { this.state.delete('inferenceProof'); throw new Error('INFERENCE_CREDENTIAL_INVALID'); }
    if ([402, 429].includes(response.status)) { this.state.delete('inferenceProof'); throw new Error('INFERENCE_QUOTA_EXCEEDED'); }
    if (response.status === 400) throw new Error('INFERENCE_REQUEST_REJECTED');
    if (response.status === 404) { this.state.delete('inferenceProof'); throw new Error('INFERENCE_MODEL_UNAVAILABLE'); }
    if (response.status !== 200) { this.state.delete('inferenceProof'); throw new Error('INFERENCE_UNAVAILABLE'); }
    let json: unknown; try { json = JSON.parse(response.body.toString()); } catch { throw new Error('INFERENCE_RESPONSE_INVALID'); }
    if (this.credential.length >= 8 && JSON.stringify(json).includes(this.credential)) throw new Error('PROVIDER_SECRET_DISCLOSURE_DENIED');
    const parsedResult = nativeAnthropic ? CompletionSchema.safeParse(anthropicResponse(json, body)) : CompletionSchema.safeParse(json);
    if (!parsedResult.success) throw new Error('INFERENCE_RESPONSE_INVALID');
    const result = parsedResult.data;
    if (result.usage.completion_tokens > outputTokens || result.usage.prompt_tokens > inputTokens || result.usage.total_tokens !== result.usage.prompt_tokens + result.usage.completion_tokens || result.usage.total_tokens > reserve) throw new Error('PROVIDER_TOKEN_BOUND_VIOLATION');
    reportUsage(this.state, this.attemptId, callId, result.usage.prompt_tokens, result.usage.completion_tokens);
    return result;
  }
  async pause(): Promise<void> { this.paused = true; try { await this.active; } catch { /* The runtime will receive the bounded provider failure on resume. */ } }
  resume(): void { if (this.controller.signal.aborted) throw new Error('INFERENCE_CANCELLED'); this.paused = false; }
  cancel(): void { this.paused = true; this.controller.abort(); }
  usage() { return { calls: this.calls, reservedTokens: this.reservedTokens, reservedUsd: this.reservedCostMicroUsd / 1000000 }; }
}

export async function inferenceReady(state: WorkerState, secrets: SecretStore): Promise<{ ready: boolean; reason?: string; config?: InferenceConfig }> {
  try {
    const config = validateInferenceConfig(state.get('inference'));
    const credential = await secrets.get(config.credentialRef);
    const proof = state.get<{ hash: string; testedAt: number }>('inferenceProof');
    if (!proof || proof.hash !== hashManifest(config) || Date.now() - proof.testedAt > 24 * 3600_000) return { ready: false, reason: 'RUN_INFERENCE_TEST', config };
    if (config.allowLocal) {
      const health = await checkLocalInference(config, credential);
      state.set('localInferenceHealth', { ...health, configHash: hashManifest(config) });
      if (!health.available || !health.modelAvailable) return { ready: false, reason: health.reason, config };
    }
    return { ready: true, config };
  } catch { return { ready: false, reason: 'CONFIGURE_DEDICATED_INFERENCE_AND_SECRET' }; }
}
