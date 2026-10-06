# Deterministic Local Full-Stack Fixture

This is **TEST FIXTURE evidence, not real-provider acceptance**. It does not replace
`test:e2e:local`, real-provider evaluation, Stripe acceptance, or malware-scanner
acceptance. Only inference responses and development payments are deterministic
fixtures. API routes, PostgreSQL transactions, S3 objects, signed worker protocol,
WorkerRuntime, Docker, OpenClaw, approvals and validation are real production code.

## Run

Prerequisites: installed workspace dependencies/generated Prisma client, current
database migrations, the existing local development bucket, running local compose
services, the supported host OpenClaw CLI, and the built
`kivro-sandbox:2026.8.2` image. The fixture does not install, migrate, reset, rebuild,
or overwrite infrastructure. Coordinate migration changes with the API owner.

```sh
node --import tsx scripts/e2e-fixture.ts --run
```

No `.env` is loaded. The script uses only public synthetic infrastructure credentials
already present in `infrastructure/compose.yaml` and `infrastructure/s3.local.json`:
Postgres `127.0.0.1:55432/kivro`, Redis `127.0.0.1:56379`, S3
`http://127.0.0.1:59000` and bucket `kivro-development`. It starts a separate API
listener and deterministic inference listener on OS-assigned loopback ports. It
does not use the running demo API/worker configuration. A root command can invoke
the command above; this sidecar does not modify root scripts.

## Evidence

Each run registers new synthetic seller/buyer accounts, pairs a new device, and
creates a private capability. Worker state and encryption keys are fresh and
temporary. Dedicated inference credentials are random test-only values; no personal
provider credentials, OpenClaw configuration, skills or keychain entries are read
or imported. The supported host CLI is queried only for its version. Docker uses
its normal host connection; the actual sandbox remains network-none.

The fixture invokes the real worker image-approval command, which runs sandbox,
SSH, config and media probes. It invokes inference configure/test with hashed
consent, capability approval and `testCapability`, and only then starts
`WorkerRuntime`. It never writes sandbox, inference or capability pass proofs.
Readiness and API publication must succeed through their normal gates.

A distinct validation file and buyer-uploaded file contain unpredictable byte
markers absent from their initial prompts. The deterministic inference server
requests the normal OpenClaw `read` tool and checks its actual tool-call reply
before deriving a report from the returned marker. It then uses the normal `write`
tool for the report and named output manifest. The purchase runs through real
signed offer acceptance, authorized S3 input download, network-none Docker/OpenClaw,
worker result upload, contract validation and settlement.

The script asserts:

- Required input bytes were returned by the real read tool, for validation and purchase.
- Private capability access is denied before the buyer grant.
- Duplicate job creation returns the same job; exactly one successful worker attempt exists.
- Buyer downloads the generated S3 object and verifies exact content, size and SHA-256.
- Anonymous and seller access to the buyer's generated asset is denied.
- A signed duplicate result submission does not settle twice.
- Buyer/seller wallet deltas match the immutable price snapshot; there is exactly
  one capture, seller earning and platform fee in one balanced ledger transaction.
- The persisted job events include accepted, running, result validation and success.

Requests and bodies are bounded; provider requests are capped at 12, each capability
run at 120 seconds, paid-job polling at 180 seconds, and a ten-minute watchdog asks
the production worker/validation cancellation handlers to stop. Individual Docker
operations retain their production deadlines. No pass is emitted on a failed
assertion, runtime error, timeout, or cleanup error.

## Cleanup And Limits

Cleanup pauses the capability and worker, stops the runtime, revokes the paired
device and buyer capability grant, logs out both sessions, closes listeners and
removes the temporary worker directory. Synthetic DB records, the immutable ledger
and S3 assets remain as auditable evidence under normal retention; no shared DB,
bucket or Docker reset is performed. A failed cleanup reports affected fixture IDs
and action names. Cleanup is checked against persisted device/capability/grant/session
records and the local runtime's pending/active/security state. SIGKILL/power loss
cannot run cleanup: use the local seller/API
administrative controls to pause/revoke the reported fixture device and capability.

The API's background reconciler is off because it would also process unrelated
jobs in the shared development DB. Normal worker polling performs real dispatch;
the fixture does not prove queue reconciliation, webhook delivery, recovery,
scheduled execution, real inference quality/cost, external payments or production
malware scanning. Redis is readiness-checked, not claimed as end-to-end queue proof.
File resource/database broker behavior has its own package tests; this fixture's
required file is a buyer-uploaded asset, not a seller-private resource selection.

The final stdout JSON is labelled `DETERMINISTIC_LOCAL_FULLSTACK_TEST_FIXTURE`,
with `realProviderAcceptance: false`, payment/scanner limitations, actual IDs,
hashes, event names and cleanup outcome. `passed: true` is computed only after all
assertions and cleanup succeed. A script existing on disk is not evidence that a
run passed; retain the actual command output for traceability.

## Executed Evidence

The command above exited **0** on **2026-10-06 at 01:07:05 UTC**, after the final
cleanup assertions were added. This is a historical run receipt, not an input to
validation or a reusable pass proof:

- Fixture: `dc6c9cef-3d7a-4320-b787-32ad28b2734e`.
- Job: `d09ba72a-fc2b-461e-afc3-5883c0f61612`.
- Worker: `8140fda7-0733-42be-9e65-6e81f836b908`, subsequently paused and revoked.
- Sandbox image: `sha256:96dd4f5334bf57fea81af17192864ae57e0f520aa492afb8591ad7fd7077ae52`.
- Nine deterministic inference requests: one real broker health request, four
  capability-validation turns, four purchased-job turns.
- Delivered file: 112 bytes, SHA-256
  `c15e195dcb1f629854d8c87b4d6f171a29e4a3d5c265ec49202695afbc4feb5c`.
- One successful attempt; one capture, one seller earning and one platform fee in
  one balanced settlement transaction, unchanged by signed result replay.
- Required-file consumption, private-access denials and persisted cleanup checks passed.

`pnpm exec tsc --noEmit -p tsconfig.tools.json` and
`pnpm exec eslint scripts/e2e-fixture.ts --no-warn-ignored` also exited 0. An earlier
run exposed fixture-side tool-call-ID normalization assumptions; the current
fixture correlates actual assistant/tool history, and the final run above passed.
