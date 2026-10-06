import { describe, it, expect } from 'vitest';
import { assertMoney, assertPrice } from './ledger.js';

describe('financial validation', () => {
  it('rejects fractional, nonfinite, negative and unsafe money', () => {
    for (const value of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) expect(() => assertMoney(value)).toThrow();
    expect(() => assertMoney(99)).not.toThrow();
  });
  it('requires the exact fixed-tier equation', () => {
    expect(() => assertPrice({ buyerPriceMinor: 99, platformFeeMinor: 19, sellerNetMinor: 80 })).not.toThrow();
    expect(() => assertPrice({ buyerPriceMinor: 99, platformFeeMinor: 20, sellerNetMinor: 80 })).toThrow();
  });
});
