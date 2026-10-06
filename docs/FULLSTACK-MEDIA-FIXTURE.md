# Deterministic Blender Full-Stack Fixture

This is deterministic local **TEST FIXTURE** evidence, not real-provider, Stripe,
production malware-scanner, remote Linux CI, or complete R07 acceptance. It targets
the Blender/file-heavy end-to-end item in Master Spec section 235 (partial
IO-0131 evidence). It does not cover the full Contract Builder UI, multi-company
orchestration/PDF/provenance/reviews, or every required/optional field scenario in
IO-0132. The section 199 500 MB/4K example is not claimed by this bounded fixture.

## Run

```sh
node --import tsx scripts/e2e-media-fixture.ts --run
```

Prerequisites: installed workspace dependencies and Prisma client, current local
migrations, existing development bucket, local Postgres/Redis/S3, supported host
OpenClaw version, and the built `kivro-sandbox:2026.8.2` image. The script neither
installs nor migrates/rebuilds/resets infrastructure. It loads no `.env` and uses
only the repository's public synthetic compose credentials: Postgres port 55432,
Redis 56379, S3 59000. API and deterministic inference use separate OS-assigned
loopback ports. No demo Worker or personal OpenClaw/provider configuration is used.

`KIVRO_SANDBOX_IMAGE` may select another locally built compatible image. The tag is
resolved with Docker inspection and checked using `DockerSandbox.create/inspect`
without starting the probe container. Every fixture and real execution thereafter
uses the immutable resolved image ID. Real worker image approval still runs all
production sandbox probes; image inspection is not a substitute for those proofs.
The nine codec-boundary tests likewise resolve the configured/default build tag:

```sh
KIVRO_MEDIA_INTEGRATION=1 pnpm exec vitest run packages/openclaw-adapter/src/media.integration.test.ts --no-file-parallelism
```

## Checklist And Evidence

- Register isolated synthetic seller/buyer accounts; pair a fresh temporary Worker.
- Run actual image/inference approval and capability validation, never fabricate proofs.
- Generate two distinct synthetic `.blend` scenes and reference renders in the
  resolved image, without host mounts or network. Image dimensions are randomized;
  scene colors/geometry differ between validation and purchase. Date, file-path
  and render-time PNG metadata are disabled in these synthetic scenes to make
  exact reference hashes reproducible; production rendering policy is unchanged.
- Grant only canonical `blender.render`, with a required `.blend` input and named
  PNG output. The deterministic provider requests the real `blender_render` plugin
  operation and observes its returned filename before emitting named output JSON.
  No read/write, arbitrary shell, resource or network tools are granted.
- Validate one scene through `testCapability`; publish privately only after real
  readiness/validation gates. Check buyer denial before an explicit capability grant.
- Upload the separate purchase scene through the real API/S3 boundary; download it
  through authorized S3 redirection and verify exact bytes/size/SHA-256.
- Run a purchased job through signed dispatch, WorkerRuntime, network-none
  Docker/OpenClaw and the fixed Blender wrapper, then upload/validate its real PNG.
- Download the result and verify SHA-256, dimensions and nonblank decoded RGB
  pixels against the independently rendered scene reference. Reference hashes and
  image bytes are never supplied to the inference model. PNG decoding uses real
  ffmpeg inside the resolved image, not an authored codec parser.
- Check one successful attempt, duplicate-create identity, signed result replay,
  one capture/earning/fee in one balanced ledger transaction, and exact wallet deltas.
- Drain delivery/usage outboxes and verify persisted cleanup before emitting a pass.

The deterministic provider and fake development wallet funding are explicit test
fixtures. API, database, S3, contracts, consent, worker protocol, runtime, Docker,
OpenClaw, native renderer, result validation and ledger transitions are production
implementations. The small synthetic binary scenes prove a file-consuming job,
not arbitrary untrusted `.blend` safety, large-file throughput or real LLM quality.
No production runtime/plugin/security files or the separate text fixture are edited.

## Bounds And Cleanup

Ten-minute watchdog; capability runs capped at 180 seconds; purchased-job polling
at 240 seconds; individual requests at 20 seconds; provider limited to ten bounded
requests. Each synthetic generation/inspection container has no network or mounts,
one CPU, 1 GiB memory, 128 PIDs and bounded tmpfs/output. Required scenes are under
4 MiB and output under 1 MiB. Image validation is not a constant-memory guarantee.

Cleanup pauses capability/Worker, stops runtime, revokes device and buyer grant,
logs out sessions, closes listeners and removes temporary state. It verifies the
persisted records and reports cleanup failures without claiming a pass. Synthetic
accounts, immutable job/ledger and S3 evidence remain under ordinary retention.
Only invocation-owned fixture containers are removed; no shared reset occurs.
SIGKILL/power loss requires manual pause/revoke using the reported fixture IDs.

The background reconciler is disabled to avoid processing unrelated local jobs.
Redis is readiness-checked, not claimed as queue-recovery evidence. The script
does not replace `test:e2e:local`, real provider acceptance or the media codec tests.

## Executed Evidence

The final full-stack command exited **0** on **2026-10-06 at 09:54:12 UTC**,
including explicit absence checks for fixture generation/decoding containers:

- Fixture: `67eda8c0-837e-4606-b2b2-0c6d3eed67f2`.
- Job: `a6dbd382-b27b-4611-a08f-c5b0f92dac87`.
- Worker: `ba3fb2eb-d21f-4ac9-9e64-569d3eb0619e`, subsequently paused and revoked.
- Resolved image: `sha256:96dd4f5334bf57fea81af17192864ae57e0f520aa492afb8591ad7fd7077ae52`.
  This is a historical local receipt, not a hardcoded image requirement or Linux CI result.
- Required `.blend`: 861,720 bytes; SHA-256
  `10f555a94eb2ffc91c8e699c45b8ab74b5c3b3b35cff61a22d7fcdb02898fd5a`.
- Delivered PNG: 17,902 bytes, 203 by 146 pixels; SHA-256
  `8939c1feb8ddd28c4f29c04a995abb1687e95c186ae714c26392a93ddc0f1b11`.
- Decoded RGB SHA-256:
  `0c0e776562b6a3782911427ee1b825cf3ff7138e65ead953e483717c0499a77a`.
- Five deterministic inference requests: one health, two validation and two purchase.
- Exact reference image/pixels, one successful attempt, one capture/earning/fee in
  one balanced settlement, signed result replay and persisted cleanup all passed.

The portable codec command also passed **9/9** locally with the explicit build
tag `KIVRO_SANDBOX_IMAGE=kivro-sandbox:2026.8.2` at 09:54:33 UTC. Tools and storage
TypeScript checks and focused ESLint exited 0. No remote Linux CI or cloud-package
build was run by this task.

Post-migration rerun: the same full-stack command exited **0** at **10:01:00 UTC**
on 2026-10-06 after the parent applied the execution-revocation/upload-journal
migrations and regenerated Prisma. Job `7408c26e-bbb4-49ec-a899-9b929d80785e`
consumed an 861,720-byte scene and delivered a 200 by 158 PNG (18,765 bytes), with
one balanced settlement after replay and all cleanup checks passing. Input SHA-256:
`20588a314946dd8b0d2f011005ae4fdf8a39d45bc8fd4dbfea05600ca97d01bb`;
output SHA-256: `c4bfab87fceb0abdf5af884aeb25a39b4457ef2c6f595133cdd7b4581df18c1c`;
decoded RGB SHA-256: `0acfc012c2adde321689fc01ac4bdafc2fa1106fb6ce4d7b5eb66e216d4f59e5`.
Image identity remained the resolved ID recorded above. This is a successful
media-path rerun, not additional upload-journal fault/recovery coverage.

Earlier development runs correctly failed on a fixture health-token declaration
and nondeterministic factory-default PNG stamps; they emitted no pass and cleanup
reported no errors. No production check was relaxed to repair those fixture issues.

Stdout carries
`DETERMINISTIC_LOCAL_MEDIA_FULLSTACK_TEST_FIXTURE`, actual IDs, image identity,
input/output/pixel hashes, events, ledger counts and `realProviderAcceptance:false`.
