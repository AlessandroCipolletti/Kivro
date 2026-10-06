# OpenClaw Worker Compatibility

## Supported Runtime

OpenClaw **2026.8.2 (0965053)**, host Node >=22.13 with `node:sqlite`,
macOS or Linux, and a working Docker Engine are required. The worker is a
host-native outbound-polling process. Buyer jobs never execute in host OpenClaw.
Discovery reads the installed CLI version and selected personal metadata only;
it never imports auth profiles, environment secrets, personal agents or plugins.

The reviewed architecture uses an **outer Docker security boundary** and
OpenClaw's supported **SSH sandbox backend** inside that container. The SSH
server listens only on the container's loopback address. This is intentional,
not a host fallback or a claim that OpenClaw's nested Docker backend is used.
The container has `--network none`, no host ports, no Docker socket, no provider
keys, no elevated capabilities, a read-only root, bounded tmpfs, CPU/memory/PID
limits and `no-new-privileges`. OpenClaw is non-root. Only per-attempt inputs and
configuration are mounted read-only. No personal workspace is mounted.

Invocation, verified against the installed official CLI and bundled docs:

```text
openclaw agent exec --config /job/config/openclaw.json \
  --message-file /job/input/prompt.txt --cwd /job/work/seed \
  --state-dir /job/work/state --thinking off --code-mode direct \
  --timeout SECONDS --json
```

The Kivro-owned plugin declares `contracts.tools` and `toolMetadata` as required
by this version. Native seller plugins are not loaded. Explicit tool allowlists
are applied to the runtime and sandbox. `tools.profile=full` avoids the CLI's
implicit coding-profile filter for approved plugin tools; it does not remove
the allowlist. Empty-tool capabilities use the minimal profile with its sole
status tool denied. Shell/process/browser/gateway/message tools are denied.

## Build And Verify

Run from the repository root after the parent workspace dependency install:

```sh
docker build -t kivro-sandbox:2026.8.2 -f security/sandbox/Dockerfile security/sandbox
node --import tsx --env-file=.env apps/worker/src/index.ts sandbox approve-image
node --import tsx --env-file=.env apps/worker/src/index.ts sandbox self-test
node --import tsx security/sandbox/smoke.ts
node --import tsx --env-file=.env apps/worker/src/index.ts doctor
```

The Dockerfile pins the Node base digest and OpenClaw release. It installs
OpenClaw under `/opt/openclaw`, not globally on the host. It includes OpenSSH,
Python (required by the SSH filesystem bridge), Blender, ffmpeg and headless
Mesa/EGL libraries required by the Workbench renderer. Build
requires registry/npm/apt access; execution does not. The current image is about
3.3 GB. Transitive npm/apt versions are not reproducibly locked: the local
approval pins the resulting immutable image ID, and tag drift blocks jobs until
explicit reapproval and tests. Production deployment should promote that exact
reviewed image ID rather than rebuild opportunistically.

Self-test reads known canary files on both read-only mounts and requires actual
EROFS/EACCES/EPERM write denial. Missing files are not evidence of isolation. It
also checks UID, capabilities, seccomp, no-new-privileges, no network route,
denied public TCP access, writable bounded tmpfs, SSH, config and plugin loading.
It additionally renders a fixed synthetic 64px Blender scene and transcodes a
fixed short WAV fixture using the same commands as the media wrappers.
The smoke script is test-only: it supplies deterministic inference responses,
never substitutes for a production provider, and is not used by the worker.

## Dedicated Inference

There is no supplied seller key and no installed Ollama. Doctor must remain
unready until the seller configures and tests one of these explicit transports:

- An OpenAI-compatible HTTPS `/v1/chat/completions` provider with a dedicated,
  seller-funded key, tool calling and usage reporting.
- A separately managed local OpenAI-compatible endpoint on **numeric loopback**,
  explicitly approved with `allowLocal:true`. This is not automatic discovery or
  use of a personal service. Even a keyless local model needs a dedicated opaque
  credential reference/token in the worker store; the endpoint may ignore it.

The worker holds the real credential. Inside the network-none container, a
loopback HTTP bridge sends bounded JSON frames over Docker stdin/stdout to the
host broker. The broker fixes endpoint/model, validates all request keys and
tool names, disables provider storage and redirects, pins public DNS addresses,
reserves cost/tokens before sending, caps responses and aborts on cancellation.
DNS shares the request deadline and cancellation; the selected public address
family is pinned so Node cannot switch to an unreviewed resolution path.
No network or host credential is made available to the agent. Inference is a
separate explicitly approved data route; network `NONE` disables research, not
the configured inference broker.

Create an inference config in an operator-selected file, using the exact model
ID and **actual current provider rates**. The rates below are illustrative,
not a provider price quote. Zero rates are appropriate only for a free/local
endpoint. Review every field before approving:

```json
{
  "provider": "openai-compatible",
  "model": "YOUR_PROVIDER_MODEL",
  "baseUrl": "https://YOUR_PROVIDER_HOST/v1",
  "credentialRef": "seller-inference",
  "allowLocal": false,
  "maxCallsPerJob": 8,
  "maxTokensPerJob": 128000,
  "dailyTokenLimit": 500000,
  "maxOutputTokensPerCall": 4096,
  "inputUsdPerMillionTokens": 1,
  "outputUsdPerMillionTokens": 4,
  "maxUsdPerJob": 1,
  "dailyUsdLimit": 10
}
```

For a dedicated local model replace the URL with, for example,
`http://127.0.0.1:11434/v1`, set `allowLocal:true`, set its actual model name,
and use zero monetary rates when appropriate. Nothing installs or starts that
model for you. Private LAN/cloud-metadata endpoints are otherwise rejected.

```sh
node --import tsx --env-file=.env apps/worker/src/index.ts inference configure --file /absolute/path/inference.json
# Review the normalized config and repeat with its printed --approve HASH.
read -r -s KIVRO_DEDICATED_KEY
printf '%s' "$KIVRO_DEDICATED_KEY" | node --import tsx --env-file=.env apps/worker/src/index.ts secret set seller-inference --stdin
unset KIVRO_DEDICATED_KEY
node --import tsx --env-file=.env apps/worker/src/index.ts inference test
```

Do not put keys in capability JSON, chat, command arguments or committed files.
Secrets are AES-256-GCM encrypted with per-record binding. macOS uses a dedicated
Kivro Keychain wrapping key; Linux requires a dedicated 32-byte hex
`KIVRO_WORKER_MASTER_KEY` provided by the operator. There is no plaintext fallback.
The worker never reads personal OpenClaw credentials.

Worker supports **OpenAI-compatible Chat Completions and native Anthropic
Messages**. Both use the same reviewed OpenClaw-to-host frame bridge; Docker
remains network-none and receives only an ephemeral non-provider token.
Platform API provider selection is separate from Worker inference. Adding an
OpenAI or Anthropic key to root `.env` does not authorize Worker use or import it
into Keychain. Explicit `secret set seller-inference --stdin`, endpoint/model
consent and a passing inference test remain mandatory. Credential rotation drops
inference and affected capability proofs; imported dependency hashes must also
be reviewed again. No real seller provider has been tested here.

### Native Anthropic

Use the configuration above with these explicit replacements:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "baseUrl": "https://api.anthropic.com/v1",
  "credentialRef": "seller-anthropic",
  "allowLocal": false
}
```

This is a fragment to replace the corresponding fields, not a complete config.
Keep all budgets and set the actual input/output rates applicable to the chosen
model/account (including any premium pricing). The model is an example of a
non-thinking configuration, not a verified live-account recommendation. Use a
dedicated marketplace-only Anthropic API key and provider-side spend limits.
Do not reuse a personal OpenClaw/Claude credential or a platform Marketplace
Agent key. macOS stores the encrypted seller credential under the dedicated
Kivro Keychain wrapping key; the provider key is never a process argument.

```sh
read -r -s KIVRO_DEDICATED_KEY
printf '%s' "$KIVRO_DEDICATED_KEY" | node --import tsx --env-file=.env apps/worker/src/index.ts secret set seller-anthropic --stdin
unset KIVRO_DEDICATED_KEY
node --import tsx --env-file=.env apps/worker/src/index.ts inference configure --file /absolute/path/anthropic.json
# Review the printed config/hash, then repeat with --approve HASH.
node --import tsx --env-file=.env apps/worker/src/index.ts inference test
```

The seller capability must declare `permissions.inference.provider: "anthropic"`,
the exact configured model and `credentialRef: "seller-anthropic"`, with matching
approved INFERENCE/CREDENTIAL dependency grants and their content-bound imports.
Changing providers requires a new approved immutable capability version and a
passing sandbox capability test; changing `.env` alone cannot switch execution.
The Worker selects its explicitly approved config, even when both provider keys
exist in the platform environment. Only one seller inference config is active
per Worker at present.

The host sends `POST /v1/messages`, `x-api-key` and
`anthropic-version: 2023-06-01`; it maps initial system/developer content to
top-level system blocks and client tool schemas to `input_schema`.
See the [official Messages API](https://platform.claude.com/docs/en/api/messages/create).
Tool history requires unique approved tool IDs and all immediate tool results;
orphan, missing, duplicated or interleaved results are rejected before egress.
See [Anthropic tool-result ordering](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls).

This adapter deliberately supports text and reviewed client tools with
`thinking: disabled`, standard service tier and provider-default sampling only.
Thinking/signature blocks, server tools, images/documents, non-default sampling,
assistant prefill and unknown content/stop reasons fail closed. Truncated output
and provider refusal do not count as successful delivery. Models that require
always-on thinking are not supported by this bridge. These are explicit adapter
limits, not fallback to an OpenAI proxy or host execution.

Native usage counts input, cache-read and cache-write tokens toward the same
token cap. No cache or server tool is requested. Cost reservations nevertheless
use **2x configured input rate** for Anthropic to cover the maximum documented
cache-write multiplier, plus configured output rate. Provider rates remain the
operator's responsibility. See [prompt-cache pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
Reservations survive rejected/failed requests and are not refunded. Successful
reported input/output counts are stored locally by attempt, without prompt,
tool-result or provider-response bodies. No automatic retries add hidden cost.
Authentication, billing/quota, missing-model and unavailable-provider responses
invalidate the health proof and require `inference test` before readiness can
return. Errors and malformed responses expose stable codes, not provider text.
Anthropic has no OpenAI `store:false` request field; configure the dedicated
provider account's data retention policy separately.

Reproducible **test-only**, no paid provider:

```sh
node --import tsx security/sandbox/smoke.ts --anthropic
```

Observed 2026-10-06: real pinned OpenClaw, network-none Docker, imported skill,
resource read, generated mixed file, named no-tools output and process-tree
controls passed; four deterministic execution calls reserved 62,664 tokens.
The loopback provider exists only inside this test script. No native Anthropic
or OpenAI live account has yet been validated.

Token reservations deliberately use UTF-8 request bytes plus framing as a
conservative upper bound, without refunds. OpenClaw tool prompts can be much
larger than buyer input. Use matching manifest and broker limits; 4096 total
tokens is generally insufficient for tool workflows. The 128000 example is a
ceiling, not permission to exceed monetary or daily limits.

## Doctor: Runtime, Device, Clock

`pnpm worker doctor` runs full sandbox probes and persists a structured
PASS/WARN/FAIL report; `health` only reads the cached report. It checks Node
>=22.13.0 with `node:sqlite`, the exact local OpenClaw pin, approved image and
policy-version proof, encrypted secret store and dedicated inference proof.
Personal configuration readability is a separate fail-closed check, using a
bounded read-only scan without importing skills. Database writability is tested
by a write/read/delete transaction; initialization, read-only and write failures
produce redacted structured diagnostics, never automatic deletion/repair.
The CLI/service must use the same supported Node executable. A Node release
without `node:sqlite` cannot even initialize the Worker database; its startup
module error must be resolved before doctor can run.

Paired readiness signs `GET /api/worker/diagnostics/v2` with the dedicated
device identity. The response must match the local Worker UUID and provide
`serverTime`, minimum versions and both bounded revocation lists. This is an
authenticated request over the paired API transport, not a detached server
signature. Production requires HTTPS; local HTTP requires explicit development
mode. V2 also supplies authenticated `sellerId` and `deploymentEnvironment`.
Only HTTP 404 permits fallback to the unchanged legacy `/diagnostics`; a legacy
response has no seller authority and its environment is explicitly `unknown`.
401/403, malformed V2, transport failures and 5xx never downgrade to legacy.
Doctor, cached health, startup and pairing display the API origin and the
server-declared `production|staging|preview|development|test|unknown` label with
verification time. Local `.env` and hostname guesses cannot label a deployment.
Cached labels are bound to the device UUID and API origin, not execution proof.
No heartbeat, re-pair, key import or cloud mutation is performed by doctor.

Minimum and revoked versions are checked against the actual local runtime,
not the API's possibly stale last-heartbeat mirror. A newly paired Worker may
therefore validate before its first heartbeat. Known mirror version reasons
are informational only after the complete policy passes; unknown policy blocks
fail closed. Missing revocation lists (older API), malformed diagnostics,
revoked identity, unsupported minimum-version syntax, or policy failure cannot
establish readiness. Local exact OpenClaw compatibility is never relaxed by
an older cloud minimum. Policy syntax currently supports stable `x.y.z` minima.

Clock checks allow at most **30 seconds including half the request round-trip
uncertainty**, refuse RTT over 10 seconds and detect wall-clock jumps. On auth
401/403 only, an unsigned `/api/health` time may explain skew; it can never prove
device validity or make readiness pass. Worker does not alter the host clock or
offset signed-request timestamps. Enable automatic OS time synchronization,
check API server time and rerun doctor. Network/TLS and malformed provider/API
content are reported as stable codes without raw bodies, keys or private paths.
Unreachable diagnostics blocks new acceptance and explicit resume. Service
login/reboot acceptance and exhaustive OS/config fault coverage remain separate
verification work.

## Sanitized Usage Receipts

Buyer-job inference stores a bounded local ledger of at most 32 admitted calls.
Each reservation is persisted atomically with the daily budget before network
transport, initially unpriced. Only a validated successful provider response
adds reported input/output tokens and an estimate at the snapshotted configured
rates. Local validation failures before reservation do not count as provider
calls. Failed, malformed, cancelled or crash-interrupted calls remain unpriced;
their unknown billable usage is never presented as a known zero charge.

`estimatedCostMicroUsd` sums successful-response tokens at configured base input
and output rates, rounded upward per call using decimal integer arithmetic.
Anthropic input totals include reported cache tokens at that configured base
input rate; this is not a cache-tier invoice reconstruction. Reservations remain
the larger conservative ceiling, including the existing 2x native-Anthropic input
allowance. `costBasis: WORKER_CONFIGURED_RATES` explicitly labels an estimate,
not a provider invoice, actual account bill, payout instruction or buyer charge.

After inference is cancelled/drained (or recovered after a crash), Worker freezes
one `WorkerUsageReceiptSchema` body. Signed `POST /api/worker/jobs/:id/usage` is
queued only after cloud acceptance and a result/terminal acknowledgement. The
receipt contains only attempt ID, provider/model, attempted/successful/unpriced
call counts, reported token totals, estimated/reserved microUSD and cost basis.
No prompts, tool data, keys, credential references, URLs or local paths are sent.
Seller test/health calls have no cloud job attempt and are not uploaded.

Receipt delivery is a separate five-second bounded task, never part of result
settlement or heartbeat/event flushing. Transient failures retain the exact body
with durable 30-second to 30-minute backoff. Explicit receipt conflicts and
permission mismatches stop retrying and retain local rejection metadata; they
never change job state. Lost acknowledgements replay the same immutable body.
Legacy token-only ledgers cannot prove reserved cost/admitted calls and emit a
local unavailable diagnostic instead of fabricating historical receipts.

`apps/worker/src/usage.test.ts` exercises successful/unpriced accounting, exact
rounding, admission caps, crash recovery without inference replay, receipt order,
slow-upload independence, retry persistence, permanent rejection and real signed
loopback delivery. No real provider invoice reconciliation has been performed.

## Pair, Approve, Test, Start

```sh
node --import tsx --env-file=.env apps/worker/src/index.ts pair PAIRING_CODE
node --import tsx --env-file=.env apps/worker/src/index.ts scan
node --import tsx --env-file=.env apps/worker/src/index.ts import --file /absolute/path/import-plan.json
# Review every dependency/instruction and repeat with --approve REVIEW_HASH.
node --import tsx --env-file=.env apps/worker/src/index.ts capability approve --file /absolute/path/capability.json
# Review and repeat approval with --approve HASH.
node --import tsx --env-file=.env apps/worker/src/index.ts capability test VERSION_UUID --file /absolute/path/test-input.json
node --import tsx --env-file=.env apps/worker/src/index.ts resume --all
pnpm worker:dev
```

The capability file has `capabilityVersionId`, `ioContract`, `permissions`,
`internalInstructions`, `dependencies`, and optional `selectedSkills` names.
Dependencies must be supported, healthy and explicitly approved, with complete
acyclic `dependsOn` closure and scoped grants. Selected skills need matching
`SKILL` nodes with exact contentHash. Consent pins skills, resources and image.
The shared execution hash covers IO, permissions, instructions **and dependencies**.

`capability test` executes real inference, validates output and reports signed
`{manifestHash,passed:true,proof:{sandbox:{imageId,policyVersion,testedAt},inference:{configHash,testedAt}}}`
to `/api/worker/capabilities/:versionId/validation`. It takes the daemon lease;
stop the daemon before testing. It does not purchase, upload or settle a job.
Tests and inference/isolation proof expire after 24 hours. Approval alone never
establishes a ready published binding. Test-input JSON is either the input
object or `{input:{...},assets:[{id,path,filename,mimeType,sha256,sizeBytes}]}` for
explicit local test asset selections. IDs must match FILE/FILES input values.
Selected files are verified, read-only snapshots, never host-executed.
Local selections are capped at 20 files, 8 MiB each and the capability's aggregate
input limit; missing, unrelated, changed, linked or secret-directory files fail
before inference. Approval/testing and recurring health all reject advertised
file formats outside the shared current-worker compatibility set.

Development auto-pair only reads mode-0600 `.kivro/demo-pairing.json` with
`{code,apiUrl,expiresAt}` when `KIVRO_ENV=development`, `DEV_AUTH_ENABLED=true`,
`NODE_ENV!=production` and API URL is loopback. It neither imports credentials
nor silently clears persistent pause. Outside that gate, explicit pairing is
required. Use the same `KIVRO_WORKER_HOME` for all commands.
Startup prints a sanitized `WORKER_STATUS` with readiness, pause, inference and
blocker codes. Changes are reported without repetitive heartbeat output; no
credential, prompt, provider response or personal path is included.

## Explicit Dependency Import

`scan [--config-root PATH]` is read-only. Every discovered item starts unselected.
The optional root selects another local metadata directory; it is not a job
workspace or permission to execute anything there. Native OpenClaw/legacy
Clawdbot JSON5 metadata supports `requires.bins`, `requires.env`, `primaryEnv`
and reviewed command-tool references. A declarative skill can state:

```yaml
---
metadata: {"kivro":{"requires":{"tools":["resource.read"],"resources":["document"],"inference":true,"skills":["helper"]}}}
---
Read the approved document through resource.read and produce the contracted output.
```

`metadata.kivro.requires.domains` can declare explicit public hostnames. Skills
must exist in the scanned skills directory; missing children, cycles, malformed
metadata, symlinks/hardlinks and content changes block import. Native plugins,
installers, arbitrary binaries, personal browser/config dependencies and `anyBins`
alternatives remain unsupported. Reviewed native binary references may map only
`blender -> blender.render`, `ffmpeg -> ffmpeg.transcode`, or
`psql -> resource.query` with an approved named prepared database resource.
Native binary/environment requirements additionally require seller-authored
reviewed instructions, not a claim that the original executable skill is compatible.

Prepare the dedicated inference secret/config/test, sandbox approval/self-test,
and selected resources/connectors before importing. The plan shape is:

```json
{
  "schemaVersion": 1,
  "discoveryHash": "SCAN_APPROVAL_HASH",
  "selectedIds": ["SKILL_ID", "TOOL_ID", "RESOURCE_ID", "INFERENCE_ID", "HELPER_SKILL_ID"],
  "permissions": "REPLACE_WITH_COMPLETE_REVIEWED_PERMISSION_MANIFEST_OBJECT",
  "targets": [
    {"kind":"INFERENCE","ref":"configured"},
    {"kind":"CREDENTIAL","ref":"seller-inference"},
    {"kind":"TOOL","ref":"resource.read"},
    {"kind":"RESOURCE","ref":"document"}
  ],
  "bindings": [
    {"discoveredId":"TOOL_ID","dependencyId":"tool:resource.read"},
    {"discoveredId":"RESOURCE_ID","dependencyId":"resource:document"},
    {"discoveredId":"INFERENCE_ID","dependencyId":"inference"}
  ],
  "adaptations": []
}
```

This is a shape example with placeholders, not executable configuration. Use
actual scan IDs and a permissions object matching the intended capability.
Every discovered required child must be explicitly in `selectedIds`; every
non-SKILL selection must have a type-compatible binding. Additional explicit
targets complete the Worker-side closure, including dedicated credentials.
Targets are `TOOL`, `RESOURCE`, `INFERENCE`, `CREDENTIAL`, `NETWORK`, `CONNECTOR`.
Credential IDs are `credential:REF`; connector IDs are `connector:ID`; database
resources use their approved `dependencyId`. Domain IDs are `domain:HOSTNAME`.
An adaptation is `{skillId,sourceHash,instructions}` bound to the exact source.
Review output includes the full compiled instructions, graph, grants, hashes and
image ID. Re-run with its `--approve HASH`; stale review fails closed. Nothing
copies credentials, shell scripts, installers, native plugins or workspace files.

Imported instructions are a new private snapshot, not an edit to personal
SKILL.md. `SKILL.contentHash` binds compiled instructions; `source` contains the
original content hash, not its private path. The canonical execution manifest
binds all tool/resource/inference/credential revision nodes and closure. Use the
returned graph in capability JSON, with every selected skill name in
`selectedSkills`. Capability review exposes graph suggestions, but their
`approved:false` values still require explicit confirmation.

`import list` reports local references; `import revoke NAME` immediately removes
new-job eligibility and proofs for dependent capabilities. Reimport changes,
credential rotation, broker-config/image/permission changes or graph tampering
invalidate consent/proofs. Review/import again and create a new immutable
capability version when the canonical graph changes, then run capability test.
An unchanged old source file is not continuously read: execution uses the pinned
snapshot, so editing personal files alone cannot silently alter a job. Revocation
stops new acceptance, not an already-running job; cancel that job explicitly.

## Opt-In macOS Service

After pairing and Keychain setup, stop the foreground Worker and run:

```sh
node --import tsx --env-file=.env apps/worker/src/index.ts service install
node --import tsx --env-file=.env apps/worker/src/index.ts service status
node --import tsx --env-file=.env apps/worker/src/index.ts service restart
node --import tsx --env-file=.env apps/worker/src/index.ts service uninstall
```

Only `service install` registers and bootstraps the per-user LaunchAgent under
`~/Library/LaunchAgents/io.kivro.worker.<local-path-hash>.plist`. No automatic
installation occurs. It starts after GUI login and restarts abnormal exits,
with a 30-second throttle; normal `stop --all` exits are not restarted until
explicit service restart or the next login. Installation/restart persist pause;
successful doctor/capability validation and explicit resume are still required.
Docker must be available after login; missing Docker or locked Keychain fails
readiness rather than creating a host fallback.

The plist is mode 0600, owner-checked and hash-bound in local state. Existing
symlinked/writable directories, changed plists, active jobs or a live foreground
lease block unsafe lifecycle actions. Uninstall retains identity, encrypted
secrets, consent, audits and job state. No shell, `.env`, arbitrary environment,
provider/master key, personal configuration or log output is persisted in the
service definition; stdout/stderr go to `/dev/null`, and `logs` reads sanitized
SQLite events. Environment-master-key setups are refused by this macOS service:
use the dedicated Kivro Keychain configuration. The launch paths are absolute;
uninstall and reinstall after moving/updating the private-beta artifact.

Tests use real `plutil` conversion and mocked launchctl operations. **No actual
LaunchAgent installation/login-cycle acceptance has been performed.** This is
an unsigned private-beta source/dependency artifact, not a signed/notarized
public release or a verified public auto-update/rollback system. Section 56
explicitly defers the desktop wrapper; it does not defer background operation.

## Resource And Research Tools

Public names are `read`, `write`, `edit`, `research.search`, `research.fetch`, `research.download`,
`resource.read`, `resource.query`, `connector.call`, `blender.render`, and
`ffmpeg.transcode`. The adapter maps dotted names to OpenClaw underscores.

- `resource approve --file selection.json`, then `--approve HASH`, snapshots
  exactly `{id,path,sha256,maxBytes}`. Only regular, nonlinked, selected UTF-8
  text/Markdown/JSON/CSV files are accepted. Personal secret directories are
  denied. Files are never mounted as raw resources; `resource.read` returns
  a bounded private result through `LocalResourceBroker`.
- `resource configure --file database.json` accepts a `PostgresResource`.
  See `packages/resource-broker/src/types.ts` and `docs/RESOURCE-BROKER.md` for
  fixed tables/columns/filters/schema/limit definitions. Review and repeat with
  the printed approval hash.
  Store the separate least-privilege database password with `secret set REF`.
  A DATABASE dependency must grant the resource and depend on its approved
  CREDENTIAL node. Configuration and operation grants are capability-scoped.
  Readiness uses the broker's bounded `checkHealth()`: fresh authentication,
  read-only-role, table/column privilege checks and PREPARE/DEALLOCATE for every
  granted operation, without executing queries or reading application rows.
- Research requires `network.mode=RESEARCH`, approved tools/domain dependencies
  and authenticated seller authority, never a Worker UUID substituted for seller.
  Search additionally requires a separately approved `research-brave` credential;
  fetch needs no search key. Only entirely PUBLIC-classified inputs without
  skills/assets/private resources can use model-selected public queries/URLs.
  Jobs combining private inputs/resources or skills with research require the
  fixed reviewed prefetch plan below. Private labels are never downgraded.
- `connector configure --file connector.json` accepts a fixed HTTPS GET JSON
  endpoint, `id`, `parameters`, `response`, optional `array`, optional
  `credentialRef`, and `maxResponseBytes`. Parameter/response fields are
  `{type:"string"|"number"|"boolean",required:boolean,maxLength?:number}`.
  No model-selected URL/method/header is accepted. The CONNECTOR dependency's
  `name` is the configured ID and `contentHash` is its printed normalized hash;
  grants include `connector.call` and its fixed hostname. Credential nodes must
  be in dependsOn. Only PUBLIC data is permitted.
- Blender is a fixed one-frame Workbench PNG renderer, `--disable-autoexec` and
  factory startup. ffmpeg uses one fixed H.264/AAC MP4 preset, one thread and
  a 120-second media bound. Both run only inside Docker on declared input asset
  UUIDs. There is no arbitrary command/argument interface.

### Reviewed Public Research With Private Resources

Approve the local capability first, then review fixed public literals:

```sh
pnpm worker research approve --file public-research.json
pnpm worker research approve --file public-research.json --approve REVIEW_HASH
pnpm worker capability test VERSION_ID --file test-input.json
pnpm worker research revoke VERSION_ID
```

Example plan (replace UUIDs/hash and review timestamp with the actual values):

```json
{
  "schemaVersion": 1,
  "capabilityVersionId": "CAPABILITY_VERSION_UUID",
  "dependencyBindingHash": "HASH_MANIFEST_OF_EXACT_DEPENDENCIES_ARRAY",
  "limits": {"maxPages": 1, "maxDurationMs": 10000},
  "sources": [{
    "id": "public-docs",
    "operation": "FETCH",
    "request": {"url": "https://example.com/", "method": "GET"},
    "provenance": {
      "kind": "REVIEWED_PUBLIC_LITERAL",
      "sourceUrl": "https://example.com/",
      "reviewedBy": "AUTHENTICATED_SELLER_UUID",
      "reviewedAt": "2026-10-06T10:00:00.000Z"
    }
  }]
}
```

The dependency hash is shared `hashManifest(dependencies)`. The plan's separate
local approval binds that exact graph, version, authenticated seller and plan
hash; it cannot be changed under the same immutable version. Approval/revocation
invalidates prior capability proof. Revoke cannot be bypassed by a cached plan.
Only the trusted broker compiles the opaque plan capability. It prefetches every
selected source in fixed order while ACCEPTED, before private execution or any
inference. No input/row/file interpolation or model-selected URL reaches that
stage. Afterward the plugin exposes only `{reviewedSourceId}` cache lookups;
private resources remain accessible through their separate narrow broker.

Versioned platform ceilings are 5 searches, 5 pages, 500,000 bytes/response,
5,000,000 total bytes and 60 seconds. Signed
`permissions.network.researchLimits` and reviewed plan limits only narrow these.
Durable job-level reservations survive attempts; failed traffic stays unknown,
not a zero-byte refund. Worker ceilings include 500 requests/day and 30/host/min.
Calls are serialized. A trusted constructor AbortSignal cancels SafeHttpClient
DNS waits and live HTTP requests, including redirect gaps. The effective total
research deadline is armed from the original durable reservation, not reset by
later calls. Job cancellation also aborts it; completed immutable cache reads
remain available after the outbound deadline. OS DNS resolution itself may
finish in the background, but its late answer cannot open a socket.

Sanitized local receipts retain host, operation, status/content type when known,
measured successful bytes, response hash, source/plan binding and timestamps;
they omit raw queries, URLs, bodies, rows and secrets. Direct repeated fetches
attach each hash to exactly one unannotated reservation or fail closed. These
network receipts are local audit, separate from signed inference usage receipts.
Cloud/platform egress remains the preferred later deployment; the current
private-beta broker exposes seller-origin traffic and is not claimed as the
final platform research architecture.

### Scanned Public Downloads

Public file ingestion requires separate explicit consent. Add the tool plus
the versioned network grant to a new capability version, with the corresponding
approved TOOL/domain dependency grants. This example is a permission excerpt,
not a complete manifest:

```json
{
  "tools": ["read", "research.download"],
  "network": {
    "mode": "RESEARCH",
    "allowedDomains": ["www.w3.org"],
    "downloads": {
      "schemaVersion": 1,
      "allowedMimeTypes": ["application/pdf", "image/png"],
      "maxFiles": 2,
      "maxFileBytes": 100000,
      "maxTotalBytes": 200000
    }
  }
}
```

No grant is inferred from ordinary fetch permission. The strict grant supports
PNG, JPEG, WebP, PDF and CSV only, at most 5 files, 500,000 bytes/file and
5,000,000 total bytes. Signed research limits and job input limits may narrow
these. Downloads share the existing research page/byte/time budget; they do
not create another quota. There is no model-selected URL download path, even
when all job inputs are public.

The separately approved public plan uses fixed DOWNLOAD entries:

```json
{
  "id": "public-pdf",
  "operation": "DOWNLOAD",
  "request": {
    "url": "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    "expectedMimeType": "application/pdf",
    "expectedSha256": "3df79d34abbca99308e79cb94461c1893582604d68329a41fd4bec1885e6adb4"
  },
  "provenance": {
    "kind": "REVIEWED_PUBLIC_LITERAL",
    "sourceUrl": "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    "reviewedBy": "AUTHENTICATED_SELLER_UUID",
    "reviewedAt": "2026-10-06T12:00:00.000Z"
  }
}
```

`expectedSha256` is optional; when present, changed content is rejected. The
example digest is an observed fixture receipt, not a promise about a third-party
URL remaining unchanged. This entry belongs in the complete reviewed plan
above, bound to the exact capability dependencies and authenticated seller.
Buyer inputs and private resource values cannot interpolate any part of it.

Configure a dedicated local ClamAV scanner explicitly. Its TCP endpoint is
trusted local configuration, never a job field, and must be numeric loopback.
An operator-selected scanner config file contains:

```json
{"schemaVersion":1,"host":"127.0.0.1","port":63310}
```

```sh
pnpm worker research scanner-configure --file scanner.json
pnpm worker research scanner-configure --file scanner.json --approve REVIEW_HASH
pnpm worker research scanner-test
```

The self-test requires both a clean canary and rejection of the standard
harmless EICAR test string. Its proof expires after one hour; rerun it before
accepting new download jobs. A configuration change invalidates affected
capability proofs. Every admitted file still requires its own clean verdict.
No absent/unreachable/malformed/slow scanner response is treated as clean, and
there is no development bypass. Doctor reports missing configuration/proof;
download capability health fails closed. Ordinary non-download capabilities
do not require this scanner.

For a disposable local verification scanner, the tested official image can be
started explicitly (no host mounts or personal data):

```sh
docker run -d --rm --name kivro-research-scanner \
  --user 1000:1000 --entrypoint /init-unprivileged \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 4g --cpus 2 --pids-limit 128 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=128m,uid=1000,gid=1000 \
  --tmpfs /run/clamav:rw,noexec,nosuid,size=16m,uid=1000,gid=1000 \
  --tmpfs /var/log/clamav:rw,noexec,nosuid,size=16m,uid=1000,gid=1000 \
  -e CLAMAV_NO_FRESHCLAMD=true -e CLAMAV_NO_MILTERD=true \
  -p 127.0.0.1:63310:3310 \
  clamav/clamav-debian@sha256:9bb8712a50f0e75166e936c452cd82dd5e5be0b85586598930b5bbb84a99a578
KIVRO_TEST_SCANNER_PORT=63310 KIVRO_SANDBOX_IMAGE=kivro-sandbox:2026.8.2-download \
  node --import tsx security/sandbox/download-smoke.ts
docker rm -f kivro-research-scanner
```

The pinned scanner above includes the observed 2026-09-28 signature snapshot,
not automatically refreshed definitions. Ongoing deployment requires an
operator-managed update process. Keep its unauthenticated TCP service on
loopback. See the [official ClamAV Docker instructions](https://docs.clamav.net/manual/Installing/Docker.html).

The prelude streams to private quarantine, validates type/size/hash and scans
before inference or private access. Only that exact scanned snapshot is staged
under the read-only job input mount. OpenClaw receives generated
`skills/kivro-public-data/UUID.ext` paths: the pinned official SSH filesystem
bridge protects its skills namespace from writes. These are untrusted data,
not skills (no SKILL.md or executable names); no execute/install tool is added.
Actual OpenClaw read and write-denial are verified by the smoke. Cached
`research_download({reviewedSourceId})` returns only the corresponding descriptor,
scan verdict and provenance, with zero outbound requests after private use.
Source headers never choose filenames. Inputs are never collected as results
automatically. A clean antivirus verdict is not a PDF sanitizer or a guarantee
against every malicious document.

This path needs sandbox download attestation version 1. Default `4cf5b9b2...`
predates it and returns `SANDBOX_DOWNLOAD_UPDATE_REQUIRED` for these capabilities.
Build a separate candidate with
`docker build -t kivro-sandbox:2026.8.2-download security/sandbox`, explicitly
select it using `KIVRO_SANDBOX_IMAGE`, approve its immutable ID and rerun sandbox
self-test before capability validation. Current image receipts and the pending
default promotion are recorded in `docs/WORKER-STATUS.md`; no automatic tag
promotion or existing Worker approval is performed. The standalone download
smoke uses actual HTTPS/ClamAV/OpenClaw and deterministic test inference, not
paid-provider, signed-API settlement or graphical grant-consent acceptance.

### Read-Only Inventory And Test Observations

`scan` additionally reports bounded agent/tool names, MCP server names with
transport/enabled flags, workspace-reference kinds, sandbox mode, and environment
variable names. It never returns their values, workspace paths or file contents,
MCP URLs/commands, credentials or browser state. It does not resolve includes or
environment references, execute MCP, or scan referenced workspaces. These are
metadata only, not importable AGENT/MCP permissions or silent grants.

After a successful seller test:

```sh
pnpm worker capability observations VERSION_ID
pnpm worker capability observations VERSION_ID --approve REVIEW_HASH
```

Reports bind the execution manifest and image ID. They include actual CLI tool
names/aggregate counts, reviewed-plugin completion outcomes, host-confirmed
resource operations, sanitized network metadata and configured inference usage.
OpenClaw 2026.8.2's supported `agent exec` result `toolSummary` is used; its
documented zero-call omission is normalized to zero. Direct plugin completion
records contain no arguments/results. Native tools with only summary evidence
are `OBSERVED` with unknown per-tool outcomes, never invented success counts.
The investigated `after_tool_call` hook registered but did not emit reliable
records in this CLI path, so it is not used and needs no conversation access.
Skills are explicitly `LOADED_NOT_PROVEN_INVOKED`; precise skill invocation is
not claimed. Missing declared dependency bindings block validation, and review
never adds grants. Older pinned images explicitly report unavailable observation
instrumentation; approve the new image and retest to obtain this evidence.

## Results And Controls

Only the fixed sandbox workspace `result/` subtree and fixed wrapper outputs
are collected. Workspaces, logs, sessions, prompts and temporary files are never
uploaded. Paths, link count, MIME signatures, contract types, byte counts,
base64 encoding and uploaded hashes are checked. Limits: 16 MiB aggregate
input/output, 8 MiB per generated file, 20 generated files, 8 path segments.
Publication rejects incompatible limits, memory below 1024 MiB or fewer than
64 PIDs. Contract limits can be lower and remain authoritative.

Supported formats are PDF, PNG, JPEG, BLEND, MP4, WAV, WebP, MOV, WebM, MP3,
M4A, OBJ and FBX, plus TXT, Markdown, JSON and CSV (formula-leading cells rejected).
DOCX/XLSX may be accepted by platform storage but **are not supported by this
adapter's MIME validator**. GLB is also unsupported.
The shared `executionFileCompatibilityIssues` gate rejects these declared
formats at local approval, test preflight and recurring capability health;
adapter environment creation also enforces it. The approval review prints
specific issues. Unsupported content additionally fails before execution/upload
and is never relabeled as a generic binary file.

Buyer inputs now stream from the authenticated API/S3 response into exclusive
read-only local files with incremental byte/hash checks; redirects, overwrite,
corruption, excessive sizes and cancellation fail closed and remove partials.
Outputs use authenticated metadata tickets, then streamed presigned PUT to
quarantine storage with **exact Content-Length** and content type, and finally
authenticated active-attempt finalization. Worker signing/auth headers never go
to storage. Storage destinations require pinned public HTTPS or explicit numeric
loopback in local development; no redirects or arbitrary ticket headers.
Finalized size/hash/MIME/name must match the collected artifact. API finalization
scans and copies to an immutable key, so PUT replay cannot rewrite delivered files.

Transport supports bounded 100 MiB descriptors, but this does not raise the
adapter's advertised limits. Container result frames still buffer at most
8 MiB/file before a private disk spool; JSON input validation retains a bounded
parse buffer. Broad large-media/result-streaming acceptance is still incomplete.

The active execution budget starts at durable local acceptance and covers
payload/setup/inference/execution/output upload. Confirmed Docker pause time is
persisted separately and excluded; pause-request broker drain and the RUNNING
acknowledgement/thaw handshake remain charged. Duplicate commands never restore
consumed time. A validated immutable result queued on time may retry cloud
acknowledgement afterward without rerunning work. Timeout stops broker work and
removes the owned container; cancellation cannot undo already-billed provider work.

The approved pause policy is cumulative per job. API configuration
`KIVRO_MAX_JOB_PAUSE_MS` (1,000..900,000 ms; default 900,000) is snapshotted into
the job and signed `maxPauseMs` field. Worker SQLite stores it immutably and
subtracts prior confirmed pauses. Duplicate commands do not replenish it. The
optional wire field has no schema default: legacy signatures and payload hashes
are verified on original bytes/fields before the Worker applies the shared
900,000 ms fallback. Notice/payload budget disagreement is rejected.

The pinned CLI, generated agent/provider configuration, runner, media wrapper
and internal bridge use finite wall ceilings allowing the active limit plus
that job's pause budget, not a blanket extra execution grant. The CLI accepts
integer seconds, so its ceiling rounds up; host accounting and runner use exact
milliseconds. Host provider/research deadlines are unchanged. Timing attestation
version 2 rejects old images; rebuild, explicit approval and self-test are
mandatory. Installed official `timeout-CuJJ5JYN.js` confirms
that OpenClaw's zero timeout maps to a roughly 24-day timer; this adapter does
not use that setting or patch upstream OpenClaw.

**Not a general FULL_RESUME guarantee:** actual long-pause, cumulative expiry and
cancellation passed on the separate candidate, including Feynman's signed-API
reservation/release/one-settlement fixture. The verified `4cf5b9b2...` image was
promoted without rebuilding to `kivro-sandbox:2026.8.2` at 13:44 CEST on
2026-10-06. Existing Workers still require explicit image reapproval; no saved
approval or daemon was changed by promotion. Evidence uses real Docker/OpenClaw, a
deterministic provider and local fake payments. See `WORKER-STATUS.md`.

The separate `scripts/e2e-research-fixture.ts --run` acceptance uses the existing
synthetic Postgres resource fixture, a fresh explicitly encrypted Worker home,
dedicated deterministic inference, real signed API requests and actual public
HTTPS. It performs no database setup, Next/CORS changes, or background queue
work. Resource setup, when missing, is the opt-in procedure in
`docs/RESOURCE-BROKER.md`; never point it at a personal database. Set
`KIVRO_RESEARCH_FIXTURE_IMAGE=sha256:...` to test an immutable candidate. Coordinate
the shared local API/DB execution slot before running. Actual full-chain acceptance
passed 2026-10-06 at 13:41 CEST on image `4cf5b9b2...`: real restricted Postgres
query, fixed HTTPS prefetch before private access, cache-only lookup and denied
private-derived URL afterward, exact result replay/one balanced local settlement,
unchanged source rows and cleanup. See Worker Status for the receipt and its
deterministic-provider/fake-payment boundary.

Named output fields use a strict raw JSON final response with only declared
`text`, `json`, `fields`; this works without any filesystem/write permission.
With write permission, `result/kivro-result.json` is an alternative metadata
source. FILE/FILES values are relative collected filenames;
the worker replaces them with uploaded asset IDs. The metadata file is not
delivered. MIXED required output includes text and files. JSON output must be
raw JSON, not a Markdown-fenced or prefixed explanation.

`pause --all` immediately persists refusal of new jobs, including while offline;
running jobs continue. `job pause JOB_ID` freezes Docker's full process tree and
drains bounded brokers. `job resume JOB_ID` rechecks readiness. `job cancel JOB_ID`
aborts brokers and removes the owned container. `stop --all` persists pause,
removes every owned active job container and requests daemon shutdown. Remote
global resume cannot clear local pause. An explicit
`job resume JOB_ID --confirm-global-pause` permits only that existing paused job
to resume while local/remote global new-job pause flags remain set. The cloud
equivalent is a signed heartbeat command with `resumeWhilePaused: true` scoped
to `RESUME_JOB` and one job ID. Neither path bypasses security blocks, original
manifest/image consent, readiness or cloud RUNNING acknowledgement. Repeated
resume of an already RUNNING job is a no-op, not another thaw or budget reset.
Crashed attempts are reaped, never re-executed;
durable already-built results retry without rerunning inference. A interrupted
upload without a durable result is failed, not reported as success.

Signed offers contain notices only. Buyer input/instructions/assets are fetched
after durable ACCEPTED acknowledgement, then the full signed payload hash,
attempt, worker, version and manifest are verified before downloads or execution.
The worker claims success only after the API accepts the validated result.
The RUNNING/cloud acknowledgement is awaited before Docker starts; a failed
acknowledgement removes the created container without executing OpenClaw.
