import { describe, expect, it } from 'vitest';
import { queueFullRejectionId } from '../src/capacity-telemetry.js';

describe('capacity rejection identities', () => {
  const buyer = '11111111-1111-4111-8111-111111111111', cap = '22222222-2222-4222-8222-222222222222';
  it('is stable across retries without including the private purchase key', () => {
    const id = queueFullRejectionId(buyer, cap, 'private-purchase-key');
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(id).toBe(queueFullRejectionId(buyer, cap, 'private-purchase-key'));
    expect(id).not.toContain('private');
  });
  it('separates buyer, capability and purchase attempts', () => {
    expect(new Set([queueFullRejectionId(buyer, cap, 'purchase-1'), queueFullRejectionId(cap, buyer, 'purchase-1'),
      queueFullRejectionId(buyer, buyer, 'purchase-1'), queueFullRejectionId(buyer, cap, 'purchase-2')]).size).toBe(4);
  });
  it('rejects malformed identifiers and unbounded keys before database work', () => {
    expect(() => queueFullRejectionId('invalid', cap, 'purchase-1')).toThrow();
    expect(() => queueFullRejectionId(buyer, 'invalid', 'purchase-1')).toThrow();
    expect(() => queueFullRejectionId(buyer, cap, 'short')).toThrow();
    expect(() => queueFullRejectionId(buyer, cap, 'x'.repeat(201))).toThrow();
  });
});
