import { describe, expect, it } from 'vitest';
import { JobDTOSchema, JobWaitReasonSchema, getPriceTier } from './index.ts';

const id = 'a1000000-0000-4000-a000-000000000001', at = '2026-10-06T12:00:00.000Z';
const job = { id, capabilityId: id, capabilityVersionId: id, capabilityTitle: 'Waiting fixture', buyerId: id, sellerId: id,
  state: 'SCHEDULED', paymentState: 'RESERVED', input: {}, output: null, priceSnapshot: getPriceTier('USD_99'), createdAt: at,
  updatedAt: at, scheduledAt: at, startedAt: null, completedAt: null, error: null, events: [] };

describe('owner-safe job wait contract', () => {
  it('preserves every public reason and the UTC deadline without normalization', () => {
    for (const waitReason of [...JobWaitReasonSchema.options, null]) {
      const dto = { ...job, waitDeadline: at, waitReason };
      expect(JobDTOSchema.strict().parse(dto)).toEqual(dto);
    }
  });
  it('rejects arbitrary provider diagnostics and invalid deadline wire values', () => {
    for (const waitReason of ['PRIVATE_SANDBOX_WARNING', { workerId: id }, '', 1]) {
      expect(JobDTOSchema.safeParse({ ...job, waitDeadline: at, waitReason }).success).toBe(false);
    }
    for (const waitDeadline of [null, new Date(at), 'tomorrow', 0]) {
      expect(JobDTOSchema.safeParse({ ...job, waitDeadline, waitReason: null }).success).toBe(false);
    }
    expect(JobDTOSchema.strict().safeParse({ ...job, workerHealth: { secret: true } }).success).toBe(false);
  });
  it('keeps historical consumers compatible without inventing absent wait state', () => {
    expect(JobDTOSchema.strict().parse(job)).toEqual(job);
  });
});
