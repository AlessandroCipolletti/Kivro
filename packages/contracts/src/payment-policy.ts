import { z } from 'zod';

export const PREPAID_PAYMENT_POLICY = Object.freeze({
  version: 'PREPAID_USD_V1', currency: 'USD', processingFeeBearer: 'PLATFORM',
  taxAssessment: 'UNASSESSED', buyerTotalBasis: 'PREPAID_CREDIT_RESERVATION',
  failurePolicy: 'NO_VALIDATED_DELIVERY_NO_SETTLEMENT',
} as const);

const amount = z.number().int().positive().max(100_000_000);
export const FinancialBreakdownSchema = z.object({
  schemaVersion: z.literal(1), currency: z.literal('USD'), baseRetailMinor: amount,
  taxMinor: z.null(), taxAssessment: z.literal('UNASSESSED'),
  buyerTotalMinor: amount, buyerTotalBasis: z.literal('PREPAID_CREDIT_RESERVATION'),
  sellerEntitlementMinor: amount, marketplaceFeeMinor: z.number().int().nonnegative().max(100_000_000),
  paymentProcessingFeeMinor: z.null(), paymentProcessingFeeAttribution: z.literal('NOT_ATTRIBUTED_TO_JOB'),
  processingFeeBearer: z.literal('PLATFORM'),
}).strict().superRefine((value, ctx) => {
  if (value.baseRetailMinor !== value.sellerEntitlementMinor + value.marketplaceFeeMinor || value.buyerTotalMinor !== value.baseRetailMinor) {
    ctx.addIssue({ code: 'custom', message: 'Prepaid reservation and commercial allocation must balance independently of unassessed tax.' });
  }
});
export type FinancialBreakdown = z.infer<typeof FinancialBreakdownSchema>;

export function prepaidFinancialBreakdown(price: { currency: string; buyerPriceMinor: number; sellerNetMinor: number; platformFeeMinor: number }): FinancialBreakdown {
  return FinancialBreakdownSchema.parse({ schemaVersion: 1, currency: price.currency, baseRetailMinor: price.buyerPriceMinor,
    taxMinor: null, taxAssessment: 'UNASSESSED', buyerTotalMinor: price.buyerPriceMinor, buyerTotalBasis: 'PREPAID_CREDIT_RESERVATION',
    sellerEntitlementMinor: price.sellerNetMinor, marketplaceFeeMinor: price.platformFeeMinor,
    paymentProcessingFeeMinor: null, paymentProcessingFeeAttribution: 'NOT_ATTRIBUTED_TO_JOB', processingFeeBearer: 'PLATFORM' });
}
