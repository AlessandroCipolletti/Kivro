# Independent Requirements and Security Audit

Status: BOUNDED R24 REAUDIT, 2026-10-06. The superseding checkpoint below distinguishes newly verified repairs from historical reproductions. Whole-MVP acceptance remains incomplete. This is not release approval.

Audit scope: read the full Master Spec, independently check integration contracts,
then re-audit implementation and verification evidence after owners finish.
The current audit phase owns only this file and `docs/REMAINING-REQUIREMENTS.md`.
The separately authorized R17 operations implementation phase is complete; its
own tests are implementation evidence, not independent self-certification.
Evidence below identifies the tested snapshot; later source changes require
their own verification.

## Current R24 Checkpoint

### Superseding Parent Checkpoint, 13:24 CEST

R01-F1's missing canonical-recovery families are now implemented in
`apps/api/src/payment-reconciliation.ts` and
`packages/billing/src/reconciliation.ts`, with the existing transactional ledger
and post-commit containment paths reused. Parent independently source-reviewed
the final batch and ran:

```sh
KIVRO_INTEGRATION=1 STRIPE_SECRET_KEY='' pnpm exec vitest run apps/api/test/payment-reconciliation.integration.test.ts
```

Result: **29 passed**, actual isolated PostgreSQL and the pinned Stripe SDK over
a synthetic loopback GET-only provider. The bounded assertions include missing
Checkout/refund/dispute notifications, durable page/retry/lease progression,
identity/mode/amount validation, genuine event-clock preservation, atomic
credit/refund containment, restart/replay and concurrent completed-transfer
fencing. No blocking defect was found in the reviewed scope. This closes the
named absent-code finding, not operational acceptance with a real Stripe account
or all ambiguous financial histories. Ambiguities remain held for investigation.
Owner's larger 155-case receipt and detailed limits are in `BILLING-STATUS.md`.

Parent financial-model/currency migrations 019/020 and pause/history migrations
021/022 are also integrated, bringing the repository to 23 migrations. Their
scoped evidence is in `LOCAL-VERIFICATION.md`. Active Worker pause, scheduler,
seller-capacity and availability-analytics batches are not certified by this
checkpoint. Findings and line numbers below are retained as historical evidence;
an older missing-code statement is not a claim about the repaired snapshot.

The companion inventory now has a superseding R01-R24 table and a clause-level
evidence-remap plan. Earlier missing-code statements are historical, particularly
saved methods/payouts, file formats, example-file APIs, operator controls, runbook,
health transitions, provider-routing audit and operations reporting. Their
presence does not by itself certify every requirement in their source sections.

### Superseding R08-F2/F3 Verification, 13:04 CEST

Both named defects below are **closed for the reviewed repairs and regression
scope**, not still-open findings against the current snapshot. Historical
reproductions are retained unchanged. The auditor independently source-reviewed
`packages/billing/src/ledger.ts`, `apps/api/src/billing.ts`,
`apps/api/src/disputes.ts` and both regression suites, then ran:

```sh
KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/ledger-provenance.integration.test.ts apps/api/test/billing-containment.integration.test.ts --no-cache
```

**2026-10-06, start 13:04:20 CEST / 11:04:20 UTC: exit 0, 77 passed**
(37 ledger-provenance, 40 billing-containment). These are actual isolated
PostgreSQL tests with synthetic signed Stripe events, not live-provider proof.
R08-F2 now checks exact job-bound reservation/settlement history before release,
settlement and refund, locks and rereads persisted job amounts, and quarantines
missing, conflicting or consumed history without taking another job's funds.
The equal/smaller-price cases cover both orders and concurrent replay. R08-F3
now derives collection identity from immutable cumulative collection history,
including legacy entries; the recurring 499-cent debt, partial funding,
restart and concurrent/stale replay cases no longer collide. No new blocking
defect was found in this bounded review. This is not blanket financial or
whole-section certification; the parent's separate 13:24 R01-F1 checkpoint above
remains unchanged and independently attributed.

Current operations scope: a separately authorized section354 implementation
batch owns `operations.ts`, `capacity-telemetry.ts`, its tests and operations
documentation/sidecar. Its 27-test owner receipt is not independent evidence.
Parent reports a separate readthrough and **44/44 PASS at 13:31:02 CEST /
11:31:02 UTC, 2026-10-06**: capacity identity units3, capacity DB14, operations
units10 and existing operations DB17. Parent found no blocker in the bounded
sampler, ownership, unknown attribution, retention, median and rejection-ID
scope. Helper/operations/tests are frozen for integration. Actual createJob
rejection instrumentation and independent background registration remain
Feynman-owned: he now reports both hooks landed, with their actual-purchase
regressions still in progress and not verified by this checkpoint. Curie's
additive UI is a separate batch. Section354 remains
PARTIAL/IN_PROGRESS, not independently self-certified by its implementation
owner and not covered by unrelated aggregate browser receipts.

### Billing Handoff: Two Open P1 Recovery Defects

Ramanujan's ready batch was independently source-reviewed through its ledger
callees and rerun at **10:29:59 UTC / 12:29:59 CEST**, exit 0:

```text
KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/billing-containment.integration.test.ts apps/api/test/disputes.integration.test.ts apps/api/test/billing.integration.test.ts packages/billing/src/ledger.test.ts --no-cache
53 PASS: billing containment 29, disputes 13, billing 9, ledger units 2.
```

This verifies the named fixture assertions, not all financial failure states.
The DB tests use real isolated PostgreSQL and synthetic signed Stripe events;
there was no real Stripe/provider call. Source now commits account/session/key
holds, immutable execution denial and receipt before releasing jobs:
`disputes.ts:34-58`, `billing.ts:434-444,462-472`. Replays derive follow-up work
from the stored receipt at `billing.ts:252-278,375-377`, not a changed duplicate
delivery body. Independent release transactions retain recovery holds, and a
mere remaining refund shortfall does not roll back available partial collection.
Dispute closure still does not automatically restore a separately held account.
The original same-transaction job-release rollback concern is closed for these
reviewed paths. The following failures prevent closing financial isolation and
recovery overall; neither needs external credentials to repair or verify.

#### P1 R08-F2: Pooled Reservation Can Release an Unfunded Job

**PARTIAL, reproduced incorrect behavior.** `packages/billing/src/ledger.ts:113-123`
checks only RESERVED state and the buyer's pooled reserved balance. It does not
establish that this job has its own valid JOB_RESERVE. The new follow-up selects
contained jobs in ID order (`apps/api/src/billing.ts:276-278`). A malformed job
can therefore consume a healthy job's reservation before that healthy job is
processed. The supplied damaged fixture uses USD_999 versus healthy USD_99
(`billing-containment.integration.test.ts:55-61`), so insufficient pooled funds
hide this ordering case.

Independent actual-webhook probe at **10:31:25 UTC / 12:31:25 CEST**, exit 0:

1. Credit a synthetic buyer 1,000 cents through the signed checkout webhook.
2. Create two PAUSED/RESERVED USD_99 jobs for that buyer with accepted attempts.
   Give the damaged job a `00000000-0000-4000-8000-...` ID and no reserve ledger
   entry; give the healthy job a `ffffffff-ffff-4fff-8fff-...` ID and call the
   real reserveJob for its 99 cents. The wallet has exactly 99 reserved cents.
3. Deliver a valid signed dispute-created event. Repeat the whole fixture with
   a separate buyer and a full charge-refunded event instead.

Both requests return HTTP 200 and persist security containment, but both produce:

| Job | Financial history/result | Recovery record |
|---|---|---|
| Damaged, processed first | JOB_RESERVE count 0; JOB_RELEASE count 1; CANCELLED/RELEASED | None |
| Healthy | JOB_RESERVE count 1; JOB_RELEASE count 0; PAUSED/RESERVED | LEDGER_INVARIANT, attempts 1 |

The wallet's reserved balance is now zero. This is not a claim that normal
purchase creates the malformed job; it is a reproduced failure of the explicitly
required quarantine behavior under the same damaged-state model as the new
tests. Authenticate exact per-job reserve provenance and conflicting financial
history before release; quarantine the malformed job without consuming another
job's funds. Regress equal/smaller damaged prices and both processing orders.
The similar pooled check in settleJob also warrants owner review, but settlement
of a malformed job was not independently executed by this probe. Do not fix this
by sorting jobs differently or inventing a reserve ledger entry.

#### P1 R08-F3: Repeated Debt Amount Collides Across Refund Cycles

**PARTIAL, reproduced incorrect behavior.** At
`packages/billing/src/ledger.ts:87`, collection uses
`topup:<id>:debt:<currentRemainingDebt>` as its unique operation key. Remaining
debt is not monotonic across increasing cumulative refunds. A later legitimate
cycle can reuse the same balance and collide with an earlier immutable entry.

Independent actual-webhook/ledger probe at **10:33:49 UTC / 12:33:49 CEST**, exit 0:

1. Credit a 998-cent synthetic checkout; legitimately reserve and settle two
   USD_499 jobs, leaving available balance zero.
2. Deliver cumulative refund 499. Debt becomes 499. Credit 499 fixture cents
   with a fresh funding key, then replay the same refund event: HTTP 200,
   debt zero, available zero, collection key `topup:<id>:debt:499`.
3. Deliver a different event increasing the same charge's cumulative refund
   to 998. Initial response is 200 and debt again becomes 499. Credit another
   499 fixture cents and replay this second event.

The last replay returns **409 ALREADY_EXISTS**, leaving refundAppliedMinor=998,
refundDebtMinor=499 and wallet.availableMinor=499. Only the first collection row
exists. The transaction rollback preserves funds and the security hold, but
ordinary replay cannot finish recovery despite sufficient funds. Admin restore
calls the same helper (`disputes.ts:122`), so it is not a bypass; that route was
source-traced, not separately invoked in this probe. The supplied incremental
funding case at `billing-containment.integration.test.ts:144-160` only decreases
one debt cycle and cannot encounter this collision.

Bind collection identity to durable monotonic refund/collection progress or an
equivalent unique operation revision, while retaining concurrent/replayed
exact-once balanced accounting. Regress at least two cumulative refund increases
that repeat the same debt amount, including duplicate delivery and concurrency.
Do not delete old entries or suppress the unique constraint.

Both probes were inline scripts with synthetic identities, no personal .env or
provider credentials, independently migrated random schemas and finally cleanup
of only their own schemas. No source or test files were changed. These are
additional failing adversarial evidence, not part of the 53 passing tests.
Parent was notified immediately of each result. Audit status remains open for
these two implementable defects, active Worker work and separately named
acceptance/trace queues.

### R08-F4: Staging Cookie Fix Verified

**Closed for the named cookie/config defect.** Parent added
`config.secureSessionCookies = production || webOrigin.startsWith('https://')`
after canonical URL parsing (`config.ts:21,28`), and `auth.ts:75` uses it.
No request header determines this flag; production/live-Stripe guards remain
unchanged. Independent executions, both exit 0:

- **10:49:42 UTC / 12:49:42 CEST**:
  `KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/accounts.integration.test.ts -t 'sets HTTPS staging login cookies' --no-cache`:
  1 PASS, 12 nonselected skipped. Actual login and persisted session in a fresh
  isolated PostgreSQL schema; HTTPS staging with a synthetic sk_test_ key emits
  Secure/HttpOnly/SameSite=Lax despite x-forwarded-proto=http, while local HTTP
  does not gain Secure from x-forwarded-proto=https. Schema cleanup completed.
- **10:49:54 UTC / 12:49:54 CEST**:
  `pnpm exec vitest run apps/api/test/config.test.ts --no-cache`: 37 PASS,
  including preserved production/live-key restrictions and canonical HTTPS
  cookie configuration. No Stripe network call or TLS/browser deployment proof.

Parent's full 13-account-case receipt is separately attributed, not an auditor
rerun of all 13. This closes only R08-F4, not all environment separation or
Worker environment-display acceptance. The following is the historical finding.

This is a bounded implementation-security finding, not a new literal Master
feature or a demand to provision cloud environments. Section 81 / PRD-0066
requires separate environments, keys, buckets, databases and pairing/signing
credentials; PRD-0067 requires unmistakable Worker environment display. It does
not prescribe NODE_ENV for staging, a cloud vendor or deployment automation.

`apps/api/src/config.ts:9-12` uses NODE_ENV=production OR KIVRO_ENV=production
for both production guards and the production environment label. The current
documentable Stripe-test configuration NODE_ENV=test + KIVRO_ENV=staging yields
production=false, development=false and deploymentEnvironment=staging.
This correctly disables fake payments/dev login and requires non-development
signing/encryption paths and CLEAN scanning (`config.ts:19-20`, `worker.ts:36-38`,
`webhooks.ts:27-28`, `assets.ts:46-48`, `asset-uploads.ts:96-97`). It is not a
blanket development shortcut bypass.

However, `apps/api/src/auth.ts:75` emits session cookies with
`secure: ctx.config.production`, ignoring even explicitly HTTPS origins. Setting
either production flag enables Secure but also requires a live-prefixed Stripe
key (`packages/policy-engine/src/index.ts:125-133`) and labels the endpoint
production. There is no independent cookie/security setting. A configuration
document alone cannot change the emitted cookie attribute; no external proxy
rewrite or HSTS policy was inspected or credited as mitigation.

Independent pure readConfig probe at **10:39:59 UTC / 12:39:59 CEST**, exit 0,
with synthetic keys, dedicated-looking dummy URLs and all other required fields:

| Flags/key | Observed config result | Source-defined cookie predicate |
|---|---|---|
| NODE_ENV=test, KIVRO_ENV=staging, sk_test_ | Accepted: staging, production=false, development=false | Secure=false |
| NODE_ENV=production, KIVRO_ENV=staging, sk_test_ | Rejected: production requires live credentials | No startup |
| NODE_ENV=production, KIVRO_ENV=staging, synthetic sk_live_ | Accepted: production, production=true | Secure=true |

Only readConfig was executed: no env file, database, network, provider client or
browser/cookie attack was used. The cookie behavior is direct source evidence,
not an independently observed Set-Cookie response. A narrow fix should allow
secure hosted-staging sessions without weakening production safety or forcing
live payments. Do not broaden this into a new deployment subsystem.

Separate DB/bucket/key selection can be an explicit deployment contract and
runbook, with actual separation left UNTESTED until evidenced; no current source
proof establishes shared staging/production resources. Parent's diagnostics/v2
sellerId and deploymentEnvironment fields are source-present at `worker.ts:181`;
its 51-case receipt is parent-attributed. Laplace's display client is active and
not independently ready-audited here. NODE_ENV precedence itself is a documented
convention, not an additional absent-feature finding.

### R07: Controlled DAG Receipt Reviewed

The previous waiting-for-reconciler-handoff statement is superseded by
`docs/E2E-ORCHESTRATION-CONTROLLED-RECEIPT.json`. Bohr's fixture
`c4db5210-131e-44f5-af79-f7a6124b7bf8` completed at
**10:23:46.833 UTC / 12:23:46.833 CEST**, exit 0. The auditor read the receipt
and corresponding script assertions; no duplicate runtime run was performed.

Owner-attributed evidence: 19 applied migrations, four successful/settled plan
jobs plus four successful/settled rating warmups, two synthetic sellers/Workers,
three exact unexpired dependency grants and actual input marker reads, an owned
1,007-byte S3 PDF checked by hash and Poppler parse/text/render, explicit plan
approval, consented synthesis with four-source provenance, signed result replay
and repeated production tickPlans without duplicate jobs/capture/earning/fee.
The plan costs 396 cents within a 1,500-cent authorization; the unused 1,104
cents were never reserved/debited. Final reserved balance and fixture containers
are zero; eight publication journals are committed, no uncommitted/undeleted
publication remains, synthetic sessions are removed and financial history stays.

Source checks: `e2e-orchestration-fixture.ts:265-268` refuses foreign active plans
before calling production tickPlans; `:402-427` checks dependency ordering,
grants/read markers, actual download, PDF content/render and unauthorized access;
`:443-467` checks settlement/replay/repeated reconciliation and wallet totals;
`:503-510` checks owned Worker/capability/session/reservation cleanup.

Important boundaries: this used the shared public schema under an explicit
parent-confirmed stopped reconciler and port checks, not an isolated schema or
cross-process lock. Background reconciliation and browser flags are false;
production tickPlans was driven explicitly by the fixture. It used real pinned
Docker/OpenClaw with deterministic loopback inference, fake payments and
DEVELOPMENT_ONLY scanning. No paid provider, real Stripe, automatic BullMQ plan
dispatch, clean-machine bootstrap or complete section 92 acceptance is implied.
R07's named deterministic local DAG/PDF evidence is now present; its external
staging acceptance remains separate and unverified.

### Billing 109-Row Scope Review

Read all 109 records in `docs/coverage-billing.json` structurally, then re-read
Master 24.1-24.27, 87, 287-289, 296 and 460 and traced the current call sites.
Its counts (31 IN_PROGRESS, 53 IMPLEMENTED, 22 TESTED, 3 BLOCKED) describe that
sidecar snapshot, not 31 missing features or independent test certification.
PAY-0081-0083 are intentionally in the shared sidecar. No coverage file changed.

**Correct scope before assigning implementation:**

- PAY-0016/0017 and PAY-0021-0023 describe direct-card authorization/window/SCA
  behavior. Master 24.1 explicitly says later, 24.27 says to add it after the
  prepaid private beta, and 460 permits credits for arbitrary scheduling delays.
  These direct-card-only requirements are EXPLICIT_FUTURE for that beta, not
  required missing code. Mixed PAY-0041/0060/0063 must keep current webhook,
  secured-prepaid dispatch and refund obligations while excluding future-card
  branches; aggregate PAY-0001 is not thereby PASS. Architecture trace remains.
- PAY-0036 cites the example failure matrix in 24.11. Immediate release on the
  first offline observation is not a fixed normative algorithm. Bounded retry
  with reservation can be an explicit policy; `background.ts:58,68-72` already
  bounds/requeues expired offers. Policy disclosure remains distinct from
  inventing a mandatory immediate-release code change.
- PAY-0045/0074/0111 overstate missing seller metrics. `selling.tsx:18,31,78`
  mounts Operations in dashboard/earnings; `operations.tsx:25,50-57` renders
  failure/average runtime and estimated provider cost/coverage. This is source
  presence, not independent self-certification of the auditor-authored R17
  calculations. Parent owns adding actual UTC-today/all-time counts; Curie
  owns presentation/reuse. Do not build duplicate financial calculations.
- PAY-0003/0018/0066/0067's claimed absence of an insufficient-funds test is
  too broad. `scripts/e2e-fixture.ts:287-297` asserts actual POST jobs returns
  402 INSUFFICIENT_FUNDS, unchanged wallet/ledger response and unchanged job
  count. Its strict fault-matrix owner receipt is already recorded here. This
  does not automatically prove API-key-specific cases or a fabricated
  non-RESERVED queued job; those are separate acceptance/trace, not absent guards.
- PAY-0100's later tier administration/multi-currency operations stay future;
  current shared tier source and immutable historical amounts remain required.
  Likewise 24.18 advanced risk-delay policy is recommended, not a new mandatory
  rolling-reserve subsystem. A missing separately named PaymentTransaction
  table alone does not prove missing financial behavior: map 24.20 semantics
  to Topup/SellerTransfer/BillingEvent/LedgerEntry and identify actual lost data.

**Source-confirmed residuals, beyond the already assigned R08-F2/F3:**

| Finding / scope | Exact evidence and remaining behavior |
|---|---|
| P1 R01-F1, PAY-0042 / 24.14: PARTIAL reconciliation, missing recovery families | `background.ts:113-165` scans only PENDING/PROCESSING/REVERSAL_PENDING transfers; `:176-179` schedules transfers and payouts but no topup/refund/dispute reconciliation. Canonical intent/charge reads in `stripe.ts:127-131` only serve receipts; `billing.ts:530-578` provides manual uncertain-transfer resolution, not periodic completed-transfer comparison. Payout backfill exists and is not this omission. Lost Checkout/refund/dispute notifications and provider changes to already-TRANSFERRED records lack a periodic discovery/repair path. Implement bounded canonical reconciliation with durable progress/replay/ambiguity holds; provider credentials are needed for acceptance, not to implement/test this path. No real-provider failure was induced by this source review. |
| P2 R01-F2, PAY-0084-0088 / 288, 24.16 and PRD-0296-0299 / 287: internal financial distinctions and explicit policy | Current Job priceSnapshot/amounts (`schema.prisma:336-350`) and tier/settlement path contain retail, seller net and marketplace fee, not separate tax/buyer-total/processor-cost treatment. `types.ts:8` has an optional buyerTotalMinor but the backend does not populate it. Section 288 explicitly asks to distinguish these internally; actual VAT/GST rates, jurisdiction rules and Stripe Tax integration are conditional on the legal structure. Section 287 requires an explicit processing-fee bearer decision; the platform-absorbs recommendation is not yet an inspected explicit policy/UI contract. This is bounded modeling/policy work, not permission to fabricate tax or invoice costs. Exact example field names in 289 are not mandatory schema names. |
| P2 R01-F3, PAY-0048 / 24.19-24.20: stored-currency discrepancy | Wallet (134), Topup (587) and SellerTransfer (628) store minor-unit amounts without currency; receipts/Stripe writes assume USD in code (`billing.ts:303`, `stripe.ts:186,205`). LedgerEntry, job priceSnapshot, disputes and payout records do carry currency. Preserve this distinction: storing explicit USD is a concrete model completion, not multi-currency checkout. The 24.19 list is headed MVP recommendation; do not inflate that alone into a new P1 release blocker or assert a demonstrated cross-currency loss. Complete 24.20 field-level equivalence rather than demand a duplicate table by name. |
| Current policy/disclosure, not a new payment kernel | 24.11 requires an explicit failure/refund policy in Terms/UI; current development terms (`account-terms.ts:16`) say outcomes depend on state, the checkout explains pre-execution release and the incident runbook states pre-settlement release. That is not a full buyer-facing offline-retry/after-start policy. Final public terms, chargeback-risk allocation, jurisdictional credit/tax treatment and Connect approval remain stage-specific external review, not something this audit can certify or replace. |

The 109-row sidecar is useful atomic evidence but must not introduce omitted
future-card features as required-MVP blockers, infer missing functionality from
unnamed test combinations, or erase true provider-recovery/model gaps. The above
is source review plus already identified receipts, not a new global billing test
run, provider acceptance, legal approval or blanket promotion of section 24.

### P1 R21-F1: Pause and Execution Deadlines Disagree

**PARTIAL, confirmed cross-layer behavior conflict; lower-runtime resolution
UNTESTED.** Master 438 / JOB-0174 says the seller can resume before the allowed
pause timeout; 439 / JOB-0177 retains a reservation while pause is within that
duration. The examples do not require hours or a particular duration. Section
440 still permits safe resume failure on changed security/readiness/dependencies;
this finding does not promise that every resume must succeed.

The API implements an independent maxPauseMs (currently 15 minutes) at
`background.ts:59`, subtracts both accumulated and current pause from execution
time at `background.ts:63-65`, and records pausedDurationMs when returning to
RUNNING at `jobs.ts:45-46`. The Worker instead stores acceptance time plus
timeoutSeconds as an absolute deadline (`state.ts:56`), arms the host timer at
`runtime.ts:165-177`, and does not adjust either deadline or timer on pause/resume
(`runtime.ts:258-277`, `state.ts:72`). It can terminate a healthy PAUSED job long
before maxPauseMs with unused active execution budget. Its signed TIMED_OUT event
is accepted via `apps/api/src/worker.ts:249-250` and takes the normal fail/release
path; this payment effect is source-traced, not executed by the test below.

Independent focused execution at **10:43:43 UTC / 12:43:43 CEST**, exit 0:

```text
pnpm exec vitest run apps/worker/src/runtime.test.ts -t 'includes paused wall time' --no-cache
2 PASS, 6 nonselected cases skipped.
```

These existing cases (`runtime.test.ts:45-58`) deliberately assert the mismatch:
timeoutSeconds=30, execute 5 seconds, pause, and either remain paused for the
remaining 25 seconds or resume after 10 paused seconds. Both terminate at the
original 30-second wall deadline; the non-resumed case has only 5 running seconds
and 25 paused seconds. It tests actual WorkerRuntime/SQLite with fake time and
mock Docker/adapter/transport, not actual OpenClaw, PostgreSQL settlement or a
wall-clock wait. Passing this expectation is evidence of current behavior, not
acceptance of the Master pause requirements.

`docs/OPENCLAW_COMPATIBILITY.md:650-653` explicitly documents a wall deadline
continuing through pause. Thus this is not undocumented behavior or proven to
have been introduced by the latest host-timer fix. That local document cannot
by itself reconcile the conflicting API accounting and Master clauses.

A host-timer-only extension is not established as sufficient. The actual runner
also passes `--timeout` to OpenClaw and wraps it in timeoutSeconds+5 seconds
(`security/sandbox/runner.mjs:167-169`, timer at line 32); generated OpenClaw
config has its timeout too (`openclaw-adapter/src/policy.ts:38`). Their precise
behavior after a long Docker pause/unpause has not been independently exercised
here. Do not claim the pinned runtime will resume successfully merely because
the host timeout is changed, and do not silently extend separate research
consent/network grants or reset consumed execution budget.

Laplace is already assigned the focused runtime investigation. Closure needs
consistent host/API/runtime execution-versus-pause accounting, with bounded
max-pause expiry retained, plus an actual pinned-runtime pause spanning the
original deadline before resumption and the corresponding reservation/release
assertions. No source change, new timeout policy, Docker rerun or expanded
runtime guarantee was made by this audit.

### R08-F1: Admin and Seller-Worker Fixes Verified

The original admin rollback below is historical. Parent's migration 018 adds
immutable `Job.executionRevokedAt`; the current source separates operator
containment from financial release:

- `job-containment.ts:6-16` sets the job denial, deletes input grants, records
  EXECUTION_REVOKED and creates CANCEL_JOB in the caller's transaction. The
  null-denial filter plus serializable callers prevents repeat command creation.
- `security-policy.ts:81-102` and `billing.ts:562-572` commit that work with
  operator flags, identity/session/key revocation where applicable and audit.
  They call `releaseContainedJobs` only after commit.
- `job-containment.ts:19-27` isolates financial release per job;
  `job-recovery.ts:8-15` records the sanitized recovery hold/audit on failure.
  `jobs.ts:64` avoids duplicating the already-durable cancellation command.
- `background.ts:49` handles the immutable denial before ordinary recovery;
  `security-policy.ts:37-47` enforces buyer suspension and per-job denial on
  execution/data routes. Migration 018 rejects clearing or changing a non-null
  denial timestamp, including after capability restoration.

Independent exact three-file run at **10:05:17 UTC / 12:05:17 CEST**, exit 0:

```text
KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/containment.integration.test.ts apps/api/test/operations-policy.integration.test.ts apps/api/test/billing.integration.test.ts --no-cache
27 PASS: containment 4, operations-policy 14, billing 9.
```

The four containment cases independently cover admin capability block, admin
Worker revoke, seller-account suspension and buyer-account suspension. Each
creates a damaged PAUSED/RESERVED job and a separately funded healthy buyer's
job, repeats the action twice, and asserts one durable cancellation/event,
recovery metadata, unchanged damaged balances/no ledger entries, affected
healthy-job release exactly once (unrelated buyer job remains reserved), denied
resume/payload/result/output-ticket requests, no capture, and DB immutability.
The capability case also restores the capability and proves job resume stays
denied. Input-grant deletion and dispatch filtering are source-traced; this
four-case fixture creates no actual input grant and is not a concurrent-race or
real Worker process-kill proof. The 14 policy cases have their own boundary
assertions; their aggregate count does not extend those four fixtures.

**R08-F1-S is now closed for the seller-initiated Worker route.** Current
`apps/api/src/worker.ts:331-350` verifies seller ownership, returns early on
already-revoked devices, and calls the same containJobExecution in the transaction
with device flags, binding invalidation and audit. releaseContainedJobs runs only
after commit. The early return preserves the original revokedAt and prevents a
second PAUSE_ALL; those two precise properties and binding invalidation are
source-traced, not separately asserted by the current five-case fixture.

Independent run at **10:09:43 UTC / 12:09:43 CEST**, exit 0:

```text
KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/containment.integration.test.ts --no-cache
5 PASS: admin capability, admin Worker, seller-owned Worker, seller account, buyer account.
```

The added seller-owned case asserts outsider 404, owner replay success, durable
per-job cancellation, intact damaged hold/ledger, healthy release, denied data/
execution and immutable denial using actual isolated PostgreSQL. No Worker
process, provider, broad security-section acceptance or dispute/refund fault is
certified by these five cases.

**Sibling rollback concern superseded by the billing handoff above:** dispute
and refund paths now commit containment/receipts before per-job release. The
independent 53-case receipt verifies the named repair assertions; R08-F2/F3
remain new, reproduced ledger isolation/recovery failures. No helper, schema or
billing implementation was changed by this audit.

#### Seller-Revoke Reproduction, Superseded by the Five-Case Receipt

Before the fix, `apps/api/src/worker.ts:330-343` updated revokedAt/paused/sandboxReady,
enqueues PAUSE_ALL and invokes failJob for active jobs inside one serializable
transaction. A damaged reservation aborts the entire operation, before its
audit. This is the same containment rollback through a different actual route,
not a failure of the four repaired admin handlers.

Independent real-DB/session probe at **10:04:04 UTC / 12:04:04 CEST**:

```text
POST /api/seller/workers/<own-worker-id>/revoke
Fixture: own ready Worker, RUNNING/RESERVED USD_99 job with accepted attempt,
buyer wallet reservedMinor=0; no existing ledger entries.
HTTP 409 LEDGER_INVARIANT
worker.revokedAt=null; job.executionRevokedAt=null
job.state=RUNNING; job.paymentState=RESERVED
CANCEL_JOB count=0; ledger-entry count=0
```

The inline script used `node --import tsx --input-type=module -e`, actual Fastify
session/Origin checks, a separately migrated `audit_seller_containment_<random>`
local PostgreSQL schema, fake billing and blank provider keys. It dropped only
its fixture schema in finally. No source/test file was created or modified.
Parent was notified immediately and implemented the commit-first helper and
post-commit financial isolation now verified above. The reproduction remains
historical failure evidence, not a current open seller-route finding.

#### Original Reproduction, Superseded for Admin Routes

Independent reproduction completed 09:47:51 UTC using a random isolated schema,
real migrated PostgreSQL and actual Fastify admin handlers/session auth. Fixture:
RUNNING + RESERVED 99-cent job, accepted attempt, buyer wallet reserved balance
zero. This is the same class of operator-visible financial hold for which parent
added per-job maintenance isolation, not a claim that ordinary buying creates
the damaged balance. No provider or personal credential was used.

| Actual admin action | HTTP/error | Persisted result |
|---|---|---|
| Block capability | 409 LEDGER_INVARIANT | securityBlocked=false |
| Revoke Worker | 409 LEDGER_INVARIANT | revokedAt=null |
| Suspend account | 409 LEDGER_INVARIANT | suspendedAt=null |

All three left cancellation command count zero and ledger entry count zero.
The fixture schema was dropped after readback. An initial inline probe failed
module resolution before DB work; the corrected local-module invocation above
completed successfully and produced these results. This is a reproduced product
failure, not a passing regression test or a hypothetical source-only concern.

Required fix: security containment, its audit and identity/session/key revocation
must survive per-job financial repair failure. Issue durable cancellation without
requiring money reconciliation, isolate damaged jobs, and expose/retain their
manual recovery holds. Do not weaken ledger invariants, invent a release, delete
financial records or promise recall of already-downloaded data/offline processes.
Regress each action with one damaged plus one healthy reservation, replay and
post-action purchase/offer/start/resume/data/result denial. Source clauses:
78 JOB-0048/JOB-0049, 79 SEC-0063/0064, 371 CAP-0110-CAP-0113 and 393.
Parent and API owner were notified immediately. No source fix was made here.

The original three admin failures are closed by the specific source review and
27-case receipt above; the subsequent five-case receipt closes the seller route.
The later billing handoff closes the named dispute/refund rollback structure but
identifies R08-F2/F3. This does not certify all section 79, category-policy
cancellation, every financial hold or every Worker control path.

### Other Current Residuals

- R16: Laplace now reports a real OpenClaw smoke using one public HTTPS prefetch,
  then private snapshot read and cache-only research lookup on a separately
  built research image. That supersedes a blanket library-only/absent-wiring
  statement. The owner still names diagnostic seller identity and trusted HTTP
  cancellation dependencies; combined PostgreSQL/full-stack acceptance is not
  yet claimed. This active batch has not received an independent ready re-audit.
- R17: sanitized research accounting detail remains in Laplace's active batch;
  its omission was source-confirmed at the earlier snapshot, not freshly
  reasserted against in-progress edits here. Health/history/routing audit and
  usage reporting are source-present. Worker usage has an owner-reported
  86-case receipt; operations' 26 cases are authored implementation evidence.
- R18: safe broader configuration dependency metadata and seller-test observed
  dependency provenance remain narrower discovery gaps. Exact selected skill
  closure/import/grants already pass independently; CLI suggestions exist, and
  native GUI/personal-file scanning must not be invented as mandatory fixes.
- R15: Node/SQLite, cloud/device/clock/policy probes pass. Dedicated readable-
  config/writable-DB diagnostics are an earlier confirmed residual now being
  implemented; no ready handoff has been independently verified.
- Example-copy durability and final UI wiring are independently reviewed below;
  they are no longer absent implementations. Bohr's completed controlled R07
  receipt c4db5210 is reviewed above; the old waiting-for-handoff statement is
  superseded. Its deterministic local proof is not external paid acceptance.

One additional UI mismatch was reproduced and then fixed during this checkpoint:
worker-policy.ts rejected native anthropic despite adapter support. Curie's fix
now permits only openai-compatible/anthropic. Independent repeated direct calls
accept anthropic and reject an unknown provider; the focused eight Worker-policy
web tests pass. This closes that precise guard defect, not all provider/browser
acceptance. Three operations-display tests independently pass, including null
contribution when coverage/pricing is incomplete and negative known estimates.

### Bounded Example Publication and UI Reaudit

**No new blocking defect found in this reviewed scope.** This is not an entire
R18/section 357-368 PASS. Independent execution at **10:15:11 UTC / 12:15:11 CEST**,
exit 0:

```text
KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/example-assets.integration.test.ts apps/api/test/pending-objects.integration.test.ts apps/web/tests/examples.test.ts --no-cache
26 PASS: example API/DB/S3 15, pending-object DB/S3 6, web helpers 5.
```

- `example-assets.ts:143-203,292-323` now stages seller example copies and buyer
  reusable templates via the shared helper. `pending-objects.ts:11-26` persists
  a random object key before PUT and validates owner/key/target plus unexpired,
  unclaimed stage before commit. The new example/Asset row and pending target
  commit together. Failure records abandonment rather than deleting a possibly
  committed object blindly. Cleanup claims uncommitted objects before deletion,
  honors drain grace and cannot attach a late publication; migration 017 supplies
  exclusive target/reference constraints. Conditional PUT prevents overwriting.
- The 15 example cases cover exact per-file consent, seller ownership, draft/
  current-version access, privacy/grants/revocation, byte and metadata integrity,
  safe inline image versus attachment delivery, Range/HEAD, source expiry,
  private expiring buyer copies without purchase, CAS/three-example limit,
  manifest/contract validation and self-owned successful-output remapping.
  New assertions at `example-assets.integration.test.ts:183-262` cover pre-PUT
  intent, atomic seller/buyer target references, committed-object protection,
  before/after-PUT orphan recovery after application reconstruction and expiry
  rollback. They age only fixture timestamps to represent elapsed TTL/drain;
  they do not SIGKILL a production process or wait a real ten-minute TTL.
- `capability-versions.tsx:70` mounts SellerExamples, whose two-stage review
  (`seller-examples.tsx:50-83`) binds per-file public approval, optional input
  reuse and explicit rights to the submitted content. Self-owned-job preview,
  immutable new draft, replace and file revoke are wired to the real routes.
  `capability-detail.tsx:42,64-69` mounts buyer examples and replaces form values
  with returned owned assets while clearing any old quote/purchase approval.
  `capability-examples.tsx:43-63` calls the exact version-bound template API with
  unchecked opt-in file selection/consent and handles stale-version rejection.
  `examples.ts:8-39` restricts example URLs and checks returned file references
  and capability/version identity. The five helper cases are not browser runs.
- Curie's **6/6 browser receipt is owner-attributed**, not rerun here. Source
  review of `apps/web/e2e/examples.spec.ts` shows three cases over two viewports:
  two real API/direct-storage draft upload, review/download/approval and revoke
  runs (`:18-77`); four explicit response-fixture runs for public typed rendering/
  reusable template consent/staleness (`:79-123`) and self-owned-job preview/
  rights/409 handling (`:125-156`). The first does not publish an active listing;
  the latter four do not prove real backend copying or successful from-job
  publication through the browser. Their corresponding APIs are independently
  covered above. CI configuration/type/lint results are also Curie-attributed.

Remaining example evidence gaps are integrated real-browser current-public
template copy and successful self-owned-job promotion, plus any requested actual
process-kill acceptance beyond the persisted recovery fixtures. These are named
unverified boundaries, not missing interfaces or newly invented mandatory test
forms. No requirement/section is promoted solely from 26 or 6 passing cases.

### Independently Executed Bounded Receipts

All commands below exited 0; all log starts are Europe/Zurich CEST, converted
explicitly to UTC. No Docker rerun or live provider was performed in this phase.

```text
09:42:44 UTC / 11:42:44 CEST
KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/operations-policy.integration.test.ts apps/api/test/security-policy.test.ts packages/storage/src/media.test.ts apps/worker/src/diagnostics.test.ts apps/worker/src/service.test.ts --no-cache
68 PASS: 11 real-DB policy/retention/usage; 2 policy; 24 media; 26 diagnostics; 5 service.

09:43:01 UTC / 11:43:01 CEST
KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/payment-methods.integration.test.ts apps/api/test/payouts.integration.test.ts apps/api/test/example-assets.integration.test.ts --no-cache
37 PASS: saved methods/receipts 12, payouts 13, public example files 12.

09:45:37 UTC / 11:45:37 CEST
pnpm exec vitest run packages/openclaw-adapter/src/discovery.test.ts apps/worker/src/imports.test.ts --no-cache
24 PASS: discovery 16, selected import/consent/closure 8.

09:51:45 UTC / 11:51:45 CEST
pnpm exec vitest run apps/web/tests/worker-policy.test.ts apps/web/tests/operations.test.ts --no-cache
11 PASS: Worker compatibility 8, operations display 3.
```

Real DB/S3 assertions are distinguished from synthetic Stripe SDK/events and
signed protocol fixtures. Service tests exercise real plist conversion but mock
launchctl; they do not prove actual login/relogin. Media structure checks do not
prove every codec engine. The earlier 12 example cases did not prove orphan
recovery; the later 15-case plus six pending-object receipt above now proves the
named persisted recovery simulations, not actual process killing. The financial tests
prove their listed owner/idempotency/canonical-state/fault assertions, not real
bank/provider acceptance. No aggregate section is promoted from these totals.

Parent-attributed only: actual deterministic Docker fixture PASS 09:33 UTC;
fresh-source 17 migrations and 3001/4001 proxy PASS 09:39 UTC; self-contained
private-beta cloud packaging and isolated API health/config/web-static boot PASS
09:44 UTC. The last is not database readiness proof. Parent subsequently reports
713 unit PASS / 192 opt-in skipped at 11:56 CEST (09:56 UTC), full types/lint
PASS, PendingObject migration 017 and 11 DB/S3 tests at 11:55 CEST, then migration
018 applied (19 total) and the 27-case containment batch at 12:01 CEST. Only the
specific independently rerun cases above are auditor executions. Build/final
complete release results remain parent-owned.
Parent additionally reports 30 targeted R20/R22 cases and 16 protocol cases at
12:07 CEST (10:07 UTC), including UTC rollover, rollback, actual purchased daily
idempotency and schedule-change/notification/full-release behavior. These are
attributed targeted receipts, not this auditor's executions or evidence that all
clauses in R20/R22 pass. The new coverage-operations.json rows remain parent-owned.
Independent terminal+RESERVED guard verification at **10:24:00 UTC / 12:24:00
CEST**, exit 0: `pnpm exec vitest run apps/api/test/job-recovery.test.ts --no-cache`
reports **7 PASS**. Four cases verify failJob throws LEDGER_INVARIANT for
SUCCEEDED/FAILED/CANCELLED/TIMED_OUT with payment RESERVED before any transaction
operation; three verify the same terminal object is returned for the tested
SETTLED/RELEASED/REFUNDED replays. `jobs.ts:57-61` implements the guard;
`background.ts:48-52` routes terminal reserved jobs through it before other
recovery, and the per-job catch records the recovery error rather than clearing
it as success. That background/manual-hold persistence path was source-traced,
not exercised by these seven unit cases; the later DB case below supplies its
named persistence proof. These seven cases do not certify dispute/refund work
(reviewed separately above) or every terminal/payment-state combination.

Supplemental independent DB run at **10:27:34 UTC / 12:27:34 CEST**, exit 0:
`KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/containment.integration.test.ts --no-cache`
reports **6 PASS** in a freshly migrated isolated schema. The additional case at
`containment.integration.test.ts:41-62` creates CANCELLED/RESERVED, commits
containment, then invokes releaseContainedJobs. It asserts a persisted
LEDGER_INVARIANT marker with attempts=1; only the fixture's nextRetryAt is set to
zero before calling reconcileJobs. The second failure retains the marker with
attempts=2, immutable denial and CANCELLED/RESERVED state, unchanged zero wallet
balances, zero job ledger entries and exactly one JOB_RECOVERY_REQUIRED audit.
This closes the specifically identified persisted-background-recovery evidence
gap for that terminal state. It does not test elapsed backoff time, all four
terminal states in PostgreSQL, real BullMQ dispatch, or dispute/refund recovery.

Parent reports root browser 10 PASS, web flows 44 PASS, unit 772 PASS / 203 opt-in
skipped and build/typecheck PASS across 12:19-12:25 CEST. These remain attributed
global receipts, not independent all-MVP evidence. The clean-source-copy runtime
and browser-to-real-Worker extensions are active, not yet accepted here. Final
bounded re-audit now includes Ramanujan's ready batch and its two open findings
above; Laplace's ready handoff remains pending. Missing implementation,
unverified acceptance and unmapped trace remain separate queues.
Parent additionally reports readable desktop catalog/mobile contract-review
screens without overflow; this is not an independent visual review. Feynman's
browser/runtime fixture is being extended with real BullMQ only in a fresh
isolated schema, not the shared public schema. It remains in progress here;
no browser/queue/runtime combined acceptance is inferred before the handoff.

Feynman reports the strict actual Docker/OpenClaw fault fixture exited 0 at
10:10:01 UTC, fixture `73969acc-3ec3-41ff-8c5e-b954bf544cfa`, using
`scripts/e2e-fixture.ts --run --faults`. Seven cases cover insufficient funds,
offline runtime, missing image, buyer cancellation before start, seller running
cancellation, invalid output and a held-provider timeout. Reported timeout job
`aa6ebada-a41a-454f-806b-8a5e7407d26d` is TIMED_OUT/RELEASED, local elapsed
30,091 ms, deadline overshoot 91 ms, cloud final 30,170 ms. All four created fault
jobs report one reserve/release and no capture/earning/fee, with no owned
containers left. A subsequent successful control job
`2d04130f-b492-4971-9d67-c9c93144d814` reports exact 112-byte S3 content/hash,
balanced settlement and idempotent signed replay. This supersedes the owner's
earlier 63-second FAILED timeout failure and group-kill EPERM report.
Auditor source review confirms the expected state/release assertions and
persisted deadline plus at-most-five-second overrun at `e2e-fixture.ts:290-345`;
the execution receipt is owner-attributed, not an independent Docker rerun.
Scope remains local deterministic inference, fake payments, DEVELOPMENT_ONLY
scan and background disabled, not real inference/Stripe or browser acceptance.

### Mapping and 100% Boundary

#### Local Acceptance Is Not the External Release Gate

Bounded reread of Master 551-573 and 92 confirms the following scope correction.
It is not an automatic coverage promotion or a new whole-local-E2E PASS.

| Source / catalog row | Exact acceptance boundary |
|---|---|
| 557 / DEV-LOCAL-006 | Final local OpenClaw acceptance must use the actual supported runtime where possible, not only mocked OpenClaw responses. It does not itself require externally paid LLM inference. The real Docker/OpenClaw deterministic receipts are relevant runtime evidence; a sole missing-live-provider BLOCKED reason in coverage-local.json is overrestrictive for this row. Other unproven local legs must be named separately. |
| 563 / DEV-LOCAL-014 | The required path starts at the buyer browser and proceeds through real local Web/API, PostgreSQL, development/test payment, Redis/dispatch, host Worker, Docker/OpenClaw, output validation/storage, buyer result/download and seller ledger. The CLI/API fixture does not prove the buyer-browser leg. Separate browser response fixtures do not supply the missing integrated path. |
| 564 / DEV-LOCAL-015 and 92 | A fake development payment adapter is expressly required/allowed, but Stripe acceptance cannot rely exclusively on it. Keep the actual Stripe test/sandbox integration and global paid-staging release gate open. This does not convert every local-development requirement into an external-inference prerequisite, nor require a live-money production charge. |
| 569 / DEV-LOCAL-022 | Correlated local logs must cover the stated components for the same job. A dedicated live provider is not stated as necessary. Missing queue/correlation evidence, if any, is a trace/acceptance gap rather than a provider blocker. |
| 570 / DEV-LOCAL-023/024 | `pnpm test:e2e:local` or an equivalent command is allowed; the command must cover the enumerated local success/fault behavior. Actual OpenClaw plus controlled inference and deterministic development payments can provide local evidence. Review the named assertions, not command spelling or a live-provider-only selector. |
| 571 / DEV-LOCAL-025/026 | Verify documented-prerequisite bootstrap from a clone on a clean supported Mac through a complete buyer-to-seller job, with no manual host PostgreSQL/Redis/S3 installation. A fresh source copy on the already-configured host proves only its observed subset. A second physical Mac is not literally required; a genuinely clean supported-Mac acceptance environment is. |
| 573 / DEV-LOCAL-029 | Retain PARTIAL until its complete local DoD checklist, including full local path and verified clean-clone setup, has evidence. Completing 573 would not close the distinct global external-provider/payment gate in 92. |

Additional source boundary for the proposed browser extension:
`scripts/e2e-fixture.ts:173-178` disables background reconciliation and checks
Redis readiness; `app.ts:57,150-154` leaves wake as a no-op without background.
This demonstrates actual dispatch by Worker polling and a Redis health check,
not queue/reconciliation participation in that job. Do not infer the entire
563 Redis/dispatch leg from a healthy Redis alone. An integrated browser extension
should record which production queue/dispatch path runs as well as the exact
browser-created job, real Worker attempt, downloaded output/hash and ledger.
This is an acceptance boundary, not a claim that the queue implementation is
absent, or permission to alter the production architecture for a fixture.

Parent retains coverage-local.json ownership. This audit flags its sole-provider
DEV-LOCAL-006 reason and related local notes for clause-specific remapping only;
it does not edit their statuses. Re-evaluate final assertions after the active
handoff, without substituting local evidence for 92 or demanding 92's credentials
for unrelated local clauses.

Independent read-only invocation of parent's new `sourceCoverage` parser now
reports 573 Master sections, 1,701 unique IDs, 573 directly mapped sections,
zero missing mappings/errors. DEV-LOCAL-002 explicitly references both 552 and
554. The previous 572/573 snapshot is obsolete after this authorized catalog
correction. Master SHA-256 is unchanged:
`a191b4db071d3d1f6f75341b92a43979d7051f9b00f65757125dc5be0e3cbec9`.
Current catalog SHA-256:
`604cbeed4c9d1cb238c496bfe6a34ce0ab321d72a86022c2884d2552b2959c98`.

Parent's earlier counts (TODO 1212, IN_PROGRESS 339, TESTED 120, IMPLEMENTED 27,
BLOCKED 3) are a historical trace snapshot. Latest parent report is a failing
release coverage gate with **1,545 not closed**, including **1,123 TODO**. Neither
count is a count of missing product features or grounds for automatic TESTED.
The companion
plan requires exact clause/handler/call-site/named assertion/run boundary for
atomic promotion; aggregate rows remain partial until every required clause
and acceptance gate is evidenced. Existing implementation without mapped tests
is trace work, not automatic TESTED and not absent code. Required external
Stripe/dedicated-inference staging, clean supported-Mac/fresh-clone
proof, and public-release signing/legal conditions remain separately named.
Nothing here reinterprets or claims the user's requested 100% completion.

## Whole-Spec Inventory Phase

The parent requested a fresh source-authoritative inventory of all 1,701 catalog
IDs, with MVP requirements separated from recommendations, examples and explicit
future scope. See `docs/REMAINING-REQUIREMENTS.md` for the current inventory and
reading progress. Coverage TODO is not evidence of missing code. Conversely,
passing suites and an evidence path are not proof that a whole source section is
complete. The historical findings below remain scoped to their stated evidence;
they do not certify untouched requirements. No source or coverage edits are made
in the current R24 audit phase.

### Historical Whole-Catalog Baseline

Fresh full-text reading is complete for all 573 Master sections. The compact
matrix in `docs/REMAINING-REQUIREMENTS.md` now maps every one of the 1,701 catalog
IDs by its actual source, with 119 nonoverlapping ranges and 30 explicit atomic
scope/evidence overrides. A read-only validation found no missing, duplicate or
extra IDs. At that original snapshot section 554 had no direct catalog row.
Parent's later DEV-LOCAL-002 correction closes it, with the new catalog hash and
independent 573/573 mapping result above; no absent Redis implementation was inferred.

The original conservative classifications were 411 PASS, 1,260 PARTIAL,
2 NOT_IMPLEMENTED and 28 UNTESTED. These are not test totals, an implementation
percentage, or a request to mass-edit coverage. PARTIAL deliberately retains
implemented and tested subsets while identifying exact residuals in R01-R24.
Required, recommended, example and explicitly future clauses are separate axes;
mixed sections cannot be deferred wholesale. Only the two audit documents were
edited, never source, originals, catalog or coverage.

Latest parent evidence, not independently certified merely by reporting:
R03 terms implemented with 12 cases; R04 direct S3/client/Worker paths with 5
upload and 14 protocol cases; R05 runtime CI/isolated packaging implemented and
tested; R08 operator security policy/admin gates implemented; R09 versioned
buyer aliases and DTO validation implemented with unit evidence; R20 atomic
account/endpoint/job-day/spend/chat counters with migration 012 applied. These
supersede earlier absent-code statements. Parent next owns R10/R11/R21/R22;
Feynman is beginning the separately assigned R14 review workflow. R06 dedicated
provider/Stripe keys remain explicitly unavailable until supplied by the user;
R07 real-provider/full acceptance remains externally unproven. Personal
credentials are never an alternative.

The remaining functional inventory is not an invented auth/email/native-app
backlog: it covers actual payout lifecycle, problem reports/reviews, combined
private-resource/research execution, file-backed public examples, media-format
presets and the specific diagnostic/telemetry residuals in the companion file.
Current runbook/REST/limits changes still require their own route-level review.
Subsequent source inspection finds the new R13 payout ingestion/reconciliation,
records and earnings summaries being integrated in `billing.ts`; it is now
implementation-in-progress pending a ready handoff, not an absent payout path.

### Independent Catalog Reaudit - 09:03:49 UTC

Auditor source-read: `apps/api/src/catalog.ts`, `capability-lifecycle.ts`,
`catalog-page.ts`, and their unit/integration tests. Independent command:

```text
KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/catalog.integration.test.ts apps/api/test/catalog.unit.test.ts --no-cache
```

Result: 18 PASS, comprising 14 real-Postgres/S3 integration cases and 4 unit
cases, at 11:03:49 Europe/Zurich / 09:03:49 UTC. Signed Worker execution in these
tests is explicitly synthetic protocol evidence, not OpenClaw or real-provider
proof. Initial loopback access required the local-services sandbox permission;
subsequent runs exposed missing shared terms setup and the newly integrated
operator policy rejecting the canonical OpenClaw version string. Owners fixed
these; the final complete rerun passed without weakening its runtime fixture.

R19 public dependency leakage is now PASS for the exact reported defect:
buyer responses contain normalized categories and resource identifiers/types,
not private graph IDs/names/edges/hashes/grants/source or credential nodes. The
sentinel test verifies the public projection; owner-only version detail retains
the full frozen graph. This does not close every Permission Manifest UI clause.

Verified lifecycle scope includes owner-only history/detail/diff, immutable
published definitions, explicit exact-hash expansion review, fresh compatible
Worker proof for rollback, CAS competing activations, retirement blocking new
purchases without changing queued pinned version/price settlement, visibility
and explicit private grants. Server-side filtering beyond 100 records, bound
cursors and future availability also passed. The policy integration case checks
catalog/readiness minimum/revoked runtime and category behavior; it does not
replace every purchase/dispatch/acceptance/resume policy test.

Scalar examples from the seller's own settled execution now have explicit
publication consent, provenance and version compatibility. Buyer-owned examples
remain denied. R18 remains PARTIAL for explicit public file assets, media
examples/test promotion and full UI acceptance: `examples/from-job` rejects
file-backed jobs with `EXAMPLE_ASSET_APPROVAL_REQUIRED`. No additional blocking
bug was found in the frozen lifecycle/page batch. Owner was notified directly.
Whole-MVP audit remains open.

## Earlier Scoped Hardening Review - 2026-10-06

Late integration finding, verified fixed: admin restoration originally posted
only `{suspended:false}` without the new reason/idempotency contract. The parent
fixed `apps/web/src/components/admin.tsx:25-40`: required 10-1000-character reason,
trimmed payload and confirmation text, dedicated `/restore`, and a key scoped to
account plus payload via `purchaseKey`. Errors retain the key; successful restore
and current billing-review readback clear it. Current suspended state determines
the displayed result, so an old idempotent receipt is not represented as current
access. The auditor reviewed this source, the modal/pending behavior, the shared
key helper and `tests/e2e/admin.spec.ts:4-63`; no additional blocker was found.

Parent-executed browser evidence: the new test passed desktop and mobile against
the actual API/DB. Its route interception uses `route.fetch()` to let the first
real restoration commit, aborts only that response, then retries the same real
endpoint and checks identical key and auditId, trimmed request reason and current
unsuspended billing-review data. This is not a canned-response UI boundary
fixture. The initial 403 was test dev-login setup missing Origin, corrected in
the test without weakening application auth. Confirmation reason is independently
source-reviewed; the inspected browser test explicitly checks the POST reason.
Existing direct API tests separately prove replay cannot undo a later suspension.

Auditor independent rerun at 03:35:23 Europe/Zurich (01:35:23 UTC):
`pnpm exec vitest run apps/web/tests/api.test.ts apps/web/tests/checkout.test.ts --no-cache`
passed all 6 tests, including stable same-payload retries with disabled storage,
changed-payload/new-operation keys and key clearing. The auditor did not launch
a competing browser run while the parent ran the full suites. Final results are
explicitly parent-reported: after the admin UI/accessibility changes, `pnpm verify`
exited 0 at 03:37 CEST (01:37 UTC), with 371 unit tests passed, 70 opt-in skipped,
full workspace/root-tools typecheck, full ESLint and the 18-route build passing.
Root browser 10 plus web flows 14 passed (24 total); a subsequent focused admin
desktop/mobile rerun also passed after the keyboard Skip-link clipping fix.
The prior final-backend integration result remains 75 passed, with backend code
unchanged. Parent reports dev setup exited 0 with all seven migrations applied
and none pending, and removed only two synthetic failed-browser sessions. Final
server restart was in progress, not independently verified here. These final
parent runs were not repeated by the auditor. Only this audit file was edited
by the auditor; whole-spec acceptance remains incomplete.

Latest parent-executed deterministic full-stack receipt, reported 01:32 UTC:
job `4dc67566-84d6-496f-891a-8ac95a4581c1`. Independent read-only DB verification
confirmed SUCCEEDED/SETTLED, one successful attempt, 112-byte asset SHA-256
`dd5aba6a6c5511f39f7bef36e2c3dccb45947b17acba9dbdb2f6f4fab9271d12`, one balanced
settlement transaction (-99/+80/+19), paused/revoked worker with sandboxReady=false,
paused capability, zero grants and zero sessions. This newer receipt supplements
the earlier fixture below; deterministic inference/fake-payment limitations are
unchanged and no auditor Docker run occurred.

Parent requested one final batch after the passing snapshot below: typed finite
nonnegative optional queue wait, explicit purchase-plan revision populated by the
agent and enforced under the API plan lock, and provider dispute closure/won plus
audited restoration. The owner handoffs and independent rechecks are now complete
for this batch. Earlier PASS rows retain their narrower tested scope.
Parent's pre-batch baseline is 369 unit, 61 integration, 22 browser tests and
optimized build passing, plus the deterministic full-stack receipt. No new Docker
run is requested; whole-spec acceptance remains incomplete.

Batch recheck: the queue-wait schema addition is independently PASS.
`packages/contracts/src/index.ts:191` and `contracts.test.ts:14` retain omission,
accept finite nonnegative estimates (including zero/fractions), and reject
negative values, infinities, NaN, string coercion and null. Command
`pnpm exec vitest run packages/contracts --no-cache` passed all 14 tests at
03:16:49 Europe/Zurich (01:16:49 UTC).

The agent purchase interface and population are independently PASS at their
library boundary: `packages/marketplace-agent/src/types.ts:131` requires
`expectedPlanRevision`, and `orchestration.ts:320` sends the current revision
after successful persisted saves. `execution-security.test.ts:34,149` verifies
successive DAG purchase revisions [2,3,6], a stale revision with zero created
jobs/idempotency keys, then one purchase after retry at the fresh revision.
`pnpm exec vitest run packages/marketplace-agent --no-cache` passed all 99 tests
at 03:18:05 Europe/Zurich (01:18:05 UTC). That first stale-revision rejection is a
library fixture; the final real API lock test also independently passes below.

API purchase revision is PASS: `apps/api/src/agent.ts:120` compares the exact
current revision under the plan advisory lock before financial reservation.
`apps/api/test/protocol.integration.test.ts:305` advances the real persisted plan
from revision 2 to 3 after lookup and before the real purchase transaction. The
stale attempt leaves jobIds empty, no idempotency record and an identical wallet;
fresh ticks then create one job with one reservation. The test injects only the
concurrent revision change, not replacement purchase, ledger or transaction logic.

Batch finding, verified fixed: the first revision of
`apps/api/src/disputes.ts:27-28` permitted equal withdrawal/reinstatement
timestamps to clear a won dispute. A read-only direct
helper probe returned null (nonblocking) for closed=100, withdrawn=200,
reinstated=200; withdrawn=201 correctly blocked. The original reproduction was
helper-level ambiguous clearance and did not invoke the restoration route. Sent
directly to the API owner for fail-closed tie handling or authoritative provider
evidence and tests in both arrival orders. Stripe documents that distinct
snapshot events can share second-resolution timestamps and must not be ordered
using that field alone: [event ordering](https://docs.stripe.com/webhooks#event-ordering).
The owner changed the debit/credit comparison to reject equality and old closure
proof after a later withdrawal. Independent real-DB signed-webhook tests now pass
both arrival orders and actual restoration refusal.

Second batch finding, verified fixed: the initial reducer preserved an old won
closure when later financial-event snapshots contradicted it. An in-memory transaction probe
of actual `reconcileDisputeEvent` (no DB/source writes) began with won closure at
100 and reinstatement at 101; funds_withdrawn at 200 with status=lost remained
stored won/reviewRequired=false, and funds_reinstated at 201 with status=lost
then produced a null blocking reason. Only `charge.dispute.updated` initially
marked a later conflicting active state for review; financial-event statuses
were overridden by the older closure. The final reducer also checks durable
financial-event snapshots in either delivery order and preserves reviewRequired
on contradictory/new-cycle evidence. Both real route permutations and signed
replays now pass with account restoration blocked.
This is reducer evidence, not a demonstrated live Stripe or admin-route exploit.

The separate suspicion that reinstated.created before closed.created is valid
was not established and was withdrawn by the parent. This audit does not request
weakening that gate: [Stripe's event reference](https://docs.stripe.com/api/events/types)
describes reinstatement after closure. Reverse delivery order with a consistent
timeline is different from contradictory timestamp/status evidence.

Independent dispute/billing command at 03:27:46 Europe/Zurich (01:27:46 UTC):
`KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/disputes.integration.test.ts apps/api/test/billing.integration.test.ts --no-cache`
exited 0, all 22 tests passed (13 dispute, 9 existing billing). These use actual
local PostgreSQL, signed synthetic Stripe events and real session/admin API
guards; no external provider calls. Specific closure/restoration behavior is
PASS: no auto-unsuspend or new credits, distinct disputes/payments stay separate,
refund debt survives closure, credentials remain revoked, admin reason/key/audit
are required, replay cannot undo a later suspension, and a new dispute racing
restoration leaves the account held. Valid late-win/reinstatement timestamps
arriving in reverse order pass. Implementation: `apps/api/src/disputes.ts:19-143`
and `billing.ts:215-262`; tests: `disputes.integration.test.ts:75-225`.
Migration 7 is owner-applied and source-reviewed, not independently replayed
against a fresh legacy-upgrade database. Lost, legacy/unknown and reviewRequired
cases intentionally remain blocked without a manual evidence-override workflow;
the general payment lifecycle and live Stripe acceptance are not certified.

Final post-batch independent verification: `pnpm test:integration --no-cache`
exited 0 at 03:28:51 Europe/Zurich (01:28:51 UTC), 75 tests passed in 11 files
(13 dispute, 13 protocol, 9 billing, 19 PostgreSQL resource, 1 background,
20 other integration/security cases). `pnpm typecheck` then exited 0 across all
workspace packages and the root tools/tests project. No Docker run, migration,
source or coverage edit was performed by the auditor. No additional confirmed
blocking P1 remains in this reviewed hardening batch; this is not whole-spec
completion or real-provider release approval.

This section supersedes historical status descriptions below. This is a P1
integration audit snapshot, not release approval or all-1701-row certification.
The complete Master Spec was read previously; TODO coverage rows and stale owner
status documents were not used as implementation evidence. Section 501 library
repair, persisted API repair, bounded queued purchase and plan fairness now pass
their named independent regressions. No additional confirmed blocking P1 was
found in the reviewed final A22-A28 fix set. This is not a statement that every
required MVP behavior is implemented or that the remaining release gates pass.

Owner handoff update: parent assigned A22/A23/A24/A26 to the API owner and A25
to the Worker owner. The auditor is not implementing those fixes. Native owner
agents were absent from the app thread list, but their IDs were recovered from
the main chat's handoff record. Acceptance checks and the A25/runtime recheck
were delivered directly to both owners. A22/A23/A24/A26 subsequently passed the
independent 21-test DB rerun, then the final 61-test integration rerun including
A28 and persisted repair. A25 also has actual deterministic full-stack execution
evidence, distinct from dedicated real-provider acceptance.

Runtime handoff evidence has advanced: auditor read the Worker owner's captured
`node --import tsx security/sandbox/smoke.ts` results. Two later runs exited 0
(26.5 seconds each), including production-inference-broker, plugin-loaded,
resource-broker-read, SSH workspace write, named output mapping, unique-marker
integrity, empty-tool allowlist and process-tree pause/resume/cancel. Earlier
empty-tool failures are superseded. This is actual Docker/OpenClaw 2026.8.2
execution with DETERMINISTIC_TEST_ONLY inference, not a dedicated real model or
paid API flow. Parent now reports full smoke and approve-image self-tests passing
on final image `sha256:96dd4f5334bf57fea81af17192864ae57e0f520aa492afb8591ad7fd7077ae52`,
including A27's named zero-tools final envelope. Worker owner also reports the
rebuilt image's mounted-canary/network/SSH/plugin/config/media probes passed.
The auditor did not launch a competing Docker run while parent/resource-owner
full-stack checks were active. This evidence is explicitly owner/parent-executed.

The resource owner's final full-stack fixture exited 0 at 01:07:05 UTC
(03:07:05 Europe/Zurich), job `d09ba72a-fc2b-461e-afc3-5883c0f61612`.
The auditor reviewed `scripts/e2e-fixture.ts:170-329` and
`docs/FULLSTACK-FIXTURE.md:99`, then independently read back only this synthetic
job's DB records: SUCCEEDED/SETTLED, one successful attempt, 112-byte output with
SHA-256 `c15e195dcb1f629854d8c87b4d6f171a29e4a3d5c265ec49202695afbc4feb5c`,
one balanced settlement transaction (-99 capture, +80 seller, +19 platform),
paused/revoked worker with sandboxReady=false, paused capability, zero remaining
grants and sessions. The executed fixture obtains genuine image/inference/local
capability proofs, signed readiness and private publication, consumes distinct
required FILE bytes through real OpenClaw tools, purchases, uploads/downloads S3
results and replays signed settlement. Nine inference calls are deterministic;
payments and malware scanning are explicitly development fixtures. Background
reconciliation is excluded. This closes the impossible required-file path, not
real-provider/Stripe, private-resource selection or all format-specific E2E gates.

### Independently rerun evidence

- `pnpm exec vitest run packages/contracts packages/policy-engine packages/job-protocol packages/billing --no-cache`: 62 passed (4 files), including the new A20 shared-validator regression.
- `KIVRO_INTEGRATION=1 pnpm exec vitest run tests/integration apps/api/test --no-cache`: 32 passed (7 files). This includes 27 real API/DB/storage integration cases and 5 security primitive cases, not 32 real-provider cases.
- `KIVRO_INTEGRATION=1 pnpm exec vitest run packages/resource-broker/test/postgres.integration.test.ts --no-cache`: 11 passed against the local synthetic PostgreSQL fixture, including actual role ACLs, query cancellation and timeouts.
- `pnpm exec vitest run apps/worker packages/openclaw-adapter packages/marketplace-agent packages/research-broker packages/resource-broker --no-cache`: 197 passed, 11 opt-in PostgreSQL cases skipped in this command and passed separately above.
- Later A25-focused rerun at 02:55:28 Europe/Zurich: `pnpm exec vitest run apps/worker packages/openclaw-adapter packages/job-protocol --no-cache`: 25 passed in 4 files, including both new required FILE/FILES preflight regressions and missing/hash/duplicate/symlink/content rejection. This is not a Docker/publication-flow run.
- A27-focused rerun of that same scoped command at 03:03:07 Europe/Zurich: 27 passed, including named scalar/JSON results with no write permission. Source now accepts a strict final JSON envelope as well as a metadata file, without adding tools.
- Completed agent handoff rerun at 03:03:50 Europe/Zurich: `pnpm exec vitest run packages/marketplace-agent --no-cache`: 98 passed in 5 files, including 29 repair regressions. Later actual API purchase/repair cases pass below; paid multi-job E2E remains separate.
- Four-fix DB rerun at 03:05:34 Europe/Zurich: `KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/billing.integration.test.ts apps/api/test/background.integration.test.ts apps/api/test/protocol.integration.test.ts --no-cache`: all 21 passed (billing 9, protocol 11, background 1). PostgreSQL/S3 were real local services; Stripe events/outcomes were synthetic. Six migrations were applied by the owner, not by the auditor.
- Scoped Worker/protocol/adapter rerun at 03:05:35 Europe/Zurich: 37 passed in 5 files, including named no-write envelopes, FILE/FILES preflight, unsupported format gating, DNS timeout/cancel and Docker/adapter prestart rejection. Crypto was not in this selection.
- Final integration rerun at 03:10:29 Europe/Zurich (01:10:29 UTC): `pnpm test:integration --no-cache` exited 0, 61 passed in 10 files: billing 9, protocol 12, PostgreSQL resource 19, recovery fairness 1, other API/ledger/storage/signature/security/dev-port cases 20. A28, persisted repair, renewed approval, completed-work/budget retention, active-job repair refusal and bounded queued purchase all passed. This is one more test than the earlier parent-reported 60-test snapshot.
- Final scoped Worker/protocol/adapter rerun at 03:10:45 Europe/Zurich (01:10:45 UTC): 39 passed in 5 files, including the later public-HTTPS DNS-family regressions. No real provider request was made.
- The first integration attempt was blocked by sandbox loopback access (S3 EPERM and PostgreSQL unreachable). The approved local-network rerun passed. This was not treated as a product failure.
- Parent's earlier `pnpm verify` receipt was 368 unit tests passed, 55 opt-in cases skipped, typecheck/lint/build passed; updated pre-hardening baseline was 369 unit, 61 integration, 22 browser and optimized build passed. Browser 8+14 includes six explicit UI-boundary fixture tests. Full verify/browser/build were not independently rerun by the auditor. Post-hardening 75-test integration and full typecheck were independently rerun as recorded above. No source or coverage files were edited; no personal provider credentials were accessed or reused.

All Vitest start times above are the host's Europe/Zurich local time (CEST,
UTC+02:00 on this date). Earlier audit versions incorrectly labelled 02:55/03:xx
Vitest logs as UTC; those labels are corrected here.

### Historical Hardening Classifications

PASS below means the specific reproduced failure and named regression surface,
not universal correctness or satisfaction of an entire Master Spec section.

| Finding / surface | Current classification | Evidence and remaining boundary |
| --- | --- | --- |
| A01 signed execution projection | PASS | Four-field executionManifestHash includes dependencies. `packages/job-protocol/src/index.ts:34-54`; real API verifier at `tests/integration/worker-protocol.test.ts:80` rejects changed dependencies and tampering. |
| A02 pre-acceptance payload, seller view, cancellation/revocation | PASS | `apps/api/test/protocol.integration.test.ts:91,400` and `tests/integration/worker-protocol.test.ts:80,110` passed, including actual private input bytes, seller redaction and post-cancellation/revocation refusal. |
| A03 named output model and delivery | PASS | API regression `apps/api/test/protocol.integration.test.ts:204`, Worker projection tests, parent named-zero-tools smoke and the actual deterministic full-stack named FILE delivery passed. Real-provider paid acceptance is a separate untested gate. |
| A04 dependency snapshot/consent | PARTIAL | Four-field hash, graph/grants and local skill/resource consent exist (`apps/worker/src/capabilities.ts:12-41`, `capability-health.ts:10-16`). Required-child skill import still rejects every non-SKILL dependency (`discovery.ts:57-78`). |
| A05 seller Connect lifecycle | PARTIAL | Onboarding, signed account events and admission checks exist. Exact acceptance gate and stale/same-second READY-after-restriction tests passed independently (`protocol.integration.test.ts:373`, `billing.integration.test.ts:84`). Real Connect acceptance remains untested. |
| A07-A12 original contract/policy reproducers | PASS | 12 contracts and 44 policy tests rerun. Default order, actual output/default rules, publication closure, fairness predicate, override and rejected schema regex/ref/depth cases are addressed. This is not a proof against all possible validation resource-exhaustion inputs. |
| A13 impossible PNG-to-PDF plan | PASS | `packages/marketplace-agent/test/orchestration.test.ts:84` and named/bounded mapping cases passed; frozen-output security cases also passed. Paid multi-job E2E is still untested. |
| A14 research/private resource runtime integration | PARTIAL | `apps/worker/src/runtime.ts:154-175` and `tools.ts:46-79` route real broker calls; final 19 real PostgreSQL tests passed independently. Captured owner Docker/OpenClaw smoke exited 0 for broker/resource/file delivery, empty tools and pause/resume/cancel with synthetic inference. The old blocked-runtime and empty-tools-failure claims are superseded. The full-stack required FILE is a buyer upload, not a seller-private resource selection; that broader paid flow remains untested. |
| A14 narrow executable / required Blender fixture | PARTIAL | New fixed-argument `blender_render` and `ffmpeg_transcode` branches exist in `security/sandbox/runner.mjs:81-95`, are gated by declared tool and input asset, and map through the reviewed plugin/shared allowlist. The earlier absent-wrapper claim is superseded. Actual required Blender/file-heavy paid fixture remains UNTESTED; discovery still rejects imported skills with non-SKILL required children (`packages/openclaw-adapter/src/discovery.ts:57-78`). |
| A15 read-only mount self-test | PASS | `security/sandbox/self-test.mjs:10-11` requires readable canaries and specific write-denial errors. Parent/owner report actual final-image approve-image probes passed. Execution is not claimed as an auditor rerun or complete sandbox-escape proof. |
| A16 queue dispatch deadlock | PASS | `worker.ts:86-87` now separates queue serving from canRunNow. Real API/DB queue -> offer, capacity and scheduled promotion tests passed. |
| A17 short-window uncertain transfer plus refund | PASS | Durable intent precedes external call. `apps/api/test/billing.integration.test.ts:138` passed with real DB and synthetic lost Stripe response/concurrent refund; long-window cases are A24. |
| A18 live/test isolation | PASS | `packages/billing/src/stripe.ts:18-24` plus DB-backed bidirectional webhook-mode tests `billing.integration.test.ts:63` passed. Real Stripe accounts and environment migration were not used/tested. |
| A19 cumulative provider topup refunds | PASS | DB-backed partial/duplicate/out-of-order/before-credit/shortfall cases at `billing.integration.test.ts:71,120,128` passed with synthetic signed events. Early-dispute coverage is A23. |
| A20 nonexistent named file settlement | PASS | Shared validator supplies authoritative []; real result-route test at `protocol.integration.test.ts:204` rejects nonexistent ID while payment stays RESERVED, then accepts actual uploaded bytes. |
| A21 heartbeat clears failed version validation | PASS | `worker.ts:152-160` preserves version/hash/time-bound validation. `protocol.integration.test.ts:191` passed for failed/missing/expired evidence. Exact acceptance checks now pass under A22. |
| A22 current acceptance eligibility | PASS | `protocol.integration.test.ts:373` passes Connect, unhealthy/FAILED/expired/mismatched/missing exact-binding cases, with no acceptedAt, payload or seller content disclosure on rejection. |
| A23 early dispute / later refund | PASS | `billing.integration.test.ts:97` persists PENDING across app recreation, applies at checkout, suppresses duplicate effects, rejects missing reference and retains disputedAt through refund/admin restore refusal. |
| A24 old uncertain transfer recovery | PASS | `billing.integration.test.ts:174,199` passes existing-transfer verification/reversal and provider-empty cancellation/refund with audit. No blind >23-hour recreation. Real Stripe lookup semantics remain an external acceptance gate. |
| A25 explicit required-file test inputs | PASS | `apps/worker/src/validation.ts:22-46`, independent required FILE/FILES and unsafe-selection regressions, plus owner-executed full-stack `scripts/e2e-fixture.ts:204-245` prove genuine local required-FILE validation, signed readiness, private publication and execution. DB receipt independently confirmed. Inference remains deterministic, not real-provider acceptance. |
| A26 job recovery fairness | PASS | `apps/api/test/background.integration.test.ts:46` independently passes 251 old future reservations, running/pause/disconnect/offer expiry and waiting overflow, with one release per terminal job. Short per-job transactions preserve financial transitions. |
| A27 no-write named scalar results | PASS | Named TEXT/JSON regressions pass independently; parent final-image smoke includes the zero-tools strict final envelope. The fix does not widen tool access or infer missing output. |
| A28 plan maintenance fairness | PASS | `apps/api/src/agent.ts:182-199` uses a durable locked ordered cursor. `apps/api/test/protocol.integration.test.ts:230` independently passes 20 nonprogressing RUNNING plans plus the 21st approved plan, exactly one new purchase across repeated ticks, retained paid work and actual bounded BUSY/NOW queued purchase. |
| A06 real Stripe/OpenClaw paid text + generated-file gates | UNTESTED | The new full-stack fixture uses genuine runtime proofs and real Docker/OpenClaw/S3/ledger, unlike the deliberately fabricated protocol-only readiness fixture. Both still use fake payments/synthetic inference or Stripe outcomes. Dedicated real inference plus Stripe test-mode acceptance remains required. |
| Section 501 individual-step repair, named regression surface | PASS | Final 99 agent tests including 29 repair regressions and actual persisted API tests `protocol.integration.test.ts:230,305` pass: concurrent repair 200/409, preserved output/provenance/spend, stale approval/revision refusal, fresh approval, active-job refusal and idempotent queued purchase. This does not certify every possible race or the real-provider multi-job scenario. |
| Shared queue-wait field and locked purchase revision | PASS | `contracts/src/index.ts:191`, `marketplace-agent/src/types.ts:131`, `orchestration.ts:320`, `api/src/agent.ts:120`; independent 14-contract/99-agent tests and actual API/DB stale-revision regression pass. Library fields are no longer pending. |
| Provider dispute closure / audited account restoration, bounded signed-event flow | PASS | `apps/api/src/disputes.ts:19-143`, `billing.ts:215-262`; independent 13 new dispute tests plus 9 existing billing cases pass and remain green in final 75-test integration. Both newly reproduced ambiguity/old-closure defects are fixed; admin restoration, debt, revocation, restart/replay and concurrency boundaries pass. Live Stripe and ambiguous legacy/operator resolution remain outside this PASS. |
| Admin restoration UI -> hardened API request | PASS | Parent fixed `apps/web/src/components/admin.tsx:25-40`; auditor reviewed source/key lifecycle and independently passed 6 helper tests. Parent's actual desktop/mobile browser -> API -> DB test `tests/e2e/admin.spec.ts:4` passes post-commit lost-response/retry with identical key/auditId and current account readback. No auditor browser rerun or broader post-UI build claim. |
| Manual resolution of provider-review/ambiguous legacy dispute records | NOT_IMPLEMENTED | Such cases deliberately remain held; no manual override/reconciliation route clears reviewRequired or legacy unknown evidence. This is a separate operational boundary, not the former absence of ordinary won-dispute restoration. |
| Approved paid multi-job final PDF and fresh-clone failure matrix | UNTESTED | Real approved paid workflow and full fresh-clone failure-matrix acceptance still require their own evidence. |

### Remaining boundaries, not missing-credential aliases

- Code gap: imported skills with declared executable/credential children remain
  unsupported by `packages/openclaw-adapter/src/discovery.ts:57-78`, even though
  separately configured inference/resources and fixed Blender/FFmpeg wrappers
  exist. Do not call this dependency-bearing import workflow complete.
- Ordinary signed closure/won-plus-reinstatement and audited restoration are
  implemented and tested; the old blanket absence claim is superseded. Lost,
  ambiguous/conflicting, legacy unknown or unsupported-amount/currency cases
  remain fail-closed, with no manual evidence-override route. Migration backfill
  is source-reviewed but a fresh legacy upgrade and actual provider reconciliation
  remain untested. Do not generalize the bounded PASS to every dispute lifecycle.
- Library interface hardening is now addressed and independently verified:
  required `expectedPlanRevision` with current-revision population, and typed
  optional finite nonnegative `AvailabilitySchema.estimatedQueueWaitSeconds`.
  Exact API revision enforcement under the existing plan lock is also implemented
  and independently tested alongside approval hash, step, version, quote and
  aggregate spend checks. No shared-interface omission remains in this batch.
- External acceptance: dedicated real inference, actual Stripe test-mode
  Connect/transfers/refunds/reconciliation and production malware scanning are
  untested. No personal credential reuse is authorized or needed for this audit.
- Scenario acceptance: required Blender/file-heavy execution, paid approved
  multi-job final-PDF/provenance flow and complete fresh-clone failure matrix
  remain untested. Passing generic text-file and unit fixtures is not equivalent.

### A22 - P1, verified fixed: Acceptance readiness

Original reproduction: `apps/api/src/worker.ts:234-240` rechecks device pause, sandbox, schedule and
security flags, but not seller Connect readiness or this Worker's current
version/hash validation. After a valid offer, account.updated can make the seller
ACTION_REQUIRED or validation can fail before acceptance. A direct real-handler
probe still returned `{ok:true}`, moved OFFERED -> ACCEPTED and set acceptedAt
with Connect ACTION_REQUIRED; it made zero WorkerBinding checks. The accepted
payload endpoint can consequently release the buyer data.

Concurrent source recheck: the accepting transaction now fetches the exact
worker/version binding and requires healthy PASSED status, matching immutable
hash, fresh validation and fresh heartbeat, plus READY Connect in Stripe mode.
All six acceptance-change cases passed independently in the real API/DB suite.

Action: transactionally recheck current seller payment eligibility and the exact
accepting Worker/version binding, manifest, successful validation and freshness.
Do not rely on a prior offer or on another ready Worker's binding. Add real route
tests that change Connect/validation after offer and before acceptance. Master
Spec 24.26(10), 109, 338 and 376.

### A23 - P1, verified fixed: Early dispute delivery

Original reproduction: `apps/api/src/billing.ts:93-107` handles a dispute only when Topup.paymentIntentId
is already stored. If checkout reconciliation is delayed, that lookup returns
null and the event is still recorded as PROCESSED. Probe: a signed synthetic
dispute for an as-yet-unlinked payment produced received=true/outcome=PROCESSED,
zero suspensions and a durable BillingEvent. Later checkout processing can credit
the wallet; replay of the same dispute is ignored at `:61-62`. Unlike refunds,
there is no deferred linkage or retriable error here.

Concurrent source recheck: unmatched disputes now persist PENDING with their
payment reference; checkout applies them in the credit transaction, and missing
references reject. The separate disputedAt marker survives subsequent refunds.
Independent real-DB regression passed early delivery, app recreation, later
credit, duplicate replay, missing reference and refusal of admin restore after
a partial refund. This does not claim a complete provider dispute-resolution UI.

Action: persist pending dispute state keyed to the provider payment or return a
retriable outcome until linkage exists; apply it atomically before later credit
can become spendable. Test dispute-before-checkout, missing payment reference,
replay and recovery after restart. Master Spec 24.13, 24.17 and 24.26.

### A24 - P1, verified fixed: Old uncertain transfer recovery

Original reproduction: `apps/api/src/background.ts:89` correctly avoids blindly recreating an old
uncertain transfer, but always throws once startedAt is older than 23 hours and
stripeTransferId is absent. Its catch (`:104-105`) loses that specific reason and
only reschedules the same permanently failing condition. No lookup/reconciliation
or audited operator-resolution route exists in `packages/billing/src/stripe.ts`
or the API. A 24-hour-old refunded uncertain transfer remained REVERSAL_PENDING
after two forced reconciliation attempts, with zero provider calls and generic
TRANSFER_RECONCILIATION_FAILED. An external payment may still need reversal.

Concurrent source recheck: explicit NEEDS_RECONCILIATION quarantines old unknown
outcomes with a preserved reason and audit record. Admin resolution verifies
provider transfer ID, mode, currency, amount, destination, job metadata and group
before linking; refunded jobs proceed to reversal. A second explicit path checks
that the provider job transfer group is empty, refunds the buyer transactionally,
and cancels the uncreated intent with operator/reason/investigation audit. This
addresses the separate crash-before-external-call case without unsafe recreation.
Both provider-existing and provider-empty recovery regressions passed in the
independent real-DB/synthetic-provider suite. No real Stripe request was made.

Action: implement provider outcome lookup and/or a durable NEEDS_RECONCILIATION
state with a safe audited resolution workflow. Preserve the uncertainty reason;
do not simply remove the time guard and risk duplicate payment. Test restart
after the recovery window, including a transfer that actually succeeded and a
refund arriving before outcome recovery. Master Spec 24.14 and 24.26(11,13,14).

### A25 - P1, verified fixed: Required-file local publication test

Original reproduction: `apps/worker/src/validation.ts:23` called validateInput with an empty asset
list; `:40` also constructs the test offer with assets=[]. The CLI at
`apps/worker/src/index.ts:112` accepts JSON values but provides no test-asset
selection/materialization path. Direct testCapability invocation for a required
PDF FILE and a UUID returned INVALID_INPUT / "File is unavailable or not
authorized" before lease acquisition, Docker or inference. FILES has the same
constraint. No credentials or image could make that original input path pass.

Concurrent recheck: Worker owner added the explicit fixture form documented in
`docs/OPENCLAW_COMPATIBILITY.md`: `{input,assets:[{id,path,filename,mimeType,sha256,sizeBytes}]}`.
New `validation.ts:26-45` validates contract input against authoritative selected
assets, checks cumulative bytes, regular file/nlink, canonical path, protected
directories, no-follow open and actual byte/hash/MIME agreement, then materializes
read-only snapshots into the test offer. A direct probe using the repository's
existing README as a required Markdown FILE reached lease acquisition with its
correct descriptor; missing assets failed INVALID_INPUT and tampered SHA-256
failed TEST_ASSET_INTEGRITY_FAILED before lease acquisition. The probe deliberately
stopped at the lease, did not invoke Docker/inference, and wrote no files. The
original impossible-preflight claim is superseded.

Final recheck: the actual full-stack fixture now calls `testCapability` with a
required FILE and separately verifies byte consumption before obtaining signed
readiness and private publication. A different buyer-uploaded FILE then completes
real WorkerRuntime/Docker/OpenClaw, generated named output, S3 delivery and one
settlement despite replay. See `scripts/e2e-fixture.ts:204-294` and the receipt
above. The owner executed this run; the auditor reviewed its implementation and
independently verified persisted job/ledger/hash/cleanup records. Required FILES
has unit preflight evidence, not a separate full-stack multi-file run.

Original acceptance request: exercise explicit, bounded seller test-file selection with the same MIME,
hash, size, safe-path and read-only materialization checks as real execution;
carry authoritative test asset descriptors into the offer. Do not weaken required
file validation or fabricate passing evidence. Test a required input file plus
generated output before publishing it. Master Spec 209, 235 and local acceptance.

### A26 - P1, verified fixed: Reservation recovery fairness

Original reproduction: `apps/api/src/background.ts:15` always selects the oldest 250 RESERVED jobs, with
no pagination, cursor, due-time filter or rotation. Those can all be future
scheduled reservations, so later running/paused/disconnected jobs never reach
their timeout/refund logic until old reservations leave. A two-cycle probe with
250 older future jobs plus one execution already an hour past deadline never
visited the expired job and left it RUNNING/RESERVED with no writes.

Concurrent source recheck: active and waiting jobs now use independent durable
rotating 250-row cursors. A real-DB regression has been added for 251 older
reservations plus running, paused, disconnected, expired-offer and expired-waiting
jobs. Independent execution passed, with financial transitions in short per-job
transactions and exactly one release. Plan maintenance has a separate issue A28.

Action: page through all outstanding jobs or prioritize independently indexed
due/expired states with bounded fair continuation. Ensure active-job recovery
cannot be blocked by long-wait reservations. Test more than 250 reservations and
verify execution, pause, disconnection and offer-expiry deadlines remain bounded.
This is a code reliability defect, not a missing provider requirement.

### A27 - P1, verified fixed: No-write named output metadata

Original reproduction: a contract with aggregate TEXT and one required named SHORT_TEXT field passes
`validateContractDefinition`, `assertPublishable` and `executionManifestHash`
with tools=[]. Yet `packages/openclaw-adapter/src/index.ts:42` instructs every
named-output capability to write result/kivro-result.json;
`security/sandbox/runner.mjs:184-193` only obtains the result manifest from that
file, and `apps/worker/src/results.ts:6-7` requires it. The correctly empty tool
allowlist has no write or equivalent tool, so that metadata path is impossible.
Direct probe of the real projection with valid final JSON
`{text:'Done',fields:{summary:'Done'}}`, no files and no resultManifest returns
NAMED_RESULT_MANIFEST_REQUIRED. This is independent of provider credentials.

Recheck: `apps/worker/src/results.ts:7-9` now accepts a strict final JSON envelope
when resultManifest is absent. Missing/invalid/fenced/undeclared content is not
inferred or extracted, and FILE/FILES still map only to collected artifacts.
Both named TEXT and JSON no-write regressions passed in the independent 27-test
Worker/protocol/adapter rerun and remained green in the later 37-test run.
Parent reports the same named zero-tool final-envelope case passed in actual
final-image OpenClaw smoke. Inference there was explicitly synthetic.

Action delivered directly to Worker owner: define a bounded, validated named
output response channel for scalar/JSON-only capabilities, without silently
adding filesystem permissions. Keep file paths/asset mapping authoritative for
file-bearing contracts. Add a no-tools named scalar/JSON regression and actual
OpenClaw smoke; publication/local testing must not advertise an impossible
combination as ready. Master Spec 211-213 and 235.

### A28 - P1, verified fixed: Long-running plans starve later approved plans

Original reproduction: `apps/api/src/agent.ts` assigns ctx.tickPlans with an unpaginated
`findMany({where:{state:{in:['APPROVED','RUNNING']}},take:20})`. Twenty older plans
waiting for scheduled/long-running jobs can occupy every selected row for days,
so later approved plans are never advanced and deadlines/quotes expire without
their purchase being attempted. Direct invocation of the actual registered
tick callback with 20 RUNNING plus a 21st APPROVED fixture over two cycles visited
exactly the same 20 IDs; the approved plan was never visited. No DB or source
mutations were used in this probe.

Final recheck: `agent.ts:181-198` now selects ascending IDs after a durable
`agent-plan-poll-cursor`, wraps when needed, and advances the cursor in a short
advisory-locked transaction before executing the batch. The independent final
integration run passed `protocol.integration.test.ts:230`: 20 nonprogressing
RUNNING rows no longer starve the later approved plan; two ticks create exactly
one new purchase while preserving a completed paid step, and repeated ticks do
not duplicate it. The same real API/DB test rejects concurrent stale repair and
active paid-job replacement, requires renewed approval, then repairs/approves a
BUSY capability with explicitly bounded NOW queue consent and purchases QUEUED.

Action delivered to API owner: durable fair continuation or independently fair
due-plan selection, plus a >20-plan regression that proves later approved work
and existing running-plan result polling progress. A26's job cursors do not fix
this independent selector. Also verify API catalog.quote's NOW/canRunNow gate
against the agent policy's BUSY/canQueue support. That separately reported
source-review concern is now corrected and covered by the real queued-purchase
case. Shared request/availability type hardening and the exact locked purchase
revision are now independently verified in the final batch above.

## Historical Findings

The following preserves discovery evidence. Use the latest classifications above
for present status; line numbers below refer to their earlier source snapshots.

## Immediate Integration Findings

### A01 - P1, initial mismatch resolved: Signed manifest projection

Initial evidence: `docs/API-STATUS.md` said `manifestHash = hashManifest(permissions)`;
`docs/WORKER-STATUS.md` said the hash covers
`{ioContract, permissions, internalInstructions}`. `docs/INTEGRATION.md` defines
the field but does not fix the projection. With those implementations, a correctly
signed offer will fail Worker integrity checks, or checking will be weakened to
make integration pass.

Recheck: API and protocol source and API status document now agree on the
three-field projection. This original interoperability discrepancy is resolved
in source, subject to cross-package verification. The manifest completeness
question remains under A04/A14; this is not a current mismatch claim.

Action: parent must define a single shared canonical projection covering every
execution-affecting field and version binding; both owners must use it. Add a
cross-package test that creates a real API offer and verifies it with the Worker
verifier. A local hash unit test cannot establish interoperability.

### A02 - P1: Offer discloses buyer payload before Worker acceptance

Evidence: Master Spec section 11 requires encrypted/signed job payload or input
downloads to become available only after acceptance.
`docs/INTEGRATION.md` puts `input` and `assets` directly in `JobOffer` and defines
no post-acceptance payload retrieval interface.

Action: split an offer's safe metadata from the accepted-attempt payload; release
input and authenticated file downloads only after ownership, current attempt,
acceptance, and secured payment checks. Test refusal before acceptance and after
cancellation/revocation/attempt expiry.

Earlier active API snapshot: `apps/api/src/worker.ts:160-165` embeds input and asset
download locations in offers. `apps/api/src/assets.ts:53-55` authorizes input
downloads for `activeStates`, which includes OFFERED (`catalog.ts:12`), without
requiring acceptance or checking the attempt's offer expiry. Seller job list and
detail also return raw `job.input` before acceptance (`jobs.ts:18,24-27,151-154`).
Fixing only the offer DTO will not close the other disclosure paths.

Concurrent source recheck: the API owner has now added JobNotice plus an
accepted-attempt payload endpoint, and file-download authorization now excludes
OFFERED and requires acceptedAt. These changes are visible in source but have not
yet been exercised end to end by the auditor. The seller list/detail raw-input
disclosure in jobs.ts is still present in the latest inspected snapshot.

## Additional Integration Findings

### A03 - P1, partially addressed: Named output contract integration

Initial evidence: Master Spec sections 192, 211-213 and 223 require typed named output
fields, independently required/optional fields, per-field file cardinality/type,
and deterministic mappings to downstream inputs. The integration contract has
one aggregate `output: {type: TEXT|JSON|FILES|MIXED, ... required}` and JobDTO has
only `text/json/assets`. It cannot describe, for example, required PNG `renders`
plus an optional BLEND `modifiedScene`, or validate each separately.

Recheck: shared code now adds optional `output.fields` and `JobOutput.fields`.
The Worker/result mapping, output-specific types and semantics still need
integration. See A08 and Recheck Notes below for current evidence.

Action: settle a shared field-level output model and canonical result manifest
before UI, API, Worker and planner finalize. Adapt all four consumers together.
Do not claim contract acceptance merely from validating the aggregate envelope.

### A04 - P1: Dependency interface loses closure, consent and health provenance

Evidence: integration `Dependency` is a flat record with `required/approved/healthy`
booleans. Master Spec sections 102-112, 118 require `dependsOn` edges, discovery
sources, required/optional/conditional classification, support/sensitivity,
observed-vs-declared checks, version snapshots, and seller/version/manifest-bound
permission consent records. No shared interface transfers these records from
local discovery/test to cloud publication.

Action: define the graph snapshot and per-permission consent/health evidence
contract and binding to the immutable tested version. Client booleans cannot
substitute for the required discovery/import/test workflow. Publication must
detect unsupported or unresolved transitive dependencies and later drift.

### A05 - P1: Connect eligibility needs an explicit integrated lifecycle

Evidence: Master Spec sections 24.1, 24.7, 24.26(10), 88 and 111 require seller
Connect readiness before paid jobs and server-verified onboarding/account state.
The integration API lists wallet funding and a webhook, but no Connect
onboarding/status endpoints or eligibility contract. A seller earnings ledger
alone cannot establish payment readiness or recoverable transfer/payout state.

Action: API/web owners need agreed onboarding/status routes, webhook-derived
eligibility and dispatch/publication checks, plus recoverable settlement transfer
and reconciliation ownership. Verify non-ready sellers never receive paid work.
An explicitly gated fake adapter is valid local scaffolding, not Stripe acceptance.

### A06 - P1: Release gates require real providers, generated files and orchestration

Evidence: sections 61 and 92 make generated-file delivery and real OpenClaw plus
Stripe test-mode paid staging E2E mandatory. Sections 160-161 explicitly require
approved multi-job orchestration, compatible artifact transfer, hard budget and
rating constraints, final PDF, provenance and exactly-once per-job settlement.
Earlier optional-language sections 12, 42 and 159 do not justify silently
removing these later explicit acceptance gates.

Action: parent must retain these gates as incomplete until actual recorded runs
pass. Unit tests/mocks and a text-only demo do not satisfy them. Local fake-payment
E2E and Stripe test E2E must be separately labeled.

## Confirmed Adversarial Findings

These probes ran directly against source with `node --import tsx
--input-type=module` on 2026-10-06. They did not edit code or create tests.

### A07 - P1: Conditional required inputs depend on field iteration order

Evidence: `packages/contracts/src/index.ts:198` applies each default immediately
before checking that field's condition (`:199-203`). Define required `details`
with `visibleWhen: {key: 'mode', equals: 'full'}` before `mode`, whose default is
`full`; `validateInput(contract, {})` returns `{mode: 'full'}` without details.
Reversing the two field definitions correctly rejects the same input.

Action: resolve and validate scalar defaults before evaluating conditions;
validate conditional relationships deterministically, independent of display or
array order. Test both field orders and required conditional output fields.
Master Spec sections 192, 202, 206 and 211.

### A08 - P1: Output defaults pass delivery validation without delivered data

Evidence: `packages/contracts/src/index.ts:238` reuses `validateInput` for output
fields but discards its normalized result. A required `report` output field with
`default: 'placeholder'` passes `validateOutput(..., {text: 'Delivered'})`, and
the returned output remains only `{text: 'Delivered'}`. No `report` exists.
This is a false valid-delivery decision that can authorize payment for an
incomplete result. Input file defaults are also accepted at schema level,
contrary to section 209.

Action: use output-specific field semantics; forbid output defaults, require
actual delivered fields, and forbid hidden defaults on FILE/FILES inputs.
Test that omitted required outputs fail regardless of defaults or conditions.
Master Spec sections 24.10, 24.23, 209 and 211-213.

### A09 - P1: Publication policy does not enforce declared permission closure

Evidence: `packages/policy-engine/src/index.ts:131` (`assertPublishable`) checks
only a short forbidden-tool set and required dependency booleans. A manifest with
`process`, `message`, `sessions_spawn`, a READ_ONLY `private-db` resource and a
credential reference passes when it has one healthy inference record and an
unapproved/unhealthy optional DB dependency. There is no resource-to-dependency
or credential-to-consent binding. Probe result: `ALLOWED`.

Action: validate all granted permissions against explicitly approved, supported
dependency closure; use one supported-tool policy shared by publisher and Worker.
The Worker currently rejects these unsupported tools/resources, so this is a
confirmed publication/readiness inconsistency, not a demonstrated host escape.
Master Spec sections 15, 96, 107, 112, 113 and 118.

### A10 - P2: Availability can say run now with a full existing queue

Evidence: `packages/policy-engine/src/index.ts:68` checks `queueDepth/maxQueue`
only inside `runningJobs >= concurrency`. With healthy Worker, runningJobs=0,
concurrency=1, queueDepth=5 and maxQueue=5, result is ONLINE/canRunNow=true.
Omitted `dependenciesHealthy` also counts as healthy. Whether this permits
overbooking or overtaking depends on API transaction enforcement, still being
implemented; do not infer an exploit solely from the helper.

Action: distinguish immediate capacity from queued capacity and unknown
readiness; derive admission from the same policy the transactional scheduler uses.
Verify fairness to existing scheduled/queued jobs and fail closed on unknown
required readiness. Master Spec sections 338-355 and 471.

### A11 - P2: Partial-day override does not replace an overnight spillover

Evidence: `packages/policy-engine/src/index.ts:33` merges yesterday's intervals
with today's even when today has an explicit available 12:00-13:00 override.
Monday 20:00-07:00 plus that Tuesday override still permits Tuesday 02:00 UTC.
The helper handles full-day closure specially, but not a narrower replacement.

Action: define override precedence and test it; if overrides replace that date's
hours, clip prior-day spillover. If additive semantics are intended, name them
explicitly in the contract/UI. Weekly scheduling is required; temporary overrides
are optional, but exposed overrides must have deterministic semantics.

## Further Confirmed Findings

### A12 - P1: Untrusted JSON Schema can block API validation indefinitely

Evidence: `packages/contracts/src/index.ts:165-171` compiles and evaluates
seller-controlled JSON Schema synchronously. The 20,000-character schema limit
does not bound regex runtime. A JSON input schema `{type:'string',
pattern:'^(a+)+$'}` with `'a'.repeat(30)+'!'` failed to return within 1.5 seconds;
the auditor's external process timeout terminated it with ETIMEDOUT/SIGTERM.
The five-character counterpart rejected in 85 ms including process startup.
`apps/api/src/jobs.ts:120` invokes this validator inside job creation.

Action: restrict schema features/regex complexity at publication and use a
bounded validation strategy (for example safe-regex semantics or isolated
validation with hard time/resource limits). Include malicious schemas, deep
nesting and expensive regexes in adversarial tests. A request timeout in the
same blocked event loop cannot enforce this boundary.

### A13 - P1: Plan validation accepts an impossible file conversion before purchase

Evidence: `packages/marketplace-agent/src/orchestration.ts:84-86` checks only
FILES/MIXED versus FILE/FILES, not MIME, extension, cardinality or size.
Direct probe: a PNG-only output mapped by assetIndex=0 to a required PDF-only
input is accepted as a two-job plan costing 198 cents. Runtime rejection later
would leave the buyer paying for an upstream service in an impossible plan.

Action: compare source output and target input constraints before approval and
financial authorization; reject unsupported conversions. Validate bounds and
guaranteed field/cardinality availability, not just coarse envelope type.
Master Spec sections 158, 160, 211, 223 and 235.

## Recheck Notes

- A01: current source now agrees on the three-field manifest projection:
  `apps/api/src/catalog.ts:70` and `packages/job-protocol/src/index.ts:33`.
  API status documentation is also corrected. Cross-package signature validation remains
  untested by the auditor; the projection still lacks skill/dependency hashes.
- A03: source now contains optional output `fields` and `JobOutput.fields`
  (`packages/contracts/src/index.ts:66,138,238`). This partially addresses the
  original interface gap. It reuses input field types (no MARKDOWN), and the
  Worker adapter still emits only `{text, files}` at
  `packages/openclaw-adapter/src/index.ts:24,69`; end-to-end named outputs are
  not yet established. A08 demonstrates a validation defect in the new path.
- A05: source has Connect account/link and transfer methods in
  `packages/billing/src/stripe.ts:37-53`, and publication/availability check
  Connect readiness in `apps/api/src/catalog.ts:39,187`. UI/routes/webhook and
  recovery integration still require re-audit when the API owner is done.

### A14 - P1: Image and inference credentials are not the only full-MVP blockers

Evidence: `packages/openclaw-adapter/src/policy.ts:6-14` permits only read/write/edit,
requires network NONE, rejects every resource, and accepts only one inference
transport. `packages/openclaw-adapter/src/discovery.ts:57-64,76-78` marks binary
dependencies unsupported and imports only skills with no required child
dependencies. `packages/openclaw-adapter/src/index.ts:17-24,62-69` exposes only
inference frames and text/files, with no research, connector or resource calls.
The standalone research package cannot make this execution path work by itself.

Action: assign concrete runtime-to-broker interfaces, approved narrow executable
wrappers and version-bound dependency import. Keep existing denial until these
boundaries are implemented. Dedicated credentials and a successful image build
will not alone make the required private-DB fixture (sections 71/90), public
research (237-276), or Blender/file-heavy fixture (235) executable. Native plugins
and arbitrary shell may remain excluded; these required narrow operations may not
be silently treated as post-MVP.

### A15 - P2: Sandbox self-test reports read-only mounts without requiring mounts

Evidence: `packages/openclaw-adapter/src/docker.ts:85-92` allows the probe with no
input/config mounts. `security/sandbox/self-test.mjs:10` treats any write failure
as evidence, including ENOENT for absent directories, then line 20 reports
read-only-input/read-only-config among passing checks.

Action: probe actual mounted known-readable canary input/config files, establish
their presence/readability, then require the expected permission/read-only write
denial. Report untested checks explicitly. This is a test-evidence defect, not a
claim that normal production mount flags are writable; `sandboxArguments` sets
readonly flags and inspection checks them.

## Active API and Billing Findings

Source and isolated in-memory probes reviewed on 2026-10-06 while API ownership
remains in progress. These probes exercise real exported handlers/functions with
transaction doubles; they do not establish real PostgreSQL or Stripe acceptance.
They made no network requests and used no actual credentials.

### A16 - P1: Queue fairness change prevents every queued job from dispatching

Evidence: `packages/policy-engine/src/index.ts:69` now returns canRunNow=false
whenever queueDepth > 0. `apps/api/src/catalog.ts:34` counts the queued job itself;
`apps/api/src/worker.ts:74-75` requires canRunNow to dequeue it. Job creation always
transitions NOW work to QUEUED (`jobs.ts:135`). An idle ready Worker with one
eligible reserved queued job produced `offers: [], attemptCreates: 0` in a direct
`dispatchForWorker` probe. This is an integration regression introduced by the
A10 fairness fix, not a request to remove fairness.

Action: separate buyer immediate-admission availability from serving the head of
an existing queue. Dequeue under the capability lock using current readiness,
free running capacity, schedule and queue order. Add a route-level create ->
offer regression, including maxQueue=0 and scheduled-to-queued work.

### A17 - P1: Refund after an uncertain external transfer can leave seller paid

Evidence: `apps/api/src/background.ts:79-80` sends the external transfer before
persisting stripeTransferId. A crash/commit failure leaves a PENDING row with no
ID although Stripe may have paid. `packages/billing/src/ledger.ts:114` then sets
REVERSAL_PENDING on refund; `background.ts:71-75` treats the missing ID as proof
of no transfer and marks CANCELLED. A fault-injected transaction probe produced
one external transfer, no persisted ID, then after refund/reconciliation:
`externalTransfers: 1, reversals: 0, localState: CANCELLED`.

Action: persist and reconcile transfer uncertainty before deciding whether there
is anything to reverse. Recover the external outcome using its stable operation
identity, then reverse if necessary; never infer "not sent" solely from a missing
local ID. Test external success followed by commit failure and refund before the
next reconciliation, plus process restart. Master Spec sections 24.12, 24.23 and
24.26 (exactly-once financial effects, refund and restart recovery).

### A18 - P1: Live configuration accepts a correctly signed test-mode payment

Evidence: `packages/billing/src/stripe.ts:16-17` checks signature but not mode;
`apps/api/src/billing.ts:53-67` credits without checking event/object livemode.
Production startup only checks the key prefix and presence of a webhook secret
(`policy-engine/src/index.ts:129`). A dummy sk_live adapter and an event signed
with its dummy webhook secret, `livemode:false`, credited 1000 cents and marked
the matching topup PAID in the actual webhook handler. No real Stripe call was
made. This is a mode-isolation/configuration failure, not a signature forgery;
the topup/session metadata checks must also match for a credit.

Action: bind the configured Stripe mode to webhook events and durable payment
records, reject all cross-mode events before any state change, and test both
directions including test/live account.updated events. Master Spec 24.26(17).

### A19 - P1: External topup refund is acknowledged with credits still spendable

Evidence: `apps/api/src/billing.ts:58-86` handles paid checkout, account.updated
and dispute.created, then marks every other event processed. A signed
charge.refunded for the previously credited payment was acknowledged and stored
as a BillingEvent, but left wallet available=1000, topup=PAID and created zero
compensating entries. The exported refundTopup method does not repair this
incoming-provider-event path. An operator/provider refund can therefore return
cash while leaving the same platform credits spendable.

Action: implement idempotent refund/reversal accounting with durable cumulative
amounts and an explicit insufficient-available-credit policy. Test refunds before
and after spending, duplicates, partial refunds and event reordering; do not
label unsupported financial event types successfully reconciled. Master Spec
24.13 explicitly includes refund events; 24.23 requires compensating entries.

### A20 - P1: A required named file can settle with no actual uploaded asset

Evidence: `packages/contracts/src/index.ts:298` passes optional value.assets into
field validation; `:222` skips file existence/type/size validation when that array
is undefined. A valid FILES contract with aggregate required=false and a named
required FILE report accepts `{fields:{report:<nonexistent UUID>}}` when assets is
omitted; the same output with assets=[] correctly fails. This is independent of
A08's now-changed default semantics.

The actual result-handler probe also passed: `apps/api/src/worker.ts:233-238`
looks up only top-level assets and leaves the omitted array absent. At `:248`
settlement was reached. The probe ended SUCCEEDED/SETTLED, with JOB_CAPTURE=-999,
SELLER_EARNING=800, PLATFORM_FEE=199 and zero object-storage reads. The UUID did
not identify any asset. This was an in-memory database probe, not a real payment.

Action: collect and resolve all named file references against authoritative
job/attempt-owned stored assets; pass an authoritative array even when empty.
Reject missing, foreign, expired and nonexistent IDs. Test the full result route
with omitted assets, not only the helper with an explicit empty array. Required
field delivery must hold independently of the aggregate envelope's required flag.
Master Spec 24.10, 24.26(5), 211-213 and 222-223.

### A21 - P1: Generic heartbeat clears a capability-specific validation failure

Evidence: a published version reporting passed=false sets its Worker binding
unhealthy (`apps/api/src/worker.ts:151-160`). The next generic heartbeat overwrites
it with body.sandboxReady (`:139-142`), without a new manifest-specific passing
test. The route probe recorded healthy=false after validation failure, then
healthy=true after a heartbeat even with health.capability='FAILED'. Capability
IDs also match every version of that capability, not only a tested version.
Availability trusts the restored binding (`catalog.ts:30-41`).

Action: keep device liveness/sandbox readiness separate from version-bound
capability validation and dependency health. A heartbeat must not convert an
explicit failed or never-tested version to passing. Require a fresh successful
version/manifest-bound validation to clear that failure, and test a healthy
device with an unhealthy capability. Master Spec 109, 118, 338 and 376 explicitly
distinguish these health states.

Parent-reported fixes A07/A12 and ongoing A08/A09/A10/A11 changes are not yet
independently certified. A16 specifically tests current A10 integration. Final
reaudit must rerun the old probes against the completed combined implementation.

## Historical Pre-Fix Evidence Snapshot

This table is preserved only as discovery history. Its NOT_IMPLEMENTED and
UNTESTED runtime rows are superseded by the final classifications at the top of
this document. Do not use this pre-fix snapshot to assess current readiness.

| Audited behavior | Classification | Exact evidence / limit |
| --- | --- | --- |
| Canonical fixed fee table and copied price lookup | PASS | `packages/contracts/src/index.ts:16-26`; contracts test line 14; auditor rerun passed |
| Reject unknown buyer keys, prototype field names, scalar coercion | PASS | `contracts.test.ts:22-35`; validator `index.ts:191-220`; auditor rerun passed |
| Conditional/default input semantics | PARTIAL | A07, A08 probes; required fields can be omitted |
| Output validity and named outputs | PARTIAL | A03/A08 plus current A20 result-handler probe: nonexistent required named file reaches settlement |
| JSON Schema safety | PARTIAL | A12; synchronous regex evaluation exceeds external 1.5-second deadline |
| Traversal/encoded relative-path rejection | PASS | `policy.test.ts:35-37`, `policy-engine/src/index.ts:104`; lexical checks only, not proof of sandbox isolation |
| Selected local/private IP and URL normalization rejection | PASS | `policy.test.ts:38-40`; does not certify real DNS/connection/rebinding enforcement |
| Weekly overnight and DST examples | PASS | `policy.test.ts:6-24`; specific cases pass; A11 override edge case remains |
| State machine rejects RUNNING -> SUCCEEDED and terminal restart | PASS | `policy.test.ts:45-51`; does not certify distributed recovery |
| Production helper rejects explicit development auth/fake payment | PASS | `policy.test.ts:41-43`; actual production API/Worker startup remains UNTESTED |
| Permission/dependency approval and publication closure | PARTIAL | A04/A09/A14; local snapshot checks exist, shared closure incomplete |
| Worker research/resource/executable broker execution | NOT_IMPLEMENTED | A14 explicit runtime denial; standalone broker source is not execution integration |
| Pre-acceptance payload protection | PARTIAL | A02; full input still in shared offer schema |
| Plan I/O compatibility before purchase | PARTIAL | A13 reproducible PNG-to-PDF impossible plan accepted |
| Availability/capacity admission | PARTIAL | A10/A16: API locking exists, but current queue-serving predicate prevents dispatch; A21 clears failed version health on heartbeat |
| Stripe mode isolation and provider refund accounting | PARTIAL | A18/A19 actual webhook-handler probes credit a test-mode event under live config and ignore a provider refund |
| Transfer uncertainty followed by refund | PARTIAL | A17 fault injection leaves one external transfer, zero reversals and local CANCELLED |
| Stripe, Connect transfers/refunds and crash reconciliation | UNTESTED | Source methods exist; no auditor real Stripe test-mode run or restart/replay evidence |
| Real Docker/OpenClaw input + generated-file paid flow | UNTESTED | No auditor real execution; image/dedicated inference prerequisites pending; A15 weakens self-test evidence |
| Full local failure matrix and fresh-clone acceptance | UNTESTED | Sections 570-573 require actual command/run evidence; healthy infrastructure alone is insufficient |
| Multi-job approved orchestration and final PDF | UNTESTED | Section 160 staging scenario not executed; A13/A14 are blockers |

Verification command completed successfully:

```text
pnpm exec vitest run packages/contracts/src/contracts.test.ts packages/policy-engine/src/policy.test.ts --no-cache
2 test files passed; 47 tests passed (7 contracts, 40 policy).
```

The additional direct probes are not covered by those 47 passing tests. No
production credentials or personal OpenClaw/provider credentials were accessed
or reused. No source, root coverage or other owner's files were edited.

## Historical Reaudit Checklist

The scoped code/DB reruns in this checklist have since been performed as recorded
above. Real-provider, production acceptance and complete scenario gates remain
open; this historical checklist is not an assertion that those gates passed.

- Wait for API, Worker, web and agent owners to finish integration; do not
  classify unfinished files as permanent omissions.
- Re-run A07-A13 reproductions after fixes and check their regression tests.
- Re-run A16-A21 against final API handlers, then use real PostgreSQL concurrency
  and controlled Stripe test-mode fault injection to verify the financial fixes.
- Trace actual signed API offers, accepted-attempt grants, output ownership,
  delivered-contract validation and ledger settlement across packages.
- Verify startup gating with conflicting NODE_ENV/KIVRO_ENV and test/live
  payment configuration, not only the shared helper.
- Verify immutable skill/dependency/image/config consent hashes and health
  evidence bind the exact published version; ensure buyer-safe DTOs exclude
  private paths, resource endpoints, credential references and private schedules.
- Audit concurrent capacity/budget reservation, duplicate messages/webhooks,
  stale attempts, seller/buyer suspension, revocation, pause and crash recovery.
- Run real local Docker/OpenClaw generated-file E2E with a dedicated configured
  model, Stripe test-mode acceptance, and the section 160 orchestration scenario.
- Retain UNTESTED/NOT_IMPLEMENTED for every unmet required gate; never convert
  failing or absent verification into PASS based on a status document.

## Read Progress

- Master Spec complete read: DONE; all 19,763 lines, sections 1-573 read in
  sequential chunks, including later overrides to earlier MVP optionality.
- Decisions, implementation plan, integration contract and engineering contract
  read. Requirements catalog is traceability support, not authoritative evidence.
- Source audit: final scoped A22-A28 recheck performed, with prior A01-A21
  regression evidence and explicit remaining code/scenario boundaries above.
- Automated verification: ten targeted probe executions (seven initial probes,
  two regex timing cases and one incompatible file-plan case); auditor independently
  reran and confirmed the 47 existing contracts/policy tests at that earlier
  snapshot. Additional isolated API/billing probes reproduced A16-A21 using
  real exported handlers/functions with in-memory transaction doubles. No real
  provider, live database mutation or credential use occurred in these probes;
  they are not provider/restart acceptance evidence.
- Final PASS/PARTIAL/NOT_IMPLEMENTED/UNTESTED classifications for this snapshot
  are recorded at the top. Full MVP certification, dedicated-provider acceptance
  and remaining code gaps are not declared complete.

Graphify skill was consulted. No existing `graphify-out/graph.json` was found.
No graph was generated because the user restricts writes to this audit file.
