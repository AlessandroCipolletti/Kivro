# Security and File Coverage Review

Review date: 2026-10-06. Scope: the 128 IO-* and SEC-* rows marked TODO in the starting coverage snapshot, across 58 full Master sections. This is an evidence sidecar, not a claim of whole-product security or 100% acceptance.

The original read-only batch wrote only `docs/coverage-security-review.json` and this report. The subsequently authorized, bounded SR-01 implementation and its separate receipt are recorded below. Billing remains frozen; no schema, existing owner/audit sidecars, central coverage, Next services, CORS settings or sandbox images were changed by this task.

## Frozen Billing Handoff

R01-F1 canonical reconciliation was already handed off and frozen before this review: `apps/api/src/payment-reconciliation.ts`, `apps/api/src/billing.ts`, `apps/api/src/background.ts`, `packages/billing/src/stripe.ts`, and `apps/api/test/payment-reconciliation.integration.test.ts`; current financial receipt is in `docs/BILLING-STATUS.md`. The parent independently reran **29/29 isolated PostgreSQL plus synthetic HTTP Stripe SDK cases at 13:24**. This is reported independent evidence, not a billing rerun in this batch. Credentialed Stripe test-mode/provider acceptance remains external; no live/paid requests were made. Ambiguous canonical data remains conservatively held for manual review.

## Inventory and Classification

Starting SHA-256:
- `spec/COVERAGE.md`: `3ce03c46ca3c562809af66472fb87ac4cb92b4e238fdbf2526e6b57811071f54`
- `spec/MASTER-SPEC.md`: `a191b4db071d3d1f6f75341b92a43979d7051f9b00f65757125dc5be0e3cbec9`

Full numbered sections read, not just catalog fragments:
12, 13, 14, 16, 17, 20, 30, 31, 43, 44, 48, 51, 53, 61, 72, 75, 88, 93, 115, 139, 157, 158, 166, 172, 183, 192, 193, 199, 201, 202, 205, 212, 213, 214, 215, 218, 220, 223, 226, 228, 234, 235, 243, 248, 250, 252, 266, 268, 277, 299, 302, 304, 361, 364, 373, 377, 378, 393.

Sections 198 and 224 were additionally checked to resolve conditional format support and semantic-role context. Section 554's local-development template requirements were considered when interpreting section 166. Short extracted clauses such as IO-0100/0101, IO-0124 and SEC-0014/0015 were evaluated as complete surrounding sentences, not isolated fragments.

Sidecar accounting: 61 IN_PROGRESS, 45 IMPLEMENTED, 19 TESTED, 2 DEFERRED, 1 BLOCKED. These are classifications, not completion percentages. **No SECTION_COVERAGE row is TESTED.**

- TESTED: a narrow atomic clause has a named executed assertion, or an explicit reproducible verification recorded here. Transport interception/in-memory tests do not become real network/DB/Docker evidence.
- IMPLEMENTED: concrete source behavior exists, but the complete literal clause was not verified by this batch.
- IN_PROGRESS: known code, display, aggregate acceptance or process evidence is partial; each row names the boundary.
- BLOCKED: only actual external acceptance/provisioning, not implementable code work. The one row is production managed-secret deployment.
- DEFERRED: only the two explicitly future browser-service clauses in section 17. Current MVP browser denial remains required and separately traced.

Each JSON row has existing implementation/test paths and clause-specific notes. Referencing an integration/browser test means it exists, not that it ran. Historical receipts are labelled. Parent should merge conservatively with other owners; this batch does not overwrite the central matrix.

## Confirmed Findings

### SR-01: Header-only MP4 accepted as valid output (original finding; bounded fix verified)

Priority: P1 correctness/acceptance gap. Requirements: IO-0100, IO-0101 (section 215), with partial impact on IO-0007 and file-format aggregates.

Before the fix, `packages/openclaw-adapter/src/files.ts:19` accepted MP4 from the ftyp signature. `packages/storage/src/media.ts:4` omitted legacy .mp4 from its structural movie validation map, so `packages/storage/src/index.ts:56` fell back to file-type recognition. `apps/worker/src/validation.ts` relies on these output validators before recording capability test proof.

Actual read-only reproduction: **a 24-byte file with ftyp only, no moov/tracks/mdat, passes Worker collection, API storage inspection and shared output validation**. It cannot contain a playable video. This directly misses section 215's valid-video-output requirement.

This did not demonstrate code execution, malware, a completed API job, or incorrect ledger settlement. The original MOV/M4A/WebM tests did not cover the legacy MP4 branch. The user subsequently authorized the narrow repair documented below; the original reproduction and observed output are retained as history.

Historical reproduction, run from the repository root before the fix. On the fixed source this command now throws during Worker validation instead of printing the former acceptance result:

```sh
node --import tsx --input-type=module -e '
import {inspectFile} from "./packages/storage/src/index.ts";
import {validateResultFiles} from "./packages/openclaw-adapter/src/files.ts";
import {validateOutput} from "./packages/contracts/src/index.ts";
const b = Buffer.alloc(24);
b.writeUInt32BE(24, 0); b.write("ftyp", 4); b.write("mp42", 8);
b.writeUInt32BE(0, 12); b.write("mp42isom", 16);
const contract = {schemaVersion: 1, inputs: [], output: {
  type: "FILES", description: "Valid video", required: true,
  files: {allowedMimeTypes: ["video/mp4"], allowedExtensions: [".mp4"],
    maxFiles: 1, maxTotalSizeBytes: 1024}
}};
const f = validateResultFiles([
  {path: "empty.mp4", data: b.toString("base64"), sizeBytes: 24}
], contract, 1024)[0];
const output = validateOutput(contract, {assets: [{
  id: "11111111-1111-4111-8111-111111111111", filename: f.filename,
  mimeType: f.mimeType, sizeBytes: f.sizeBytes, sha256: f.sha256
}]});
console.log(JSON.stringify({bytes: b.length, hasTracks: false,
  hasMediaData: false, workerCollected: f.mimeType,
  storage: await inspectFile(b, f.filename, f.mimeType, 1024),
  contractAccepted: output.assets.length === 1}));
'
```

Observed:
```json
{"bytes":24,"hasTracks":false,"hasMediaData":false,"workerCollected":"video/mp4","storage":"video/mp4","contractAccepted":true}
```

### SR-02: Universal crossing-data runtime schemas incomplete

Priority: P2 literal boundary coverage gap. Requirements: IO-0010, IO-0012 (section 53).

`apps/web/src/lib/api.ts:20` returns parsed JSON as generic `T` without runtime validation. `apps/api/src/app.ts` has authentication/security/error hooks, not a universal response-schema serializer; for example, admin Worker responses in `apps/api/src/security-policy.ts` use direct projections.

Input, contract, signed Worker-message and model-tool validation are real and tested. The missing part is the section's universal response boundary, not evidence that existing request authorization can be bypassed. No malformed-response exploit was attempted. Source inspection is the evidence, not a passing test of completeness.

### SR-03: Available file semantic roles are ignored

Priority: P2 contract compatibility gap. Requirement: IO-0117 (section 223); related aggregate IO-0046/0047 remains partial.

`packages/contracts/src/index.ts:51` supports `constraints.semanticType`. `packages/marketplace-agent/src/orchestration.ts:88` compares MIME, extension, cardinality, byte bounds and required named fields, but never reads semanticType. Those other checks have executed named assertions.

The following read-only production-validator reproduction passes a named `product_image` into `reference_image`. Both complete I/O contracts are parsed by IOContractSchema first. There is no quote, purchase, network call or database mutation:

```sh
node --import tsx --input-type=module -e '
import {randomUUID} from "node:crypto";
import {IOContractSchema} from "./packages/contracts/src/index.ts";
import {validatePlan} from "./packages/marketplace-agent/src/orchestration.ts";
import {BuyerConstraintsSchema} from "./packages/marketplace-agent/src/types.ts";
const bounds = {allowedMimeTypes: ["image/png"],
  allowedExtensions: [".png"], maxFileSizeBytes: 1000};
const src = IOContractSchema.parse({schemaVersion: 1, inputs: [], output: {
  type: "FILES", description: "Product image", required: true,
  files: {allowedMimeTypes: ["image/png"], allowedExtensions: [".png"],
    maxFiles: 1, maxTotalSizeBytes: 1000},
  fields: [{key: "image", label: "Image", type: "FILE", required: true,
    order: 0, constraints: {...bounds, semanticType: "product_image"}}]
}});
const dst = IOContractSchema.parse({schemaVersion: 1, inputs: [{
  key: "image", label: "Image", type: "FILE", required: true, order: 0,
  constraints: {...bounds, semanticType: "reference_image"}
}], output: {type: "TEXT", description: "Report", required: true}});
const cap = ioContract => ({
  id: randomUUID(), versionId: randomUUID(), priceTierId: "USD_99",
  visibility: "PUBLIC", seller: {id: randomUUID()}, dependencies: [],
  ioContract, permissions: {network: {mode: "NONE"}, tools: []},
  availability: {status: "ONLINE", canRunNow: true,
    nextAvailableAt: null, reason: null},
  estimatedDurationSeconds: 60, rating: 5
});
const a = cap(src), b = cap(dst), aStep = randomUUID(), bStep = randomUUID();
const result = validatePlan({
  steps: [
    {id: aStep, capabilityId: a.id, capabilityVersionId: a.versionId,
      dependsOn: [], inputMapping: []},
    {id: bStep, capabilityId: b.id, capabilityVersionId: b.versionId,
      dependsOn: [aStep], inputMapping: [{kind: "asset",
        sourceStepId: aStep, targetInput: "image",
        sourceField: "image", assetIndex: 0}]}
  ],
  capabilities: [a, b],
  constraints: BuyerConstraintsSchema.parse({maxTotalSpendMinor: 500}),
  timing: {mode: "IMMEDIATE", maxQueueWaitSeconds: 0},
  now: new Date("2026-10-06T10:00:00Z")
});
console.log(JSON.stringify({
  sourceSemanticType: src.output.fields[0].constraints.semanticType,
  targetSemanticType: dst.inputs[0].constraints.semanticType,
  accepted: result.order.length === 2
}));
'
```

Observed:
```json
{"sourceSemanticType":"product_image","targetSemanticType":"reference_image","accepted":true}
```

This proves absence of comparison, not that every pair of different tags is necessarily incompatible. The Master calls for semantic-role comparison where available; any repair needs an explicit conservative compatibility policy. This is not a permission or private-file-access bypass. Initial reproduction setup errors (an unsupported aggregate file-bound property, then missing PUBLIC fixture visibility) were corrected before the successful production-validator result above; those failed attempts are not passing evidence.

### SR-04: First-class warnings are incomplete

Requirements: SEC-0111/0113 and partial SEC-0065 (sections 115, 377, 378).

`apps/api/src/worker-health.ts` persists status/reason markers and health transition audit records. `apps/web/src/lib/worker-health.ts` and `apps/web/src/components/selling.tsx` preserve security precedence and display status/reasons. They do not provide the complete required warning object with severity, title, description, affected entity, detectedAt, required action and blocking state for all listed warning categories.

Readiness invalidation, security pause and cancellation are implemented separately; incomplete warning presentation does not mean protection waits for seller attention. No browser acceptance of a full warning workflow was run.

### SR-05: Public permission categories collapsed

Requirements: SEC-0092 through SEC-0097 (section 299).

`apps/web/src/components/permissions.tsx` displays AI inference, Internet, aggregate approved read-only seller resources, buyer files and shell. It does not separately identify database access versus selected local dataset/private API access or all external-side-effect/browser indicators. The section's example layout is not itself mandatory; the gap is the incomplete explanation of the capability's actual powers. Immutable internal grants are enforced, but internal enforcement does not complete the buyer-readable explanation requirement. No cross-category permission disclosure exploit is claimed.

### SR-06: General research-file ingestion absent

Requirement: IO-0134 (section 250).

`packages/research-broker/src/broker.ts` returns bounded readable text/HTML with hashes, provenance and untrusted labels. Its supported path is not a general public image/PDF/CSV download-to-job-file pipeline with safe generated names and applicable malware scanning. Unsupported executable/binary content is denied; downloaded text is not automatically installed or executed.

This is a fail-closed feature boundary rather than an unsafe network relaxation. The section introduces public asset downloads conditionally ('may require'); it does not establish that every research capability must accept every binary format. Do not mark all of the download-to-workspace pipeline complete merely because the egress fetch primitive is tested.

## Other Explicit Boundaries

- Large files: direct storage transfers stream, but approved media structure inspection can buffer the full file, with a hard maximum of 100 MiB. Current adapter limits are 16 MiB aggregate and 8 MiB per result file, and framed results use base64. **No constant-memory or arbitrary-large-file claim.**
- Storage economics (section 220): uploaded/retained/granted byte counters and lifecycle timestamps exist. Download authorization is not measured egress; actual storage-duration byte-time and external storage/egress cost telemetry remain partial. Null cost is not zero cost.
- README/architecture (section 48): core boundaries are documented, but all 15 principles are not explicitly enumerated there. Historical milestone process (sections 51/93) cannot be established solely by today's source or test count.
- Managed production secrets (section 166): server-side configuration is not proof of cloud secret-manager provisioning, encryption, least-privilege IAM, rotation or environment isolation. No production secret-manager, client-bundle/image leak or git-history secret audit was run. Nonsecret local defaults in .env.example must be distinguished from actual committed secrets and the separate local-development requirements.
- Arbitrary browser jobs are forbidden now; the controlled browser service is explicitly future conditional scope in section 17. DOCX/XLSX/GIF/FLAC/GLB/GLTF support in section 198 is conditional. Unsupported Worker formats fail closed; their absence is not automatically a current MVP defect.
- The Blender example's 500 MB and 4K values are examples, not mandatory global defaults. Existing deterministic Blender/job and real-codec fixture receipts are historical in this review, not repeated acceptance.
- Structured noNetwork is a real hard filter. Browser access is globally unsupported today, not a separate general buyer forbidden-tools constraint. No future browser constraint is claimed implemented.
- Fixed automatic platform retention is explicitly sufficient for MVP in section 228; buyer-selectable delete-after-success is a possible future option. No missing current control is inferred from that option.
- Full all-format result integrity, all security-trigger combinations and every end-to-end trust boundary remain broader than these targeted tests.

## Executed Verification

All times are Europe/Zurich on 2026-10-06. Receipts are time-bound shared-worktree snapshots; subsequent owners' source changes are not automatically covered.

### Run A: 555 passing tests, 31 files

Started 13:29:59; 2.02 s reported duration. No skipped integration cases are counted as passes.

```sh
pnpm exec vitest run \
  packages/storage/src/storage.test.ts packages/storage/src/media.test.ts \
  packages/openclaw-adapter/src/security.test.ts \
  packages/openclaw-adapter/src/discovery.test.ts \
  packages/openclaw-adapter/src/media.test.ts \
  packages/resource-broker/test/broker.test.ts packages/research-broker/test \
  packages/contracts/src/contracts.test.ts packages/policy-engine/src/policy.test.ts \
  packages/marketplace-agent/test \
  apps/worker/src/security.test.ts apps/worker/src/runtime.test.ts \
  apps/worker/src/state.test.ts apps/worker/src/research.test.ts \
  apps/worker/src/imports.test.ts apps/worker/src/observations.test.ts \
  apps/api/test/security.test.ts apps/api/test/security-policy.test.ts \
  apps/api/test/catalog.unit.test.ts apps/api/test/operations.test.ts
```

Actual boundaries: real synthetic filesystem/link/immutable-selection checks; local SQLite Worker-state fixtures; unit contract/policy/provider fixtures; mocked Docker/process and intercepted HTTP/DNS socket boundaries; in-memory marketplace executors. Research egress tests do not make live SSRF probes. No PostgreSQL, S3, Docker, malware scanner or live inference acceptance is included in this count.

### Run B: 116 passing tests, 15 files

Started 13:31:18; 763 ms reported duration. Diagnostics use ephemeral loopback HTTP and temporary Worker state.

```sh
pnpm exec vitest run \
  apps/web/tests/contract-definition.test.ts apps/web/tests/forms.test.ts \
  apps/web/tests/result-rendering.test.ts apps/web/tests/results.test.ts \
  apps/web/tests/examples.test.ts apps/web/tests/worker-health.test.ts \
  apps/web/tests/dependencies.test.ts apps/web/tests/worker-policy.test.ts \
  apps/web/tests/uploads.test.ts apps/web/tests/plans.test.ts \
  apps/web/tests/agent-recommendations.test.ts apps/web/tests/versions.test.ts \
  security/sandbox/bridge.test.ts apps/worker/src/diagnostics.test.ts \
  apps/worker/src/cli-controls.test.ts
```

The initial restricted run at 13:31:04 had 87 pass/29 fail because binding 127.0.0.1 returned EPERM in diagnostic tests. The complete command was rerun with approved local loopback access and passed 116/116. The first attempt is not silently discarded or treated as a product failure. Rendering tests use React server rendering, not a browser.

Combined successful receipt: **671 passing tests across 46 disjoint files**, plus the two manual production-validator reproductions above. No typecheck/build/full-suite/DB/browser/Docker/live-provider/malware-scanner acceptance was run in this coverage batch. In particular, the existing asset upload integration suite was not run because it changes shared S3 CORS.

### Official API Check

For IO-0054/0055/0056, the official [OpenAI Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses) was opened and checked during this review. It recommends Responses for new projects and documents `/v1/responses`, `text.format` and `store:false`; the current platform adapter and its named synthetic wire test use that interface. No API key or provider request was used. This narrow documentation/wire-format evidence does not prove live model reliability or quality.

## Handoff

Confirmed code/presentation gaps were reported during the original read-only review. Only the subsequently authorized SR-01 fix is included here; its bounded acceptance is below. Other findings are assigned elsewhere and are not expanded by this task. Billing stays frozen.

The JSON is scoped to exactly the starting 128 TODO IDs, includes no unrelated requirements, and does not promote entire sections from partial tests. Artifact validation passed: exactly 128 unique requested IDs, valid row fields/statuses, 125 existing evidence paths and zero section-level TESTED rows. Both report reproduction snippets were executed directly from this saved Markdown and returned the displayed results. These artifact checks are separate from the 671 product-test receipt.

Shared-worktree note: the central coverage snapshot matched at the first validation, then was regenerated concurrently; the Master SHA-256 remained unchanged. The observed regenerated coverage SHA-256 was `a6449699fee0173516f519357d8de5d2677c030bc667fa3e7d1af2de8a1ce546`. This review did not edit it. That merge captured an earlier draft: parent should re-merge the final sidecar, notably IO-0125 (fixed automatic retention explicitly permitted for MVP; no missing buyer-selectable control) and IO-0134 (conditional binary-download scope, not an invented universal requirement).

## Authorized SR-01 Fix Receipt

Completed 2026-10-06 at 13:53 Europe/Zurich. The original failed reproduction above is retained; it no longer passes on current source.

Production changes:
- `packages/storage/src/media.ts`: register .mp4 in the structural media map, reuse the bounded MOV/M4A atom/reference/offset/sample validator, allow only explicit MP4 brands, and require at least one video track. No generic parser or codec decoder was added.
- `packages/openclaw-adapter/src/files.ts`: remove the ftyp-only fallback. Both buffer/result validation and full approved input-file sniffing now use the shared MP4 structure checks. Existing API `inspectFile` automatically uses the same map; no API mutation changed.

Focused tests/fixtures:
- `packages/storage/src/media-test-fixtures.ts`: authored structural MP4 and eight negative bodies (ftyp-only, missing moov, no tracks, missing/empty mdat, audio-only, external reference, invalid sample offset).
- `packages/storage/src/media.test.ts`: storage and shared validator rejection; brand/video-track checks.
- `packages/openclaw-adapter/src/media.test.ts`: Worker buffer, full-file input, result projection and directory collection rejection; valid MP4 and corruption in metadata after 64 KiB.
- `packages/storage/src/media-fixtures.ts`: actual FFmpeg ordinary and fast-start H.264 MP4 generation in the existing policy-checked, network-none sandbox. Existing MOV/M4A and other media fixtures retained.
- `packages/openclaw-adapter/src/media.integration.test.ts`: actual generated bytes/hash checks at both production validation boundaries, explicit moov-before/after-mdat layouts, and three corrupted-real-MP4 regressions.

Commands actually run:
```sh
pnpm exec vitest run packages/storage/src/storage.test.ts packages/storage/src/media.test.ts packages/openclaw-adapter/src/security.test.ts packages/openclaw-adapter/src/media.test.ts
pnpm --filter @kivro/storage typecheck
pnpm --filter @kivro/openclaw-adapter typecheck
env KIVRO_MEDIA_INTEGRATION=1 KIVRO_SANDBOX_IMAGE=sha256:4cf5b9b2b420774d780acfef09fe2d1ce9ff73d60f29c7ffb69b0c1a0bf91c7f pnpm exec vitest run packages/openclaw-adapter/src/media.integration.test.ts --maxWorkers=1
```

Results:
- **78/78 focused tests** in four files at 13:51:48: storage 3, structural media 33, adapter media 20, adapter security 22.
- **14/14 real FFmpeg/Blender tests** at 13:53:32 using the explicit inspected immutable image ID above. The earlier default-tag run also passed 14/14 at 13:52:01; these are the same cases, not 28 distinct tests.
- Both package typechecks passed; adapter typecheck was repeated after final integration-layout assertions.
- No image build/promotion, network use from the container, host bind mounts, buyer/personal data or provider credentials. Fixtures and temporary files are synthetic and cleaned up.

The original exact 24-byte body was rechecked independently after the fix:
```json
{"bytes":24,"workerSniff":"UNSUPPORTED_MOVIE_CONTAINER","workerResult":"UNSUPPORTED_MOVIE_CONTAINER","storage":"Media failed bounded structural validation"}
```

These failures occur in storage inspection and Worker result/input validation, before an accepted asset/result can proceed toward delivery. **No billing mutation, actual settlement, capability publication or full OpenClaw/API/S3 job was rerun for this repair.** The 92-case focused receipt is not added to the earlier 671 as though disjoint. Validation remains bounded structural inspection, not proof of every codec bitstream's decodability, and buffers the approved full media file under the existing <=100 MiB cap. Whole section-215 coverage remains conservative; the specific SR-01 header-only bypass is fixed.
