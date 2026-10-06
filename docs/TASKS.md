# Implementation And Acceptance Checklist

- [x] Read product overview, architecture, local acceptance, constraints and milestones.
- [x] Inspect repository and developer prerequisites.
- [x] Implement local workspace, real PostgreSQL/Redis/S3 bootstrap and seeded identities.
- [x] Implement buyer/seller/admin web surfaces, shared contracts and durable API.
- [x] Implement isolated host Worker, resource/research brokers and signed execution.
- [x] Implement ledger, result validation and explicit buyer-approved plan repair.
- [x] Pass unit, real-service integration, browser and production-build checks.
- [x] Pass deterministic full-stack required-file execution and exactly-once settlement.
- [x] Final hardening: explicit purchase plan revision, typed bounded queue estimate,
  and provider-verified dispute closure with audited account restoration.

The milestones below remain open under the supplied full requirement-level
Definition of Done. Implemented surfaces above are not wholesale milestone
certifications. Exact evidence is in COVERAGE and LOCAL-VERIFICATION.

Current completion pass (implementation in progress, not release acceptance):

- [x] Account profile/password lifecycle and encrypted, durable email delivery.
- [x] Seller version history, diff, retirement and guarded reactivation.
- [x] Server-side marketplace filtering, sorting and pagination.
- [x] Explicit, consent-bound Worker skill dependency imports.
- [x] Immutable signed usage receipts and measured/unknown economics separation.
- [x] Revocation at payload/file/result boundaries before maintenance runs.
- [x] Financial-hold-independent operator containment and durable cancellation.
- [x] Durable object publication intent and crash/cleanup retry tests for uploads.
- [x] Durable example copies integrated; scoped API/S3 and browser consent/download tests.
- [x] Worker reviewed-public prefetch, sanitized audit and observed dependencies implemented.
- [x] Readable-config/writable-DB doctor diagnostics and signed environment display.
- [x] Seven-case actual-runtime fault matrix and controlled DAG/PDF fixture receipts.
- [x] Actual browser-to-Worker job and production Redis queue in a clean source copy.
- [x] Explicit currency, immutable financial interpretation and HTTPS staging cookies.
- [x] Development-only fully redacted inference debug diagnostics.
- [x] Immutable configured pause budgets, financial expiry and explicit resume API.
- [x] Historical input contracts and actor/attempt/state transition audit.
- [x] Seller capacity configuration, scheduled admission fairness and window limits.
- [x] Capability availability-duration, median-wait and rejected-capacity analytics.
- [x] Actual long-pause resume across host, OpenClaw and bridge deadlines.
- [x] Canonical billing reconciliation for lost provider notifications and changed transfers.
- [ ] Marketplace agent requirement gaps and final-result provenance.
- [x] Public description/contract/example discovery projection, bounded model context.
- [x] Owner-resolved agent attachment metadata and pre-inference API authorization.
- [x] Structured attachment/output-format matching and semantic pipeline compatibility.
- [x] Universal runtime response contracts shared by API and web.
- [ ] First-class Worker warning records and distinct public permission categories.
- [ ] Reviewed public binary-file ingestion with separate version-bound consent.
- [x] Reject header-only MP4 files at storage and Worker validation boundaries.
- [x] Remaining MVP inventory checked against all 573 authoritative Master sections.
- [ ] Re-run real-service, browser, sandbox and full-stack checks after integration.

Full-section source review follow-ups (these are code/workflow gaps, not missing keys):

- [ ] PR-A01: explicit persistent seller daily job-count ceiling, alongside existing daily inference limits.
- [ ] PR-A02: exact saved buyer preview and selected-file export to the local sandboxed seller test.
- [x] PR-A03: consolidated five-actor threat model with honest hardware/provider limits.
- [ ] Master83: canonical persisted job correlation through HTTP, Worker, OpenClaw, uploads and settlement.
- [ ] Master97/111: explicit local-execution acknowledgement and complete selective import workflow.
- [ ] Master100/109: supported local inference discovery and fresh outage/readiness detection.
- [ ] Master101/105: pre-publication economics and uncertainty distinct from dependency provenance.
- [ ] Master114: inspectable secret-free dependency-aware capability package and reproduction evidence.
- [x] Master32: immutable publication environment/dependency evidence with explicit per-version execution consent.
- [x] Master219: centralized configurable effective file ceilings across API and Worker boundaries; final UI acceptance remains below.
- [ ] Master263: fixed, approved, schema-bound read-only POST connector support.
- [ ] Master371/418/469/492: update recommendation, dated schedule preview, bounded offline waiting and human recommendation labels.

- [ ] M00: workspace, service boundaries, schemas, traceability and CI.
- [ ] M01-M04: accounts, immutable capability contracts, discovery, consent and isolation.
- [ ] M05-M07: assets, brokers, dispatch, recovery and job controls.
- [ ] M08-M11: availability, schedules, billing, marketplace, seller operations.
- [ ] M12-M14: platform inference, orchestration, REST/API keys and webhooks.
- [ ] M15-M16: operations, adversarial tests, UI verification and release checks.
- [ ] M18: reproducible local infrastructure and real OpenClaw E2E.
- [ ] M17: evidence-based audit against all requirements, explicit remaining blockers.

External acceptance needs: functioning Docker daemon, supported OpenClaw,
seller inference credentials/model, Stripe test credentials/webhook secret for
Stripe acceptance. Missing dependencies never authorize insecure fallbacks.
Docker and supported OpenClaw are now verified on this host. Dedicated seller/
platform inference and Stripe credentials remain unsupplied. Additional known
code/product gaps are explicitly listed in implementation-status.md.
