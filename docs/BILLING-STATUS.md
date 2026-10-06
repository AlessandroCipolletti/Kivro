# Billing implementation evidence

This is bounded package/API evidence, not full PAY-0001, PAY-0042 or PAY-0074 acceptance. No real Stripe credentials or charged requests have been used in this implementation session.

## Parent integration contract (R13)

The parent owns Prisma/schema/migrations and background scheduling. Migration `20261006001400_payouts_worker_health` now provides this model, plus a User relation/foreign key and a database identity-immutability trigger:

```prisma
model PayoutRecord {
  id                String   @id @default(uuid()) @db.Uuid
  sellerId          String   @db.Uuid
  stripeAccountId   String
  stripePayoutId    String
  livemode          Boolean
  amountMinor       Int
  currency          String
  status            String
  providerCreatedAt DateTime
  arrivalDate       DateTime
  paidAt            DateTime?
  failureCode       String?
  lastSyncedAt      DateTime
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  @@unique([livemode, stripeAccountId, stripePayoutId])
  @@index([sellerId, livemode, status])
  @@index([sellerId, providerCreatedAt])
}
```

Migration 014 enforces `amountMinor >= 0`, uppercase three-letter `currency`, and `status IN ('pending','in_transit','paid','failed','canceled')`. Provider amount, currency, owner and creation time are immutable in reconciliation and protected by a database trigger. No ledger entries are generated for a bank payout. The parent has wired `reconcilePayouts(ctx)` into `apps/api/src/background.ts` maintenance and regenerated Prisma. The integration suite deploys the real migrations into its isolated PostgreSQL schema. Existing `PlatformSetting` provides fair cursors/leases and `BillingEvent` provides durable signed-event retry; no other fields are required.

Configuration is wired by the parent: optional `STRIPE_CONNECT_WEBHOOK_SECRET` -> `config.stripeConnectWebhookSecret` -> third constructor argument `new StripeBilling(config.stripeSecret, config.stripeWebhookSecret, config.stripeConnectWebhookSecret)`. The adapter supports the separate Connect destination secret and rejects platform-scoped payloads verified only with that secret. Existing primary-secret/local-CLI forwarding remains compatible. [Stripe documents distinct account/connected-account event scopes](https://docs.stripe.com/connect/webhooks) and [endpoint-specific signature secrets](https://docs.stripe.com/webhooks/signature). Both destinations may use `/api/billing/webhook`; no auth exemption or additional URL is needed.

## R01 saved methods and receipts

- Production adapter: `packages/billing/src/stripe.ts`. Session-only API: `apps/api/src/billing.ts`.
- GET `/api/billing/payment-methods?after=pm_...`: availability, reason, versioned consent, masked card list/default, pagination, and persisted pending operation retry data.
- POST `/api/billing/payment-methods/setup`: `{consentAccepted:true,consentVersion:<GET consent.version>}` plus `Idempotency-Key`. Returns a Stripe-hosted setup Checkout URL, ID and expiry. Card entry happens only at Stripe; this creates no charge or wallet credit.
- POST `/api/billing/payment-methods/:id/default` and `/remove`: strict empty JSON body plus `Idempotency-Key`. Stripe customer ownership, method ownership and mode checked before mutations. Default is Stripe's invoice-settings default; hosted Checkout may choose its own saved-card presentation order.
- GET `/api/billing/receipts?after=<topup UUID>` returns only the buyer's paid/refunded/disputed Stripe-backed purchases; GET `/api/billing/receipts/:id` verifies the current customer, PaymentIntent and charge before returning a Stripe receipt URL. Fake-development credits never become provider receipts.
- Consent/intent precede provider I/O. Mutations have stable provider idempotency keys. Uncertain operations block unrelated changes and return a persisted key/action for retry. Operations older than 20 hours require operator reconciliation rather than unsafe blind recreation. No automatic off-session debit or auto-topup is implemented.
- The setup return URL is not payment evidence. Signed setup completion is audited but never credited as a payment. API keys do not authorize billing-profile access; session, suspension, ownership and cross-site guards apply.

Saved-method evidence: 32 adapter tests and 12 PostgreSQL/API integration tests passed as part of the combined run below. The integration suites use actual isolated local PostgreSQL schemas; Stripe SDK boundaries are explicitly synthetic. Both billing package and API typechecks now pass.

Operator no-charge Stripe test (not run here):

```sh
KIVRO_STRIPE_SAVED_METHODS=1 node --env-file=.env node_modules/vitest/vitest.mjs run packages/billing/src/stripe-provider.integration.test.ts
```

Requires a dedicated `sk_test_` key. The probe rejects live keys, creates a synthetic customer, a hosted setup session, and a confirmed SetupIntent using Stripe's official test token. It lists/defaults/removes the saved method, checks there are no charges, expires its session and deletes its own customer. It does not prove browser card entry, 3DS, delivered webhooks or a real paid receipt. Those remain credentialed acceptance work.

An existing test purchase can additionally be verified without a new charge: set `KIVRO_STRIPE_RECEIPTS=1` and `KIVRO_STRIPE_RECEIPT_CUSTOMER`, `KIVRO_STRIPE_RECEIPT_BUYER`, `KIVRO_STRIPE_RECEIPT_TOPUP`, `KIVRO_STRIPE_RECEIPT_INTENT`, `KIVRO_STRIPE_RECEIPT_AMOUNT` to the purchase's actual Kivro/Stripe identifiers and original USD minor-unit amount, then run the same test file with `node --env-file=.env node_modules/vitest/vitest.mjs run packages/billing/src/stripe-provider.integration.test.ts`. This optional probe only reads the existing customer/intent/charge and verifies the receipt URL; it is not run here and does not prove browser/API ownership guards beyond the separately executed integration tests.

## R13 payout lifecycle

The signed payout webhook is a notification, not a balance mutation. It persists only a bound seller/account/payout reference before a bounded provider read, then fetches the current payout with the `Stripe-Account` scope. Old or duplicate webhook payloads cannot overwrite the latest provider state. A paid payout can later fail, as documented by [Stripe's payout object](https://docs.stripe.com/api/payouts/object); totals follow the current state, not terminal-state ranking. Platform payout events and unknown connected accounts are ignored. Connected-account charge/Checkout/dispute events cannot credit or mutate platform payments.

`reconcilePayouts(ctx)` processes at most two pending events and one seller scan per invocation. Each seller scan refreshes the newest 20 records and advances a durable second 20-record cursor through history. It repeatedly revisits older records, including paid payouts, and works for suspended/not-ready sellers too. Provider reads use 3-second request timeouts and no automatic retries. An account lease fences stale responses; no DB transaction spans provider I/O. Failed reads retain durable retry state and a safe error code. All work is read-only at Stripe; there is no payout creation/withdrawal endpoint.

Additive earnings fields: `transferredMinor`; `payoutSummary:{available,reason,currency:'USD',accountWide:true,paidOutMinor,pendingMinor,failedMinor,canceledMinor,lastSyncedAt,historyComplete,lastError}`; `payouts`, `payoutsHasMore`, `payoutsNextCursor`. GET `/api/seller/payouts?after=<record UUID>` returns `{available,reason,items,hasMore,nextCursor}`. Rows expose only `id,amountMinor,currency,status,providerCreatedAt,arrivalDate,paidAt,failureCode,lastSyncedAt`. Account IDs, bank destinations, descriptions and failure messages are not returned. Cursors and every row are seller/account/mode scoped.

`arrivalDate` is Stripe's expected bank arrival, not guaranteed receipt time. `paidAt` is when Kivro first observed the currently paid status, not an invented bank settlement timestamp; it clears if that payout later fails. Payout sums are connected-account-wide, not attributable to an individual Kivro job, and may include other sources. The USD summary does not convert other currencies; individual rows preserve their actual currency. Negative or out-of-range provider payouts fail closed and require review rather than silently corrupting totals. `historyComplete:false` identifies incomplete initial backfill; stale/error data must not be presented as a freshly verified full total.

Earlier combined verification on 2026-10-06: **102 passed, 3 real-provider probes skipped**. This includes 13 real PostgreSQL/API payout integration tests, 21 payout adapter tests, 32 saved-method adapter tests, 12 saved-method PostgreSQL/API integration tests, 9 existing billing regression tests, 13 existing dispute regression tests and 2 ledger unit tests. The integration suites use the real migrated schema, production API/adapter/reconciliation code and signed event verification, with explicitly synthetic Stripe SDK responses. Billing package typecheck, API typecheck and scoped ESLint passed. No real Stripe calls, charged requests, browser payout acceptance or bank outcomes are claimed. Curie owns UI integration and has the DTO contract.

Reproduce the bounded verification:

```sh
KIVRO_INTEGRATION=1 pnpm exec vitest run packages/billing apps/api/test/payouts.integration.test.ts apps/api/test/payment-methods.integration.test.ts apps/api/test/billing.integration.test.ts apps/api/test/disputes.integration.test.ts
pnpm exec tsc --noEmit -p packages/billing/tsconfig.json
pnpm exec tsc --noEmit -p apps/api/tsconfig.json
```

The database tests require development PostgreSQL at `127.0.0.1:55432/kivro`, create randomly named isolated schemas, apply real migrations, and drop only those schemas on completion. No personal Worker, OpenClaw or provider configuration is changed.

## Requirement evidence boundary

| Requirement | Evidence and remaining boundary |
| --- | --- |
| PAY-0024 | Versioned explicit saved-card reuse consent is durably recorded before hosted setup; unit/API tests verify rejection without current consent. Real hosted browser/3DS acceptance remains unrun. |
| PAY-0025 | No PAN, CVC, bank destinations or Stripe card fingerprints are stored by saved-method/payout flows. Provider IDs and safe operation/consent/status evidence are persisted; masked cards are projected transiently. Tested API projection/ownership. |
| PAY-0026 | Buyer API supports saved methods, default/removal, receipt listing and verified receipt links. UI is owned by Curie; this package/API evidence alone does not certify complete buyer UI acceptance. |
| PAY-0029 | Payout integration tests distinguish earned/Connect-transferred/actually provider-paid amounts; duplicate, out-of-order and paid-to-failed events change only payout records/audit, never job settlement, ledger or transfer creation. |
| PAY-0042 | Payout-specific bounded maintenance/backfill/retry is implemented and tested, and the parent wired the scheduler hook. This does not certify every provider-versus-ledger reconciliation required by section 24. |
| PAY-0001 / PAY-0074 | Partial section evidence only: saved methods/receipts and account-wide payout data are implemented and locally tested. Full payment acceptance needs real Stripe test credentials/events/browser evidence; full seller economics dashboard extends beyond this owned API scope. |

Read-only operator payout probe (not run here):

```sh
KIVRO_STRIPE_PAYOUTS=1 KIVRO_STRIPE_PAYOUT_ACCOUNT=acct_TEST_ACCOUNT KIVRO_STRIPE_PAYOUT_SELLER=EXISTING_SELLER_ID KIVRO_STRIPE_PAYOUT_ID=po_EXISTING_TEST_PAYOUT node --env-file=.env node_modules/vitest/vitest.mjs run packages/billing/src/stripe-provider.integration.test.ts
```

Use an existing dedicated test Connect account created by Kivro, whose `metadata.kivroUserId` equals the supplied seller ID. This probe only reads ownership/list/current payout using real Stripe APIs; it cannot create charges, transfers or payouts. It is not evidence that Connect webhooks reached the API. Subscribe the configured Stripe destination to connected-account `payout.created`, `payout.updated`, `payout.paid`, `payout.failed`, and `payout.canceled`; connect the actual destination's signing secret to the API. Replay existing **test** events and verify durable records, current status and unchanged ledger before claiming full lifecycle acceptance. Do not manufacture a passed webhook proof with CLI trigger data or substitute unit fixtures for provider acceptance.

## Durable hold closeout

Historical durable-hold receipt, 2026-10-06 at 12:26 Europe/Zurich: **53 passed, zero skipped or failed**. Breakdown: 29 new `billing-containment.integration.test.ts` cases, 13 dispute integration cases, 9 billing integration cases, 2 ledger unit cases. API typecheck and ESLint on the two modified production files and new test file passed. This receipt superseded the initial failed balance-assertion attempt, but did NOT prove R08-F2/F3: its damaged reservation was larger than the healthy pool, and it did not repeat a debt balance after an increased cumulative refund. The later provenance/monotonic-collection receipt below closes those specific gaps. Reservation transfers are checked using offsetting available/reserved deltas; funding, settlement, refund receivable and debt recovery use zero-sum amounts.

```sh
KIVRO_INTEGRATION=1 STRIPE_SECRET_KEY='' pnpm exec vitest run apps/api/test/billing-containment.integration.test.ts apps/api/test/disputes.integration.test.ts apps/api/test/billing.integration.test.ts packages/billing/src/ledger.test.ts
pnpm --filter @kivro/api typecheck
pnpm exec eslint apps/api/src/billing.ts apps/api/src/disputes.ts apps/api/test/billing-containment.integration.test.ts
```

The new suite applies real migrations in a temporary `billing_containment_<random>` schema on local PostgreSQL 55432, uses synthetic SDK-signed Stripe events, does not load personal `.env`, and drops its own schema. No Stripe network calls, paid requests, dev-server restarts or builds were performed. Existing billing/dispute regression suites retain their own documented synthetic-fixture behavior.

- Canonical refund charge/payment/topup/owner/mode/currency/original amount and integer cumulative bounds are checked before containment. Conflicting references cannot select an arbitrary topup through an OR query.
- Dispute and refund-shortfall transactions commit suspension, session/API-key revocation, immutable execution revocation, asset-grant removal, cancellation commands, event receipts and audits before reservation release. The same suspended account is contained as buyer and seller; unrelated buyers are not suspended.
- Per-job releases are isolated. Damaged reservations stay revoked with durable recovery evidence; healthy reservations release exactly once. No balance is invented to make corrupted jobs appear repaired.
- Existing balanced refund receivables account for unavailable funds. Account-serialized debt collection commits partial progress and never automatically restores a suspended account. Manual review remains necessary even after debt reaches zero.
- Refund/checkout receipts retain their payment reference and topup/user binding. Duplicate deliveries resume cleanup from committed evidence, not changed replay bodies. Disputes use their durable case binding. Effects are returned from the successful serializable transaction, not accumulated across aborted attempts.
- Named cases include `restart and altered duplicate resume only the committed refund after a real post-commit database failure`, `%s duplicate resumes an interrupted healthy release after restart using its durable receipt`, and `a database serialization retry commits one set of effects, never effects from the aborted attempt`. PostgreSQL triggers inject the release/collection failures and a deferred SQLSTATE 40001 commit failure; these are not mocked financial transactions.

Only `apps/api/src/disputes.ts`, the webhook/refund portion and supporting helper in `apps/api/src/billing.ts`, and the new test were changed for this closeout. No changes were made to schema, `jobs.ts`, or `job-containment.ts`. The parent's separate corrupted-terminal-reservation recovery work is not attributed to this receipt. Independent review is separate evidence and was still underway when this receipt was recorded.

## R08-F2/F3 provenance and monotonic recovery

Final focused receipt, 2026-10-06 at 12:55:51 Europe/Zurich: **139 passed, zero failed/skipped**, ten files, 7.56 seconds. Breakdown: 37 new ledger-provenance cases; 40 billing-containment cases (11 added); 13 dispute, 9 billing, 4 existing ledger concurrency, 20 protocol, 7 currency, 6 containment, 1 background and 2 ledger unit tests. Billing and API typechecks and scoped ESLint passed. An earlier API typecheck encountered unrelated `agent.ts:176` errors; the final rerun was green after that shared-tree issue was resolved. The initial new test was moved from the billing package to the API test package, which already declares its contracts dependency, before this final passing run.

```sh
KIVRO_INTEGRATION=1 STRIPE_SECRET_KEY='' pnpm exec vitest run apps/api/test/ledger-provenance.integration.test.ts apps/api/test/billing-containment.integration.test.ts apps/api/test/disputes.integration.test.ts apps/api/test/billing.integration.test.ts packages/billing/src/ledger.test.ts tests/integration/ledger.test.ts apps/api/test/protocol.integration.test.ts tests/integration/financial-currency.test.ts apps/api/test/containment.integration.test.ts apps/api/test/background.integration.test.ts
pnpm --filter @kivro/api --filter @kivro/billing typecheck
pnpm exec eslint packages/billing/src/ledger.ts apps/api/test/ledger-provenance.integration.test.ts apps/api/test/billing-containment.integration.test.ts
```

- `reserveJob`, `releaseJob`, `settleJob` and `refundJob` lock/reload the persisted job. Caller-supplied stale/changed amounts cannot choose wallet identities or amounts. A shared bounded history query checks canonical operation keys, exact job/buyer/seller binding, USD, amounts and all wallet deltas. Release/settlement need one unconsumed reserve; refund needs that reserve plus one balanced capture/earning/fee transaction. Extra, missing, malformed or already-consumed history fails closed before wallet mutation. Financial replay still has one effect.
- Equal 99-cent and smaller damaged reservations cannot spend the healthy job's pool. Signed dispute/refund tests cover both UUID orderings, concurrent initial delivery/replay and independent healthy release with durable damage recovery. Settlement and refund tests also cover both concurrent orderings; refund cannot borrow another job's pooled spent/earned funds. These tests inject damaged history only into isolated synthetic schemas; production code never invents missing provenance.
- Debt collection takes the account and topup locks, reloads debt and derives its key from the sum of immutable prior `REFUND_DEBT_COLLECTION` amounts: `topup:<id>:debt-collected:<cumulativeCollectedMinor>`. Progress is monotonic even when debt returns to 499 after the provider refund rises from 499 to 998. Single/partial/legacy variants test concurrent old/new event replay and app restart, unchanged old keys, exactly 998 collected in balanced recovery pairs, zero final debt and continued suspension. No unique constraint is removed or ignored.
- Changed source: `packages/billing/src/ledger.ts` only. Changed tests: `apps/api/test/billing-containment.integration.test.ts` and new `apps/api/test/ledger-provenance.integration.test.ts`. No schema, `jobs.ts`, containment helper, protocol/currency test or production Stripe API edits. Parent migration 019 and the other owner's new protocol tests were exercised, not authored here. No schema additions are required for R08.

The new suites use real PostgreSQL 55432 and randomly named disposable schemas; signed Stripe payloads are explicit synthetic SDK fixtures. Existing protocol tests also use localhost S3. No real Stripe request, charge, browser acceptance, dev restart or build is claimed. This is a bounded regression receipt, not all financial-family acceptance.

## R01-F1 canonical provider reconciliation

Final focused receipt, **2026-10-06 13:18:40 Europe/Zurich: 155 passed, zero failed/skipped**, eight files, 27.50 seconds. This includes **29 new canonical-recovery cases** using actual PostgreSQL and the real pinned Stripe SDK over an explicitly synthetic loopback HTTP server, plus 40 containment, 37 provenance, 13 dispute, 9 billing, 13 payout, 12 saved-method and 2 ledger unit cases. Billing/API typechecks and scoped ESLint passed. Initial fixture-constructor/module-resolution failures were corrected before this receipt; no failed fixture run is presented as acceptance. The parent's earlier 411-test receipt included an intermediate 26-case version, not these final 29 cases.

```sh
KIVRO_INTEGRATION=1 STRIPE_SECRET_KEY='' pnpm exec vitest run apps/api/test/payment-reconciliation.integration.test.ts apps/api/test/billing-containment.integration.test.ts apps/api/test/ledger-provenance.integration.test.ts apps/api/test/billing.integration.test.ts apps/api/test/disputes.integration.test.ts apps/api/test/payouts.integration.test.ts apps/api/test/payment-methods.integration.test.ts packages/billing/src/ledger.test.ts
pnpm --filter @kivro/api --filter @kivro/billing typecheck
pnpm exec eslint packages/billing/src/reconciliation.ts apps/api/src/payment-reconciliation.ts apps/api/src/billing.ts apps/api/src/disputes.ts apps/api/test/payment-reconciliation.integration.test.ts
```

### Source and integration contract

- `apps/api/src/payment-reconciliation.ts` exports `reconcilePayments(ctx: ApiContext): Promise<void>`. `background.ts` registers it as the independent `payments` maintenance task alongside existing transfer-intent recovery and payout scans. It runs only with configured Stripe billing and `paymentMode === 'stripe'`. Existing pending-transfer writes and payout logic remain separate.
- `packages/billing/src/reconciliation.ts`, exported by the package index, provides `readCheckoutPage`, `readTopup`, `readCompletedTransfer`, `RECONCILIATION_PAGE_SIZE` and `RECONCILIATION_READ_OPTIONS`. All calls are authenticated platform-account GETs using the existing pinned SDK. Production has no alternate provider-host switch; the test alone redirects its SDK client to its own loopback listener.
- `billing.ts` extracts the existing transactional handler into internal `applyBillingObservation(tx, observation)` and post-commit `finishBillingObservation(ctx, effects)`. Public webhooks still require signature/mode/account verification before that handler. Canonical reads validate the complete session/customer/intent/charge binding first; they use explicit `canonical:*` receipt IDs, not invented Stripe event IDs or forged webhook signatures.
- `disputes.ts` adds `reconcileCanonicalDispute`. A provider object proves current status, not closure/withdrawal/reinstatement event chronology. Existing genuine event clocks are preserved; unknown terminal cases stay held without fabricated closure/reinstatement. Accounts never auto-unsuspend. `restoreBillingAccount` also rejects unresolved canonical-payment review flags.

### Bounds and recovery behavior

- A mode-scoped durable `PlatformSetting` lease lasts 120 seconds. Every financial/progress transaction checks its token under the same advisory lock. Expired/replaced work cannot commit stale observations or clear a newer lease. No database transaction spans provider HTTP I/O.
- One invocation reads at most two Checkout pages of ten objects (fresh head plus durable historical cursor), considers at most twenty candidates per local family, probes at most two known topups, and probes at most one completed/review-held transfer. A topup reads at most two dispute pages of ten while maintaining its own history cursor. First credit waits for completion of its initial dispute scan.
- Each HTTP call has a three-second timeout and zero SDK retries. The maximum is fifteen sequential provider reads per invocation, including unexpanded-charge fallback; no provider writes are made by this reconciler. Security containment and ledger cleanup retain their existing per-account/per-job work, so this is a provider-read bound, not a claim of constant-time database fanout.
- Candidate cursors advance past failed/not-yet-due work, persisted retry delays back off from fifteen seconds to one hour, and expired provider cursors reset without interpreting a failed page as an empty financial history. Successful discovery clears its prior error. An API restart retains progress and exact-once effects.
- Checkout discovery recovers missing local session/customer IDs after a lost create response, then requires ownership, mode, amount, currency, metadata and canonical successful intent/charge validation before credit. Conflicting paid sessions create a sticky review hold, not an arbitrary winner. Unpaid Checkout is never credited or marked paid. A webhook cannot bypass an unresolved pre-credit hold.
- Lost cumulative refunds use the same balanced ledger, durable containment and post-commit release/debt recovery as webhooks. Known refund/dispute observations and first credit commit atomically. Regressed refund evidence creates review rather than restoring credits. A real SQL-trigger failure proves restart/replay can complete cleanup without duplicate credit/refund/release/collection.
- Already-TRANSFERRED and REVERSED records are revisited. Canonical owner/job/group/mode/currency/amount mismatches or unexpected full/partial reversals move the intent to `NEEDS_RECONCILIATION` with audit evidence; no new transfer, buyer refund, seller earning or ledger capture is invented. Success and error paths both fence against a concurrent refund changing the transfer to `REVERSAL_PENDING`.

### Evidence boundary

The new suite creates an isolated `payment_reconcile_<random>` schema per case, applies the current migrations, uses only synthetic identities and a dedicated fixture key, and drops only its own schemas. Its HTTP server permits dedicated-key GETs only. Assertions cover paging beyond the newest Checkout page and the twenty-row candidate boundary; concurrent lease claims/replacement; a real three-second timeout; malformed pages/cursor loss; ambiguous identities; missing refund/dispute notifications; preservation of genuine dispute event clocks; stale valid/invalid transfer reads; API restart; and post-commit recovery.

No schema/migration changes, production Stripe writes, real-provider acceptance, charged requests, main-server restart, Next start, CORS edits or build were performed. The parent's concurrent job-timing changes in `background.ts` were preserved. Topup review flags and financial ambiguity holds are deliberately sticky: this bounded patch adds no automatic clearing or general manual-resolution endpoint for those new cases. Operator investigation remains required; absence of dispute closure/reinstatement evidence must not become permission to restore an account. PAY-0042 now has the missing recovery families implemented and locally exercised, not a claim of full live/test Stripe operational acceptance.

The provider paging and comparison semantics follow Stripe's [Checkout Session list](https://docs.stripe.com/api/checkout/sessions/list), [dispute list](https://docs.stripe.com/api/disputes/list) and [Transfer object](https://docs.stripe.com/api/transfers/object), checked against the installed SDK types. Real dedicated Stripe-test-account validation remains a separate operator step when credentials are supplied.

## Clause-level financial trace

`docs/coverage-billing.json` is a proposed parent-merge sidecar, not an edit to the central matrix. It contains 109 PAY rows: every one of the 71 PAY rows still TODO at audit start, the other section-24 rows, and related financial sections. PAY-0081 through PAY-0083 remain exclusively in the other owner's `docs/coverage-shared.json`; that file was read but not edited. Read authority: the entire Master section 24 and full sections 87, 142, 232, 282, 288-290, 293, 296, 324, 345, 460 and 540, plus each corresponding catalog clause. Catalog lead-ins are evaluated with their full following list, not as isolated sentences.

Status rules: TESTED denotes the literal bounded clause supported by named assertions, with synthetic/provider boundaries stated; IMPLEMENTED denotes confirmed source without complete clause-specific verification; IN_PROGRESS denotes aggregate partial coverage or real missing implementation; BLOCKED is reserved here for explicitly required external legal/business review. Empty test fields mean no qualifying test, not an invented acceptance. Conservative differences from existing sidecars must be resolved by the parent; this file does not authorize blanket promotion or automatic replacement.

Confirmed gaps reported before these documentation edits:

- Direct per-job PaymentIntent create/authorize/manual-capture/cancel and authorization-expiry scheduling are absent, but this is explicitly FUTURE architecture: 24.25 P5 says after credits work and 24.27 says then add direct authorization/capture after the private-beta credits flow. It is not a present private-beta blocker. Hosted credit Checkout does not prove that future branch.
- Tax/processing presentation and snapshot work is being handled separately by the parent under section 288. Final tax applicability requires legal review; do not invent a mandatory tax provider or claim that fixture evidence settles legal obligations.
- The earlier R01-F1 recovery-family gap is now implemented by the canonical reconciliation above: Checkout discovery, topup/refund/dispute reads and already-completed transfer comparison join existing intent/payout recovery. Its final 29 network/database cases passed within the 155-test receipt. Actual Stripe-account operational acceptance remains unrun.
- The seller earnings page lacks jobs-today/total, estimated provider cost, failure-rate and average-runtime metrics required by section 87. Core balances/transfers/account-wide payouts are present.
- The earlier currency gap is now closed by the parent's migration 019: Wallet, Topup, SellerTransfer, Job and AbuseBucket store USD explicitly with database checks; PayoutRecord preserves provider currencies. Its seven DB tests passed in the R08 receipt. Section 24.20 still needs semantic mapping of the existing equivalent records; an absent separately named PaymentTransaction table does not itself prove missing financial behavior.
- The earlier insufficient-wallet/API-key test gap is now closed by the other owner's four protocol cases: balances 0/98 reject a 99-cent job without dispatch or persisted financial/capacity effects; real funding then enables one reserve and cancellation release. Those tests passed in the R08 receipt. Real provider/browser acceptance remains unrun independently.

Additional documentation-audit verification on 2026-10-06 at 12:33 Europe/Zurich: **185 offline unit tests passed, 3 real-provider probes explicitly skipped**. This does not replace or expand the 53-test database containment receipt and is not a browser or Stripe acceptance run:

```sh
KIVRO_STRIPE_SAVED_METHODS=0 KIVRO_STRIPE_RECEIPTS=0 KIVRO_STRIPE_PAYOUTS=0 pnpm exec vitest run packages/billing packages/contracts/src/contracts.test.ts packages/marketplace-agent/test/orchestration.test.ts packages/marketplace-agent/test/execution-security.test.ts packages/marketplace-agent/test/repair.test.ts apps/web/tests/payouts.test.ts apps/web/tests/checkout.test.ts apps/web/tests/versions.test.ts apps/api/test/config.test.ts
```

Other named database/browser tests in the sidecar were source-inspected; earlier actual receipts are identified where available. No new production source work, provider acceptance, schema change or central coverage edit was performed for this trace.
