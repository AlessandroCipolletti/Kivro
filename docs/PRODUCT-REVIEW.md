# Product Requirement Review

Date: 2026-10-06. Scope: 185 previously unreviewed PRD rows, interpreted against
their complete numbered Master sections, including level-two section1. Catalog
fragments are not standalone requirements. Attached implementation-agent prose
does not override the user's request or runtime security boundaries.

`coverage-product-review.json` records source trace only: 105 IMPLEMENTED,
71 IN_PROGRESS, 5 BLOCKED external acceptance, 4 explicitly post-MVP DEFERRED.
None is promoted to TESTED from file existence or a broad package test count.
The merge tool checks evidence paths and conservatively retains partial claims.

## Concrete Follow-Ups

| ID | Source | Finding and ownership |
|---|---|---|
| PR-A01 | 25; PRD-0039..0041 | Durable daily inference tokens/USD and per-job calls/cost already exist in `apps/worker/src/inference.ts`. A distinct seller-configurable daily job-count ceiling is absent from `WorkerState.claim`. Coordinate the local-state/CLI change with the Worker owner; do not claim the existing cost controls are absent. |
| PR-A02 | 229; PRD-0197 | Buyer preview in `capability-editor.tsx` is display-only, while local `capability test VERSION_ID --file INPUT` executes a reviewed sandboxed seller test. A preview-to-local-test export/execution workflow, including files, remains to be integrated and tested. No unrestricted local HTTP bridge or free paid-job bypass is authorized. |
| PR-A03 | 18; PRD-0031..0038 | Boundary implementations and incident guidance existed, but no consolidated five-actor threat model. `docs/THREAT-MODEL.md` now documents those controls and their limits; it is not a penetration-test certificate. |

The review also references active bounded work: universal response schemas,
structured agent-file matching, public download grants, permission taxonomy,
first-class Worker warnings, shared-device pending admission and precise health
metrics. Their owner receipts and final integrated reruns remain authoritative.

## Scope Decisions

- Master47 explicitly postpones external MCP commerce, hosted execution,
  royalties, other runtimes, hosted browsers and hardware markets. Later
  mandatory REST/agent orchestration is not deferred by that earlier section.
- Master159/162 explicitly require natural-language discovery. The earlier
  section85 advice against early semantic routing cannot remove this scope.
- Stage descriptions, suggested screen labels, retention examples and JSON field
  spellings do not override later fixed-tier contracts or equivalent behavior.
- Sections38/46 and the final review in287 require professional legal/payment
  approval or actual private-alpha demand. Local code/tests cannot manufacture
  those outcomes. The user will supply dedicated `.env` keys later; do not ask
  for personal OpenClaw/Codex credentials or treat fixture calls as live proof.

## Latest Independent Checkpoint

At14:18:12 CEST, the parent integration command passed566 cases across47 files,
and full repository TypeScript checks passed. See `LOCAL-VERIFICATION.md` for
precise synthetic/external boundaries. Current-source browser, runtime, package
and fresh-source acceptance must be rerun after the remaining owner changes.
This review does not establish100% Master completion or release readiness.
