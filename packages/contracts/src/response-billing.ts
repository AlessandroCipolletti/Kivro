import { z } from 'zod';
import { AssetDTOSchema, FinancialBreakdownSchema, InputFieldSchema, JobDTOSchema, JobOutputSchema,
  JobPauseLimitSchema, OutputContractSchema } from './index.ts';
import { count, isoDate, jsonObject, jsonValue, money, okResponseSchema, responseRoutes, uuid, type ResponseRoute } from './response-common.ts';

const methodId = z.string().regex(/^pm_[A-Za-z0-9]{1,200}$/);
const methodUnavailableReason = z.enum(['DEVELOPMENT_PAYMENTS', 'STRIPE_NOT_CONFIGURED']);
const payoutUnavailableReason = z.enum(['DEVELOPMENT_PAYMENTS', 'STRIPE_NOT_CONFIGURED', 'CONNECT_NOT_CONFIGURED']);
const httpsUrl = z.string().url().refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}, 'Expected an HTTPS URL without credentials');
const hostedUrl = (host: string) => httpsUrl.refine(value => {
  try { const url = new URL(value); return url.hostname === host && !url.port; } catch { return false; }
}, 'Unexpected provider URL host');

export const pendingBillingOperationResponseSchema = z.object({
  key: z.string().min(8).max(200), action: z.enum(['setup', 'default', 'remove']),
  paymentMethodId: methodId.nullable(), consentVersion: z.string().nullable(), retryAfter: isoDate,
}).strict();
export const paymentMethodsResponseSchema = z.object({
  available: z.boolean(), reason: methodUnavailableReason.nullable(),
  consent: z.object({ version: z.string().min(1), text: z.string().min(1) }).strict(),
  pendingOperation: pendingBillingOperationResponseSchema.nullable(),
  methods: z.array(z.object({ id: methodId, type: z.literal('card'), brand: z.string().min(1),
    last4: z.string().regex(/^\d{4}$/), expMonth: z.number().int().min(1).max(12), expYear: count,
    isDefault: z.boolean() }).strict()).max(20),
  defaultPaymentMethodId: methodId.nullable(), hasMore: z.boolean(), nextCursor: methodId.nullable(),
}).strict();
export const paymentMethodSetupResponseSchema = z.object({
  id: z.string().min(1), url: hostedUrl('checkout.stripe.com'), expiresAt: isoDate,
}).strict();
export const billingReceiptsResponseSchema = z.object({
  available: z.boolean(), reason: methodUnavailableReason.nullable(),
  items: z.array(z.object({ id: uuid, amountMinor: money, currency: z.literal('USD'),
    status: z.enum(['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED']), refundedMinor: money,
    createdAt: isoDate, receiptAvailable: z.literal(true) }).strict()).max(20),
  hasMore: z.boolean(), nextCursor: uuid.nullable(),
}).strict();
export const billingReceiptResponseSchema = z.object({ url: hostedUrl('pay.stripe.com') }).strict();

export const walletLedgerEntryResponseSchema = z.object({
  id: uuid, type: z.string().min(1), jobId: uuid.nullable(), currency: z.literal('USD'),
  amountMinor: money, availableDelta: money, reservedDelta: money, spentDelta: money, earnedDelta: money, createdAt: isoDate,
}).strict();
export const walletResponseSchema = z.object({
  availableMinor: money, reservedMinor: money, spentMinor: money, earnedMinor: money,
  ledger: z.array(walletLedgerEntryResponseSchema).max(100),
}).strict();
export const walletTopupResponseSchema = z.union([
  z.object({ id: uuid, status: z.string().min(1) }).strict(),
  // Checkout's SDK URL is nullable; the existing handler returns it unchanged.
  z.object({ id: uuid, url: httpsUrl.nullable() }).strict(),
]);
export const billingWebhookResponseSchema = z.object({ received: z.literal(true), outcome: z.string().min(1) }).strict();

export const sellerTransferResponseSchema = z.object({
  id: uuid, jobId: uuid, sellerId: uuid, amountMinor: money, currency: z.literal('USD'),
  state: z.enum(['NEEDS_RECONCILIATION', 'PENDING', 'PROCESSING', 'REVERSAL_PENDING', 'TRANSFERRED', 'REVERSED', 'CANCELLED']),
  stripeTransferId: z.string().nullable(), destinationAccountId: z.string().nullable(), startedAt: isoDate.nullable(),
  reversalId: z.string().nullable(), attempts: count, nextAttemptAt: isoDate, lastError: z.string().nullable(), createdAt: isoDate,
}).strict();
export const sellerPayoutResponseSchema = z.object({
  id: uuid, amountMinor: money, currency: z.string().regex(/^[A-Z]{3}$/),
  status: z.enum(['pending', 'in_transit', 'paid', 'failed', 'canceled']),
  providerCreatedAt: isoDate, arrivalDate: isoDate, paidAt: isoDate.nullable(),
  failureCode: z.string().regex(/^[a-z0-9_]{1,100}$/).nullable(), lastSyncedAt: isoDate,
}).strict();
export const sellerPayoutsResponseSchema = z.object({
  available: z.boolean(), reason: payoutUnavailableReason.nullable(), items: z.array(sellerPayoutResponseSchema).max(20),
  hasMore: z.boolean(), nextCursor: uuid.nullable(),
}).strict();
export const sellerEarningsResponseSchema = z.object({
  earnedMinor: money, grossSalesMinor: money, platformFeesMinor: money, pendingMinor: money,
  settledJobs: count, pendingJobs: count, connectStatus: z.string().min(1), payoutsEnabled: z.boolean(),
  transfers: z.array(sellerTransferResponseSchema).max(100), transferredMinor: money,
  payoutSummary: z.object({ available: z.boolean(), reason: payoutUnavailableReason.nullable(),
    currency: z.literal('USD'), accountWide: z.literal(true), paidOutMinor: money, pendingMinor: money,
    failedMinor: money, canceledMinor: money, lastSyncedAt: isoDate.nullable(), historyComplete: z.boolean(), lastError: z.string().nullable(),
  }).strict(),
  payouts: z.array(sellerPayoutResponseSchema).max(20), payoutsHasMore: z.boolean(), payoutsNextCursor: uuid.nullable(),
}).strict();
export const sellerAuditEventResponseSchema = z.object({
  id: uuid, actorId: uuid.nullable(), sellerId: uuid.nullable(), jobId: uuid.nullable(), workerId: uuid.nullable(),
  type: z.string().min(1), metadata: jsonValue, createdAt: isoDate,
}).strict();
export const billingAdminOverviewResponseSchema = z.object({
  users: count, capabilities: count, jobs: count, activeJobs: count, platformFeeMinor: money, dispatchEnabled: z.boolean(),
}).strict();

export const billingDisputeResponseSchema = z.object({
  id: z.string().min(1), paymentIntentId: z.string().min(1), topupId: uuid.nullable(), livemode: z.boolean(), amountMinor: money,
  // Unknown provider states/currencies remain visible for conservative operator review.
  currency: z.string().length(3), status: z.string().min(1), lastEventCreated: count, lastEventId: z.string().min(1),
  closedStatus: z.string().nullable(), closedEventCreated: count.nullable(), withdrawnEventCreated: count.nullable(),
  reinstatedEventCreated: count.nullable(), reviewRequired: z.boolean(), createdAt: isoDate, updatedAt: isoDate,
  blockingReason: z.enum(['PROVIDER_REVIEW_REQUIRED', 'DISPUTE_OPEN', 'DISPUTE_LOST', 'UNEXPECTED_DISPUTE_WITHDRAWAL',
    'UNKNOWN_DISPUTE_OUTCOME', 'FUNDS_REINSTATEMENT_PENDING']).nullable(),
}).strict();
export const billingReviewResponseSchema = z.object({
  user: z.object({ id: uuid, name: z.string(), suspendedAt: isoDate.nullable() }).strict(), refundDebtMinor: money,
  topups: z.array(z.object({ id: uuid, amountMinor: money, refundedMinor: money, refundDebtMinor: money,
    disputedAt: isoDate.nullable(), disputes: z.array(billingDisputeResponseSchema) }).strict()),
}).strict();
export const billingRestoreResponseSchema = z.union([
  z.object({ userId: uuid, suspended: z.literal(false), alreadyActive: z.literal(true) }).strict(),
  z.object({ userId: uuid, suspended: z.literal(false), restoredAt: isoDate, auditId: uuid }).strict(),
]);
export const billingSuspendResponseSchema = z.union([z.object({ suspended: z.literal(true) }).strict(), billingRestoreResponseSchema]);

const outputResponse = JobOutputSchema.extend({
  json: jsonValue.optional(), fields: jsonObject.optional(),
  assets: z.array(AssetDTOSchema.extend({ sizeBytes: count, expiresAt: isoDate.optional() }).strict()).max(20).optional(),
}).strict();
// The administrative refund returns jobDto(), including retained buyer content and event metadata.
export const billingRefundJobResponseSchema = JobDTOSchema.extend({
  capabilityVersionNumber: count.positive(), inputContract: z.array(InputFieldSchema.and(jsonObject)).max(50), outputContract: OutputContractSchema.and(jsonObject),
  input: jsonObject, output: outputResponse.nullable(), financialBreakdown: FinancialBreakdownSchema,
  maxPauseMs: JobPauseLimitSchema, pausedDurationMs: count, pausedAt: isoDate.nullable(),
  createdAt: isoDate, updatedAt: isoDate, scheduledAt: isoDate.nullable(), startedAt: isoDate.nullable(), completedAt: isoDate.nullable(),
  originalScheduledAt: isoDate.nullable(), eligibleAt: isoDate.nullable(), queuedAt: isoDate.nullable(),
  contentDeletedAt: isoDate.nullable(), contentExpiresAt: isoDate.nullable(), pauseSupport: z.literal('FULL_RESUME'),
  events: z.array(z.object({ id: uuid, type: z.string(), message: z.string(), createdAt: isoDate, metadata: jsonValue }).strict()),
}).strict();

export const billingResponseRoutes: ResponseRoute[] = [
  ...responseRoutes('GET', ['/api/billing/payment-methods'], paymentMethodsResponseSchema),
  ...responseRoutes('POST', ['/api/billing/payment-methods/setup'], paymentMethodSetupResponseSchema),
  ...responseRoutes('POST', ['/api/billing/payment-methods/:id/default', '/api/billing/payment-methods/:id/remove'], okResponseSchema),
  ...responseRoutes('GET', ['/api/billing/receipts'], billingReceiptsResponseSchema),
  ...responseRoutes('GET', ['/api/billing/receipts/:id'], billingReceiptResponseSchema),
  ...responseRoutes('GET', ['/api/wallet'], walletResponseSchema),
  ...responseRoutes('POST', ['/api/wallet/topup'], walletTopupResponseSchema),
  ...responseRoutes('POST', ['/api/billing/webhook'], billingWebhookResponseSchema),
  ...responseRoutes('POST', ['/api/seller/billing/onboard'], z.object({ url: httpsUrl }).strict()),
  ...responseRoutes('GET', ['/api/seller/earnings'], sellerEarningsResponseSchema),
  ...responseRoutes('GET', ['/api/seller/payouts'], sellerPayoutsResponseSchema),
  ...responseRoutes('GET', ['/api/seller/audit'], z.array(sellerAuditEventResponseSchema).max(200)),
  ...responseRoutes('GET', ['/api/admin/overview'], billingAdminOverviewResponseSchema),
  ...responseRoutes('GET', ['/api/admin/transfers'], z.array(sellerTransferResponseSchema).max(100)),
  ...responseRoutes('POST', ['/api/admin/transfers/:id/resolve', '/api/admin/transfers/:id/cancel-uncreated'], sellerTransferResponseSchema),
  ...responseRoutes('POST', ['/api/admin/dispatch'], z.object({ enabled: z.boolean() }).strict()),
  ...responseRoutes('GET', ['/api/admin/users/:id/billing-review'], billingReviewResponseSchema),
  ...responseRoutes('POST', ['/api/admin/users/:id/restore'], billingRestoreResponseSchema),
  ...responseRoutes('POST', ['/api/admin/users/:id/suspend'], billingSuspendResponseSchema),
  ...responseRoutes('POST', ['/api/admin/jobs/:id/refund'], billingRefundJobResponseSchema),
];
