import { describe, expect, it } from 'vitest';
import type { Job, Transaction } from '@kivro/database';
import { failJob } from '../src/jobs.js';

describe('terminal job recovery', () => {
  it.each(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const)('keeps an unresolved %s reservation in manual review', async state => {
    // A terminal state cannot authorize reconstructing absent financial history.
    const job = { state, paymentState: 'RESERVED' } as Job;
    await expect(failJob({} as Transaction, job, 'CANCELLED', 'Operator containment')).rejects.toMatchObject({ code: 'LEDGER_INVARIANT' });
  });
  it.each(['SETTLED', 'RELEASED', 'REFUNDED'] as const)('retains idempotent terminal replay with %s payment', async paymentState => {
    const job = { state: 'CANCELLED', paymentState } as Job;
    await expect(failJob({} as Transaction, job, 'CANCELLED', 'Operator containment')).resolves.toBe(job);
  });
});
