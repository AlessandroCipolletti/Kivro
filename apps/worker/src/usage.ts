import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WorkerUsageReceiptSchema, type WorkerUsageReceipt } from '@kivro/contracts';
import type { WorkerState } from './state.ts';

const PricingSchema = z.object({ provider: z.enum(['openai-compatible', 'anthropic']), model: WorkerUsageReceiptSchema.innerType().shape.model,
  inputUsdPerMillionTokens: z.number().nonnegative().max(1000), outputUsdPerMillionTokens: z.number().nonnegative().max(1000) }).strict();
export type UsagePricing = z.infer<typeof PricingSchema>;
const CallSchema = z.object({ id: z.string().uuid(), reservedTokens: z.number().int().min(1).max(200000), reservedCostMicroUsd: z.number().int().nonnegative().max(100000000),
  reported: z.object({ inputTokens: z.number().int().nonnegative().max(10000000), outputTokens: z.number().int().nonnegative().max(200000), estimatedCostMicroUsd: z.number().int().nonnegative().max(100000000) }).strict().optional() }).strict();
const LedgerSchema = z.object({ schemaVersion: z.literal(1), pricing: PricingSchema, entries: z.array(CallSchema).max(32) }).strict();
type Ledger = z.infer<typeof LedgerSchema>;
const key = (attemptId: string) => `inferenceUsage:${z.string().uuid().parse(attemptId)}`;

function decimal(value: number): { coefficient: bigint; scale: number } {
  if (!Number.isFinite(value) || value < 0) throw new Error('INVALID_COST');
  const [mantissa, exponent = '0'] = value.toString().split('e'), [whole, fraction = ''] = mantissa!.split('.');
  const scale = fraction.length - Number(exponent), coefficient = BigInt(`${whole}${fraction}`);
  return scale < 0 ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 } : { coefficient, scale };
}
function rounded(numerator: bigint, denominator: bigint, up: boolean): number {
  const value = Number((numerator + (up ? denominator - 1n : 0n)) / denominator);
  if (!Number.isSafeInteger(value)) throw new Error('INVALID_COST'); return value;
}
/** A rate in USD/million tokens is numerically microUSD/token. Round once,
 * upward, without binary floating-point undercounting monetary reservations. */
export function tokenCostMicroUsd(inputTokens: number, outputTokens: number, pricing: UsagePricing, inputMultiplier = 1): number {
  if (![inputTokens, outputTokens, inputMultiplier].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('INVALID_COST');
  const input = decimal(pricing.inputUsdPerMillionTokens), output = decimal(pricing.outputUsdPerMillionTokens), scale = Math.max(input.scale, output.scale);
  const amount = BigInt(inputTokens) * BigInt(inputMultiplier) * input.coefficient * 10n ** BigInt(scale - input.scale) + BigInt(outputTokens) * output.coefficient * 10n ** BigInt(scale - output.scale);
  return rounded(amount, 10n ** BigInt(scale), true);
}
export function usdToMicroUsd(value: number, up = false): number { const number = decimal(value); return rounded(number.coefficient * 1000000n, 10n ** BigInt(number.scale), up); }

function ledger(state: WorkerState, attemptId: string): Ledger {
  const result = LedgerSchema.safeParse(state.get(key(attemptId)));
  if (!result.success) throw new Error('INFERENCE_USAGE_UNAVAILABLE'); return result.data;
}
export function initializeUsage(state: WorkerState, attemptId: string, raw: UsagePricing): void {
  const pricing = PricingSchema.parse(raw), current = state.get(key(attemptId));
  if (state.get(`usageReceipt:${attemptId}`)) throw new Error('INFERENCE_USAGE_FINALIZED');
  if (current === undefined) { state.set(key(attemptId), { schemaVersion: 1, pricing, entries: [] } satisfies Ledger); return; }
  if (JSON.stringify(ledger(state, attemptId).pricing) !== JSON.stringify(pricing)) throw new Error('INFERENCE_PRICING_CHANGED_DURING_ATTEMPT');
}
export function usageSummary(state: WorkerState, attemptId: string) {
  const usage = ledger(state, attemptId);
  return { calls: usage.entries.length, reservedTokens: usage.entries.reduce((sum, call) => sum + call.reservedTokens, 0), reservedCostMicroUsd: usage.entries.reduce((sum, call) => sum + call.reservedCostMicroUsd, 0) };
}
/** Caller includes this write in the same transaction as the daily budget. */
export function reserveUsage(state: WorkerState, attemptId: string, reservedTokens: number, reservedCostMicroUsd: number): string {
  if (state.get(`usageReceipt:${attemptId}`)) throw new Error('INFERENCE_USAGE_FINALIZED');
  const usage = ledger(state, attemptId), id = randomUUID();
  usage.entries.push({ id, reservedTokens, reservedCostMicroUsd });
  state.set(key(attemptId), LedgerSchema.parse(usage)); return id;
}
export function reportUsage(state: WorkerState, attemptId: string, callId: string, inputTokens: number, outputTokens: number): void {
  state.transaction(() => {
    if (state.get(`usageReceipt:${attemptId}`)) throw new Error('INFERENCE_USAGE_FINALIZED');
    const usage = ledger(state, attemptId), call = usage.entries.find(entry => entry.id === callId);
    if (!call || call.reported) throw new Error('INFERENCE_USAGE_CALL_MISMATCH');
    const estimatedCostMicroUsd = tokenCostMicroUsd(inputTokens, outputTokens, usage.pricing);
    if (inputTokens + outputTokens > call.reservedTokens || estimatedCostMicroUsd > call.reservedCostMicroUsd) throw new Error('PROVIDER_USAGE_BOUND_VIOLATION');
    call.reported = { inputTokens, outputTokens, estimatedCostMicroUsd };
    state.set(key(attemptId), LedgerSchema.parse(usage));
  });
}
export function usageReceipt(state: WorkerState, attemptId: string): WorkerUsageReceipt {
  const usage = ledger(state, attemptId), reported = usage.entries.flatMap(call => call.reported ? [call.reported] : []);
  return WorkerUsageReceiptSchema.parse({ attemptId, provider: usage.pricing.provider, model: usage.pricing.model,
    attemptedCalls: usage.entries.length, successfulCalls: reported.length, unpricedCalls: usage.entries.length - reported.length,
    inputTokens: reported.reduce((sum, call) => sum + call.inputTokens, 0), outputTokens: reported.reduce((sum, call) => sum + call.outputTokens, 0),
    estimatedCostMicroUsd: reported.reduce((sum, call) => sum + call.estimatedCostMicroUsd, 0), reservedCostMicroUsd: usage.entries.reduce((sum, call) => sum + call.reservedCostMicroUsd, 0), costBasis: 'WORKER_CONFIGURED_RATES',
  });
}
