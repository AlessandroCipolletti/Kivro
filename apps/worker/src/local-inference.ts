import { z } from 'zod';
import type { LocalInferenceMetadata } from '@kivro/openclaw-adapter';
import { boundedRequest } from './http.ts';

const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./:@-]{0,199}$/).refine(value => !value.includes('..'));
const compatibleModels = z.object({ data: z.array(z.object({ id: modelId })).max(100) });
const ollamaModels = z.object({ models: z.array(z.object({ name: modelId })).max(100) });
const MAX_METADATA_BYTES = 64 * 1024, PROBE_TIMEOUT_MS = 2000;
const defaults: LocalInferenceMetadata[] = [
  { runtime: 'OLLAMA', provider: 'openai-compatible', endpoint: 'http://127.0.0.1:11434/v1', models: [], requiredService: 'Ollama server', hardwareRequirements: null },
  { runtime: 'LM_STUDIO', provider: 'openai-compatible', endpoint: 'http://127.0.0.1:1234/v1', models: [], requiredService: 'LM Studio local server', hardwareRequirements: null },
];
export type LocalInferenceHealth = { available: boolean; modelAvailable: boolean; checkedAt: number; latencyMs: number; reason?: 'LOCAL_INFERENCE_OFFLINE' | 'LOCAL_INFERENCE_MODEL_UNAVAILABLE' | 'LOCAL_INFERENCE_AUTH_REQUIRED' };
export type LocalInferenceDiscovery = LocalInferenceMetadata & { availability: 'AVAILABLE' | 'UNREACHABLE' | 'AUTH_REQUIRED' | 'MODEL_UNAVAILABLE'; checkedAt: number; latencyMs: number; minimalInferenceVerified: false };

function endpointUrl(endpoint: string): URL {
  const url = new URL(endpoint);
  if (!['127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9/_-]*$/.test(url.pathname)) throw new Error('UNSAFE_LOCAL_INFERENCE_ENDPOINT');
  return url;
}
function modelsUrl(endpoint: string): URL { return new URL(`${endpoint.replace(/\/$/, '')}/models`); }
async function listModels(url: URL, credential?: string, provider?: string, ollama = false) {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (credential) headers[provider === 'anthropic' ? 'x-api-key' : 'authorization'] = provider === 'anthropic' ? credential : `Bearer ${credential}`;
  const response = await boundedRequest(url, { headers, localApproved: true, maxBytes: MAX_METADATA_BYTES, timeoutMs: PROBE_TIMEOUT_MS });
  if ([401, 403].includes(response.status)) throw new Error('LOCAL_INFERENCE_AUTH_REQUIRED');
  if (response.status !== 200) throw new Error('LOCAL_INFERENCE_OFFLINE');
  const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
  return ollama ? ollamaModels.parse(raw).models.map(model => model.name) : compatibleModels.parse(raw).data.map(model => model.id);
}

/** Read-only known loopback metadata. Never discovers credentials or starts/loads models. */
export async function discoverLocalInference(configured: LocalInferenceMetadata[] = []): Promise<LocalInferenceDiscovery[]> {
  if (configured.length > 2) throw new Error('LOCAL_INFERENCE_DISCOVERY_LIMIT');
  const candidates = configured.length ? configured : defaults;
  return Promise.all(candidates.map(async candidate => {
    if (!['OLLAMA', 'LM_STUDIO'].includes(candidate.runtime)) throw new Error('UNSUPPORTED_LOCAL_INFERENCE_RUNTIME');
    const endpoint = endpointUrl(candidate.endpoint);
    if (!['/v1', '/v1/'].includes(endpoint.pathname)) throw new Error('UNSAFE_LOCAL_INFERENCE_ENDPOINT');
    const declared = z.array(modelId).max(100).parse(candidate.models);
    const checkedAt = Date.now(), start = performance.now();
    let availability: LocalInferenceDiscovery['availability'] = 'UNREACHABLE', models = [...declared];
    try {
      const observed = await listModels(candidate.runtime === 'OLLAMA' ? new URL('/api/tags', endpoint) : modelsUrl(endpoint.href), undefined, undefined, candidate.runtime === 'OLLAMA');
      availability = declared.length && !declared.some(model => observed.includes(model)) ? 'MODEL_UNAVAILABLE' : 'AVAILABLE';
      models = [...new Set(observed)].sort();
    } catch (error) { if (error instanceof Error && error.message === 'LOCAL_INFERENCE_AUTH_REQUIRED') availability = 'AUTH_REQUIRED'; }
    return { runtime: candidate.runtime, provider: 'openai-compatible' as const, requiredService: candidate.runtime === 'OLLAMA' ? 'Ollama server' : 'LM Studio local server', hardwareRequirements: null,
      endpoint: endpoint.href, models, availability, checkedAt, latencyMs: Math.round(performance.now() - start), minimalInferenceVerified: false as const };
  }));
}

/** Complements, never replaces, the approved minimal generation test. */
export async function checkLocalInference(config: { baseUrl: string; model: string; provider: string }, credential: string): Promise<LocalInferenceHealth> {
  const checkedAt = Date.now(), start = performance.now();
  let available = false, modelAvailable = false, reason: LocalInferenceHealth['reason'];
  try {
    const models = await listModels(modelsUrl(endpointUrl(config.baseUrl).href), credential, config.provider);
    available = true; modelAvailable = models.includes(config.model);
    if (!modelAvailable) reason = 'LOCAL_INFERENCE_MODEL_UNAVAILABLE';
  } catch (error) { reason = error instanceof Error && error.message === 'LOCAL_INFERENCE_AUTH_REQUIRED' ? 'LOCAL_INFERENCE_AUTH_REQUIRED' : 'LOCAL_INFERENCE_OFFLINE'; }
  return { available, modelAvailable, checkedAt, latencyMs: Math.round(performance.now() - start), ...(reason ? { reason } : {}) };
}
