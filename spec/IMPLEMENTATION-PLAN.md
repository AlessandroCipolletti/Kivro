# Kivro Implementation Plan for Codex

> Execute milestones in order unless dependencies explicitly permit parallel work. The Master Spec is authoritative; this file controls sequencing, not scope.

## Global Definition of Done

A milestone is complete only when:

1. Every mapped requirement is classified in `COVERAGE.md`.
2. Required production behavior is implemented; mocks are not accepted as production substitutes.
3. Unit/integration/E2E tests appropriate to the milestone pass.
4. Typecheck and lint pass.
5. Security invariants are not weakened.
6. Relevant UI is reviewed at desktop and mobile sizes.
7. Any deviation is recorded in `DECISIONS.md` and must not contradict the Master Spec.

## Milestones

### M00 — Repository bootstrap & engineering contract

- **Master Spec coverage:** §40, §49, §51, §52, §53, §54, §55, §56, §57, §58, §59, §60, §84, §85, §86, §87, §88, §89, §90, §91, §92, §93, §94, §95
- **Requirements:** 77 mapped requirements
- **Depends on:** none

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 77 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

### M01 — Domain model, accounts & shared contracts

- **Master Spec coverage:** §4, §8, §9, §23, §53, §54, §120, §163, §192, §299, §300, §301, §302, §303, §304, §305, §306, §307, §308
- **Requirements:** 64 mapped requirements
- **Depends on:** previous foundational milestones as required by code dependencies

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 64 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

### M02 — Kivro Worker foundation & OpenClaw integration

- **Master Spec coverage:** §5, §6, §7, §10, §11, §12, §13, §14, §15, §20, §21, §22, §61, §62, §63, §64, §65, §66, §67, §68, §69, §369, §370, §371, §372 … (+23 sections)
- **Requirements:** 185 mapped requirements
- **Depends on:** previous foundational milestones as required by code dependencies

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 185 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

### M03 — Capability import, dependencies & publishing

- **Master Spec coverage:** §96, §97, §98, §99, §100, §101, §102, §103, §104, §105, §106, §107, §108, §109, §110, §111, §112, §113, §114, §115, §116, §117, §118, §119, §309 … (+47 sections)
- **Requirements:** 207 mapped requirements
- **Depends on:** previous foundational milestones as required by code dependencies

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 207 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

### M04 — Sandbox, permissions & security baseline

- **Master Spec coverage:** §16, §17, §18, §19, §20, §21, §70, §71, §72, §73, §74, §75, §76, §77, §78, §79, §80, §81, §82, §83, §278, §279, §280, §281, §282 … (+16 sections)
- **Requirements:** 145 mapped requirements
- **Depends on:** previous foundational milestones as required by code dependencies

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 145 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

### M05 — Capability I/O, files & assets

- **Master Spec coverage:** §192, §193, §194, §195, §196, §197, §198, §199, §200, §201, §202, §203, §204, §205, §206, §207, §208, §209, §210, §211, §212, §213, §214, §215, §216 … (+20 sections)
- **Requirements:** 110 mapped requirements
- **Depends on:** previous foundational milestones as required by code dependencies

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 110 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

### M06 — Controlled Internet research & resource brokers

- **Master Spec coverage:** §237, §238, §239, §240, §241, §242, §243, §244, §245, §246, §247, §248, §249, §250, §251, §252, §253, §254, §255, §256, §257, §258, §259, §260, §261 … (+16 sections)
- **Requirements:** 106 mapped requirements
- **Depends on:** previous foundational milestones as required by code dependencies

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 106 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

### M07 — Job execution, dispatch, recovery & per-job control

- **Master Spec coverage:** §9, §10, §11, §12, §13, §14, §15, §426, §427, §428, §429, §430, §431, §432, §433, §434, §435, §436, §437, §438, §439, §440, §441, §442, §443 … (+7 sections)
- **Requirements:** 119 mapped requirements
- **Depends on:** previous foundational milestones as required by code dependencies

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 119 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

### M08 — Payments, pricing & seller economics

- **Master Spec coverage:** §24, §25, §278, §279, §280, §281, §282, §283, §284, §285, §286, §287, §288, §289, §290, §291, §292, §293, §294, §295, §296, §297, §298
- **Requirements:** 137 mapped requirements
- **Depends on:** previous foundational milestones as required by code dependencies

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 137 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

### M09 — Availability, scheduling, queueing & future reservations

- **Master Spec coverage:** §26, §396, §397, §398, §399, §400, §401, §402, §403, §404, §405, §406, §407, §408, §409, §410, §411, §412, §413, §414, §415, §416, §417, §418, §419 … (+43 sections)
- **Requirements:** 150 mapped requirements
- **Depends on:** previous foundational milestones as required by code dependencies

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 150 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

### M10 — Marketplace buyer experience & discovery

- **Master Spec coverage:** §28, §29, §120, §121, §122, §123, §124, §125, §126, §127, §128, §129, §130, §131, §132, §133, §134, §135, §136, §137, §138, §139, §140, §141, §142 … (+32 sections)
- **Requirements:** 148 mapped requirements
- **Depends on:** previous foundational milestones as required by code dependencies

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 148 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

### M11 — Marketplace Agent & platform inference

- **Master Spec coverage:** §120, §121, §122, §123, §124, §125, §126, §127, §128, §129, §130, §131, §132, §133, §134, §135, §136, §137, §138, §139, §140, §141, §142, §143, §144 … (+77 sections)
- **Requirements:** 295 mapped requirements
- **Depends on:** previous foundational milestones as required by code dependencies

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 295 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

### M12 — Seller dashboard, Worker health & emergency controls

- **Master Spec coverage:** §369, §370, §371, §372, §373, §374, §375, §376, §377, §378, §379, §380, §381, §382, §383, §384, §385, §386, §387, §388, §389, §390, §391, §392, §393 … (+57 sections)
- **Requirements:** 218 mapped requirements
- **Depends on:** previous foundational milestones as required by code dependencies

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 218 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

### M13 — Buyer REST API, API keys & webhooks

- **Master Spec coverage:** §330, §331, §332, §333, §334, §335, §336, §337, §338, §339, §340, §341, §342, §343, §344, §345, §346, §347, §348, §349, §350, §351, §352, §353, §354 … (+2 sections)
- **Requirements:** 66 mapped requirements
- **Depends on:** previous foundational milestones as required by code dependencies

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 66 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

### M14 — UI design system & product polish

- **Master Spec coverage:** §518, §519, §520, §521, §522, §523, §524, §525, §526, §527, §528, §529, §530, §531, §532, §533, §534, §535, §536, §537, §538, §539, §540, §541, §542 … (+8 sections)
- **Requirements:** 96 mapped requirements
- **Depends on:** previous foundational milestones as required by code dependencies

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 96 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

### M15 — Observability, abuse, privacy & operations

- **Master Spec coverage:** §29, §30, §31, §32, §33, §34, §35, §36, §37, §38, §84, §85, §86, §87, §88, §89, §90, §91, §92, §93, §94, §95
- **Requirements:** 53 mapped requirements
- **Depends on:** previous foundational milestones as required by code dependencies

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 53 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

### M16 — Testing, fixtures, E2E & release gates

- **Master Spec coverage:** §34, §35, §36, §37, §38, §39, §40, §41, §42, §43, §44, §45, §46, §88, §89, §90, §91, §92, §93, §94, §95
- **Requirements:** 51 mapped requirements
- **Depends on:** previous foundational milestones as required by code dependencies

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 51 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

### M17 — Full specification compliance audit

- **Master Spec coverage:** §1, §2, §3, §4, §5, §6, §7, §8, §9, §10, §11, §12, §13, §14, §15, §16, §17, §18, §19, §20, §21, §22, §23, §24, §25 … (+525 sections)
- **Requirements:** 1672 mapped requirements
- **Depends on:** previous foundational milestones as required by code dependencies

**Execution checklist**

- Read the mapped Master Spec sections before coding.
- Inspect current repository state and existing tests.
- Convert the milestone into a concrete task checklist before edits.
- Implement in small, testable increments.
- Update `COVERAGE.md` as evidence is created.
- Run relevant tests/typecheck/lint.
- Perform adversarial review for security/payment/runtime milestones.
- Do not silently defer mapped requirements.

**Acceptance gate**

- All 1672 mapped requirements are accounted for.
- No unexplained `TODO`, `PARTIAL`, or `BLOCKED` item remains for functionality required by this milestone.
- Evidence paths and test paths are recorded in `COVERAGE.md`.

## M18 — Local Development Environment & Full Local E2E

### Goal
Make Kivro reproducibly runnable on a supported developer Mac with production-like local infrastructure and a real host-native Worker.

### Requirements covered
`DEV-LOCAL-001` through `DEV-LOCAL-029`, plus existing storage, Worker, sandbox, payment, job and E2E requirements participating in the local path.

### Required implementation

```text
Docker Compose: PostgreSQL + Redis + MinIO/S3-compatible storage
pnpm dev:setup
pnpm dev
pnpm worker:dev
pnpm dev:demo
pnpm test:e2e:local
migrations + deterministic seed + bucket creation
host-native Worker + real Docker job sandbox + OpenClaw integration
fake dev payment adapter + Stripe test mode
distinct buyer/seller fixtures + correlated logs + health checks + reset commands
```

### Acceptance
Fresh clone → setup → local services → Worker → seller publishes fixture capability → buyer discovers and test-pays → dispatch → sandbox/OpenClaw → output validation/upload → buyer result → seller ledger settles exactly once. Development mode must not weaken security boundaries. Every checkbox in MASTER-SPEC §573 must pass.

