# Implementation Status

Updated 2026-10-06. A running local application is implemented. The full supplied
specification is **not certified complete**, and this is not a production release.
The exact evidence and unresolved scope are in `spec/COVERAGE.md` and the scoped
status documents. A TODO row can also mean evidence has not yet been classified;
it must not be silently treated as satisfied.

## Running Locally

`pnpm dev:setup` prepares PostgreSQL, Redis, private S3-compatible storage,
migrations and distinct development accounts. `pnpm dev` starts web and API.
The main browser is normally http://localhost:3000. See `README.md` for commands.
Nothing starts buyer execution in personal OpenClaw, and fake credits never
substitute for actual Worker readiness or a sandbox boundary.

## Implemented Surfaces

- Marketplace, detail, search/filter, favorites, buyer forms and file uploads.
- Accounts, scoped/revocable API keys, seller workspace, administrator controls.
- Immutable capability versions, typed input/output contracts, explicit dependency
  grants, permissions, availability schedules, preview and publication gates.
- Durable jobs, signed post-acceptance payloads, capacity admission, reservation,
  result validation, private file delivery and append-only financial ledger.
- Host Worker identity/consent, encrypted dedicated credentials, replay protection,
  durable controls and network-isolated Docker/OpenClaw execution.
- Controlled research/connectors, read-only private-resource operations and
  narrow approved rendering/transcoding tools.
- Separate platform inference, buyer-approved multi-step plans, frozen contracts,
  file provenance, revision checks and bounded plan repair.
- Development bootstrap/health/reset, local fixtures and layered verification.

These are descriptions of implemented boundaries, not claims that every feature
within a broad specification section or every external acceptance case passed.

## External Acceptance

- No dedicated seller inference credential/model has been supplied. A complete
  paid buyer-file -> real model -> generated file -> ledger run has not passed.
  `pnpm test:e2e:local` rejects missing readiness rather than mocking success.
- No dedicated platform inference configuration was supplied. The fallback is
  catalog discovery only; it does not fabricate approved paid plans.
- Stripe test-account Checkout, Connect, transfers/payouts and real signed webhook
  delivery have not been verified with operator-owned credentials. Financial
  integration tests use real PostgreSQL and controlled provider responses.
- Real outbound buyer-webhook delivery, production malware scanning, deployment,
  monitoring, backups and clean-OS/volume bootstrap remain acceptance work. The
  Master does not require a second physical Mac.
- Actual deterministic multi-seller PDF execution and seven runtime fault cases
  have passing scoped receipts. These do not replace external-provider acceptance
  or demonstrate every possible failure/recovery combination.

The separately labelled deterministic full-stack fixture does pass actual
required-file local validation/publication, paid development-credit execution,
private S3 delivery and exactly-once ledger settlement with cleanup. It verifies
the integration path without substituting for the external acceptance above.

## Current Integration Work

At14:46 CEST the complete local-service integration suite passes594 cases and
the preceding default suite passes1427 cases. There are25 source migrations.
These counts identify dated source checkpoints, not a full release certification.

Implemented and exercised API boundaries include seller capacity configuration,
shared-device scheduled fairness, availability analytics, bounded offline wait
reasons, immutable buyer/seller/financial/job-pause snapshots, strict response
contracts, signed Worker warnings, attachment authorization, settlement recovery,
durable object publication and separate execution containment. First publication
now requires explicit local-execution consent and freezes runtime/dependency
evidence. Historical evidence is not fabricated.

Platform execution-file settings are centralized in contracts/file-limits and
may only lower reviewed bounds. API admission rejects oversized inputs before
funds move; Worker input staging and output collection apply the same ceilings.
The effective limits are exposed separately from immutable capability contracts.
The new lower-limit paths have API/S3 and adapter checks.

Current remaining implementation/acceptance work is explicit: finish the complete
selective seller import workflow and its portable inventory exchange; finish
local-inference discovery/fresh readiness, portable package/test-bundle CLI and
UI integration, pre-publication economics, uncertainty display, dated schedule
preview and nonblocking update/recommendation labels. Several of those scoped
helpers already pass tests but are not yet integrated browser workflows.

The reviewed-public binary download image, new canonical trace metadata and the
latest frontend must pass their actual runtime/browser checks, then fresh-copy
bootstrap and release archives must be regenerated. Earlier Docker, long-pause,
media, private-DB/public-research and browser receipts remain valid only for the
recorded source/image checkpoints in LOCAL-VERIFICATION. None establishes a
newer source state automatically.

Consult `REMAINING-REQUIREMENTS.md`, `API-STATUS.md`, `WORKER-STATUS.md` and
`WEB-STATUS.md` for the exact current evidence boundaries. Invoice/infrastructure
costs and confirmed network egress remain unknown unless measured, not fabricated.
Legal/public-release conditions are distinct from missing private-beta code.

Independent P1 findings are tracked in `INDEPENDENT-AUDIT.md`; fixes are accepted
only with new evidence, not by erasing their historical reproduction. The audit
and all module status files are snapshots, not a security certification.

## Evidence Rules

`LOCAL-VERIFICATION.md` distinguishes unit tests, real PostgreSQL/S3 tests,
deterministic inference through actual Docker/OpenClaw, browser UI fixtures and
real-provider acceptance. These layers are not interchangeable.

`pnpm coverage:merge --apply` merges reviewed owner evidence conservatively.
`pnpm coverage:audit` checks all Master section mappings, IDs, statuses and existing evidence paths.
`pnpm coverage:audit --release` also refuses any requirement not TESTED or
explicitly authorized DEFERRED. A regular audit pass is not release approval.
