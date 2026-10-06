# Worker Status

Updated 2026-10-06. Implementation and observed evidence, not a claim that a real
paid-provider E2E has passed.

## Daily Admission, Declared POST and CLI Hooks

Planck replacement receipt, **2026-10-06 14:46:05 CEST: 140/140 PASS**
across seven focused files. Worker `tsc --noEmit` and owned-file ESLint passed.
No runtime.ts, Prisma, billing, Next, image or service-install changes were made.

`job-limits.ts` and the existing atomic SQLite `claim` transaction enforce
`dailyJobLimit` across all capabilities using accepted attempt history and UTC
midnight. Default100; explicit configuration1..10000. Success, failure and
cancellation consume admission; rejected/replayed offers do not consume it.
Changing configuration, pause/resume or restarting cannot reset usage. Invalid
configuration and a clock earlier than the latest accepted attempt fail closed.
Nineteen daily-job tests include three concurrent processes sharing SQLite,
durable reopen, legacy history and outbox rollback. Inference daily token/USD
budgets remain owned by the existing inference implementation.

`ConnectorConfig.method` is optional GET|POST. Omitted legacy methods remain
omitted in stored objects and approval hashes; execution treats them as GET.
Method changes require a new immutable ID and newly bound dependency consent.
POST uses the fixed reviewed HTTPS endpoint and typed finite primitive fields,
at most30 fields and256000 serialized body bytes. Model arguments cannot alter
method, endpoint, credentials or headers. Thirty-six connector tests include
four actual isolated loopback HTTP cases proving GET query/no body, declared
POST JSON and redirect rejection with conservative failed-request accounting.
Only the SafeHttpClient transport seam is replaced for these four cases;
production Worker selection, schema, credential resolution, tool policy,
registry and durable accounting execute. This is not external HTTPS/TLS proof
or a guarantee that a seller-declared provider operation has no side effects.

New CLI bindings:

```sh
pnpm worker limits status
pnpm worker limits configure --file limits.json
pnpm worker limits configure --file limits.json --approve EXACT_PREVIEW_HASH
pnpm worker capability test VERSION_ID --file seller-test.json
pnpm worker capability package-export VERSION_ID --price-tier USD_99
pnpm worker capability package-export VERSION_ID --price-tier USD_99 --approve EXACT_REVIEW_HASH
pnpm worker capability package-import-preview NEW_VERSION_UUID --file package.json
```

Package export review prints the full exact payload and approval hash; approved
export emits canonical JSON directly. Optional `--publication-evidence FILE`
must be identical in review/export. Package import preview uses an owned regular
single-link nonsymlink file bounded4MiB before allocation and verifies the open
descriptor did not change. It cannot approve/install skills, credentials,
resources, permissions or test proofs. Destination binding/import/approval and
actual reproduction remain pending in the broader package workflow.

Only `capability test` uses Pauli's separate bounded seller-test reader;
ordinary configuration reads retain2MiB. Five real CLI tests verify the hooks,
package input above2MiB, optional publication-evidence hash binding, rejected
unsafe files and a changed manifest rejected before any execution.

Exact scoped rerun:

```sh
pnpm exec vitest run apps/worker/src/daily-jobs.test.ts apps/worker/src/state.test.ts \
  apps/worker/src/connectors.test.ts apps/worker/src/cli-controls.test.ts \
  apps/worker/src/cli-packages.test.ts apps/worker/src/seller-test-bundle.test.ts \
  apps/worker/src/capability-package.test.ts --maxWorkers=2
```

Counts: daily19, state5, connectors36, existing CLIcontrols9, new CLIhooks5,
Pauli seller-test20, Sartre package46. No paid-provider, Stripe, browser or
Docker execution was run in this receipt; no project-wide100% claim is implied.

Discovery CLI follow-up,14:48:31CEST:34/34PASS across new CLIhooks6, daily19
and existing CLIcontrols9; Worker typecheck and owned ESLint passed. New
`pnpm worker inference discover [--config-root PATH]` delegates read-only
metadata probing to Pauli's reviewed helper without opening Worker state,
changing inference configuration or resolving credentials. `scan` returns a
separate `localInference` availability projection, while its approval hash stays
bound to the static discovery snapshot. The test changes availability between
scans and verifies the approval hash remains unchanged. Hardware requirements
remain explicitly unknown and metadata availability is not a generation proof.
Pauli owns helper/periodic readiness acceptance.

Daily availability integration,**2026-10-06 14:52:30CEST:229/229PASS** in11
focused files; Worker typecheck and owned-file ESLint passed. This independent
rerun includes the latest Pauli readiness5 and Gibbs runtime23 tests, plus
daily20, state5, connectors36, CLIcontrols9, CLIhooks6, bundle20, package46,
local-inference13 and diagnostics46. Exhaustion refreshes local readiness,
published ready capability IDs, offer polling, heartbeat ready status and CLI
health from current SQLite usage. Accepted final admission triggers an immediate
heartbeat. It leaves inference health separate and does not cancel active work;
an existing paused job may resume through the sole valid daily-exhaustion
blocker, while clock/configuration/inference failures still deny resume.
Fresh UTC-day allowance or an approved limit increase restores admission
without clearing other readiness failures. Existing cached health cannot hide
daily exhaustion in CLI `health`. These are real SQLite/Worker-runtime tests
with synthetic transport and sandbox boundaries, not full signed-API/Docker
acceptance of the daily limit. Read-only review found the API's sandbox-ready
acceptance guard applies only to ACCEPTED, not existing resume/results; parent
owns any dedicated cross-hop acceptance run.

## Authoritative Checkpoint

- **Fresh runtime daily admission PASS, 2026-10-06 14:51:43 CEST.** Worker
  runtime refreshes authoritative SQLite daily usage before availability,
  heartbeat, offer polling and acceptance. An accepted final job triggers an
  immediate heartbeat; inference readiness remains independent from daily
  exhaustion. Existing jobs continue and can resume through valid quota
  exhaustion only. Invalid clocks/configuration and other health failures
  remain blocked. Runtime/daily-limit/readiness tests **48 passed**; Worker
  typecheck and scoped lint passed. Host-only change, no image rebuild.
- **Gibbs independent SR06 candidate reverification PASS, 2026-10-06
  14:49 CEST.** Separate freshly built tag
  `kivro-sandbox:2026.8.2-download-gibbs`, immutable image
  `sha256:cbe964ea46f0d9acbcfc7ee782c3974e239b225490091a35df33bc82a9b56f7e`.
  Two real smoke runs explicitly checked the runner's canonical job/attempt
  UUID pair and download policy version 1, including a repeat with lower local
  file/input/output budgets. No promotion; default remains `4cf5b9b2...`.
  All smoke processes completed and dedicated scanner/job/probe containers
  were removed. Source/runtime boundaries and exact receipt follow below.
- **R16 finished, PASS / exit 0, 2026-10-06 13:41:22.732 CEST.** Actual
  `scripts/e2e-research-fixture.ts --run`, fixture
  `9fd39cfc-84c5-4bb6-8458-1af39df5cd0e`, job
  `2ae0efd6-15ce-455a-8a82-e55d681a7f73`: signed API, restricted synthetic
  Postgres, actual Docker/OpenClaw, reviewed HTTPS prefetch before private
  access, cache-only afterward, private-derived URL denied, exactly one balanced
  settlement, source rows unchanged and complete cleanup. Deterministic
  inference and fake payments; not paid-provider acceptance. Full receipt below.
- **Default image promoted without rebuild, 2026-10-06 13:44:07 CEST.**
  `kivro-sandbox:2026.8.2` and `kivro-sandbox:2026.8.2-pause` resolve to
  `sha256:4cf5b9b2b420774d780acfef09fe2d1ce9ff73d60f29c7ffb69b0c1a0bf91c7f`.
  Parent authorized; Feynman confirmed no consumers; Curie/Feynman notified.
  Existing Worker approvals remain explicit; no daemon or personal state changed.
- **SR06 isolated real-runtime smoke PASS / exit 0, 2026-10-06.** Separate tag
  `kivro-sandbox:2026.8.2-download`, immutable image
  `sha256:66ed9182691e11325406d8f42576e2a8b43a31294a33a96c1f61df54f6b3834e`;
  job `2ad0b1a5-faf7-4541-a21f-5cab07f9180d`. Includes the parent's canonical
  correlation/attempt trace patch. Completion observed by 14:30:42 CEST.
  Actual fixed public HTTPS
  CSV/PDF/PNG, actual ClamAV clean/EICAR probes and scans, actual OpenClaw
  private-resource access followed by cache-only download lookup/read, denied
  source-file write and one integrity-checked generated result. Synthetic
  seller authority and deterministic inference: no signed API or settlement
  acceptance in this new smoke. Full receipt and boundaries below.
- **SR06 image is NOT promoted.** Default remains `4cf5b9b2...`; download-enabled
  capabilities require the new image's policy attestation and fail closed on
  that default. Disposable scanner and execution containers were removed.
  Parent owns promotion/final runtime snapshot; no Next/CORS/Redis slot used.
- **Final scoped source regression: 528 PASS / 17 explicit opt-in skips** at
  14:31:46 CEST, including the concurrently landed daily-job, connector,
  seller-test bundle and correlation tests. Worker, research-broker and tools
  typechecks plus scoped ESLint passed. Real SR06
  smoke above ran separately; the skipped cases are pause/media integrations,
  not synthetic substitutes for that smoke. No live provider key is available.

## Gibbs Candidate Reverification

Build command, exit 0:

```sh
docker build --progress=plain -t kivro-sandbox:2026.8.2-download-gibbs security/sandbox
```

The build reused all source layers, including the canonical correlation runner.
Its image ID is
`sha256:cbe964ea46f0d9acbcfc7ee782c3974e239b225490091a35df33bc82a9b56f7e`.
All RootFS layer digests match Laplace's prior `66ed918...` candidate; the
manifest/attestation digest differs. Only the separately named Gibbs tag was
created. The default and pause tags still resolve to `4cf5b9b2...`.

`security/sandbox/download-smoke.ts` now asserts the actual `config-test`
timing version 2 and download policy version 1, the staged request UUID pair,
the exact pair in the actual runner `started` frame and the image-bound local
download proof. Missing correlation metadata can no longer pass this smoke
through the production adapter's deliberate legacy compatibility path.

First strengthened smoke, exit 0, completed before 14:45:38 CEST:

```sh
KIVRO_TEST_SCANNER_PORT=51866 \
KIVRO_SANDBOX_IMAGE=sha256:cbe964ea46f0d9acbcfc7ee782c3974e239b225490091a35df33bc82a9b56f7e \
  node --import tsx security/sandbox/download-smoke.ts
```

Job `48f2b554-ac68-49e4-8668-723f47be2190`, attempt
`bba6161c-04ca-43a8-9cba-04a8963b5512`, generated result SHA-256
`54c1fa87313f1a3f184cc8a42e231cb8d3fc86cb4664b3e59e9a6efcbcaabe62`.

The centralized local budgets also apply to research files. The host download
store receives a narrowed copy of the reviewed grant: its per-file bound
cannot exceed `KIVRO_MAX_JOB_FILE_BYTES`, and its total cannot exceed the
remaining `KIVRO_MAX_JOB_INPUT_BYTES` after buyer JSON and assets. Signed seller
permissions/consent hashes are unchanged. Rejected inputs stay quarantined
and are removed before sandbox exposure. Three new regressions cover per-file
rejection, combined input rejection, exact-limit admission and exhausted input
before any download.

Second strengthened smoke after that host change, exit 0, completed before
14:49:12 CEST:

```sh
KIVRO_TEST_SCANNER_PORT=53779 \
KIVRO_SANDBOX_IMAGE=sha256:cbe964ea46f0d9acbcfc7ee782c3974e239b225490091a35df33bc82a9b56f7e \
KIVRO_MAX_JOB_FILE_BYTES=20000 KIVRO_MAX_JOB_INPUT_BYTES=20000 \
KIVRO_MAX_JOB_OUTPUT_BYTES=2000 \
  node --import tsx security/sandbox/download-smoke.ts
```

Job `776faa88-67b1-4625-9365-12519ca1f5d3`, attempt
`9dbe83b6-c54d-43b5-8362-12076113937d`, generated result SHA-256
`badc08926cfaf21b142f05ed680ffc05149c167a0fe3e9f1e081f00841338876`.
Both runs used actual Docker/OpenClaw, three fixed public HTTPS sources and
the dedicated official ClamAV image already recorded below. All source
bytes/hashes matched the earlier receipt. Six deterministic inference calls,
143,767 reserved tokens and zero synthetic USD in each run. Private-resource
access followed by cache-only file lookup/read, write denial, source hash
integrity, private-derived URL rejection and one result-only delivery passed.
The inference provider and seller identity were synthetic: no signed API,
settlement, paid-provider or Stripe acceptance is implied.

Focused file-limit/download/correlation suite: **47 passed**, six files,
14:47:12 CEST. Worker research/runtime plus complete adapter unit suite:
**112 passed / 14 explicit media opt-in skips**, 14:47:45 CEST. Worker and
adapter typechecks, tools TypeScript and scoped ESLint passed. The first
restricted-shell focused run passed its five socket-free files but could not
complete the loopback scanner fixture; it was terminated (exit 130), then the
same tests passed with authorized local network access. No finite shell
process from these runs remains. Both dedicated scanner containers were
removed by their exact IDs, and no job/probe containers remain from these
smokes. Parent may start its full-stack fixture on the candidate; promotion
still requires its explicit GO.

## Gibbs Daily Admission Integration

`runtime.ts` consumes Pauli's synchronous `refreshDailyAdmission` projection
and Planck's durable `state.dailyJobs()` counts before capability advertising,
heartbeat, offer polling, direct acceptance and status output. It does not
wait for the 30-second full health poll to observe the final claim, an approved
limit edit or a UTC day rollover. A successfully accepted job schedules the
next heartbeat immediately, publishing its current active ID and exhausted
capacity. The heartbeat includes only bounded primitive numeric fields
`dailyJobLimit`, `dailyJobsClaimed`, `dailyJobsRemaining`, accepted by the API's
existing generic health allowlist. Its inference marker reflects the actual
inference check, not overall admission readiness.

Exhaustion cannot abort an already running execution. `RESUME_JOB` permits
only the exact additional failed check `dailyJobs / DAILY_JOB_LIMIT_REACHED`
for an existing paid attempt; invalid configuration, clock rollback, sandbox,
inference and every other failed check still prevent thaw. All consent,
manifest, deadline, security and cloud acknowledgements remain required. A
read-only API inspection confirmed that the sandbox/readiness admission check
applies to `ACCEPTED`; existing running/resuming/result operations retain their
separate ownership, revocation, policy and pause-budget checks.

```sh
pnpm exec vitest run apps/worker/src/runtime.test.ts \
  apps/worker/src/daily-jobs.test.ts apps/worker/src/readiness-admission.test.ts \
  --maxWorkers=2
```

**48 passed**, three files, 14:51:43 CEST: runtime 23, daily limits 20,
readiness admission 5. Four new runtime regressions cover immediate withdrawal,
unchanged active execution and valid paused-job resume, fresh UTC recovery
and approved limit edits with independent blockers retained, actual heartbeat
projection without new offer polling, and failed resume through invalid
configuration or clock rollback. Worker TypeScript and scoped ESLint passed
after these edits. This is a host-runtime regression receipt, not an additional
signed-API or paid-provider run. Runtime/source frozen for parent integration;
the parent-owned input byte checks are preserved.

## SR06 Public File Admission

Implemented distinct, optional `permissions.network.downloads` schema version 1
paired with `research.download` in RESEARCH mode. Existing manifests receive no
default or new authority. Only fixed, seller-reviewed HTTPS DOWNLOAD sources
are accepted, even for otherwise PUBLIC-only jobs. Dependency/manifest/review
changes invalidate approval. Source MIME and optional expected SHA-256 are part
of that review; remote filenames, headers, credentials and buyer/model URLs
cannot select the destination or grant authority.

The host broker streams into an exclusive private quarantine file with DNS/IP
pinning, public-address/redirect checks, cancellation, hashing, backpressure and
an absolute deadline through the final disk flush. DOWNLOAD shares existing
page, byte and time reservations and adds signed file-count/per-file/total
limits. Supported public downloads: PNG, JPEG, WebP, PDF and CSV; at most five
files, 500,000 bytes/file and 5,000,000 total, further narrowed by research and
job-input budgets. Validation uses the existing storage and adapter validators;
CSV formulas/scripts and type mismatches fail closed. Mandatory dedicated
loopback ClamAV scans happen before any private access or inference. There is
no development scan bypass, and no claim that antivirus sanitizes PDF content.

Only the exact scanned snapshot is installed into read-only per-job inputs.
Generated `skills/kivro-public-data/UUID.ext` workspace paths use the pinned
official SSH backend's protected skills filesystem namespace. They contain no
SKILL.md, executable name or seller code and are explicitly untrusted data.
Actual OpenClaw read succeeded and write to that same path was denied. This
uses the supported inner filesystem bridge inside the outer Docker boundary;
it is not a host fallback. After the ACCEPTED prelude, `research.download`
accepts only a strict reviewed source ID and returns a cached descriptor,
provenance and scan verdict. It opens no network connection. Result collection
remains exclusively under `result/`; downloaded inputs are not auto-delivered.

**Final candidate build and real smoke passed**, completion observed by
2026-10-06 14:30:42 CEST. Tag `kivro-sandbox:2026.8.2-download` resolves to
`sha256:66ed9182691e11325406d8f42576e2a8b43a31294a33a96c1f61df54f6b3834e`.
This includes the parent-owned canonical job/attempt correlation trace plus
the final host-side sink deadline fix. Exact rerun:

```sh
KIVRO_TEST_SCANNER_PORT=63387 \
KIVRO_SANDBOX_IMAGE=sha256:66ed9182691e11325406d8f42576e2a8b43a31294a33a96c1f61df54f6b3834e \
  node --import tsx security/sandbox/download-smoke.ts
```

Job `2ad0b1a5-faf7-4541-a21f-5cab07f9180d`, six calls, 143,767 reserved
tokens, result SHA-256
`16f14086897e221883227f25630b263d162d1b507a9bc1f47d4b2299c8b5e390`.
All three source sizes/hashes below matched, scanner clean/EICAR probes passed,
private resource then cached CSV consumption and protected-source write denial
passed, no extra private-derived public request occurred, canonical source
hashes were unchanged, exactly one generated file was collected and its Docker
container was removed. The dedicated scanner was removed afterward and no
candidate-image containers remained. Feynman/Curie notified. **Default remains
4cf5; no further Worker-owned image edits are planned in this batch.** Promotion
and existing Worker reapproval are parent-coordinated actions, not implied by
this handoff. The synthetic provider/seller and absent signed API/settlement
boundaries below apply equally to this final rerun.

Initial real smoke, retained separately, command:

```sh
KIVRO_TEST_SCANNER_PORT=60851 KIVRO_SANDBOX_IMAGE=kivro-sandbox:2026.8.2-download \
  node --import tsx security/sandbox/download-smoke.ts
```

PASS / exit 0 on `sha256:0cc8bbec44e49230e435b3e7879e63d6c8736fb093f56ef054512c5c3094911a`,
job `3b9ec06a-e8f7-4d93-ab03-8ac2d7b26da1`, 2026-10-06. Actual downloaded bytes:

| Reviewed Source | Bytes | SHA-256 |
| --- | ---: | --- |
| `https://people.sc.fsu.edu/~jburkardt/data/csv/addresses.csv` | 328 | `a3702f854ee4df14ef9f1574684b672f39ad616b1c93840fac2f451a74d10654` |
| `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf` | 13264 | `3df79d34abbca99308e79cb94461c1893582604d68329a41fd4bec1885e6adb4` |
| `https://www.w3.org/Icons/w3c_home.png` | 1848 | `590608bf256237f22d84bbab2a0a1afc0d4f20db6350bbac2c6841f1f3e13b01` |

ClamAV was the official immutable image
`clamav/clamav-debian@sha256:9bb8712a50f0e75166e936c452cd82dd5e5be0b85586598930b5bbb84a99a578`,
version `1.5.4/28137/Mon Sep 28 06:24:12 2026`. Clean and standard harmless
EICAR probes both behaved correctly before the three actual scans. This is a
bundled signature snapshot, not a claim of current daily database freshness.
Six deterministic-provider calls, 143,767 conservatively reserved tokens;
generated result SHA-256
`745c93e23d2b80a8b26ded37212651b1732af0a120ea69495225114093effc3b`.
Private resource access preceded the cached CSV read, source writes were denied,
all canonical input hashes remained unchanged, and private-derived URL access
was rejected without additional public traffic. Only the declared generated
result was collected. Job/scanner containers, temporary state and provider
fixtures were removed. No paid provider, signed API, buyer settlement or UI
consent acceptance is claimed by this smoke. The prior R16 signed-API Postgres
receipt remains separate. An initial fixture failure was a missing `resource:`
dependency ID prefix; fixing that fixture required no broker policy relaxation.

Focused evidence: Worker download tests 9, scanner tests 10, download transport
tests 9, plus the existing broker suite; combined focused run **137 passed** at
14:25 CEST. The added sink-close regression retains timeout even after the HTTP
request has completed. Earlier combined owned suite **450 passed / 17 explicit
opt-in skips**; parent reported full typecheck/lint and **1,242 unit passes** at
14:21:22 CEST, before the final sink-deadline and diagnostics compatibility edits.
Final combined command below passed **528 tests / 17 opt-in skips** at 14:31:46
CEST, including independently owned daily-job/connector/bundle/correlation
additions. Tools typecheck passed again after the concurrent seller-test subpath
export landed. This is not a claim that all 528 tests were authored in SR06.

```sh
pnpm exec vitest run apps/worker/src packages/openclaw-adapter/src \
  packages/job-protocol/src packages/crypto/src packages/research-broker/test \
  packages/storage/src packages/contracts/src/research-downloads.test.ts \
  security/sandbox --maxWorkers=2
```

Diagnostics V2 now accepts optional typed security warnings without changing
the strict legacy endpoint; **46 diagnostics tests passed**. Malformed warnings
never trigger legacy fallback or expose raw content. Tools typecheck passed.

Source handoff: `apps/worker/src/{research-scanner.ts,research-files.ts,
research-downloads.test.ts,research-config.ts,tools.ts,runtime.ts,validation.ts,
observations.ts,capability-health.ts,readiness.ts,index.ts,file-transfer.ts,
transport.ts,diagnostics.test.ts}`; `packages/openclaw-adapter/src/{research-files.ts,
index.ts,policy.ts}`; `packages/contracts/src/{research-downloads.ts,
research-downloads.test.ts,index.ts}`; `packages/research-broker/src/{requests.ts,
policy.ts,public-requests.ts,broker.ts,egress.ts}` and
`test/download-egress.test.ts`; `packages/storage/{package.json,src/index.ts,
src/validation.ts,src/scanner.ts,src/scanner.test.ts}`;
`security/sandbox/{runner.mjs,download-smoke.ts,plugin/index.mjs,
plugin/openclaw.plugin.json}`; and Worker status/compatibility/coverage docs.
Additive storage subpath exports preserve existing API callers. No dependency
install, lockfile/Prisma change, personal credential import or service install.
Parent's separate canonical correlation trace patch is included in the final
`66ed...` candidate. The earlier `0cc8...` receipt above is retained historically.

Publication provenance boundary: current signed validation reports sandbox
image/policy/test time plus inference config hash/test time, alongside the
execution manifest hash. The inference hash covers normalized dedicated
inference configuration only. Selected skill/resource consent hashes,
reviewed research plan hash, and scanner config/proof exist locally but are
not separately transmitted in this validation payload. No whole-Worker config
hash or independent config-schema version is currently signed. A server-side
publication projection must name its own schema/scope rather than present it
as complete local configuration attestation. No validation protocol expansion
was made by this SR06 batch.

## R21 Verified Image

The pause repair passed focused and signed-API verification on separate tag
`kivro-sandbox:2026.8.2-pause` and was promoted to the default tag after the
independent rerun and R16 acceptance. Host SQLite
now preserves confirmed pause duration and remaining active execution budget,
including repeated/duplicate commands. Pause-request broker draining remains
charged; resume rechecks original manifest, image, consent, resources and cloud
RUNNING acknowledgement before thaw. Local pause expiry and cancellation remain
authoritative without cloud connectivity. Crashed attachments still fail closed.

**Approved policy, synchronized acceptance passed:** pause duration is now
cumulative per job, capped at the shared `MAX_JOB_PAUSE_MS=900000`. Parent-owned
API configuration `KIVRO_MAX_JOB_PAUSE_MS` is snapshotted immutably into each job.
Worker verifies the optional signed `maxPauseMs` before applying legacy fallback,
rejects notice/payload disagreement, stores the budget immutably in SQLite and
subtracts all prior confirmed pauses. Lower limits down to 1,000 ms are supported.
Existing Worker image reapproval remains explicit; this is not a general FULL_RESUME claim. No API/shared-policy
file was changed by Worker.

Candidate runner/config/provider/media/bridge deadlines are finite, allowing
the active limit plus the signed cumulative budget as wall containment. Host provider/research
deadlines are unchanged; no retries or token-budget resets were added. The
owned plugin uses a fixed-loopback, byte-capped HTTP bridge with an explicit
timer instead of fetch's implicit headers timer. New local timing attestation
version 2 rejects old images with `SANDBOX_TIMING_UPDATE_REQUIRED`; old cached sandbox
proofs cannot establish readiness for this Worker version. Current candidate
`sha256:4cf5b9b2b420774d780acfef09fe2d1ce9ff73d60f29c7ffb69b0c1a0bf91c7f`
was built on 2026-10-06 at 13:20 CEST with that policy.

**Tag receipt, 2026-10-06 13:44:07 CEST:** after parent authorization, Feynman
confirmed no image consumers and `docker ps --filter label=io.kivro.owner`
was empty. `docker tag` promoted the exact tested image without rebuilding:
`kivro-sandbox:2026.8.2` and `kivro-sandbox:2026.8.2-pause` both resolve to
`sha256:4cf5b9b2b420774d780acfef09fe2d1ce9ff73d60f29c7ffb69b0c1a0bf91c7f`.
Former `4b2874ff...` remains at `kivro-sandbox:2026.8.2-research-observed`.
Feynman and Curie were notified. No saved personal image approval, credential,
daemon or Next/CORS state was changed. Parent owns final artifact/fresh-clone
verification and explicit reapproval of any existing demo Worker.

Master 442/446: `resumeWhilePaused: true` authorizes only one existing job resume;
local equivalent is `job resume JOB_ID --confirm-global-pause`. Global local and
remote pause remain set and new acceptance is blocked. Security blocks are
checked before resume and again after asynchronous readiness/cloud work. Already
RUNNING resume is idempotent. Focused suite: 72 passed; owned suite: 258 passed,
12 opt-in cases skipped (real pause tests run separately). Worker/adapter/protocol
and tools typechecks plus scoped lint pass. Real timing-v2 tests below pass;
historical d106 evidence is retained only for comparison.

Parent's independent 13:33:09 CEST run completed the resume behavior (SUCCEEDED,
two calls, one delivery and removed container), then failed the fixture's final
duration assertion at 74,988 ms after a single 75,000 ms sleep. Expiry/cancel
passed. The fixture now polls elapsed wall time from persisted `pausedAt`, aims
for 75,250 ms, and has an 80-second monotonic wait bound. The final >=75,000 ms
assertion and every production guard are unchanged. Independent rerun remains
recorded separately below; no image rebuild is needed for this test-only correction.

Parent's corrected independent run **3/3 passed**, 13:38:51-13:40:27 CEST, same
`4cf5b9b2...` image. Resume job `7b3ad407-9d20-4a5b-9339-3b13dc5b0137`:
3,416 ms active before pause, 75,254 ms paused, 86,341 ms wall, two calls and
result SHA-256 `7e30a0963dd7228010756b856a9c60c583a7015454e52c756cad1bca64e01b38`.
Expiry 2,189 ms and cancellation 159 ms had no result, one terminal event and
removed containers. Cloud/readiness remain synthetic in this independent
fixture; it does not replace Feynman's separate API settlement receipt.

Exact `4cf5b9b2...` candidate receipts, 2026-10-06 13:20-13:24 CEST:

- Actual lower-budget pause suite **3/3 passed**. Resume job
  `b4b44fce-5f4d-4288-a6cb-714e41fbf14d`: active limit 30 seconds, cumulative
  pause budget 90,000 ms; 3,061 ms active before pause, 75,006 ms paused,
  85,829 ms total wall; two deterministic-provider calls and real file SHA-256
  `404081ba48d74b1df3beb5b3bfaa4571e685558bd351a3a4297611ac8c9d2584`.
- Actual 2,000 ms budget expiry job `19d88d58-f75a-4cbf-a273-370992c43012`
  reported `TIMED_OUT` at 2,153 ms including cleanup; cancellation job
  `0d66680d-3746-49a5-b051-5ee6dcc18295` completed cleanup at 155 ms. Both
  had one pre-pause provider call, no resume or delivered result, one terminal
  event, and removed containers. Cloud delivery/readiness are synthetic here;
  API reservation/release/capture is not exercised by these three tests.
- Full `security/sandbox/smoke.ts` passed: self-test, import, production broker,
  read-only resource, named mixed result, no-tools and cancellation; four
  execution calls / 62,068 reserved tokens. Actual public-prefetch research
  smoke passed: one `example.com` HTTPS response, 577 bytes, SHA-256
  `25ddf2c883e0d1958ea971d279a7e4f0fd446724ee3db7db19dadabd4a62e484`,
  three calls / 41,380 reserved tokens, private resource then cache-only access,
  arbitrary URL denial, observation review and cleanup. This is a private-file
  resource smoke, not the requested signed-API read-only Postgres acceptance.

Feynman reported the actual signed-API fixture **PASS / exit 0**, receipt
`293229d6-2337-46df-b991-9d7574bb7efc`, at 2026-10-06 13:33:10.930 CEST on
the exact `4cf5b9b2...` image. Success job
`387588e5-bdd3-4143-ba75-228bc1677711`: 76,446 ms confirmed pause, 24,147 ms
active below the 30,000 ms bound, 100,588 ms wall; one balanced settlement after
result replay and a 112-byte S3 result with SHA-256
`3a6798001128d9e2986a7cc42f041c3dd6ef3a401448d7f74800d718e5dbc81c`.
Cumulative expiry used 56,227 ms plus the remaining 33,773 ms, with 127 ms expiry
overshoot: `TIMED_OUT`, one reserve/one release, zero capture/earning. Paused
cancellation also had zero earnings. Containers/temp state removed, fixture
Worker revoked, cleanup passed and execution slot released. This is attributed
API-owner evidence with deterministic inference/fake payments, not paid-provider
acceptance. Default tag promotion occurred afterward as recorded above; no
production service restart was performed by Worker.

Direct evidence: the actual old image failed after a 75-second Docker freeze
despite the repaired host retaining time. Intermediate candidate `25737737...`
passed at 13:01 CEST: 3,449 ms active before pause, 75,006 ms paused, 86,286 ms
wall, two production-broker requests to a deterministic HTTP provider, actual
OpenClaw write/result integrity and container removal. Job
`c050fafe-0267-4926-b256-9113c54dda58`, result SHA-256
`75294b20370139d34cc67548a50eb0faea6dcb199765572ae2aa11fe2d1a61dd`.
Cloud delivery/readiness are synthetic in this focused test; no settlement,
real provider, or 15-minute wall-clock-expiry acceptance is claimed.

The earlier timing-v1 candidate was
`sha256:d106fd835aaddd4467750d9b496ade83390059e18ae8cc97c09224746ca128dc`.
Its actual research/resource/plugin/self-test smoke passed, with one public
577-byte fetch and three deterministic inference calls. Exact-candidate long
pause passed at 13:05 CEST: job `012fc8c9-7a4e-48ee-b3d1-b351642bdd58`,
3,299 ms active before pause, 75,012 ms confirmed pause, 85,963 ms total wall,
two calls, real result SHA-256
`0cd8f2d9f3e3f6f68df2c429a4d5a3aab540384ffdbdf0b38bb680511832433f`,
and removal confirmed. Full basic smoke also passed on final d106, including
four production-broker calls/62,068 reserved tokens, import, named mixed result,
empty tools and pause/resume/cancel/removal. Scoped suite: **346 passed, 10 opt-in tests
skipped** (the long-pause test ran separately); Worker/adapter/tools typechecks
and scoped ESLint pass. Restricted HTTP-fixture run encountered loopback EPERM and was terminated;
the escalated rerun passed. No real provider or shared services were involved.
Use `KIVRO_PAUSE_INTEGRATION=1 KIVRO_SANDBOX_IMAGE=kivro-sandbox:2026.8.2-pause
pnpm exec vitest run apps/worker/src/pause.integration.test.ts --maxWorkers=1`.

R21 changed paths: `apps/worker/src/{state.ts,state.test.ts,runtime.ts,runtime.test.ts,
pause.integration.test.ts,readiness.ts,diagnostics.test.ts,security.test.ts,
validation.ts,index.ts,cli-controls.test.ts}`;
`packages/openclaw-adapter/src/{index.ts,policy.ts,timing.ts,security.test.ts}`;
`packages/job-protocol/src/{index.ts,fixtures.ts,protocol.test.ts}`;
`security/sandbox/{Dockerfile,.dockerignore,runner.mjs,timing.mjs,bridge.test.ts,
plugin/index.mjs,plugin/bridge.mjs}`; and this status, compatibility and Worker
coverage documents. No API/contracts/schema/root edits or service installation.

## R16 Signed API Acceptance

`scripts/e2e-research-fixture.ts --run` **PASS / exit 0** at
2026-10-06 13:41:22.732 CEST, immutable image `4cf5b9b2...`:

- Fixture `9fd39cfc-84c5-4bb6-8458-1af39df5cd0e`; purchased job
  `2ae0efd6-15ce-455a-8a82-e55d681a7f73`; attempt
  `2bea1095-713b-4c93-9efa-e05c275f1c6d`; Worker
  `4f012f2d-95f9-4e27-8cc1-55293d5b2fb4`.
- Actual CLI pairing, sandbox/inference proofs, authenticated seller diagnostics,
  dependency/resource/research consent, real seller validation, heartbeat,
  private publication/grant, signed notice/acceptance/payload and purchased job.
- Production resource broker used the existing synthetic restricted Postgres
  reader and approved parameterized `get` query. Validation consumed `a1`;
  purchase consumed `a2`, with private taint and no host connection metadata.
  No DDL, seed, ACL or personal database changes. Final read-only checks confirmed
  both source rows unchanged.
- The paid job fetched fixed `https://example.com/` once before inference/private
  access: HTTP 200, 577 bytes, SHA-256
  `25ddf2c883e0d1958ea971d279a7e4f0fd446724ee3db7db19dadabd4a62e484`.
  After the real private query, OpenClaw used a reviewed-source cache lookup.
  An attempted URL containing private row/buyer data was denied. No post-private
  public requests or receipt mutation; receipt ordering and sanitized content
  were checked against durable audit/state.
- Nine deterministic-provider HTTP calls total (health plus validation/purchase).
  Actual combined TEXT result SHA-256
  `7dda325611b99c2ef8cde921db2dd2791a1652f4d0a18fe159e4c3078c2dc7f5`.
  Replay used the exact Worker TEXT shape and verified its committed attempt
  hash first. Exactly one capture, earning and fee in one balanced transaction;
  no buyer reservation remained. Fake local payments, not a real charge.
- Cleanup passed: capability paused, Worker revoked, buyer grant revoked,
  sessions closed, no owned containers/active attempts/outbox, temporary state
  and servers removed. No Next/CORS or background reconciler used.

The initial run reached purchased success but its fixture replay incorrectly
used API-normalized TEXT output (`assets:[]` added) and received 409. Cleanup
passed. Only the fixture replay was corrected, retaining the committed hash and
exact-once checks; no production API/Worker relaxation. Final source passes tools
typecheck and lint, plus early production/schema/image rejection and no-run help.
No paid provider, public search key, real seller database or browser acceptance
is inferred from this synthetic-data, real-runtime receipt.

## Implemented

- Host-native CLI: scan, doctor, pair, start, stop --all, persistent offline
  pause/resume, per-capability pause, job pause/resume/cancel, jobs and sanitized
  audit logs. Startup/status-change diagnostics show ready/paused/inference and
  sanitized blockers. Encrypted dedicated credentials with Keychain/explicit Linux
  wrapping key; durable SQLite lease, replay IDs, outbox and crash recovery.
- Ed25519 outbound requests; content-free signed notices; atomic persisted
  notice/attempt before ACCEPTED; accepted payload signature/hash checks before
  buyer downloads or inference. Shared executionManifestHash covers IO,
  permissions, instructions and dependencies.
- Real supported OpenClaw 2026.8.2 (0965053) inside Docker network-none. Outer
  Docker is the security boundary; the supported SSH backend uses loopback
  inside the same container. No host jobs or personal plugin loading. Read-only
  root/input/config, dropped capabilities, resource/time/token/cost bounds,
  full-container freeze and cancellation.
- The asynchronous RUNNING/cloud acknowledgement is awaited after container
  creation/inspection and before Docker starts. A rejected callback removes the
  container without executing it; both Docker and adapter entrypoints are tested.
- Dedicated fixed-endpoint host inference broker, strict request/response
  schemas, conservative durable reservations, public-DNS pinning, redirect
  refusal, explicit dedicated loopback option and cancellation. No provider
  credential enters the container. OpenAI-compatible Chat Completions and
  native Anthropic Messages are supported through the same internal bridge.
  Anthropic supports text/client tools with thinking disabled, strict history
  and response mapping, cached-input accounting, 2x input-price reservations
  and redacted errors. Explicit seller secret/config consent is mandatory;
  provider keys in platform `.env` are never silently imported or selected.
- R15 doctor checks Node/SQLite, signed cloud device authentication, local
  versions against complete cloud minimum/revocation lists and bounded clock
  skew. Missing policy arrays fail closed. Fresh-pair readiness does not require
  a prior heartbeat; stale mirror version reasons cannot override actual local
  policy evaluation. Public clock hints never establish valid credentials.
- R15 completion: separate personal-config readability, transactional Worker DB
  writability and structured initialization failure. Authenticated diagnostics
  V2 adds seller authority and server-declared deployment labels; only HTTP 404
  falls back to unchanged legacy diagnostics with `unknown` environment.
  Doctor/health/startup/pair show the API origin and verified deployment label.
- R16: immutable reviewed public-source plans bind seller/version/dependencies.
  Fixed prefetch runs before private execution/inference; subsequent research
  accepts only reviewed source-ID cache lookups. Private labels are not weakened.
  Trusted HTTP cancellation covers DNS waits, redirect gaps and live requests,
  with narrowed durable total-network deadlines independent of cached reads.
- R17: sanitized local research receipts retain actual successful bytes,
  status/host/type/hash, plan/source binding and timestamps. Failed traffic stays
  unknown. Each fetched-page hash must match exactly one unannotated reservation.
- R18: safe agent/tool/MCP/workspace-reference/environment-name inventory and
  explicit review of actual seller-test tool/resource/network/inference metadata.
  Native CLI summary outcomes stay unknown; reviewed plugin completions are
  observed directly. Skills are labeled loaded, not falsely reported invoked.
  Undeclared bindings block validation; reviewing a report never grants access.
- Durable signed usage receipts: bounded pre-transport call reservations,
  successful reported tokens, exact decimal configured-rate estimates and
  explicit unpriced calls. One immutable receipt is queued only after accepted
  and finished cloud acknowledgement. Independent bounded retries never
  participate in result settlement. Legacy incomplete accounting is not invented.
- Reviewed Kivro plugin: research, read-only resources, fixed JSON connectors,
  fixed Blender/ffmpeg wrappers. LocalResourceBroker is integrated with host
  identities, capability-scoped stored configuration/operation grants,
  cancellation and SELLER_PRIVATE taint. Bounded checkHealth() authenticates and
  checks every granted query's ACL/preparation without reading application rows.
- Explicit dependency-bearing skill import: selected transitive closure,
  reviewed tool/inference/resource/connector bindings, dedicated credential
  revisions, actual resource health, content-bound review and native-requirement
  adaptation. Immutable compiled SKILL nodes retain source provenance. Reimport,
  rotation/config changes and revoke invalidate dependent capability proofs.
- Opt-in macOS service install/uninstall/status/restart, private owner/hash-bound
  plist, sanitized environment, paused lifecycle changes and active-job refusal.
  No actual LaunchAgent was installed; launchctl is mocked in unit tests.
- Direct upload tickets and streamed presigned PUT/finalize, exact Content-Length,
  no Worker auth at storage, pinned public DNS/explicit development loopback,
  bounded hash-checked downloads to exclusive read-only files and partial cleanup.
  Existing adapter caps remain; this is not large-result frame streaming.
- Result-only collection, path/link/MIME/size/hash checks, shared output
  validation, named field metadata with file paths mapped to uploaded IDs. No
  session/log/prompt/workspace scraping. Crashed jobs are never re-executed.
- capability test runs real dedicated inference in Docker, validates output
  and posts the exact signed API validation proof. FILE/FILES tests accept
  explicit {input,assets:[{id,path,filename,mimeType,sha256,sizeBytes}]} selections.
  It holds the daemon lease, without purchase/upload/settlement. Approval alone
  does not establish readiness or a healthy published binding.
- Shared executionFileCompatibilityIssues is enforced at local approval,
  seller-test preflight, recurring consent/health and adapter environment setup.
  A passing PDF fixture cannot validate a contract also advertising unsupported
  Office/GLB files. Review output includes compatibility issues. Media-owner
  validated WebP/MOV/WebM/MP3/M4A/OBJ/FBX formats now pass the Worker contract gate.

## Observed Evidence

- Final image promoted to `kivro-sandbox:2026.8.2` after both suites passed:
  `sha256:4b2874ffba74006e54b613bb988eabcc1fb57e0839e156bdaed20318830b680f`.
  Feynman notified; no further rebuild/retag planned during his browser fixture.
- `node --import tsx security/sandbox/research-smoke.ts`: **exit 0 on final
  image**. Actual example.com HTTPS prefetch (577 bytes, SHA-256
  `25ddf2c883e0d1958ea971d279a7e4f0fd446724ee3db7db19dadabd4a62e484`),
  approved private-file snapshot read, immutable cache after private access,
  arbitrary URL denial, sanitized receipt, actual tool observations, explicit
  review and container cleanup. Three deterministic inference calls, 41,380
  reserved tokens. Synthetic seller identity, not real DB/full signed API
  research or paid-provider acceptance.
- Generic `security/sandbox/smoke.ts` on the same final image: **exit 0**, mixed
  file integrity, actual skill import, resource broker, named outputs, empty-tool
  path and whole-container pause/resume/cancel/removal. Four production-broker
  execution requests reserved 62,068 tokens, deterministic HTTP provider only.
- Final combined owned/broker unit run: **327 passed, 9 Docker-gated media
  tests skipped**. Five-package typecheck and scoped lint pass.
  The focused 135-test run includes 42 diagnostics tests. Bohr independently
  reported 188 relevant tests plus Worker/broker typecheck/lint passing.
  Socket-abort tests mock HTTPS; pending-DNS tests use the actual SafeHttpClient
  with an injected resolver, not a live slow-provider fixture.
- Intermediate failures were corrected before promotion: registered
  `after_tool_call` hooks produced no CLI records, so the implementation uses
  supported CLI toolSummary plus direct restricted-plugin completions instead.
  No conversation-hook permission remains. The no-tools smoke exposed the
  documented zero-call summary omission; a regression and full rerun passed.
- Feynman-attributed actual seven-case fault matrix passed at 2026-10-06
  10:10:01.331 UTC, fixture `73969acc-3ec3-41ff-8c5e-b954bf544cfa`, image96dd.
  Timeout job `aa6ebada-a41a-454f-806b-8a5e7407d26d` became TIMED_OUT/RELEASED
  at 30,091 ms for a 30-second budget. No residual containers; exactly-one
  reserve/release/no capture on fault jobs. Owned-PID fallback corrected an
  intermediate process-group EPERM before that final pass.

- Usage receipt/media-gate follow-up: **86 focused tests passed** (31 inference,
  26 diagnostics, 18 security/contract gates and 11 durable usage tests), Worker
  typecheck and scoped lint passed. Synthetic signed HTTP verifies receipt
  ordering/idempotent body retries; no real provider invoice or receipt full-stack
  acceptance is claimed from these unit fixtures.
- Parent reported a real deterministic full-stack pass at **2026-10-06 09:33:18
  UTC** after the doctor bootstrap fix: Docker/OpenClaw file consumption, S3,
  exactly-one ledger capture and cleanup. This is attributed parent evidence,
  not a Worker-owner rerun or receipt acceptance evidence.

- Previous import/stream/service batch scoped Vitest: **79 passed**, including signatures/notices/dependency hashes,
  replay/offline pause, pre-start callback rejection without execution, resource
  consent/snapshot mutation, private-data egress refusal, token/tool restrictions
  required FILE/FILES selections, named no-write outputs, unsupported advertised
  formats, startup diagnostics, DNS cancellation/deadlines and address-family pinning.
  New coverage: 24 discovery/import tests, five service lifecycle tests with real
  plist conversion but mocked launchctl, and eight loopback streaming/security tests.
  Personal-state preservation tests use synthetic personal directories and compare
  content, inode, mode, mtime and ctime; OS read-access time is not an immutability claim.
- Four-package typecheck and scoped ESLint passed after the final host edits.
- Final native Anthropic/R15 scoped suite: **136 passed across 12 files**;
  four-package typecheck and scoped ESLint passed. This bounded batch adds
  31 provider/conversion/accounting/
  redaction tests and 26 diagnostics tests. Real ephemeral HTTP fixtures verify
  native Anthropic headers/tool round trips and Ed25519 cloud diagnostics,
  revoked identities, clock skew, stale first-heartbeat state and required
  revocation lists. Keychain calls are mocked; no actual seller key is used.
- `node --import tsx security/sandbox/smoke.ts --anthropic`: **exit 0**, real
  OpenClaw and production native Messages conversion, deterministic HTTP
  provider. Four execution requests reserved **62,664 tokens**, plus separate
  health request. Actual import, resource read, mixed generated file integrity,
  empty-tool named output and pause/resume/cancel all passed using image 96dd
  below. No image rebuild, real-provider access or shared dev server was used.
- `KIVRO_INTEGRATION=1 pnpm exec vitest run tests/integration/worker-protocol.test.ts`:
  **2 passed** against the actual local API/database fixture. These are explicit
  synthetic protocol attestations, not inference evidence. Restricted loopback
  access blocked an initial rerun; the escalated local-network rerun passed.
- `node --import tsx security/sandbox/smoke.ts`: real OpenClaw plus production
  InferenceBroker plus a loopback-only deterministic HTTP test provider passed.
  Latest run includes actual CLI dependency import and a compiled skill in the
  real OpenClaw request; four execution requests reserved **62,052 tokens** plus
  a separate deterministic inference health call. Verified plugin registration,
  resource read, SSH filesystem write, unique-marker file integrity, named file
  mapping, named scalar/JSON final output with an empty tool allowlist, and real process-tree
  pause/resume/cancel/removal. No production mock provider is installed.
- Docker mounted-canary isolation, network-none, SSH and plugin/config probes
  and real Blender/ffmpeg media probes passed using separate temporary evidence
  state. Historical approved image for this earlier evidence:
  `sha256:96dd4f5334bf57fea81af17192864ae57e0f520aa492afb8591ad7fd7077ae52`.
- A credential-free bounded HTTPS request through the actual broker transport to
  `https://nodejs.org/api/http.html` returned HTTP 200 (647993 bytes), verifying
  public DNS address-family pinning outside the loopback fixture.
- Full-stack fixture owner reported exit 0 for
  `node --import tsx scripts/e2e-fixture.ts --run`: real approval/proofs,
  required-file validation and purchase execution, S3 content/hash/size,
  duplicate-create/result replay, exactly one balanced capture/earning/fee and
  cleanup. Stable-source rerun job `d09ba72a-fc2b-461e-afc3-5883c0f61612`, nine
  deterministic inference calls, one real attempt, a 112-byte generated file,
  and final image above. Persisted cleanup was checked; generated SHA-256:
  `c15e195dcb1f629854d8c87b4d6f171a29e4a3d5c265ec49202695afbc4feb5c`.
  This is attributed fixture evidence, not a Worker
  owner rerun or real-provider/live-payment acceptance. See `docs/FULLSTACK-FIXTURE.md`.
- Parent independently reported actual demo pairing, Keychain PASS, sandbox
  PASS, paused/no jobs, and dedicated inference as the missing prerequisite;
  parent subsequently stopped its paused daemon for final image approval.
- **Worker-owner direct-transfer full-stack rerun passed**, 2026-10-06
  09:04:38 UTC, `node --import tsx scripts/e2e-fixture.ts --run` (no env-file):
  job `29a75d3a-bb5d-44e9-9b3a-9286feb4154a`, attempt
  `2613064f-42a3-4fed-8668-8307ff66d255`, nine deterministic provider calls.
  Actual signed API acceptance, streamed required input, direct SeaweedFS PUT
  and immutable finalize, Docker execution, replay and exactly-one balanced
  capture/earning/fee all passed. Delivered file: 112 bytes, SHA-256
  `87389a710018a6a6ffff60c24e70dab5f9d6d2b827f22dabd394d0c966ce21e5`.
  Worker paused/revoked, capability paused, grants/sessions revoked, temporary
  state removed. An initial invocation failed before fixture startup due to a
  concurrent research-broker barrel-export conflict; the owner fixed it and this
  rerun exited 0. Fake payments, deterministic inference and development-only
  scanning remain explicit limitations, not real-provider/public-launch evidence.

## Handoff

```sh
docker build -t kivro-sandbox:2026.8.2 -f security/sandbox/Dockerfile security/sandbox
pnpm worker sandbox approve-image
pnpm worker sandbox self-test
pnpm test:sandbox
pnpm worker doctor
```

Rebuilds change the pinned image ID. Explicitly approve the final image and
restart the paired worker to load current host code. This implementation did
not stop or modify the parent's paired worker state.
This batch rebuilt and promoted the sandbox but did not install a service.
Rebuild the unsigned private-beta source/dependency archive after these final
host and sandbox changes. No paired demo state was modified by this batch.

Scoped verification commands:

```sh
pnpm exec vitest run packages/crypto packages/job-protocol packages/openclaw-adapter apps/worker
pnpm --filter @kivro/worker --filter @kivro/openclaw-adapter --filter @kivro/job-protocol --filter @kivro/crypto typecheck
pnpm exec eslint apps/worker packages/openclaw-adapter packages/job-protocol packages/crypto security
KIVRO_INTEGRATION=1 pnpm exec vitest run tests/integration/worker-protocol.test.ts
```

Exact inference JSON, key handling, approval, test and resource/connector
configuration are in `docs/OPENCLAW_COMPATIBILITY.md`. No dedicated seller key or
isolated local model has been supplied. Real provider execution and live Stripe
payment/delivery remain **unverified and blocked by operator configuration**.
The deterministic local fixture tests generated delivery and exactly-one local
settlement, but does not prove provider quality/cost, external payment acceptance,
the background reconciler or production malware scanning. Readiness never uses
the test fixture as a production substitute.

Adapter limits: 16 MiB input/output, 8 MiB per generated file, 20 files, at least
1024 MiB memory/64 PIDs. Local test-file selections are at most 8 MiB each.
DOCX/XLSX and unsupported media are rejected in advertised contracts before
approval/test execution, not merely at file runtime. Arbitrary exec, seller
native plugins and unrestricted network are intentionally unsupported. No
global dependency installation occurred. Transitive image dependencies are not
rebuild-reproducible; approve/promote the exact reviewed image digest.
Dependency-bearing SKILL imports now support approved broker references, never
native executable copying or personal credential reuse. Safe metadata inventory
and observed reports exist; automatic local-model discovery, precise skill
invocation, complete graphical import/review and broad dependency taxonomy
remain incomplete M02/M03 work, not post-MVP waivers. Native personal
plugins/browser sessions and arbitrary host execution
are intentionally unsupported under the MVP security policy.

## Next MVP Gaps

- R12 media owner delivered validators/tests and the seven new advertised formats;
  Worker contract tests are aligned. Office/GLB remain unsupported by this adapter.
- R15 named checks are implemented. Exhaustive fresh-host OS/Docker/storage
  fault acceptance and real service login/reboot remain unverified.
- R16 combined prepared-DB + reviewed-public research through the full signed
  API passed using actual restricted synthetic Postgres, HTTPS, Docker/OpenClaw
  and exact local settlement. No live search-provider credential test.
  Hardened local egress is not final cloud
  research placement. R17 network metadata is local audit, not cloud cost/UI.
- R21 host/real-runtime repair passed;
  approved signed cumulative budget plus actual lower-budget expiry/cancellation
  pass. Feynman's actual API reservation/release/settlement matrix passed on the
  candidate, now promoted to default. Existing-worker reapproval and final
  artifact/fresh-clone rollout verification remain with parent. See above.
- OpenAI-compatible and native Anthropic are implemented, but neither has live
  dedicated-seller credential acceptance yet. Anthropic extended/always-on
  thinking and multimodal/server tools are intentionally unsupported by this
  reviewed bridge. Provider onboarding remains explicit, never `.env` copying.
- Direct network transfer now streams, but container result frames and JSON
  validation retain bounded buffers. No claim of unrestricted large-media support.

## Changed Paths

- `apps/worker/package.json`, `tsconfig.json`, `src/`: CLI, runtime, state,
  credentials, transport/inference, readiness, capability consent/health/testing,
  resource/connector/tool integration, result projection and tests.
- `packages/openclaw-adapter/package.json`, `tsconfig.json`, `src/`: discovery,
  process/Docker isolation, policy/config mapping, file checks, adapter and tests.
- `packages/job-protocol/package.json`, `tsconfig.json`, `src/`: signatures,
  shared manifest hashing, notice/payload verification and fixtures/tests.
- `packages/crypto/package.json`, `tsconfig.json`, `src/`: Ed25519, hashes,
  authenticated encryption and tests.
- `security/sandbox/`: Dockerfile/denylist, runner, isolation/media probes,
  reviewed plugin and deterministic real-runtime smoke harness.
- `scripts/e2e-research-fixture.ts`: parent-authorized new acceptance script;
  no existing shared fixture/root script edits.
- `docs/WORKER-STATUS.md`, `docs/OPENCLAW_COMPATIBILITY.md`, `docs/coverage-worker.json`.

Current native-Anthropic/R15 batch specifically changed:
`apps/worker/src/{anthropic,inference-protocol,inference,inference.test,diagnostics,diagnostics.test,readiness,transport,index,runtime,validation}.ts`,
`packages/openclaw-adapter/src/policy.ts`, `security/sandbox/smoke.ts` and the
three owned documentation files above. No root/schema/API/package/lock edits.

This bounded batch's concrete source changes are `apps/worker/src/imports.ts`,
`imports.test.ts`, `service.ts`, `service.test.ts`, `file-transfer.ts`,
`transport.test.ts`, `transport.ts`, `http.ts`, `index.ts`, `capabilities.ts`,
`capability-health.ts`, `runtime.ts`, `secrets.ts`, `validation.ts`;
`packages/openclaw-adapter/src/discovery.ts`, `discovery.test.ts`, `files.ts`;
`security/sandbox/smoke.ts`; and the three owned docs above. Parent separately
added the Worker production tsx dependency/package-lock updates for deployment.

Latest bounded batch additionally changes Worker research-config/research-usage,
tools/observations/diagnostics and their tests, runtime/state/validation/health,
adapter discovery/Docker/process/policy/result handling and tests, sandbox
runner/plugin/observations module/Dockerfile/denylist/research-smoke/smoke, and
these three owned docs. Exact files are under the owned directories above.
The explicitly authorized cross-owner cancellation patch touches only
`packages/research-broker/src/egress.ts` and `test/egress.test.ts`, with broker
owner review. Package manifests export source. No root/shared contracts,
policy, infrastructure, API/storage or lockfile was edited by this batch.
