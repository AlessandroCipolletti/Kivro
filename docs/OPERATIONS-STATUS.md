# Cloud Operations Telemetry

Implementation handoff for R17, 2026-10-06. This is an implementation note, not
an independent audit certificate or whole-MVP completion claim. Prior audit
documents are unchanged by this batch.

## Ownership and Wiring

This batch owns only:

- `apps/api/src/operations.ts`
- `apps/api/test/operations.test.ts`
- `apps/api/test/operations.integration.test.ts`
- `apps/api/test/operations-reporting.integration.test.ts`
- `packages/contracts/src/response-operations.ts`
- `apps/api/src/capacity-telemetry.ts`
- `apps/api/test/capacity-telemetry.test.ts`
- `apps/api/test/capacity-telemetry.integration.test.ts`
- `docs/coverage-operations.json`
- this document

Parent has wired `registerOperations(app, ctx)` into API startup. There are no schema,
Worker, background, app-registration, provider or financial-write changes here.
The usage-cost extension reads parent-owned migration 016 fields
`JobAttempt.usageReceipt` and `usageReportedAt` and the shared
`WorkerUsageReceiptSchema`. Parent owns signed receipt ingestion, immutable
storage enforcement and its separate tests; Laplace owns receipt production.
Tests register the module on the actual app when it has not yet been wired.

## API Contract

`GET /api/seller/operations` uses `requireIdentity(request)` without an API-key
scope: a live, unsuspended session is required. Scope is always its user's
seller ID, never a caller-supplied ID. `GET /api/admin/operations` additionally
uses `requireAdmin`. Even an administrator's API key cannot call these routes.
The only query field is `days`, integer 1-90, default 30. Unknown query fields
are rejected. No endpoint modifies application records or calls a provider.

Both return the exported `OperationsDTO` from `operations.ts`. Curie has been
given the endpoint/type contract directly. Dates are ISO UTC strings, rates are
fractions from 0 to 1, money is integer USD cents, inference accounting is integer
micro-USD, sizes are bytes and durations are seconds. `null` means unavailable
or no samples; a genuine observed zero remains zero.

| Field | Exact meaning |
|---|---|
| `period.{from,to,days}` | Rolling duration ending at request time, not a local calendar month. All queries use one repeatable-read DB snapshot. |
| `jobs.createdCount` | Jobs created in the period. Other job outcome metrics use completion time, not this creation cohort. |
| `jobs.{terminalCount,succeededCount,failedCount,timedOutCount,cancelledCount}` | Terminal jobs completed in the period. `failedCount` includes FAILED and TIMED_OUT; timedOutCount is its subset. Cancellation remains separate. |
| `jobs.{successRate,failureRate}` | Started-terminal-job success/failure numerator divided by `executionOutcomes.decidedCount`. StartedAt must lie between createdAt and completedAt. Waiting-only failures, contradictory start timestamps, cancellations and unfinished execution are excluded; no denominator gives null. All-stage terminal counts remain unchanged and are not this denominator. |
| `jobs.executionOutcomes` | Additive meaningful-execution cohort: basis STARTED_TERMINAL_JOBS, decidedCount, succeededCount, failedCount (includes timedOutCount), excludedBeforeStartCount, excludedInvalidTimingCount and cancelledAfterStartCount. Completion time selects the period; this is one outcome per job, not a count of retry offers. |
| `jobs.{lastSuccess,lastFailure}` | Latest all-time completed success/failure through request time, scoped to seller or platform. Failure includes timeouts, not cancellations. Only job ID, capability ID, frozen version title, state and completion time are returned. Never raw errors, inputs or outputs. |
| `jobs.runtime.{sampleCount,totalSeconds,averageSeconds}` | Completed terminal executions with valid started/completed timestamps. Wall elapsed time minus persisted pause duration and any final still-open pause; floored at zero. Not CPU/GPU time or billed provider time. No samples gives null average. |
| `finance` | USD settlement/reversal entries posted in the period, joined to the job for ownership. `buyerCapturedMinor`, `buyerRefundedMinor`, `sellerEarningsMinor`, `sellerEarningsReversedMinor`, `netSellerEarningsMinor`, `platformFeesMinor`, `platformFeeReversalsMinor`, `netPlatformFeesMinor`. Refund/reversal amounts are positive display magnitudes; net fields can be negative in a refund-heavy period. |
| `scheduled` | Current SCHEDULED + RESERVED jobs; includes outstanding expired reservations not yet reconciled and identifies their count. Totals: jobCount, estimatedWorkSeconds, reservedBuyerValueMinor, estimatedSellerEarningsMinor, expiredReservationCount. These are not revenue, earned profit, promised delivery times or measured workload. |
| `scheduled.groups` | Grouped by capability ID and the current exact `scheduledAt` eligibility instant. This is an eligibility cohort, not a reconstructed complete availability window. Title is a stable representative frozen-version title. Each row includes the same totals and its capabilityId/capabilityTitle/scheduledAt. Work estimates sum each job's pinned version duration. |
| `scheduled.{totalGroups,truncated}` | Complete total-group count and explicit truncation indicator. The first 200 groups are returned in earliest eligibility order, null eligibility last; summary totals still include every group. |
| `assets.{retainedAssetCount,retainedAssetBytes,expiredUndeletedCount}` | Asset records with no deletedAt, including expired objects pending deletion. Seller scope is owned uploads plus assets associated with their sales jobs. This is retained asset metadata, not a fresh object-store inventory; staging uploads, unlinked objects and network traffic are not measured. |
| `assets.{uploadedCount,uploadedBytes}` | Asset records created in the period within that same ownership scope, including subsequently deleted assets. This measures finalized stored-asset metadata, not every attempted byte upload. |
| `assets.{downloadGrantCount,downloadGrantedBytes,downloadGrantUnknownSizeCount}` | ASSET_DOWNLOAD_GRANTED events in the period for the account or its sales jobs. Every grant counts; known nonnegative integer bytesGranted sum once per event. Invalid/missing sizes are counted as unknown, not silently represented as measured zero-byte transfers. Repeated grants can reference the same file. |
| `assets.{storageCostMicroUsd,egressBytes,egressCostMicroUsd}` | Null. A presigned download grants access; it does not prove bytes transferred. No storage/egress invoice or access-log receipt is available to this module. |
| `workers` | Current registeredCount/revokedCount, unrevoked freshHeartbeatCount/staleHeartbeatCount using heartbeat TTL, unrevoked pausedCount, sandboxReadyFreshCount and latest lastSeenAt. Fresh sandbox flag does not mean full capability/dependency/payment admission. No raw health payload or machine identifier is returned. |
| `sellerCosts` | Recorded Worker-configured cost estimates, provider/model token and call totals, explicit attempt/receipt/pricing coverage, and a contribution estimate only with complete coverage. Actual providerCostMicroUsd/providerBilledCostMicroUsd, infrastructureCostMicroUsd and final marginMicroUsd remain null. Exact semantics below. |
| `platformInference` | Null for seller responses. Admin-only accounting projection described below. |
| `manualRecoveryRequired` | Null for sellers. Admin current unresolved job-recovery-error records: full count, truncated flag, at most 200 newest items containing only jobId and sanitized code. A malformed identifier is null with INVALID_RECOVERY_RECORD; it is not silently hidden. This exposes a hold, not proof of repair or permission to alter the ledger. |
| `maintenanceErrors` | Null for sellers. Admin current maintenance-error records: full count, truncated flag, at most 200 newest items with task/code/lastSeenAt. No raw error payload. Parent clears a record after successful recovery; these current holds are independent of the selected metric period. |

No download URL, object key, filename, buyer identity, credential, internal
instructions, raw failure message, health JSON or inference prompt is returned.
The admin endpoint is platform-wide; seller aggregates never include another
seller's jobs or unassociated buyer uploads. Monetary and count projections fail
rather than silently overflowing JavaScript safe integers.

## Seller Usage Estimates

`sellerCosts` now derives estimates from actual persisted attempt receipts. It
does not replace missing receipts or unknown failed-call costs with assumed zero.
The schema is validated again at read time, including attempt-ID binding and
consistent accepted/finished/reported timestamps. Invalid records are counted
and excluded from known totals, never returned as raw JSON.

```text
reportedAttempts, attemptedCalls, successfulCalls, unpricedCalls
inputTokens, outputTokens
estimatedProviderCostMicroUsd, reservedCostMicroUsd
costBasis = WORKER_CONFIGURED_RATES
estimatedContributionMarginMicroUsd = number | null
providerCostMicroUsd = providerBilledCostMicroUsd = null
infrastructureCostMicroUsd = marginMicroUsd = null
byProvider[], totalGroups, truncated
```

Each provider/model group has the same receipt, call, token and estimate totals.
The first 200 groups are returned in provider/model order, with complete global
totals and explicit truncation. Receipts are scanned in 200-row pages within the
same repeatable-read transaction. Retries count independently; the query is not
limited to `Job.activeAttemptId`. No seller or attempt identifiers are exposed
in the cost DTO. Administrator cost totals cover all sellers; they are distinct
from administrator-only platform-agent inference accounting.

The attempt cohort requires acceptedAt at or before the snapshot end and either
acceptedAt or finishedAt within the inclusive reporting period. Unaccepted
offers, future acceptances and attempts entirely before the period are excluded.
An attempt accepted before the period but finished within it is included.
Unfinished accepted attempts are visible as incomplete coverage. A receipt
reported after the snapshot end is missing for that snapshot, not retroactively
priced. These reporting estimates are not an invoice-period accounting system.

`coverage` contains:

```text
acceptedAttempts, finishedAttempts, unfinishedAttempts
missingReceiptAttempts, invalidReceiptAttempts, unpricedAttempts
earningsJobsOutsideCohort, receiptRate, complete
```

`receiptRate` is valid reported receipts / cohort accepted attempts; it is null
for no accepted attempts. It can be 1 while pricing remains incomplete:
`unpricedCalls` explicitly retains failed/ambiguous calls without a confirmed
usage estimate. The receipt's reservedCostMicroUsd is uncertainty/budget
reservation, not a measured expense, and is never added to estimated spend.
A genuine zero-call receipt is a valid observed zero, unlike a missing receipt.

`complete` requires at least one accepted attempt, every included attempt
finished and validly reported, no unpriced calls, and no earnings jobs outside
the cost cohort. That last guard detects USD seller earnings/reversals posted in
the period for jobs with no accepted attempts or with accepted attempts outside
the cohort. Even net-zero legacy earnings/reversals cannot hide missing cost
coverage by cancelling each other out.

Only with `complete=true` is estimatedContributionMarginMicroUsd computed as
`finance.netSellerEarningsMinor * 10000 - estimatedProviderCostMicroUsd`.
It can be negative. Net seller earnings already exclude the platform fee; the
fee is not subtracted again. This is an estimated contribution after recorded
provider usage, not final profit, invoice-confirmed provider spend or a claim
that infrastructure cost is zero. Incomplete/no-sample estimates remain null.
Reason is WORKER_RATE_ESTIMATE_ONLY, INCOMPLETE_USAGE_COVERAGE or
NO_ACCEPTED_ATTEMPTS as applicable. Curie has the exact exported
`SellerUsageTotals` and `SellerCostOperations` DTO and these display semantics.

## Platform Inference

The actual cloud accounting source is `PlatformSetting` keys starting with
`inference-request:` written by `apps/api/src/agent.ts`. There is no standalone
inference cost table. The daily `platform-inference:` budget counters already
include these requests and must never be added again.

The admin DTO includes complete totals and provider/model groups:

```text
finishedCalls, succeededCalls, failedCalls, unsettledCalls, invalidRecordCount
recordedCostMicroUsd
successfulUsageCostMicroUsd
failedCallBudgetChargeMicroUsd
reservedBudgetMicroUsd
costBasis = CONFIGURED_RATES_AND_FAILURE_BUDGETS
providerBilledCostMicroUsd = null
byProvider[], totalGroups, truncated
```

FINISHED rows use their final updatedAt within the selected period. Success
amounts are accounting estimates from configured token rates; failed calls can
charge their entire uncertainty budget. These are not verified provider invoices.
All still-RESERVED request records through request time are included even when
older than the period, since they are outstanding budget exposure, not finished
spend. Malformed accounting records increment invalidRecordCount and do not
fabricate an amount. The grouped list is capped at 200 with explicit truncation;
totals remain complete. Records are scanned in bounded 200-row batches inside
the same read-only snapshot. Raw metadata and account IDs are never returned.

## Health and Future Hooks

Parent now owns WorkerDevice.healthStatus, sanitized WORKER_HEALTH transitions
in AuditEvent with sellerId/workerId and metadata previous/status/reason, plus
90-day retention. Worker API returns that history, so operations does not copy
it or falsely claim there is no history. Parent also owns ASSET_DOWNLOAD_GRANTED
creation after signed URL issuance and its 90-day retention. No hook is added
by this module; absent historical events cannot be backfilled from current state.

Parent-owned durable, immutable attempt receipts now supply estimated seller
provider usage. Actual invoice reconciliation and infrastructure accounting
remain separate unknown inputs; configured rates alone cannot establish them.
Keys, prompts and private resource content stay out of the receipt schema.
Actual transfer bytes still need object-store access-log/receipt ingestion, not
presign counts. Any future health summary should use the parent's retained
transitions and classify stale heartbeat in the background, not generate events
on this read endpoint.

At larger scale, indexed dedicated inference-accounting rows and aggregate
rollups would avoid scanning the JSON settings store on each admin request.
They require a separate parent-owned schema/background change. Current queries
have a bounded 15-second read-transaction timeout; no sampled/truncated total is
returned as a complete aggregate.

## Verification

Focused unit tests cover bounded query/scope input, separate inference success,
failure and reservation accounting, malformed or missing cost values, safe
integer overflow and private metadata projection. Real-DB tests use explicit
synthetic metric fixtures, not execution, S3-transfer, financial settlement or
live-provider proof. They exercise actual app session/admin/API-key auth, seller
isolation, completion cohorts, pause subtraction, refunds versus reserved value,
asset bytes, grant counts, current Worker state and platform accounting rows.

Receipt-extension focused command at 11:38:58 Europe/Zurich (09:38:58 UTC):

```text
KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/operations.test.ts apps/api/test/operations.integration.test.ts --no-cache
```

Result: 26 PASS (10 unit + 16 real-DB cases). This includes complete totals across
201 inference rows and 201 scheduled groups, explicit 200-group truncation,
admin-only recovery/maintenance visibility and cleared-record readback. New
receipt cases cover multiple attempts, accepted/completed period boundaries,
ownership isolation, recorded token/call/cost sums, missing/misbound receipts,
unfinished attempts, unpriced calls even with 100% receipt coverage, zero-call
receipts, late reporting, negative contribution after refunds, legacy/prior-period
earnings mismatches, and full 201-receipt totals with bounded provider groups.
Unit cases additionally reject unsafe monetary sums and contradictory timestamps.
Scoped ESLint passes for all three TypeScript files, and the API-wide typecheck
passes (exit 0). These fixtures persist receipt JSON directly to test reporting;
they are not proof of signed Worker ingestion or genuine provider consumption.
No live inference, Stripe, object transfer or browser execution was performed
here. Parent's concurrent full-integration run observed the old sellerCosts
expectation while this file was being updated; the final focused run includes
the new expectation and passes.

Fixture cleanup correction: the first six-case run left three synthetic RESERVED
jobs without funded wallets. All subsequent runs explicitly terminalize their
own synthetic reservations during teardown; no financial records are deleted.
A read-only lookup identified the first-run leftovers and reported them to parent:
`2337823f-e3da-4db4-a6f2-ef1e8982d9f4`,
`6cb18732-8e1e-485b-9773-4c59fe087b6f`,
`cb34f563-12d7-439e-a22b-073554c62e5f`.
They belong to the first `operations.kivro.local` fixture account, not real
marketplace funding. They were not marked recovered by this module.

Parent owns final UI rendering, migrations and global verification. No prior
independent-audit PASS status is changed by this implementation batch.

## Section 354 Capacity Analytics

Owner implementation extension, 2026-10-06. Not an independent audit or a claim
that all availability acceptance tests pass. No schema migration is needed:
the helper reuses AuditEvent and PlatformSetting. Feynman owns createJob and
background registration outside this batch; Curie owns rendering. The two
independent-audit documents are not edited by this implementation owner.

The existing seller/admin routes add optional `OperationsDTO.capabilityAnalytics`.
The live backend supplies it, but optional typing preserves existing fixtures
and permits a staged UI update. Seller identity is still session-derived and
admin access still requires an admin session. Neither query parameters nor
API keys can broaden scope. Analytics include no buyer IDs, purchase keys,
private inputs, worker identifiers or raw failure messages.

The exported contract lives in `capacity-telemetry.ts`:

```text
CapabilityAnalyticsDTO:
  method = BOUNDED_PREVIOUS_OBSERVATION
  maxObservationGapMs = 120000
  disconnectFailureBasis = RETAINED_PLATFORM_RECONNECT_EXPIRY_EVENTS
  totalCapabilities, truncated, items[]

CapabilityAnalyticsItem:
  capabilityId, capabilityTitle
  durations: onlineMs, busyMs, offlineMs, scheduledOfflineMs, pausedMs, securityBlockedMs
  coverage: eligibleMs, observedMs, unknownMs, ratio
            firstObservedAt, lastObservedAt, observationCount, invalidObservationCount
  jobsAccepted, acceptedAttempts
  queueFullRejects, queueFullCoverageFrom
  queueWait: sampleCount, medianSeconds, excludedCount
  execution: sampleCount, medianSeconds, excludedCount
  disconnectFailures
```

Each duration is a mutually exclusive catalog-availability state, not hardware
uptime. ONLINE excludes BUSY; scheduled-offline, paused and security-blocked time
are kept separate, not relabeled disconnected. The previous observed state is
attributed only between two observations at most 120 seconds apart. This is a
bounded sampling estimate: unobserved changes within a sample interval are not
reconstructed. There is no extrapolation before the first observation, after
the last observation, or across a larger gap. A restart can preserve a timely
interval because its checkpoint is durable; a long restart gap remains unknown.
Capability creation and the requested period bound eligible time. Zero elapsed
eligibility gives null coverage ratio. A never-observed capability has zero
observed duration and its entire eligible period unknown, not zero uptime.

`recordCapacityObservation` atomically writes the event and checkpoint under a
per-capability advisory lock. Duplicate/stale sample timestamps do not change
either. Malformed checkpoints restart coverage without inventing a prior state;
malformed retained intervals count as invalid and contribute no duration.
`reconcileCapacityTelemetry` claims up to 100 published capabilities via a
persisted UUID cursor, then observes each in its own transaction. A failed
capability does not block the rest of the page; the independent maintenance task
receives a sanitized failure. Concurrent invocations and process restarts keep
advancing the cursor. Missed sweeps appear as reduced coverage, not inferred
uptime. The helper retains its two event types for configured operational audit
retention (default 90 days), without deleting financial records.

Queue timing is first authoritative `queuedAt` to first `startedAt`, selecting
jobs that started in the period. It does not count the original future scheduled
reservation as queue waiting before first eligibility. Execution timing selects
terminal jobs completed in the period and subtracts persisted accumulated pauses
plus a final still-open confirmed pause from start-to-completion elapsed time.
Missing/reversed timestamps, impossible pause totals, and ambiguous pre-start
pause attribution are excluded explicitly. In particular, a paused legacy job
without retained PAUSED evidence is not silently assumed to have paused only
after execution started. The median is PostgreSQL percentile_cont(0.5), including
the midpoint for an even sample count; no samples returns null, not zero. These
are elapsed active phase durations, not CPU time. The previous average-runtime
field is unchanged; the new medians use stricter attributable-sample coverage.

Accepted jobs are distinct jobs with an accepted attempt in the period;
acceptedAttempts also counts retries. Offered but unaccepted attempts do not
count. Disconnect failures count completed FAILED jobs with a retained
PLATFORM-authored reconnect-expiry JobEvent. Arbitrary Worker failure text does
not qualify, and missing/expired event evidence cannot reconstruct older causes.

`recordQueueFullRejection(ctx,buyerId,capabilityId,purchaseKey)` is called only
after the purchase transaction has failed with CAPABILITY_QUEUE_FULL. It derives
seller ownership from the capability and writes a deterministic event ID from
buyer/capability/purchase-key identity. It stores neither the raw key nor input.
One rejected purchase key counts once across concurrent retries and restarts,
not once per HTTP retry. Deduplication lasts for the retained event's lifetime;
replaying after retention can produce a new observation. The global tracking
start marker and retention bound `queueFullCoverageFrom`; before this point the
absence of events does not prove zero rejections. A null marker means no known
tracking start. The createJob caller must catch telemetry errors and rethrow the
original 409; insufficient-funds and other errors must not invoke this recorder.
The helper does not touch wallets, jobs, reservations or the ledger.

Only the first 200 capabilities in stable ID order are returned, with a complete
capability count and explicit truncation. Their duration/sample queries aggregate
all retained evidence for those capabilities; they are not limited to 200 jobs.
The read-only operations transaction remains bounded by its existing timeout.
At larger scale, a parent-owned index on telemetry event type/time and capability
identity or dedicated rollups could improve performance. No schema change is
required or performed for the current bounded batch. No uptime ranking or
admission-policy change is made.

### Owner Verification

```text
KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/capacity-telemetry.test.ts apps/api/test/capacity-telemetry.integration.test.ts apps/api/test/operations.test.ts --no-cache
```

2026-10-06, start 13:28:24 CEST / 11:28:24 UTC: exit 0, 27 PASS
(3 identity unit, 14 new isolated-PostgreSQL, 10 existing operations unit).
The DB fixture migrates a fresh random schema and drops only that schema. No
personal environment file, provider, shared public-schema state, API server,
object storage, browser or Docker runtime is used. Tests exercise durable
restarts/concurrency, unknown first/gap/trailing periods, exact 120-second limit,
creation/window/retention bounds, corrupt evidence, queue rejection dedup and DB
failure rollback, pause-aware medians, distinct accepted jobs, disconnect source
attribution, actual seller/admin/API-key route authorization, and fair traversal
of more than 200 capabilities despite a malformed capability. Scoped ESLint and
API typecheck passed after an unrelated capacity-test type error was corrected
by its owner. Actual purchase-catch/background integration and UI acceptance
remain separately owned and are not inferred from these reporting fixtures.

## JR01 / JR02 Reporting Handoff

2026-10-06 implementation-owner checkpoint, not independent certification.
`operations.ts` and `response-operations.ts` are frozen after the receipt below.
Parent owns the global response registry/hook. The browser-safe response group
exports two GET descriptors, full nested strict seller/admin DTO schemas, and
the additive `executionOutcomesResponseSchema` / `operationsReportingResponseSchema`.
The latter two are optional for compatibility with clients serving an older DTO;
the current backend always populates them. Unknown invoice/network costs still
require literal null. Signed net earnings/contribution remain permitted.

`reporting` contains the following exact metric cohorts:

- `dispatchLatency`: FIRST_OFFER_MINUS_INITIAL_QUEUE_WALL_TIME. Select jobs
  whose first-ever attempt creation is in the inclusive period. Retry offers do
  not duplicate jobs or replace their first-offer time. Initial queuedAt must
  lie between job creation and that offer. Return cohortJobs, sampleCount,
  missingQueueTimestampCount, invalidTimelineCount, averageSeconds and
  medianSeconds. Wall waiting after initial queuing can include a subsequent
  pause or schedule change; this is not active processing or network latency.
- `offerAcceptance`: ACCEPTED_OR_EXPIRED_OFFERS_CREATED_IN_PERIOD. Retries are
  independent offers. acceptedCount / denominatorCount, where the denominator
  is acceptedCount + expiredUnacceptedCount. Withdrawn-before-acceptance,
  pending and unknown/contradictory offers are separately counted, not treated
  as Worker refusal. Future acceptance does not alter an earlier snapshot.
- `failures`: RETAINED_TERMINAL_EVENTS. All completed FAILED/TIMED_OUT jobs in
  the period, with fixed allowlisted reason/source groups, knownReasonJobs,
  unknownReasonJobs and missingEventJobs. The allowlist checks both platform
  message and authoritative source. It never returns arbitrary event messages,
  raw Job.error, inputs or credentials. Missing/pruned event evidence remains
  unknown even when a private raw error is still stored.
- `cancellations`: completed CANCELLED jobs split into platformJobs,
  accountJobs, workerJobs and unknownSourceJobs. These are not failure-rate
  numerator or denominator members. Event retention can make source unknown.
- `refunds`: JOBS_WITH_FIRST_USD_CAPTURE_IN_PERIOD. Count jobs with a first
  posted USD JOB_CAPTURE in the period and any posted positive USD REFUND by
  the snapshot end. refundedJobs / denominatorJobs uses coherent one-capture,
  at-most-one-refund histories with matching buyer ownership. Duplicate or
  contradictory records are unknownOutcomeJobs, excluded from that rate.
  periodRefundsOutsideCohortJobs, periodRefundsWithoutCaptureJobs and
  invalidLedgerRecordCount remain explicit. Top-up refunds and reservation
  releases are not job refunds. This is a posted-record cohort metric, not
  ledger reconciliation, Stripe charge/refund rate or invoice attestation.

All queries retain session-derived seller ownership or explicit admin scope,
one repeatable-read snapshot, fixed-size reason categories and bounded response
groups. No financial writes, migration, Worker or background changes were made.
Curie received the final DTO and reports consuming executionOutcomes for rate
labels/denominators; that UI report is attributed, not independently verified
here. Detailed JR01 reporting views remain a separate UI integration task.
Local sandbox-creation-failure telemetry from section 35 is not implemented by
this cloud reporting batch. Do not promote all of section 35 or 375 from this
receipt alone, or infer whole-MVP acceptance.

### Focused Receipt

```text
KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/operations-reporting.integration.test.ts apps/api/test/operations.integration.test.ts apps/api/test/operations.test.ts apps/api/test/worker-warnings.test.ts apps/api/test/worker-warnings.integration.test.ts --no-cache
```

2026-10-06, start 14:14:45 CEST / 12:14:45 UTC: exit 0, **60 PASS**:
12 new isolated-PostgreSQL reporting cases, 18 existing operations API/DB cases,
10 operations unit cases, 14 warning unit cases and 6 warning PostgreSQL cases.
The 12 reporting cases cover meaningful-execution exclusions, null no-sample
rates, first-offer deduplication, offer decision denominators, inclusive
boundaries, future-record exclusion, all eight fixed failure categories,
unknown/pruned event evidence, distinct cancellation sources, matched refund
cohorts, malformed/duplicate ledger evidence, seller/admin scope and strict
response schemas. Synthetic ledger fixtures prove read-model behavior, not a
real payment-provider transaction. Existing operations fixtures use unique
identities in the local development database; the new reporting and warning
suites migrate and drop only their own random schemas.

```text
KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/operations-policy.integration.test.ts -t 'retains sanitized health transitions' --no-cache
```

Start 14:14:49 CEST / 12:14:49 UTC: exit 0, **1 PASS, 15 unselected/skipped**.
This confirms the existing scalar health transition behavior alongside the
additive warning observer; it does not prove warning HTTP/Worker/UI integration.
API and contracts typecheck plus scoped ESLint passed on this source. No
browser, Docker, external inference or Stripe request was run for this batch.
