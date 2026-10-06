import type { InferenceErrorCode, InferenceTask, PlatformInferenceRequest } from './inference.js';

export type InferenceDebugEvent = {
  event: 'DEVELOPMENT_INFERENCE_DEBUG'; phase: 'REQUEST' | 'RESPONSE' | 'ERROR';
  requestId: string; task: InferenceTask; attempt: number;
  metadata: PlatformInferenceRequest['metadata'];
  contentRedacted: true; systemBytes?: number; messageCount?: number; messageBytes?: number;
  toolDefinitionCount?: number; structuredOutputRequested?: boolean;
  responseBytes?: number; toolCallCount?: number; code?: InferenceErrorCode;
};
export type InferenceDebugWarning = { event: 'DEVELOPMENT_INFERENCE_DEBUG_ENABLED'; warning: string };

export function createDevelopmentInferenceDebug(env: Record<string, string | undefined>,
  write: (event: InferenceDebugEvent | InferenceDebugWarning) => void): ((event: InferenceDebugEvent) => void) | undefined {
  const enabled = env.PLATFORM_INFERENCE_DEBUG?.trim() ?? '';
  if (!['', 'false', 'true'].includes(enabled)) throw new Error('PLATFORM_INFERENCE_DEBUG must be true or false');
  if (enabled !== 'true') return undefined;
  if (env.NODE_ENV === 'production' || env.KIVRO_ENV === 'production' || !['development', 'test'].includes(env.KIVRO_ENV ?? env.NODE_ENV ?? '')) {
    throw new Error('Platform inference debug is restricted to explicit development/test environments');
  }
  const emit = (event: InferenceDebugEvent | InferenceDebugWarning) => {
    // Diagnostics must never change provider accounting or retry behavior.
    try { write(event); } catch { /* Logging sink failure is not an inference failure. */ }
  };
  emit({ event: 'DEVELOPMENT_INFERENCE_DEBUG_ENABLED',
    warning: 'DEVELOPMENT ONLY: extra request metadata is logged. Prompt, response, schema, tool arguments and secrets are fully redacted. Do not enable on shared or production data.' });
  return emit;
}
