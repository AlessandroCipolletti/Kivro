# JOB / OBS Requirement Trace

## Checkpoint

2026-10-06. This is a bounded read-only source/requirements review, not whole-MVP
certification. Production/tests, other sidecars, Master/catalog and main coverage
were not edited. The earlier audit-receipt refresh is complete; parent R01-F1
13:24 CEST evidence and historical reproductions remain unchanged.

Scope is the **146 TODO rows at 2026-10-06T11:34:20.052Z**: **139 JOB + 7 OBS**.
All 70 complete referenced Master sections were read, not only the often-truncated
catalogue fragments. Parent/other agents may have merged coverage since that
snapshot; this sidecar does not overwrite their files.

Snapshot hashes:
- Master: `a191b4db071d3d1f6f75341b92a43979d7051f9b00f65757125dc5be0e3cbec9`.
- Catalogue: `604cbeed4c9d1cb238c496bfe6a34ce0ab321d72a86022c2884d2552b2959c98`.
- Main coverage at selection: `3ce03c46ca3c562809af66472fb87ac4cb92b4e238fdbf2526e6b57811071f54`.
- Whole source mapping is 573 sections / 1701 requirements, not the obsolete 572 qualifier.

Classification: **17 TESTED, 87 IMPLEMENTED, 37 IN_PROGRESS, 5 DEFERRED**.
No TODO is automatically treated as missing code; no selected row is automatically
BLOCKED merely because real-provider/Stripe credentials are absent. The separate
Master92 external acceptance gate remains open.

The machine-readable authority for this checkpoint is
`docs/coverage-job-review.json`: exactly one row per selected ID, implementation
paths, named assertion or source-only test limits, and full-section interpretation.
TESTED applies only to the specific catalogue clause and stated boundary.
IMPLEMENTED means source exists, not completed acceptance. IN_PROGRESS distinguishes
confirmed gaps from missing trace/acceptance in its notes. Neither means all other
requirements in that section are closed.

## Actionable Findings

Four source-confirmed P2 gaps were reported immediately, without modifying code:

| Finding | IDs / Master | Exact current gap and action |
|---|---|---|
| JR-01 | OBS-0004 / 35 | `apps/api/src/operations.ts` and `capacity-telemetry.ts` report counts, active runtime/queue samples and ledger amounts, but not dispatch latency, offer acceptance rate, aggregated failure causes or refund rate. Queue wait is not dispatch latency; accepted counts are not an acceptance denominator; refunded amount is not a rate. Add defined, scoped metrics with truthful cohorts/unknowns. Local readiness/audit exists, but no dedicated sandbox-creation-failure metric was found. |
| JR-02 | JOB-0093; aggregate JOB-0091 / 375 | `operations.ts:251` counts all FAILED/TIMED_OUT, including `startedAt=null`; `operations.ts:310` and `:316` divide by succeeded+failed. A wait-only timeout therefore inflates the failure rate presented in `operations.tsx`/seller economics. Define meaningful-execution cohort and separately report prestart/platform outcomes. This is a source counterexample, not a new DB reproducer. |
| JR-03 | JOB-0056 / 127 | `apps/web/src/components/jobs.tsx` does not display seller identity in My Jobs/detail. `jobs.ts` carries sellerId for ownership but no rendered seller name. Add a safe historical seller display; do not replace pinned contracts/price with current catalog values. Other history/result/review/report functionality exists. |
| JR-04 | OBS-0011; related JOB-0082 / 376,342 | WorkerHealth capability list in `selling.tsx` shows status/reason, but not last success, current running/max and queue/max. `catalog.ts` computes runningJobs/queueDepth then drops them from the seller DTO. New section354 analytics contains historical observations, not current load. Add scoped live fields plus last-success provenance, null when unknown. Curie independently confirmed these fields are not part of the new analytics UI. |

These are reporting/presentation gaps, not a newly demonstrated sandbox, payment
or authorization bypass. The worker-health warning gap from the separate
SECURITY-REVIEW is not silently folded into these rows or certified by this trace.

**JR-A01: explicit required safety-test gap, JOB-0049 / Master78.**
`billing.ts` persists/audits `POST /api/admin/dispatch`; `jobs.ts` and
`worker.ts` check the flag at purchase, offer and acceptance. Repository searches
for `dispatchEnabled`, `DISPATCH_DISABLED`, `admin/dispatch` and global-dispatch
terms found no test that toggles the real switch and proves these disabled paths.
The only browser fixture occurrence is static overview data, not behavior.
Add an isolated regression for admin authority, no reserve on disabled purchase,
no offer, rejection of a previously issued offer, preservation of running work,
and restoration. This is an **acceptance/test gap**, not absent switch code.

## Already Present, Not Automatically Tested

- State machine, CAS/idempotency, private payload release, durable Worker state,
  process/container ownership and fail-closed recovery exist. Unit mocks are not
  actual descendant/sandbox isolation proof.
- Readiness checks and approved resource/inference/manifest dependency boundaries
  exist. Missing-secret/local-service failure-to-requeue/release joined cases are
  still trace work; these subsystems are not missing merely because rows were TODO.
- Manual/global/per-capability pause, graphical running-job pause, distinct pending
  vs confirmed state, cumulative immutable pause budget and financial hold/release
  exist. Actual computer reboot, offline web-pause/reconnect race and complete
  queued/manual-control matrices are not established by SQLite reopen alone.
- Schedule/capacity admission, FIFO, original promise, wait bounds, rescheduling
  events, prestart cancellation and release exist. This run tests real DB FIFO,
  last-slot concurrency and stale quote rejection, not every clock-close race or
  real future-only buyer browser workflow.
- Job history, current-quote Run again, safe final results and in-app polled status
  updates exist. Missing seller display is narrow; a separate notification inbox
  is not required by Master483.
- Hard orchestration budget/current revision and timing predicates exist. Mock
  concurrent executor tests are not simultaneous distinct-step PostgreSQL budget
  proof. This distinction keeps JOB-0065 IN_PROGRESS.
- Structured sanitized audit, health history and operational metrics are present.
  No end-to-end secret non-leak proof across every diagnostic/resource/research
  sink is inferred from the named redaction assertions.

## Scope Corrections

- Master9's state names are recommended; equivalent validated states are allowed.
- Master140 recommend-only Mode A requires manual purchases; one approved plan in
  Mode B does not require reprompting before every paid step. Mode C is later.
- Master375 explicitly permits one default reporting window. A 30-day default is
  not a missing mandatory 24-hour filter; 1/7/30/90 choices already exist.
- Master408's later paragraph expressly recommends starts only inside an allowed
  window for MVP. The selected strict policy is valid despite the earlier
  alternative recommendation. Optional future selectable policies: JOB-0122.
- Master412 allows weekly scheduling plus manual pause for MVP; temporary
  available-for-two-hours controls are explicitly optional.
- Master429 native desktop local UI is conditional/future: JOB-0144. Existing web
  graphical control remains required and implemented; local CLI is supplementary.
- RESTART_STEP applies only when advertised. Current runtime advertises FULL_RESUME;
  checkpoint engine/example can evolve after MVP under Master435:
  JOB-0165, JOB-0168, JOB-0169. Durable extensible state remains separately mapped.
- Master441 outside-window manual resume is recommended, not unconditional.
  Current stricter rejection is disclosed in UI; record the product choice rather
  than inventing a mandatory permissive behavior.
- Master444 requires deterministic pausable stages, not the literal illustrative
  STARTING enum. RUNNING-only pause is explicit; upload/terminal stages reject.
- Master482 minimum public events are completed/failed; extra scheduled events are
  implemented but not independently all-event tested here. Master483 email is future.
- Master506 mandatory default is IMMEDIATE; future scheduling requires explicit
  consent. No invented five-minute default: configurable bounded wait is enough.

## Independent Receipts

All times below are **2026-10-06 Europe/Zurich CEST (UTC+02)**.
No Docker, image changes, paid provider, Stripe network, browser, Next or CORS run.

**JR-U1: 13:41:08 CEST = 11:41:08 UTC**, exit0, 178 tests / 9 files.
Exact command included four nonexistent web-lib selectors; Vitest selected the
nine existing files. Those web tests were correctly run separately in JR-U2:
```sh
pnpm exec vitest run packages/policy-engine/src/policy.test.ts packages/openclaw-adapter/src/security.test.ts apps/worker/src/state.test.ts apps/worker/src/runtime.test.ts apps/worker/src/cli-controls.test.ts apps/worker/src/security.test.ts apps/web/src/lib/job-pause.test.ts apps/web/src/lib/worker-health.test.ts apps/web/src/lib/checkout.test.ts apps/web/src/lib/schedules.test.ts packages/marketplace-agent/test/orchestration.test.ts packages/marketplace-agent/test/execution-security.test.ts packages/marketplace-agent/test/agent.test.ts --no-cache
```
Runtime/adapter transport and Docker are mocked; actual temporary files and SQLite
are used. Counts are not evidence beyond each row's named assertions.

**JR-U2: 13:41:27 CEST = 11:41:27 UTC**, exit0, 13 tests / 4 files:
```sh
pnpm exec vitest run apps/web/tests/job-pause.test.ts apps/web/tests/worker-health.test.ts apps/web/tests/checkout.test.ts apps/web/tests/schedules.test.ts --no-cache
```
Pure logic, not browser tests.

**JR-D1: 13:42:11 CEST = 11:42:11 UTC**, exit0, 29 tests / 3 files:
```sh
KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/pause-budget.integration.test.ts apps/api/test/scheduling.integration.test.ts apps/api/test/containment.integration.test.ts --no-cache
```
Real isolated local PostgreSQL and API injection: 12 pause-budget, 11 scheduling,
6 containment. Fake development payments, synthetic signed Worker events, no live
Worker/runtime/provider. Test schemas cleaned by the existing suites.
Initial restricted run at 13:41:46 failed Prisma setup, 29 skipped/no assertions;
approved local-access rerun above passed. No application defect inferred from setup.

## Attributed Evidence

- Parent independently source-reviewed and ran capacity/helper/operations
  **44/44 at 13:31:02 CEST**, documented in OPERATIONS-STATUS: only bounded
  ownership/unknown attribution/retention/medians/rejection metrics.
  This auditor authored those modules and does not self-certify them.
- Feynman reported 11 actual scheduling DB cases plus 4 pure scheduling and one
  251-job fairness case, **16 PASS at 13:37:58 CEST**. JR-D1 independently reran
  the current 11 scheduling cases, including catch telemetry failure/no-funds
  behavior. This does not promote all Master354 or JOB rows.
- Curie reported **66 web-flow + 10 root browser PASS at approximately 13:44 CEST**,
  including 4 analytics and 4 capacity desktop/mobile cases. That is owner
  evidence; no real Worker browser coupling is inferred. Existing job-pause UI
  fixtures use routed synthetic HTTP responses.
- WORKER-STATUS records timing-v2 candidate `4cf5b9b2...` signed-API runtime receipt
  `293229d6-2337-46df-b991-9d7574bb7efc` at **13:33:10.930 CEST**: real Docker/
  OpenClaw, controlled inference, actual DB/S3 settlement/replay and expiry/cancel.
  Source review recognizes this scoped evidence, not an auditor Docker rerun.
  Final default image promotion/reapproval remained parent-owned at this snapshot.
  An earlier independent long-pause fixture duration assertion at 74,988ms was
  subsequently corrected in the test; no blanket successful rerun is invented.

## Exact Selection

The sidecar retains these exact selected IDs; no requirement outside them was added.

| Master section | Selected catalogue IDs |
|---|---|
| 9 | JOB-0002 |
| 19 | JOB-0009, JOB-0011, JOB-0013, JOB-0014, JOB-0016, JOB-0021, JOB-0023 |
| 29 | OBS-0001 |
| 35 | OBS-0004 |
| 36 | JOB-0026, JOB-0027, JOB-0028, JOB-0029, JOB-0030 |
| 60 | JOB-0033, JOB-0034, JOB-0035, JOB-0037 |
| 69 | JOB-0043 |
| 70 | JOB-0045, JOB-0046 |
| 78 | JOB-0049 |
| 116 | JOB-0051, JOB-0052, JOB-0053, JOB-0054, JOB-0055 |
| 127 | JOB-0056, JOB-0057, JOB-0058 |
| 140 | JOB-0062, JOB-0063 |
| 141 | JOB-0065 |
| 336 | JOB-0073 |
| 338 | JOB-0074 |
| 341 | JOB-0080 |
| 342 | JOB-0082 |
| 352 | JOB-0085 |
| 369 | OBS-0007, OBS-0008, OBS-0009, OBS-0010 |
| 375 | JOB-0091, JOB-0092, JOB-0093 |
| 376 | OBS-0011 |
| 382 | JOB-0095 |
| 383 | JOB-0096 |
| 385 | JOB-0101, JOB-0102 |
| 386 | JOB-0104 |
| 389 | JOB-0110 |
| 390 | JOB-0112 |
| 391 | JOB-0113, JOB-0114 |
| 394 | JOB-0115, JOB-0116, JOB-0117 |
| 407 | JOB-0118 |
| 408 | JOB-0120, JOB-0121, JOB-0122, JOB-0124 |
| 409 | JOB-0126, JOB-0127, JOB-0128 |
| 411 | JOB-0129 |
| 412 | JOB-0131 |
| 422 | JOB-0134 |
| 426 | JOB-0136, JOB-0137 |
| 428 | JOB-0140, JOB-0141 |
| 429 | JOB-0143, JOB-0144, JOB-0145 |
| 430 | JOB-0147, JOB-0148 |
| 431 | JOB-0150, JOB-0151, JOB-0153, JOB-0154 |
| 432 | JOB-0157, JOB-0158 |
| 433 | JOB-0160, JOB-0161, JOB-0162 |
| 434 | JOB-0165, JOB-0166 |
| 435 | JOB-0167, JOB-0168, JOB-0169, JOB-0170 |
| 436 | JOB-0171, JOB-0172, JOB-0173 |
| 439 | JOB-0178 |
| 441 | JOB-0181, JOB-0182, JOB-0183 |
| 443 | JOB-0187 |
| 444 | JOB-0190, JOB-0191, JOB-0192, JOB-0193 |
| 445 | JOB-0195, JOB-0196 |
| 447 | JOB-0200, JOB-0201 |
| 449 | JOB-0204, JOB-0205 |
| 450 | JOB-0206, JOB-0207, JOB-0208, JOB-0209, JOB-0210 |
| 453 | JOB-0211, JOB-0212 |
| 454 | JOB-0213, JOB-0214 |
| 455 | JOB-0215, JOB-0216 |
| 457 | JOB-0218, JOB-0219 |
| 458 | JOB-0220 |
| 459 | JOB-0221, JOB-0222 |
| 466 | JOB-0227 |
| 473 | JOB-0231 |
| 481 | JOB-0234 |
| 482 | JOB-0235 |
| 483 | JOB-0236, JOB-0237 |
| 485 | JOB-0240 |
| 486 | JOB-0241, JOB-0242, JOB-0243 |
| 493 | JOB-0244, JOB-0245, JOB-0246 |
| 497 | JOB-0248 |
| 506 | JOB-0250, JOB-0251 |
| 515 | JOB-0253, JOB-0254 |

## Handoff

Parent may merge the sidecar using the existing conservative merge rules after
review. No `--apply` was used here and no main coverage status was rewritten.
The separate external paid-provider/Stripe staging, supported-machine acceptance,
release/signing prerequisites and unreviewed clauses elsewhere remain distinct.
This checkpoint completes the requested JOB/OBS trace, not Kivro or its release gate.
