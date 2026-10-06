# Catalog, Availability and Agent Trace

Reviewed 2026-10-06, Europe/Zurich. This is a bounded source/test trace, not
release certification and not new implementation ownership. The companion
`coverage-catalog-review.json` contains exact requirement IDs and per-row
implementation, named-test and remaining-boundary evidence. Parent owns merging
the main coverage table.

## Scope and Attribution

The original queue was 48 CAP, 50 AVL and 23 AGT TODO rows. Four exact rows,
CAP-0067 through CAP-0070, are already attributed by `coverage-web.json` and
are intentionally omitted here. The resulting 117 rows are:

| Family | Rows | IMPLEMENTED | IN_PROGRESS | TESTED |
| --- | ---: | ---: | ---: | ---: |
| CAP | 44 | 19 | 12 | 13 |
| AVL | 50 | 30 | 8 | 12 |
| AGT | 23 | 7 | 9 | 7 |
| Total | 117 | 56 | 29 | 32 |

`TESTED` is restricted to atomic behavior covered by the cited named tests.
No SECTION_COVERAGE aggregate is marked TESTED. `IMPLEMENTED` means source
implements the scoped behavior; notes identify where the exact acceptance
scenario was not run. `IN_PROGRESS` identifies an actual partial implementation
or a broader acceptance boundary. Test names without a receipt below are
source-attributed evidence, not newly executed tests.

Read the full literal Master sections, not only truncated requirement sentences:
23, 26, 32, 42, 54, 74, 97-101, 104-105, 108-109, 111, 114, 117-118, 156,
219, 247, 272, 301, 337, 340, 347, 350-351, 355, 362, 371, 398, 404-406,
413, 415, 418, 424, 451-452, 463, 469, 474-475, 477-478, 480, 488, 492,
495-496, 502-504 and 509. Also read full229 for the parent's additional
PRD-0197 question. Matched each original ID to `spec/REQUIREMENTS.md` and checked
all current coverage sidecars for existing attribution.

PRD-0197 is now attributed by the parent's `coverage-product-review.json`.
Its confirmed finding is documented below but deliberately not duplicated in
this JSON sidecar. Do not rerun coverage-merge from this review.

## Confirmed Source Gaps

1. **First-publication explanation and acknowledgement,97/111.** Explicit
   permission/hash approval exists, but the integrated first-use flow does not
   present and separately acknowledge the complete local-execution model,
   restricted OpenClaw, seller inference cost and personal-session/workspace
   exclusions. AGT-0001/0002, CAP-0038/0039.
2. **Supported local-inference discovery and ongoing health,100/109.** Discovery
   exposes primary model metadata, not a normalized supported local service,
   endpoint, availability and known hardware record. `inferenceReady` trusts a
   configured-secret/hash proof for24h; periodic readiness does not make a fresh
   local service inference probe. A stopped service can remain advertised until
   a request fails. AGT-0016 through0019, AGT-0029/0032, CAP-0042. Heartbeat loss
   is already handled and is a different failure mode.
3. **Publishing economics,101.** Price, fee, seller proceeds and separate-cost
   disclosure exist, as do measured/unknown post-job usage and spend ceilings.
   Prepublication remote/local inference-cost and margin estimates are missing.
   AGT-0021; related complete import-flow CAP-0038.
4. **Dependency uncertainty,105.** DECLARED/DETECTED/INFERRED describes provenance,
   not the requested CONFIRMED/LIKELY/POSSIBLE/UNKNOWN confidence distinction.
   Actual observed-vs-loaded evidence is honest, but not the full confidence UI.
   CAP-0022/0023.
5. **Integrated import flow,111.** CLI read-only discovery, approval, isolated test
   and observed-report review are real. Web imports already-authored JSON rather
   than connecting personal workflow selection, observed-vs-declared review,
   dedicated resource setup and economics into the full proposed flow.
   CAP-0038; this does not mean those underlying services are absent.
6. **Platform file-limit configuration,219.** API upload limit is configurable;
   absolute contract byte maxima and supported Worker file ceiling remain
   separate constants. Effective safety ceilings are enforced, but the requested
   centralized configuration boundary is incomplete. CAP-0060/0062. Raising only
   the schema would not safely close this gap.
7. **Nonblocking update recommendation,371.** Installed, supported and minimum
   Worker/OpenClaw versions are now supplied and rendered, and insecure versions
   are blocked. A behind-supported-but-still-permitted update recommendation is
   not calculated/displayed. CAP-0111, distinct from tested security CAP-0112.
8. **Effective seller schedule preview,418.** Weekly recurrence/timezone and
   overnight labels exist. Current effective status, next dated start/end, and
   next seven dated days with exceptions are not wired to the editor despite
   the policy helper. AVL-0049/0050.
9. **Offline-at-window explanation,469.** Backend waiting is finite and does not
   immediately fail a reservation just because no Worker is available. Buyer
   view only says generic waiting for provider availability; it does not expose
   an offline-at-window reason or the reservation's wait deadline. AVL-0066.
10. **Human status language,492.** Cards/checkout have human labels. Agent saved
    recommendation `timing.label` inserts raw `availability.status`, and the
    rationale component renders it verbatim, including SCHEDULED_OFFLINE.
    AVL-0077/0078. This is presentation, not an availability-authority bypass.
11. **Preview-to-local test bridge,229 / PR-A02.** `previewInput` is component
    state, preview uploads are disabled, and no export/command handoff connects
    it to `capability test VERSION_ID --file INPUT`. The existing local seller
    test is real. A static form preview plus a separate CLI test is not an
    executable preview. Exact PRD-0197 attribution remains with PRODUCT-REVIEW.

Additional provenance/package boundaries: approved image/version/hash replay is
implemented. Master32 requires recorded versions/hashes, not bit-reproducible
apt/npm rebuilds; this review requests no build-lock expansion. Validation proof
is refreshed on WorkerBinding and recorded in validation audits, but publication
does not freeze a complete per-version runtime attestation for lifetime retrieval
(CAP-0002/0003). Parent owns any durable execution-provenance follow-up. The full
inspectable portable capability bundle, including pricing/runtime and tests,
remains partial (CAP-0047). Master114 filenames are illustrative, not required
literal paths. Full54 manifest/hash/versioning is classified IMPLEMENTED.

## Acceptance Boundaries

- The fifteen-clause355 and twenty-clause424 aggregates remain IN_PROGRESS.
  Exact two-capability dependency-failure isolation, a full physical laptop
  loss/reconnect matrix, a dedicated PAUSED paid-purchase rejection, NOW outside
  schedule with zero financial side effects, prompt schedule-tampering, and
  running-job-survives-window-close are not all established by the cited tests.
  Missing exact tests are not automatically claims of broken production code.
- Shared-device capacity, due-reservation FIFO and per-window reservation limits
  now have source implementations and targeted tests. Do not repeat older gap
  reports that predate these changes. Seller capacity settings are already
  persisted, owner/revision-bound and tested; no source changes made here.
- Full42 expressly makes a dedicated MCP server future scope. Later319-324 make
  REST mandatory; REST exists. Full413 permits capability schedules for MVP and
  makes Worker-default inheritance future convenience. Neither is a newly
  invented release blocker.
- Full451 supersedes earlier blanket SCHEDULED_OFFLINE no-purchase language:
  no NOW purchase, but separately approved bounded scheduled reservation is
  allowed. Full480 permits an immediate-only autonomous MVP while the underlying
  single-capability job model supports scheduling. Current agent dependency
  waiting uses PLANNED, and purchased steps stay RUNNING while executor reports
  PENDING; there is no invented WAITING/JOB_CREATED enum.
- Local deterministic inference/DAG tests prove contracts and admission policy,
  not OpenAI/Anthropic service quality, seller provider compatibility, production
  credentials, physical hardware or real Stripe acceptance. No paid-provider or
  live-seller data was used in this review.
- Laplace's SR06 research downloads are a separate changing implementation and
  candidate-image receipt. No review of that entire new path or modification of
  its production files is implied by the connector allowlist row.

## Verification Receipts

All timestamps below are 2026-10-06 Europe/Zurich, not UTC.

| Time | Command / Scope | Result |
| --- | --- | --- |
| 13:31, earlier trace | catalog integration / protocol / capacity integration | 19 / 20 / 32 passed; earlier source snapshot, not rerun for this document |
| 13:37:44, earlier trace | 18 focused unit files | 231 passed, one localhost-bind EPERM; not an all-pass suite |
| 13:38:02 | bounded loopback-authorized replay of Worker usage | 11/11 passed; earlier combined result232 distinct passing cases, not243 |
| 14:10:51 | `KIVRO_INTEGRATION=1 pnpm exec vitest run apps/api/test/protocol.integration.test.ts` | 20/20 passed,4.61s, actual local DB/Redis/S3 and signed synthetic Worker |
| 14:10:52 | `pnpm exec vitest run packages/marketplace-agent/test/response-agent.test.ts` | 18/18 passed |
| 14:16:21 | focused13-file trace replay below | 179/179 passed,0.733s |
| 14:16:35, parent-reported independent receipt | global response hook protocol / capacity integration | 20/20 and32/32 passed; not rerun or relabeled as this agent's run |
| 14:20 | `pnpm exec tsc --noEmit -p apps/api/tsconfig.json` | exit0 on current tree; earlier transient missing runtimeAvailability export resolved by concurrent owner |

The13-file replay included marketplace-agent orchestration25, agent11,
recommendations18, repair30, public-discovery18; policy-engine44; API
catalog.unit7 and scheduling5; Web dependencies7, schedules4, checkout2,
examples5 and worker-health3. These counts overlap earlier receipts and must
not be summed as unique total coverage. No browser, server, Docker run or image
rebuild was started for this trace.

## Repair Response Regression

The concurrent repair500 was invalid synthetic plan data, not a permissive
response-schema defect. The fixture spread a public quote into the internal
AgentQuote and retained the extra `priceSnapshot`. Strict response validation
correctly rejected that field, including when preserved inside repair history.

Only the narrow repair fixture in `apps/api/test/protocol.integration.test.ts`
was changed: explicitly project internal quote fields, validate the serialized
plan before persistence, and include response bodies in the concurrent assertion.
`packages/marketplace-agent/test/response-agent.test.ts` now specifically rejects
the leaked property on both current step quotes and prior repair audit quotes.
Production response schema and financial/repair code were unchanged.

The real protocol receipt now observes concurrent200/409, preserved completed
output/job ID,99 spent plus99 remaining, fresh revision6 approval and exactly
one downstream creation after polling beyond twenty waiting plans. Its cleanup
closes the app, retires/pauses only synthetic listings, revokes fixture identities
and retains financial/job history. No further protocol edits are owned here.

## Proposed PR-A02 Boundary

Proposal only, coordinated with Laplace; no implementation in this trace:

- New browser-safe strict `@kivro/contracts/seller-test` schema: discriminator,
  schemaVersion1, saved capabilityVersionId, manifestHash, input and inline assets
  `{id, filename, mimeType, sizeBytes, sha256, contentBase64}`. No local paths,
  URLs, permissions, instructions, credentials or model configuration.
- Bound to20 unique selected/referenced assets, current8MiB per-file ceiling and
  at most16MiB aggregate decoded input, further narrowed by approved capability
  limits. Bound metadata and encoded document size before allocation; canonical
  base64, byte length, checksum, MIME and exact frozen input validation.
- Seller explicitly downloads the bundle, then invokes the existing CLI test.
  Bundle version/hash must match CLI version and locally approved manifest before
  readiness or inference. Download itself cannot approve, run, publish, purchase
  or contact localhost. Existing seller inference cost and resource consent apply.
- Dedicated bounded regular-file/no-symlink reader for the test command; retain
  the ordinary2MiB configuration reader and legacy explicit local-path fixture
  mode separately. Use existing isolated seller-test execution and normal
  validation-proof reporting, not a free cloud job route or browser-to-host bridge.
- Suggested files: new contracts schema/test and Worker bundle helper/test,
  then only agreed narrow `validation.ts`/CLI hooks. Parent owns package export
  registration; Laplace must agree Worker ownership. Curie remains exclusive on
  Web/Next/build/browser until the parent's checkpoint.

Adversarial cases must include wrong/stale manifest or CLI version, duplicate or
unreferenced IDs, invalid/oversized base64, size/hash/MIME mismatch, hidden input
fields, archive/path/URL injection, forbidden file formats, and zero execution
before validation. Unit receipt must not be called actual OpenClaw acceptance;
one later explicitly authorized local synthetic runtime test can close that gap.
