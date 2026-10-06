# Agent service integration status

## Seller preview bundle checkpoint, 2026-10-06 14:33 Zurich

PR-A02/Master229 shared contract and Worker preparation are implemented; Web
export and the test-only CLI reader hook remain separate owners' bindings.
`@kivro/contracts/seller-test` exports `SellerTestBundleSchema`, bundle/asset
types, `SellerTestAssetSchema`, `isSellerTestBundle` and bounded constants.

```ts
type SellerTestBundle = {
  kind: 'KIVRO_SELLER_TEST'; schemaVersion: 1;
  capabilityVersionId: string; manifestHash: string;
  input: Record<string, unknown>;
  assets: { id: string; filename: string; mimeType: string; sizeBytes: number;
    sha256: string; contentBase64: string }[];
};
```

Only saved immutable version/hash and explicitly selected input bytes belong in
this bundle. No permissions, instructions, credentials, paths, asset URLs,
validation proof or approval can be supplied. At most20 unique files,8MiB each,
16MiB total decoded files plus input, and256KiB bounded JSON input; effective
Worker contract/permission limits may be stricter. Canonical base64 length is
validated before decoding, then hash/MIME and exact input references are checked.
Wrong version/hash is rejected before acquiring a lease or checking inference.

`apps/worker/src/seller-test-bundle.ts` exports `prepareSellerTestBundle` and
`readSellerTestInput(path)`. Existing `prepareValidationInput` dispatches portable
bundles to it while retaining explicit local-path fixture compatibility. Reader
checks regular file, single link, no symlink, encoded size before allocation,
open-descriptor identity/size/timestamps and fatal UTF-8/JSON. Ordinary config
commands are untouched and retain2MiB; legacy test input also retains2MiB.

Ram owns `index.ts`: only the `capability test VERSION_ID --file INPUT` branch
should call `readSellerTestInput`; other commands must keep `jsonFile`.
Curie owns explicit preview file selection/download after browser checkpoint:
bind the saved unchanged version/hash, and show the explicit local CLI command.
Download must not upload, execute, purchase, publish, approve or contact localhost.
The local test still uses the seller's approved inference/resources and can incur
seller provider cost. No paid provider or actual Docker execution was run here.

Receipt14:33:01: contracts32 + Worker bundle18 + existing security21 =71PASS.
Scoped lint and contracts/Worker `tsc --noEmit` pass. Browser-only in-memory bundle
has11 inputs/126276 bytes and no server/marketplace imports. No Next build/server
was started. These are unit/helper checks, not complete UI-to-OpenClaw acceptance.
Parent retains PRD-0197 coverage attribution in `coverage-product-review.json`.

Catalog trace handoff: `docs/CATALOG-REVIEW.md` and
`docs/coverage-catalog-review.json`,117 unique previously-unattributed rows:
56 IMPLEMENTED,29 IN_PROGRESS,32 atomic TESTED; no section aggregate TESTED.
Master32 does not require bit-reproducible apt rebuilds. Parent owns immutable
publication-time runtime attestation and central platform file ceilings.

## Attachment matching, semantic roles and response DTOs, 2026-10-06

Latest bounded source batch covers owned-library behavior for Master208/233,
SR-03/Master223 and the requested SR-02 agent response schemas. Parent's
publicDiscovery additions are preserved. No API/UI, inference provider,
accounting, Worker, research broker, database or Docker source was edited here.

Frozen chat binding (exported by `@kivro/marketplace-agent`):

```ts
const body = AgentChatBodySchema.parse(request.body);
const inputAssets = await resolveAgentInputAssets(ctx, user.id, body.inputAssetIds ?? []);
return agent.chat({ ...body, userId: user.id, inputAssets });
```

The resolver is parent-owned `apps/api/src/agent-assets.ts`; run it before
inference initialization. Body `inputAssetIds?: string[]` accepts at most20
distinct UUIDs. `requiredOutputFiles?: { extension?: string; mimeType?: string;
count: number }[]` accepts1..20 groups, each count1..20, sum at most20. At least
one format selector is required. Extensions must be lowercase dotted strings;
MIME selectors must be lowercase type/subtype tokens. Exact duplicate selector
pairs are rejected: combine their counts. UI should normalize before submission.
Body metadata/bytes are forbidden. Internal `inputAssets?: AssetDTO[]` must
exactly equal the explicit ID set; the package checks expiry, strips download
URLs, and exposes only ID/MIME/size/extension to inference, never filename,
hash, storage path or file content. Ownership/scanning/deletion/kind remain the
API resolver's authority and are rechecked by the existing purchase boundary.

`matchDirectContract`, `validatePlanEntryAssets`, `matchOutputRequirements`,
`matchPlanFinalOutputs`, `inputAssetHints`, `RequiredOutputFilesSchema` and their
types are exported from the package. Direct discovery hard-filters I/O mismatch
before ranking/model context. Ambiguous file placement, missing scalar/file
inputs and insufficient declared output guarantees produce explicit issues;
seller scalar defaults require helper policy opt-in and file defaults remain
forbidden. Assignment search is bounded at4096 states. The ready result is
checked by shared `validateInput`, not merely the matching approximation.

`AgentChatResponse.contractMatches?: AgentContractMatch[]` contains returned
capability/version IDs, `status: READY | NEEDS_INPUT | INCOMPATIBLE`, partial
`preparedInput`, `assetOptions`, `appliedDefaults`, typed `issues` and
`output: { compatible, guaranteed, issues }`. Hard-incompatible candidates are
not returned as recommendations. Prepared input is not purchase authority.
Conversation user messages persist `inputAssetIds` and `requiredOutputFiles`;
assistant messages persist the same `contractMatches`. Later turns must
explicitly resubmit IDs for fresh resolution; history never reattaches files.

Plans accept selected files only at explicit literal entry mappings, verify
their actual format/size/count and reject invented IDs, unused selected files,
or null/empty required files before quoting. `inputAssets` metadata is frozen
into the approval hash and retained through repair CAS. Final format/type
requirements are enforced collectively on terminal producers, not every
intermediate step. Output maxima/allowlists are not count guarantees: required
narrow named fields may prove counts; overlapping format groups or unknown
guarantees require clarification rather than a fabricated promise. Repair
revalidates final formats, preserves completed paid work and spent budgets,
and still requires fresh approval. No provider swap or automatic purchase added.

SR-03 policy: a target with an explicit semanticType requires the identical
trimmed, case-sensitive source field semanticType. Different roles and an
unknown source into a typed target are denied. A generic target accepts either
known or unknown source roles under the unchanged MIME/extension/cardinality/
size checks. Aggregate asset selection cannot evade a typed target. Runtime
rechecks the frozen named source role before grants/downstream purchase,
including previously approved legacy snapshots. No role is inferred from
filenames, MIME or model assertions.

New browser-safe `packages/contracts/src/response-agent.ts` exports
`agentResponseRoutes` for all8 current agent endpoints plus strict
`agentChatResponseSchema`, `agentConversationsResponseSchema`,
`agentPlanResponseSchema`, `agentSynthesisPreviewResponseSchema`,
`agentSynthesisResponseSchema`, component schemas and inferred DTO aliases.
Parent owns the `@kivro/contracts/responses` registry/export/API binding; Curie
owns browser consumption. Production schemas import only Zod, browser-safe
shared contracts and response-common, never marketplace-agent/server modules.
Schema tests parse JSON-serialized actual service chat/conversation, plan
lifecycle/repair/replan, and consented synthesis results. Current service/wire
output-file and synthesis validators have parity tests; consolidation of those
schemas into one shared definition is not claimed by this additive DTO batch.

Verification: full package receipt is266/266 across13 files at14:02:48
Europe/Zurich on2026-10-06, exit0, including33 helper,27 attachment/semantic and17
response-schema regressions. Marketplace and contracts `tsc --noEmit`, scoped
ESLint and an in-memory esbuild browser bundle passed. The bundle has94 inputs
and no marketplace-agent, Node builtin or server-contract import. Coverage merge
dry run passed with `applied: false`; no shared coverage/task file was modified.
No paid keys, live-provider call, dev server,
database mutation, Docker run or image rebuild is part of this receipt.

Remaining acceptance boundary: parent resolver/route and Curie attachment picker,
format selectors and restoration/error presentation need their own current
integration/browser receipts. The library tests use authoritative metadata
fixtures and memory repositories, not uploaded file bytes or PostgreSQL. They
do not establish natural-language planning quality, real provider acceptance,
or a complete Blender/render pipeline. §§208/233 aggregate rows remain partial;
the earlier read-only catalog trace is paused, not silently completed.

## Independent debug review, 2026-10-06

Parent-owned `inference-debug.ts`, Router integration and API logging/accounting
binding were independently reviewed against the full literal Master section182.
No blocking finding. The dedicated **17/17** debug tests passed at13:06:17
Europe/Zurich, exit0. Debug is false by default; either production environment
flag defeats enablement; only explicit development/test environments can enable
it. One strong warning precedes count/byte-size/validated-UUID correlation events.
Prompts, responses, schemas, tool names/arguments and arbitrary exception text do
not enter those events. Synchronous sink failures do not change provider retries
or accounting. Successful accounting retains tool-call counts and the API audit
includes conversation/orchestration references.

Only the narrow normative AGT-0085 row is promoted to TESTED. This review did not
change production inference code/tests, rerun a real provider, audit deployment
log shipping, or add positive-tool-call/multiple-attempt debug trace assertions.
The existing tests use provider/accounting/log-sink fixtures; API wiring was
inspected. The Master clause permits full content redaction and does not demand
an unsafe raw-prompt debug option. Earlier debug-gap notes below are historical.

## Discovery controls and payment-denial tests, 2026-10-06

Latest authorized implementation batch closes the owned-library gaps identified
under Master sections 134/135. `inference.ts`, provider tests, API production
routes/accounting, shared contracts and Web implementation remain other owners'
files. Curie has the additive UI contract and owns browser verification.

`AgentChatBodySchema` now accepts optional `preferredCapabilityIds` (at most 100
distinct UUIDs) and `onlineOnly`. Preferences are soft ranking hints among
relevant, eligible public capabilities, not an allowlist or access grant. Missing
preferred IDs are resolved through buyer-scoped `MarketplaceCatalog.get`, and all
existing permission, seller, budget, rating, runtime, dependency, output and
timing checks still apply. Only eligible public preference IDs reach model
context. `onlineOnly: true` requires ONLINE plus `canRunNow`; it cannot be relaxed
by extraction, a zero-wait BUSY queue, scheduling consent, or a preference. It is
rechecked against the approved capability version before purchase. These are
request controls, not new persistent account preferences.

`AgentChatResponse.recommendationDetails?: AgentRecommendation[]` is additive;
the existing `recommendations: CapabilityDTO[]` is unchanged. Exported
`AgentRecommendation` includes capability/version/title/time, deterministic
reason and keyword matches, preference flag, structured price/rating/timing/
permissions/I/O labels, tradeoffs and limitations. Facts come from authoritative
catalog fields, never model-generated prices, ratings or factual explanations.
Runtime is explicitly an estimate; review counts are not renamed verified jobs;
network NONE is not described as proof of local inference. Each assistant
`ConversationMessage` saves the same optional detail array through the existing
repository interface. API conversation JSON already preserves it, requiring no
migration or new route. Web should render escaped text, match the recorded
capability version and treat restored details as historical, not live quotes.

Verification: 171/171 marketplace-agent tests across nine files, including 18
new regressions in `test/recommendations.test.ts`; marketplace and API
`tsc --noEmit`; scoped source/test ESLint. Existing budget, frozen-version,
approval, CAS repair, private-synthesis and inference-failure tests remain green.
Named new evidence includes `never promotes preferences past visibility, seller,
budget, rating, runtime, output, dependency or network constraints`, `returns
and persists versioned public explanations as historical snapshots, including
without inference`, and the three `rejects model ... without copying fabricated
facts or creating purchases` cases. Persistence evidence for the new detail
array uses the repository test harness plus inspected API JSON binding, not a
new PostgreSQL restoration/browser test. Live-provider quality and browser
acceptance remain separate. The only DAG-fixture edit adds `onlineOnly: null` to
its synthetic intent reply; Docker was not rerun and the accepted controlled
receipt remains historical evidence for its recorded source state.

Separately, the authorized test-only `apps/api/test/protocol.integration.test.ts`
batch passed **20/20** on 2026-10-06 at 12:54:38 Europe/Zurich (exit 0). Four added
cases are session/zero cents, session/98 cents, `jobs:create` API key/zero cents,
and API key/98 cents, all buying the 99-cent tier. Each asserts repeated HTTP
402/`INSUFFICIENT_FUNDS`, no job/attempt/reserve/ledger/event/grant/idempotency/
purchase-quota/capacity side effects, and no offers on a valid signed Worker
poll. Actual `creditWallet` funding followed by the same request key admits one
job, reserves 99 cents exactly once across replay, and yields a signed
`paymentSecured` offer. Cancellation releases the 99 cents. Keys are scoped to
`jobs:create`; the public versioned API is exercised. The real local DB and
existing S3/Redis are used, not a mocked ledger. Synthetic accounts/Workers are
retired, capability hidden/paused, and all financial history retained. No
Docker, real-provider calls, production payment edit, server or build was used.
This receipt predates the parent's additive FinancialBreakdown/migration020
change; it is not relabeled as a post-migration rerun.

Coverage rows PRD-0116, AGT-0035/0036/0037 and related recommendation clauses are
updated conservatively: owned source and named tests now exist, while aggregate
sections are not promoted to TESTED. Natural-language resolution of seller or
capability aliases remains unimplemented; explicit UI/UUID controls are available
and the literal section allows natural language **or** controls. No new approval,
purchase authority, model debug implementation or external acceptance is claimed.

## Independent review and atomic coverage, 2026-10-06

The preceding bounded scope was review/documentation only. Laplace owns Worker research
integration and the trusted `SafeHttpClient` cancellation implementation. No
production file, API route, Worker state, Docker image or running service was
changed by this review. Earlier integration-open notes below are historical;
the current findings and `docs/coverage-agent.json` take precedence.

**R16 research/cancellation review:** no blocking defect found in the reviewed
fixed-source prefetch, private cache-only tools, immutable consent/version/seller
binding, seller-narrowed job-lifetime budgets or trusted AbortSignal propagation.
The same signal reaches host Brave/fetch/connectors; cancellation abandons pending
DNS, destroys an active request and prevents a subsequent redirect connection.
Abort reasons do not enter public errors. Private input/resource labels are not
cleared. Outbound research has a separate deadline so the immutable cache remains
usable afterward while the job itself is still active.

**R17 telemetry:** persisted receipts retain sanitized host/status/bytes/hash
metadata, not raw queries, URLs, arguments or resource content. Failed traffic is
unknown (`actualBytes: null`), not invented zero usage. Page hashes bind exactly
one unannotated receipt. Native tool observations remain `OBSERVED`; only the
reviewed plugin's completed calls have per-tool success/failure evidence.

Independent verification completed:

- 144 Agent/integrations tests across eight files.
- 188 Worker research/observations/runtime/diagnostics/transport and all broker
  tests across nine files. An initial sandbox-restricted attempt hit localhost
  `listen EPERM`, was stopped, and passed on the permitted loopback-only rerun.
- 21 adapter security tests, including the final zero-tool-summary regression.
- Worker and broker `tsc --noEmit`; scoped changed-source/test ESLint.
- `scripts/coverage-merge.ts` dry run passed with `applied: false`; no shared
  coverage/requirements/Task completion file was changed.

Laplace separately reports both real Docker smoke fixtures passed on final image
`sha256:4b2874ffba74006e54b613bb988eabcc1fb57e0839e156bdaed20318830b680f`.
This review did not rerun Docker or retag/rebuild that image. The research smoke
uses public example.com plus a private snapshot, a synthetic seller identity and
deterministic inference. It is not an actual private DB/full signed API research
job, live Brave/provider acceptance, or the canonical advertising/video pipeline.
Socket cancellation unit tests mock `node:https`; pending-DNS cancellation uses
the real client with an injected resolver. Those evidence limits remain open.

**Coordinated P1 finding: pause runtime differs from the advertised policy.**
`apps/worker/src/state.ts` fixes the deadline at acceptance plus timeout;
`apps/worker/src/runtime.ts` keeps it running through PAUSED. The two named
`includes paused wall time without resetting the budget on resume=%s` regressions
confirm timeout after 30 wall seconds despite at most 20 active seconds. Conversely,
`apps/api/src/background.ts` subtracts paused time and applies a separate maximum
pause allowance, while `apps/api/src/jobs.ts` advertises `FULL_RESUME`. The runner
and OpenClaw `--timeout` also have wall-time timers. This is not FULL_RESUME
acceptance under Master sections 433/434/438/439/440 (notably JOB-0163, JOB-0166,
JOB-0174, JOB-0177 and JOB-0179). Reported to Laplace for parent coordination;
no unilateral runtime/financial-policy edit was made.

Bounded follow-up: agree one persisted active-runtime/pause-allowance/absolute
containment contract across API, Worker and the pinned runner, without resetting
remaining active time or spending on resume. Extending the host timer alone is
insufficient. Until actual pause/resume acceptance, expose truthful capability
pause support. Required tests include a permitted long pause followed by useful
resume, over-pause failure with one release, repeated pauses without budget reset,
and cancellation while paused. Do not turn pause into an implicit cancel.

Atomic coverage now has 288 rows, including 126 newly mapped AGT/PRD normative
clauses from the full relevant Master sections and named test/source evidence.
Eleven narrow atomic rows are TESTED; no SECTION_COVERAGE row was promoted to
TESTED. Missing per-recommendation reasons/limitations (AGT-0036/0037), preference
controls (PRD-0116), safe development inference debug mode (AGT-0085), real model
feature/provider acceptance, distributed research limits/cloud egress, and the
canonical advertising workflow remain explicitly partial or unverified. Optional
streaming/browser rendering is not misrepresented as a mandatory implementation
gap. The controlled PDF DAG remains supplemental local evidence, not a blanket
completion claim.

Core services implemented; focused tests, package typechecks and lint exercised.
This is not a full-MVP acceptance claim. Owned paths: `packages/marketplace-agent`,
`packages/research-broker`, `packages/integrations`, this document and
`docs/coverage-agent.json`. The latest human handoff gives the parent exclusive
ownership of `packages/marketplace-agent/src/inference.ts` and
`packages/marketplace-agent/test/inference.test.ts`; this agent no longer edits them.
Subsequent explicit scope grant: only synthesis preview/POST routes and their
required imports in `apps/api/src/agent.ts`. Accounting and chat remain parent-owned.
Latest explicit bounded scope adds only `scripts/e2e-orchestration-fixture.ts`
and its documentation for R07 / Master section 160. No edits to the existing
`scripts/e2e-fixture.ts`, root commands, API, Worker or shared production modules
are part of that batch. See `docs/E2E-ORCHESTRATION-FIXTURE.md` for the exact
local-inference substitution, prerequisites, verification and retained history.
R07 CONTROLLED LOCAL PASS on 2026-10-06: parent stopped/reconfirmed the main
reconciler off; port 4000 checks were clear before and after execution. Fresh
API/Prisma imports and all 19 applied migrations (including 017/018) were verified.
Fixture `c4db5210-131e-44f5-af79-f7a6124b7bf8`, plan
`1db8ca51-19cd-440f-a641-ae6bfb020c61`, exited 0: two sellers, three real file reads
feeding one PDF, 396-cent plan spend, consented four-source provenance, eligible
reviews and exactly-once signed-result replay settlements. Cleanup and an
independent audit confirmed zero containers/sessions/reservations/uncommitted
objects, eight committed publication records, revoked Workers and paused
capabilities. No fixture process remains; the main API was not restarted.
Full evidence: `docs/E2E-ORCHESTRATION-CONTROLLED-RECEIPT.json`. This is coordinated
process isolation on public schema, not an isolated schema. The older plan
`88f433de-7cca-497d-ae78-31a9c640bd0b` remains explicitly qualified as uncontrolled.
Loopback deterministic inference/fake payment do not close external-provider,
Stripe staging or browser acceptance.

Latest handoff, 2026-10-06: A13 static and runtime mapping defenses are in owned
source. Approved steps now persist frozen I/O snapshots and definition hashes.
Bounded individual-step repair and deterministic replan are now implemented;
both require explicit revision, quiescent persistence and fresh buyer approval.
API/Worker integration and the parent's signed-protocol tests remain separately
owned; this document does not claim those acceptance tests have passed.

Current bounded batch: consent-bound final synthesis and typed provenance are
exposed by MarketplaceAgent, chat exposes the planner's existing hard constraints,
and no-immediate-match responses offer read-only future choices. Batch repair
regressions preserve paid work and budgets through one CAS. Provider configuration
autodetection/default profiles and their tests now belong to the parent.

## Parent/API integration notice

Implemented source exports (all server-only, ESM, Node >=22):

- `@kivro/marketplace-agent`: `MarketplaceAgent`, `PlatformInferenceRouter`,
  `OpenAIPlatformProvider`, `AnthropicPlatformProvider`,
  `createInferenceConfiguration`, `OrchestrationService`, `validatePlan`,
  `planApprovalHash`, `capabilityDefinitionHash`,
  `PlanRepairBodySchema`, `PlanRepairBody`, `PlanReplanBodySchema`, `PlanReplanBody`,
  `AgentChatBodySchema`, `AgentChatBody`, `AgentChatResponse`,
  `AgentSynthesisBodySchema`, `AgentSynthesisRequestSchema`,
  `AgentSynthesisPreviewSchema`, `AgentSynthesisResponseSchema`,
  `AgentSynthesisSourceSchema` and corresponding inferred types,
  `ConversationRepository`, `PlanRepository`, `PurchaseExecutor`,
  `InferenceAccounting`, `MarketplaceCatalog`.
- `@kivro/research-broker`: `SafeHttpClient`, `ResearchBroker`,
  `BraveSearchProvider`, `ConnectorRegistry`, `assertPublicAddress`,
  `ResearchAccounting`, `NetworkPolicyError`, `bindJobResearchTools`,
  `createResearchRequestHandler`, `createRemoteResearchTools`,
  `createResearchInferenceBridge`, `BrokeredResourceTool`.
- `@kivro/integrations`: `WebhookDispatcher`, `WebhookRepository`,
  `createWebhookSecret`, `signWebhook`, `verifyWebhook`,
  `createApiKey`, `authenticateApiKey`, `ApiKeyRepository`.

The API agent owns persistence, authentication, routing, job/payment transactions,
and background dispatch. No memory-backed production repositories will be shipped.
The package manifests declare local dependencies; the parent owns workspace
installation and root lockfile. Packages use Zod 3, Ajv 8, ipaddr.js 2 and
htmlparser2 10 as needed. No other owner's source files were edited.

## Concrete API wiring (ready now)

```ts
import {
  MarketplaceAgent, OrchestrationService, PlatformInferenceRouter,
  createInferenceConfiguration, AgentChatBodySchema, AgentSynthesisBodySchema,
  type MarketplaceCatalog, type ConversationRepository, type PlanRepository,
  type PurchaseExecutor, type InferenceAccounting,
} from '@kivro/marketplace-agent';

// Implement these against the existing authenticated application services/DB.
declare const catalog: MarketplaceCatalog;
declare const conversations: ConversationRepository;
declare const plans: PlanRepository;
declare const executor: PurchaseExecutor;
declare const accounting: InferenceAccounting;

const configuration = createInferenceConfiguration(process.env);
const inference = new PlatformInferenceRouter({ ...configuration, accounting });
const orchestration = new OrchestrationService({ catalog, plans, executor });
const agent = new MarketplaceAgent({ catalog, conversations, orchestration, inference });

// request.user.id MUST come from cookie/API authentication, never request.body.
const response = await agent.chat({ ...AgentChatBodySchema.parse(request.body), userId: request.user.id });
// Response: {conversationId,message,recommendations,timingAlternatives?,plan?,inferenceStatus}
// mode:'PLAN' creates AWAITING_APPROVAL only. Missing inference never creates a plan.
const approved = await orchestration.approve({
  planId: request.params.id, userId: request.user.id,
  expectedRevision: request.body.expectedRevision,
});
// Queue a durable execution tick after commit; do not block the HTTP request on jobs.
await orchestration.execute({ planId: approved.id, userId: approved.userId });
const persisted = await orchestration.get(request.params.id, request.user.id);
const history = await conversations.list(request.user.id);
// GET /api/agent/plans/:id/synthesis-preview (authenticated, no inference):
const preview = await agent.getSynthesisPreview({ planId: persisted.id, userId: request.user.id });
// POST /api/agent/plans/:id/synthesize (separate request after buyer consent):
const synthesis = await agent.synthesize({ ...AgentSynthesisBodySchema.parse(request.body),
  planId: persisted.id, userId: request.user.id });
```

## Synthesis and chat binding checklist

The parent owns `apps/api`; Curie owns Web and has received this exact contract.
The human subsequently granted this agent only the two synthesis routes. Both
are now bound in `apps/api/src/agent.ts`; chat still duplicates a smaller schema
and infers scheduling consent from timingMode at the last inspection.
Binding status:

1. Implemented authenticated GET `/api/agent/plans/:id/synthesis-preview`, calling
   `agent.getSynthesisPreview({planId,userId})` with validated UUID path parameters.
2. Implemented rate-limited authenticated POST `/api/agent/plans/:id/synthesize`, using
   `AgentSynthesisBodySchema` plus authenticated user/path IDs. Never default or
   manufacture consent, source IDs, the manifest hash or the reviewed revision.
   It reuses the existing daily `agent-turns` bucket and adds a five/minute limit.
3. Parent still needs to replace chat's duplicate body schema with `AgentChatBodySchema`, without
   changing its `allowScheduling:false` or `maxQueueWaitSeconds:0` defaults.
   Neither a future timingMode nor a suggested option alone supplies consent.
4. Preserve the entire `ConversationMessage.synthesis` JSON when appending and
   retrieving conversations. Existing JSON storage appears compatible by source
   inspection, but a DB/API round-trip test has not been run here. Job-linked
   messages, including older messages without typed synthesis metadata, are
   excluded from future model chat history to avoid automatic redisclosure.
5. Implemented POST mapping of `SYNTHESIS_CONSENT_STALE` to HTTP 409, requiring a fresh
   preview and buyer consent, never an automatic retry. Keep provider/context/budget failures
   explicit and sanitized. No summary operation should wake purchases or approve
   a plan. `INFERENCE_BUDGET_EXCEEDED` belongs to inference accounting, not wallet
   spending. Rate limits and durable account budgets remain mandatory.

Verification: 26 synthesis library tests plus four route-binding tests pass.
`test/synthesis-routes.test.ts` exercises the real registered handlers with
fixture identity/storage: authentication, strict consent bodies, exact scoped
arguments, daily-turn denial and stale conflict/no-retry. It does not claim a
real PostgreSQL HTTP round-trip. No DB schema or persistence implementation change
was necessary; append already serializes complete message JSON. A concurrent
API typecheck temporarily encountered parent billing/Prisma `payoutRecord`
generation errors, unrelated to these two routes. Final API and Marketplace
`tsc --noEmit` reruns passed after that concurrent generation work resolved.

Exact POST body (all fields required):

```ts
type AgentSynthesisBody = {
  expectedRevision: number;
  sourceManifestHash: string; // SHA-256 from preview
  sourceJobIds: string[]; // 1-32 unique selected IDs from preview
  consentToProviderProcessing: true;
};
```

`AgentSynthesisPreview` returns `{planId,revision,sourceManifestHash,available,
processingDestinations,sources,fileContentsProcessed:false,maxContentBytes:24000}`.
Each processing destination contains only `{provider,model}`, including the
configured fallback. Source records contain `{stepId,jobId,capabilityId,
capabilityVersionId,outputHash,hasText,hasJson,fieldKeys,assets}`. Assets contain
`{id,filename,mimeType,sizeBytes,sha256}` only, never download URLs or file bytes.
The preview makes no inference calls, purchases, transfer grants or mutations.

The UI must disclose the plan's goal, selected text/JSON/named fields and file
metadata being sent to the listed providers. Consent must be a separate explicit
buyer action. The backend binds it to the completed plan's revision, frozen output
hashes and configured destinations; unselected/foreign/retired job outputs are
not sent. Changed output or configuration invalidates the old preview. The
24,000-byte input limit is checked before reserving inference spend. Inference
uses the existing bounded profile retries and durable-accounting callback.

`AgentSynthesisResponse` returns `{id,kind:'AGENT_SYNTHESIS',planId,planRevision,
message,createdAt,provider,sources,fileContentsProcessed:false,consent}`. Consent
records `{acceptedAt,sourceManifestHash,sourceJobIds,processingDestinations}`;
sources are the authoritative version/output/file metadata for jobs actually
cited. All processed jobs remain in `consent.sourceJobIds`, even if not cited.
The structured response is persisted on `ConversationMessage.synthesis` when
the plan has a conversation, and is returned to the caller otherwise. Plans and
paid output artifacts are unchanged. No file generation, file reading or tool
execution is exposed to the synthesis model. Rendering must label the summary
as agent synthesis, separate from original paid outputs, and use text, not HTML.
Schema validation cannot certify the semantic truth of every generated sentence.

Chat now accepts `maxPerJobSpendMinor`, `maxJobs` (default 8), `blockedSellers`,
`outputTypes`, and `maxQueueWaitSeconds` (default 0), as well as previous fields.
Inference may tighten total/per-job budgets and job count, never raise them.
Immediate busy queues require authoritative `canQueue:true` and a finite wait
within the explicit bound; queue purchases still use NOW, not SCHEDULED.
`timingAlternatives?: CapabilityDTO[]` offers up to three compatible future
records when the bounded search finds no immediate match. It does not create
quotes, scheduling authority or a plan. Display future timing and request a new
explicit scheduling choice before planning. Do not claim exhaustive catalog
absence from a bounded search.

Batch repair already uses the existing `/api/agent/plans/:id/repair` and
`PlanRepairBodySchema`: `expectedRevision`, `reason`, and 1-8 replacements
`{stepId,capabilityId,capabilityVersionId,inputMapping?}`. Present all replacements,
retained outputs, paid spend and new estimates; approve the returned revision
only after a separate fresh buyer action. No new automatic multi-step purchase
or repair endpoint is needed. Browser code must import package types with
`import type`; this package's runtime exports are server-only.

The exact repository and callback types are in
`packages/marketplace-agent/src/types.ts` (exported from `src/index.ts`):

- `ConversationRepository`: `create(userId)`, `get(id,userId)`, `list(userId)`,
  `append(id,userId,messages)`; return `Conversation` including user-visible messages.
- `PlanRepository`: `create(plan)`, `get(id,userId)`,
  `compareAndSwap(plan,expectedRevision): Promise<boolean>`. Atomically require
  the stored revision to equal expectedRevision; replacement has revision + 1.
  Repair additionally requires the quiescent CAS described below. It never
  falls back to the ordinary CAS when this stronger callback is missing.
- `MarketplaceCatalog`: `search({userId,query,cursor?,limit})` returning
  `{capabilities,nextCursor?}`, `get(capabilityId,userId)`,
  `quote({userId,capabilityId,capabilityVersionId,executionMode,scheduledAt?})`.
- `AgentQuote`: `{id,capabilityId,capabilityVersionId,amountMinor,expiresAt,
  earliestStartAt,estimatedDeliveryAt}`. Convert the job quote's price snapshot
  to `amountMinor`; preserve the stored quote UUID and expiry.
- `PurchaseExecutor.createJob`: `{userId,planId,stepId,expectedPlanRevision,approvalHash,maxBudgetMinor,
  capabilityId,capabilityVersionId,quote,input,executionMode,scheduledAt?,idempotencyKey}`
  returning `{jobId}`. In ONE transaction, read the stored approved plan, verify
  exact `storedPlan.revision === expectedPlanRevision`, hash/owner/step/quote,
  immutable capability version, and
  `capabilityDefinitionHash(version) === approvedStep.capabilityDefinitionHash`.
  Recheck live availability and asset access, enforce
  `sum(settled + reserved + newly authorized) <= maxBudgetMinor`, and call the
  normal secured-payment job service. Deduplicate the stable key
  `orchestration:<planUUID>:<stepUUID>` with a request fingerprint.
  `execute` passes the CURRENT `plan.revision` after its RUNNING/progress CAS
  saves, not the revision originally approved by the buyer. Check it inside the
  same reservation lock. Do not put this changing revision into the stable job
  idempotency identity; already committed job recovery remains read-only.
- `PurchaseExecutor.lookupCreatedJob?({userId,planId,stepId,idempotencyKey})`
  returns `{jobId}` or `null`. This is a read-only DB lookup of an already
  committed job, verifying buyer, plan, step, approved version and stable key.
  Implement it to recover a job commit followed by plan-CAS failure even when
  the provider is now busy or the old quote expired. Never create/reserve/approve
  anything in this callback. Without it, createJob still must deduplicate, but
  availability/quote gates can block recovery of the unrecorded committed job.
- `PurchaseExecutor.getJob(jobId,userId)` returns `{id,state,output?}` where state
  is `PENDING|SUCCEEDED|FAILED|CANCELLED`. Map active job states to PENDING and
  TIMED_OUT to FAILED. Return only already validated, buyer-authorized output.
- `PurchaseExecutor.authorizeAssetTransfer({userId,planId,sourceJobId,targetStepId,
  assetId})`: verify ownership and grant only this next step; idempotent.
- `InferenceAccounting.reserve({requestId,task,provider,model,metadata,
  maxCostMicroUsd})` returns reservation ID; enforce DB/Redis user/conversation
  spend and request limits atomically. `finish(id,{costMicroUsd,usage?,latencyMs,
  outcome,code?})` is idempotent. Retain uncertain failure reservations at their
  full amount. No raw prompts, responses, secrets, or hidden reasoning in usage logs.

API approval routes MUST require the exact `expectedRevision` the buyer reviewed.
Do not substitute the latest server revision when it is omitted. The package
requires it; the latest API source now requires it too. The previous omission
fallback has been removed by its owner, not edited by this agent.

New persisted step fields: `contractSnapshot: IOContract` and
`capabilityDefinitionHash: string`. Both are included in `planApprovalHash`.
JSON plan repositories require no new service interface, but pre-snapshot plans
must be explicitly replanned/reviewed. Do not backfill old approved plans with
today's contracts or recompute their approval hash to silently migrate them.

Configuration handoff supersedes the previous no-defaults policy: the human now
requests standard `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` autodetection when exactly
one provider is configured, an explicit `PLATFORM_INFERENCE_PROVIDER` when both
are configured, and pinned low-cost model/rate defaults with explicit overrides.
The parent exclusively owns `createInferenceConfiguration`, provider tests and
API `.env` binding. Consult that implementation for current aliases/defaults;
this agent has not independently verified the new configuration paths. Explicit
task profiles remain supported. Preserve `processingDestinations(task)` so
synthesis previews disclose primary and fallback providers/models without keys.

## Research endpoint and worker hook

```ts
import {
  ResearchBroker, BraveSearchProvider, createResearchRequestHandler,
  bindJobResearchTools,
} from '@kivro/research-broker';

const broker = new ResearchBroker({
  accounting: researchAccounting,
  authorize: async context => {
    // DB: active job + active attempt, bound buyer/version, immutable permission
    // snapshot, current revocation, and trusted Resource Broker taint labels.
    return loadAuthorizedJobEgressGrant(context);
  },
  searchProvider: env.BRAVE_SEARCH_API_KEY
    ? new BraveSearchProvider(env.BRAVE_SEARCH_API_KEY) : undefined,
});
const handleResearch = createResearchRequestHandler({
  broker,
  authenticateActiveJob: async request => {
    // Verify the signed worker request, nonce, worker ownership and ACTIVE attempt.
    // Derive userId/jobId/capabilityVersionId from the DB; never trust body identity.
    return authenticateBoundWorkerJob(request);
  },
});
fastify.post('/api/worker/jobs/:id/research', async request =>
  handleResearch(request, request.body));
// Body: {attemptId,operation:'search'|'fetch',args:{...}}
// search args: {query,maxResults?,locale?,freshness?}; fetch args: {url,method?:'GET'|'HEAD'}.

// In an authenticated stdin/stdout bridge, bind the trusted context once:
const jobTools = bindJobResearchTools(broker, verifiedJobContext);
await jobTools.search({ query: 'public company product' });
```

`ResearchAccounting.reserve` must atomically enforce per-job count/byte/duration
limits and per-user/host rate/concurrency caps, returning a reservation ID.
`finish` persists safe metadata and reconciles bytes. `authorize` is called on
EVERY operation and returns `{policy,dataClasses}`. `ResearchPolicySchema` sets
absolute ceilings; only explicitly enabled search/fetch or registered connectors
are available. Missing/UNKNOWN/private labels deny generic research. The labels
MUST be assigned by trusted job/resource code; accepting a sandbox's claim of
PUBLIC would invalidate the data-flow boundary. A job that has read private data
cannot subsequently label arbitrary model-generated queries public.

Do not give a sandbox `SafeHttpClient`, `HttpTransport`, arbitrary headers,
credential callbacks, registry registration, or policy construction. Only the
bound tools are the worker surface. The outer network-none container remains
required; these libraries do not themselves wire the Worker bridge or firewall.

Configure `BrokerOptions.audit(event)` to persist safe denial/failure metadata
even when authorization, schema validation or data-flow policy denies an operation
before reservation. It receives context, operation, code and outcome, never raw
queries, URLs, bodies or secrets. Success/traffic metadata goes to `accounting`.

## Actual inference-pipe adapter

This is an executable integration option for the Worker's existing
OpenAI-compatible inference pipe. It inserts a bounded tool-result round trip;
it does not expose raw HTTP or require shell/network access inside Docker.

```ts
import { createResearchInferenceBridge, createRemoteResearchTools } from '@kivro/research-broker';

const remoteResearch = createRemoteResearchTools(command =>
  signedWorkerTransport.request('POST', `/api/worker/jobs/${offer.jobId}/research`,
    { attemptId: offer.attemptId, ...command }));

// Construct ONCE per job, outside the per-request callback.
const inferenceWithTools = createResearchInferenceBridge({
  infer: body => sellerInferenceBroker.request(body),
  research: remoteResearch,
  initialDataClasses: trustedInitialJobDataClasses,
  assertActive: async () => assertRunningUncancelledAttempt(offer.attemptId),
  maxRounds: 4,
  // Optional: server-registered Resource Broker operations, never arbitrary SQL.
  resourceTools: approvedReadOnlyResourceTools,
  markPrivateData: async () => persistJobDataTaint(offer.jobId, 'SELLER_PRIVATE'),
});
await adapter.execute(spec, offer, inferenceWithTools, signal, onStarted);
```

The inference broker must validate/allow the published broker tool names
`kivro_web_search`, `kivro_web_fetch`, and registered `kivro_resource_*` names,
and accept/forward `parallel_tool_calls: false`. Those permissions must be bound
to the approved capability version. The older Worker schema rejects both new
names and that field, so merely replacing the callback is not sufficient.
Its seller inference budgets must remain active for every internal round.
Framework-owned tool calls pass back to OpenClaw; mixed framework/broker batches
fail before executing either group. Private-resource taint is persisted before
disclosing resource data and prevents later generic research egress. This default
does not silently declassify private content, even into GET/search query strings.

The Worker owner's newer `JobToolBroker`/native bridge may instead call
`ResearchBroker.search/fetch` directly, preserving its existing approved tool
names. Do not apply both dispatch mechanisms to the same call. Both paths must
verify active attempts, immutable policy, revocation, and trusted data labels.
The package does not implement a private database driver or approve resources;
`BrokeredResourceTool` accepts already approved, typed, read-only host callbacks.

## Plan and mapping semantics

- `chat` is advisory and cannot access `PurchaseExecutor`. Discovery without AI
  remains useful lexical catalog matching and is explicitly labeled deterministic.
- Planning defaults to IMMEDIATE; every step must currently be eligible, and
  unknown queue wait is denied. Scheduling requires explicit UI/user consent.
  BUSY requires `canQueue === true` plus a finite nonnegative authoritative
  `estimatedQueueWaitSeconds <= maxQueueWaitSeconds`. It uses NOW, not SCHEDULED.
  The parent's shared availability schema now includes the optional finite,
  nonnegative queue estimate. The catalog must supply a trusted estimate or the agent conservatively rejects
  the queue. The API quote callback must also accept bounded NOW queue requests.
- `validatePlan` rejects cycles, duplicate/unknown dependencies, missing inputs,
  budget/rating/permission violations, and unavailable steps. JSON pointers cannot
  traverse prototype fields; references require declared dependencies.
- Plan approval binds immutable proposal fields, quote IDs/prices/expiries,
  versions, frozen I/O contracts, permission/contract fingerprints, constraints
  and timing through `planApprovalHash`. Runtime progress
  is persisted with revision CAS. Every job uses a stable idempotency key.
- Every successful job output is checked against its approved frozen contract,
  not the latest catalog definition. Invalid output fails the source step and
  prevents dependent purchases. Unstarted steps require the same version ID AND
  definition hash before dispatch; same-ID definition drift does not gain consent.
  Version/definition/price drift never substitutes a new step or issues a new
  approval. The API transaction must repeat these checks to close read/write races.
- A13 fixed: asset mappings compare MIME sets, extension sets, per-file/total
  size bounds, guaranteed source count/index, and target cardinality BEFORE
  quoting or purchasing upstream. Generic outputs guarantee one file only when
  required. Higher indices require named FILES fields with sufficient minFiles.
- Named file mappings use `{kind:'asset',sourceStepId,sourceField?,assetIndex,
  targetInput}`. Named scalar/JSON mappings use `/fields/<key>` pointers.
  Requiredness, scalar type/bounds, required JSON properties, array minimum
  lengths and static JSON schema compatibility are checked conservatively.
  File metadata is validated again and ownership grants are checked before
  downstream purchase. Unknown/unsupported conversions fail closed.
- Aggregate `/text` mappings guarantee presence, but aggregate output contracts
  do not describe a useful text-length bound. Full target validation still gates
  downstream purchase; named output fields provide pre-purchase length checks.
- Execution is a bounded tick: refresh purchased jobs, dispatch ready branches,
  persist status, return. The API scheduler resumes it after events/restart.
  Upstream failures skip unstarted descendants; purchased branches remain visible.
- Stale quotes/provider changes stop execution. Explicit repair/replan below can
  replace unstarted work or terminal failed attempts, preserving paid work.
  Every repaired plan requires fresh buyer approval; delegated budgets and
  background substitution without another buyer review are not implemented.

## Repair API handoff for Feynman and Curie

The methods and exported Zod body schemas are implemented. No API or Web source
was edited. Native `send_input` is unavailable. Feynman's app thread became
available during final coordination; the required expectedPlanRevision change,
post-save revision semantics and regression results were directly handed off
through app messaging on 2026-10-06. Feynman owns the exact comparison inside
beforeReserve's lock. This is not a claim that this agent executed API integration.

Latest read-only integration inspection: the API now registers both exact routes,
uses the exported body schemas, implements lookupCreatedJob and a shared-lock
quiescent CAS checking complete job-ID sets/terminal payment state, and writes
PLAN_REPAIRED audit in that transaction. Web calls replan with the reviewed
revision, presents retained work/attempt budgets and requires fresh approval.
This confirms interface alignment in source, not the parent's full integration
test results. API financial P1 hardening remains concurrently owned by that team.

```ts
import { PlanRepairBodySchema, PlanReplanBodySchema } from '@kivro/marketplace-agent';

// POST /api/agent/plans/:id/repair
// {expectedRevision,reason,replacements:[{stepId,capabilityId,capabilityVersionId,inputMapping?}]}
const repaired = await orchestration.repair({
  ...PlanRepairBodySchema.parse(request.body),
  planId: request.params.id, userId: request.user.id,
});

// POST /api/agent/plans/:id/replan
// {expectedRevision,reason,stepId,query?}
const replanned = await orchestration.replan({
  ...PlanReplanBodySchema.parse(request.body),
  planId: request.params.id, userId: request.user.id,
});
// Both return OrchestrationPlan with status AWAITING_APPROVAL and no approval.
// Present changed services, price/permissions/output, paid work and repairHistory.
// Only a separate explicit POST /approve {expectedRevision: returnedPlan.revision}
// can authorize execution. Never automatically invoke approve after repair/replan.
```

`repair` accepts 1-8 explicit replacements and preserves dependencies. Omitted
inputMapping preserves existing mapping; an explicitly supplied mapping is fully
validated. `replan` searches at most four 25-result pages, deterministically ranks
eligible alternatives, and tests complete DAG compatibility using existing input
mapping. It selects one compatible replacement for the requested step into an
UNAPPROVED draft. This is deterministic catalog replan, not AI inference. It
does not invent new conversions; explicit multi-step repair can replace up to
eight affected steps at once. No compatible option produces NO_COMPATIBLE_REPAIR
and leaves the original plan unchanged, without claiming an exhaustive search.

Required persistence callback:

```ts
compareAndSwapQuiescent(
  plan: OrchestrationPlan,
  expectedRevision: number,
  expectedJobIds: string[],
): Promise<boolean>
```

The callback must run one DB transaction under the SAME per-plan lock used by
PurchaseExecutor.createJob. Verify buyer/plan ownership, exact old revision,
exact set of committed jobs (including failed/refunded/retired attempts), and
that every job is terminal. Reject any unknown or active job, including a commit
whose ID has not yet reached plan JSON. Store the entire new plan and embedded
repairHistory atomically, with revision + 1; false becomes PLAN_CONFLICT. Never
drop existing agentPlan.jobIds during this update. Missing callback yields
REPAIR_PERSISTENCE_UNAVAILABLE. A generic revision-only CAS is NOT sufficient.

Each repair preserves COMPLETED steps, their job IDs, contracts, outputs and
provenance, even if the old provider disappeared or its old quote expired.
`retainedWork` hash-binds those outputs to the new approval. Runtime PENDING jobs
yield ACTIVE_JOBS_PREVENT_REPAIR without partial changes; resolve them first.
An explicit replacement of a terminal unsuccessful paid step moves the old
attempt to immutable `retiredSteps`, generates a new step ID/idempotency key,
and rewires dependent references. Completed paid steps cannot be replaced.
Unselected failed paid steps cause UNRESOLVED_FAILED_STEP, not an implicit retry.

`estimatedCostMinor` is a conservative lifetime estimate: completed quoted spend
+ retired paid attempt quotes + all remaining quoted purchases. Failed/refunded
attempts are conservatively counted in full, never silently freed from budget;
the API transaction additionally enforces its actual ledger totals. maxJobs
counts retired attempts as well. Constraints/timing/budget cannot be increased
through either repair body. Known completed output is validated against proposed
inputs before quoting; every pending quote is refreshed. Completed quotes are
preserved. Approval then rechecks live versions/definitions and all remaining
eligibility without requiring historical completed sellers to be available.

`repairHistory` stores the actor, reason, deterministic/explicit mode, previous
revision/approval/definition and output hashes, replacement IDs, committed spend
and remaining budget. Old history and paid work are preserved. History is bound
into the new plan approval hash. Limit: five committed repairs per plan, eight
explicit replacements per repair, 32 total configured jobs/attempts maximum,
and an 8 MB persisted repaired plan ceiling. Limit failure never buys anything.

Other expected errors: PLAN_NOT_FOUND, PLAN_CONFLICT, COMPLETED_STEP_IMMUTABLE,
COMPLETED_OUTPUT_CHANGED, INVALID_RETAINED_WORK, REPAIR_LIMIT_EXCEEDED,
JOB_COUNT_EXCEEDED, BUDGET_EXCEEDED, INCOMPATIBLE_MAPPING,
INCOMPATIBLE_RETAINED_OUTPUT and the existing live policy errors.

The checked-in Master Spec places repair in section 501 and repair acceptance
cases in section 516. Section 518 is UI design direction. Coverage uses the
actual IDs from spec/REQUIREMENTS.md, without inventing a repair ID for 518.

## Webhooks and API keys

```ts
import {
  createApiKey, authenticateApiKey, createWebhookEvent, createWebhookSecret,
  validateWebhookEndpoint, WebhookDispatcher, verifyWebhook,
} from '@kivro/integrations';

const issued = createApiKey({ userId, name: 'Automation', scopes: ['jobs:read'] });
await apiKeyStore.insert(issued.record); // SHA-256 of a random 256-bit secret only.
// Return issued.secret exactly once; never put it in URLs, logs, or Worker DTOs.
const identity = await authenticateApiKey(bearerToken, ['jobs:read'], apiKeyRepository);

await validateWebhookEndpoint(url); // HTTPS + all DNS addresses checked at registration.
const secret = createWebhookSecret();
await webhookStore.insert({ url, userId, encryptedSecret: await encrypt(secret) });
// Job state transaction/outbox must enqueue one immutable event for its owner.
const event = createWebhookEvent('job.completed', { jobId, capabilityId, status: 'SUCCEEDED' });
await durableWebhookOutbox.enqueue(userId, event);
const dispatcher = new WebhookDispatcher({ repository: webhookRepository,
  readSecret: ref => encryptedSecretStore.decrypt(ref) });
await dispatcher.dispatchDue(); // Durable scheduler repeats when work is due.

// Consumer: rawBody must be bytes captured before any JSON parsing/reformatting.
const received = verifyWebhook({ secret, rawBody,
  timestamp: headers['kivro-timestamp'], signature: headers['kivro-signature'],
  eventId: headers['kivro-event-id'] });
await processEventOnceInTransaction(received.id, received);
```

`WebhookRepository.claimDue({now,limit,leaseMs})` atomically claims due deliveries,
including expired leases. `getEndpoint(id)` reloads current ownership, enabled
state, subscriptions and encrypted-secret reference. `finish(...)` compares the
lease token, advances attempt count once, persists status/next attempt/safe HTTP
status/failure code, and applies endpoint disablement. Never persist remote
response bodies. Default retries are 1m, 5m, 30m, 2h, 8h, 24h; exhausted/SSRF/410
endpoints are disabled. Every attempt resolves and pins DNS again. Redirects are
denied for signed requests, so neither bodies nor signatures are forwarded.

Signature format: `v1=<hex HMAC-SHA256(secret, timestamp + '.' + rawBody)>`;
timestamp is Unix seconds. Default verification skew is 300 seconds. Delivery is
at least once; immutable event-ID deduplication is the receiver's responsibility.
Equivalent Python verification, before parsing JSON and durable ID deduplication:

```python
import hashlib, hmac, time
assert abs(int(timestamp) - int(time.time())) <= 300
expected = 'v1=' + hmac.new(secret.encode(), timestamp.encode() + b'.' + raw_body,
                          hashlib.sha256).hexdigest()
assert hmac.compare_digest(expected, signature)
```

API routing still enforces TLS, key/account rate limits, revoked/suspended user
state and endpoint authorization. `authenticateApiKey` checks hash, expiry,
revocation and explicit buyer scopes, then persists last use. Buyer API keys do
not carry Worker identity or seller execution permissions.

## R16 reviewed public research

Library implemented and tested; Worker integration remains Laplace-owned. No
Worker, sandbox plugin, shared contract or permission-manifest file was edited.
The existing `ResearchBroker.search/fetch` and connector data-flow checks still
reject private/unknown/secret contexts by default. A resource-bearing job is not
relabeled PUBLIC. `semanticType:PUBLIC`, a domain allowlist, or a model's claim
that a new query is public is not sufficient to use the new path.

New exports are `ReviewedPublicResearchPlanSchema`, `publicResearchPlanHash`,
`compilePublicResearchPlan`, `CompiledPublicResearchPlan`,
`PublicResearchReferenceSchema`, `narrowResearchPolicy`, `ResearchLimitsSchema`,
`reserveResearchUsage`, `ResearchUsageSchema` and `prefetchPublicResearchTools`.
The plan contains:

```ts
{
  schemaVersion: 1,
  capabilityVersionId,
  dependencyBindingHash,
  limits: { maxQueries, maxPages, maxResponseBytes, maxTotalBytes, maxDurationMs,
    searchEnabled, fetchEnabled, allowedDomains, allowedContentTypes },
  sources: [{
    id: 'company_search', operation: 'SEARCH',
    provenance: { kind: 'REVIEWED_PUBLIC_LITERAL', sourceUrl: 'https://example.com/company',
      reviewedBy: sellerId, reviewedAt: reviewedAtIso },
    request: { query: 'Acme public annual report', maxResults: 2 }
  }, {
    id: 'company_page', operation: 'FETCH',
    provenance: { kind: 'REVIEWED_PUBLIC_LITERAL', sourceUrl: 'https://example.com/company',
      reviewedBy: sellerId, reviewedAt: reviewedAtIso },
    request: { url: 'https://example.com/company', method: 'GET' }
  }]
}
```

Every limits field is optional; omitted fields retain the platform cap. Source
IDs are distinct, bounded ASCII identifiers; at most 30 sources. Only exact
reviewed search arguments or HTTPS GET/HEAD URLs are allowed, no templates or
runtime substitution. Provenance is an explicit trusted review attestation,
not an automatic determination that arbitrary text is public. The host must
review the exact literals and save their normalized plan hash in immutable
local consent, separately from untrusted execution input. Plan hashes alone do
not prove approval. The seller/source registry, not a model or buyer prompt,
must supply the provenance and approved hashes.

Worker binding agreed with Laplace:

```ts
const publicResearch = compilePublicResearchPlan({
  plan: approvedLocalPlan,
  scope: { userId, jobId, attemptId, capabilityVersionId },
  approvedPlanHash: storedConsent.planHash,
  approvedDependencyBindingHash: verifiedDependencyBindingHash,
  expiresAt: activeAttemptDeadline,
});
// In authorize(context), after current job/attempt/dependency consent checks:
return { policy: livePlatformPolicy, dataClasses: ['BUYER_PRIVATE', 'SELLER_PRIVATE'], publicResearch };
// Before starting inference or exposing any private resources/files:
const cachedResearch = await prefetchPublicResearchTools({
  broker, context, plan: publicResearch, assertActive,
});
// Private model/plugin gets ONLY these cache lookups, never outbound methods:
await cachedResearch.searchPublic({ reviewedSourceId: 'company_search' });
await cachedResearch.fetchPublic({ reviewedSourceId: 'company_page' });
```

`dependencyBindingHash` must cover the locally verified canonical dependency
source/contentHash/dependsOn/grants snapshot and match the previously approved
snapshot; do not recompute a model-supplied plan's hash and use it as approval.
The compiler checks the approved plan hash, dependency hash, capability version,
review timestamp and expiry (maximum 24 hours). The token owns a normalized copy,
exposes `planHash`, `dependencyBindingHash`, scope, expiry and search/fetch source
IDs, and is frozen and registered in a private WeakMap. Serialized/lookalike tokens
are invalid. Reconstruct it only from trusted local approval when restarting.
The host must recheck active attempt, revocation and dependency consent per call;
tokens are not durable bearer credentials. `ResearchContext.attemptId` is required
for this path and must come from authenticated execution, not the tool body.

`searchPublic/fetchPublic` resolve the exact reviewed request inside the broker,
retain all private labels, intersect reviewed limits with the current grant,
and use the existing pinned DNS/peer/redirect-checked transport and accounting.
Unknown source, wrong operation, extra query/URL/header/body/proof fields, missing
or foreign binding and expired/revoked authority fail before egress. Fetch source
proof does not bypass private-address checks. Result shapes are unchanged;
successful accounting records add `publicPlanHash` and `publicSourceId` beside
existing host/status/bytes/query-hash provenance. No raw query or private contents
are added to denial logs. `bindJobResearchTools` and the signed-handler adapter
also expose `searchPublic/fetchPublic`; the old inference bridge still blocks
private free-form research and was not silently taught to trust labels.

Seller ceilings: `narrowResearchPolicy(platformPolicy, reviewedLimits)` takes
numeric minima and intersects tool flags, content types and exact domains; it
cannot enable network mode, connectors or disabled operations. Transport limits
now reach both SafeHttpClient and Brave before reading bytes. Custom search
providers must honor the optional second `{maxResponseBytes,timeoutMs}` argument.
Zero search/page budgets deny immediately. For cumulative enforcement, call
`reserveResearchUsage(prior,{operation,maxBytes,nowMs},effectivePolicy)` and save
the returned state atomically under the durable JOB key, never reset per attempt.
It enforces independent query/page, reserved-byte and elapsed-time ceilings;
uncertain/failed requests keep their reservation. The host still owns cluster
rate/concurrency limits, durable transactions and active-job cancellation.

Security boundary and honest remaining gap: these are finite reviewed public
requests, not arbitrary mixed-context research or automatic declassification of
DB-derived facts. Direct `broker.searchPublic/fetchPublic` calls still allow
request choice/timing as a side channel. Mixed jobs must instead use
`prefetchPublicResearchTools`: it runs every reviewed search then every reviewed
fetch in fixed order, before model/private access, and returns cache-only strict
ID lookups. The cached callbacks check active execution, return fresh copies and
cannot generate network traffic regardless of later private content or model
choices. Partial prefetch failure returns no cache and retains consumed budget.
Do not expose the outbound broker methods to the private runtime or rerun
prefetch in response to a private model request. This library does not claim
to prove arbitrary LLM-generated queries safe. Worker
review/storage, plugin ID-only schemas, job-keyed counters, full telemetry,
coordinated image rebuild and actual DB+public-research runtime acceptance remain
unimplemented/unverified here. R16 stays IN_PROGRESS until those bindings pass.

Verification: `test/public-requests.test.ts` has 27 passing cases for mixed private
labels with exact public requests, forged/serialized tokens, all four scope
bindings, request substitutions, immutable hash/consent/dependency snapshots,
expiry/revocation, duplicate sources, private DNS, signed-handler identity,
seller limits, fixed prefetch/cache-only private access and real Brave-adapter
byte/time forwarding. All 105 research
package tests and its `tsc --noEmit` pass. Fixture transports and a private-address
resolver are used; no live research keys or requests were used.

## Provider references checked

Official API documentation was fetched on 2026-10-06. Model/rate configuration
and default selection are now parent-owned. Adapters make real HTTPS API requests,
not production fixture responses.

- OpenAI Responses and native structured outputs:
  https://developers.openai.com/api/docs/guides/structured-outputs
- OpenAI function call/result translation:
  https://developers.openai.com/api/docs/guides/function-calling
- Anthropic Messages authentication/version headers:
  https://platform.claude.com/docs/en/api/overview
- Anthropic tool-use/result translation:
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- Anthropic native `output_config.format` (not deprecated `output_format`):
  https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Brave search query/count/header and result shape:
  https://api-dashboard.search.brave.com/app/documentation/web-search/codes

The raw provider schema boundary was also checked: unsupported grammar bounds
are removed only from the provider's schema and retained as descriptive hints;
the router validates against the original bounded schema before acceptance.
Anthropic numeric/length/array restrictions and OpenAI length/uniqueness
restrictions motivated this adaptation. Parent now owns this helper and provider
wire regressions. No live provider credentials were used to validate model support.

## Verification and limits

Latest follow-up, 2026-10-06: 249 tests pass across 12 files, including the 27 R16
security cases and four synthesis route-binding tests. Scoped ESLint and research,
Marketplace and API `tsc --noEmit` checks pass. The earlier concurrent
billing/Prisma generation errors resolved on the final rerun. The coverage
report now contains 159 exact IDs and merges read-only with
`applied:false`. No live provider credentials, DB-backed route acceptance or
mixed-job Worker acceptance is claimed.

Prior bounded batch, 2026-10-06: 218 tests passed across 10 files, including
132 Marketplace tests (26 synthesis and 30 repair); all three package
`tsc --noEmit` checks and scoped ESLint passed. Provider tests were included in
this read-only verification, but their source is now parent-owned. The then-155-entry
coverage report passes `node --import tsx scripts/coverage-merge.ts` with
`applied:false`; parent task-completion/coverage files were not modified.

Prior verification on 2026-10-06: 185 focused tests passed across 9 files; all three
package `tsc --noEmit` checks and scoped ESLint passed. The unsupported Node
`RequestOptions.autoSelectFamily` property is removed; DNS pinning still uses an
explicit address family, pinned lookup callback and remote-peer validation.

Tests live only under the three owned packages' `test/` directories. They cover
provider request/response fixtures, schema failures/retries/budgets, no purchase on
inference failure, conversation ownership, approval tampering, DAG and A13 file
compatibility, DNS pinning/rebinding/redirects/private IPv4 and IPv6, byte/type
limits, private-data denial, typed connectors, real-runtime bridge protocol,
hashed scoped keys, signature tampering/replay freshness and durable webhook retry
contracts. Fixtures and memory repositories exist only in tests.

`packages/marketplace-agent/test/execution-security.test.ts` adds focused checks
for a full three-job branched DAG at the exact approved 297-minor-unit budget,
total/per-job/job-count rejection before quoting, unchanged approval across
ticks, price/version/permission drift, frozen contract tampering, frozen output
validation after catalog replacement, concurrent initial CAS, committed-job
recovery, and named asset MIME/extension/size/cardinality/requiredness failures.
Final revision-binding regression: each DAG purchase receives the post-save
persisted revision (2, 3, 6 in the three-job fixture). A concurrent CAS before
the modeled reservation check propagates PLAN_CONFLICT without a job or key;
a later explicit tick uses revision 3 and creates exactly one job. The latest
Marketplace-only revision-binding run passed 99 tests plus its tsc --noEmit and scoped ESLint.
The unit executor is not evidence that actual payment/DB transactions are atomic.

`packages/marketplace-agent/test/repair.test.ts` covers full paid-chain repair
and fresh approval, frozen paid output/files, refreshed pending quotes, spent budget,
permissions/rating/version/I/O rejection, terminal failed-attempt retention,
new retry IDs, active/unrecorded jobs, missing quiescent callback, a commit racing
repair CAS, concurrent repairs, repair limits, changed output and audit tampering,
bounded alternative search and strict route bodies, plus explicit canQueue bounds.
These are unit callback/security tests, not real PostgreSQL repair-race tests.
The current batch strengthens two-step replacement after an upstream purchase:
one CAS retains the paid result/hash and 99 spent + 198 remaining, refuses any
execution before fresh approval, then completes with exactly three jobs and 297
lifetime spend. An invalid second replacement leaves the entire old plan intact.
The completed-file regression preserves asset IDs/filenames/MIME/size/hashes and
named field references in the saved CAS plan; no transfer grant or purchase occurs
until a new approval, and the completed source job is never rerun or recharged.

`packages/marketplace-agent/test/synthesis.test.ts` covers literal consent,
selected-source-only processing, frozen contracts/versions, safe file metadata,
stale source/revision/provider disclosures, concurrent completion changes,
foreign owners/conversations, forged/duplicate/unselected citations, artifact
field rejection, UTF-8 context limits, spend denial, explicit unavailability,
fallback disclosure and typed/legacy summary history privacy. These are fixture
and repository-callback checks; live summary quality and API/UI acceptance are
not claimed. Agent tests cover strict body fields, model non-escalation of limits,
future options without scheduling, and explicit queue bounds.

`docs/coverage-agent.json` records exact requirement IDs with scoped evidence.
Section-wide integration or code gaps remain IN_PROGRESS even when focused
library tests pass. It does not alter the parent's task-completion record.
The read-only merge validation (`node --import tsx scripts/coverage-merge.ts`)
passed with `applied: false`; no root coverage table or task status was changed.

```sh
pnpm exec vitest run --no-cache packages/marketplace-agent/test packages/research-broker/test packages/integrations/test
pnpm --filter @kivro/marketplace-agent typecheck
pnpm --filter @kivro/research-broker typecheck
pnpm --filter @kivro/integrations typecheck
pnpm exec eslint packages/marketplace-agent packages/research-broker packages/integrations
```

No live OpenAI/Anthropic/Brave credentials were used or charged. Live provider
contract tests, real HTTPS network integration, DB concurrency/crash recovery,
the approved paid multi-job PDF scenario, and the Docker/OpenClaw runtime with
research/private resources have not been verified by this agent. A14 therefore
remains an integration/acceptance item even though concrete executable hooks and
the Worker's in-progress `JobToolBroker` now exist.

Streaming is explicitly optional for MVP (Master sections 64 and 164); delegated
budget purchasing is later/advanced under section 140. Their absence is not an
MVP blocker. Recommend-only and approve-plan modes are implemented; background
provider substitution without fresh approval is intentionally forbidden. Bounded
repair preserves the original DAG topology and budget; it does not invent
conversion steps or increase spending authority. Aggregate text mappings lack
static length guarantees for future output (known completed values are checked
during repair); binary
research/PDF downloads and arbitrary database/resource implementations are absent.
The bridge accepts approved typed resource callbacks; their implementations and
permission grants belong to the Worker/Resource Broker owner.

Actual remaining package/product gaps after this bounded batch: per-recommendation
structured rationale/tradeoffs (section 135) and explicit preferred-capability /
discovery-online-only controls (section 134) are not fully exposed. Natural-language
blocked-seller/preference resolution is not implemented. Text mapping static
guarantees and live model behavior remain as noted above. These are not claims
that API binding alone makes all agent requirements complete.

Additional explicit limits: provider streaming is not implemented; provider
health checks prove API reachability/authentication, not configured-model feature
support. Binary/PDF downloads, browser rendering, robots-policy automation, and
arbitrary external side effects are not offered. HTML becomes untrusted readable
text, not a claim that prompt injection is removed. Render returned text as text,
never raw HTML. Cluster-wide rate/concurrency limits require the supplied durable
accounting implementations; callback transaction guarantees are integration
requirements, not proven by a mocked unit test.
