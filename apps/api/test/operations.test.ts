import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { addInferenceRecord, addWorkerUsageRecord, operationsSnapshot, OperationsQuery, type InferenceOperationsTotals, type SellerUsageTotals } from '../src/operations.js';

const totals = (): InferenceOperationsTotals => ({ finishedCalls: 0, succeededCalls: 0, failedCalls: 0, unsettledCalls: 0, invalidRecordCount: 0,
  recordedCostMicroUsd: 0, successfulUsageCostMicroUsd: 0, failedCallBudgetChargeMicroUsd: 0, reservedBudgetMicroUsd: 0 });

describe('operations accounting boundaries', () => {
  it('bounds the reporting period and rejects caller-controlled seller scope', () => {
    expect(OperationsQuery.parse({})).toEqual({ days: 30 });
    expect(OperationsQuery.parse({ days: '90' })).toEqual({ days: 90 });
    for (const input of [{ days: 0 }, { days: 91 }, { days: 'Infinity' }, { days: 'bad' }, { days: 1.5 }, { sellerId: 'another-account' }]) {
      expect(OperationsQuery.safeParse(input).success).toBe(false);
    }
  });
  it('separates rate-derived successful spend, failure budget charges and open reservations', () => {
    const result = totals();
    addInferenceRecord(result, { state: 'FINISHED', provider: 'fixture', model: 'model', outcome: 'SUCCEEDED', costMicroUsd: 30 });
    addInferenceRecord(result, { state: 'FINISHED', provider: 'fixture', model: 'model', outcome: 'FAILED', costMicroUsd: 70 });
    addInferenceRecord(result, { state: 'RESERVED', provider: 'fixture', model: 'model', maxCostMicroUsd: 50 });
    expect(result).toEqual({ finishedCalls: 2, succeededCalls: 1, failedCalls: 1, unsettledCalls: 1, invalidRecordCount: 0,
      recordedCostMicroUsd: 100, successfulUsageCostMicroUsd: 30, failedCallBudgetChargeMicroUsd: 70, reservedBudgetMicroUsd: 50 });
  });
  it('does not manufacture costs from malformed, missing or negative amounts', () => {
    const result = totals();
    for (const cost of [undefined, null, -1, '12', Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(addInferenceRecord(result, { state: 'FINISHED', provider: 'fixture', model: 'model', outcome: 'SUCCEEDED', costMicroUsd: cost })).toBeNull();
    }
    expect(result.recordedCostMicroUsd).toBe(0); expect(result.invalidRecordCount).toBe(7);
    expect(addInferenceRecord(result, { state: 'FINISHED', provider: 'fixture', model: 'model', outcome: 'SUCCEEDED', costMicroUsd: 0 })).not.toBeNull();
    expect(result.finishedCalls).toBe(1);
  });
  it('projects only aggregate-safe fields and refuses unsafe numeric sums', () => {
    const result = totals();
    const projected = addInferenceRecord(result, { state: 'RESERVED', provider: 'fixture', model: 'model', maxCostMicroUsd: 5,
      metadata: { userId: 'private-user', prompt: 'private prompt' }, credential: 'secret' });
    expect(JSON.stringify(projected)).not.toMatch(/private|secret|credential|metadata/);
    result.reservedBudgetMicroUsd = Number.MAX_SAFE_INTEGER;
    expect(() => addInferenceRecord(result, { state: 'RESERVED', provider: 'fixture', model: 'model', maxCostMicroUsd: 1 })).toThrow();
  });
  it('classifies corrupt stored aggregates as a sanitized server error, not invalid user input', async () => {
    const ctx = { config: { heartbeatTtlMs: 60000 }, db: { $transaction: async () => { z.number().parse('private invalid stored amount'); } } } as unknown as Parameters<typeof operationsSnapshot>[0];
    await expect(operationsSnapshot(ctx, undefined)).rejects.toMatchObject({ statusCode: 500, code: 'OPERATIONS_DATA_INVALID', message: 'Stored operational metrics failed validation' });
  });
});

describe('recorded seller usage accounting', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const now = new Date('2026-10-06T10:00:00Z'), acceptedAt = new Date('2026-10-06T09:00:00Z'), finishedAt = new Date('2026-10-06T09:01:00Z');
  const usage = () => ({ attemptId: id, provider: 'anthropic', model: 'fixture-model', attemptedCalls: 2, successfulCalls: 1, unpricedCalls: 1,
    inputTokens: 100, outputTokens: 20, estimatedCostMicroUsd: 30, reservedCostMicroUsd: 900, costBasis: 'WORKER_CONFIGURED_RATES' });
  const empty = (): SellerUsageTotals => ({ reportedAttempts: 0, attemptedCalls: 0, successfulCalls: 0, unpricedCalls: 0,
    inputTokens: 0, outputTokens: 0, estimatedProviderCostMicroUsd: 0, reservedCostMicroUsd: 0 });
  const row = () => ({ id, acceptedAt, finishedAt, usageReportedAt: finishedAt, usageReceipt: usage() });

  it('counts recorded calls and tokens without charging the uncertainty reservation as spent', () => {
    const total = empty();
    expect(addWorkerUsageRecord(total, row(), now).status).toBe('RECORDED');
    expect(total).toEqual({ reportedAttempts: 1, attemptedCalls: 2, successfulCalls: 1, unpricedCalls: 1,
      inputTokens: 100, outputTokens: 20, estimatedProviderCostMicroUsd: 30, reservedCostMicroUsd: 900 });
  });
  it('accepts a genuine zero-call receipt without inventing tokens or provider costs', () => {
    const total = empty();
    expect(addWorkerUsageRecord(total, { ...row(), usageReceipt: { ...usage(), attemptedCalls: 0, successfulCalls: 0, unpricedCalls: 0,
      inputTokens: 0, outputTokens: 0, estimatedCostMicroUsd: 0, reservedCostMicroUsd: 0 } }, now).status).toBe('RECORDED');
    expect(total).toEqual({ ...empty(), reportedAttempts: 1 });
  });
  it('does not include absent or later-reported receipts in an earlier snapshot', () => {
    const total = empty();
    expect(addWorkerUsageRecord(total, { ...row(), usageReceipt: null, usageReportedAt: null }, now).status).toBe('MISSING');
    expect(addWorkerUsageRecord(total, { ...row(), usageReportedAt: new Date(now.getTime() + 1) }, now).status).toBe('MISSING');
    expect(total).toEqual(empty());
  });
  it('rejects malformed, misbound, unbalanced and contradictory receipts without leaking them', () => {
    const total = empty();
    for (const change of [
      { usageReceipt: { ...usage(), attemptId: '22222222-2222-4222-8222-222222222222' } },
      { usageReceipt: { ...usage(), estimatedCostMicroUsd: -1 } },
      { usageReceipt: { ...usage(), attemptedCalls: 3 } },
      { usageReceipt: { ...usage(), prompt: 'private data', credential: 'secret' } },
      { usageReportedAt: null }, { finishedAt: null }, { finishedAt: new Date(now.getTime() + 1) },
      { finishedAt: new Date(acceptedAt.getTime() - 1) }, { usageReportedAt: acceptedAt },
    ]) {
      expect(addWorkerUsageRecord(total, { ...row(), ...change }, now)).toEqual({ status: 'INVALID' });
    }
    expect(total).toEqual(empty());
  });
  it('refuses unsafe aggregate token or monetary sums', () => {
    const total = empty(); total.estimatedProviderCostMicroUsd = Number.MAX_SAFE_INTEGER;
    expect(() => addWorkerUsageRecord(total, row(), now)).toThrow();
  });
});
