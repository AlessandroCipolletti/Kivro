# API, Database, Billing And Storage Status

Updated 2026-10-06. This is a scoped implementation handoff, not whole-spec or
production-launch certification. Exact requirement IDs are in docs/coverage-api.json.

## Owned Paths And Exports

- apps/api/src/app.ts exports asynchronous createApp({env,db,storage,billing,background,logger}).
- apps/api/src/main.ts starts Fastify and background maintenance with graceful shutdown.
- apps/api/src/background.ts owns BullMQ scheduling/recovery, transfer recovery and asset expiry.
- packages/database contains Prisma 6.19 schema, migrations, serializable retry helper and seed.
- packages/billing contains append-only ledger operations and the real Stripe SDK adapter.
- packages/storage exports createObjectStore, createStorage and ensureBucket;
  S3ObjectStore exposes ensureDevelopmentBucket and ensureBucket.
- apps/api/test and billing/storage source tests contain owned regressions.
- Root, shared contracts/policy, worker, web and parent tests were not edited.
  Workspace dependency installation remained parent-owned.

Database package scripts: generate, migrate, migrate:dev, seed, studio, typecheck.

## Implemented Behavior

Authentication uses scrypt passwords, durable hashed sessions, expiring/revocable
scoped hashed API keys, Origin/CSRF checks and explicit admin privileges. Any
normal account can buy and sell. API keys cannot inherit seller or admin powers.
Secrets are shown only at creation. Logs redact credentials. General rate limits
remain 180/minute per authenticated user/key/worker, otherwise IP; login/register
are 10/minute/IP and agent chat 20/minute. HTTP 429 survives the error handler.

Catalog supports search/detail, private grants, unlisted/public visibility,
favorites, settled-buyer reviews, seller drafts, new-version edits, publication,
pause and schedules. Public DTOs omit full schedules, internal instructions,
credential references and private dependency identifiers, names, graph edges,
content hashes and grant/source details. Dependencies are buyer-safe category
summaries and resource identifiers are normalized. Schedule changes audit
previous/new values and timezone, including changes through the main editor.

Execution manifests use the required shared executionManifestHash projection:
{ioContract, permissions, internalInstructions, dependencies}. Shared definition
validation runs before create/update/publish/readiness through this projection.
Approved dependency closure and adapter runtime limits are required. Published
versions and job ownership/input/prices are protected by PostgreSQL triggers.
Publication requires live nonpaused worker evidence bound to this manifest.
Heartbeats cannot restore a failed or never-tested version.
Unsupported worker file formats may remain in drafts but cannot pass validation,
publish, become available or accept an attempt. Storage supporting DOCX/XLSX does
not imply that the current worker supports those formats. Public availability
includes canQueue and a capacity-based estimatedQueueWaitSeconds; it is an
estimate, not a guaranteed start deadline.

Purchase atomically validates normalized input/assets, checks capacity and
availability, snapshots price, reserves credits, grants input access and records
idempotency/audit. Offline/full-capacity requests do not reserve money. NOW queue
acceptance is separate from canRunNow. Scheduled jobs remain outside the immediate
queue until eligible. Quotes expire; maximum wait, offer expiry, disconnection,
pause and runtime deadlines recover/release funds. Runtime excludes confirmed
paused intervals. Existing jobs keep their pinned version when publication changes.
Recovery rotates independent active/waiting cursors, so 250 future reservations
cannot hide execution/pause/disconnection/offer deadlines. Financial transitions
use short per-job serializable transactions, with bounded exponential retry jitter.

Seller/admin job controls, worker revocation, account suspension, dispatch kill
switch, full job refunds, seller earnings and structured audit are implemented.
Pause waits for a worker acknowledgement, not an API-only state assertion.

Buyer uploads/downloads and accepted-attempt worker access use actual private S3
bytes. Result validation resolves both aggregate and named FILE/FILES references
against attempt-owned assets, rereads bytes, verifies SHA-256/size and validates
the frozen contract before exactly-once settlement. Missing named assets cannot
settle even if the top-level assets envelope is omitted.

Marketplace conversations/plans persist in PostgreSQL. Plan updates use CAS;
approval requires expectedRevision. Purchases recheck exact expectedPlanRevision
under the plan lock, ownership, approval hash,
version/quote and total reserved/settled budget in the financial transaction.
Purchased job IDs persist separately from plan JSON. Prior-purchase lookup
recovers a job committed before plan CAS. CAS refuses to discard reserved/settled
jobs during concurrent repair. Cross-job files require explicit plan dependencies.
Platform inference has durable per-user and global daily cost reservations.
Repair/replan routes use explicit expectedRevision and atomic quiescent CAS on
the same plan lock as purchase. Completed work, retired paid attempts, budget,
repair history and purchased job IDs survive; repair clears prior approval.
Plan polling also uses a durable cursor, so twenty waiting plans cannot hide the
next approved plan. Bounded queue consent uses NOW quotes, not implicit scheduling.

Buyer webhooks have encrypted secrets, immutable signed outbox events, durable
bounded retries, HTTPS public-address checks and connection-pinned DNS. Liveness
and readiness inspect PostgreSQL, Redis and the S3 bucket; readiness reconnects
Redis after a prior failure.

## Worker Protocol

Signatures cover exact raw JSON or complete multipart bytes including boundaries.
Canonical request is METHOD + newline + pathname + newline + timestamp + newline
+ nonce + newline + sha256(rawBody). GET has empty body. Nonces are durable with
TTL, timestamp skew is bounded to 60 seconds.

GET /api/worker/offers returns SignedJobNotice, with no input/assets/instructions.
It includes a hash of the fixed full payload. After signed ACCEPTED,
GET /api/worker/jobs/:id/payload?attemptId=UUID returns SignedJobOffer with matching
expiry, nonce and asset ordering. Device ownership, accepted current attempt,
reserved payment, state and revocation are rechecked. Input bytes use signed
worker API routes, not presigned URLs in offers. Seller job DTOs also hide content
before worker acceptance.
Acceptance itself rechecks the exact worker/version binding, fresh PASSED proof,
manifest hash, live heartbeat and current Connect readiness. Another healthy
binding does not substitute for the accepting device's validation.

Heartbeat capabilities contain exact version UUIDs only, never capability UUIDs.
Commands repeat until acknowledged via acknowledgedCommandIds or health.commands.

POST /api/worker/capabilities/:versionId/validation is signed and accepts:
- Failure: {manifestHash, passed:false}.
- Success: {manifestHash, passed:true, proof:{sandbox:{imageId,policyVersion,testedAt},
  inference:{configHash,testedAt}}}.
- imageId is sha256: followed by 64 lowercase hex; configHash is 64 lowercase hex.
- policyVersion must match ADAPTER_POLICY_VERSION from openclaw-adapter.
- testedAt values are epoch milliseconds, no older than 24 hours.
- Exact schema: WorkerValidationSchema in apps/api/src/worker.ts.

The worker must report real local tests/consent. This is signed device testimony,
not hardware remote attestation or conclusive proof against a seller controlling
the signing key.

## Payments And Files

Integer USD cents and unique ledger operation keys back reserve/release/settle/
refund. Full job refunds reverse the fee and seller earning through new entries.
The database rejects ledger updates/deletes.

Stripe API is pinned to 2025-03-31.basil. Adapter implements Checkout, Express
Connect, separate charges/transfers, deterministic transfer/reversal idempotency
and raw webhook verification. Connect returns to /selling/earnings. Browser
redirects never credit funds or establish onboarding readiness.

Handled events: paid checkout completion/async success, account.updated,
charge.refunded, charge.dispute.created/updated/closed/funds_withdrawn/funds_reinstated.
Configured key, event/object and durable
topup modes must agree. Cumulative refunds handle duplicates, older events and
refund-before-credit ordering. Spent-credit shortfalls release outstanding
reservations, debit available funds, record debt and suspend the account. Admin
restoration requires debt collection. Unsupported event types are persisted as
UNHANDLED with audit, not reported as financially reconciled.
Connect events retain a provider-time cursor; older READY events cannot clear
newer restrictions, and a restriction wins ambiguous same-second ordering.

Disputes are durable independent PaymentDispute cases linked by exact dispute ID,
payment intent and mode. Early events stay PENDING and link in the later credit
transaction; duplicate checkout/created events cannot resurrect a resolved case.
Migration 7 preserves old unresolved cases and quarantines unexplained legacy
holds. Closure never credits a wallet or automatically restores an account.

Restoration policy is deliberately fail-closed:
- Won requires a signed terminal event plus signed reinstatement at/after closure,
  strictly after every known withdrawal. A withdrawal at/after the retained
  closure, tied debit/credit timestamps, conflicting later financial status,
  changed amounts/currency, or unknown statuses prevent restoration.
- Lost remains blocked. A later, separately proven lost-to-won event and funds
  reinstatement can clear it, including reversed delivery of those events.
- warning_closed/prevented clears only with no known funds withdrawal.
- Every case across every topup must clear; refund debt must be fully collectible.
  Quarantined/legacy/ambiguous cases have no unsafe manual override.
- GET /api/admin/users/:id/billing-review returns case evidence and blocking reasons.
- POST /api/admin/users/:id/restore requires Idempotency-Key and {reason} (10-1000
  trimmed characters). Existing /suspend with suspended:false requires the same.
  Admin identity, prior suspension, reason, debt collection and dispute proofs are
  audited atomically. Replaying an old restore key never removes a later suspension.
  Revoked sessions and API keys remain revoked; users must authenticate afresh.

This implements closure and audited account restoration, not a full chargeback
loss-allocation, seller-reserve, evidence-submission or provider reconciliation
workflow. Lost/ambiguous cases stay held pending that operational work. Dispute
events do not silently debit principal or reverse completed seller jobs.
Stripe documents funds reinstatement after closure and warns about unordered,
duplicate events; the tests reverse delivery while preserving valid provider
times. Same-second ordering is never treated as sufficient debit/credit proof.
Sources: [Stripe event types](https://docs.stripe.com/api/events/types),
[Stripe webhook ordering](https://docs.stripe.com/webhooks#event-ordering),
[dispute lifecycle and late wins](https://docs.stripe.com/disputes/how-disputes-work).

Transfer intent/destination are persisted before network calls. A lost outcome
retries the same idempotency key, including after concurrent refund, then reverses
the recovered transfer. Unknown outcomes older than 23 hours become explicitly
NEEDS_RECONCILIATION with audit and no further automatic create attempts.
- GET /api/admin/transfers lists the unresolved intents by default.
- POST /api/admin/transfers/:id/resolve requires stripeTransferId and a reason.
  The provider object must match amount/currency/mode/destination/job metadata
  and transfer group. A refunded job then queues reversal. Repeated linking is
  idempotent and the resolving administrator is audited.
- POST /api/admin/transfers/:id/cancel-uncreated requires reason,
  investigationReference and confirmation CONFIRM_NO_PROVIDER_TRANSFER_AND_REFUND.
  Stripe must return an empty complete job transfer group. The transaction
  refunds the buyer, cancels the intent and records the investigation; it never
  retries an old unknown create. This covers a crash before the network call.

Official references checked: [Stripe webhooks](https://docs.stripe.com/webhooks),
[refunds](https://docs.stripe.com/refunds),
[event mode](https://docs.stripe.com/api/events/object).

S3 keys are server UUIDs independent of filenames. Local service is SeaweedFS.
Buyer signed downloads expire after 120 seconds, maximum 300. Worker reads
recheck scoped grants. DOCX/XLSX archives are bounded BEFORE MIME detection:
2000 entries, 50 MiB/entry, 100 MiB total expansion and compression-ratio limits.
Traversal, duplicate paths, symlinks, encryption, macros, embedded archives and
executable entries are rejected. Arbitrary ZIP extraction is not exposed.
ClamAV is required in production; unscanned dev files are DEVELOPMENT_ONLY,
never CLEAN. Real scanner acceptance remains untested.

## Seed And Configuration

Seed requires KIVRO_ENV=development, DEV_AUTH_ENABLED=true, PAYMENT_MODE=fake and
nonproduction NODE_ENV. Repeated runs preserve original credits/history.
- buyer@kivro.local: 11111111-1111-4111-8111-111111111111.
- seller@kivro.local: 22222222-2222-4222-8222-222222222222.
- admin@kivro.local: 33333333-3333-4333-8333-333333333333.
- Explicit dev password: Kivro-demo-password-2026!.
- Document Analyzer capability: 44444444-4444-4444-8444-444444444444.
- CSV Insights / Technical Editor capability IDs end in 445 / 446.
- Final version IDs: 55555555-5555-4555-8555-555555555585,
  55555555-5555-4555-8555-555555555586,
  55555555-5555-4555-8555-555555555587.
- Fixtures are offline until a real approved/validated worker is available.
- .kivro/demo-pairing.json is mode 600, contains a one-time code plus IDs and keeps
  an unused valid code. PostgreSQL stores only its hash; raw code is never logged.
- Runtime bounds: 1024 MiB, CPU 1, 128 PIDs, 16 MiB input/output, 300 seconds and
  128000 token reservation. Dedicated inference configuration needs
  maxTokensPerJob >= 128000 plus adequate explicitly approved dollar/daily limits.
  Model must match KIVRO_SEED_MODEL (default gpt-4.1-mini); credentials stay local.
  Seed does not configure or successfully test a provider.

Production invokes shared configuration guards and requires durable Ed25519
WORKER_SIGNING_PRIVATE_KEY, 32-byte-hex WEBHOOK_ENCRYPTION_KEY, CLAMAV_HOST, Stripe
configuration and HTTPS WEB_ORIGIN. Dev key fallback persists in PostgreSQL.
Existing environment values take precedence over env-file defaults.

Optional API limits: MAX_UPLOAD_BYTES, ASSET_RETENTION_DAYS, CLAMAV_PORT,
PLATFORM_INFERENCE_DAILY_USER_MICRO_USD (default 1000000),
PLATFORM_INFERENCE_DAILY_GLOBAL_MICRO_USD (default 100000000).

## Evidence And Gaps

Tests use real PostgreSQL and S3 with synthetic signed devices/provider events.
They do not establish real OpenClaw execution or live Stripe acceptance. Parent
owns running API/web processes and final browser/full-workspace reruns.

Seven migrations are applied (confirmed with prisma migrate status):
20261006000000_initial, 20261006000100_invariants,
20261006000200_transfer_recovery, 20261006000300_pause_accounting,
20261006000400_validation_and_refunds, 20261006000500_pending_disputes,
20261006000600_dispute_lifecycle.

Targeted audit evidence: disputes 13, billing 9, protocol 13 and recovery 1 tests cover signed
synthetic provider ordering, mode checks, disputes, early refunds, uncertain
transfer resolution, exact-binding acceptance, private payload/files, capacity,
required named files, unsupported file publication, persisted-plan repair/CAS,
retained spend/output, explicit reapproval, queued NOW quotes and fair polling.
The exact-revision race advances persisted plan revision after executor lookup;
the actual purchase transaction leaves no job, idempotency record or reservation.
A fresh tick purchases exactly once. Dispute tests cover duplicate and reversed
delivery, early events/restart, independent cases, tied/conflicting financial
events, late wins, remaining refund debt, balanced cash entries, revocation,
reason/key/admin authorization and restoration racing a new dispute.
The auditor independently reran all 22 dispute/billing tests successfully.
Verification on 2026-10-06 (local Europe/Zurich time):
- Owned API/billing/storage plus parent integration subset: 61 passed across 12
  files, with KIVRO_INTEGRATION=1 and real local PostgreSQL/private S3.
- pnpm test: 371 passed, 70 opt-in integration tests skipped; those skips are
  reported separately, not counted as successful integration execution.
- pnpm typecheck: all workspace packages and root tsconfig.tools.json passed.
- Scoped ESLint: apps/api, packages/database, packages/billing, packages/storage.
- All 106 coverage-api.json requirement IDs were checked against REQUIREMENTS.

Required work not claimed complete:
- Real Stripe sandbox/live Checkout/Connect/transfer/payout/refund acceptance;
  direct per-job card auth/capture; tax/receipts; exhaustive external financial
  reconciliation; chargeback loss allocation/evidence submission and operational
  payout reconciliation. Ambiguous and legacy dispute evidence stays quarantined.
- Real OpenClaw/Docker/dedicated-provider end-to-end acceptance and adversarial
  seller isolation. Other package owners' tests are not API acceptance evidence.
- Complete seller version history/rollback/lifecycle UX, executed-example
  provenance, advanced moderation/disputes and audit exports.
- Real platform-inference/provider orchestration and two-worker acceptance;
  exhaustive repair/purchase race stress beyond the implemented API regressions.
- Email/push notifications and account recovery, scalable catalog pagination,
  multi-replica distributed rate limits, operational backups/metrics/retention
  and legal launch review.
- Outgoing internet webhook delivery and real ClamAV acceptance.
- Fine-grained arbitrary archive opt-in/extraction remains disabled.

These are uncovered or partially verified required behaviors, not post-MVP
reclassifications. No entire section is marked complete based only on this API.

Shared-owner follow-ups landed: PurchaseExecutor requires expectedPlanRevision,
OrchestrationService supplies its current revision and the API enforces equality
under its plan lock. AvailabilitySchema now retains the optional finite,
nonnegative estimatedQueueWaitSeconds. Both changes are consumed and exercised
by API integration regressions; shared packages were not edited by this owner.

## Catalog Lifecycle Batch

Implemented against Master Spec sections 303-318, 358-365, 85/125 and 490-491.
This batch writes catalog.ts, capability-lifecycle.ts, catalog-page.ts and
catalog tests only; the parent owns schema/migrations and other API modules.
Parent migration 20261006000800_capability_lifecycle adds lifecycleRevision and
CapabilityVersionLifecycle. No additional schema fields are required. Published
version rows remain immutable; retirement/testing metadata lives separately.

Seller routes under /api/seller/capabilities/:id:
- GET /versions: version summaries, current/draft IDs, lifecycleRevision,
  visibility and numeric nextCursor (100 history entries per page).
- GET /versions/:versionId: full frozen definition, lifecycle and readiness reasons.
- GET /versions/:versionId/diff?fromVersionId=: optional baseline, default active;
  categorized changes, expansion warnings and a hash bound to both definitions.
- POST /versions/:versionId/testing {expectedRevision}: invalidates old binding
  readiness and requires new signed proof timestamps after testing started.
- POST /versions/:versionId/activate {expectedRevision,reason,reviewedDiffHash?}:
  published, unretired target only; exact manifest, current adapter limits,
  dependency grants, fresh worker proof/heartbeat and Connect readiness required.
  Failure is ROLLBACK_NOT_READY. Permission expansion requires the exact diff hash.
- POST /versions/:versionId/retire {expectedRevision,reason,deactivate?}: retiring
  the active version requires explicit deactivate:true, stops new purchases and
  hides the capability. Existing pinned jobs can still execute and settle.
- POST /visibility {expectedRevision,visibility}: visibility is independent of
  version state. Increasing exposure reruns readiness; reducing it works offline.
  Jobs and reviews survive changes. PRIVATE requires explicit buyer grants.
- POST /versions/:versionId/examples/from-job
  {expectedRevision,jobId,title,confirmPublic:true}: only the seller's own settled
  successful work with the identical manifest; creates a new draft with durable
  execution provenance. Other buyers' jobs are never copied. File examples fail
  closed pending an explicit asset-publication flow. Public provenance omits job ID.

Lifecycle mutation transactions share the purchase capacity lock and CAS revision.
PUT and publish preserve legacy bodies but accept expectedRevision; publish also
accepts versionId and reviewedDiffHash. New routes require expectedRevision.
Permission expansion cannot silently publish. All frozen contract changes produce
conservative review warnings; this is not a semantic schema-compatibility solver.
Executed examples from changed manifests and incompatible curated examples block
publication until rerun, updated or removed. Seller history keeps full snapshots.

GET /api/capabilities/page preserves the old array endpoint separately and returns
{items,total,nextCursor}. Filters: q, category, sellerId, minPrice/maxPrice (cents),
minRating, outputType, maxDurationSeconds, favorites, availability and timezone.
Availability accepts ALL/NOW/TODAY/SCHEDULABLE or a concrete availability status.
Sorts: RELEVANCE, NEWEST, PRICE_ASC, PRICE_DESC, RATING, POPULAR, FASTEST.
Limit is 1-100 (default 24). Default ALL retains future-only services; immediate
availability breaks otherwise comparable ranking ties. Filters apply before page
selection, including beyond 100 records. Cursors bind filters/viewer favorites and
exclude later-created capabilities. Ranking, availability and review metrics stay
live, so concurrent metric changes can move items between pages; no cross-request
snapshot guarantee is claimed. Exact live totals scan bounded 200-record batches
with grouped metrics and retain only one page, not an indexed large-scale search
service. Public responses never expose the seller's schedule.

Operator category blocks and minimum/revoked Worker/OpenClaw versions also gate
availability, publication and rollback readiness. Catalog pages and version
history load the policy once per request; unsupported Workers cannot become
ready merely because their earlier binding proof passed.

Verification on 2026-10-06 for this batch: 4 catalog unit tests and 14 real-DB
catalog integration tests passed; combined catalog/API/protocol subset passed
40 tests across five files. Scoped ESLint and API TypeScript checks passed.
Coverage includes ownership and private projections, immutable row triggers,
fresh testing proof, expansion consent, stale/concurrent CAS, rollback price and
queue pinning, retirement without cancelling paid jobs, visibility/grants,
scalar execution provenance, >100-record filtering, cursor binding and future
availability. Tests use synthetic signed devices, not real OpenClaw execution.
Browser verification and global rebuild/restart remain parent-coordinated.

Earlier evidence/gaps above describe the prior billing handoff. This catalog batch
supersedes its missing API history/rollback/lifecycle and scalar provenance items;
it does not establish full UI acceptance, public file examples, real worker
execution, or completion of parent-owned account/billing/storage work in progress.

## Review Workflow Batch

Master sections 86/128 API behavior is implemented in catalog-reviews.ts, invoked
from catalog.ts; no schema or migration changes. Existing GET/POST
/api/capabilities/:id/reviews remain compatible, including capability slug reads.
Only a non-seller buyer of a SUCCEEDED, SETTLED, positive-price job can create a
review. A per-job lock plus unique constraint handles concurrent duplicates;
creation records REVIEW_CREATED with immutable job/version references.

- GET /api/capabilities/:id/reviews/summary returns averageRating (null if empty),
  reviewCount and distribution:[{rating,count}] with all five bins in ascending
  rating order. Existing public review arrays contain only review ID, rating,
  comment, creation time and display name, never buyer/job IDs or edit hashes.
  Both reads enforce private capability grants and capabilities:read API scope.
- GET /api/jobs/:id/review requires the job buyer, or that buyer's jobs:read key.
  It returns job/capability/version identifiers, version number, seller ID,
  eligible, canEdit, reason, review and policy. Review includes
  {id,rating,comment,createdAt,reviewHash}; policy includes
  {editWindowDays:30,editDeadlineAt}. Seller/admin identity alone cannot read
  another buyer's review-status endpoint. Historical buyer access survives a
  capability becoming private without exposing its current private definition.
- PUT /api/jobs/:id/review accepts {rating,comment,expectedReviewHash}. A signed-in
  buyer can edit for 30 days after the original review's creation, not after each
  edit. The content hash and serializable transaction prevent lost concurrent
  edits. Changes record previous/next content and pinned version in REVIEW_EDITED.
  Reposting identical content is a no-op. Funds/ledger entries are never changed.
- Duplicate creation returns REVIEW_ALREADY_EXISTS; stale edit returns
  REVIEW_CONFLICT; the exact deadline returns REVIEW_EDIT_WINDOW_CLOSED.
  Previously verified reviews remain visible and editable within the original
  window after a refund, so refunding cannot erase negative feedback. A refunded
  job without an existing review cannot qualify for new verified feedback.

Catalog DTOs now also disclose pauseSupport:FULL_RESUME and dataProcessing with
configured asset/job-content retention days, provider/model and
privateSellerRuntime:true. No inference credential reference is exposed.

Verification: 19 catalog/review real-database tests and 7 unit tests passed on
2026-10-06. Final catalog/review/API/protocol subset passed all 48 tests across
five files at 11:11 Europe/Zurich. All 147 coverage IDs are valid and unique.
These include concurrent duplicate creation and edits, ownership and
API scope, public redaction, unpaid/self/refunded eligibility, exact edit-window
boundary, retained audit/ledger balances, distribution updates and private access.
The test app explicitly raises its synthetic accounts' request quota; production
defaults are unchanged. Scoped ESLint passes. Latest API typecheck has no scoped
catalog/review errors but is awaiting parent/sibling payoutRecord generation.
The auditor independently passed the prior 14 lifecycle DB +4 unit batch and
found no additional lifecycle blocker; R14 review is a separate requested audit.
Web review editing/distribution, seller aggregate reputation, problem reports and
moderation are not certified by this API-only evidence. Parent owns problem reports.

## File-Backed Example Batch (R18)

Master sections 357-368 now have file-backed API examples in example-assets.ts.
Parent-owned migration 20261006001500_example_assets adds immutable independent
CapabilityExampleAsset records. Parent registers registerExampleAssets(app, ctx)
and invokes cleanupExampleAssets(ctx) as an independent maintenance task. This
batch needed no further schema or migration changes.

- POST /api/seller/capabilities/:id/versions/:versionId/examples accepts
  expectedRevision, title, optional description, input, outputValue (JobOutput),
  approvedAssetIds, optional reusableInputAssetIds/replaceExampleId, and
  confirmPublic:true. The /from-job variant takes jobId instead of input/outputValue.
  Both return version history with a new unpublished draft. Every referenced file
  requires explicit approval; extra approvals and reusable output selections fail.
  Sources must be active seller-owned uploads or successful, settled, self-owned
  test outputs. A different buyer's job/content is never promoted. From-job
  outputs must belong to the exact successful attempt and unchanged manifest.
- Copies are independently stored, digest/MIME/size checked, scanned according to
  deployment policy, limited to 100 MiB total, and frozen into version examples.
  File IDs in input, output assets and named output fields are remapped. Original
  asset expiry/deletion does not remove approved copies. Copy failures and stale
  revision transactions schedule staged-object cleanup without updating drafts.
  Per-capability serialization protects concurrent edits and the three-example cap.
- Public CapabilityExampleDTO keeps legacy input/output fields and adds optional
  description/order/source, inputAssets/outputAssets, structured outputValue and
  whitelisted version/manifest/time provenance. ExampleAssetDTO extends AssetDTO
  with reusableTemplate. Public DTOs omit source asset IDs, private job IDs and
  object keys. Unchanged scalar editor round-trips preserve server-held evidence.
  Publication revalidates all contracts, file metadata, ownership and revocation;
  incompatible contracts or changed real-execution manifests require replacement,
  rerun or removal. Draft file URLs are not exposed.
- GET /api/seller/capabilities/:id/versions/:versionId/examples/from-job/:jobId
  previews only an eligible self-owned successful execution with current source
  assets, returning jobId/capabilityVersionId/targetVersionId/input/outputValue/
  inputAssets/outputAssets. Source metadata includes filenames/hashes and ordinary
  owner-only download links for explicit approval. Foreign jobs/accounts are denied.
  Seller version detail preserves private frozen provenance while adding authorized
  public example links only for the current published version.
- GET /api/capabilities/:id/examples/:exampleId/assets/:assetId checks the exact
  current published version reference, capability visibility/private grants,
  retirement, security block, seller suspension and copy revocation. It rechecks
  authorization after storage opens, before sending headers. Safe media/PDF use
  inline MIME; other formats download as attachments. Single byte ranges and HEAD
  support previews with bounded streams, nosniff, sandbox CSP and no-store headers.
  Knowing a draft, old-version or unrelated asset UUID grants no download access.
- POST /api/capabilities/:id/examples/:exampleId/template accepts the exact
  capabilityVersionId and optional assetIds/confirmCopy:true. By default it returns
  only scalar inputs, omitting all file fields. Only explicitly selected reusable
  input files are copied into normal buyer-owned, expiring private INPUT assets.
  It returns capabilityId/capabilityVersionId/input/assets, never purchases a job
  or reserves funds, and rechecks visibility/version/revocation before committing.
- POST /api/seller/capabilities/:id/example-assets/:assetId/revoke accepts
  expectedRevision/reason, is owner-only, irreversible and audited. Downloads and
  templates deny access immediately; public DTOs omit the invalid example.
  Maintenance deletes revoked objects with retry-safe per-row failure isolation.
  Original source files and previously copied buyer templates remain independent.

Verification on 2026-10-06 at 11:32 Europe/Zurich: all 60 tests across catalog unit,
catalog integration, example-assets integration, API protocol, general API and
signed Worker protocol suites passed. The 12 new real PostgreSQL/S3 tests cover
consent/ownership, immutable copies, draft/private/suspended/revoked isolation,
original expiry and application restart, inline PNG and ranges/HEAD, explicit
buyer template consent/ownership/expiry/no-charge, concurrent revision/limit and
replacement, integrity and copy-race cleanup, incompatible contract/runtime changes,
and signed self-owned execution with remapped files and redacted provenance.
API typecheck and scoped ESLint pass. Signed test Workers are synthetic fixtures,
not claims of real OpenClaw/provider execution or completed browser media UX.
After adding the owner-only source preview and enriched seller version links,
all 38 catalog/example tests were rerun and passed at 11:35; API typecheck and
scoped ESLint passed again. The API coverage file contains 155 unique valid IDs.
The final expanded run at 11:36 passed all 60 API/catalog/protocol tests again;
including shared contracts produced 73 passes and one unrelated shared assertion
failure at contracts.test.ts:34, which still expects now-supported WebP output
to be rejected. The shared/worker owner was notified; that test is outside this
batch's authorized shared example-DTO edits.

The earlier crash-orphan gap is closed by the parent-owned shared PendingObject
helper and migration 20261006001700_pending_objects. Both example publication and
buyer template copies call stageObject before storage PUT, then commitObject in
the same transaction as their completed target records. Example approval is never
created before bytes exist. Failure calls abandonObject, which schedules cleanup
after the 60-second PUT drain grace; an uncommitted crash stage expires after ten
minutes plus that grace. GC claims prevent late publication, and committed targets
cannot be abandoned or collected even after their stage expiry. No helper/schema,
legacy-upload or direct-upload source was edited by this agent.

Follow-up verification at 11:57 Europe/Zurich: 15 example DB/S3 integration tests
plus 19 catalog integration and 7 unit tests all passed (41 total). Three added
cases verify the pending record exists before PUT without premature approval,
atomic example/template attachment, committed-target protection against cleanup,
restart recovery of before-PUT and after-PUT abandoned states, rejection of late
publication, and rollback when staging expires during copying. TTL/drain expiry is
represented by aged fixture DB timestamps, not by claiming an actual SIGKILL or
waiting eleven minutes. TypeScript and scoped ESLint pass. File publication and
template API gaps recorded in older sections are superseded by this evidence;
browser/agent acceptance and whole-Master completion are not claimed here.

## R23 Real Fault Matrix

scripts/e2e-fixture.ts now accepts --run --faults, retaining the original successful
fixture mode. It uses actual Docker/OpenClaw, outbound signed Worker transport,
local deterministic inference and isolated synthetic accounts. No core behavior,
proof, job state or timestamps are patched to manufacture outcomes. Background
maintenance is excluded because the shared local DB contains unrelated work.

The first real run on 2026-10-06 (fixture b11831b4-485b-48ca-8ef4-ecbfe00137cf)
passed insufficient-funds admission, stopped-Worker/offline admission, real missing
image/sandbox admission, scheduled buyer cancellation, seller cancellation during
RUNNING, and invalid-output rejection after real input consumption. All four
created fault jobs, including the timeout case, have exactly one 99-cent reserve,
one 99-cent release, and no capture, seller earning or platform fee.

That first timeout scenario FAILED acceptance: job 9760edf0-105a-44d9-801b-45af7a989ea3
became FAILED/RELEASED after about 63 seconds despite its published 30-second
execution limit, rather than TIMED_OUT. Worker audit reported
EXECUTION_STOPPED_LOCAL_INFERENCE_OFFLINE. The intentionally stalled local provider
exposed timeout classification/drain behavior; the fixture assertion remains strict.
No production Worker/core change was made to hide this failure. The subsequent
success-control purchase was not reached, so this is not a passing full matrix.

That run cleaned up successfully. A subsequent run of the corrected deadline
surfaced an uncaught process-group kill EPERM during seller cancellation, before
timeout. Fixture cacf4f67-5880-430b-93af-6128bda653a5 exited without finally cleanup.
Both created jobs were already CANCELLED/RELEASED with exactly one reserve/release
and no capture. Its single exited container was ownership-checked and removed;
only its verified synthetic Worker, capability, grant, sessions and temporary
directory were cleaned up, with TEST_FIXTURE_CRASH_CLEANUP recorded in the audit.
No payment/job/ledger state was changed to simulate success.

Laplace repaired Worker deadline/cancellation and Docker frame-drain/kill handling
in his owned source, without rebuilding the image. The final strict command
`node --import tsx scripts/e2e-fixture.ts --run --faults` exited 0 at
2026-10-06T10:10:01.331Z (12:10 Europe/Zurich), with passed:true:

- Fixture: 73969acc-3ec3-41ff-8c5e-b954bf544cfa.
- Worker: 2c1ad629-f832-4ffc-b9df-de69c4cb27fb.
- Capability: 3aeb7e25-1cfd-4706-852e-0d3bf904b1fc.
- Image: sha256:96dd4f5334bf57fea81af17192864ae57e0f520aa492afb8591ad7fd7077ae52.
- Insufficient funds: HTTP402 INSUFFICIENT_FUNDS; stopped Worker and actual missing
  sandbox image: HTTP409 CAPABILITY_OFFLINE. All create zero jobs/reservations.
- Buyer scheduled cancellation: 5572b8b8-8cd6-4994-b2f9-c04dc50bbceb,
  CANCELLED/RELEASED before start, repeated cancellation idempotent.
- Seller RUNNING cancellation: 1502958a-d815-463b-b9ff-099a280d7ab9,
  CANCELLED/RELEASED, actual container inspected and held inference cancelled;
  buyer cancellation after start was denied.
- Invalid output: 27f7c276-3261-487f-b9bf-f0dc28d76724, FAILED/RELEASED after
  two provider calls and a real required-file read. This tests the Worker output
  contract boundary, not submission of malformed output to the API.
- Timeout: aa6ebada-a41a-454f-806b-8a5e7407d26d, TIMED_OUT/RELEASED.
  Local acceptance 10:09:05.592Z, persisted deadline 10:09:35.592Z, local terminal
  transition after 30091ms, cloud finalization after 30170ms. The harness asserts
  the exact persisted 30000ms budget, no early timeout and at most 5000ms observed
  local scheduling/drain overshoot; actual overshoot was 91ms.

Each of the four created fault jobs has one 99-cent reserve, one 99-cent release,
zero captures/earnings/platform fees, restored buyer balances and no remaining
owned containers. The post-failure success control also passed: job
2d04130f-b492-4971-9d67-c9c93144d814 consumed the uploaded source, generated and
delivered a 112-byte file through S3 with exact bytes/hash, and settled one balanced
transaction containing one capture, seller earning and platform fee. Signed result
replay and purchase idempotency did not create a second settlement/job.

Automatic cleanup passed: Worker paused/revoked, capability paused, buyer grant
removed, sessions logged out, fixture-owned containers and temporary state removed.
Root tools TypeScript and scoped script lint pass. The matrix uses actual Docker,
OpenClaw, PostgreSQL, Redis/S3 health and signed transport, but local deterministic
inference, explicit fake payment and DEVELOPMENT_ONLY malware scan. It does not
claim live-provider/Stripe acceptance, browser-driven fault flows, background
reconciliation, real SIGKILL recovery, or complete Master Spec acceptance.
Parent can use this receipt for DEV-LOCAL-024; its coverage-local ownership was
not edited. Example PendingObject integration remains separately verified above.

## Section 563 Buyer Browser Fixture

`scripts/e2e-fixture.ts --run --browser` is implemented with the real Next app,
Chromium (`KIVRO_BROWSER_CHANNEL`, default `chrome`), registered buyer session,
private capability/grant, file picker/direct S3 upload/finalization, server quote,
explicit consent and purchase, rendered result and native authenticated download.
It checks that the quote and consent checkbox alone create no job or reservation;
the receipt includes the downloaded bytes in base64, byte count and SHA-256.
The normal API and seven-case fault modes keep their existing execution path.
Next and browser processes have bounded cleanup, and S3 CORS is restored to
`http://localhost:3000`. No fixture UI routes, intercepted API/storage responses,
real-provider credentials or financial-history deletion are introduced.

`KIVRO_FIXTURE_SCHEMA` is optional. Only `fresh_clone_[a-f0-9]{16}` is accepted;
malformed values fail before fixture mutation. Omission retains `public`.
Only the schema component of the fixed synthetic localhost database URL changes,
and the selected schema is reported. This fixture never creates or drops schemas.
Public-schema browser runs retain background:false to protect unrelated work.
Only an isolated-schema browser run enables actual API background maintenance,
with an exclusive lease on local Redis logical database 15. Acceptance then
requires actual completed BullMQ purchase-wake and periodic reconciliation jobs,
persisted reconciler cursors and no persisted maintenance failures. Cleanup only
removes that initially empty, exclusively owned queue, never shared Redis DB0.

Verification: root tools TypeScript, scoped script ESLint and the
side-effect-free schema guard checks pass (default/valid isolated name and ten
invalid values, including trailing newlines). Actual Redis15 lease acquisition
and owned-queue cleanup passed using registered Lua methods on the installed
client; this does not substitute for completed production maintenance jobs.

The first browser run (ffe24d11-d08f-4b75-b117-abfb1a2aec6a) reached a settled
job and rendered result, but failed the harness's page-response redirect wait.
Chromium's native attachment path is not an ordinary page response. The corrected
harness awaits the actual download event and stream, checks exact bytes/hash,
and correlates the real buyer authorization audit before its separate API 302,
anonymous-denial and seller-denial assertions. No application behavior or file
download is mocked to avoid this harness failure. The failed run cleaned up with
no errors and its financial history was retained.

The single corrected rerun `node --import tsx scripts/e2e-fixture.ts --run --browser`
exited 0 with passed:true at 2026-10-06T10:51:01.665Z (12:51 Europe/Zurich):

- Fixture: 5f02acdf-1a22-401a-b424-f379df464af6, schema public.
- Job: 6693c1c9-952f-44b2-9e7f-50688210431a, SUCCEEDED/SETTLED.
- Capability: abfb2c4d-ee62-4117-9543-cacbe4e5549a.
- Worker: 9275bb9a-234f-41ba-9557-c485ec7ccd7d; attempt
  b4ea7540-0d53-477f-8d9b-e61b4adb270e.
- Image: sha256:4b2874ffba74006e54b613bb988eabcc1fb57e0839e156bdaed20318830b680f,
  after Laplace's explicit stable-image coordination.
- Actual Next proxy and Chrome 154.0.8037.98, no route mocks, uncaught page errors
  or failed page API responses. Browser upload PUT200 finalized the 53-byte source.
- Consent initially unchecked, purchase disabled before consent, zero jobs or
  reservations from quote/checkbox alone, exactly one browser purchase request.
- Actual Worker read the private input, four inference/tool steps produced
  report.txt; nine total deterministic inference requests include readiness/test.
- Browser showed Completed/Paid and named results. Its native S3 download was
  112 bytes, SHA-256 c01b9d8734fa2c2d1762a897488aac3df79c09a659a4f31db38a6f6a48e3888b;
  the machine receipt contains exact bytes as base64. Authorization audit:
  e6fe4293-c832-4945-b735-bfa729d876d6.
- One balanced settlement transaction, one capture/earning/platform fee; actual
  purchase replay and signed result replay did not duplicate payment or execution.
- Browser/Next closed with the port verified closed; CORS restored to
  http://localhost:3000; Worker paused/revoked, capability paused, grant/session
  cleanup and owned container/temp cleanup all passed. No financial rows deleted.

This closes the browser-path verification gap on this host under the fixture's
explicit deterministic inference, fake billing and DEVELOPMENT_ONLY scan policy.
Background was deliberately false for this public-schema receipt. The parent's
subsequent fresh-clone runtime run passed at 2026-10-06T10:56:33.757Z with20
migrations, actual completed Redis15 wake/periodic jobs and complete cleanup;
see `docs/FRESH-CLONE-RUNTIME-RECEIPT.json`. That separate receipt covers the
isolated-schema background path. Neither receipt claims live-provider/Stripe
acceptance, browser-driven faults or whole-Master completion.

## Nonfinancial API Coverage Checkpoint, 2026-10-06

Documentation-only review of the authoritative full Master sections and atomic
catalog IDs covering contracts, catalog/version lifecycle, job admission/control,
direct asset security, approved examples, buyer API/webhooks and scheduling.
`docs/coverage-api.json` adds144 previously unmapped records:75 TESTED,
52 IMPLEMENTED,15 IN_PROGRESS and2 DEFERRED. Existing155 records are preserved
except two clarified notes: parent account verification/recovery has since landed,
and the queue aggregate now names its missing seller setter explicitly. No
financial evidence row or production source changed.

TESTED records identify existing named assertions or the accepted browser/runtime
receipt; this mapping is not a new test execution. API/schema assertions do not
claim complete UI/runtime coverage. Broad section aggregates are not promoted
from one narrow passing test. Multipart upload and job email notifications are
explicitly future/conditional clauses, not missing mandatory MVP functionality.

Concrete remaining behavior found by source review:

| Master / IDs | Current behavior and actual gap | Source |
|---|---|---|
|343-344 / PRD-0329; queue-setting portion of JOB-0083|Capacity values are persisted/enforced, but seller create/update exposes no mutation for concurrency or maxQueue. Showing them in the seller response is not configuration.|`apps/api/src/catalog.ts` seller create/update/list; `packages/contracts/src/index.ts` CreateCapabilitySchema|
|353,471 / JOB-0087, JOB-0228-0230|Dispatch is FIFO only among QUEUED rows. Eligible SCHEDULED rows await separate UUID-ordered promotion and are excluded from immediate admission counts. A new NOW job can take a slot before an earlier due reservation.|`apps/api/src/jobs.ts` createJob; `apps/api/src/background.ts` reconcileJobs; `apps/api/src/worker.ts` dispatch|
|472 / AVL-0067-0068|Finite maxScheduled prevents unlimited bookings, but admission has no per-window capacity estimate or window-specific conservative count based on duration/concurrency/runtime.|`apps/api/src/jobs.ts` scheduled branch and quote|
|9 / JOB-0001, JOB-0004|JobEvent contains time, job ID, state and sanitized reason, but generic transitions omit actor/attempt/previous state. Separate creation/control/settlement audits do not attribute every transition.|`apps/api/src/jobs.ts` transition; `packages/database/prisma/schema.prisma` JobEvent|
|442,446 / JOB-0184, JOB-0186, JOB-0198|Resume under global new-job pause has no explicit per-job confirmation override; repeated resume after RUNNING acknowledgement attempts an invalid RUNNING-to-RESUMING transition. Parent/Laplace now own the active pause batch. Section441 outside-schedule resume is a recommendation, not independently counted as a hard missing feature.|`apps/api/src/jobs.ts` registerJobs resume branch|
|221 / IO-0113|Historical version and output contract are preserved/exposed, but buyer JobDTO omits the old input contract. Buyer cannot retrieve its old field constraints via seller-only version details after active version changes.|`apps/api/src/jobs.ts` jobDto; `apps/api/src/capability-lifecycle.ts` version-detail ownership|
|354 / AVL-0019|Operations expose job outcomes/average active runtime and device health transitions, but not capability busy/online/offline durations, median queue/execution waits or durable queue-full rejection counts.|`apps/api/src/operations.ts` OperationsDTO; `apps/api/src/worker-health.ts`; `apps/api/src/jobs.ts` queue-full error|

These are implementation findings, not a list of absent tests. No fixes are
claimed by this checkpoint. No browser, Next, Docker, provider or database fixture
was rerun during the mapping review; Curie's browser slot remains untouched.

### Scheduler and Telemetry Hook Follow-Up

The checkpoint's FIFO/per-window findings now have implementations and focused
evidence in `apps/api/src/scheduling.ts`, admission/quote in `jobs.ts`, signed
dispatch in `worker.ts`, scheduled promotion in `background.ts`, and ONLY the
catalog quote integration in `apps/api/src/agent.ts`. No migration was needed.

- One capability advisory lock serializes promotion, admission and offers.
  Scheduled eligibility uses creation time then UUID, never recovery-page UUID
  order. Already-admitted execution queue entries drain normally; every freed
  slot goes to due reservations before a new NOW buyer. Not-yet-eligible future
  reservations do not block NOW. Historical versions remain pinned; a missing
  older exact-version proof cannot be skipped in favor of newer work.
- Effective admission/dispatch concurrency is at most the number of ready
  devices, even when seller configuration is higher. The parent-authorized
  follow-up below now aligns public catalog availability and its wait estimate
  with authoritative cross-capability live-attempt occupancy.
- Conservative per-window ceiling is the minimum of global maxScheduled,
  effective concurrency+maxQueue, and estimated start slots before closing.
  Existing reserved work consumes slots; the longest involved pinned typical
  runtime is used. Overnight overlaps, date overrides and real DST boundaries
  are preserved. Always-open/continuous multi-day schedules use seller-local
  daily reservation buckets. Running work may finish after closing; these are
  estimates and eligibility, not promised completion times.
- A full chosen window returns409 SCHEDULE_WINDOW_FULL with canonical window
  bounds; it is not silently moved to a later window. A new quote/explicit later
  selection is needed. Normal checkout and agent catalog quotes share the same
  check; quote creation never reserves payment. Purchase rechecks under lock.
- Queue-full telemetry is recorded only after the failed purchase transaction
  exits. Repeated purchase keys produce one rejection event; telemetry failure
  preserves the original409;402 does not create a capacity rejection. The bounded
  observer is an independent maintenance task, so its failure cannot prevent
  deadline release or subsequent cleanup. Sartre owns the helper/analytics DTO.

Focused receipts: scheduling integration11 PASS, window unit4 PASS, existing
background recovery fairness1 PASS at2026-10-06 13:37:58 Europe/Zurich.
The background regression still processes active deadlines behind251 future
reservations and advances its durable waiting cursor. Pause API12 PASS and
helper unit4 PASS are separate receipts. All API/tools typechecks and scoped
lint passed after implementation; parent owns the final global regression run.
No additional Docker/browser fixture was run for the scheduler batch.

Parent has also closed the prior transition-attribution, historical-input-contract
and explicit-global-pause/duplicate-resume findings; the rerun pause API tests
name those assertions in `docs/coverage-api.json`. Seller capacity configuration
was delivered by Bohr, and section354 analytics by Sartre. This follow-up removes
obsolete missing-behavior notes without claiming the entire Master is complete.

### Authoritative Live-Device Occupancy Follow-Up

Parent extended ownership only to `catalog.ts` availability/evidence and
`catalog-page.ts` batched evidence, alongside existing scheduler/admission/
dispatch ownership. No seller capacity CRUD, generic policy hierarchy, Worker
protocol, schema, migration or financial implementation changed.

Availability now loads occupied ready-device IDs from Job.activeAttempt for
the active execution states across ALL capabilities, including OFFERED and jobs
on historical versions. Worker.runningJobIds is not an authority; stale attempt
rows that are not the job's current active attempt do not occupy slots. Catalog
pages batch this query across the page's devices without limiting it to the
capabilities matched by the search filter.

The own-capability runningJobs count remains unchanged. Internal
effectiveConcurrency/capacityLoad separately account for free physical devices,
the seller's remaining concurrency, and over-capacity work draining after a
configuration reduction. This avoids counting a foreign job as a capability
job or hiding a spare device behind an overly coarse foreign-job count.
Public status, current queue-wait estimates, NOW admission, scheduled promotion
and dispatch use those same values. Positive queues remain bounded. Future
window quotes remain explicitly conservative estimates, not a physical future
device reservation or start-time guarantee.

`KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/scheduling.integration.test.ts apps/api/test/scheduling.test.ts apps/api/test/pause-budget.integration.test.ts`
passed36/36 at2026-10-06 13:52:02 Europe/Zurich: scheduler20 (9 new occupancy
cases), window4, pause12. The new cases cover detail/page/agent quote consistency,
zero queue rejection without reserve, one-slot positive queue, OFFERED occupancy,
scheduled promotion after release, two devices, old versions, ignored untrusted
running IDs/stale attempt rows and unchanged policy precedence. API typecheck
and scoped lint pass. These use isolated PostgreSQL schemas, no Next/Docker run.

Historical distinct pre-offer gap (subsequently closed by the pending-slot
follow-up below, not by the original bounded live-attempt repair):
with one Worker bound to A and B (both maxQueue0), purchase A but do not poll
offers yet. A is QUEUED/RESERVED with no activeAttempt. B can still pass its
separate per-capability admission check and reserve another NOW job. Concurrent
A/B purchases have the same issue. Serial one-device dispatch prevents parallel
execution but does not itself reserve the pending physical slot at purchase.
Closing this requires a shared pending-slot admission policy/atomic reservation,
not merely subtracting active attempts. Authority: Master343-345 and351. This
source-confirmed case motivated the separately authorized pending-slot repair.

## Signed API Pause Runtime Acceptance, 2026-10-06

`KIVRO_PAUSE_FIXTURE_IMAGE=sha256:4cf5b9b2b420774d780acfef09fe2d1ce9ff73d60f29c7ffb69b0c1a0bf91c7f node --import tsx scripts/e2e-fixture.ts --run --pause`
exited0 with passed:true at2026-10-06T11:33:10.930Z. Fixture UUID
293229d6-2337-46df-b991-9d7574bb7efc; public schema with23 applied migrations.
Laplace explicitly approved that immutable timing-v2 image before execution.
An earlier invocation was denied Docker socket access at prerequisites, before
creating fixture data; the authorized rerun below is the actual runtime receipt.

- Actual API registration, dedicated Ed25519 Worker pairing/proofs, private
  capability consent, OpenClaw/Docker, required input-file read and S3 delivery.
  No browser/Next/CORS changes; background deliberately false on shared public
  schema. Only inference is deterministic; billing is explicitly fake and scanning
  DEVELOPMENT_ONLY. No live-provider or production Stripe claim.
- Success job387588e5-bdd3-4143-ba75-228bc1677711, attempt
  6562b908-d083-4092-b8a5-aa52be271abe: signed90,000ms cumulative pause budget,
  30,000ms active execution timeout,76,446ms confirmed pause,24,147ms active and
  100,588ms wall time. Docker actually paused; provider call count stayed fixed,
  funds remained RESERVED, duplicate pause created no command/reset, signed
  resume completed after the old timeout without replenishing active time.
- One capture, seller earning, platform fee and balanced settlement; signed
  result replay did not duplicate them. Generated112-byte report SHA-256
  3a6798001128d9e2986a7cc42f041c3dd6ef3a401448d7f74800d718e5dbc81c.
- Cumulative expiry jobfa1fb5ef-dc90-470f-aacf-dc9b0d8336e4: first confirmed
  pause56,227ms, second remaining budget33,773ms, real-clock expiry127ms beyond
  the budget. TIMED_OUT/RELEASED, reserve1/release1/capture0/earning0/fee0.
- Paused cancellation jobd195e81b-d316-4925-a32d-6e540b7d8275: repeated seller
  cancel, CANCELLED/RELEASED, reserve1/release1/capture0/earning0/fee0.
-12 deterministic provider requests total. All owned containers/temp state
  removed, runtime/provider/API stopped, Worker paused/revoked, capability paused,
  grant revoked and sessions logged out. Financial/audit history retained.

Fixture code: `scripts/e2e-fixture.ts`, `scripts/e2e-fixture-pause.ts`.
Four side-effect-free guard tests in `scripts/e2e-fixture-pause.test.ts` also pass.
API regression `pause-budget.integration.test.ts` passes12 cases, including
rejection of pause from ACCEPTED with409 PAUSE_NOT_SUPPORTED_IN_CURRENT_STAGE,
unchanged funds/state/events and no Worker command. It does not alter generic
state-machine possibilities or pretend startup/output-validation are pausable.

## Worker Response Contracts, SR02 Bounded Handoff

`packages/contracts/src/response-worker.ts` exports browser-safe
`workerResponseRoutes` descriptors for all15 JSON routes in `worker.ts` and
`worker-usage.ts`, including seller pairing/device controls. Assets/upload paths
and central registry/response-hook installation remain parent-owned. Legacy
diagnostics stays strict and unchanged; v2 requires seller/deployment identity
and accepts the shared optional warning snapshot, as does the full seller
Worker projection. Wire dates are ISO strings, not Prisma Date objects.

The pure command schema was extracted to `worker-command.ts` without changing
its existing refinement. Parent owns its root export; Laplace agreed to replace
the job-protocol local definition with a re-export. Signed notice/offer response
schemas reuse contracts' existing schemas and never import the Node protocol.
`healthHistory.previous` remains a required string: migration014 made
WorkerDevice.healthStatus TEXT NOT NULL DEFAULT 'UNKNOWN'. Free-form health
is JSON-validated; known projection/history/binding fields are strict.

At2026-10-06 14:02:30 Europe/Zurich,
`KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/worker-responses.integration.test.ts packages/contracts/src/response-worker.test.ts`
passed9/9: eight schema/bundle regressions plus one real isolated-PostgreSQL
flow validating all15 actual route responses with parse-to-wire deep equality.
Both actual parsed notice and accepted payload retain byte-identical canonical
content and verify against the server's Ed25519 key. This proves the current
producer's round trip; central validation should still preserve original signed
payloads against future schema normalization. Browser-platform esbuild succeeds
with no server packages or external imports. Contracts/API typechecks and scoped
lint pass. No production handler, database migration, Docker/browser run, live
inference or live payment request is part of this response-schema receipt.

## Pending Slots and Dispatch Switch, Authoritative Follow-Up

The earlier cross-capability pre-offer reservation gap is now closed. New
`apps/api/src/pending-capacity.ts` treats persisted paid QUEUED jobs as durable
execution/queue reservations, using deterministic compatible-device matching.
Admission, due promotion and offer creation share a seller-level advisory lock
inside serializable transactions. Exact immutable-version readiness and current
activeAttempt occupancy determine device edges; self-reported running IDs do not.

The matching pass considers oldest accepted prefixes, respects each capability's
remaining concurrency and uses augmenting paths to place flexible jobs on spare
compatible devices. It does not count incompatible devices as spare capacity or
let a later same-capability version bypass an unready earlier job. Matched pending
jobs consume execution slots; unmatched jobs consume their own capability's queue
allowance. Public detail/page/agent/API quote use the same assessment. Real
runningJobs and queueDepth remain separate from internal policy load. Dispatch
honors the matching result rather than independently picking another queue head.

Due promotion validates the resulting queue bounds of all affected capabilities;
an older scheduled job cannot steal an admitted zero-queue reservation. Existing
over-limit work drains after configuration/readiness changes without new financial
entries. A failed purchase transaction leaves no queued job or physical slot.
NOW jobs persist the post-lock ordering timestamp used by their admission probe,
avoiding PostgreSQL transaction-start timestamps reordering a waiting purchase.
No new Prisma model/migration or Worker wire protocol was needed.

The future-window correction retains global scheduled limits and per-window
ceilings but estimates current backlog carryover after available open execution
time before the requested start, using the longest pinned estimated runtime.
Closed hours do not count as draining capacity. This fixes the known capacity
fixture with two running jobs plus one queued job and two one-hour-later scheduled
reservations. Estimates remain estimates, not guaranteed future device bookings.

JR-A01 now tests the real `/api/admin/dispatch` route: session-only admin authority,
audited off/on changes, no new purchase/reserve/offer while disabled, denied
acceptance of an already-issued offer without attempt/fund changes, preservation
and one valid settlement of an already-running job, and restoration of the same
offer/queued dispatch/new purchases. It does not claim a Docker/UI kill-switch run.

At2026-10-06 14:19:18 Europe/Zurich the focused command
`KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/scheduling.integration.test.ts apps/api/test/pending-capacity.test.ts apps/api/test/scheduling.test.ts apps/api/test/capacity.integration.test.ts apps/api/test/pause-budget.integration.test.ts apps/api/test/worker-responses.integration.test.ts packages/contracts/src/response-worker.test.ts`
passed95/95: scheduling30, pure matching7, window5, seller capacity32, pause12,
actual Worker response flow1 and response schemas/browser bundle8. Isolated
fixtures deployed24 current migrations; the capacity suite retains and archives
its synthetic public-schema financial records. No financial history was deleted.
The preceding run had one test-only ledger lookup error (`job` relation instead
of actual `jobId`), corrected before this receipt. Parsed real signed responses
again preserved canonical bytes and verified cryptographically with the parent
global response hook active. Parent owns final independent/global verification.

Source paths: `apps/api/src/pending-capacity.ts`, availability-only changes in
`catalog.ts`, evidence-only changes in `catalog-page.ts`, `scheduling.ts`, NOW
admission/timestamp-only changes in `jobs.ts`, and dispatch-only changes in
`worker.ts`. Parent seller-name/capability-summary regions and Sartre warning
handler regions remain independently owned. Response paths and focused test paths
are listed above. No dev server, Docker, Next, CORS or Redis fixture was started.

## Current Job Waiting State, Master469

The authorized JobDTO now always emits the existing durable `waitDeadline` as
ISO UTC and a nullable `waitReason`. Both fields are additive/optional in the
shared schema for historical consumers; current API detail, buyer list, seller
list, creation and control responses include them. Parent `correlationId` and
seller identity projections are preserved. No database migration was needed.

`apps/api/src/job-wait.ts` computes the reason at read time without changing job
state, events, dispatch or money. A scheduled job before eligibility or outside
the current window reports `WAITING_FOR_SCHEDULE`; once eligible with its
nonrevoked bound devices disconnected it reports
`ELIGIBLE_BUT_WORKER_OFFLINE`. It retains reserved funds and the same deadline.
The other bounded codes are `PROVIDER_PAUSED`, `PROVIDER_UNAVAILABLE`,
`WAITING_FOR_CAPACITY`, `WAITING_FOR_WORKER_ACCEPTANCE`,
`WAITING_FOR_WORKER_START`, `DISPATCH_PAUSED` and `WAIT_LIMIT_REACHED`.
Started, terminal and nonreserved jobs report null. The deadline is retained as
historical information after starting; it is not an execution timeout.

The projection uses the purchased immutable version, exact accepted device,
current security/pause/schedule gates and the existing compatible-device pending
assignment. It distinguishes shared-device capacity from connectivity and never
substitutes the newest version or another device for an accepted attempt.
Unverified/revoked/policy-blocked readiness returns only a generic public code.
Worker IDs, private health/warnings, validation proof, credentials and local
paths are not projected. Existing owner/scoped-key checks run before the lookup,
and seller input/output remain hidden until acceptance. Capability/version
readiness and seller assignment lookups are cached within each list projection.

The focused command below started2026-10-06 14:32:56 Europe/Zurich and passed68/68
in11.56s: scheduling40 (including ten new wait-state DB cases), pending matching7,
window5, pause12, actual Worker-response flow1, and wait contract3.

```sh
KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/scheduling.integration.test.ts apps/api/test/pending-capacity.test.ts apps/api/test/scheduling.test.ts apps/api/test/pause-budget.integration.test.ts apps/api/test/worker-responses.integration.test.ts packages/contracts/src/job-wait.test.ts
```

The wait cases prove offline-at-window retention, reconnect/offer/accept/start
updates, expiry followed by exactly one release and zero capture/earnings, expiry
outbox, historical/assigned device matching, shared capacity, pause/security and
dispatch distinctions, authenticated owner/API-key access, and seller redaction.
An initial test fixture incorrectly tried changing immutable job input; the
database correctly rejected it and the fixture now sets input at creation.
API/contracts typechecks, scoped lint and coverage merge dry-run pass
(1699 reviewed, applied:false). Tests use disposable isolated PostgreSQL schemas
deploying the migrations available at run time; this slice changes no schema or core financial code, and no
browser/Next/Worker/Docker/CORS/Redis runtime acceptance was run. The separate
Curie-owned buyer presentation/copy/deadline rendering is pending, so
`AVL-0066` remains IN_PROGRESS for the full section rather than being promoted
from this API-only evidence.

Changed paths for this slice: `apps/api/src/job-wait.ts`, DTO/read/list regions
only in `apps/api/src/jobs.ts`, `apps/api/test/scheduling.integration.test.ts`,
the wait enum/fields only in `packages/contracts/src/index.ts`,
`packages/contracts/src/job-wait.test.ts`, this status file and
`docs/coverage-api.json`.
