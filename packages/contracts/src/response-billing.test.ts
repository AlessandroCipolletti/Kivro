import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { prepaidFinancialBreakdown } from './payment-policy.ts';
import { errorResponseSchema } from './response-common.ts';
import { billingResponseRoutes, billingDisputeResponseSchema, billingRefundJobResponseSchema, billingRestoreResponseSchema,
  billingSuspendResponseSchema, paymentMethodsResponseSchema, sellerEarningsResponseSchema, sellerPayoutResponseSchema,
  sellerTransferResponseSchema, walletResponseSchema, walletTopupResponseSchema } from './response-billing.ts';

const id = 'a1000000-0000-4000-a000-000000000001', at = '2026-10-06T12:00:00.000Z';
const pending = { key: 'saved-method-test', action: 'setup', paymentMethodId: null, consentVersion: 'saved-card-2026-10-06-v1', retryAfter: at };
const methods = { available: true, reason: null, consent: { version: 'saved-card-2026-10-06-v1', text: 'Explicit fixture consent' }, pendingOperation: pending,
  methods: [{ id: 'pm_fixture1', type: 'card', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: true }],
  defaultPaymentMethodId: 'pm_fixture1', hasMore: true, nextCursor: 'pm_fixture1' };
const ledger = { id, type: 'JOB_RELEASE', jobId: id, currency: 'USD', amountMinor: 99,
  availableDelta: 99, reservedDelta: -99, spentDelta: 0, earnedDelta: 0, createdAt: at };
const wallet = { availableMinor: 99, reservedMinor: 0, spentMinor: 0, earnedMinor: 0, ledger: [ledger] };
const transfer = { id, jobId: id, sellerId: id, amountMinor: 80, currency: 'USD', state: 'TRANSFERRED', stripeTransferId: 'tr_fixture',
  destinationAccountId: 'acct_fixture', startedAt: at, reversalId: null, attempts: 1, nextAttemptAt: at, lastError: null, createdAt: at };
const payout = { id, amountMinor: 500, currency: 'CHF', status: 'paid', providerCreatedAt: at, arrivalDate: at, paidAt: at,
  failureCode: null, lastSyncedAt: at };
const earnings = { earnedMinor: 80, grossSalesMinor: 99, platformFeesMinor: 19, pendingMinor: 0, settledJobs: 1, pendingJobs: 0,
  connectStatus: 'READY', payoutsEnabled: true, transfers: [transfer], transferredMinor: 80,
  payoutSummary: { available: true, reason: null, currency: 'USD', accountWide: true, paidOutMinor: 0, pendingMinor: 0,
    failedMinor: 0, canceledMinor: 0, lastSyncedAt: at, historyComplete: true, lastError: null },
  payouts: [payout], payoutsHasMore: false, payoutsNextCursor: null };
const dispute = { id: 'dp_fixture', paymentIntentId: 'pi_fixture', topupId: id, livemode: false, amountMinor: 500, currency: 'usd',
  status: 'won', lastEventCreated: 1_790_251_200, lastEventId: 'evt_fixture', closedStatus: 'won', closedEventCreated: 1_790_251_199,
  withdrawnEventCreated: 1_790_251_198, reinstatedEventCreated: 1_790_251_200, reviewRequired: false, createdAt: at, updatedAt: at, blockingReason: null };
const review = { user: { id, name: 'Buyer', suspendedAt: at }, refundDebtMinor: 100,
  topups: [{ id, amountMinor: 500, refundedMinor: 200, refundDebtMinor: 100, disputedAt: null, disputes: [dispute] }] };
const restored = { userId: id, suspended: false, restoredAt: at, auditId: id };
const price = { id: 'USD_99', currency: 'USD', buyerPriceMinor: 99, platformFeeMinor: 19, sellerNetMinor: 80, enabled: true, sortOrder: 0 };
const asset = { id, filename: 'result.png', mimeType: 'image/png', sizeBytes: 80, sha256: 'a'.repeat(64), expiresAt: at, downloadUrl: 'https://files.example.test/result' };
const job = { id, capabilityId: id, capabilityVersionId: id, capabilityTitle: 'Fixture', capabilityVersionNumber: 1,
  inputContract: [{ key: 'text', label: 'Text', type: 'SHORT_TEXT', required: true, order: 0, constraints: { maxLength: 100 } }],
  outputContract: { type: 'TEXT', description: 'Result', required: true }, buyerId: id, sellerId: id, state: 'SUCCEEDED', paymentState: 'REFUNDED',
  input: { text: 'Buyer content' }, output: { text: 'Result', json: { nested: [true, null, 1] }, assets: [asset], fields: { result: 'Result' } },
  priceSnapshot: price, financialBreakdown: prepaidFinancialBreakdown(price), maxPauseMs: 900_000, pausedDurationMs: 0, pausedAt: null,
  createdAt: at, updatedAt: at, scheduledAt: null, startedAt: at, completedAt: at, originalScheduledAt: null, eligibleAt: at, queuedAt: at,
  contentDeletedAt: null, contentExpiresAt: at, pauseSupport: 'FULL_RESUME', error: null,
  events: [{ id, type: 'REFUNDED', message: 'Administrative refund', createdAt: at, metadata: { reason: 'Fixture', amountMinor: 99 } }] };

const fixtures: Record<string, unknown> = {
  'GET /api/billing/payment-methods': methods,
  'POST /api/billing/payment-methods/setup': { id: 'cs_test_fixture', url: 'https://checkout.stripe.com/c/pay/fixture', expiresAt: at },
  'POST /api/billing/payment-methods/:id/default': { ok: true },
  'POST /api/billing/payment-methods/:id/remove': { ok: true },
  'GET /api/billing/receipts': { available: true, reason: null, items: [{ id, amountMinor: 500, currency: 'USD', status: 'PARTIALLY_REFUNDED', refundedMinor: 100, createdAt: at, receiptAvailable: true }], hasMore: true, nextCursor: id },
  'GET /api/billing/receipts/:id': { url: 'https://pay.stripe.com/receipts/fixture' },
  'GET /api/wallet': wallet,
  'POST /api/wallet/topup': { id, status: 'PAID' },
  'POST /api/billing/webhook': { received: true, outcome: 'REQUIRES_REVIEW' },
  'POST /api/seller/billing/onboard': { url: 'https://connect.stripe.com/setup/fixture' },
  'GET /api/seller/earnings': earnings,
  'GET /api/seller/payouts': { available: true, reason: null, items: [payout], hasMore: false, nextCursor: null },
  'GET /api/seller/audit': [{ id, actorId: id, sellerId: id, jobId: null, workerId: null, type: 'PAYMENT_REVIEW', metadata: { evidence: [true, { amountMinor: 99 }] }, createdAt: at }],
  'GET /api/admin/overview': { users: 2, capabilities: 1, jobs: 1, activeJobs: 0, platformFeeMinor: -19, dispatchEnabled: true },
  'GET /api/admin/transfers': [transfer],
  'POST /api/admin/transfers/:id/resolve': transfer,
  'POST /api/admin/transfers/:id/cancel-uncreated': { ...transfer, state: 'CANCELLED', stripeTransferId: null },
  'POST /api/admin/dispatch': { enabled: false },
  'GET /api/admin/users/:id/billing-review': review,
  'POST /api/admin/users/:id/restore': restored,
  'POST /api/admin/users/:id/suspend': { suspended: true },
  'POST /api/admin/jobs/:id/refund': job,
};

// Read registration syntax without importing server code or connecting to a database.
function registeredBillingRoutes(): string[] {
  const file = ts.createSourceFile('billing.ts', readFileSync(new URL('../../../apps/api/src/billing.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const registration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'registerBilling');
  if (!registration) throw new Error('Missing registerBilling');
  const routes: string[] = [];
  const visit = (node: ts.Node, bindings: Record<string, string>) => {
    if (ts.isForOfStatement(node)) {
      const values = ts.isAsExpression(node.expression) ? node.expression.expression : node.expression;
      const declaration = ts.isVariableDeclarationList(node.initializer) ? node.initializer.declarations[0]?.name : undefined;
      if (!ts.isArrayLiteralExpression(values) || !declaration || !ts.isIdentifier(declaration)) throw new Error('Unrecognized route loop');
      for (const value of values.elements) {
        if (!ts.isStringLiteral(value)) throw new Error('Nonliteral route loop');
        visit(node.statement, { ...bindings, [declaration.text]: value.text });
      }
      return;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'app') {
      const method = node.expression.name.text.toUpperCase(), argument = node.arguments[0];
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error(`Unrecognized app registration: ${method}`);
      let path: string;
      if (argument && ts.isStringLiteral(argument)) path = argument.text;
      else if (argument && ts.isTemplateExpression(argument)) {
        path = argument.head.text;
        for (const span of argument.templateSpans) {
          if (!ts.isIdentifier(span.expression) || bindings[span.expression.text] === undefined) throw new Error('Unresolved route template');
          path += bindings[span.expression.text] + span.literal.text;
        }
      } else throw new Error('Nonliteral route');
      routes.push(`${method} ${path}`);
    }
    ts.forEachChild(node, child => visit(child, bindings));
  };
  visit(registration, {});
  return routes.sort();
}

describe('browser-safe billing response contracts', () => {
  it('covers every actual billing registration, including both generated method routes, without duplicates', () => {
    const routes = billingResponseRoutes.map(route => `${route.method} ${route.path}`).sort();
    expect(routes).toHaveLength(22);
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes).toEqual(registeredBillingRoutes());
    expect(routes).toEqual(Object.keys(fixtures).sort());
  });

  it.each(billingResponseRoutes.map(route => ({ ...route, key: `${route.method} ${route.path}` })))('preserves the complete $key projection and rejects undeclared fields', ({ key, schema }) => {
    const fixture = fixtures[key];
    expect(schema.parse(fixture)).toEqual(fixture);
    const extra = Array.isArray(fixture) ? fixture.map(item => ({ ...item, privateKey: 'must-not-be-stripped' })) : { ...fixture as object, privateKey: 'must-not-be-stripped' };
    expect(schema.safeParse(extra).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('accepts every unavailable/empty list branch and pending saved-method action', () => {
    for (const reason of ['DEVELOPMENT_PAYMENTS', 'STRIPE_NOT_CONFIGURED', null]) {
      const common = { available: reason === null, reason, hasMore: false, nextCursor: null };
      expect(paymentMethodsResponseSchema.parse({ ...methods, ...common, methods: [], defaultPaymentMethodId: null, pendingOperation: null }).methods).toEqual([]);
      for (const path of ['/api/billing/receipts', '/api/seller/payouts']) {
        expect(billingResponseRoutes.find(route => route.path === path)!.schema.parse({ ...common, items: [] })).toEqual({ ...common, items: [] });
      }
    }
    expect(billingResponseRoutes.find(route => route.path === '/api/seller/payouts')!.schema.safeParse({ available: false, reason: 'CONNECT_NOT_CONFIGURED', items: [], hasMore: false, nextCursor: null }).success).toBe(true);
    for (const action of ['setup', 'default', 'remove']) {
      const value = { ...methods, pendingOperation: { ...pending, action, paymentMethodId: action === 'setup' ? null : 'pm_fixture1', retryAfter: '1970-01-01T00:00:00.000Z' } };
      expect(paymentMethodsResponseSchema.parse(value)).toEqual(value);
    }
  });

  it('rejects card secrets, malformed cards and internal operation state', () => {
    for (const patch of [{ card: { number: '4242424242424242' } }, { last4: '4242424242424242' }, { expMonth: 13 }, { id: 'cus_wrongtype' }]) {
      expect(paymentMethodsResponseSchema.safeParse({ ...methods, methods: [{ ...methods.methods[0], ...patch }] }).success).toBe(false);
    }
    for (const patch of [{ customerId: 'cus_private' }, { authorized: true }, { state: 'PENDING' }, { retryAfter: new Date(at) }]) {
      expect(paymentMethodsResponseSchema.safeParse({ ...methods, pendingOperation: { ...pending, ...patch } }).success).toBe(false);
    }
  });

  it('keeps signed financial deltas and refuses coerced, unsafe or fractional money', () => {
    for (const field of ['amountMinor', 'availableDelta', 'reservedDelta', 'spentDelta', 'earnedDelta']) {
      expect(walletResponseSchema.safeParse({ ...wallet, ledger: [{ ...ledger, [field]: -99 }] }).success).toBe(true);
      for (const value of ['99', 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(walletResponseSchema.safeParse({ ...wallet, ledger: [{ ...ledger, [field]: value }] }).success).toBe(false);
      }
    }
    expect(walletResponseSchema.safeParse({ ...wallet, ledger: [{ ...ledger, currency: 'CHF' }] }).success).toBe(false);
  });

  it('preserves all topup branches without combining status and hosted URL', () => {
    for (const value of [{ id, status: 'PAID' }, { id, status: 'REFUNDED' }, { id, url: 'https://checkout.stripe.com/c/pay/test' }, { id, url: null }]) {
      expect(walletTopupResponseSchema.parse(value)).toEqual(value);
    }
    expect(walletTopupResponseSchema.safeParse({ id, status: 'PAID', url: null }).success).toBe(false);
  });

  it('rejects unsafe or foreign setup/receipt URLs without throwing outside Zod', () => {
    for (const path of ['/api/billing/payment-methods/setup', '/api/billing/receipts/:id', '/api/seller/billing/onboard', '/api/wallet/topup']) {
      const route = billingResponseRoutes.find(item => item.path === path)!;
      const base = path.endsWith('/setup') ? { id: 'cs_fixture', expiresAt: at } : path.endsWith('/topup') ? { id } : {};
      for (const url of ['not a URL', 'javascript:alert(1)', 'http://checkout.stripe.com/test', 'https://user:pass@checkout.stripe.com/test']) {
        expect(route.schema.safeParse({ ...base, url }).success).toBe(false);
      }
      if (path.startsWith('/api/billing/')) {
        for (const url of ['https://attacker.test/test', 'https://checkout.stripe.com.attacker.test/test', 'https://pay.stripe.com:444/test']) {
          expect(route.schema.safeParse({ ...base, url }).success).toBe(false);
        }
      }
    }
  });

  it('retains non-USD payout evidence separately from USD earnings totals', () => {
    expect(sellerEarningsResponseSchema.parse(earnings).payouts[0]!.currency).toBe('CHF');
    for (const status of ['pending', 'in_transit', 'paid', 'failed', 'canceled']) {
      expect(sellerPayoutResponseSchema.safeParse({ ...payout, status, paidAt: null, failureCode: status === 'failed' ? 'account_closed' : null }).success).toBe(true);
    }
    for (const extra of [{ stripeAccountId: 'acct_private' }, { stripePayoutId: 'po_private' }, { destination: { bankAccount: 'private' } }]) {
      expect(sellerPayoutResponseSchema.safeParse({ ...payout, ...extra }).success).toBe(false);
    }
    expect(sellerEarningsResponseSchema.safeParse({ ...earnings, payoutSummary: { ...earnings.payoutSummary, currency: 'CHF' } }).success).toBe(false);
    expect(sellerPayoutResponseSchema.safeParse({ ...payout, status: 'TRANSFERRED' }).success).toBe(false);
  });

  it('validates required transfer evidence, nullable provider references and every reconciliation state', () => {
    for (const state of ['NEEDS_RECONCILIATION', 'PENDING', 'PROCESSING', 'REVERSAL_PENDING', 'TRANSFERRED', 'REVERSED', 'CANCELLED']) {
      const value = { ...transfer, state, stripeTransferId: null, destinationAccountId: null, startedAt: null, reversalId: null, lastError: 'OPERATOR_REVIEW' };
      expect(sellerTransferResponseSchema.parse(value)).toEqual(value);
    }
    expect(sellerTransferResponseSchema.safeParse({ ...transfer, nextAttemptAt: undefined }).success).toBe(false);
    expect(sellerTransferResponseSchema.safeParse({ ...transfer, attempts: -1 }).success).toBe(false);
  });

  it('keeps unknown provider dispute evidence visible and clocks distinct from wire dates', () => {
    const unknown = { ...dispute, topupId: null, currency: 'chf', status: 'new_provider_status', closedStatus: 'new_provider_status',
      lastEventCreated: 0, closedEventCreated: null, withdrawnEventCreated: null, reinstatedEventCreated: null,
      reviewRequired: true, blockingReason: 'PROVIDER_REVIEW_REQUIRED' };
    expect(billingDisputeResponseSchema.parse(unknown)).toEqual(unknown);
    for (const field of ['lastEventCreated', 'closedEventCreated', 'withdrawnEventCreated', 'reinstatedEventCreated']) {
      expect(billingDisputeResponseSchema.safeParse({ ...dispute, [field]: at }).success).toBe(false);
    }
    expect(billingDisputeResponseSchema.safeParse({ ...dispute, payment_intent: 'unprojected' }).success).toBe(false);
  });

  it('accepts idempotent restoration and legacy suspend(false) responses without inventing restoration effects', () => {
    const alreadyActive = { userId: id, suspended: false, alreadyActive: true };
    for (const value of [restored, alreadyActive]) {
      expect(billingRestoreResponseSchema.parse(value)).toEqual(value);
      expect(billingSuspendResponseSchema.parse(value)).toEqual(value);
    }
    for (const value of [{ suspended: false }, { ...restored, alreadyActive: true }, { ...alreadyActive, sessionsRestored: true }]) {
      expect(billingRestoreResponseSchema.safeParse(value).success).toBe(false);
      expect(billingSuspendResponseSchema.safeParse(value).success).toBe(false);
    }
  });

  it('requires ISO wire dates at every projected date location', () => {
    const visits: { route: string; path: (string | number)[] }[] = [];
    const findDates = (route: string, value: unknown, path: (string | number)[] = []) => {
      if (value === at || value === null && String(path.at(-1)).endsWith('At')) visits.push({ route, path });
      else if (Array.isArray(value)) value.forEach((child, index) => findDates(route, child, [...path, index]));
      else if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => findDates(route, child, [...path, key]));
    };
    for (const [route, fixture] of Object.entries(fixtures)) findDates(route, fixture);
    expect(visits.length).toBeGreaterThan(40);
    for (const { route, path } of visits) {
      const schema = billingResponseRoutes.find(item => `${item.method} ${item.path}` === route)!.schema;
      for (const invalid of ['not-a-date', at.slice(0, -1), 123, new Date(at)]) {
        const changed: unknown = structuredClone(fixtures[route]);
        let object = changed as Record<string | number, unknown>;
        for (const key of path.slice(0, -1)) object = object[key] as Record<string | number, unknown>;
        object[path.at(-1)!] = invalid;
        expect(schema.safeParse(changed).success, `${route} ${path.join('.')}`).toBe(false);
      }
    }
  });

  it('requires the complete refund job and strict nested contracts, output, assets and events', () => {
    for (const field of ['capabilityVersionNumber', 'inputContract', 'outputContract', 'financialBreakdown', 'maxPauseMs', 'pausedAt', 'contentExpiresAt', 'pauseSupport', 'events']) {
      expect(billingRefundJobResponseSchema.safeParse({ ...job, [field]: undefined }).success).toBe(false);
    }
    for (const patch of [
      { events: [{ ...job.events[0], privateKey: 'unprojected' }] },
      { output: { ...job.output, storageKey: 'private' } },
      { output: { assets: [{ ...asset, storageKey: 'private' }] } },
      { inputContract: [{ ...job.inputContract[0], privateKey: 'private' }] },
      { inputContract: [{ ...job.inputContract[0], constraints: { extraConstraint: true } }] },
      { outputContract: { ...job.outputContract, extra: true } },
      { priceSnapshot: { ...price, platformFeeMinor: 20 } },
      { financialBreakdown: { ...job.financialBreakdown, taxMinor: 0 } },
    ]) expect(billingRefundJobResponseSchema.safeParse({ ...job, ...patch }).success).toBe(false);
    const redacted = { ...job, input: {}, output: null, contentDeletedAt: at };
    expect(billingRefundJobResponseSchema.parse(redacted)).toEqual(redacted);
  });

  it('allows intentional JSON content and metadata but not non-JSON values or arbitrary envelopes', () => {
    for (const value of [Infinity, undefined, new Date(at), () => null]) {
      for (const patch of [{ input: { key: value } }, { output: { json: { key: value } } }, { output: { fields: { key: value } } },
        { events: [{ ...job.events[0], metadata: { key: value } }] },
        { inputContract: [{ ...job.inputContract[0], default: value, constraints: { jsonSchema: { key: value } } }] }]) {
        expect(billingRefundJobResponseSchema.safeParse({ ...job, ...patch }).success).toBe(false);
      }
    }
    const envelope = { error: { code: 'BILLING_OPERATION_PENDING', message: 'Retry this operation', details: pending } };
    expect(errorResponseSchema.parse(envelope)).toEqual(envelope);
    expect(errorResponseSchema.safeParse({ error: { ...envelope.error, stripeSecretKey: 'private' } }).success).toBe(false);
    for (const route of billingResponseRoutes) expect(route.schema.safeParse(envelope).success).toBe(false);
  });

  it('bundles for browsers without importing Stripe, Node, the database or API code', async () => {
    const require = createRequire(import.meta.url);
    const bundler = createRequire(require.resolve('tsx'))('esbuild') as {
      build(options: object): Promise<{ metafile: { inputs: Record<string, unknown>; outputs: Record<string, { imports: { path: string }[] }> } }>;
    };
    const built = await bundler.build({ entryPoints: [fileURLToPath(new URL('./response-billing.ts', import.meta.url))],
      platform: 'browser', format: 'esm', bundle: true, write: false, metafile: true, logLevel: 'silent' });
    expect(Object.keys(built.metafile.inputs).some(path => /(?:packages\/(?:billing|database|storage)|apps\/(?:api|worker)|node_modules\/stripe)\//.test(path))).toBe(false);
    expect(Object.values(built.metafile.outputs).flatMap(output => output.imports)).toEqual([]);
  });
});
