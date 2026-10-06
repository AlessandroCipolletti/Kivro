# Platform Clause Trace

## Scope and Snapshot

Read-only review on 2026-10-06 of exactly 60 rows that were TODO in the 14:05 CEST report: WRK 40, API 7, TST 12, PAY 1. The companion `docs/coverage-platform-review.json` contains mergeable evidence proposals, not edits to the central matrix. Billing source remains frozen. No API, Worker, schema, image, Next or CORS changes were made for this review.

- Input report: `.local/coverage-report.json`, generated `2026-10-06T12:05:01.786Z`; SHA-256 `e073be436d71fd13d6bb7512f941a17ba2a71bf710f3a263b8f6859450cb5f34`.
- Authoritative Master SHA-256: `a191b4db071d3d1f6f75341b92a43979d7051f9b00f65757125dc5be0e3cbec9`.
- Central coverage hash at review start: `0444f82e620369cb85ecaa8aa39858036cacda31ecd83f11f7d9909dce1b2d72`; concurrent owners may change it. This review does not overwrite their evidence.
- Full Master sections read: 2, 6, 7, 15, 24, 27, 34, 40, 49, 50, 52, 59, 66, 73, 83, 91, 92, 94, 189, 231, 263, 319, 374, 381. Requirement catalog fragments were interpreted within those complete sections.
- No existing Graphify graph was available; a docs-only review did not generate one.

Initial trace statuses were 8 TESTED, 22 IMPLEMENTED, 27 IN_PROGRESS, 3 BLOCKED. After the separately authorized PR-02 fix below, proposed statuses are **8 TESTED, 23 IMPLEMENTED, 26 IN_PROGRESS, 3 BLOCKED**. There is no whole-section TESTED promotion. IMPLEMENTED means source-confirmed with explicitly bounded or unverified acceptance, not a certificate. All aggregate partials retain their literal unproven conditions. This is not a 100% completion assessment.

## Confirmed Implementable Gaps

These findings preserve the original review-time reproduction. Subsequent authorized implementation is recorded separately below, not silently rewritten as if the gap never existed. Other owners may independently address PR-01.

### PR-01: End-to-End Correlation Is Missing

Master section 83 / WRK-0093 requires a correlation ID across HTTP request, Job, JobAttempt, Worker message, OpenClaw invocation, output asset and settlement. `apps/api/src/app.ts` logs a Fastify request ID for server errors; `apps/api/src/config.ts` defines a request ID prefix. Job and attempt identifiers connect subsets of execution, but reviewed schema/protocol/runtime/audit paths do not carry one original request correlation through every required hop. Inference-debug request IDs are separate scoped identifiers, not this chain.

Reproduction: source search for `correlationId|requestId|x-request-id|correlation.id|traceId|trace_id` across applications, packages, security and scripts; inspect API error logging, Worker SQLite audit shape, protocol schemas, asset and financial records. Existing safe logging/usage tests do not assert cross-hop propagation.

Proposed owner-coordinated fix: server-owned persisted correlation identity, distinct from attempt identifiers, carried through validated protocol messages and narrow audit fields. Add one integration assertion spanning all listed hops including output and settlement, plus retry/replay identity and redaction assertions. Coordinate DB/API/protocol/Worker owners before implementation. This is an observability code gap, not evidence of a financial or authorization bypass. Reported to parent before proposing edits; no implementation in this review.

### PR-02: Declared Read-Only POST Is Not Configurable in Worker

Master section 263 / API-0007 explicitly permits legitimate authenticated research POST through a declared, fixed connector rather than arbitrary HTTP. `packages/research-broker/src/connectors.ts` supports typed fixed GET/POST with schema, data-policy and egress checks. However, production `apps/worker/src/connectors.ts` exposes no method in its strict configuration schema, and `connectorDefinition` always constructs GET. `apps/worker/src/tools.ts` uses that mapping for the production broker.

Executed a no-network reproduction using a synthetic endpoint and a parsed config with no credential:

```json
{"configuredMethod":"GET","declaredPostAccepted":false,"modelEndpointOverrideAccepted":false}
```

The test parsed the normal configuration, attempted the same object with `method: "POST"`, and attempted a model-provided endpoint override against its request schema. This confirms missing safe POST configuration, not an arbitrary-POST escape. Existing broker tests correctly deny arbitrary POST and endpoint/method/header overrides.

Proposed Worker-owned fix: immutable approved explicit GET/POST configuration, GET default for existing resources, fixed endpoint and typed body schema, existing credential/taint/rate/byte/time bounds, and production Worker-to-broker tests for approved POST and denied overrides. Notify the Worker owner before any edits. Parent and Laplace have been informed; no connector source change here.

## Precise Partial Boundaries

- Sections 7/27 import UX: the production CLI has structured discovery, unchecked defaults, strict closure selection, approval hashes, credential references and source-change detection. The 22 discovery and 8 import assertions do not demonstrate a rendered wizard clearly separating all five required import states or the complete human CAN/CANNOT preview. Dangerous items are rejected or marked for review; do not silently equate that with a verified dedicated visual group.
- Sections 15/49/59 isolation: generic exec is denied, fixed wrappers run inside approved network-none Docker, and runtime config is explicit. Internal staging uses approved read-only input/config host mounts. Do not turn the conditional internal-exec wording into a false zero-host-mount claim or claim all escape scenarios from policy unit tests. Real sandbox/image acceptance was not rerun here.
- Sections 2/49 supply targeting and build order: private DB/tool mechanisms exist, but fixtures cannot prove buyer willingness to pay, primary supply composition or historical implementation chronology. No invented prompt-only rejection policy is required by those examples.
- Section 52 recommends architecture, not exact directory duplication. Native config/discovery/execution are adapter-owned; Worker deployment/readiness and the owned sandbox are necessarily runtime-aware. No second runtime or enforced architecture/import-boundary test was verified.
- Section 66 Worker settlement authority: Worker signatures authenticate only Worker routes; user/admin/canonical webhook authorities own billing. Source confirms separation, but a dedicated valid-signed-device negative matrix against every billing route was not rerun or located. Do not promote that clause based solely on general job protocol tests.
- Section 73 uses the preferred host inference broker. Long-lived seller credentials stay outside the sandbox; its token is a fixed dummy. The dedicated-key-to-sandbox fallback is conditional and inactive. Synthetic native-provider HTTP tests and mocked Keychain storage do not prove commercial-provider account limits or actual OS Keychain operation.
- Section 94 environment template contains blank provider/Stripe fields, deliberately synthetic loopback DB/S3 fixture values and a replace-me session placeholder. It is not an entirely names-only/blank template. No personal secrets were inspected or exposed and no Git-history secret audit was performed; source inspection is not proof that all historical commits are secret-free.
- Sections 374/381 actual PG tests prove offline projection on expired heartbeat without receiving another heartbeat, safe owner-only history, warning-episode persistence and 90-day pruning. They do not prove every desktop reconnect display or the complete four-event narrative in rendered UI.
- Section 231 structural validity and semantic quality remain distinct. Schema/MIME/hash/path/size/parsability checks are not useful/correct-answer guarantees. Buyer reviews, tests and dispute/refund handling are separate; automated quality evaluators are explicitly future.

## Future and External Acceptance

PAY-0021 was checked against the full section 24, not just the isolated direct-payment sentence. Section 24.5 describes manual authorization/capture. Section 24.25 phase 5 says after credits work; section 24.27 explicitly sequences direct per-job payments after private-beta prepaid credits. Current code implements prepaid credits, not per-job manual-capture authorization and expiry. Keep that future architecture gap visible without manufacturing a current private-beta blocker or deferring other payment obligations. Sidecar status is conservative IN_PROGRESS; parent owns reconciliation with other evidence proposals.

The section 91 security gate remains aggregate IN_PROGRESS: many technical checks exist, but every listed test and explicit release authorization is not established here. External security review OR explicit accepted private-beta risk is the literal condition. Unsigned private-beta packaging by itself is not documented owner acceptance. No assertion that public onboarding has opened is made.

TST-0009, TST-0011 and TST-0012 are BLOCKED specifically for final external acceptance. Production Stripe SDK and actual OpenClaw runtime paths exist. Local deterministic inference fixtures and synthetic HTTP Stripe SDK tests do not replace the distinct-user real paid staging flow. Authorized Stripe TEST keys/account/Connect/webhook configuration, provider test/sandbox setup and an operator-controlled staging run remain required. No live or paid calls were made, and no fake acceptance result was generated. Text/file delivery, personal-environment preservation and exactly-once settlement must remain in that final run.

## Actual Verification Receipt

All times below are CEST, 2026-10-06. This review ran **464 passing tests across 21 distinct files**, plus API typecheck. Counts describe this bounded run, not a full repository or security acceptance suite.

1. **405/405, 17 files, 14:13:20**: adapter discovery/security; policy and protocol; resource broker unit; Worker imports/security/inference/diagnostics/state/usage; research broker/egress; marketplace agent/execution/orchestration/inference-debug. Some tests use actual synthetic loopback HTTP; others are unit fixtures. An initial restricted run had 31 listener `EPERM` failures and 374 passes. The complete escalated rerun allowed local listeners and passed 405; the failed invocation is not counted as a passing run.
2. **19/19, 14:13:43**: `packages/resource-broker/test/postgres.integration.test.ts`, real local PostgreSQL on port 55432, synthetic private fixtures with cleanup. Actual table ACL, write/DDL/COPY rejection, independent read-only transaction, timeout/cancellation, schema/output checks and health reauthentication/SELECT revocation were exercised. Not mocked PostgreSQL or seller data.
3. **22/22, two files, 14:14:07**: `apps/api/test/operations-policy.integration.test.ts` (16) and `apps/api/test/worker-warnings.integration.test.ts` (6), isolated local PG schemas and actual API projections. Relevant named assertions include `retains sanitized health transitions once and detects heartbeat expiry without receiving another heartbeat`, `persists first detection across independent clients and deduplicates concurrent observation audits`, and `retains fresh critical warnings while applying the existing 90-day history retention`.
4. **18/18, 14:18:43**: `packages/marketplace-agent/test/recommendations.test.ts`. Relevant assertion `rejects model unknown-id without copying fabricated facts or creating purchases` observes zero purchases and zero plans. The separate rerun agent test proves malicious model limits cannot raise buyer authority.
5. `pnpm --filter @kivro/api typecheck` passed. No new full build, lint, browser, Docker, remote CI, provider or paid staging run. Prior receipts in `docs/LOCAL-VERIFICATION.md`, `docs/OPENCLAW_COMPATIBILITY.md` and fixture docs remain explicitly historical, not executions by this trace.

Reproduction commands for this bounded receipt:

```sh
pnpm exec vitest run packages/openclaw-adapter/src/discovery.test.ts packages/openclaw-adapter/src/security.test.ts packages/policy-engine/src/policy.test.ts packages/job-protocol/src packages/resource-broker/test/broker.test.ts apps/worker/src/imports.test.ts apps/worker/src/security.test.ts apps/worker/src/inference.test.ts apps/worker/src/diagnostics.test.ts apps/worker/src/state.test.ts apps/worker/src/usage.test.ts packages/research-broker/test/broker.test.ts packages/research-broker/test/egress.test.ts packages/marketplace-agent/test/agent.test.ts packages/marketplace-agent/test/execution-security.test.ts packages/marketplace-agent/test/orchestration.test.ts packages/marketplace-agent/test/inference-debug.test.ts --maxWorkers=1
env KIVRO_INTEGRATION=1 pnpm exec vitest run packages/resource-broker/test/postgres.integration.test.ts --maxWorkers=1
env KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/operations-policy.integration.test.ts apps/api/test/worker-warnings.integration.test.ts --maxWorkers=1
pnpm exec vitest run packages/marketplace-agent/test/recommendations.test.ts --maxWorkers=1
pnpm --filter @kivro/api typecheck
```

The JSON inventory is checked against the frozen 60 IDs, all evidence paths must exist, and no central merge/apply command is run. Conflicting older or concurrent owner statuses are for the parent to merge conservatively.

## Authorized Follow-Up

After the read-only trace, the parent authorized PRD-A01 daily-job admission and PR-02 declared POST. Laplace confirmed the narrow file ownership and no race with his scanner branches. The following implementation is separate from the original 464-test trace. No billing, cloud schema, runtime, readiness, tools, research, adapter or image edits were made by this follow-up.

### PRD-A01: Local Daily Job Limit

Implementation: `apps/worker/src/state.ts`, new `apps/worker/src/job-limits.ts`, and only the limits import/help/command branch in `apps/worker/src/index.ts`. Tests: new `apps/worker/src/daily-jobs.test.ts`.

- Default: 100 accepted jobs per UTC day, configurable integer 1-10000. Pause remains the zero-admission control. Existing state receives the finite default without resetting attempts.
- `WorkerState.claim` checks the bound inside its existing `BEGIN IMMEDIATE` transaction, before the accepted attempt/outbox/audit. An indexed count of accepted-job history includes successful, failed and cancelled jobs across all capabilities. There is no refundable daily counter.
- Reopen, replay, acknowledgements, transitions and limit changes cannot erase consumption. UTC midnight starts the next allowance; time before the latest admitted attempt fails closed as clock rollback. Independent processes share the SQLite lock.
- CLI supports `limits status` and `limits configure --file CONFIG [--approve HASH]`. Input is strict `{ "dailyJobLimit": 100 }`, preview is nonmutating and approval requires the exact hash. No secrets, daemon startup, personal configuration or changes to existing inference `dailyUsdLimit`/`dailyTokenLimit` are involved.
- Boundary: this adds local admission enforcement only, not cloud daily-limit warnings/readiness projection. Any future deletion of attempt history must preserve admission provenance. No such pruning exists in the reviewed Worker paths.

From the repository root with the intended Worker home selected:

```sh
node --import tsx apps/worker/src/index.ts limits status
node --import tsx apps/worker/src/index.ts limits configure --file /absolute/path/to/limits.json
node --import tsx apps/worker/src/index.ts limits configure --file /absolute/path/to/limits.json --approve REVIEWED_HASH
```

### PR-02: Approved Read-Only POST

Implementation: `apps/worker/src/connectors.ts`; tests: new `apps/worker/src/connectors.test.ts`.

- Optional immutable GET/POST configuration preserves absent legacy method fields and their original approval hashes. GET is applied only in the runtime definition. Changing a method, including making an old implicit GET explicit, requires a new connector ID and dependency hash.
- Existing strict primitive field, per-string and field-count limits remain. POST also caps serialized typed JSON at 256000 bytes before credential resolution, accounting and transport. Model arguments cannot replace endpoint, method, headers, credential reference or body schema.
- Existing ConnectorRegistry and SafeHttpClient enforce the fixed HTTPS endpoint, exact approved host, public-address pinning, zero credentialed redirects, bounded response/time, approved credential child, PUBLIC-only data flow, per-job/daily/rate accounting and strict output schema. No generic POST tool was added.
- Immutable configuration check, store and audit now share a transaction, including failed-audit rollback. Read-only remains a seller-reviewed endpoint declaration, not a proof of the remote provider's side effects.
- Tests use production `JobToolBroker.create`, selection, secret resolution and SQLite accounting with synthetic HTTP transport. Egress tests use deterministic socket fixtures. No real external API/TLS provider or new Docker job acceptance was run.

### Final Receipt

**205/205 tests in 10 files at 14:32:10 CEST**, plus Worker typecheck and scoped lint passed. Counts: daily admission 19, connector 32, existing state 5, CLI controls 9, runtime 19, security 21, imports 8, research 15, broker 13, egress 64. The new admission suite includes actual independent-process SQLite races, restart/replay, midnight/rollback, failed/cancelled/successful-job accounting, atomic outbox failure and real CLI preview/approval. Connector assertions cover old GET hashes, immutable method changes, audit rollback, seven invalid methods, six override fields, private input, ten-call budget persistence and output schema rejection.

```sh
pnpm exec vitest run apps/worker/src/runtime.test.ts apps/worker/src/security.test.ts apps/worker/src/imports.test.ts apps/worker/src/research.test.ts apps/worker/src/connectors.test.ts apps/worker/src/daily-jobs.test.ts apps/worker/src/state.test.ts apps/worker/src/cli-controls.test.ts packages/research-broker/test/broker.test.ts packages/research-broker/test/egress.test.ts --maxWorkers=1
pnpm --filter @kivro/worker typecheck
pnpm exec eslint apps/worker/src/state.ts apps/worker/src/index.ts apps/worker/src/job-limits.ts apps/worker/src/daily-jobs.test.ts apps/worker/src/connectors.ts apps/worker/src/connectors.test.ts
```

An intermediate combined run was blocked by another owner's new `@kivro/contracts/seller-test` import before its package export landed (155 tests passed, three suites failed to load; Worker typecheck had the same missing-subpath errors). The owner fixed that export; the complete final run above passed. No unrelated files were edited or tests mocked to bypass it.

The initial path-check failure was corrected: the adapter module is `docker.ts`, and API assets live in `assets.ts`/`asset-uploads.ts`, not the mistaken draft names. All sidecar evidence paths validate. `pnpm coverage:merge` ran with `applied: false`; the central matrix is unchanged by this task.
