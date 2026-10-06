# Local orchestration acceptance fixture

Owner: agent-service agent. Script: `scripts/e2e-orchestration-fixture.ts`.
Requirement mapping: R07, Master Spec section 160, `PRD-0152`, `PRD-0153`,
`PRD-0154`. This is supplemental deterministic local evidence, not completion of
the required real-provider, Stripe test-mode staging acceptance.

## Run

```sh
node --import tsx scripts/e2e-orchestration-fixture.ts --run
```

With no arguments, the script prints usage and has no infrastructure side
effects. The only execution modes are `--run` and the explicitly requested
stopped-run recovery command below. Root package commands are intentionally not
edited. A parent-owned alias may point directly to the run command.

Prerequisites are the existing migrated/seeded local PostgreSQL, Redis and S3
services from `infrastructure/compose.yaml`, a running Docker daemon, an already
built `kivro-sandbox:2026.8.2` image, the supported host OpenClaw runtime, Node and
the installed workspace dependencies. Poppler's `pdfinfo`, `pdftotext` and
`pdftoppm` must be on PATH. The fixture installs nothing, builds no images, starts
no frontend/dev server, and reads no `.env` or personal credentials. Only the
documented synthetic local service credentials are passed to its API instance.

API and inference servers listen on independently allocated loopback ports.
Each invocation has unique accounts, capability names, Worker state directories,
trace identifiers and idempotency keys. Do not run another approved-plan fixture
or a background plan reconciler against the same database concurrently. The
production `tickPlans()` callback is not scoped by plan: this script checks for
foreign APPROVED/RUNNING plans before every tick and refuses to proceed when it
finds one. This precondition is not a cross-process lock. Normal cloud background
reconciliation is disabled, not substituted or claimed tested.
This applies only to the fixture's own API instance: the guard cannot detect a
different API process reconciling this same fixture plan. Before a controlled
shared-schema run, obtain explicit parent confirmation that the dev API/background
reconciler is stopped. Otherwise use a separately migrated schema. Do not stop
the parent dev API or browser suite without its handoff.

## Actual execution

1. Register one buyer and two distinct sellers through the real API. Pair two
   signed Workers, approve the existing image, and perform live local inference
   and sandbox proofs using temporary secret stores.
2. Create three synthetic company research capabilities and one PDF capability
   through seller routes. All four cost 99 cents and allow only read/write, with
   no general network or private resources. Validate every immutable capability
   version in real Docker/OpenClaw before publication.
3. Run four paid warm-up jobs and submit genuine eligible API reviews. These
   supply the otherwise-missing 4.5 minimum-rating evidence without inserting
   ratings, jobs, outputs or ledger rows directly into the database. Reviews
   explicitly identify synthetic test data, not real provider quality.
4. POST `/api/agent/chat` with PLAN mode, a $15 maximum, 4.5 minimum rating,
   99-cent per-job maximum, four-job limit and explicit no-scheduling policy.
   The local planner consumes the actual catalog candidates and returns their
   real capability/version IDs. It proposes three independent upstream steps
   and a PDF step whose three named FILE inputs reference their `document`
   output fields.
5. Verify current quotes, the four-step DAG and $3.96 cost, then prove a draft
   reconciliation creates no jobs or charges. Approve via the authenticated plan
   API using the exact revision. A stale repeated approval must fail.
6. Execute using the real API reconciler, signed Worker protocol, DB accounting,
   Docker/OpenClaw, S3 uploads and scoped downstream input grants. Assert the PDF
   job is created only after all three predecessors complete, and its exact
   asset IDs equal their named outputs, backed by exactly three unexpired,
   target-job-scoped asset grants. Poll only the plan while running, then fetch
   terminal jobs, to respect the real API rate limit.
7. Require actual `read` tool replies containing each upstream file's unique
   marker before the PDF provider returns a `write` tool call. The initial PDF
   prompt must not already contain those markers. Download the PDF through the
   buyer API and S3; compare bytes/hash/size, parse it with Poppler, verify all
   three source markers in extracted text, and render its one page as PNG.
8. Preview synthesis without inference. Reject false consent. Submit explicit
   revision/hash/source-bound consent, check all four job/version/output hashes
   and persist the synthesis in the actual conversation repository. Synthesis
   receives text and file metadata only, never PDF file contents.
9. Replay each real Worker result through the signed endpoint. Require exactly
   one attempt, capture, seller earning and platform fee per plan job, with one
   balanced settlement transaction. Repeated reconciliation cannot add jobs.
   Buyer and both seller wallet deltas must match the itemized four-job prices.
   Submit one eligible review per purchased plan job and reject duplicates.

## Explicit substitutions

Only inference is deterministic. Seller inference uses a real loopback HTTP
Chat Completions fixture via the existing supported OpenAI-compatible Worker
configuration. No external model or live research is used.

The platform API has no configurable loopback provider URL. Inside this script
only, `OpenAIPlatformProvider.prototype.generate` delegates to the original
implementation with a fixture-owned HTTP transport. That transport accepts only
the exact OpenAI Responses request destination and forwards it to the loopback
fixture server. The real provider encoder/parser, structured-output validation,
router, API accounting, agent, catalog search and persisted plan path remain in
use. The original prototype is restored during cleanup. No production source is
changed, and this is not evidence of OpenAI API compatibility or model quality.

The fixture model emits a small valid PDF through OpenClaw's actual write tool.
Its three company facts are synthetic. Poppler parsing, extracted source text,
rendering and the file delivery chain are checked; graphic-design quality and a
real PDF-generating model are not claimed.

Payment mode is explicitly fake, malware scanning is development-only, and no
browser/UI acceptance is performed. The $15 authorization is a ceiling, not an
upfront $15 debit: the fixture expects $3.96 spent and zero remaining wallet
reservations. The unused $11.04 authorization was never charged. Four warm-ups
cost a separate $3.96 and are identified separately in evidence.

## Cleanup and evidence

On success or failure, pause only fixture capabilities, cancel its unfinished
jobs, stop its runtimes, pause and revoke its Worker devices, log out its
sessions, close the temporary servers, remove temporary Worker state and restore
modified process environment variables. Cleanup respects a bounded Retry-After
delay and reconciles the stopped fixture plan without creating new purchases.
Cleanup failures make the run fail.
Synthetic user accounts, capability versions, jobs, plans, reviews, output
artifacts, audit records and financial history remain in the existing DB/S3
retention lifecycle. Never truncate or delete another fixture's records, refund
successful jobs just to remove evidence, or claim deletion of financial history.

For a stopped invocation whose final output reports an incomplete logout/plan
cleanup, use its exact `fixtureId`:

```sh
node --import tsx scripts/e2e-orchestration-fixture.ts --cleanup <fixtureId>
```

Recovery accepts only UUID-keyed synthetic accounts with this script's exact
email namespace. It refuses to proceed unless all their Workers are already
paused/revoked, capabilities paused, jobs terminal and buyer reservations zero.
It also refuses reconciliation if another buyer has an active plan. It uses the
real reconciler to finish the stopped plan, then expires only those synthetic
sessions in the DB. It cannot create approval, clear reservations, edit output,
settle/refund money or delete financial records. `cleanupOnly:true` is not a
passing orchestration run.

Successful stdout ends with one `DETERMINISTIC_LOCAL_ORCHESTRATION_FIXTURE` JSON
record containing `passed:true`, identities, immutable versions, plan/attempt/job
IDs, explicit approval, cost breakdown, four settlement proofs, PDF hash,
synthesis provenance, review IDs and cleanup outcome. An error emits the failing
phase, bounded error code and stack locations, without raw inference requests,
credential values, prompts or signed S3 URLs. `passed:false` is not acceptance.

## Verification checkpoint

**Controlled local rerun: PASS, 2026-10-06.** Full receipt and the independent
read-only cleanup audit are preserved in
`docs/E2E-ORCHESTRATION-CONTROLLED-RECEIPT.json`.
This is the NEW run after the parent's 12:18 Europe/Zurich authorization, not
historical fixture `7cf029b6-7dc9-4d9c-9377-03f07700ceee`. Its receipt timestamp is
12:23:46 CEST (`2026-10-06T10:23:46.833Z`); the command exited 0 after cleanup.

Parent explicitly stopped its main API/background reconciler and reconfirmed it
stayed off during execution. Port 4000 had no listener before or after this run.
The fixture used its own ephemeral API with background processing disabled and
explicit calls to the production plan reconciler. This is coordinated process
isolation on the public schema, not a separate schema or automatic global lock.
The fresh process loaded current API/Prisma code. A separate migration metadata
query verified all 19 migrations, including pending objects (017) and execution
containment (018). No image rebuild or paid provider credentials were used.

| Controlled receipt | Value |
| --- | --- |
| Fixture | `c4db5210-131e-44f5-af79-f7a6124b7bf8` |
| Receipt timestamp | `2026-10-06T10:23:46.833Z` / 6 October 2026, 12:23:46 CEST |
| Plan | `1db8ca51-19cd-440f-a641-ae6bfb020c61` |
| Conversation | `a14e69f7-b319-4f13-a372-f7da70335c0b` |
| Buyer | `0c763d32-03b4-438b-a2f1-75628a7d91a3` |
| Sellers | `3adc879e-a056-4bad-8eb3-d07c8364922d`, `ba361080-fc96-428b-a492-ff01a1d7362c` |
| Research jobs | `495894ad-f12e-46ec-8bc0-f2c8369a5451`, `7214db30-a295-48a8-bd52-d6ce26d8264a`, `9f2a9883-1196-42aa-88bf-642d0fa7d7c2` |
| PDF job | `5a7ab8ce-8241-4c95-94da-40826ee7b3d9` |
| PDF asset | `657d0a79-199c-4447-b23b-bbb2dcf880e3` |
| PDF SHA-256 | `e7dcadb99f19755579c632f0f6f72b23d181c2577b31b216800c83d92d096eab` |
| Synthesis | `70bbea62-45ba-4d83-9fd6-6d603823400e` |
| Image | `sha256:96dd4f5334bf57fea81af17192864ae57e0f520aa492afb8591ad7fd7077ae52` |
| Result | Exit 0, `passed:true`, all fixture cleanup assertions passed |

The four-job approved DAG cost 396 cents against a 1500-cent ceiling, with zero
reserved funds after completion. Three actual upstream reads and exactly three
downstream file grants led to the PDF; Poppler parsed/rendered the downloaded
1007-byte file and recovered each source marker. Explicitly consented synthesis
persisted four job/version/output-hash provenance records. Signed result replay
left exactly one balanced capture/earning/fee transaction per job; repeated
reconciliation created no additional jobs. All four plan-job reviews succeeded
and duplicate reviews were rejected. The four separate paid warm-ups established
the rating floor through real review routes, for eight total successful jobs.

After process exit, a read-only audit of these exact identities found:

- Zero residual fixture Docker containers, zero synthetic sessions and zero
  wallet reservations.
- Both Workers paused/revoked/not ready and all four capabilities paused.
- Eight successful settled jobs and eight committed asset-publication journal
  records, with zero uncommitted undeleted publication records.

Temporary servers and Worker state are removed. Financial/job/review/artifact
history is preserved. The parent can coordinate image rebuild and its next
browser fixture; this fixture did not restart the main API. Tools typecheck
passed against the current source during this run.

## Historical uncontrolled receipt

**Not controlled acceptance evidence.** Parent subsequently confirmed
that its main dev API background plan reconciler ran against the public schema
throughout the historical run below. The fixture's `background:false` setting
does not control that other process. Therefore the historical `passed:true`
receipt is an observation of passing assertions in a shared environment, not
proof that only the fixture's explicit ticks drove execution. Do not cite it as
controlled R07 acceptance. The coordinated current-schema run above supersedes
it for that purpose. This historical receipt predates the executionRevokedAt and
stage-journal changes; its original evidence remains preserved.

The last static checkpoint passed `pnpm exec tsc -p tsconfig.tools.json --noEmit`
and scoped ESLint. The no-argument usage command was executed. The historical
runtime command exited 0 with `passed:true` on 2026-10-06; its unmodified IDs and
observed assertions are retained below, with the isolation limitation above:

| Evidence | Value |
| --- | --- |
| Fixture | `7cf029b6-7dc9-4d9c-9377-03f07700ceee` |
| Plan | `88f433de-7cca-497d-ae78-31a9c640bd0b` |
| Conversation | `01e2466c-abcc-4b54-8c5a-b5881434dd7d` |
| Buyer | `beebcb37-670f-4a6b-aea4-a5ed46c35d4c` |
| Sellers | `56635382-1afc-4cc7-93aa-5e78e97f2c1a`, `60c78e3a-d8e0-4236-9efc-22a79cafa86e` |
| Approval hash | `a9f851db492b72046c1566f914f6a1b5ded94dd45af03bc1710ba40987235d05` |
| Research jobs | `cd719f70-7993-42a1-a88e-5019c1559738`, `f481f6e8-778d-4c05-b8f4-7f10dba58fb4`, `d907c7a3-ce18-4ab4-bc97-26711746dea7` |
| PDF job | `0f9aa03a-eabc-468b-bc61-edf1f339e9e8` |
| PDF asset | `c1ba1303-7eb0-4544-95a3-abf4437ae389` |
| PDF SHA-256 | `93ed8c240149f3d257bf3a6bf9e51b39389b28be0f482c9c081a7ae4d0eb454e` |
| PDF bytes | 1007; one page parsed, text checked, PNG rendered by Poppler |
| Synthesis | `8fab9b6a-fcc5-40f7-ade5-5fe98e4c4c13`; four bound provenance records persisted |
| Image | `sha256:96dd4f5334bf57fea81af17192864ae57e0f520aa492afb8591ad7fd7077ae52` |
| Price breakdown | Four times 99 cents: 80 cents seller net, 19 cents platform fee per job |
| Plan wallet result | 396 cents spent; zero reserved; no extra purchase on replay/reconciliation |
| Ratings/reviews | Four eligible warm-up reviews established rating 5; four plan-job reviews accepted; duplicates denied |
| Inference | 50 loopback calls in total, including three platform calls; no external-provider calls |
| Cleanup | Both Workers paused/revoked, four capabilities paused, sessions expired, temporary state removed |

Each plan job had exactly one real successful attempt, one capture, one seller
earning and one platform fee in a single balanced settlement transaction, after
replaying its result through the signed endpoint. Exactly eight buyer jobs
existed: four warm-ups and four approved-plan jobs. The three PDF input asset
IDs matched the upstream named outputs and exactly three live target-job grants.
False synthesis consent made no inference call; explicit consent preserved all
four output/version hashes. Anonymous/seller PDF downloads were rejected.

Initial development runs caught fixture-only invalid zero accounting rates,
an incorrect health-response token count and excessive polling. These were
fixed in this script without weakening production checks. The rate-limited run
`9c79b45e-4bf3-4aa3-9ba3-f94ce1b1b5ef` required stopped-run cleanup; the documented
`--cleanup` command exited 0 and verified no remaining active jobs/reservations,
then expired its sessions. Its paid history remains preserved. The historical
exit-0 run required no cleanup recovery. Its runtime assertions exposed no
production failure, but its concurrent reconciliation still prevents treating
that historical receipt as a controlled result. Use the new controlled receipt.

External-provider/Stripe staging acceptance, production malware scanning,
browser presentation and background scheduling/restart/failure matrices remain
outside this fixture's acceptance claims. The separate private-DB/public-research
scenario belongs to the Worker's R16 evidence. Local deterministic PASS does not
close `PRD-0152`/`PRD-0153`/`PRD-0154` in full.
