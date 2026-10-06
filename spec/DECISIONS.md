# Kivro Architecture & Product Decisions

This is the durable decision log for implementation. It prevents coding agents from silently reinterpreting settled product decisions. `MASTER-SPEC.md` remains authoritative.

## Canonical decisions

### DEC-001 — Kivro is runtime-independent as a brand
OpenClaw is the first supported seller runtime, not the permanent product identity.

### DEC-002 — Seller execution is isolated from personal OpenClaw
Paid jobs execute through the Kivro Worker in a separate minimal OpenClaw environment. Buyers never access the seller's personal OpenClaw session/workspace.

### DEC-003 — Fail closed
No sandbox, incompatible runtime, critical security failure, or missing required dependency means no paid execution. Never fall back to host execution.

### DEC-004 — Capabilities, not remote computer access
Buyers purchase narrow, typed, versioned capabilities. They do not purchase arbitrary shell/browser/network access to seller machines.

### DEC-005 — Explicit dependency consent
Every discovered skill/tool/resource/inference/network dependency must be explicitly approved by the seller before publication.

### DEC-006 — Controlled network access
Public research is mediated and policy-controlled. Private/LAN/localhost/metadata access is blocked. Specialized authenticated APIs use declared typed connectors.

### DEC-007 — Payment before execution
No secured payment or reserved prepaid credits means no paid job dispatch/execution. Settlement happens only after valid delivery.

### DEC-008 — Fixed price tiers
MVP seller pricing uses Kivro-controlled fixed USD tiers with immutable per-job price snapshots.

### DEC-009 — Availability is independent from visibility
A capability may remain public/discoverable while scheduled offline. Humans may schedule future execution; autonomous immediate execution excludes future-only capabilities unless the buyer explicitly permits waiting.

### DEC-010 — Seller retains operational control
Seller can pause all new work and pause/cancel individual running jobs. Local emergency pause must work without cloud connectivity and survive restart.

### DEC-011 — One authoritative I/O contract
The versioned capability I/O contract drives web forms, API validation, agent mapping, Worker validation, file handling, and orchestration compatibility.

### DEC-012 — Versioned immutable publication
Runtime-affecting changes create a new capability version. Historical jobs remain pinned to immutable snapshots.

### DEC-013 — Platform inference and seller inference are separate
Kivro pays for Marketplace Agent inference. Seller capability inference is an explicit seller dependency/cost.

### DEC-014 — Human UI and autonomous orchestration use the same authoritative availability data
Human UI explains/schedules future availability. Autonomous immediate mode hard-filters unavailable capabilities and continues searching alternatives.

### DEC-015 — UI quality is a product requirement
Kivro must use a restrained, intentional, human-designed visual system and explicitly avoid stereotypical AI-generated SaaS aesthetics.

## Decision template

```text
### DEC-NNN — Title
Date:
Status: Proposed | Accepted | Superseded
Context:
Decision:
Consequences:
Master Spec references:
```

Never use this log to override the Master Spec without explicit user/product-owner approval.


## DEC-LOCAL-001 — Docker Compose local infrastructure
PostgreSQL, Redis and S3-compatible storage run locally through Docker Compose; host installs are not required.

## DEC-LOCAL-002 — Host-native Worker
Kivro Worker runs directly on the developer Mac during integration/E2E development to exercise the real seller-device boundary.

## DEC-LOCAL-003 — Real sandbox semantics locally
Development never bypasses sandboxing. Sandbox unavailable means execution unavailable.

## DEC-LOCAL-004 — S3-compatible local storage
Use MinIO or equivalent locally through the same storage abstraction/business flow used for production storage.

## DEC-LOCAL-005 — Two payment development modes
Use a deterministic fake adapter for fast tests and Stripe test mode for Stripe acceptance; development shortcuts cannot be enabled in production.

## DEC-LOCAL-006 — Distinct buyer and seller identities
Even on one Mac, buyer and seller remain separate Kivro authorization identities.

## DEC-LOCAL-007 — Fresh-clone E2E is an engineering acceptance fixture
Maintain a reproducible buyer-to-seller local E2E path including generated-file delivery and ledger settlement.

## DEC-LOCAL-008 — SeaweedFS local S3 service

Date: 2026-10-06
Status: Accepted implementation choice within DEC-LOCAL-004.
Official MinIO container pulls from Docker Hub and Quay returned access errors.
Use pinned SeaweedFS 4.48, with S3 authentication, loopback-only host binding,
persistent Docker volume and the same S3 business flow used by production.
This follows the explicit "MinIO or equivalent" allowance in Master Spec section 555.
Upstream: https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API
