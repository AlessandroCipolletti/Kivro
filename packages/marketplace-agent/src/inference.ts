import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { z } from 'zod';
import { NetworkPolicyError, SafeHttpClient, type HttpTransport } from '@kivro/research-broker';
import type { InferenceDebugEvent } from './inference-debug.js';
export { createDevelopmentInferenceDebug } from './inference-debug.js';

export type InferenceTask = 'INTENT_EXTRACTION' | 'DISCOVERY_RERANK' | 'RECOMMENDATION' | 'ORCHESTRATION_PLANNING' | 'RESULT_SYNTHESIS';
export type InferenceErrorCode = 'AUTHENTICATION_ERROR' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'TIMEOUT' |
  'INVALID_REQUEST' | 'MODEL_UNAVAILABLE' | 'CONTENT_POLICY' | 'CONTEXT_LIMIT' | 'UNKNOWN_PROVIDER_ERROR' |
  'INVALID_RESPONSE' | 'INVALID_TOOL_CALL' | 'INFERENCE_BUDGET_EXCEEDED';
export class InferenceError extends Error {
  constructor(public readonly code: InferenceErrorCode, public readonly retryAfterMs?: number) { super(code); this.name = 'InferenceError'; }
}
export type JsonSchema = Record<string, unknown>;
export interface PlatformToolDefinition { name: string; description: string; parameters: JsonSchema }
export interface PlatformToolCall { id: string; name: string; arguments: unknown }
export type PlatformMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: PlatformToolCall[] }
  | { role: 'tool'; callId: string; content: string; isError?: boolean };
export interface PlatformInferenceRequest {
  task: InferenceTask; system: string; messages: PlatformMessage[]; tools?: PlatformToolDefinition[];
  responseSchema?: JsonSchema; maxOutputTokens?: number;
  metadata: { userId: string; conversationId?: string; orchestrationId?: string };
}
export interface InferenceUsage { inputTokens: number; outputTokens: number; cachedInputTokens: number }
export interface PlatformInferenceResponse {
  provider: string; model: string; text: string; structuredOutput?: unknown;
  toolCalls: PlatformToolCall[]; usage: InferenceUsage; latencyMs: number;
}
export interface PlatformInferenceProvider {
  readonly id: string;
  generate(request: PlatformInferenceRequest & { model: string; maxOutputTokens: number; timeoutMs: number }): Promise<PlatformInferenceResponse>;
  healthCheck(): Promise<{ configured: boolean; healthy: boolean; code?: InferenceErrorCode }>;
}
export const InferenceProfileSchema = z.object({
  provider: z.enum(['openai', 'anthropic']), model: z.string().trim().min(1).max(200),
  maxInputTokens: z.number().int().min(8192).max(200_000).default(32000),
  maxOutputTokens: z.number().int().min(1).max(16384).default(2048),
  timeoutMs: z.number().int().min(100).max(30000).default(30000),
  maxAttempts: z.number().int().min(1).max(4).default(2),
  inputMicroUsdPerMillionTokens: z.number().int().positive().max(1_000_000_000),
  outputMicroUsdPerMillionTokens: z.number().int().positive().max(1_000_000_000),
  structuredOutput: z.literal(true), toolCalling: z.boolean().default(true),
}).strict();
export type InferenceProfile = z.infer<typeof InferenceProfileSchema>;
export interface InferenceAccounting {
  /** Atomic per-user/conversation/day spend and rate reservation. Deny by throwing. */
  reserve(request: { requestId: string; task: InferenceTask; provider: string; model: string;
    metadata: PlatformInferenceRequest['metadata']; maxCostMicroUsd: number }): Promise<string>;
  /** Idempotent settlement. On uncertain failures the full reservation is charged. */
  finish(id: string, record: { costMicroUsd: number; usage?: InferenceUsage; latencyMs: number;
    outcome: 'SUCCEEDED' | 'FAILED'; code?: InferenceErrorCode; provider?: string; model?: string; toolCallCount?: number }): Promise<void>;
}

const usageSchema = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), cachedInputTokens: z.number().int().nonnegative() });
const retryable = (code: InferenceErrorCode) => ['RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'TIMEOUT'].includes(code);
const ajv = new Ajv({ strict: true, allErrors: false, ownProperties: true });
function compileSchema(schema: JsonSchema) {
  let nodes = 0;
  function inspect(value: unknown, depth: number): void {
    if (++nodes > 2000 || depth > 20) throw new InferenceError('INVALID_REQUEST');
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    for (const key of ['$ref', '$dynamicRef', '$recursiveRef', 'pattern', 'patternProperties', 'propertyNames', 'format', 'if', 'then', 'else', 'not', 'dependencies', 'dependentSchemas']) {
      if (Object.hasOwn(object, key)) throw new InferenceError('INVALID_REQUEST');
    }
    // Schema property names are data, so inspect each property's schema, not the name map.
    for (const [key, child] of Object.entries(object)) {
      if (key === 'properties' || key === '$defs' || key === 'definitions') {
        if (!child || typeof child !== 'object') throw new InferenceError('INVALID_REQUEST');
        for (const property of Object.values(child)) inspect(property, depth + 1);
      } else if (Array.isArray(child) && ['anyOf', 'allOf', 'oneOf', 'prefixItems'].includes(key)) {
        if (child.length > 8) throw new InferenceError('INVALID_REQUEST');
        for (const entry of child) inspect(entry, depth + 1);
      } else if (['items', 'additionalItems', 'additionalProperties', 'contains'].includes(key)) {
        if (Array.isArray(child)) for (const item of child) inspect(item, depth + 1);
        else inspect(child, depth + 1);
      }
    }
  }
  if (JSON.stringify(schema).length > 30000) throw new InferenceError('INVALID_REQUEST');
  inspect(schema, 0);
  try { return ajv.compile(schema); } catch { throw new InferenceError('INVALID_REQUEST'); }
}
export function validateStructuredOutput(schema: JsonSchema, value: unknown): void {
  const validate = compileSchema(schema);
  if (!validate(value)) throw new InferenceError('INVALID_RESPONSE');
}
/** Provider grammar subsets cannot enforce every bound. Preserve original schemas for local validation. */
function wireSchema(schema: JsonSchema, provider: 'openai' | 'anthropic'): JsonSchema {
  compileSchema(schema);
  const unsupported = new Set(['minLength', 'maxLength', 'uniqueItems', ...(provider === 'anthropic' ?
    ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'maxItems'] : [])]);
  function visit(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const result: JsonSchema = {}; const limits: JsonSchema = {};
    for (const [key, child] of Object.entries(value)) {
      if (unsupported.has(key) || (provider === 'anthropic' && key === 'minItems' && Number(child) > 1)) { limits[key] = child; continue; }
      if (['properties', '$defs', 'definitions'].includes(key)) {
        result[key] = Object.fromEntries(Object.entries(child as JsonSchema).map(([name, property]) => [name, visit(property)]));
      } else if (['anyOf', 'allOf', 'oneOf', 'prefixItems'].includes(key) && Array.isArray(child)) result[key] = child.map(visit);
      else if (['items', 'additionalProperties', 'additionalItems', 'contains'].includes(key)) result[key] = Array.isArray(child) ? child.map(visit) : visit(child);
      else result[key] = child;
    }
    if (Object.keys(limits).length) result.description = `${typeof result.description === 'string' ? result.description + ' ' : ''}Required limits: ${JSON.stringify(limits)}.`;
    return result;
  }
  return visit(schema) as JsonSchema;
}
function normalizeError(error: unknown): InferenceError {
  if (error instanceof InferenceError) return error;
  if (error instanceof NetworkPolicyError) return new InferenceError(error.code === 'NETWORK_TIMEOUT' ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE');
  return new InferenceError('UNKNOWN_PROVIDER_ERROR');
}
function statusError(status: number, headers: Record<string, string>, body: unknown): InferenceError {
  const error = z.object({ error: z.object({ code: z.string().optional(), type: z.string().optional() }).passthrough() }).safeParse(body);
  const code = error.success ? error.data.error.code ?? error.data.error.type : '';
  if (code === 'context_length_exceeded') return new InferenceError('CONTEXT_LIMIT');
  if (code === 'model_not_found') return new InferenceError('MODEL_UNAVAILABLE');
  if (['content_policy_violation', 'refusal'].includes(code ?? '')) return new InferenceError('CONTENT_POLICY');
  if (status === 401 || status === 403) return new InferenceError('AUTHENTICATION_ERROR');
  if (status === 404) return new InferenceError('MODEL_UNAVAILABLE');
  if (status === 408) return new InferenceError('TIMEOUT');
  if (status === 429) {
    const hint = headers['retry-after'];
    const seconds = Number(hint);
    const delay = hint ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(hint) - Date.now()) : 1000;
    return new InferenceError('RATE_LIMITED', Math.min(30_000, Math.max(0, Number.isFinite(delay) ? delay : 1000)));
  }
  if (status >= 500) return new InferenceError('PROVIDER_UNAVAILABLE');
  return new InferenceError('INVALID_REQUEST');
}

abstract class HttpProvider implements PlatformInferenceProvider {
  abstract readonly id: string;
  abstract readonly host: string;
  protected readonly http: HttpTransport;
  readonly #apiKey: string;
  protected get apiKey(): string { return this.#apiKey; }
  constructor(apiKey: string, http?: HttpTransport) {
    if (!apiKey.trim()) throw new InferenceError('PROVIDER_UNAVAILABLE');
    this.#apiKey = apiKey;
    this.http = http ?? new SafeHttpClient();
  }
  toJSON(): { id: string; configured: true } { return { id: this.id, configured: true }; }
  protected abstract headers(): Record<string, string>;
  abstract generate(request: PlatformInferenceRequest & { model: string; maxOutputTokens: number; timeoutMs: number }): Promise<PlatformInferenceResponse>;
  async healthCheck(): Promise<{ configured: boolean; healthy: boolean; code?: InferenceErrorCode }> {
    try {
      await this.call('/v1/models', undefined, 5000);
      return { configured: true, healthy: true };
    } catch (error) { return { configured: true, healthy: false, code: normalizeError(error).code }; }
  }
  protected async call(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    let response;
    try {
      response = await this.http.request({ url: `https://${this.host}${path}`, method: body === undefined ? 'GET' : 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json', accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), httpsOnly: true, allowedDomains: [this.host],
        maxRedirects: 0, timeoutMs, maxBytes: 2_000_000, allowedContentTypes: ['application/json'] });
    } catch (error) { throw normalizeError(error); }
    let parsed: unknown;
    try { parsed = JSON.parse(response.body.toString('utf8')); } catch { throw new InferenceError(response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'INVALID_RESPONSE'); }
    if (response.status < 200 || response.status >= 300) throw statusError(response.status, response.headers, parsed);
    return parsed;
  }
}

export class OpenAIPlatformProvider extends HttpProvider {
  readonly id = 'openai'; readonly host = 'api.openai.com';
  protected headers(): Record<string, string> { return { authorization: `Bearer ${this.apiKey}` }; }
  async generate(request: PlatformInferenceRequest & { model: string; maxOutputTokens: number; timeoutMs: number }): Promise<PlatformInferenceResponse> {
    const started = Date.now();
    const input = request.messages.flatMap((message): Record<string, unknown>[] => {
      if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.callId, output: message.content }];
      return [{ role: message.role, content: message.content }, ...(message.role === 'assistant' ?
        (message.toolCalls ?? []).map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) })) : [])];
    });
    const raw = await this.call('/v1/responses', {
      model: request.model, instructions: request.system, input, store: false, max_output_tokens: request.maxOutputTokens,
      ...(request.tools?.length ? { tools: request.tools.map(tool => ({ type: 'function', name: tool.name,
        description: tool.description, parameters: wireSchema(tool.parameters, 'openai'), strict: true })), parallel_tool_calls: false } : {}),
      ...(request.responseSchema ? { text: { format: { type: 'json_schema', name: 'marketplace_response', strict: true, schema: wireSchema(request.responseSchema, 'openai') } } } : {}),
    }, request.timeoutMs);
    const response = z.object({ status: z.string(), model: z.string(), output: z.array(z.record(z.unknown())),
      usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
        input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative() }).optional() }) }).safeParse(raw);
    if (!response.success) throw new InferenceError('INVALID_RESPONSE');
    if (response.data.status !== 'completed') throw new InferenceError('INVALID_RESPONSE');
    const toolCalls: PlatformToolCall[] = []; const texts: string[] = [];
    for (const item of response.data.output) {
      if (item.type === 'function_call') {
        const call = z.object({ call_id: z.string().min(1), name: z.string().min(1), arguments: z.string() }).safeParse(item);
        if (!call.success) throw new InferenceError('INVALID_TOOL_CALL');
        let args: unknown;
        try { args = JSON.parse(call.data.arguments); } catch { throw new InferenceError('INVALID_TOOL_CALL'); }
        toolCalls.push({ id: call.data.call_id, name: call.data.name, arguments: args });
      } else if (item.type === 'message') {
        const content = z.array(z.record(z.unknown())).safeParse(item.content);
        if (!content.success) throw new InferenceError('INVALID_RESPONSE');
        for (const block of content.data) {
          if (block.type === 'refusal') throw new InferenceError('CONTENT_POLICY');
          if (block.type === 'output_text' && typeof block.text === 'string') texts.push(block.text);
        }
      }
      // Provider reasoning blocks are deliberately neither returned nor persisted.
    }
    return { provider: this.id, model: response.data.model, text: texts.join('\n'), toolCalls,
      usage: { inputTokens: response.data.usage.input_tokens, outputTokens: response.data.usage.output_tokens,
        cachedInputTokens: response.data.usage.input_tokens_details?.cached_tokens ?? 0 }, latencyMs: Date.now() - started };
  }
}

export class AnthropicPlatformProvider extends HttpProvider {
  readonly id = 'anthropic'; readonly host = 'api.anthropic.com';
  protected headers(): Record<string, string> { return { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }; }
  async generate(request: PlatformInferenceRequest & { model: string; maxOutputTokens: number; timeoutMs: number }): Promise<PlatformInferenceResponse> {
    const started = Date.now();
    const messages = request.messages.map(message => message.role === 'tool' ?
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.callId, content: message.content, is_error: message.isError ?? false }] } :
      { role: message.role, content: [ ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...(message.role === 'assistant' ? (message.toolCalls ?? []).map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })) : []) ] });
    const raw = await this.call('/v1/messages', {
      model: request.model, system: request.system, messages, max_tokens: request.maxOutputTokens,
      ...(request.tools?.length ? { tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: wireSchema(tool.parameters, 'anthropic'), strict: true })) } : {}),
      ...(request.responseSchema ? { output_config: { format: { type: 'json_schema', schema: wireSchema(request.responseSchema, 'anthropic') } } } : {}),
    }, request.timeoutMs);
    const response = z.object({ model: z.string(), stop_reason: z.string(), content: z.array(z.record(z.unknown())),
      usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
        cache_read_input_tokens: z.number().int().nonnegative().optional(), cache_creation_input_tokens: z.number().int().nonnegative().optional() }) }).safeParse(raw);
    if (!response.success) throw new InferenceError('INVALID_RESPONSE');
    if (response.data.stop_reason === 'refusal') throw new InferenceError('CONTENT_POLICY');
    if (!['end_turn', 'tool_use', 'stop_sequence'].includes(response.data.stop_reason)) throw new InferenceError('INVALID_RESPONSE');
    const texts: string[] = []; const toolCalls: PlatformToolCall[] = [];
    for (const block of response.data.content) {
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      if (block.type === 'tool_use') {
        const call = z.object({ id: z.string().min(1), name: z.string().min(1), input: z.unknown() }).safeParse(block);
        if (!call.success) throw new InferenceError('INVALID_TOOL_CALL');
        toolCalls.push({ id: call.data.id, name: call.data.name, arguments: call.data.input });
      }
    }
    const usage = response.data.usage;
    return { provider: this.id, model: response.data.model, text: texts.join('\n'), toolCalls,
      usage: { inputTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        outputTokens: usage.output_tokens, cachedInputTokens: usage.cache_read_input_tokens ?? 0 }, latencyMs: Date.now() - started };
  }
}

function cost(profile: InferenceProfile, input: number, output: number): number {
  // Charge cached tokens at the full input rate; this intentionally overestimates.
  return Math.ceil((input * profile.inputMicroUsdPerMillionTokens + output * profile.outputMicroUsdPerMillionTokens) / 1_000_000);
}
export interface InferenceRouterOptions {
  providers: PlatformInferenceProvider[];
  profiles: Partial<Record<InferenceTask, InferenceProfile>>;
  fallbacks?: Partial<Record<InferenceTask, InferenceProfile>>;
  accounting: InferenceAccounting;
  sleep?: (ms: number) => Promise<void>;
  debug?: (event: InferenceDebugEvent) => void;
}
export class PlatformInferenceRouter {
  private readonly providers: Map<string, PlatformInferenceProvider>;
  private readonly profiles: InferenceRouterOptions['profiles'];
  private readonly fallbacks: InferenceRouterOptions['fallbacks'];
  constructor(private readonly options: InferenceRouterOptions) {
    this.providers = new Map(options.providers.map(provider => [provider.id, provider]));
    this.profiles = Object.fromEntries(Object.entries(options.profiles).map(([task, profile]) => [task, InferenceProfileSchema.parse(profile)]));
    this.fallbacks = Object.fromEntries(Object.entries(options.fallbacks ?? {}).map(([task, profile]) => [task, InferenceProfileSchema.parse(profile)]));
  }
  isAvailable(task: InferenceTask): boolean {
    const profile = this.profiles[task]; return !!profile && this.providers.has(profile.provider);
  }
  /** Public processing disclosure only; never includes credentials, rates or request data. */
  processingDestinations(task: InferenceTask): { provider: string; model: string }[] {
    if (!this.isAvailable(task)) return [];
    const primary = this.profiles[task]!; const fallback = this.fallbacks?.[task];
    const profiles = [primary, ...(fallback && this.providers.has(fallback.provider) ? [fallback] : [])];
    return profiles.map(({ provider, model }) => ({ provider, model }))
      .filter((item, index, items) => items.findIndex(other => other.provider === item.provider && other.model === item.model) === index);
  }
  async health(): Promise<{ status: 'READY' | 'DEGRADED' | 'UNAVAILABLE'; providers: Record<string, { configured: boolean; healthy: boolean; code?: InferenceErrorCode }> }> {
    const results = Object.fromEntries(await Promise.all([...this.providers].map(async ([id, provider]) => [id, await provider.healthCheck()])));
    const configured = Object.values(this.profiles);
    const healthy = configured.filter(profile => results[profile.provider]?.healthy).length;
    return { status: !healthy ? 'UNAVAILABLE' : healthy === configured.length ? 'READY' : 'DEGRADED', providers: results };
  }
  async generate(request: PlatformInferenceRequest): Promise<PlatformInferenceResponse> {
    const primary = this.profiles[request.task];
    if (!primary || !this.providers.has(primary.provider)) throw new InferenceError('PROVIDER_UNAVAILABLE');
    if (!request.metadata.userId || request.messages.length > 40 || (request.tools?.length ?? 0) > 16) throw new InferenceError('INVALID_REQUEST');
    if (!z.object({ userId: z.string().uuid(), conversationId: z.string().uuid().optional(), orchestrationId: z.string().uuid().optional() }).strict().safeParse(request.metadata).success) {
      throw new InferenceError('INVALID_REQUEST');
    }
    const schemaBytes = Buffer.byteLength(JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools, schema: request.responseSchema }));
    const toolNames = new Set<string>();
    for (const tool of request.tools ?? []) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tool.name) || toolNames.has(tool.name)) throw new InferenceError('INVALID_REQUEST');
      toolNames.add(tool.name);
      compileSchema(tool.parameters);
    }
    if (request.responseSchema) compileSchema(request.responseSchema);
    let profile = primary; let schemaRetries = 0; let last: InferenceError | undefined;
    for (let attempt = 0; attempt < primary.maxAttempts; attempt++) {
      if (schemaBytes + 4096 > profile.maxInputTokens || schemaBytes > 180_000) throw new InferenceError('CONTEXT_LIMIT');
      if (request.tools?.length && !profile.toolCalling) throw new InferenceError('INVALID_REQUEST');
      const maxOutputTokens = request.maxOutputTokens ?? profile.maxOutputTokens;
      if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > profile.maxOutputTokens) throw new InferenceError('INVALID_REQUEST');
      const provider = this.providers.get(profile.provider);
      if (!provider) throw new InferenceError('PROVIDER_UNAVAILABLE');
      const maxCost = cost(profile, profile.maxInputTokens, maxOutputTokens);
      const requestId = randomUUID();
      const reservation = await this.options.accounting.reserve({ requestId, task: request.task,
        metadata: request.metadata, provider: profile.provider, model: profile.model, maxCostMicroUsd: maxCost });
      const debug = (detail: Omit<InferenceDebugEvent, 'event' | 'requestId' | 'task' | 'attempt' | 'metadata' | 'contentRedacted'>) => {
        try { this.options.debug?.({ event: 'DEVELOPMENT_INFERENCE_DEBUG', requestId, task: request.task, attempt: attempt + 1,
          metadata: { ...request.metadata }, contentRedacted: true, ...detail }); } catch { /* Observability cannot change accounting. */ }
      };
      debug({ phase: 'REQUEST', systemBytes: Buffer.byteLength(request.system), messageCount: request.messages.length,
        messageBytes: request.messages.reduce((total, message) => total + Buffer.byteLength(message.content), 0),
        toolDefinitionCount: request.tools?.length ?? 0, structuredOutputRequested: request.responseSchema !== undefined });
      const started = Date.now(); let response: PlatformInferenceResponse;
      try {
        response = await provider.generate({ ...request, model: profile.model, maxOutputTokens, timeoutMs: profile.timeoutMs });
        if (response.provider !== profile.provider || !response.model) throw new InferenceError('INVALID_RESPONSE');
        usageSchema.parse(response.usage);
        if (response.usage.inputTokens > profile.maxInputTokens || response.usage.outputTokens > maxOutputTokens ||
          response.usage.cachedInputTokens > response.usage.inputTokens) throw new InferenceError('INFERENCE_BUDGET_EXCEEDED');
        const ids = new Set<string>();
        if (response.toolCalls.length > 16) throw new InferenceError('INVALID_TOOL_CALL');
        for (const call of response.toolCalls) {
          const tool = request.tools?.find(definition => definition.name === call.name);
          if (!tool || !call.id || ids.has(call.id)) throw new InferenceError('INVALID_TOOL_CALL');
          ids.add(call.id);
          try { validateStructuredOutput(tool.parameters, call.arguments); } catch { throw new InferenceError('INVALID_TOOL_CALL'); }
        }
        if (request.responseSchema && !response.toolCalls.length) {
          try { response.structuredOutput = JSON.parse(response.text); } catch { throw new InferenceError('INVALID_RESPONSE'); }
          validateStructuredOutput(request.responseSchema, response.structuredOutput);
        }
      } catch (error) {
        last = error instanceof z.ZodError ? new InferenceError('INVALID_RESPONSE') : normalizeError(error);
        debug({ phase: 'ERROR', code: last.code });
        await this.options.accounting.finish(reservation, { costMicroUsd: maxCost, latencyMs: Date.now() - started, outcome: 'FAILED', code: last.code });
        if (last.code === 'INVALID_RESPONSE' && schemaRetries++ < 1 && attempt + 1 < primary.maxAttempts) continue;
        if (!retryable(last.code) || attempt + 1 >= primary.maxAttempts) throw last;
        const fallback = this.fallbacks?.[request.task];
        if (fallback && this.providers.has(fallback.provider)) profile = fallback;
        await (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(last.retryAfterMs ?? Math.min(4000, 250 * 2 ** attempt));
        continue;
      }
      debug({ phase: 'RESPONSE', responseBytes: Buffer.byteLength(response.text), toolCallCount: response.toolCalls.length });
      await this.options.accounting.finish(reservation, { costMicroUsd: cost(profile, response.usage.inputTokens, response.usage.outputTokens),
        usage: response.usage, latencyMs: response.latencyMs, outcome: 'SUCCEEDED', provider: response.provider, model: response.model, toolCallCount: response.toolCalls.length });
      return response;
    }
    throw last ?? new InferenceError('PROVIDER_UNAVAILABLE');
  }
}

// Pinned, budgeted defaults; custom models require explicit rates. See docs/INFERENCE-PROVIDERS.md.
export const DEFAULT_INFERENCE_PROFILES = {
  openai: { model: 'gpt-4.1-mini-2025-04-14', input: 400_000, output: 1_600_000 },
  anthropic: { model: 'claude-haiku-4-5-20251001', input: 1_000_000, output: 5_000_000 },
} as const;

export function createInferenceConfiguration(env: Record<string, string | undefined>, profiles?: InferenceRouterOptions['profiles']):
  { providers: PlatformInferenceProvider[]; profiles: InferenceRouterOptions['profiles'] } {
  const providers: PlatformInferenceProvider[] = [];
  const openaiKey = env.PLATFORM_OPENAI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  const anthropicKey = env.PLATFORM_ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim();
  if (openaiKey) providers.push(new OpenAIPlatformProvider(openaiKey));
  if (anthropicKey) providers.push(new AnthropicPlatformProvider(anthropicKey));
  if (profiles) return { providers, profiles };
  const requested = env.PLATFORM_INFERENCE_PROVIDER?.trim();
  if (requested && !['openai', 'anthropic'].includes(requested)) throw new Error('PLATFORM_INFERENCE_PROVIDER must be openai or anthropic');
  if (!requested && providers.length > 1) throw new Error('Both provider keys are configured: set PLATFORM_INFERENCE_PROVIDER to openai or anthropic');
  if (!providers.length) return { providers, profiles: {} };
  const provider = (requested || providers[0]!.id) as 'openai' | 'anthropic';
  if (!providers.some(item => item.id === provider)) throw new Error('The selected PLATFORM_INFERENCE_PROVIDER has no API key');
  const defaults = DEFAULT_INFERENCE_PROFILES[provider];
  const model = env.PLATFORM_INFERENCE_MODEL?.trim() || defaults.model;
  const inputRate = env.PLATFORM_INFERENCE_INPUT_MICRO_USD_PER_MILLION?.trim();
  const outputRate = env.PLATFORM_INFERENCE_OUTPUT_MICRO_USD_PER_MILLION?.trim();
  if (model !== defaults.model && (!inputRate || !outputRate)) throw new Error('Custom PLATFORM_INFERENCE_MODEL requires explicit input/output micro-USD-per-million rates');
  if (Boolean(inputRate) !== Boolean(outputRate)) throw new Error('Configure both platform inference input and output rates');
  const profile = InferenceProfileSchema.parse({ provider, model,
    inputMicroUsdPerMillionTokens: inputRate ? Number(inputRate) : defaults.input,
    outputMicroUsdPerMillionTokens: outputRate ? Number(outputRate) : defaults.output, structuredOutput: true });
  return { providers, profiles: Object.fromEntries(['INTENT_EXTRACTION', 'DISCOVERY_RERANK', 'RECOMMENDATION', 'ORCHESTRATION_PLANNING', 'RESULT_SYNTHESIS'].map(task => [task, profile])) };
}

export interface AuthorizedTool {
  definition: PlatformToolDefinition;
  authorize(userId: string, args: unknown): Promise<void>;
  execute(args: unknown): Promise<unknown>;
}
export async function executeToolCalls(calls: PlatformToolCall[], tools: AuthorizedTool[], userId: string): Promise<PlatformMessage[]> {
  if (!userId || calls.length > 16 || new Set(calls.map(call => call.id)).size !== calls.length) throw new InferenceError('INVALID_TOOL_CALL');
  // Validate and authorize the entire batch before invoking any tool.
  for (const call of calls) {
    const tool = tools.find(item => item.definition.name === call.name);
    if (!tool || !call.id) throw new InferenceError('INVALID_TOOL_CALL');
    try { validateStructuredOutput(tool.definition.parameters, call.arguments); } catch { throw new InferenceError('INVALID_TOOL_CALL'); }
    await tool.authorize(userId, call.arguments);
  }
  const result: PlatformMessage[] = [];
  for (const call of calls) {
    const tool = tools.find(item => item.definition.name === call.name)!;
    const content = JSON.stringify(await tool.execute(call.arguments));
    if (!content || Buffer.byteLength(content) > 32000) throw new InferenceError('CONTEXT_LIMIT');
    result.push({ role: 'tool', callId: call.id, content });
  }
  return result;
}
