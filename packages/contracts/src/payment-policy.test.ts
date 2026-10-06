import { describe, expect, it } from 'vitest';
import { FinancialBreakdownSchema, PREPAID_PAYMENT_POLICY, prepaidFinancialBreakdown } from './payment-policy.js';

const price = { currency: 'USD', buyerPriceMinor: 99, platformFeeMinor: 19, sellerNetMinor: 80 };
describe('explicit prepaid financial interpretation', () => {
  it('preserves fixed economics and distinguishes unknown tax and processor costs from zero', () => {
    expect(prepaidFinancialBreakdown(price)).toEqual({ schemaVersion: 1, currency: 'USD', baseRetailMinor: 99,
      taxMinor: null, taxAssessment: 'UNASSESSED', buyerTotalMinor: 99, buyerTotalBasis: 'PREPAID_CREDIT_RESERVATION',
      sellerEntitlementMinor: 80, marketplaceFeeMinor: 19, paymentProcessingFeeMinor: null,
      paymentProcessingFeeAttribution: 'NOT_ATTRIBUTED_TO_JOB', processingFeeBearer: 'PLATFORM' });
    expect(PREPAID_PAYMENT_POLICY).toMatchObject({ processingFeeBearer: 'PLATFORM', failurePolicy: 'NO_VALIDATED_DELIVERY_NO_SETTLEMENT' });
    expect(Object.isFrozen(PREPAID_PAYMENT_POLICY)).toBe(true);
  });
  it.each([{ taxMinor: 0 }, { taxAssessment: 'EXEMPT' }, { paymentProcessingFeeMinor: 0 }, { processingFeeBearer: 'SELLER' },
    { buyerTotalBasis: 'FINAL_TAX_INVOICE' }, { buyerTotalMinor: 100 }, { sellerEntitlementMinor: 79 }, { currency: 'EUR' }])('rejects unsupported interpretation %j', patch => {
    expect(FinancialBreakdownSchema.safeParse({ ...prepaidFinancialBreakdown(price), ...patch }).success).toBe(false);
  });
  it('rejects unbalanced, fractional and unsupported source prices', () => {
    for (const patch of [{ buyerPriceMinor: 100 }, { platformFeeMinor: 1.5 }, { sellerNetMinor: -1 }, { currency: 'EUR' }]) {
      expect(() => prepaidFinancialBreakdown({ ...price, ...patch })).toThrow();
    }
  });
});
