# Authoritative Remaining Requirements Inventory

Status: BOUNDED R24 REMAP, 2026-10-06. Superseding checkpoints distinguish current repairs from historical reproductions. Whole-MVP acceptance remains open. Not release approval.

## Authority and Method

`spec/MASTER-SPEC.md` is the scope authority. Catalog priorities, old status
documents and coverage TODO counts do not override its actual wording. A
normative catalog item can be a truncated list introduction; its complete source
section remains necessary. Examples do not mandate their particular product,
library, command spelling or values. Later explicit requirements qualify earlier
scope summaries. Recommendations are identified as such, not silently treated
as either mandatory implementation or automatic deferral.

A read-only, fence-aware structured mapping found exactly 573 numbered Master
sections and 1,701 unique catalog IDs: 1,672 heading entries plus 29 DEV-LOCAL
table entries. All IDs resolve to a real section, with no duplicate ID. All 573
Master sections were identified. The original snapshot had only 572 directly
mapped sections; parent has since corrected DEV-LOCAL-002 to reference both 552
and 554 (pinned Redis and health check). Independent read-only sourceCoverage now
returns 573/573 directly mapped, 1,701 unique IDs, no unknown/missing sections
or duplicate IDs. This was a traceability correction, not absent Redis code.
Section 1 uses a level-two heading; sections 2-573 use level one.
Catalog prefixes include PRD, WRK, JOB, IO, SEC, CAP, PAY, AVL, OBS, API, TST, OPS,
AGT and UI. A parser restricted to PRD or level-one headings is incomplete.

Current source SHA-256 (after parent-authorized DEV-LOCAL-002 correction):

- Master: `a191b4db071d3d1f6f75341b92a43979d7051f9b00f65757125dc5be0e3cbec9`
- Catalog: `604cbeed4c9d1cb238c496bfe6a34ce0ab321d72a86022c2884d2552b2959c98`

Original catalog snapshot: `06b61c77924469a76e41a0b638d7f91c94f06c38e1cadd7d388df13dce971564`.
The Master was not changed. Multi-source curated IDs must preserve every source
clause; their one existing baseline range does not erase the second attribution.

Evidence states are PASS (the stated behavior is implemented and verified),
PARTIAL (specific implemented subset and remaining acceptance), NOT_IMPLEMENTED
(source inspection establishes an absent required path), and UNTESTED (not
enough evidence yet, including an unreviewed clause). Scope is a separate axis:
REQUIRED_MVP, RECOMMENDED, EXAMPLE, or EXPLICIT_FUTURE. Only explicit future
behavior is eligible for DEFERRED without a new owner scope decision. A mixed
section cannot be deferred because one of its paragraphs discusses the future.

## Confirmed Scope Corrections

- Password recovery and email verification are not explicit Master requirements.
  They must not be invented as blocking MVP omissions. The Master does require
  authenticated account/authorization behavior; its security boundaries still
  require independent verification. Section 483 explicitly separates required
  in-app notifications from recommended future/email notifications.
- Section 6 is a suggested stack, including CLI-first Worker and optional later
  desktop UI. A missing native desktop shell is not by itself a missing MVP.
- Section 3's early exclusions are not a blanket deferral for later explicitly
  specified API/webhook, orchestration, file or resource behavior. Classify the
  later clauses directly.
- `SECTION_COVERAGE` rows include all behavior in their source sections, not just
  nearby atomic catalog fragments. An existence-only coverage script cannot
  establish that these sections pass.
- Sections 557/570 do not independently require externally paid LLM inference.
  Actual supported OpenClaw with deterministic inference/development payment
  can supply local-runtime evidence; 570 permits an equivalent command. Keep
  92's real provider/test-payment staging and 564's Stripe acceptance separate.
  Section 563 still requires the buyer-browser-to-real-Worker path; separate
  API/runtime and UI-response fixtures do not prove that combined path.
- Section 571 requires a clean supported-Mac clone/bootstrap through a complete
  job, not literally a second physical machine. Same-host source-copy/isolated
  boot evidence is partial, not proof of the whole clean-environment checklist.

## Reading and Classification Progress

Structured mapping: 573/573 sections and 1,701/1,701 IDs parsed. Current fresh
full-text reread: all sections 1-573 completed. The catalog was read and parsed in
full, including all prefixes, normative fragments and curated rows; future and
recommendation fragments were rechecked against their complete source context.
The matrix below replaces the initial blanket UNTESTED default. Each ID maps by
its catalog Source to exactly one matrix row; named atomic overrides take
precedence. PARTIAL is not shorthand for missing code: the evidence key and
remaining finding distinguish implemented behavior from the specific residual.

Parent's pre-inventory baseline: 371 unit tests, 75 integration tests, 24 browser
tests and optimized build passed; seven migrations applied. These are attributed
run totals, not proof that all 1,701 requirements are implemented. Known tested
scopes and their exact receipts remain in `docs/INDEPENDENT-AUDIT.md`.

## Active Ownership

- Feynman: API capability version lifecycle and catalog.
- Curie: web matching, results and date overrides.
- Laplace: Worker import dependency closure.
- Parent: auth/security foundation and traceability/coverage scripts; R03 terms,
  R04 direct S3 and R05 CI after the account/provider configuration batch.
- Ramanujan: R01 buyer payment methods/receipts in billing package/API.
- Laplace additionally owns R02 background Worker installation.
- Auditor: current R24 phase owns these two audit documents only, with no source,
  test or coverage edits. The separately authorized R17 operations implementation
  phase is complete; its own 26-test receipt is implementation-owner evidence,
  not independent self-certification.

## Current Bounded Checkpoint

This section supersedes absent-code wording in the historical R01-R24 snapshots
and the baseline matrix below. It does not promote whole sections or change the
catalog/coverage files. Master is unchanged; current catalog hash and all-source
mapping above include parent's authorized correction. Only the named assertions and fixtures in the
following receipts are verified; current shared code can change after each run.

### Superseding R08 and Operations Scope

**R08-F2 and R08-F3 are closed for the named repairs**, superseding their
historical open-P1 rows below. Independent auditor source/test review and actual
execution on **2026-10-06, start 13:04:20 CEST / 11:04:20 UTC**, exit 0:

```sh
KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/ledger-provenance.integration.test.ts apps/api/test/billing-containment.integration.test.ts --no-cache
```

**77 PASS: 37 ledger-provenance + 40 billing-containment.** Exact per-job history
now gates release/settlement/refund; an unfunded equal/smaller job cannot consume
another job's reservation. Monotonic collection identities incorporate legacy
history and survive a second 499-cent debt cycle, partial funding, restart and
concurrent replay. These are real isolated-PostgreSQL and synthetic signed-Stripe
fixtures. No new blocker was found in that bounded scope; no live Stripe or
whole-financial-section acceptance is claimed. Parent's separate 13:24 R01-F1
checkpoint below is preserved without changing its attribution or limitations.

Section354 / AVL-0019 analytics now has an implementation-owner module for
bounded capability-state observations with unknown-time coverage, durable
queue-full rejection events, phase medians, accepted-job counts and retained
platform disconnect evidence. Owner27 PASS is not independent certification.
Parent separately reports **44/44 PASS at 13:31:02 CEST / 11:31:02 UTC,
2026-10-06** (3 capacity units,14 capacity DB,10 operations units,17 operations
DB) plus a no-blocker bounded source review. The helper/API/test snapshot is
frozen. Feynman now reports actual purchase-rejection catch and independent
background registration landed; their regression tests remain in progress and
are not verified here. Curie's additive analytics UI is separately pending.
Thus the previous blanket absence of this reporting module is superseded, but
the whole section remains PARTIAL/IN_PROGRESS. No ranking penalty or schema
change was introduced, and no unrelated browser receipt closes these hooks.

### Actionable Implementation Residuals

Superseding 13:24 CEST checkpoint: **R01-F1 is implemented and independently
verified for the final 29 canonical-recovery fixtures**. The former absence of
periodic Checkout/topup/refund/dispute discovery and completed-transfer comparison
is no longer current. See `INDEPENDENT-AUDIT.md` and `BILLING-STATUS.md` for exact
read bounds, durable recovery, ambiguity holds and actual-PG/synthetic-provider
limits. Real Stripe-account acceptance remains unrun. Parent's migrations
019/020 now implement explicit USD and immutable financial interpretation;
021/022 implement cumulative pause limits and explicit single-job resume under
global pause. Their scoped tests do not certify the ongoing Worker, scheduling,
capacity configuration or availability-analytics batches. The table below is
retained as the historical finding/reproduction record, not a new assertion that
these repaired paths are still absent.

| Priority / finding | Exact remaining behavior and evidence | Ownership / acceptance |
|---|---|---|
| P1 R01-F1 periodic provider recovery | PAY-0042 / 24.14. `background.ts:115,176-179` scans pending/processing/reversal transfers and canonical payouts, not topups/refunds/disputes or already-TRANSFERRED records. `stripe.ts:127-131` reads intent/charge only for receipts; `billing.ts:530-578` is manual uncertain-transfer resolution. | PARTIAL overall reconciliation; named missing recovery families are actual absent code, not credentials. Add bounded canonical discovery/comparison, durable progress and replay/ambiguity handling. Do not rebuild existing payout backfill or weaken R08 containment. Source-reviewed, not a newly induced real-provider incident. |
| P2 R01-F2 financial distinctions and policy | PAY-0084-0088 / 288; PAY-0044/0045 / 24.16; PRD-0296-0299 / 287. Current price/ledger path distinguishes retail/seller/marketplace fee but has no explicit tax/buyer-total/processor-cost treatment. Optional web buyerTotalMinor is not backend implementation. | Concrete internal modeling/policy residual. Section 288 requires the distinctions, but a tax engine, exact rates and Stripe Tax depend on legal applicability. Explicit processing-fee bearer decision/presentation remains; do not invent charges, invoice costs or mandatory tax-provider integration. Public legal approval is separately external. |
| P2 R01-F3 currency model discrepancy | PAY-0048 / 24.19-24.20: `schema.prisma:134,587,628` Wallet/Topup/SellerTransfer monetary fields have implicit USD; LedgerEntry, priceSnapshot, dispute and payout currencies exist. `billing.ts:303` synthesizes USD for receipt DTOs. | PARTIAL model completion, not absent multi-currency checkout or demonstrated currency loss. Store explicit USD if following the literal recommendation; 24.19 is headed MVP recommendation, so do not inflate it alone into an unconditional P1 gate. Map 24.20 semantics to existing financial records instead of requiring a duplicate table by name. |
| R08-F1 commit-first containment verified for named paths | Admin cap/device/account and seller Worker controls use immutable migration 018 and `job-containment.ts`; latest six containment cases pass at 10:27:34 UTC. Ramanujan's dispute/refund batch independently passes 53 cases at 10:29:59 UTC: `disputes.ts:34-58` and `billing.ts:434-472` commit holds/receipt before releases; stored-receipt replay drives follow-up. Source: 78 JOB-0048/JOB-0049; 79 SEC-0063/0064; 371 CAP-0110-CAP-0113; 393. | The original rollback concern is closed for named assertions, not every financial invariant. Two new independently reproduced failures below remain actionable. No blanket financial/security PASS. |
| P1 R08-F2 unfunded job consumes pooled reservation | `packages/billing/src/ledger.ts:113-123` checks pooled wallet balance, not per-job JOB_RESERVE provenance. At 10:31:25 UTC, separate actual dispute/refund webhook probes each returned 200 but released an unfunded 99-cent job sorted first; the legitimate 99-cent job then received LEDGER_INVARIANT. Damaged JOB_RESERVE=0/JOB_RELEASE=1, healthy JOB_RESERVE=1/JOB_RELEASE=0, pooled reserve=0. | Required implementable financial isolation repair, not external acceptance. Validate each job's reserve/history before mutation, quarantine damage and preserve healthy release. Existing test uses damaged USD_999 versus healthy USD_99 and misses equal/smaller-price ordering. Regress both orders; no invented reserve history. Companion audit has exact reproduction. |
| P1 R08-F3 repeated refund-debt balance collides | `packages/billing/src/ledger.ts:87` keys collection only by remaining debt. Actual webhook probe at 10:33:49 UTC: settle 998 cents; cumulative refund 499, fund/collect 499; increase cumulative refund to 998, fund another 499 and replay. Second collection returns 409 ALREADY_EXISTS, debt=499 and available=499, because `topup:<id>:debt:499` already exists. | Required implementable recovery repair, not Stripe credentials. Use durable monotonic collection identity with exact-once balanced replay. Regress multiple refund increases repeating the same debt balance and concurrency. Manual restoration uses the same helper, so it is not an alternative recovery path. No deletion/suppression of immutable history. |
| R08-F4 narrow staging-cookie fix verified | `config.ts:21,28` derives secureSessionCookies from production OR canonical HTTPS WEB_ORIGIN; `auth.ts:75` uses it without request-header trust. Independent 10:49:42 UTC actual isolated-DB staging login case PASS and 10:49:54 UTC config 37 PASS. | Closed for this defect: Stripe-test staging emits Secure/HttpOnly/SameSite=Lax despite forwarded HTTP; local HTTP ignores spoofed forwarded HTTPS. Production/live-key restrictions stay enforced. No global environment-separation/Worker-display/TLS deployment acceptance or real Stripe claim. |
| P1 R21-F1 pause/deadline consistency | Master 438 JOB-0174 and 439 JOB-0177 permit resume/reservation retention within allowed pause. API `background.ts:59,63-65` subtracts pause and separately caps it at 15 minutes; Worker `state.ts:56`/`runtime.ts:165-177,258-277` keeps its absolute execution deadline running. Independent two-case run at 10:43:43 UTC confirms a 30-second job times out after only 5 running + 25 paused seconds. | Actual cross-layer conflict, not a newly invented runtime guarantee or proof the latest timer introduced it. Worker docs state the wall policy, but that does not resolve the Master/API mismatch. Tests use fake time and mocked Docker. OpenClaw `--timeout` plus runner timer also need investigation; host-only extension is not certified sufficient. Laplace owns focused investigation; retain bounded pause expiry and safe readiness failures. |
| P1 R16 active Worker integration/acceptance | The earlier snapshot lacked actual reviewed public-prefetch wiring. Laplace now reports real OpenClaw public HTTPS prefetch followed by private snapshot read/cache-only lookup on a separate research image; do not retain a blanket absent-wiring claim. Owner still names diagnostic seller identity/trusted HTTP cancellation dependencies and no combined PostgreSQL/full-stack receipt. Source: 254-255 PRD-0233-PRD-0235; 261 PRD-0245-PRD-0247. | Active owner batch, not independently ready-audited. Verify immutable plan/attempt/version binding, public-before-private execution, cached ID-only calls, seller-narrowed limits and safe cancellation with no private-derived outbound text. A smoke receipt is not full combined-resource acceptance; neither is this merely external credentials. |
| P2 R17 research audit detail, pending owner handoff | Earlier `ResearchAccounting.finish` dropped destination/outcome/byte/query evidence and `state.ts:42` stored only event/source/job/time. This was source-confirmed for 254 PRD-0233/PRD-0234; current active edits are not re-audited in the example batch. | Laplace research batch. Verify safe operation/destination/outcome/size and blocked reason without raw queries/private payloads. The example's precise field spelling is not a literal schema mandate. Health history, routing audit and seller receipt reporting are already implemented, not this gap. |
| P2 R18 discovery/observed dependency provenance | `discovery.ts:66-109` reads only config defaults.model and plugin entries plus declared skill metadata, not safe agent/tool/MCP/workspace-reference/environment metadata from 104. No seller-test observed-dependency report was found. Source: 104 AGT-0023-AGT-0027; 105 CAP-0022-CAP-0025; 118 CAP-0049-CAP-0051. | Worker owner notified. Selected transitive skill import, exact reviewed broker binding and CLI dependencySuggestions already exist and independently pass; do not rebuild them or require a native GUI. Add safe metadata/provenance and reviewable observed usage without copying personal files, auth stores, secrets or silently granting permissions. |
| P2 R15 remaining doctor checks | `readiness.ts:35-59` now checks Node/SQLite availability, signed device/cloud/clock policy, Docker and inference. It never inspects scanRuntime.configReadable or emits a dedicated writable-Worker-DB result from the 57 check list, WRK-0071-WRK-0073. Constructor/write exceptions are not a structured diagnostic. | Worker owner notified. Add bounded readable-config and DB write diagnostics with safe guidance; distinguish an unused absent personal config from a broken security prerequisite. Existing fail-closed runtime checks must remain. |
| R18 provider/UI mismatch, narrow fix landed | Initial direct invocation reproduced the stale openai-compatible-only guard at `apps/web/src/lib/worker-policy.ts:36`, inconsistent with adapter support. Curie changed it to openai-compatible/anthropic; independent repeated invocation now returns no issue for anthropic and a rejection for an unknown transport. Source: 99 AGT-0009-AGT-0014; 108 CAP-0026-CAP-0032. | The reported guard defect is fixed, not an active implementation omission. Curie reports 84 web units at 11:48 CEST; narrow independent tests are recorded below. Full editor/provider/browser acceptance is separate. No personal credential reuse or custom native endpoint approval is implied. |
| R18 example publication/UI implemented; acceptance scoped | Independent 10:15:11 UTC run: 15 example API/DB/S3 + 6 pending-object DB/S3 + 5 web helper cases PASS. `example-assets.ts:167,191,304,316` uses pre-PUT durable staging and atomic target commit. `capability-versions.tsx:70`, `seller-examples.tsx:50-83`, `capability-examples.tsx:43-63`, `capability-detail.tsx:64-69` wire seller review/from-job/revoke and buyer explicit version-bound owned-copy templates. | No new blocking defect found in this reviewed scope; old scalar-only/no-orphan-wiring absence claims are closed. Curie reports six browser passes: two real draft/direct-storage flows and four explicit UI-response fixtures, not six real-backend flows. Remaining integrated-browser/process-kill evidence boundaries are distinguished below; no entire R18/357-368 PASS. |

The original admin containment reproduction completed at 09:47:51 UTC in a separately migrated
`audit_containment_<random>` PostgreSQL schema. It used a synthetic RUNNING,
RESERVED 99-cent job with an accepted attempt and zero reserved buyer balance.
All three real admin handlers were invoked with an actual admin session. No
provider was called, no real ledger row was edited, and the fixture schema was
dropped afterward. This demonstrates behavior under an already recognized
financial hold, not an assertion that normal purchasing creates corrupt balances.
Those admin paths are now independently verified by four focused DB cases plus
14 policy and nine billing regressions. The distinct seller-owned revoke probe
at 10:04:04 UTC reproduced a sibling rollback in another isolated schema; parent
subsequently fixed it, and all five containment cases passed independently at
10:09:43 UTC. The probes did not alter real data or source. The later 53-case
billing handoff closes the named sibling rollback concern, but R08-F2/F3 are
independently reproduced additional failures. Full reproduction details and
precise test limitations are in `docs/INDEPENDENT-AUDIT.md`.

### R01-R24 Remap

The original source/ID ranges for each R-item remain below. PASS here is always
scoped to the named behavior; PARTIAL can mean remaining trace/acceptance rather
than absent implementation.

| Finding | Current classification and source-grounded disposition |
|---|---|
| R01 | PASS for scoped saved-method/receipt API assertions (E15); PARTIAL overall. Saved methods, receipts, Stripe adapter and wallet UI exist. New 109-row review identifies R01-F1 periodic provider-recovery omissions and R01-F2/F3 model/policy discrepancies, distinct from external R06. Direct per-job cards are explicitly later under 24.1/24.27, not an MVP absence. |
| R02 | PASS for five service lifecycle fixture cases (E17); PARTIAL actual platform acceptance. `service.ts` implements opt-in LaunchAgent install/status/restart/uninstall, private plist, Keychain-only secrets and paused start. Real supported-Mac login/relogin acceptance is UNTESTED, not absent installer code. Clean-environment acceptance is separately 571; no literal second-machine requirement is invented. |
| R03 | PARTIAL, implementation/trace. Terms version/hash acceptance is persisted and enforced before paid reservations; `accounts.integration.test.ts:158` names the exact case. Parent's 12-case receipt is attributed, not an independently rerun account suite here. Email recovery/verification remains extra workflow, not invented literal MVP scope. |
| R04 | PARTIAL, implemented with acceptance boundaries. `asset-uploads.ts`, browser direct finalize flow, Worker streamed file transfer and scoped upload/protocol tests exist. Parent/Worker actual deterministic direct-transfer fixture receipts are retained; no confirmed missing direct-S3 interface. No arbitrary 500 MB throughput claim. |
| R05 | PARTIAL, implemented release automation. CI includes isolated-runtime Docker/OpenClaw and macOS/Linux artifact jobs; parent reports self-contained Worker/cloud artifacts and isolated boot at 09:44 UTC. Remote CI execution and public-release signing are separate evidence/stage gates. Cloud health/config/static boot is not DB readiness proof. |
| R06 | UNTESTED external acceptance: dedicated real inference + Stripe test/Connect credentials explicitly unavailable until supplied. No credential reuse. This remains required staging acceptance, not a missing-code alias or automatic DEFERRED. |
| R07 | PASS for owner-attributed controlled local receipt c4db5210 at 10:23:46.833 UTC, independently read with script assertions: 19 migrations, four plan plus four warmup successful/settled jobs, three consumed/granted dependency files, S3 PDF Poppler parse/render, provenance, replay and zero remaining containers/reservations. PARTIAL whole acceptance: public schema under confirmed stopped reconciler, explicit tickPlans, deterministic inference/fake payment, no browser/background/provider proof. Waiting-for-handoff statement is stale. |
| R08 | PARTIAL. Operator CAS policy, version/category gates and control routes are implemented. Named admin/seller-Worker controls and dispute/refund commit-first containment have scoped independent verification. R08-F2/F3 are open assigned financial repairs. R08-F4 staging-cookie coupling is now closed by independent source/config and actual DB login regression; no whole-security-section promotion. |
| R09 | PASS for E14 scoped v1 route/auth/private-route exclusion/historical DTO case; PARTIAL aggregate API trace. `app.ts` aliases and shared runtime DTOs exist; no confirmed absent v1 buyer surface. |
| R10 | PASS for E14 owned signed test delivery and seventh-attempt terminal/degraded/no-retry assertions. Web UI exists; full rendered/configured external delivery acceptance is not inferred from injected delivery transport. Old send-test/terminal absence is closed. |
| R11 | PARTIAL with present runbook/retention/disclosures. `INCIDENT_RESPONSE.md` covers compromised release, seller credential leak, malicious buyer and marketplace compromise, plus financial responsibilities. The old 79 NOT_IMPLEMENTED claim is superseded. E14 verifies immutable retention snapshot/purge; configured disclosures exist in API/web. No incident drill or legal/public-launch clearance is asserted. |
| R12 | PASS for E18 bounded media-structure assertions; PARTIAL full format/runtime/UI acceptance. Contracts/storage and web presets now include WebP/MOV/WebM/MP3/M4A/OBJ/FBX. Old absent-format allowlist claims are closed. Exact codec/conversion and current UI receipts still govern their scopes; conditional GIF/DOCX/etc remain conditional. |
| R13 | PASS for E15 scoped payout reconciliation tests; PARTIAL provider/UI acceptance. Durable account-bound records, leases, canonical provider reads, pagination/retry/backfill and correct earned/transfer/payout distinctions exist. No bank transfer or live Stripe receipt is fabricated. |
| R14 | PARTIAL, implementation present. E14 verifies owner reports/admin moderation/CAS/audit without payment edits. Feynman's review edits/distribution/current-job projection have named catalog tests; previous owner receipt is 48 scoped cases, not a new independent rerun here. No currently confirmed absent reports/reviews route. |
| R15 | PARTIAL. E17 verifies 26 Node/SQLite/signed device/cloud clock/policy diagnostics cases. Only the narrower config-readable and DB-writable diagnostic presentation residual above remains source-confirmed. |
| R16 | PARTIAL, active Worker integration as above. Safe broker core/public-plan library is real; private+research execution cannot be marked PASS merely because those libraries pass. |
| R17 | PARTIAL. Parent health transitions, minimum/latest version projection and routing-change audit are implemented (E14). Operations metrics and usage-cost/coverage/contribution reporting passed their owner's 26 cases (E19, not independent certification). Worker usage outbox is now source-present; Laplace reports 86 focused passes. Curie's cost display now consumes the exact DTO and gates contribution; rendered acceptance is separate. Research audit detail remains active; invoice/infrastructure/confirmed egress stay legitimately unknown, not invented requirements to manufacture prices. |
| R18 | PARTIAL. E03 lifecycle/catalog and E16 example publication/persisted recovery/helper subsets pass. Example UI/API wiring is source-reviewed and no longer missing; current real-browser versus response-fixture receipts are explicitly separate. E17 closes blanket non-SKILL prerequisite rejection. Required discovery/observation remains Laplace's active batch pending ready re-audit. The provider/UI guard defect is fixed. |
| R19 | PASS for the precise public dependency projection leak, independent E03 receipt. No promotion of every permission taxonomy/agent clause. |
| R20 | PASS for E14 atomic hit/spend concurrency, cross-key account aggregation and chat-turn ceiling assertions; PARTIAL remaining daily job/endpoint/calendar/idempotent rollback trace. `abuse.ts` and admission call sites exist; do not claim missing abuse controls from old TODOs. |
| R21 | PASS for E14 v1 FULL_RESUME DTO assertion; PARTIAL actual pause/resume semantics. Open P1 R21-F1 confirms Worker absolute timeout conflicts with API pause-excluded accounting and Master 438/439 before-pause-limit behavior. FULL_RESUME metadata/UI exists, but long-pause actual runtime acceptance is not certified. No checkpoint-engine or unconditional successful-resume guarantee is invented. |
| R22 | PARTIAL, implementation present. `jobs.ts:24-26,44,143` retains originalScheduledAt/eligibleAt/queuedAt and emits them; `background.ts:87` records old/new/original reschedule metadata; job UI displays them. Exact transition/reschedule-history acceptance is still a targeted trace/test item, not an absent-column claim. |
| R23 | PARTIAL with bounded owner-reported runtime acceptance. Feynman reports strict seven-case actual Docker/OpenClaw fault matrix exit 0 at 10:10:01 UTC, including corrected TIMED_OUT/RELEASED at 30,091 ms, 91 ms deadline overshoot and a successful exact-file/settlement/replay control. Auditor checked strict source assertions, not Docker execution. Fixture remains deterministic inference/fake payment/DEVELOPMENT_ONLY scan/background disabled: valid local evidence, not 92 staging. Browser-to-Worker/queue participation and clean supported-Mac full-clone job remain unproven local boundaries. Parent reports migration 018 applied (19 total). Missing external inference alone is not a 557/570 blocker. |
| R24 | PARTIAL trace-only work. The explicit plan below maps actual non-gaps without turning aggregate counts into TESTED. This audit makes no coverage-file changes or 100% claim. |

### Exact Remaining Acceptance Map

This is the bounded checkpoint, not a new full-source audit. Active owner changes
must be re-read after their ready handoffs before an earlier code gap is either
reasserted as current or closed. An unreviewed implementation is not automatically
NOT_IMPLEMENTED, and an unavailable test prerequisite is not DEFERRED.

| Queue | Exact scope / current evidence | What remains and classification |
|---|---|---|
| Required provider-recovery code | R01-F1 / PAY-0042 / 24.14: absent periodic topup/refund/dispute discovery and completed-transfer comparison; payout backfill and pending-transfer retry exist. | PARTIAL aggregate; named recovery families NOT_IMPLEMENTED by current source. Credentials affect external acceptance, not implementation. R01-F2 internal tax/total/processing distinctions and explicit fee policy also remain bounded modeling work; actual tax collection is conditional. R01-F3 explicit currency is a recommended-model discrepancy, not multi-currency scope. |
| Required code/financial repair | R08-F2: equal-price unfunded job consumes a healthy job's pooled reserve under actual dispute/refund delivery. R08-F3: two increasing cumulative refunds repeat a debt amount and permanently collide on the collection key while funds are available. Both independently reproduced after the 53-case billing batch passed. | PARTIAL / two concrete required code repairs, not credential-blocked or missing trace. The original commit-first containment rollback concern is closed for reviewed paths. Keep durable denial/receipt, manual holds and immutable ledger history; regress provenance/isolation plus repeated refund cycles. Terminal+RESERVED has separate seven-unit and six-DB receipts, not proof against these failures. |
| Narrow staging security fix verified | R08-F4: canonical config.secureSessionCookies decouples HTTPS session safety from live billing. Independent config 37 PASS plus actual isolated-DB staging login 1 PASS. | PASS for this fix only. Section 81 operational separation remains UNTESTED, not absent cloud provisioning. PRD-0067 client display awaits Laplace's ready handoff; API diagnostics/v2 is present. |
| Required pause/deadline consistency | R21-F1 / 438 JOB-0174, 439 JOB-0177: actual Worker test asserts expiry during an allowed pause with unused active execution budget, unlike API accounting. | PARTIAL / source- and focused-test-confirmed conflict. Laplace investigates pinned-runtime timers before policy changes. No proof of the underlying OpenClaw long-pause behavior or of a host-only remedy; final acceptance must cover real resume across the former wall deadline and bounded expiry/payment effects. |
| Required Worker code, active | R15 config-readable/DB-writable diagnostics (57 WRK-0071-WRK-0073); R17 safe research audit (254 PRD-0233/0234); R18 safe metadata/observed dependencies (104 AGT-0023-AGT-0027; 105 CAP-0022-CAP-0025; 118 CAP-0049-CAP-0051). | Earlier source-confirmed residuals; Laplace is implementing them. Keep PARTIAL pending exact ready source/tests, not broad NOT_IMPLEMENTED against code still changing. Do not invent personal-file copying or native GUI requirements. |
| Required combined execution, active | R16 public-plan/private-resource flow (254-255/261), now owner-reported real OpenClaw smoke with public prefetch and private snapshot/cache-only lookup. | Pending remaining identity/cancellation dependencies, bounded source review and real combined PostgreSQL/resource full-stack receipt. PARTIAL / implementation plus acceptance; no longer a blanket missing prefetch call site. |
| Example implementation verified | R18 / 357-368: exact per-file consent, independent owned copies, immutable draft/current access, version-bound buyer reuse, revocation and persisted orphan recovery. Independent 15+6 API/DB/S3 tests and five UI-helper tests; source-connected seller/buyer UI. | PASS only for those assertions; no currently confirmed missing implementation here. Recovery uses controlled stored timestamps/application reconstruction, not actual SIGKILL. UI receipt is separately qualified below. |
| Example integration evidence | Curie reports six browser passes: two real direct-upload/draft/revoke flows; four response-fixture public-template/from-job flows. Exact boundaries in `apps/web/e2e/examples.spec.ts:18,79,125`. | Real-browser current-public owned template copy and successful self-owned-job publication are not demonstrated by those fixture cases, although their APIs pass independently. UNTESTED integration boundaries, not absent features or invented mandatory test forms. |
| Local runtime acceptance proved by owner | R23 seven strict actual Docker/OpenClaw fault cases and exact-file success/settlement/replay at 10:10:01 UTC; strict assertions source-reviewed. | Do not keep the earlier wrong-timeout defect open for this scenario. Owner-attributed PASS for named faults only, not real Stripe, paid inference, production scanning/background or all failure requirements. No duplicate Docker rerun requested. |
| Controlled local DAG proof present | R07 receipt c4db5210, 2026-10-06T10:23:46.833Z, reviewed with production-script assertions; four plan jobs plus four warmups and three file dependencies culminate in a downloaded/parsed/rendered PDF, exact settlement and clean owned state. | Owner-attributed PASS for named deterministic local assertions. Main reconciler was confirmed stopped; public-schema isolation is procedural, not a DB lock. Explicit tickPlans, no browser/background proof, no paid provider. Do not leave this rerun classified as awaiting coordination. |
| Other local acceptance awaiting handoff | R23 buyer-browser-to-real-Worker job and actual Redis/dispatch participation (563); R02/R23 supported-Mac login/relogin and clean-clone full job (56/571-573). | UNTESTED named receipts. Existing API fixtures have no browser/background; Redis health alone is not queue participation. Same-host source-copy proof is partial. No literal second physical Mac or paid LLM is added to local clauses. These are not absent DAG/service/bootstrap-code claims. |
| External required acceptance | R06 / 92 TST-0008-TST-0012, R07 / 160 PRD-0152-PRD-0154 and 235 IO-0131/0132 real paid/file-heavy scenarios. | Dedicated inference and Stripe/Connect credentials explicitly await the user; personal credentials forbidden. UNTESTED external staging, not automatic DEFERRED. Deterministic fixtures do not become paid-provider evidence. |
| Release-stage prerequisites | Public distribution signing/notarization, production secret/IAM/rotation and applicable public legal conditions. Private-beta package/isolated boot receipts already exist. | Stage-specific deployment/acceptance evidence, not automatically missing private-beta source. Keep the exact source/stage gate; no signing/public-launch approval inferred. |
| Unreviewed trace, not missing code | R20/R22 targeted 30 cases and protocol 16 are parent-attributed; Feynman maps API clauses. R24 all 1,701 IDs remain mapped to the Master. | Latest parent release coverage gate FAIL: 1,545 not closed, 1,123 TODO. Perform atomic source/call-site/assertion mapping and bounded review after final owner handoff. No conversion of counts into feature gaps or blanket TESTED. |

Scope correction for parent's local coverage remap: DEV-LOCAL-006 (557) is not
BLOCKED solely because dedicated live inference is absent. Credit actual supported
OpenClaw evidence only for the asserted runtime behavior; do not thereby promote
DEV-LOCAL-014 (563 browser/full path) or DEV-LOCAL-029 (573 full local checklist).
DEV-LOCAL-023/024 (570) may use an equivalent deterministic local command with
real OpenClaw and exact success/fault assertions. DEV-LOCAL-022 (569 correlation)
also has no standalone live-provider requirement. DEV-LOCAL-015 (564 Stripe
integration/acceptance) and the global 92 gate remain distinct external checks.
Final local row status awaits the active handoff and exact evidence mapping;
coverage-local.json is not modified by this audit.

### Billing Sidecar Corrections

All 109 rows of `docs/coverage-billing.json` were read structurally and checked
against the relevant full Master subsections and current source. The 31 partial
rows are not 31 feature gaps; aggregate statuses and test totals are not fresh
independent proof. Parent owns all coverage edits.

| IDs / source | Correct current classification |
|---|---|
| PAY-0016/0017, PAY-0021-0023; 24.1/24.3/24.5/24.27/460 | EXPLICIT_FUTURE direct-card flow for the prepaid private beta. No required manual-capture/SCA/authorization-expiry implementation now. Preserve architecture trace and future finite-window constraints; do not call absent card code an MVP blocker. |
| PAY-0041/0060/0063 and PAY-0001 aggregate | Mixed clauses. Current provider webhooks, prepaid secured-dispatch and release/refund behavior remain required; direct-card branches are later. Do not defer the whole clause or certify the whole section from prepaid tests. |
| PAY-0036 / 24.11 | Offline-release matrix is explicitly an example, not a requirement to abandon the first offer immediately. Current bounded expiry/requeue exists. Buyer-facing offline-retry and after-start refund policy disclosure is a real policy/copy residual; final commercial Terms/legal allocation is stage-specific external work. |
| PAY-0045/0074/0111 / 87 | Estimated seller cost/coverage, failure rate and average runtime are already in the mounted Operations view, including earnings (`selling.tsx:78`, `operations.tsx:25,50-57`). Parent owns UTC-today/all-time counts and Curie presentation. Not all missing metrics and not a reason to duplicate financial math. No independent self-certification of the auditor-authored operations implementation. |
| PAY-0003/0018/0066/0067 / 24.4/24.26 | Insufficient-funds negative evidence exists in `scripts/e2e-fixture.ts:287-297`: 402, unchanged wallet/ledger and job count. Prior strict fault-matrix receipt is owner-attributed and source-reviewed. API-key-specific or malformed-queued-job cases remain separately scoped acceptance, not missing guard code. |
| PAY-0042 / 24.14 | Genuine source gap R01-F1. Existing periodic payout reconciliation does not cover missed topup/refund/dispute notifications or already-completed transfer drift. |
| PAY-0048 / 24.19-24.20 | R01-F3 explicit-currency storage discrepancy. Single USD is allowed; multi-currency can follow later. The recommended wrapper must remain visible. Existing records may satisfy PaymentTransaction semantics without that exact table name; remaining fields need explicit trace, not a duplicate model by default. |
| PAY-0084-0088 / 288; PAY-0089 / 289 | Required internal distinction of retail/tax/total/seller/marketplace/processing components is incomplete (R01-F2). Jurisdictional calculation/collection and Stripe Tax apply only if legally required. Snapshot field names are examples; immutability is required. No invented tax rate or default zero liability. |
| PAY-0100 / 296; 24.18 | Future tier/multi-currency administration and recommended high-risk rolling reserves are not new present-day MVP subsystems. Shared tiers and historical immutable economics remain required. |
| PAY-0014/0020/0047; 24.2/24.4/24.17 | External public-launch business/legal approval, not source code that an agent can certify. Method/terms infrastructure is present but does not prove merchant-of-record, stored-value or chargeback-risk clearance. |

No additional source absence is asserted from a missing named assertion alone.
Universal security/financial promises still need trace and adversarial evidence,
but arbitrary untested combinations do not automatically invent new features.

### Exact New Receipts

Independent runs in this checkpoint, all exit 0:

- 09:42:44 UTC / 11:42:44 CEST: operations-policy integration 11, security-policy
  units 2, storage media 24, Worker diagnostics 26, Worker service 5: 68 PASS.
- 09:43:01 UTC / 11:43:01 CEST: payment-methods integration 12, payouts integration
  13, example-assets integration 12: 37 PASS. Real PostgreSQL/S3 where applicable;
  Stripe SDK and signed execution are explicit synthetic fixtures, not providers
  or OpenClaw proof.
- 09:45:37 UTC / 11:45:37 CEST: adapter discovery 16 and Worker imports 8: 24 PASS.
  Native launchctl effects in service tests are mocked; no actual login-cycle
  installation was performed by this audit.
- 09:51:45 UTC / 11:51:45 CEST: web Worker-policy 8 and operations-display 3:
  11 PASS. Includes the repaired native-Anthropic guard and incomplete-coverage
  contribution gating; not a rendered browser receipt.
- 10:05:17 UTC / 12:05:17 CEST: containment integration 4, operations-policy
  integration 14, billing integration 9: 27 PASS, exact command in the companion
  audit. The containment tests use actual isolated PostgreSQL and injected signed
  Worker/session requests, not a real runtime. They assert immutable denial and
  healthy/damaged financial isolation for the four named admin actions only.
- The original three-action R08-F1 probe is historical; the seller-revoke probe
  at 10:04:04 UTC is also now historical. Reproduced defects are additional
  adversarial evidence, not part of passing suite totals.
- 10:09:43 UTC / 12:09:43 CEST: containment integration 5 PASS after seller-route
  repair, including outsider 404 and owner replay with damaged/healthy jobs.
  Retaining the original device timestamp, no duplicate PAUSE_ALL and binding
  invalidation are source-traced; the current fixture does not separately assert
  those three properties. This does not certify dispute/refund containment.
- 10:15:11 UTC / 12:15:11 CEST: example-assets integration 15, pending-objects
  integration 6, web example helpers 5: 26 PASS. Exact three-file command in the
  companion audit. Real development PostgreSQL/S3, synthetic signed Worker
  protocol and no live providers. Example fixtures own unique IDs in the local
  development database; helper cases use an isolated schema. Recovery ages
  fixture timestamps/reconstructs the app, not SIGKILL or wall-clock TTL waits.
- 10:24:00 UTC / 12:24:00 CEST: `pnpm exec vitest run apps/api/test/job-recovery.test.ts --no-cache`
  exits 0, seven unit cases PASS. Four terminal states with RESERVED reject with
  LEDGER_INVARIANT before DB operations; three resolved-payment replay cases
  return the unchanged job. `jobs.ts:57-61` and `background.ts:48-52` are reviewed.
  These units do not execute background recovery against PostgreSQL; the later
  DB receipt below supplies the named persistence/retry proof separately.
- 10:27:34 UTC / 12:27:34 CEST: `KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/containment.integration.test.ts --no-cache`
  exits 0, six actual isolated-schema cases PASS. New CANCELLED/RESERVED fixture
  verifies release-helper recovery attempts=1, then background retry attempts=2
  after changing only its nextRetryAt to zero, with one recovery audit, unchanged
  terminal/payment/deny state and wallet balances, and no invented ledger entry.
  Not an elapsed-backoff, all-terminal-DB-states or BullMQ execution test.
- 10:29:59 UTC / 12:29:59 CEST: billing containment 29, disputes 13, billing 9,
  ledger units 2: 53 PASS, exact four-file command in the companion audit. Real
  isolated PostgreSQL, synthetic signed Stripe, no live provider. Confirms named
  durable containment/receipt/replay/partial-collection assertions, not all
  financial fault states. Additional isolated-schema adversarial probes at
  10:31:25 and 10:33:49 UTC reproduce R08-F2/F3 despite that passing suite; both
  exited 0 after reporting product failures and dropping their own schemas.
  Probes are not passing regression tests. No source/test/coverage edits.
- 10:39:59 UTC / 12:39:59 CEST: pure readConfig probe confirms the three
  staging/production/key combinations in R08-F4. No DB/network/provider or env
  load. Session Secure behavior is source-traced, not an observed cookie attack;
  diagnostics/v2 51 tests are parent-attributed, not independently rerun here.
- 10:43:43 UTC / 12:43:43 CEST: existing Worker runtime paused-wall-clock cases
  2 PASS / 6 nonselected skipped. This confirms the conflicting current R21-F1
  behavior, not compliance: real WorkerRuntime/SQLite, fake clock, mock Docker/
  adapter/transport. No actual OpenClaw or DB settlement receipt is inferred.
- 10:49:42 UTC / 12:49:42 CEST: independent isolated-PostgreSQL HTTPS staging
  cookie regression 1 PASS / 12 nonselected skipped; actual login/session and
  Set-Cookie assertions, synthetic test-key configuration, no Stripe call.
- 10:49:54 UTC / 12:49:54 CEST: config suite 37 PASS, including canonical HTTPS
  cookie protection and unchanged production/live-key restrictions. These
  close R08-F4 only. Parent's complete 13-account-case run is attributed.

R07 owner receipt reviewed, not independently rerun: fixture c4db5210 at
10:23:46.833 UTC / 12:23:46.833 CEST, process exit 0, 19 migrations, four plan
and four warmup jobs SUCCEEDED/SETTLED, three dependency grants/read markers,
S3 PDF Poppler parse/render, replay and zero remaining containers/reservations.
Source/receipt boundaries are in the companion audit; explicit tickPlans with
the parent-confirmed reconciler stopped is not automatic background execution.

Parent-reported current receipts, not auditor executions: actual Docker fixture
09:33 UTC; fresh source 17 migrations and proxy 09:39 UTC; self-contained cloud
packaging/isolated API health-config/web-static boot 09:44 UTC. Parent's later
11:56 CEST report is 713 unit PASS / 192 opt-in skipped and full types/lint PASS;
PendingObject migration 017 and 11 DB/S3 cases passed at 11:55 CEST. Migration
018 is subsequently reported applied (19 total), with the 27-case containment
batch at 12:01 CEST. These global/migration reports are attributed, not auditor
executions or whole-MVP/DB-readiness certification.
Parent additionally reports policy/data 19/19 at 11:50:33 CEST (09:50:33 UTC):
14 operations-policy + 5 uploads with current revocation/category admission and
data gates. The 14 operations-policy cases have since passed independently in
the 10:05:17 UTC run. Parent additionally reports 30 targeted R20/R22 cases and
16 protocol cases at 12:07 CEST, covering UTC rollover/rollback/real daily purchase
idempotency and actual schedule-change/notification/full-release. These new
receipts and conservative coverage-operations.json rows are parent-attributed;
they do not promote aggregate requirements without assertion-level mapping.
Feynman's 10:10:01 UTC strict runtime fault receipt is also attributed, fixture
`73969acc-3ec3-41ff-8c5e-b954bf544cfa`: seven fault cases pass, four created jobs
release once without capture/earning/fee, timeout has 91 ms deadline overshoot,
and the subsequent exact 112-byte S3 success control settles/replays correctly.
Source assertions were reviewed at `scripts/e2e-fixture.ts:290-345`; no independent
Docker rerun occurred. This closes the owner's earlier timeout/classification
failure for that deterministic local scenario, not real-provider acceptance.

### Non-Gap Evidence Mapping Plan

Earlier parent trace snapshot: 1,701 mapped, TODO 1,212, IN_PROGRESS 339,
TESTED 120, IMPLEMENTED 27, BLOCKED 3; 1,581 not TESTED. Latest parent release
coverage gate remains FAIL with 1,545 not closed, including 1,123 TODO. These are
trace/evidence counts, not missing-feature counts or proof that 100% was achieved.

1. Preserve original IDs, Master/catalog hashes and all rows. Use the existing
   573-section map plus actual clause text; preserve every atomic override and
   explicit future/recommended/example distinction. Record a source snapshot
   or file hashes with each new test receipt so later edits invalidate only the
   affected evidence, not unrelated verified scopes.
2. Map present code first, in bounded families: E01/E02 contracts and policy;
   E04/E05 signed jobs and immutable money; E03/E16 lifecycle/catalog/examples;
   E07/E18 direct assets/media; E09/E17 Worker/import/diagnostics; E06 agent plans;
   E14 operator/retention/limits; E15 saved methods/payouts; E19 operations; E11/E12
   UI and packaging/runtime. Existence of these paths moves a row out of the
   missing-code queue, not automatically into TESTED.
3. For each requirement, record the precise source clause, implementing handler
   plus actual call site, named test assertion, command/environment, timestamp,
   executed/skipped result and boundary (unit, DB, synthetic provider, real
   runtime, browser or external provider). Match assertions, not test filenames
   alone: for example the E14 v1 test proves historical response/auth scopes,
   not every REST endpoint or every section 322 requirement.
4. Promote an atomic row to TESTED only for its full required behavior with
   executed applicable evidence. Use IMPLEMENTED when the complete code path is
   traced but its required test is not run/mapped; retain IN_PROGRESS/PARTIAL for
   mixed clauses, active integration or outstanding acceptance. An unexecuted
   test or sibling case is UNTESTED evidence, not a missing implementation.
5. Decompose SECTION_COVERAGE rows into an explicit checklist without deleting
   the original row. Mark the section TESTED only after all required clauses and
   required acceptance items are evidenced; one unresolved clause leaves it
   partial. Do not propagate one passing atomic item to adjacent catalog rows,
   the whole source section, an E-key family or all 1,701 entries.
6. Keep separate queues for reproduced defects (R08-F1), implementable residuals
   and active owners, exact test/trace gaps, external staging credentials,
   supported-machine/release-stage acceptance, and explicit future scope.
   BLOCKED records must name the unavailable prerequisite and unrun command;
   they are not eligible for automatic DEFERRED. Public signing/qualified legal
   prerequisites apply at the specified release stage, not as invented private-
   beta source features.
7. Validate every evidence reference and ensure no test was silently skipped,
   no original ID disappeared, and no aggregate was promoted from counts alone.
   Re-run the bounded affected suite after owner changes, then parent performs
   its full release matrix. Report remaining required failures/unknowns plainly;
   neither this remap nor packaging changes the meaning of the user's 100% goal.

## Historical Finding Snapshots

These are source-observed gaps in the snapshot, not claims that owners have
finished their currently active batches. Priority below is audit triage, not a
rewrite of catalog priority.

| Finding | Priority / State | Source and IDs | Current evidence and required next acceptance |
|---|---|---|---|
| R01 Saved buyer methods and receipts | P1 / PARTIAL | 24.1, 24.6; PAY-0001, PAY-0024-PAY-0026 | `packages/billing/src/stripe.ts:27-42` creates one-time credit Checkout; `apps/api/src/billing.ts:14-50` and `apps/web/src/components/wallet.tsx:15-41` expose top-up and ledger history, not add/remove/default saved-method management or receipts. Add the provider-backed management/receipt path and authorization/idempotency tests. Existing funding/ledger behavior is not missing. Direct per-job authorization is separately later under 24.27. Sent to API owner. |
| R02 Background Worker installation | P1 / NOT_IMPLEMENTED | 56; WRK-0068-WRK-0070 | `apps/worker/src/index.ts:28,43-56,119-124` provides foreground start/stop, but no LaunchAgent/equivalent installer or login-start workflow exists in source/scripts/docs. Supply macOS private-beta background-after-login lifecycle and install/uninstall/restart proof. Signed/notarized desktop GUI is explicitly later, not this gap. Sent to Worker owner. |
| R03 Terms acceptance | P1 / NOT_IMPLEMENTED | 120 buyer requirements; PRD-0083 section coverage | `apps/api/src/auth.ts:72-80` registration accepts email/name/password only; no terms version/acceptance exists in schema or UI. Provide actual terms availability and persisted explicit acceptance before paid use. This does not imply an invented email-verification/recovery requirement. Parent owns auth/security. |
| R04 Large-file transfer architecture | P1 / PARTIAL | 61, 218; IO-0107-IO-0110 and 61 section coverage | `apps/api/src/assets.ts:13-45,50-59,75-84,92-112` buffers/proxies input and output bytes; `apps/worker/src/transport.ts:49-65` downloads a Buffer and uploads Buffer.concat multipart; browser `contract-form.tsx:27-33` posts bytes to API. Required direct object-storage upload/finalize plus streamed Worker transfer is absent. Preserve active-attempt grants, hash/size verification, scanning, expiry/revocation and finalization authorization. Existing small-file safety/full-stack passes remain valid, not proof of 218. Sent to API and Worker owners for coordinated assignment. |
| R05 Dedicated runtime CI and release artifacts | P1 / PARTIAL | 80; TST-0001-TST-0005 | `.github/workflows/ci.yml` runs unit/build and local DB integration, but no dedicated real OpenClaw/Docker security runner or Worker artifact/checksum/compatibility release job. Local parent Docker proof is valuable but does not constitute this automation. Public-launch signing/rollout obligations from 56 are a separate release-stage condition. |
| R06 Real paid provider staging | P1 / UNTESTED | 92; TST-0008-TST-0012 | Deterministic full-stack receipts prove real OpenClaw/sandbox/API/S3/ledger, explicitly fake payment and deterministic inference. No dedicated-provider Stripe test/Connect paid two-user staging receipt yet. Credentials must be supplied separately; personal credentials must not be reused. This is an external verification prerequisite, not evidence that the implemented protocol is absent. |
| R07 Full orchestration and file-heavy acceptance | P1 / UNTESTED | 160 PRD-0152-PRD-0154; 235 IO-0131-IO-0132 | Library/API tests prove bounded DAG, exact revision, persisted repair, compatibility and financial constraints. Required real staging multi-company-to-PDF/provenance/reviews and Blender/file-heavy end-to-end receipts are not established by the single text-file deterministic fixture. 159's extension wording does not negate the explicit later acceptance list in 161. |

Parent has explicitly confirmed dedicated provider/Stripe credentials will be
supplied later. R06 is externally unavailable for now; no personal credential
reuse is authorized. Account recovery/verification/SMTP is owner-requested extra
workflow work, not an inferred Master blocker. Its new migration/tests need their
own review; the old seven-migration/371-test receipt is not a current global pass.

## Additional Required Gaps

| Finding | Priority / State | Source and IDs | Exact observed residual |
|---|---|---|---|
| R08 Operator security policy | P1 / PARTIAL | 4.3, 78 JOB-0048/JOB-0049; 371 CAP-0110-CAP-0113; 393 | `apps/api/src/worker.ts:148` admits hardcoded Worker 0.1.0 plus pinned adapter support. `billing.ts:206-214` only supplies the global dispatch switch. No operator-set minimum/revoked Worker/OpenClaw policy, category blocking or complete admin capability/device control surface was found. Local compatibility checks and account suspension are implemented. Test policy changes at purchase, dispatch, acceptance and resume, with no seller override. |
| R09 Versioned buyer REST/response contract | P1 / PARTIAL | 53; 322 IO-0136/IO-0137; 323 CAP-0087 | `apps/api/src/app.ts:132` registers current `/api` services only. No stable versioned buyer route surface or systematic runtime response validation was found. Existing authenticated API-key jobs/payment/idempotency are real and should be reused, not duplicated. Define/document a stable equivalent to the specified v1 surface and test exact response/asset contract. |
| R10 Webhook operational completion | P2 / PARTIAL | 333 AVL-0003; 335 API-0026/API-0027 | `apps/api/src/webhooks.ts:94-122` has list/create/delete but no Send test operation. Delivery attempts stop at seven, while endpoint disable uses aggregate failure count >=20; a single exhausted delivery remains neither delivered nor explicitly terminal in its returned status. Add tested terminal/degraded presentation and safe signed test delivery. Existing HMAC, bounded retry and SSRF controls are implemented. |
| R11 Privacy, retention and incident operations | P1 / PARTIAL | 37 PRD-0044-0046; 65; 79 SEC-0063/0064; 178 PRD-0174; 228 IO-0125-0127; 24.11/24.17/38 | Required incident-response runbook or equivalent was not found. `capability-detail.tsx:34` discloses seller processing but not actual retention or declared external AI/processors; job page lacks actual retention/expiry. Asset expiry deletion exists in `background.ts:151-160`. Implement accurate product disclosures linked to configuration, documented failure/refund/chargeback responsibility and operational procedures. Legal/tax/MoR review is conditional before public launch, not an invented tax-engine requirement for private beta. |
| R12 Supported common media formats | P1 / PARTIAL | 193, 198 UI-0020/UI-0021, 235 IO-0131/IO-0132 | `packages/contracts/src/index.ts:109-134` currently allows Worker TXT/MD/CSV/JSON/PDF/PNG/JPEG/BLEND/MP4/WAV only. Listed common presets WebP, MOV, WebM, MP3, M4A, OBJ and FBX cannot be published/executed. Rejecting unsupported contracts is correct safety behavior, not full format acceptance. GIF/DOCX/XLSX/FLAC/GLTF clauses explicitly say where supported and must not be silently promoted to unconditional format requirements. Exact 500 MB/4K example values are not required defaults. |
| R13 Seller payout lifecycle | P1 / PARTIAL | 24.8/24.13/24.14/24.20, PAY-0001/PAY-0029/PAY-0042; 87 PAY-0074 | `billing.ts:65-117` handles Checkout/refund/account/dispute events, but payout events are UNHANDLED. Schema stores `payoutsEnabled`, not actual payout records; earnings returns transfers, not paid-out amounts (`billing.ts:128-135`, `selling.tsx:91-94`). Durable settlement/transfer/refund/dispute restoration is proven; it is not bank-payout reconciliation. Add provider-account-scoped payout state/reconciliation and accurate pending/transferred/paid-out display with duplicate/out-of-order tests. Real-provider proof remains R06. |
| R14 Problem reports and review completion | P1 / PARTIAL | 30 SEC-0032-0034; 86 PRD-0070-0072; 127; 128 PRD-0099/0100 | No buyer/seller problem-report route, persisted report or moderation intake found. Paid-only one-review-per-job creation exists (`catalog.ts:141-153`), but no review edit policy/path or rating distribution. `jobs.tsx:62` looks for review.jobId while public review projection omits it, so current-job review status cannot be established by that response. Add owner-scoped report/review workflow and tests, not an advanced reputation system. |
| R15 Complete diagnostic checks | P2 / PARTIAL | 57 WRK-0071-WRK-0073; 567 DEV-LOCAL-020 | `apps/worker/src/readiness.ts:38-65` checks OS, OpenClaw, sandbox, store, inference and identity presence. It does not perform the full specified Node/runtime, actual cloud/device-credential validity and reasonable clock-sync diagnostics. Preserve current fail-closed checks; add bounded, sanitized, actionable missing probes rather than optimistic PASS labels. |
| R16 Research plus private resources | P1 / PARTIAL | 246/254/255/261; PRD-0245-0247; 274-276 | `apps/worker/src/tools.ts:35-38` labels every job with resources or input assets private; `ResearchBroker` accepts only PUBLIC data for research. Therefore even public-input research in a combined private-DB capability is impossible. Add a demonstrably public-data-only research path without blanket declassification. Research limits are hardcoded in Worker, not seller-configurable narrower policy. Optional binary research download is not implemented; do not advertise it. Real combined research/private-resource fixture required; no arbitrary request body/POST or host-network workaround. |
| R17 Operational telemetry/economics | P2 / PARTIAL | 9/29/35/83/87/101/175/182/220/254/354/370/375/381/484 | Existing job events, ledger, inference cost rows and basic health are real. Missing portions include retained cloud health transitions, latest/minimum version display, last successful/failed job and runtime/failure metrics, seller provider-cost/margin presentation, platform cost dashboard, storage/egress telemetry and grouped scheduled-demand workload/value. `WorkerState.audit` (`state.ts:41`) stores only event/source/job/time; actual research accounting finish (`tools.ts:32`) discards host/status/bytes/query hash required by 254. Fill specific metrics from actual data, not placeholder values. Routing changes also need the 181 audit record. |
| R18 Active functional owner batches | P1 / PARTIAL | 7/74-77/102-119/125/153-157/233/305-318/357-368 | Import closure, lifecycle/rollback/retirement/reviewed diffs, catalog search/profile/matching, results/presets and examples are assigned/in progress. New code is landing; do not repeat earlier NOT_IMPLEMENTED claims. Full example assets, ownership/consent, contract revalidation and Publish successful test as example need evidence under 368 even if an individual PUBLIC capability may have zero examples (357). Await focused owner handoff then adversarially verify actual routes/UI/Worker together. |
| R19 Public dependency projection | P1 / PASS, scoped fix verified | 153 PRD-0142/0143; 299-302, especially 300 SEC-0098 | `capabilityDto` now emits normalized dependency categories and safe resource identifiers/types, excluding raw graph IDs/names/edges/hashes/source/grants and credential nodes; owner-only version detail retains the frozen graph. Auditor read the projection/lifecycle/page code and sentinel regression, then independently passed 14 real-DB integration plus 4 unit tests at 11:03:49 CEST (09:03:49 UTC). This closes the reported leak, not every UI/taxonomy/agent clause in these sections. |
| R20 Account/job abuse ceilings | P2 / PARTIAL, implementation reported | 25/30/176/326; SEC-0032; AGT-0075/AGT-0076 | Initial API limiter chose keyId OR userId and lacked combined account/endpoint and daily job/spend/chat-turn controls. Parent now reports atomic counters and migration 012 applied. This is no longer an absent-code claim; verify concurrent admission, counter rollback/idempotent retries, key-plus-account aggregation and calendar boundaries before PASS. Existing wallet, plan and inference budgets were already real. |
| R21 Declared pause support | P2 / PARTIAL | 433-434, 436, 448-449 | Actual pinned runtime pause/resume works and is tested. Public/runtime capability metadata does not declare the specified FULL_RESUME/RESTART_STEP/NOT_SUPPORTED support level, and job UI cannot show that declaration. Expose the real supported behavior (a single fixed supported mode is sufficient initially); do not implement checkpoints just because the example mentions them. |
| R22 Scheduled timing history | P2 / PARTIAL | 455-456 JOB-0217; 467/484 | Job persists one mutable `scheduledAt`, created/started/completed timestamps and state events. `background.ts:68-71` overwrites scheduledAt and logs the new time, but original promised earliest eligibility is not separately retained; optional short-lived quote is deleted. Preserve original reservation eligibility and changes plus eligible/queued timing (columns or explicit immutable events), so SLA/queue metrics and buyer changes are reconstructable. |
| R23 Complete local/failure acceptance | P1 / UNTESTED | 34/44/70/89-92/449/570-573; DEV-LOCAL-023-029 | Real deterministic happy path and scoped fault tests exist. No complete fresh-clone supported-Mac receipt or one real-runtime matrix covering offline, unavailable sandbox, payment failure, cancellation, invalid output and timeout with cleanup/settlement was supplied. Validate the exact remaining cases without rerunning already-proven Docker checks unnecessarily. |
| R24 Trace-only closure | P2 / PARTIAL | All mixed/aggregate sections in matrix | Coverage TODO is not absence. Existing atomic contract, policy, ledger, signed protocol, storage, broker, planning and local infrastructure behavior must receive exact source-clause/test mapping. The parent owns coverage/scripts. A passing test count or one file path cannot close an entire section with several still-open clauses. |

R08-R24 priorities are next-batch candidates, not silent assignment to existing
owners. High-risk findings were sent directly to relevant owners. R01-R05 have
explicit parent assignments; R19 is now independently verified fixed. Test/source
line numbers identify the inspected snapshot and can move as shared work lands.

### Earlier Parent Batch Update

This supersedes absence wording in the original finding snapshots above, without
converting owner statements into independent PASS evidence:

- R03: terms implemented; parent reports 12 passing cases.
- R04: direct S3 upload/client/Worker protocol implemented; parent reports 5 upload
  and 14 protocol cases passing. Reaudit streaming, finalization, revocation and
  large-file behavior before closing the aggregate section.
- R05: CI jobs and isolated Worker artifact packaging implemented and tested by
  parent. Review actual workflow/release gates; a local packaging test is not an
  executed remote CI/security-runner receipt.
- R08: parent implemented operator security policy/admin API and enforcement
  gates; typecheck was pending at handoff. Catalog owner is integrating policy.
- R09: parent implemented buyer v1 aliases and DTO runtime validation; unit tests
  reported passing. Adversarial scope/idempotency/asset response review remains.
- R20: parent reports atomic account/endpoint/day job count/spend/chat counters;
  migration 012 now applied. Concurrent enforcement evidence remains to review.
- R13: subsequent source inspection sees new account-scoped payout ingestion,
  provider reconciliation, persisted payout records and earnings summaries in
  `apps/api/src/billing.ts`. This is active implementation, not still an absent
  payout path; no ready handoff or independent payout test receipt yet.
- Parent next owns R10 webhook terminal/test behavior, R11 privacy/retention and
  runbook, R21 pause-support declaration, and R22 timing history.
- R06 remains explicitly credential-blocked. R07 acceptance is externally
  unproven, not a claim that the orchestration/file implementation is absent.

Remaining functional work or acceptance includes R13 payout reconciliation, R14
problem-report/review completion (review portion now assigned to Feynman), R16 combined research/private-resource flow,
the file-backed example portion of R18, and R12 supported media presets. R15 and
the enumerated R17 diagnostics/telemetry remain narrower P2 gaps. Do not expand
these into unspecified account recovery, native desktop GUI, autonomous buying,
browser automation, direct-card payment or future email requirements.

## Evidence Keys

These keys identify inspected implementation and targeted evidence, not blanket
test-count certification. Prior independent runs and parent/owner-attributed
runtime receipts are detailed in INDEPENDENT-AUDIT. A row that references an
active owner batch stays PARTIAL until the relevant residual is verified.

| Key | Concrete source and verification boundary |
|---|---|
| E01 | `packages/contracts/src/index.ts`, `contracts.test.ts`: immutable four-field execution hash, integer price tiers, safe defaults, conditional required values, named outputs, JSON schema, MIME/cardinality and finite queue estimates. The independent 14-case contract receipt predates the current format/pause/DTO batches. |
| E02 | `packages/policy-engine/src/index.ts`, `policy.test.ts`: authoritative availability, overnight/DST windows, closures/overrides, pause precedence, queues and forbidden production flags. Actual API dispatch and scheduled fairness evidence is E04, not just pure policy tests. |
| E03 | `apps/api/src/auth.ts`, `catalog.ts`, `capability-lifecycle.ts`, `catalog-page.ts`; `tests/integration/api.test.ts`, `apps/api/test/catalog.unit.test.ts` and `catalog.integration.test.ts`: authorization/private grants, immutable owner-only versions/diffs, public projection and server filtering. Auditor independently passed the current 14 catalog integration plus 4 unit cases at 11:03:49 CEST (09:03:49 UTC), including policy integration. Broader account/terms work does not automatically inherit that receipt. |
| E04 | `apps/api/src/jobs.ts`, `worker.ts`, `background.ts`; `apps/api/test/protocol.integration.test.ts`, `background.integration.test.ts`, `tests/integration/worker-protocol.test.ts`: real DB/signed synthetic Worker admission, cancellation, exact manifest/revision, pinned price/version, named result, fairness and persisted plan repair. The independent 75-test integration receipt is historical and not OpenClaw proof. |
| E05 | `packages/billing/src/ledger.ts`, `stripe.ts`, `apps/api/src/billing.ts`, `disputes.ts`; ledger tests plus `apps/api/test/billing.integration.test.ts` and `disputes.integration.test.ts`: balanced ledger, idempotent settlement, refund/dispute/transfer uncertainty and audited restoration. Independent 22 focused cases and historical 75 integration cases; synthetic Stripe events are not real-provider payment proof. |
| E06 | `packages/marketplace-agent/src/`, agent/inference/orchestration/synthesis/execution-security/repair tests, `apps/api/src/agent.ts`: typed discovery/planning, bounded budgets, mapping, authorization, provider adapters and persisted repair. Independent 99-case receipt; provider-wire fixtures are not dedicated live-provider proof. |
| E07 | `packages/storage/src/index.ts`, `office.ts`, `apps/api/src/assets.ts`, `apps/worker/src/results.ts`, `packages/openclaw-adapter/src/files.ts`; storage, contract, real-S3 and named-output protocol tests. Private object authorization/scanning/hash/size/expiry are implemented. Current direct transfer batch needs its own receipt and does not prove large-file throughput merely by existing. |
| E08 | `packages/research-broker/src/{broker,egress,connectors,policy}.ts`, `packages/integrations/`, broker/egress/integrations tests: DNS/redirect/IP/method/domain restrictions, typed broker operations and private-data denial. Actual Worker wiring in `apps/worker/src/tools.ts` still matters: R16/R17 cannot be closed by the reusable library alone. |
| E09 | `apps/worker/src/{runtime,state,secrets,readiness,inference,transport,capability-health}.ts`, `packages/openclaw-adapter/src/`, `security/sandbox/`; Worker/adapter security/state/import tests and actual parent-run Docker smoke. Image `sha256:96dd4f5334bf57fea81af17192864ae57e0f520aa492afb8591ad7fd7077ae52` exercised real OpenClaw, broker, file output, empty tools and pause/resume/cancel with deterministic inference. It did not exercise real paid inference/Stripe. |
| E10 | `packages/resource-broker/src/`, `apps/worker/src/resources.ts` and resource configuration; broker tests and 19 actual Postgres cases; `scripts/e2e-fixture.ts` and `docs/FULLSTACK-FIXTURE.md`. Actual selected FILE/resource/sandbox/S3/settlement receipt: parent job `4dc67566-84d6-496f-891a-8ac95a4581c1`, 01:32 UTC. Independent DB inspection confirmed settled job/asset/balanced ledger and revoked grants; provider deterministic, payment fake. |
| E11 | `apps/web/src/components/`, `apps/web/src/lib/`, `apps/web/tests/`, `tests/e2e/`, web Playwright flows: functional forms, results, schedules and purchase/restore interactions. Parent baseline 24 browser cases includes six explicitly mocked UI-boundary cases; admin lost-response tests use real API/DB. New UI changes require current screenshots/browser acceptance; source is not rendered proof. |
| E12 | `infrastructure/compose.yaml`, `scripts/{dev-setup,dev,dev-reset,health,e2e-fixture,package-worker}.ts`, dev-config/dev-ports tests and `.github/workflows/ci.yml`: actual local setup and isolated deterministic infrastructure. Parent's newly implemented runtime CI/artifacts R05 needs current workflow/run attribution. Fresh-clone supported-Mac acceptance remains separate R23. |
| E13 | `apps/api/src/webhooks.ts`, `apps/api/test/security.test.ts` and buyer settings: actual API webhook HMAC, SSRF checks, persistent retries and sanitized metadata. The separate integrations library cannot stand in for missing route/UI operations. |
| E14 | Independent 09:42:44 UTC: `apps/api/test/operations-policy.integration.test.ts` 11 PASS and `security-policy.test.ts` 2 PASS. Named admin/CAS/purchase, v1 scopes, atomic limits/chat, reports, retention, webhook terminal, health, isolated maintenance and signed immutable usage assertions. Does NOT cover the newly reproduced containment rollback. |
| E15 | Independent 09:43:01 UTC: `payment-methods.integration.test.ts` 12 PASS and `payouts.integration.test.ts` 13 PASS; actual DB, synthetic Stripe SDK/events. Source `apps/api/src/billing.ts` and `packages/billing/src/stripe.ts`. Exact financial ownership/idempotency/backfill/reconciliation assertions, not live provider or buyer card-entry proof. |
| E16 | Latest independent 10:15:11 UTC: `example-assets.integration.test.ts` 15 + `pending-objects.integration.test.ts` 6 + web `examples.test.ts` 5 PASS. Actual PostgreSQL/S3 consent/copies/access/revocation/integrity/reuse/CAS/self-owned remapping plus pre-PUT intent, atomic target commit and simulated persisted recovery. Seller/buyer UI call sites reviewed. Curie's six browser passes are attributed: two real draft/storage flows, four response-fixture flows. No actual process-kill or paid-provider proof. Supersedes earlier 12-case receipt only for changed example scopes. |
| E17 | Independent Worker diagnostics 26 and service 5 at 09:42:44 UTC; discovery 16 and imports 8 at 09:45:37 UTC. `diagnostics.ts`, `service.ts`, `imports.ts`, adapter `discovery.ts`. Proves the named read-only discovery/closure/grants/consent/proof invalidation and diagnostic/service fixture cases, not broader config/observed discovery or a real login cycle. |
| E18 | Independent 09:42:44 UTC: `packages/storage/src/media.test.ts` 24 PASS; contracts format map and actual `inspectMedia` ingestion path source-read; web presets source-present. Bounded adversarial structure/reference checks are not codec-decoder execution or broad format acceptance. |
| E19 | R17 implementation-owner evidence, not independently self-certified: `operations.test.ts` 10 + `operations.integration.test.ts` 16 PASS at 09:38:58 UTC, types/lint PASS. Metrics/cost/coverage/recovery semantics and exclusions in `OPERATIONS-STATUS.md`. Parent owns ingestion/migration, Worker owns production/outbox, Curie owns current UI. |
| F01 | Explicit future clause in the source-scope table below. No test or implementation is asserted; DEFERRED eligibility applies only to that clause. |
| F02 | Example/recommendation or empirical product validation. Not demonstrated is not the same as an absent required MVP code path. |

## Whole-Catalog Matrix

Historical baseline: the 119 nonoverlapping source ranges below cover all 573 sections and all 1,701
catalog IDs. Range notation `A-0001..A-0003` includes both endpoints.
The current bounded checkpoint above supersedes stale residual/absence wording,
especially runbook, payment methods, formats, health and example-file paths.
This matrix remains a clause-mapping baseline, not a fresh count of code gaps.
Every ID inherits its source row's evidence state and scope, except the named
atomic overrides in the following table. For aggregate or mixed rows, PARTIAL
means the indicated implementation exists but the full source-section acceptance
does not yet pass. It does **not** count every underlying atomic clause as a
missing feature. R24 is a traceability task, not permission for mass PASS edits.

This conservative inventory has 411 PASS, 1,260 PARTIAL, 2 NOT_IMPLEMENTED and
28 UNTESTED ID classifications after the atomic overrides. These are audit
classifications, not passing-test counts or a completion percentage. The two
NOT_IMPLEMENTED IDs are the incident-runbook source section; other concrete
absent paths sit inside mixed PARTIAL sections with explicit R-findings.
Active parent batches supersede the historical absence wording, as recorded
above, but do not become PASS solely from reported implementation.

| Master sections | Catalog IDs | Evidence state | Default scope | Evidence | Implemented subset / exact residual |
|---|---|---|---|---|---|
| 1-5 | PRD-0001..PRD-0021, WRK-0001..WRK-0009 | PARTIAL | REQUIRED_MVP | E01,E03,E04,E05 | Core architecture exists; remaining R06/R13/R14 plus independent acceptance of parent R03/R08 batches. |
| 6 | WRK-0010 | PASS | RECOMMENDED | E09,E12 | Suggested stack substantially adopted; no mandatory desktop shell. |
| 7-9 | WRK-0011..WRK-0030, PRD-0022..PRD-0030, JOB-0001..JOB-0004 | PARTIAL | REQUIRED_MVP | E01,E04,E09 | Import closure and complete transition/audit metadata: R18/R17. |
| 10-11 | WRK-0031..WRK-0035, JOB-0005..JOB-0007 | PASS | REQUIRED_MVP | E04,E09 | Outbound pairing, signed offers, replay protection, accepted-attempt-only content. |
| 12 | IO-0001..IO-0006 | PARTIAL | REQUIRED_MVP | E07,E09 | Safe bounded files exist; large transfer/failure matrix remains R04/R23. |
| 13-17 | SEC-0001..SEC-0025, WRK-0036..WRK-0042 | PASS | REQUIRED_MVP | E08,E09,E10 | Dedicated local secrets, brokered read-only resources, deny-by-default tools/network/browser; future browser behavior excluded. |
| 18-23 | PRD-0031..PRD-0038, JOB-0008..JOB-0025, SEC-0026..SEC-0031, WRK-0043..WRK-0047, CAP-0001 | PARTIAL | REQUIRED_MVP | E01,E04,E09,E10 | Enforced isolation subset is proven; threat-model artifact, complete audit/version/release obligations remain R05/R08/R11/R17. |
| 24-25 | PAY-0001..PAY-0073, PRD-0039..PRD-0042 | PARTIAL | REQUIRED_MVP | E05,E09 | Atomic credit settlement and inference budgets exist; R01/R06/R13/R17/R20. |
| 26 | AVL-0001..AVL-0002 | PASS | REQUIRED_MVP | E02,E04,E09 | Capacity admission, pause, heartbeat expiry and bounded waiting implemented/tested. |
| 27-30 | WRK-0048..WRK-0051, PRD-0043, OBS-0001..OBS-0003, SEC-0032..SEC-0034 | PARTIAL | REQUIRED_MVP | E03,E09,E11 | Buyer/seller core flows exist; import, reporting, economics and audit gaps R14/R17/R18. |
| 31 | IO-0007..IO-0009 | PASS | REQUIRED_MVP | E01,E07,E11 | Output limits, safe rendering, MIME/signature validation, production scan gate and authorized downloads. |
| 32 | CAP-0002..CAP-0004 | PARTIAL | REQUIRED_MVP | E03,E09 | Pinned artifacts and immutable jobs exist; full import/version lifecycle batch R18 pending. |
| 33 | SEC-0035 | PASS | REQUIRED_MVP | E09 | Unreviewed native plugin import rejected; internal reviewed sandbox plugin is not personal plugin reuse. |
| 34-35 | WRK-0052, OBS-0004 | PARTIAL | REQUIRED_MVP | E04,E09,E10 | Security tests and basic operational data exist; complete runner/failure/metrics acceptance R05/R17/R23. |
| 36 | JOB-0026..JOB-0031 | PASS | REQUIRED_MVP | E04,E09 | Missing sandbox/secret and disconnect/crash fail closed, with bounded release/recovery. |
| 37-39 | PRD-0044..PRD-0048 | PARTIAL | REQUIRED_MVP | E03,E05,E09,E11 | Working private fixture is not legal/privacy/product launch evidence: R06/R11/R23. |
| 40 | WRK-0053 | PASS | RECOMMENDED | E01,E02,E04,E09 | Monorepo and independently tested package boundaries; suggested folder spellings are not mandatory. |
| 41 | PRD-0049..PRD-0050 | PASS | RECOMMENDED | E03,E04,E05 | Equivalent authenticated services exist; this early route sketch is not a literal URL contract. |
| 42 | CAP-0005..CAP-0007 | UNTESTED | EXPLICIT_FUTURE | F01 | External Marketplace MCP future; later buyer REST requirements are not deferred. |
| 43 | SEC-0036..SEC-0037 | PARTIAL | REQUIRED_MVP | E09,E05,E06 | Compatibility/provider documentation recorded; fresh external API review is not inferred from file existence. |
| 44-45 | SEC-0038..SEC-0041, PRD-0051..PRD-0053 | PARTIAL | REQUIRED_MVP | E04,E09,E10 | Actual local sandbox/resource proof exists; genuine paid staging and all attack experiments R06/R23. |
| 46 | PRD-0054..PRD-0056 | UNTESTED | RECOMMENDED | F02 | Real supply/demand/economic validation is not established by synthetic fixtures. |
| 47 | PRD-0057..PRD-0060 | UNTESTED | EXPLICIT_FUTURE | F01 | Hosted workers, royalties, other runtimes, controlled browser and hardware economy are post-MVP. |
| 48-51 | SEC-0042..SEC-0054, WRK-0054..WRK-0060 | PARTIAL | REQUIRED_MVP | E01,E04,E05,E09 | Core boundaries implemented; not a whole-product certificate. Build order is guidance, not an extra feature. |
| 52 | WRK-0061..WRK-0063 | PASS | RECOMMENDED | E01,E09 | Suggested layout adopted in substance; adapter isolation is implemented. |
| 53-55 | IO-0010..IO-0012, CAP-0008..CAP-0009, WRK-0064..WRK-0067 | PARTIAL | REQUIRED_MVP | E01,E04,E09 | Runtime request/manifest validation and durable state exist; public response-contract and complete snapshot proof R09/R18. |
| 56-57 | WRK-0068..WRK-0073 | PARTIAL | REQUIRED_MVP | E09 | R02 background installation; doctor lacks some explicit cloud/clock/runtime diagnostic checks (R15). |
| 58-60 | WRK-0074..WRK-0081, JOB-0032..JOB-0037 | PASS | REQUIRED_MVP | E09 | Pinned adapter, explicit sandbox and unique attempt directories; scoped runtime cleanup evidence. |
| 61 | IO-0013..IO-0028 | PARTIAL | REQUIRED_MVP | E07,E09 | Actual named file E2E works; parent reports direct transfer implementation/tests; complete file acceptance R07/R12. |
| 62-64 | IO-0029..IO-0034, JOB-0038..JOB-0041 | PASS | REQUIRED_MVP | E04,E07,E09 | Private generated object keys, bounded supported formats, lifecycle deletion and safe stage events; token streaming not required. |
| 65-70 | PRD-0061..PRD-0062, WRK-0082..WRK-0092, CAP-0010..CAP-0013, JOB-0042..JOB-0047 | PARTIAL | REQUIRED_MVP | E04,E07,E09 | Authorization, cancellation and limits proven in scoped tests; retention disclosure and full process failure matrix R11/R23. |
| 71-73 | SEC-0055..SEC-0061, API-0001..API-0004 | PASS | REQUIRED_MVP | E09,E10 | Typed resource/inference broker, credential isolation and conservative per-job/daily budgets implemented and exercised. |
| 74-77 | CAP-0014..CAP-0017, SEC-0062, PRD-0063..PRD-0065 | PARTIAL | REQUIRED_MVP | E03,E09,E11 | Atomic publish/consent and API lifecycle/projection independently tested; full Worker/UI import acceptance remains R18. |
| 78 | JOB-0048..JOB-0049 | PARTIAL | REQUIRED_MVP | E03,E04,E05 | Global dispatch/account/refund controls work; remaining operator policies R08. |
| 79 | SEC-0063..SEC-0064 | NOT_IMPLEMENTED | REQUIRED_MVP | R11 | Required incident-response runbook not found; no equivalent operational procedure in inspected docs. |
| 80-83 | TST-0001..TST-0005, PRD-0066..PRD-0067, OPS-0001..OPS-0002, WRK-0093..WRK-0096 | PARTIAL | REQUIRED_MVP | E04,E05,E09,E12 | Basic CI/migrations/environment separation exist; parent R05 runtime/artifact batch reported ready; full correlation/retention R17. |
| 84 | OBS-0005..OBS-0006 | PASS | REQUIRED_MVP | E04,E09,E12 | Real DB/Redis/S3 readiness, local Worker health, no LAN management listener. |
| 85-87 | PRD-0068..PRD-0072, PAY-0074 | PARTIAL | REQUIRED_MVP | E03,E05,E11 | Search/reviews/basic economics exist; catalog batch, reporting and payout/metric gaps R13/R14/R17/R18. |
| 88-92 | IO-0035..IO-0037, WRK-0097..WRK-0098, TST-0006..TST-0012 | PARTIAL | REQUIRED_MVP | E04,E05,E09,E10 | Real deterministic single-job proof exists; genuine paid providers, full fixtures/failure/security release gate R06/R07/R23. |
| 93-95 | IO-0038..IO-0041, TST-0013..TST-0015, PRD-0073 | PARTIAL | REQUIRED_MVP | E01,E04,E12 | Strict build and scoped tests pass; milestone/code-quality scope does not waive outstanding behavior. |
| 96-99 | PRD-0074..PRD-0079, AGT-0001..AGT-0014 | PASS | REQUIRED_MVP | E01,E09,E11 | Explicit consent, local-execution acknowledgement and dedicated inference gating; no personal credential copy. |
| 100-119 | AGT-0015..AGT-0034, CAP-0018..CAP-0051, UI-0001..UI-0015, SEC-0065, JOB-0050..JOB-0055, PRD-0080..PRD-0082 | PARTIAL | REQUIRED_MVP | E01,E02,E09,E10,E11 | Local inference and dependency enforcement exist; complete discovered closure, observed dependency UX and cost presentation R17/R18. |
| 120 | PRD-0083..PRD-0087 | PARTIAL | REQUIRED_MVP | E03,E05,E11 | Unified account works; parent reports terms acceptance and 12 cases passing; independent R03 closure pending. |
| 121 | PRD-0088..PRD-0089 | PASS | REQUIRED_MVP | E05 | Buyer credits and seller entitlements remain separate immutable accounts. |
| 122-128 | PRD-0090..PRD-0100, CAP-0052, JOB-0056..JOB-0059 | PARTIAL | REQUIRED_MVP | E03,E11 | Core marketplace/history/favorites/paid reviews work; catalog completeness, review edit/reporting/profile details R14/R18. |
| 129-145 | PRD-0101..PRD-0125, AGT-0035..AGT-0046, IO-0042..IO-0044, JOB-0060..JOB-0065, PAY-0075..PAY-0077 | PARTIAL | REQUIRED_MVP | E06 | Discovery, approval, persisted DAG, mapping, budget and repair implemented; real multi-job staging R07 and matching/catalog completion R18. |
| 146-149 | PRD-0126..PRD-0133, CAP-0053..CAP-0054 | PASS | REQUIRED_MVP | E06 | Platform/seller separation, typed tools and purchase authorization enforce limits outside the model. |
| 150-157 | PRD-0134..PRD-0148, CAP-0055, IO-0045 | PARTIAL | REQUIRED_MVP | E03,E06,E11 | Plans/conversations, ranking and current server catalog filtering tested; matching/evaluation/UI acceptance remains R18/R24. R19 leak fixed. |
| 158 | IO-0046..IO-0049 | PASS | REQUIRED_MVP | E01,E06 | Deterministic named output/file/MIME/cardinality/size compatibility tests reject impossible chains. |
| 159-162 | PRD-0149..PRD-0158 | PARTIAL | REQUIRED_MVP | E03,E06,E11 | Later acceptance makes approved multi-job orchestration required; staged PDF/provenance/reviews R07. |
| 163-165 | PRD-0159..PRD-0162, AGT-0047..AGT-0055 | PASS | REQUIRED_MVP | E06 | Separate inference domains, two normalized provider adapters, independent configuration and no-key degradation; wire-contract evidence, not live-provider proof. |
| 166 | SEC-0066..SEC-0069 | UNTESTED | REQUIRED_MVP | R06 | Managed production secrets/IAM/rotation deployment evidence not supplied; local templates do not prove deployment. |
| 167-172 | AGT-0056..AGT-0069, IO-0050..IO-0052 | PASS | REQUIRED_MVP | E06 | Per-task router/profile abstraction, validated tools/output, bounded provider normalization and schema tests. |
| 173 | AGT-0070..AGT-0073 | PASS | RECOMMENDED | E06 | Optional fallback is bounded and does not retry policy/authorization failures; fixture-tested. |
| 174-178 | PRD-0163..PRD-0174, AGT-0074..AGT-0076 | PARTIAL | REQUIRED_MVP | E06 | Provider health, cost rows and conservative budget exist; complete limits/metrics/privacy disclosure R11/R17/R20. |
| 179-180 | PRD-0175..PRD-0178, AGT-0077..AGT-0078 | PASS | REQUIRED_MVP | E06 | Explicit synthesis-data consent; invalid or failed inference has no purchase side effects. |
| 181-190 | AGT-0079..AGT-0097, IO-0053..IO-0056, UI-0016..UI-0018, PRD-0179..PRD-0182, TST-0016..TST-0018 | PARTIAL | REQUIRED_MVP | E06 | Provider adapters and boundary fixtures exist; routing audit/operational evidence R17/R24 and dedicated-provider R06. |
| 191 | PRD-0183..PRD-0184 | PASS | REQUIRED_MVP | E06,E09 | Platform inference and seller runtime have separate authority, secrets and economic attribution. |
| 192-193 | IO-0057..IO-0062 | PARTIAL | REQUIRED_MVP | E01,E07,E09,E11 | Shared contract is real; promised supported media and file-heavy acceptance R07/R12. |
| 194-197 | IO-0063..IO-0070, UI-0019 | PASS | REQUIRED_MVP | E01,E07,E11 | Scalar/choice/file constraints, strict values and MIME/size ownership validation; no arbitrary regex required. |
| 198 | UI-0020..UI-0021 | PARTIAL | REQUIRED_MVP | E01,E09,E11 | Common preset/runtime format gap R12; unsupported GIF/DOCX/etc clauses remain conditional. |
| 199 | IO-0071 | UNTESTED | EXAMPLE | F02 | 500 MB/4K example values are not mandatory defaults; separate file-heavy acceptance remains R07. |
| 200-203 | PRD-0185, IO-0072..IO-0078 | PASS | REQUIRED_MVP | E01,E11 | Semantic descriptions/groups, simple conditions and normalized shared schema implemented/tested. |
| 204 | UI-0022 | PARTIAL | REQUIRED_MVP | E01,E11 | Visual builder/form exists; new preset/result/preview changes require current owner verification R18. |
| 205 | IO-0079..IO-0081 | PASS | RECOMMENDED | E01,E09,E11 | Automatic contract suggestions optional; no automatic exposure of local resources, explicit seller contract required. |
| 206-209 | PRD-0186..PRD-0189, CAP-0056, IO-0082..IO-0083 | PASS | REQUIRED_MVP | E01,E04,E06,E09,E11 | Generated inputs validate at browser/API/Worker; missing required files cannot be fabricated; safe scalar defaults. |
| 210 | CAP-0057..CAP-0059 | PARTIAL | REQUIRED_MVP | E03,E11 | Providing examples is optional per capability; supporting safe public examples is later explicit acceptance R18. |
| 211-214 | IO-0084..IO-0097 | PASS | REQUIRED_MVP | E01,E07,E09 | Named results, required assets, canonical output root, bounded untrusted data and binary references exercised. |
| 215 | IO-0098..IO-0101 | PARTIAL | REQUIRED_MVP | E01,E09 | Unsupported contracts fail publication/local consent; broader media/tool compatibility acceptance R07/R12. |
| 216-217 | IO-0102..IO-0106 | PASS | REQUIRED_MVP | E07,E09 | Content sniffing and denied unsafe archives; general archive extraction is conditional on support. |
| 218-220 | IO-0107..IO-0112, CAP-0060..CAP-0062 | PARTIAL | REQUIRED_MVP | E07,E09 | Parent reports R04 direct/streamed transfers implemented; verify current limits/revocation; R17 storage/egress telemetry remains. |
| 221-224 | IO-0113..IO-0117, PRD-0190..PRD-0191 | PASS | REQUIRED_MVP | E01,E03,E06 | Immutable contract references, safe new versions and deterministic typed compatibility; active lifecycle UI enhancements separate. |
| 225-227 | IO-0118..IO-0124, PRD-0192..PRD-0195 | PASS | REQUIRED_MVP | E04,E07,E11 | Buyer asset ownership/scoped grants and seller-hardware warning exist; previous-asset picker is optional. |
| 228-230 | IO-0125..IO-0129, PRD-0196..PRD-0197 | PARTIAL | REQUIRED_MVP | E07,E09,E11 | Cleanup and local representative test work; explicit retention/preview/example path R11/R18. |
| 231-232 | TST-0019, PAY-0078..PAY-0080 | PASS | REQUIRED_MVP | E01,E05,E07,E11 | Validity distinct from quality; fixed-tier delivery/refund policy, no mandatory variable pricing. |
| 233-236 | PRD-0198..PRD-0203, IO-0130..IO-0132 | PARTIAL | REQUIRED_MVP | E01,E06,E11 | Same contract is consumed; matching/results/presets and full file acceptance R07/R12/R18. |
| 237-238 | PRD-0204..PRD-0212 | PARTIAL | REQUIRED_MVP | E08,E09 | Declared research/connectors exist; combined private-resource flow R16; external actions remain excluded. |
| 239-249 | SEC-0070..SEC-0077, PRD-0213..PRD-0227, UI-0023, CAP-0063..CAP-0064 | PASS | REQUIRED_MVP | E08,E09 | No raw sandbox network, typed search/fetch, SSRF/DNS/redirect/method/domain constraints; no generic external actions. |
| 250 | IO-0133..IO-0135 | PARTIAL | REQUIRED_MVP | E08,E09 | Safe text fetch exists; optional binary downloads are not implemented and cannot be advertised (R16). |
| 251-253 | PRD-0228..PRD-0232, SEC-0078..SEC-0081 | PASS | REQUIRED_MVP | E08,E09 | No generic download-and-run or prompt-authorized permission expansion. |
| 254-256 | PRD-0233..PRD-0236 | PARTIAL | REQUIRED_MVP | E08,E09 | Hard bounds exist, but actual Worker discards network audit detail and hardcodes seller research controls: R16/R17. |
| 257-258 | PRD-0237..PRD-0239 | PASS | REQUIRED_MVP | E01,E11 | Seller explicit network/tools consent and generated buyer-facing research indicator. |
| 259-260 | PRD-0240..PRD-0244 | PARTIAL | RECOMMENDED | E01,E08 | Optional source fields representable; suggested video-ad canonical fixture not exercised, distinct from mandatory file-heavy acceptance. |
| 261 | PRD-0245..PRD-0247 | PARTIAL | REQUIRED_MVP | E08,E09,E10 | Research plus private resources impossible under current job-wide taint gate: R16. |
| 262-263 | PRD-0248..PRD-0250, API-0005..API-0007 | PASS | REQUIRED_MVP | E08,E09 | No arbitrary request bodies; typed declared connectors and denied private-data flow. |
| 264 | PRD-0251..PRD-0252 | UNTESTED | EXPLICIT_FUTURE | F01 | Browser rendering optional unless a chosen canonical capability needs it; search/fetch sufficient initially. |
| 265 | PRD-0253..PRD-0257 | UNTESTED | REQUIRED_MVP | R11 | Operational website restrictions/terms/data-use review not established by SSRF tests. |
| 266-273 | SEC-0082..SEC-0089, PRD-0258..PRD-0267, CAP-0065..CAP-0066 | PASS | REQUIRED_MVP | E08,E09 | Narrow primitives, connection-boundary validation, broker credentials and sanitized fetched content; local broker is allowed MVP option. |
| 274-277 | PRD-0268..PRD-0276, SEC-0090..SEC-0091 | PARTIAL | REQUIRED_MVP | E08,E09 | Adversarial fixtures pass; configured provider health/public research and combined-capability acceptance R06/R16. |
| 278-284 | PRD-0277..PRD-0292, PAY-0081..PAY-0083 | PASS | REQUIRED_MVP | E01,E05,E11 | Canonical fixed USD tiers, exact fees/net, integer money and seller-selected enabled tier. |
| 285-288 | PRD-0293..PRD-0299, PAY-0084..PAY-0088 | PARTIAL | REQUIRED_MVP | E01,E05,E11 | Retail/net presentation exists; provider-cost economics and conditional tax/legal launch evidence R11/R17. |
| 289-293 | PAY-0089..PAY-0097, PRD-0300..PRD-0303 | PASS | REQUIRED_MVP | E04,E05,E06 | Immutable price snapshots, quoted purchases, balanced earnings and compensating full refunds. |
| 294-298 | PRD-0304..PRD-0315, PAY-0098..PAY-0101 | PARTIAL | REQUIRED_MVP | E01,E05,E11 | Tier economics implemented; complete seller detail/test trace R17/R24; future tier/currency operations not mandatory. |
| 299-304 | SEC-0092..SEC-0106, CAP-0067..CAP-0070 | PARTIAL | REQUIRED_MVP | E01,E03,E06,E11 | Generated permissions and no-network filter implemented; R19 raw graph leak independently fixed; complete taxonomy/UI/agent trace remains. |
| 305-318 | CAP-0071..CAP-0086, SEC-0107, TST-0020, PRD-0316..PRD-0322, JOB-0066..JOB-0067 | PARTIAL | REQUIRED_MVP | E03,E04,E09 | API immutable history/diff/rollback/retirement/CAS/private grants independently passed; connected UI/import acceptance remains R18. |
| 319-321 | API-0008..API-0016 | PASS | REQUIRED_MVP | E03,E04 | High-entropy hashed/scoped/revocable API keys, identities separated from Worker; rate controls exist. |
| 322-323 | IO-0136..IO-0137, CAP-0087 | PARTIAL | REQUIRED_MVP | E03,E04 | Shared buyer services implemented; parent R09 v1 aliases/DTO validation reported tested; independent route acceptance pending. |
| 324-325 | PAY-0102..PAY-0105, API-0017..API-0019 | PASS | REQUIRED_MVP | E04,E05 | Same secured-payment and idempotency service for buyer API/web; fingerprint conflict and insufficient-funds tests. |
| 326 | API-0020..API-0021 | PARTIAL | REQUIRED_MVP | E03,E04 | Parent R20 atomic account/endpoint/day counters implemented; concurrency/retry/calendar behavior remains to verify. |
| 327-335 | PRD-0323..PRD-0328, JOB-0068..JOB-0071, API-0022..API-0027, AVL-0003 | PARTIAL | REQUIRED_MVP | E08,E13 | Signed SSRF-protected durable webhooks implemented; send-test and terminal-delivery observability R10. |
| 336 | JOB-0072..JOB-0073 | UNTESTED | RECOMMENDED | E13 | End-to-end public webhook automation example not demonstrated with a real controlled HTTPS receiver. |
| 337-353 | AVL-0004..AVL-0018, JOB-0074..JOB-0089, PRD-0329..PRD-0330, PAY-0106..PAY-0108, WRK-0099..WRK-0100, UI-0024..UI-0025, CAP-0088..CAP-0089 | PARTIAL | REQUIRED_MVP | E02,E04,E09,E11 | Core authoritative availability/capacity/queue/disconnect paths proven; complete UI and health trace R17/R24. |
| 354-356 | AVL-0019..AVL-0020, CAP-0090..CAP-0094, PRD-0331..PRD-0332 | PARTIAL | REQUIRED_MVP | E02,E04 | Missing operational metrics plus complete acceptance trace R17/R24, not missing availability engine. |
| 357-368 | CAP-0095..CAP-0109, PRD-0333..PRD-0341, IO-0138..IO-0144 | PARTIAL | REQUIRED_MVP | E03,E11 | Scalar executed-example consent/provenance/version checks independently passed; file-backed examples, public assets/media and full UI/template acceptance remain R18. |
| 369-378 | OBS-0007..OBS-0011, WRK-0101..WRK-0105, CAP-0110..CAP-0113, SEC-0108..SEC-0115, JOB-0090..JOB-0093 | PARTIAL | REQUIRED_MVP | E03,E09,E11 | Real heartbeat/basic dashboard exists; parent R08 policy gates implemented, minimum/latest presentation and health telemetry need acceptance. |
| 379-380 | WRK-0106..WRK-0108 | PASS | REQUIRED_MVP | E09 | Local health/doctor provide sanitized distinct cached/active checks; completeness of individual doctor probes tracked at 57. |
| 381 | WRK-0109..WRK-0111 | PARTIAL | REQUIRED_MVP | E03,E09 | Current health overwritten; retained cloud transition timeline R17. |
| 382-392 | JOB-0094..JOB-0114, PRD-0342..PRD-0344 | PASS | REQUIRED_MVP | E02,E04,E09,E11 | Durable local/global/capability pause, cloud-only-new-work semantics, bounded queued waits and explicit readiness-gated resume. |
| 393-395 | SEC-0116..SEC-0118, JOB-0115..JOB-0117, PRD-0345..PRD-0348 | PARTIAL | REQUIRED_MVP | E02,E04,E09 | Security latch and stop work; parent R08 revocation/update gates implemented, current enforcement/acceptance trace pending. |
| 396-425 | PRD-0349..PRD-0364, AVL-0021..AVL-0058, UI-0026..UI-0027, JOB-0118..JOB-0134 | PARTIAL | REQUIRED_MVP | E02,E04,E11 | Timezone/DST/overnight/schedule/pause behavior implemented; preview and current web acceptance R18/R24. Optional future overrides excluded. |
| 426-450 | JOB-0135..JOB-0210, PRD-0365..PRD-0367 | PARTIAL | REQUIRED_MVP | E04,E09,E11 | Actual process/broker pause/resume/cancel proven; declared pause-support metadata/UI R21 and full failure matrix R23. |
| 451-486 | AVL-0059..AVL-0073, JOB-0211..JOB-0243, PAY-0109..PAY-0110, UI-0028..UI-0031, PRD-0368..PRD-0381, CAP-0114, AGT-0098..AGT-0101 | PARTIAL | REQUIRED_MVP | E02,E04,E05,E11 | Scheduled credit reservation, requeue/fairness/expiry work; original eligibility history/demand detail R17/R22 and UI trace R24. |
| 487-500 | PRD-0382..PRD-0393, AVL-0074..AVL-0086, CAP-0115..CAP-0118, JOB-0244..JOB-0248, UI-0032..UI-0039 | PARTIAL | REQUIRED_MVP | E02,E06,E11 | Deterministic human/agent timing and hard constraints present; matching/current UI and scenario trace R18/R24. |
| 501-504 | PRD-0394..PRD-0395, AVL-0087..AVL-0096 | PASS | REQUIRED_MVP | E04,E06 | Persisted repair, exact revision, live availability/price revalidation and bounded BUSY metadata independently regression-tested. |
| 505-517 | PRD-0396..PRD-0407, JOB-0249..JOB-0254, TST-0021, AVL-0097..AVL-0109, CAP-0119..CAP-0120, AGT-0102..AGT-0103 | PARTIAL | REQUIRED_MVP | E06,E11 | Explicit scheduling/deadline constraints, DAG critical path and no silent spend work; remaining real orchestration/UI/eval trace R07/R24. |
| 518-546 | UI-0040..UI-0086, JOB-0255..JOB-0266, PRD-0408..PRD-0423, AGT-0104..AGT-0106, SEC-0119..SEC-0121, CAP-0121..CAP-0123, PAY-0111..PAY-0112, API-0028..API-0029 | PARTIAL | REQUIRED_MVP | E11 | Functional responsive design and prior real browser evidence exist; new rendered-state/visual/accessibility review still needed, not a mandate for redesign. |
| 547 | UI-0087..UI-0088 | UNTESTED | EXPLICIT_FUTURE | F01 | Eventually/practical screenshot regression automation; current screenshot inspection 546 remains required. |
| 548-550 | UI-0089..UI-0093, PRD-0424 | PARTIAL | REQUIRED_MVP | E11 | Restrained component system exists; final rendered quality evidence is not inferred from source alone. |
| 551-573 | DEV-LOCAL-001..DEV-LOCAL-029 | PARTIAL | REQUIRED_MVP | E12,E09 | Actual Compose/dev/fixture evidence exists; fresh-clone and complete local failure matrix R23. Parent's DEV-LOCAL-002 correction now directly maps both 552 and 554; this does not promote implementation evidence. |

## Atomic Scope and Evidence Overrides

These take precedence over the broader source row. Future subclauses in a mixed
section are not a waiver of its current safety or acceptance obligations.

| Catalog ID | Evidence state | Scope | Evidence | Exact interpretation |
|---|---|---|---|---|
| PRD-0050 | PASS | REQUIRED_MVP | E04 | Separate signed Worker protocol, not the optional early buyer URL sketch. |
| CAP-0005 | PARTIAL | REQUIRED_MVP | E03,E04 | Mixed section: preserve service boundaries now; only external Marketplace MCP is future. Later buyer REST remains required. |
| CAP-0006 | PASS | REQUIRED_MVP | E03,E04 | Shared services preserve the future adapter boundary; not a certificate that external MCP exists. |
| WRK-0054 | PARTIAL | RECOMMENDED | E09,E12 | Recommended build sequence, not a separate product feature; its security invariants remain required. |
| WRK-0055 | PASS | REQUIRED_MVP | E09,E10 | Actual sandbox/resource/security invariant tests exist, with narrower execution receipts below. |
| WRK-0056 | UNTESTED | RECOMMENDED | F02 | Historical development ordering is not established and is not a new runtime feature. |
| WRK-0057 | PASS | REQUIRED_MVP | E09,E10 | Actual contained Worker execution with scoped private-resource access. |
| WRK-0058 | PASS | REQUIRED_MVP | E09,E10 | No undeclared general-machine access in the implemented sandbox policy. |
| WRK-0061 | PASS | REQUIRED_MVP | E01,E09 | Mixed structural recommendation and mandatory adapter boundary implemented. |
| WRK-0063 | PASS | REQUIRED_MVP | E09 | Adapter boundary is mandatory; example folder layout is not. |
| IO-0081 | PASS | REQUIRED_MVP | E01,E09 | No silent import-to-public-resource exposure; explicit declarations and consent required. |
| PRD-0251 | PASS | REQUIRED_MVP | E08,E09 | Current browser-disabled safe-search/fetch boundary implemented; future browser-rendering feature not claimed. |
| PRD-0252 | PASS | REQUIRED_MVP | E08,E09 | Master expressly permits safe HTTP search/fetch for first implementation. |
| AGT-0081 | PASS | REQUIRED_MVP | E06,E09 | Configuration and buyer DTOs do not return provider keys. |
| PAY-0099 | PASS | REQUIRED_MVP | E01,E05 | Single shared price-tier source, not duplicated component prices. |
| PAY-0100 | UNTESTED | EXPLICIT_FUTURE | F01 | Later tier administration/multicurrency operations; historical snapshot invariants are not deferred. |
| PAY-0101 | PASS | REQUIRED_MVP | E04,E05 | Persisted price snapshots and compensating ledger preserve historical earnings. |
| JOB-0132 | PASS | REQUIRED_MVP | E02,E04 | Manual pause precedence tested even where temporary overrides are optional. |
| PRD-0354 | PASS | REQUIRED_MVP | E02,E09,E11 | No automatic wake promise; offline Worker remains non-executable. |
| PRD-0355 | PASS | REQUIRED_MVP | E02,E04 | Host must be online; scheduled state does not bypass Worker readiness. |
| JOB-0144 | UNTESTED | EXPLICIT_FUTURE | F01 | Conditional future native Worker UI; current web seller controls remain required. |
| JOB-0145 | PASS | REQUIRED_MVP | E04,E09,E11 | Current primary seller web UI has actual job pause/resume/cancel. |
| JOB-0168 | UNTESTED | RECOMMENDED | F02 | Encouraging application checkpoints is not a mandate to implement arbitrary checkpoint engines. |
| JOB-0169 | UNTESTED | EXAMPLE | F02 | Conditional RESTART_STEP video example; current runtime uses process suspension. |
| JOB-0170 | PASS | REQUIRED_MVP | E04,E09 | Durable job/attempt state permits later checkpoints; checkpoint feature itself can evolve after MVP. |
| JOB-0233 | PASS | REQUIRED_MVP | E04 | Explicit NOW/WHEN_AVAILABLE preference implemented; v1 surface tracked separately by R09. |
| JOB-0234 | PASS | REQUIRED_MVP | E04,E05 | Failed immediate admission does not reserve credits. |
| JOB-0237 | PASS | REQUIRED_MVP | E04,E11 | Persisted job events/in-app status provide current scheduled updates. |
| JOB-0238 | UNTESTED | EXPLICIT_FUTURE | F01 | Recommended future/email notifications are explicitly not required account recovery or SMTP scope. |
| JOB-0239 | PASS | REQUIRED_MVP | E04,E11 | State-change updates, not minute-by-minute scheduled countdown notifications. |

## Source-Bounded Deferral Rules

| Master source | Eligible future, conditional or recommended behavior | Required current boundary that remains |
|---|---|---|
| 6, 56, 429; WRK-0010, WRK-0068..WRK-0070, JOB-0144/0145 | Optional native desktop shell; signed/notarized public distribution belongs to that release stage. | CLI-first background-after-login lifecycle and primary seller web job controls. |
| 24.18/24.27; PAY-0001 aggregate | Advanced rolling reserves are recommended; direct per-job card authorization is later. | Credit-funded atomic ledger, payment methods/receipts, Connect, refunds/disputes and actual payout status. |
| 38 | Legal/tax/MoR review before public launch is conditional on launch, not an invented private-beta tax engine. | Accurate current responsibility, refund and privacy disclosures; no unsupported compliance claim. |
| 42, 47; CAP-0005..CAP-0007, PRD-0057..PRD-0060 | External Marketplace MCP, hosted supply, royalties, additional runtimes and later controlled browser/hardware economy. | Preserve boundaries; later 319-336 explicitly require buyer REST/API keys/webhooks and supersede early exclusion wording. |
| 64 | Optional token streaming. | Sanitized status/events; never hidden chain-of-thought. |
| 140, 159 | Delegated autonomous budget mode, indefinite or recurring buying, bidding and other runtimes are later/outside this MVP. | Approved multi-job DAG orchestration is explicit acceptance in 160-161, not deferred by 159's earlier wording. |
| 173, 181 | Provider fallback optional; provider admin GUI later, environment configuration valid for MVP. | Enabled fallback must preserve budgets/authorization; no key display; routing changes need audit. |
| 198-199 | Formats marked where supported are conditional; example 500 MB/4K settings are not mandatory defaults. | Unqualified common presets and 235's actual file-heavy acceptance are not excused. |
| 205, 225 | Automatic contract suggestions and previous-asset convenience picker are optional. | No inferred exposure of local resources; strict buyer asset ownership and shared contract validation. |
| 217-218 | General archives may remain disabled; multipart object upload is later/needed only at relevant storage limits. | Safe extraction if supported; direct object upload and streamed transfer now. |
| 232, 296; PAY-0100 | Variable addons, tier administration and multicurrency evolution. | One fixed tier source; exact immutable historical prices, earnings and refunds. |
| 238, 264, 269 | General external actions/browser rendering unnecessary; cloud research broker preferred future architecture. | Hardened local broker is allowed MVP; safe search/fetch, no raw sandbox network or private-data exfiltration. |
| 328 | Started/cancelled webhooks recommended; orchestration-specific webhook extensions later. | Job completion/failure, signatures, retries, buyer observability and test operation. |
| 357, 363, 368 | Individual capabilities may have zero examples; buyer-job publication needs a future all-party consent/licensing flow. | Product supports safe examples and explicit seller-owned example publication; no automatic buyer data publication. |
| 412-413, 416 | Temporary schedule overrides optional; either global or per-capability schedule model is acceptable initially; automatic wake not promised. | Manual pause wins; timezone/DST and real online readiness still enforced. |
| 435; JOB-0168..JOB-0170 | Application checkpointing can evolve after MVP; video RESTART_STEP is a conditional example. | Durable state must permit it; current actual pause semantics must be declared accurately under 434. |
| 461 | Direct-card authorization expiry only applies if that later payment model is enabled. | Credit reservation/release and bounded scheduling remain required now. |
| 480-481, 506 | Scheduled multi-step plans may be restricted; not-before/exact-window and advanced execution modes can be future. | Real single-job NOW/WHEN_AVAILABLE, explicit user approval, deadlines, price/budget and no silent rerouting. |
| 483; JOB-0238 | Explicitly recommended future/email notifications. | In-app scheduled-job status updates; no countdown spam. |
| 547; UI-0087/UI-0088 | Eventually/practical screenshot-regression automation. | Current actual screenshot inspection/rendered quality under 546; cannot certify UI quality from source alone. |

## Release and Reaudit Boundaries

Already-implemented scopes requiring exact trace rather than reinvention include
shared contracts/defaults/output matching, policy/DST/pause precedence, signed
Worker replay/admission, immutable financial settlement, accepted-attempt file
authorization, isolated broker/resource access, approved plans/exact revision,
persisted repair and local Compose infrastructure. The E-keys point to their
real implementation/tests; remaining aggregate acceptance is named separately.

New owner code requires focused review of its actual integration points. A
library test cannot prove it is called by the API or Worker; a DTO type cannot
prove runtime validation; a Docker smoke cannot prove live provider payment.
Parent-executed receipts are retained with attribution. Test output local time
is Europe/Zurich (CEST, UTC+02:00 on this date), not UTC unless converted.

Whole-MVP remains incomplete until required functional residuals and required
acceptance evidence close. External credentials, public-launch/legal review,
fresh-clone evidence and explicitly future features are distinct categories.
No source, catalog, coverage or original specification was edited in this R24
audit phase. The earlier separately authorized R17 implementation is disclosed
above and is not independently self-certified.
