import { describe, expect, it } from 'vitest';
import { WorkerUsageReceiptSchema } from '../src/worker-usage.js';

describe('sanitized Worker usage receipt', () => {
  const valid = { attemptId: '12345678-1234-4234-8234-123456789abc', provider: 'anthropic', model: 'test', attemptedCalls: 2,
    successfulCalls: 1, unpricedCalls: 1, inputTokens: 10, outputTokens: 5, estimatedCostMicroUsd: 5, reservedCostMicroUsd: 10, costBasis: 'WORKER_CONFIGURED_RATES' };
  it('keeps partial priced usage explicit', () => expect(WorkerUsageReceiptSchema.parse(valid)).toEqual(valid));
  it.each([{ unpricedCalls: 0 }, { estimatedCostMicroUsd: 11 }, { successfulCalls: 0, unpricedCalls: 2 }, { attemptedCalls: 100 }, { apiKey: 'not-allowed' }, { inputTokens: -1 }])('rejects inconsistent or unsafe accounting %j', delta => {
    expect(() => WorkerUsageReceiptSchema.parse({ ...valid, ...delta })).toThrow();
  });
});
