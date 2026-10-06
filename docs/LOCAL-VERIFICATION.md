# Local Verification Evidence

Date: 2026-10-06. Host: macOS, Node 26.5.0, pnpm 10.32.1,
Docker Engine 29.7.2, installed OpenClaw 2026.8.2 (0965053).
Observed commands are recorded below; none imply full-spec release approval.

## Latest Bounded Checks

- 14:46:08 CEST: full integration rerun passed **594/594 across48 files**
  in48.29s, including migration024 publication evidence, explicit per-version
  local-execution acknowledgement, reduced file ceilings, due-job wait reasons,
  shared-device scheduling and the actual admin dispatch switch. Uses local
  PostgreSQL/S3 and controlled HTTP provider fixtures, not paid providers or
  Docker execution. The14:43 run had593 passes and one stale diagnostic-field
  assertion. Its test now includes the structured securityWarnings snapshot;
  the legacy response remains unchanged. A first correction mistakenly named
  the item array warnings instead of items; the scoped37-case rerun passed
  at14:45 before the successful complete rerun.
- 14:44:44: complete default suite passed **1427 tests**,467 explicit opt-in
  cases skipped, across117 passed and36 skipped files. Includes local portable
  capability-package, seller-test bundle, daily-job and connector tests present
  at that source checkpoint. Ongoing UI/discovery edits still need final checks.
- 14:40:22: central file-limit contracts, actual file validation/collection and
  adapter combined text/file budgets passed **33/33**. Earlier API/S3/protocol
  file-limit checks passed27/27 in the targeted run. A new assertion initially
  expected a decoded-byte error, but the encoded-size guard correctly rejected
  earlier; its expectation was corrected without loosening the guard.
- 14:34:22: catalog integration passed20/20 after migration024,25 total
  migrations. First publication freezes the approved manifest/inference-config
  hashes, Worker/OpenClaw versions, image/policy proof and dependency/skill hashes.
  Existing published-version DB protection rejects mutation; subsequent retests
  cannot change that receipt. Seller history exposes it, public DTOs do not;
  historical versions are null rather than reconstructed. Explicit local-execution
  consent was subsequently added and passed in the594-case run above.
- Canonical correlation assertions now cover real-fixture HTTP headers/DTO,
  local Worker attempt, output-upload/output-asset lineage and ledger job keys.
  They are source changes awaiting the new image/full-stack run, not evidence
  borrowed from the14:27 old-image receipt below.
- 14:27:33 CEST: parent repeated actual `pnpm test:e2e:faults` successfully on
  immutable image `sha256:4cf5b9b2b420774d780acfef09fe2d1ce9ff73d60f29c7ffb69b0c1a0bf91c7f`.
  Fixture `eab151ab-2331-4b1c-9462-25f8717da16c`, successful job
  `f8bc36f0-535f-40f0-9603-959bc0ace65c`: real file read,112-byte generated result,
 13 synthetic inference requests across validation/matrix/success, one capture,
  one seller earning, one platform fee and one balanced settlement, replay checked.
  Seven faults passed: insufficient funds, offline runtime, unavailable sandbox,
  buyer pre-start cancellation, running seller cancellation, invalid output and
  execution timeout. Paid failed jobs each released once with no capture/earning;
  no fixture containers remained. Timeout overshoot was93ms on a30-second limit.
  Actual API/Worker/Docker/S3, fake local payments and development-only scanning;
  no real provider, browser or production Redis maintenance. This process started
  before the new correlation patch and does not attest the future download image.
- 14:27:15: parent correlation HTTP/adapter/purchase replay checks passed **12/12**.
  Canonical identity is the existing persisted Job UUID, not a redundant mutable
  field. Tests prove trusted success headers, no caller override/private logging,
  isolated request metadata and rejection of mismatched runner trace pairs.
  Initial unit fixtures used Fastify request logging unlike production and a
  symlinked macOS temporary path; corrected fixtures retain production guards.
  New runner trace emission still requires the rebuilt-image runtime acceptance.
- 14:21:22 CEST: complete default suite passed **1242 tests**, with444 explicit
  opt-in cases skipped; full lint passed. This is not a replacement for the566
  actual-service cases below or the separate Docker/browser/live-key gates.
- 14:24: actual `pnpm test:e2e:faults` first failed before any purchase at
  `CAPABILITY_TEST_NOT_READY`: the strict Worker diagnostics consumer had not yet
  accepted the newly added structured warning snapshot. Sandbox and dedicated
  synthetic inference proofs passed; pairing showed unknown cloud verification.
  Fixture `a03dfe1b-9207-4169-a5d1-345af0d8f8d4` cleaned up without errors.
  The Worker schema was aligned rather than relaxed, and a fresh run is pending.
- 2026-10-06 14:18:12 CEST: parent full `pnpm test:integration` passed
  **566/566 cases across 47 files**, including actual signed Worker response
  round-trips, pending shared-device admission, reporting, canonical payment
  recovery and the new seller identity/live capability DTOs. The global strict
  response hook and web response parser are enabled. PostgreSQL, local S3 and
  synthetic provider fixtures are used; this does not certify real inference,
  Stripe accounts, Docker execution or browser behavior. Full repository
  `pnpm typecheck` passed at this source checkpoint.
- 14:15:55: parent live-capability health integration passed **3/3** in an
  isolated migrated PostgreSQL schema, plus **8/8** response-boundary units.
  Counts include historical-version jobs and do not clip draining work above
  configured limits. Last success retains its exact version/timestamp, excludes
  missing/future completion dates and is null without evidence. Public/foreign
  callers cannot obtain seller live state. Jobs/readiness are synthetic records,
  not runtime executions. Initial sandboxed DB connection failed before tests;
  the authorized local-network rerun passed without changing database guards.
- 14:09:01: immutable seller identity integration passed **3/3** using actual
  funded purchase and idempotent replay. Profile changes cannot rewrite purchase
  history, legacy unknown names remain null, and buyer overrides are rejected.
  Migration023 adds the immutable nullable snapshot, bringing the total to24.
  The broader targeted run had one malformed repair-fixture quote; after that
  fixture was corrected, protocol20 and capacity32 independently passed at
  14:16:35. The earlier full integration run at14:07 had509 passes and failures
  in test-only probe schemas and capacity/repair fixtures; it is superseded by
  the566-case run above, not retroactively counted as successful.
- 2026-10-06 14:01:22 CEST: parent independently reran storage/media/adapter
  security tests, **78/78 PASS** across four files. At14:01:29, real synthetic
  FFmpeg/Blender media integration passed **14/14**, using immutable image
  `sha256:4cf5b9b2b420774d780acfef09fe2d1ce9ff73d60f29c7ffb69b0c1a0bf91c7f`.
  Ordinary/fast-start MP4s remain valid and header-only/missing-track/media and
  corrupted-reference bodies fail at production validators. No provider, payment,
  browser or end-to-end API settlement was exercised by this bounded rerun.
- 13:58:23: parent-owned agent attachment suite passed **14/14** against a
  temporary migrated PostgreSQL schema. The actual authenticated chat route
  rejects client-supplied owner/metadata and unavailable IDs before inference
  initialization or the hashed daily agent quota changes. A valid request passes
  canonical selected metadata and output requirements and consumes one turn.
  Chat/model initialization is intercepted for this route-boundary test; there
  is no live provider, file-content read, asset grant or purchase. Generic HTTP
  anti-abuse limits still count rejected requests. An earlier test incorrectly
  asserted the generic HTTP buckets were unchanged; only the test was corrected.
- 13:59:15: **18/18** new shared-response/server-boundary cases passed. This is
  an implementation checkpoint: the central hook is not yet enabled globally
  while the remaining route groups and UI wiring are being integrated.
- 13:43:10: **189/189** marketplace-agent tests passed, including the final
  **18** public-discovery cases. This supersedes the earlier188/17 checkpoint
  only for that source state; new structured matching is a separate later batch.
- Web owner's 13:44 checkpoint reports **112** units, **66/66** full expanded
  browser cases and **10/10** root browser cases. Both owned development servers
  were stopped and the Next/build slot returned. See WEB-STATUS for exact scope;
  this precedes the new attachment, warning and response-validation integration.

## Subsequent Integration Checkpoints

The sections below retain the earlier 03:37 local baseline. They are historical
receipts, not a claim that later code has already passed every expanded gate.
Current work continues beyond that baseline:

- 13:08 CEST: seven coverage-parser cases passed. Merge/audit now check root
  files and `.github` evidence paths as well as package paths, reject traversal,
  and still do not treat file existence as implementation proof.
- 13:14: migrations 021/022 applied, 23 total. Job pause limits are immutable
  snapshots; cumulative pause use cannot decrease; a global-pause exception is
  constrained to an explicit RESUME_JOB command with a job ID.
- 13:16: eleven new actual isolated-PostgreSQL/API cases passed. They cover
  configured purchase/offer snapshots, duplicate pause/resume accounting,
  reservation retention, cumulative expiry through maintenance/control/events/
  result paths, exactly-one release/no earning, post-expiry data denial, explicit
  single-job resume under global pause, non-overridable security revocation,
  actor/attempt/state transition audit and historical input-contract retrieval.
  Initial fixture failures (terms hash acceptance and undeclared inference
  dependency) were corrected by the actual terms endpoint and approved synthetic
  dependency declaration; production guards were not weakened.
- 13:16: full repository typecheck passed. 13:17 default suite passed **928**
  tests, with **342** explicitly opt-in cases skipped; full lint passed. These
  are a source checkpoint while scheduler/capacity and Worker integration evolve,
  not a final build/browser/live-provider release receipt.
- 13:18: the complete integration command passed **411 cases across 33 files**.
  Its canonical-payment suite was the intermediate 26-case version; the final
  29-case independently rerun receipt below supersedes that bounded subset.
- 13:20: optimized Next production build passed after the shared source exports
  were made consistent with workspace TypeScript resolution. The browser owner
  then resumed testing; this build does not certify subsequent source changes.
- 13:22: root `pnpm db:migrate` passed with all 23 migrations already applied.
  The root database wrapper loads private local configuration without overriding
  explicit caller environment values. It performs no reset or schema push.
- 13:24: parent independently reran **29/29 canonical-payment reconciliation
  cases** against isolated real PostgreSQL schemas and the real Stripe SDK over
  an explicit synthetic loopback HTTP server. Source review covered bounded
  reads, durable paging/retry/lease fences, exact-once recovery, preservation of
  genuine event clocks and stale completed-transfer observations. No blocking
  defect was identified in that scope. No real Stripe account was contacted;
  sticky ambiguity holds require operator investigation. Tools typecheck passed.
- 13:31: parent independently source-reviewed availability telemetry and ran
  **44/44 cases**: 3 identity units, 14 new isolated-PostgreSQL telemetry cases,
  10 operations units and 17 existing operations integration cases. No blocking
  issue was identified in that bounded reporting scope. Actual purchase-rejection
  recording and maintenance registration remain separately owned integration.
- 13:33-13:35: independent Docker pause rerun passed expiry/cancel, while the
  successful resume case failed its last timing assertion: 74,988 ms measured
  after a requested 75,000 ms sleep. Successful execution, output integrity,
  two provider calls and removal assertions had passed. The fixture now polls
  the persisted wall-clock pause origin with a small margin; the original
  >=75,000 ms assertion and all production guards remain unchanged. A fresh
  complete rerun is required; this failed run is not recorded as PASS.
- 13:39: all **188 marketplace-agent tests** passed, including 17 new public
  description/contract/example discovery cases. Scoped types and lint passed.
  See `PUBLIC-DISCOVERY-REVIEW.md`; actual attachment compatibility and live
  provider quality remain distinct, not inferred from public keyword matching.
- 13:40: independent rerun of the fixed pause fixture passed **3/3** on unchanged
  image `sha256:4cf5b9b2b420774d780acfef09fe2d1ce9ff73d60f29c7ffb69b0c1a0bf91c7f`.
  Job `7b3ad407-9d20-4a5b-9339-3b13dc5b0137` used 3,416 ms before pause,
  paused for 75,254 ms and completed in 86,341 ms wall time with two provider
  calls and verified output hash
  `7e30a0963dd7228010756b856a9c60c583a7015454e52c756cad1bca64e01b38`.
  Two-second pause expiry cleaned up at 2,189 ms; cancellation at 159 ms.
  Both delivered no result and emitted one terminal event. All containers were
  removed. Actual Worker/SQLite/Docker/OpenClaw were exercised; cloud readiness,
  delivery and provider responses were synthetic, and API settlement was not
  exercised. The earlier timing-only failed run remains above.

- 11:31 CEST: migration 016 applied; 17 migrations through Worker usage receipts.
- 11:32: 18 focused checks passed for operator policy, retention, maintenance
  isolation, signed immutable Worker usage ingestion and receipt schemas.
- 11:33: real Docker/OpenClaw deterministic full-stack file fixture passed again,
  including file consumption, S3 delivery, replay and exactly-once balanced
  settlement. The first-heartbeat diagnostics bootstrap defect was fixed without
  bypassing version revocations. No paid-provider/Stripe acceptance is implied.
- 11:37: complete repository typecheck passed; 4 synthesis route tests passed.
- 11:38 expanded suites exposed obsolete unsupported-media assertions and a
  catalog fixture relying on the first 100 results; owner corrections are in
  progress. These runs are not recorded as global PASS.
- 11:39: clean-source bootstrap passed with a frozen-lockfile install, private
  generated configuration, new schema/all 17 migrations and frontend/API proxy
  on ports 3001/4001 while 3000/4000 were occupied. Temporary processes/schema and
  source copy were removed. Existing Docker services were reused; this is not
  second-machine or clean-volume evidence.
- 11:40: optimized web build passed. Full lint passed at this checkpoint.
- 11:43: Worker/API/web private-beta archives passed closure/checksum checks;
  API/web archives also booted from an extracted temporary directory with isolated
  HOME. API health/config, web page and static assets passed without development
  source imports or provider keys. Production routing/readiness remains separate.
- Expanded browser run: 32/38 passed. Six failures cover a same-document reset
  token state issue and duplicated/missing fixture selectors/configuration in
  desktop/mobile tests. Fixes and reruns remain open, not silently counted as PASS.
- 11:52: all 14 operator-policy/retention tests passed, including revoked Worker
  and OpenClaw versions and blocked categories at dispatch, start/resume, payload,
  input download, output ticket creation and previously issued ticket finalization.
  No maintenance tick is needed to deny access, and no capture was created.
- 11:54: migration 017 applied; 18 migrations now include durable object
  publication intent before S3 PUT. Committing the target and publication is one
  transaction. Abandoned/expired stages have retryable delayed cleanup.
- 11:55: 11 real PostgreSQL/S3 tests passed for direct uploads and publication,
  including crash-after-PUT, lost acknowledgement, target/expiry mismatch,
  failed-cleanup retry, immutable committed data and conditional overwrite denial.
- 11:56: complete typecheck and lint passed; the full default test suite passed
  **713 tests**, with 192 explicitly opt-in integration/provider tests skipped.
  Those skipped tests are not included in the success count.
- The structural coverage audit now verifies **573/573 Master sections** and
  **1,701/1,701 catalog IDs**. Four parser tests reject missing/duplicate/unknown
  mappings and ignore fenced examples. This does not promote behavior to TESTED.
- 12:01: migration 018 applied, 19 total. The actual Blender/file fixture passed
  again on this schema (owner receipt in `FULLSTACK-MEDIA-FIXTURE.md`). Four
  containment cases plus 14 policy and 9 billing cases passed: damaged reservations
  cannot roll back capability/device/account restrictions, healthy reservations
  release once, and revoked jobs cannot resume even after a capability is restored.
- 12:03: the complete `pnpm test:integration` run passed **214/214** cases across
  25 files on actual PostgreSQL/S3. Synthetic provider/protocol boundaries remain
  explicitly labelled; this is not real Stripe or external inference acceptance.
- Expanded browser checkpoint: **42/44 passed**. All six previous failures are
  fixed; the new public-example download fixture is cancelled in Chrome on both
  viewports. That fixture and its remaining consent assertions need a passing rerun.
  New real direct-upload/example-draft/revocation and self-test promotion views
  passed. Parent inspected the new desktop draft and full-width mobile operations
  captures: readable content, no clipped controls or horizontal overlap.
- 12:09: all five containment cases passed, now including seller-owned Worker
  revocation and outsider denial. Independent audit also reran these five cases.
- 12:10: owner reran the actual Docker/OpenClaw fault matrix: all seven cases
  passed, including a 30-second timeout observed at 30.091 seconds with no capture.
  Successful file execution and exactly-once settlement also passed afterward.
  See `FULLSTACK-FIXTURE.md`; no external inference or Stripe was used.
- 12:15: 30 configuration tests and seven terminal-reservation recovery tests
  passed. Local/test Stripe rejects non-test secret keys even in fake mode, upload
  ceilings reject invalid values, and terminal jobs with unresolved reservations
  stay in manual review instead of being reported as recovered.
- 12:17: the complete expanded browser suite passed **44/44** on desktop/mobile.
  Actual S3-backed example downloads are asserted in the direct-upload case;
  the explicitly synthetic public-example case checks rendered metadata and
  selected-copy consent. Earlier 42/44 is retained as historical failed evidence.
  The separate root browser suite needs its fixture-only global catalog count
  corrected for existing valid local capabilities before its own final rerun.
- 12:18-12:19: the root browser suite passed **10/10** after explicit seed-identity
  assertions replaced the global count assumption. Existing unrelated favorites
  and balances were preserved. The complete unit suite passed **772 tests** with
  203 opt-in tests skipped; an earlier sandboxed invocation could not bind local
  HTTP ports and was stopped, then rerun with the required loopback access.
  The optimized web build passed. Full typecheck passed again after the fixture
  variable shadowing correction; full lint and scoped recovery/bootstrap lint
  checks also passed at their recorded source checkpoints.
- 12:23: the coordinated multi-seller DAG/PDF rerun passed with the main public
  schema reconciler stopped. Exact current-schema receipt and read-only cleanup
  audit are in `E2E-ORCHESTRATION-CONTROLLED-RECEIPT.json`. Four approved plan jobs
  cost 396 development cents, produced the PDF from three actual file reads,
  preserved four-source synthesis consent/provenance and settled exactly once.
  Historical concurrent-reconciler evidence is explicitly not used for this gate.
- 12:26: all six actual-DB containment tests passed, including terminal RESERVED
  recovery across a background retry without deleting the manual marker or
  inventing ledger entries. The financial owner also reports 53 focused cases
  for durable dispute/refund holds and recovery; independent review is separate.
- 12:30: updated API/web archives passed packaging and isolated extracted boot.
  This tests import closure, health/config, rendered web HTML and static assets,
  not production database readiness or deployment.
- 12:31: the full `pnpm test:integration` command passed **285/285** across 28
  files. This command includes API unit cases as well as actual PostgreSQL/S3
  integration; no external Stripe or paid inference was used.
- 12:48-12:49: 37 configuration and 13 account lifecycle cases passed, including
  HTTPS Stripe-test staging cookies, canonical-origin security independent of
  forwarded headers and production live-key precedence. The operations suite
  passed 17 cases including seller-scoped UTC-day/lifetime job counts independent
  of the selected reporting window.
- 12:52: migration 019 applied (20 total). Seven isolated-schema cases passed
  explicit USD storage/constraints without amount changes, retaining independently
  reported non-USD connected-account payouts.
- 12:54: 35 inference/debug cases passed. Development-only diagnostics require an
  explicit environment, warn at startup and redact all prompt/response/schema/tool
  content. Sink errors do not change provider calls or accounting.
- 12:56: `pnpm test:fresh-clone:runtime` passed from a temporary clean source copy,
  frozen-lockfile installation and new schema/all 20 migrations. The real Next
  buyer browser uploaded to S3, explicitly purchased once, obtained a real
  Docker/OpenClaw result, downloaded and checked its bytes/hash, and verified one
  balanced settlement/replay. The actual production BullMQ processor completed
  purchase wake and periodic work in exclusively leased Redis DB15; no manual
  maintenance call or test queue processor substituted for it. Source/schema,
  their objects, processes, containers and owned queue were cleaned successfully.
  Full scoped receipt: `FRESH-CLONE-RUNTIME-RECEIPT.json`. This used the same Mac
  and existing Docker services, deterministic inference, fake billing and
  DEVELOPMENT_ONLY scans, not an external staging or clean-OS proof.
- 12:59: migration 020 applied (21 total). Ten financial-contract cases and 14
  isolated PostgreSQL cases passed explicit immutable price/tax/credit-reservation/
  entitlement/commission/processing-cost interpretation. Unknown tax/processor
  fees remain null with explicit states, not fabricated zero costs or exemption.
  Preliminary development terms were versioned after the policy wording changed.
- 13:00-13:01: default suite passed **887 tests**, with 303 opt-in tests skipped.
  The full integration command passed **361 cases across 30 files**, including
  37 ledger-provenance, 40 containment/refund, 20 protocol and 14 financial-model
  cases. This is a source checkpoint while remaining owner work continues.
  Package/app types passed, but tools typecheck found a newly added HTTP test-mock
  signature mismatch; owner correction and final complete typecheck remain due.

The exact requirement inventory remains `docs/REMAINING-REQUIREMENTS.md`.
Credential-dependent staging, independent release/security acceptance and the
remaining owner batches must not be inferred from these scoped receipts.

## Infrastructure And Startup

Repeated `pnpm dev:setup` runs exited 0. The final run found seven applied Prisma
migrations and no pending migration. Setup preserved existing development balances,
verified the S3 bucket and refreshed separate buyer/seller/admin fixtures.
PostgreSQL, Redis and SeaweedFS were healthy on loopback ports 55432, 56379 and
59000. Persistent Compose volumes were used; no host database installation.
The `.env` and local pairing file are private, and no secret values are recorded
here. Initial incomplete bootstrap attempts were rerun after implementation.

`pnpm dev` served Next.js at http://localhost:3000 and Fastify at
http://127.0.0.1:4000. `pnpm dev:health` observed HTTP 200 liveness/readiness with
actual PostgreSQL, Redis and S3 connectivity. A genuinely clean second-machine
bootstrap has not been performed. Reset was not run against the user's data.

The root configuration regression tests prove that selected API/web ports update
the listener, browser proxy, Worker URL and CSRF origin together, and that local
setup/reset reject nonlocal or non-Kivro database/bucket targets.
An actual port-4000 occupancy test exposed and fixed macOS IPv4/IPv6 bind
differences. Both complete browser suites then passed through the live frontend
proxy to API port 4001 while 4000 returned a fixture HTTP 503. The temporary
listener was removed and normal ports 3000/4000 were restored afterward.

## Types, Tests And Build

- Full `pnpm typecheck` passed across all packages and the root tools/test harness.
- Full `pnpm lint` passed.
- Final `pnpm verify` exited 0: **371 unit tests passed**, 70 opt-in DB/S3
  tests skipped in that command, with types, lint and optimized Next.js production
  build succeeding for all 18 routes. This supersedes the earlier 368/369-unit
  snapshots. The last run at 03:37 Europe/Zurich includes the admin request UI
  and keyboard-accessibility follow-up, not only the earlier backend snapshot.
- `pnpm test:integration` exited 0: **75 passed** against actual PostgreSQL/S3,
  including 19 private-resource tests, financial fault handling and durable
  job/plan recovery beyond the first selection batch.
- The DB/S3 suite uses actual local services. Signed device proofs, Stripe events
  and provider responses in those tests are explicitly synthetic, not hardware
  attestation, external Stripe acceptance or model inference.
- A recovery fixture initially collided on a reused public key; it now generates
  a distinct fixture identity and the complete later suite passed.

## Browser Evidence

`pnpm test:e2e:web`: **10 passed**, Chrome at 1440x1000 and 390x844.
Real services cover search/empty state, favorites lifecycle, wallet, six seller
routes, offline purchase refusal, scoped API key create/use/revoke, file-contract
preview and refusal to publish without validation. Earlier editor test failures
were exact-label selector mismatches, fixed using the rendered accessible names.
The two added admin cases create a separate synthetic account, suspend it, require
a normalized restoration reason and call the real audited API. The first real
restoration response is intentionally lost after the server commit; the retry
reuses the same key and returns the same audit ID, then reads back active status.
Only response delivery is intercepted, not API responses or database behavior.
Initial setup failures were authenticated requests without the required Origin;
the test now supplies it without weakening server CSRF checks.
The focused admin cases were rerun after hiding the skip link while unfocused;
keyboard Tab still reveals and focuses it on desktop and mobile. Their final
screenshots were inspected. Two residual sessions from the failed test setup
were revoked by exact synthetic-account name/email filters; other users were
untouched, and all accounting/audit history was retained.

`pnpm test:e2e:web:flows`: **14 passed** at the same desktop/mobile sizes.
Eight are real-service workflows: upload/download metadata display, account/API
key/admin gating, draft save/export with named fields, dependency cycles/consent,
overnight schedule and persisted agent discovery without configured inference.
Six are explicitly intercepted queue/plan-repair UI boundary fixtures. Those six
prove presentation/request/consent behavior, not paid backend orchestration.

Screenshots in `.local/` and `apps/web/verification/` were reviewed. The marketplace,
Worker page, settings and contract preview/review were nonblank and readable with
no horizontal overflow at both viewports. These are selected workflow checks,
not exhaustive accessibility or visual-regression certification.

## Real Runtime, Deterministic Inference

Final observed sandbox image ID:
`sha256:96dd4f5334bf57fea81af17192864ae57e0f520aa492afb8591ad7fd7077ae52`.

`pnpm worker sandbox approve-image` exited 0 after actual mounted-canary,
network-none, non-root, readonly, seccomp, SSH and plugin/config isolation checks.
An image rebuild invalidated prior approval and correctly made the Worker unready
until this explicit retest. No personal workspace or Docker socket was mounted.

`pnpm test:sandbox` exited 0. Actual OpenClaw used the production host inference
broker against a loopback-only deterministic TEST provider. Four requests reserved
58,368 tokens and zero synthetic cost. Verified resource-broker reading, SSH file
writing, result-only collection, unique marker/hash, named asset mapping, an empty
tool allowlist and actual process-tree pause/resume/cancel. An earlier empty-tool
phase failed; the complete later run passed. No real-provider acceptance is claimed.

The real demo Worker was paired, used encrypted Keychain storage and remained
paused with no jobs. It was then stopped cleanly with `pnpm worker stop --all`.
Dedicated inference is not configured. This is a truthful readiness failure.

## Deterministic Full-Stack Fixture

The separately configured fixture in `scripts/e2e-fixture.ts` passed actual API
registration/pairing, required-file local validation, private publication/grants,
WorkerRuntime dispatch, required S3 input download/read, generated output upload,
authenticated download/hash and exactly-once balanced settlement/result replay.
It used nine deterministic provider requests and fake credits, not an external
model/payment account. No pass proofs were fabricated. The test device was paused
and revoked, grants/sessions revoked, and temporary Worker state removed after
persisted cleanup assertions. The receipt and limits are in `FULLSTACK-FIXTURE.md`.
Parent independently reran `pnpm test:e2e:fixture` at 01:10:54 UTC: exit 0,
job `8e864dea-d59c-48ba-89dc-78401c996c1a`, one 112-byte generated file with SHA-256
`d5c791431f1aa8e20594f4ac1604c7f0e845692d3187a1914d13e0213fd004b2`.
Persisted required-file validation/publication, private grants, signed result
replay and cleanup passed. The fixture's actual device was then revoked.
After the final backend hardening the fixture passed again at 01:32:02 UTC,
job `4dc67566-84d6-496f-891a-8ac95a4581c1`, 112-byte output SHA-256
`dd5aba6a6c5511f39f7bef36e2c3dccb45947b17acba9dbdb2f6f4fab9271d12`.
Again there was exactly one balanced capture/earning/fee and verified cleanup.

## Acceptance Not Passed

`pnpm test:e2e:local` exited **1** because no ready real-inference Worker-backed
file-output capability was available. It did not purchase a job or fabricate
success. Its full acceptance path requires actual uploaded input consumption,
generated file/private download/hash, distinct buyer/seller identities, exactly
one settlement and unchanged personal OpenClaw metadata. The metadata check never
reads credential file contents and is not a bit-for-bit content attestation.

Still required: dedicated seller and platform inference configuration; real
provider/paid file workflow; real Stripe test-account Connect/payment/webhook
acceptance; multi-seller final PDF workflow; complete real-runtime failure matrix;
real outbound webhook and production malware scanning; clean second-machine
bootstrap and production operations. Known code/product gaps are also recorded
in `implementation-status.md`; they are not all caused by missing credentials.

`pnpm coverage:audit` checks traceability integrity. The `--release` variant must
remain failing while required TODO/IN_PROGRESS/IMPLEMENTED/BLOCKED rows remain.
