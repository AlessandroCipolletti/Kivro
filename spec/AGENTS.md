# AGENTS.md — Kivro Engineering Contract

## Authority

`spec/MASTER-SPEC.md` is the authoritative product and technical specification.

Supporting files:

- `spec/REQUIREMENTS.md` — traceable requirement catalog.
- `spec/IMPLEMENTATION-PLAN.md` — implementation sequencing.
- `spec/COVERAGE.md` — living implementation/test evidence.
- `spec/DECISIONS.md` — durable accepted implementation decisions.

If a supporting file conflicts with `MASTER-SPEC.md`, follow `MASTER-SPEC.md` and repair the supporting file.

## Core instruction

Do not optimize for finishing quickly by reducing scope. Completeness, correctness, security and traceability have priority over implementation speed.

Never silently omit, simplify, reinterpret, postpone or replace a requirement because it is difficult. If blocked, mark it `BLOCKED`, explain why, and continue only where safe.

## Before implementing a milestone

1. Read the milestone in `spec/IMPLEMENTATION-PLAN.md`.
2. Read every referenced Master Spec section.
3. Read every mapped requirement.
4. Inspect existing code/tests before editing.
5. Produce or update a concrete task checklist.
6. Identify security/payment/data-loss risks before implementation.

## During implementation

- Keep `spec/COVERAGE.md` synchronized with actual evidence.
- Use production implementations for required MVP behavior; mocks belong only in tests/dev fixtures.
- Never weaken security boundaries to make a feature work.
- Never fall back from required isolation to host execution.
- Keep financial transitions idempotent and auditable.
- Keep state-machine transitions explicit.
- Validate structured inputs/outputs at trust boundaries.
- Treat buyer inputs, uploaded files, URLs, web content, seller plugins and remote responses as untrusted.
- Preserve immutable historical job/version/price/permission snapshots.
- Prefer deterministic policy code over LLM judgment for security, money, availability, authorization and budgets.
- Do not expose chain-of-thought, secrets, private seller paths, credentials, LAN details or personal OpenClaw data.

## UI implementation

UI quality is part of Definition of Done. Follow the Master Spec design sections. Do not ship generic AI-generated SaaS aesthetics, untouched component-library defaults, decorative gradients/glows, unnecessary cards, or vague AI copy.

Review rendered pages, not only source code. Check desktop and mobile, realistic data, loading/error/empty/long-content states, keyboard access and responsive behavior.

## Required validation after a meaningful implementation unit

Run the relevant subset of:

```text
unit tests
integration tests
E2E tests
typecheck
lint
build
security/adversarial tests
```

Do not mark a requirement `TESTED` unless an actual test or explicit reproducible verification exists.

## Coverage rules

For each completed requirement, record:

```text
status
implementation file(s)
test/evidence file(s)
notes if needed
```

A section-level coverage requirement is not satisfied merely because one sentence from that section was implemented. Re-read the entire source section before marking it complete.

`DEFERRED` is allowed only for functionality explicitly identified by the Master Spec as post-MVP, or after explicit product-owner approval.

## Reviewer mode

After each milestone, perform a fresh adversarial review with this objective:

> Attempt to prove the milestone is incomplete, unsafe, inconsistent with the Master Spec, or insufficiently tested.

Check the original Master Spec rather than trusting `COVERAGE.md`. Fix discovered gaps before closing the milestone.

## Final compliance audit

Before declaring Kivro complete:

1. Re-read the entire `MASTER-SPEC.md`.
2. Independently audit the repository against it.
3. For every requirement classify `PASS`, `PARTIAL`, `FAIL`, `NOT_IMPLEMENTED`, or `UNTESTED`.
4. Do not trust existing coverage claims without code/test evidence.
5. Search for Master Spec sections with no implementation evidence.
6. Run the full automated test suite, typecheck, lint and production build.
7. Run the canonical paid staging E2E between two distinct users.
8. Verify the seller's personal OpenClaw environment remains untouched.
9. Verify payment/settlement happens exactly once.
10. Verify no unexplained required-MVP item remains.

The project is not complete because the happy path works. It is complete only when the Master Spec is accounted for end-to-end.


## Local development contract
Local development is a first-class acceptance target. Preserve `pnpm dev:setup`, Docker Compose PostgreSQL/Redis/S3-compatible storage, host-native Worker execution, distinct buyer/seller identities, real sandbox semantics, strict environment-gating of development payment/auth shortcuts, Stripe test-mode coverage and `pnpm test:e2e:local`. Never create a development shortcut that weakens the production security model. Before marking infrastructure-related work complete, verify MASTER-SPEC §§551–573 and update all `DEV-LOCAL-*` coverage rows.
