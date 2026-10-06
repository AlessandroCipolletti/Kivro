import { z } from 'zod';
import type { InferenceRequest } from './inference-protocol.ts';

type Text = { type: 'text'; text: string };
type Block = Text | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } | { type: 'tool_result'; tool_use_id: string; content: Text[] };
const namePattern = /^[A-Za-z0-9_-]{1,64}$/;
const idPattern = /^[A-Za-z0-9_-]{1,200}$/;
function textBlocks(content: InferenceRequest['messages'][number]['content']): Text[] {
  return (typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content ?? []).filter(block => block.text.length > 0);
}
function invalid(): never { throw new Error('ANTHROPIC_TOOL_HISTORY_INVALID'); }

/** Only reviewed client tools cross this bridge. No server tools, prompt cache,
 * images or opaque thinking signatures are silently discarded or enabled. */
export function anthropicRequest(body: InferenceRequest, maxTokens: number) {
  const system: Text[] = [], messages: { role: 'user' | 'assistant'; content: Block[] }[] = [];
  const toolNames = new Set(body.tools?.map(tool => tool.function.name));
  if (toolNames.size !== (body.tools?.length ?? 0) || [...toolNames].some(name => !namePattern.test(name))) throw new Error('ANTHROPIC_TOOL_DEFINITION_INVALID');
  if (body.temperature !== undefined && body.temperature !== 1 || body.top_p !== undefined && body.top_p !== 1) throw new Error('ANTHROPIC_SAMPLING_UNSUPPORTED');
  const seen = new Set<string>(), pending = new Set<string>();
  for (const message of body.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      if (messages.length || message.tool_calls?.length || message.tool_call_id || message.name) invalid();
      system.push(...textBlocks(message.content)); continue;
    }
    if (message.role === 'tool') {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id) || message.tool_calls?.length) invalid();
      const block: Block = { type: 'tool_result', tool_use_id: message.tool_call_id, content: textBlocks(message.content) };
      const previous = messages.at(-1);
      if (previous?.role === 'user' && previous.content.every(block => block.type === 'tool_result')) previous.content.push(block);
      else messages.push({ role: 'user', content: [block] });
      continue;
    }
    if (pending.size || message.tool_call_id || message.name) invalid();
    const content: Block[] = textBlocks(message.content);
    if (message.tool_calls?.length) {
      if (message.role !== 'assistant') invalid();
      for (const call of message.tool_calls) {
        if (!idPattern.test(call.id) || seen.has(call.id) || !toolNames.has(call.function.name)) invalid();
        let input: unknown; try { input = JSON.parse(call.function.arguments); } catch { invalid(); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
        seen.add(call.id); pending.add(call.id);
        content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: input as Record<string, unknown> });
      }
    }
    if (!content.length) throw new Error('ANTHROPIC_EMPTY_MESSAGE');
    messages.push({ role: message.role, content });
  }
  if (pending.size || !messages.length || messages[0]!.role !== 'user' || messages.at(-1)!.role !== 'user') invalid();
  if (!toolNames.size && body.tool_choice === 'required') throw new Error('ANTHROPIC_TOOL_DEFINITION_INVALID');
  const tools = body.tools?.map(tool => ({ name: tool.function.name, ...(tool.function.description ? { description: tool.function.description } : {}), input_schema: tool.function.parameters }));
  return { model: body.model, ...(system.length ? { system } : {}), messages, max_tokens: maxTokens, stream: false, thinking: { type: 'disabled' }, service_tier: 'standard_only',
    ...(tools?.length ? { tools, tool_choice: body.tool_choice === 'none' ? { type: 'none' } : { type: body.tool_choice === 'required' ? 'any' : 'auto', disable_parallel_tool_use: true } } : {}),
  };
}

const Tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ResponseSchema = z.object({ id: z.string().regex(idPattern), type: z.literal('message'), role: z.literal('assistant'), model: z.string().min(1).max(200),
  content: z.array(z.discriminatedUnion('type', [z.object({ type: z.literal('text'), text: z.string(), citations: z.array(z.unknown()).max(0).nullish() }).strict(), z.object({ type: z.literal('tool_use'), id: z.string().regex(idPattern), name: z.string().regex(namePattern), input: z.record(z.unknown()) }).strict()])).max(100),
  stop_reason: z.string(), usage: z.object({ input_tokens: Tokens, output_tokens: Tokens, cache_creation_input_tokens: Tokens.nullish(), cache_read_input_tokens: Tokens.nullish(), server_tool_use: z.record(Tokens).nullish() }),
});
export function anthropicResponse(raw: unknown, request: InferenceRequest) {
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error('ANTHROPIC_RESPONSE_UNSUPPORTED');
  const result = parsed.data;
  if (Object.values(result.usage.server_tool_use ?? {}).some(count => count > 0)) throw new Error('ANTHROPIC_SERVER_TOOL_DENIED');
  if (['max_tokens', 'model_context_window_exceeded'].includes(result.stop_reason)) throw new Error('INFERENCE_OUTPUT_LIMIT');
  if (result.stop_reason === 'refusal') throw new Error('INFERENCE_REFUSED');
  if (!['end_turn', 'tool_use'].includes(result.stop_reason)) throw new Error('ANTHROPIC_RESPONSE_UNSUPPORTED');
  const calls = result.content.filter(block => block.type === 'tool_use'), texts = result.content.filter(block => block.type === 'text');
  const names = new Set(request.tools?.map(tool => tool.function.name));
  const previousIds = new Set(request.messages.flatMap(message => message.tool_calls?.map(call => call.id) ?? []));
  if ((result.stop_reason === 'tool_use') !== !!calls.length || new Set(calls.map(call => call.id)).size !== calls.length || calls.some(call => !names.has(call.name) || previousIds.has(call.id)) || calls.length && request.tool_choice === 'none' || !calls.length && request.tool_choice === 'required') throw new Error('ANTHROPIC_TOOL_RESPONSE_INVALID');
  if (!calls.length && !texts.some(block => block.text.trim())) throw new Error('ANTHROPIC_EMPTY_RESPONSE');
  const prompt = result.usage.input_tokens + (result.usage.cache_creation_input_tokens ?? 0) + (result.usage.cache_read_input_tokens ?? 0), completion = result.usage.output_tokens;
  if (!Number.isSafeInteger(prompt + completion)) throw new Error('PROVIDER_TOKEN_BOUND_VIOLATION');
  return { id: result.id, object: 'chat.completion', model: request.model, choices: [{ index: 0, message: { role: 'assistant', content: texts.length ? texts.map(block => block.text).join('\n') : null,
    ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : {}),
  }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } };
}
