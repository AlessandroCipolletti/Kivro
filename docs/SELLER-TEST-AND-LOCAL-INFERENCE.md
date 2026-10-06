# Seller Test Bundles and Local Inference

## Explicit Preview Exchange

The browser-safe `@kivro/contracts/seller-test` contract carries a seller-selected
input fixture and selected file bytes, bound to one saved capability version and
execution manifest hash. It does not carry permissions, credentials, URLs, host
paths, or replacement instructions. The Worker rejects a different or missing
local approval before acquiring its execution lease or contacting inference.

```sh
pnpm worker capability test VERSION_ID --file /absolute/path/preview.json
```

`readSellerTestInput` is used only for this explicit test command. Ordinary
configuration readers retain their existing two-MiB limit. The bundle has reviewed
ceilings of 20 files, eight MiB per file and 16 MiB total input including JSON;
`@kivro/contracts/file-limits` is their common source. Current deployment settings
may lower those limits. Lower file/input limits are enforced before decoding file
bytes, and the legacy explicit local-file fixture uses the same effective limits.
Canonical base64, byte lengths, SHA-256, frozen input constraints and MIME sniffing
are checked before staging read-only input. CLI file reads require a bounded,
regular, singly linked file and reject symlinks or a changed open descriptor.

## Supported Local Metadata

OpenClaw discovery projects only known `ollama` and `lmstudio` provider metadata:
safe literal loopback endpoint, declared model IDs and required service name.
Credentials, authorization options, model paths and other provider config values
are excluded. `localhost` metadata is normalized to literal `127.0.0.1`; includes
and environment references are never resolved.

The read-only Worker discovery probes Ollama `GET /api/tags` and LM Studio
`GET /v1/models`. Without configured known providers it probes only the two fixed
default loopback ports, 11434 and 1234. It does not scan other addresses, copy
credentials, select inference, load models or generate a response. Responses are
limited to 64 KiB and 100 model entries, with a two-second deadline and no redirects.
Hardware requirements remain unknown rather than being inferred from model names.
Discovery availability is not publication readiness.

These metadata routes follow the primary service documentation:
[Ollama model list](https://docs.ollama.com/api/tags) and
[LM Studio model list](https://lmstudio.ai/docs/developer/openai-compat/models).
LM Studio may expose downloaded models with just-in-time loading, so a listed model
is not represented as already loaded.

## Fresh Readiness

An explicitly approved dedicated inference configuration and a matching successful
minimal generation test remain necessary. Every configuration with `allowLocal`
must additionally expose `GET BASE_URL/models`, including a generic compatible
loopback endpoint. The periodic Worker readiness check confirms the exact selected
model through that route using only the approved dedicated credential. A missing
service, missing model, rejected credential, malformed response or redirect blocks
new work. Restoring the service can recover readiness while the existing generation
proof is still valid; polling never creates a new proof or changes grants.

The existing Worker health cycle runs every 30 seconds. Remote paid providers are
not polled by this metadata check. Only sanitized availability, selected-model
availability, timestamp, latency and approved configuration hash are stored.

## Daily Admission

The daily admission check reports UTC date, configured job limit, durable claimed
jobs and remaining capacity. Exhaustion sets readiness false while leaving sandbox
health and active execution unchanged. `refreshDailyAdmission` lets CLI/runtime
owners refresh this inexpensive state between full health polls, preserving other
blockers and recovering at the next UTC day. Invalid configuration or clock status
fails closed and is redacted. A previously accepted paused job may bypass only the
valid exhaustion code `DAILY_JOB_LIMIT_REACHED`, never clock/configuration failures.

## Focused Verification

On 2026-10-06 at 14:49:47 CEST, 177 tests passed across seller-test contracts and
Worker helpers, local inference HTTP fixtures, discovery, inference, imports,
diagnostics and daily admission readiness. Worker and adapter typecheck and owned
lint passed. Local inference tests use synthetic loopback HTTP, including exact
model loss, service disappearance, recovery, redirects and oversized responses;
they do not prove a real installed model or paid provider. Browser, actual Docker,
complete runtime admission and fresh-copy receipts belong to the integration owners.
