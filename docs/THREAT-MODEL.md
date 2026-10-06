# Kivro Threat Model

Scope: private-beta control plane, dedicated seller Worker, approved OpenClaw
runtime and isolated job execution. This is a design/source review, not a proof
that all attacks are impossible. Master18 defines five relevant adversaries.

## Assets and Boundaries

Protect buyer funds, result integrity, private input files, seller credentials,
personal OpenClaw state, local resources and third-party systems. Treat buyer
text/files, model output, public webpages, imported skills and network responses
as untrusted. Authenticated seller declarations are permissions, not evidence
that arbitrary seller-controlled hardware is trustworthy.

Cloud authentication and the financial ledger are distinct from signed device
identity. A job's immutable version, permission manifest and price snapshot are
checked again at dispatch/acceptance. Private job data is withheld until the
current paid attempt is accepted. Revocation/expiry invalidates access.

## Adversaries

| Actor | Attack surfaces | Implemented controls | Residual limits |
|---|---|---|---|
| Malicious buyer against seller | Prompt injection, personal files/cookies, DB credentials, resource exhaustion | Strict input contracts; separate job state; mandatory Docker boundary; no personal mounts; read-only root; dropped capabilities; no-new-privileges; bounded CPU/memory/PIDs/time/output; dedicated inference budgets; explicitly approved resource brokers | Prompt delimiters are only defense in depth. Container/kernel vulnerabilities and malicious host administrators remain outside this guarantee. |
| Malicious buyer against third parties | Seller-IP proxying, SSRF, spam, arbitrary browsing/posting/purchases | No unrestricted shell/browser/network; brokered allowlisted destinations and operations; DNS/address/redirect checks; research prefetched before private access; abuse limits; category/device/dispatch kill switches | Destination operators can serve hostile data. Reviewed endpoints and network infrastructure still require operational monitoring. Public downloads use distinct reviewed grants, not arbitrary buyer URLs. |
| Malicious seller against buyer | Copying plaintext, deceptive results, malware, retaining files, intentional failure after reading input | Accurate seller-hardware disclosure; scoped data release; output contract/hash/MIME/size and production malware checks; verified delivered-job reviews; dispute/refund/report workflows; explicit retention | The seller controls the physical machine and can observe authorized plaintext. Isolation is not confidential computing, objective result-quality proof or prevention of out-of-band copying. |
| Malicious skill/plugin or supply chain | Host execution, hidden dependencies, changed instructions, malicious upgrades | Read-only selective discovery; reviewed dependency closure; pinned hashes; explicit local consent; revalidation after changes; separate marketplace configuration; unsupported plugins/commands rejected; approved runtime image identity | Approved code can still contain vulnerabilities. Dependency updates, release provenance and supported runtime changes require fresh review and tests. |
| Compromised marketplace | Forged dispatch, altered manifests, metadata leakage, mass access to sellers | Local dedicated secret store; signed expiring notices; buyer/account/device scopes; local approved-manifest comparison; no cloud DB passwords; local pause independent of cloud; short-lived accepted-attempt access | A stolen platform signing key is a serious incident, not made harmless by signatures. Local consent and broker limits constrain authority but do not establish trusted cloud behavior or protect already disclosed data. |

## Control Locations

- Local consent and runtime: `apps/worker/src/capabilities.ts`, `imports.ts`,
  `state.ts`, `runtime.ts`, `inference.ts`, `secrets.ts`.
- Sandbox/policy and signed protocol: `packages/openclaw-adapter/src/docker.ts`,
  `policy.ts`, `packages/job-protocol/src/index.ts`.
- Resources/research: `packages/resource-broker`, `packages/research-broker`,
  `apps/worker/src/tools.ts`, `resources.ts`, `research-config.ts`.
- Cloud authorization, admission and containment: `apps/api/src/auth.ts`,
  `jobs.ts`, `worker.ts`, `security-policy.ts`, `job-containment.ts`.
- Files and finance: `packages/storage`, `apps/api/src/asset-uploads.ts`,
  `assets.ts`, `packages/billing/src/ledger.ts`, `apps/api/src/payment-reconciliation.ts`.

## Verification and Operations

Use the exact scoped receipts in `LOCAL-VERIFICATION.md`, `SECURITY-REVIEW.md`
and owner status documents. Unit mocks, synthetic PostgreSQL/HTTP fixtures and
actual Docker probes establish different facts. Development-only malware status
is not a production scan. Real provider/Stripe credentials and external security
review remain separate acceptance requirements.

Never copy personal credentials into marketplace configuration, weaken a failed
manifest check, or delete financial evidence to make a test/reconciliation pass.
Follow `INCIDENT_RESPONSE.md` for containment and key rotation. Follow
`DATA-HANDLING.md` for actual retention boundaries, including backups and copies
already downloaded by authorized users. Revisit this model whenever adding a
tool, resource type, provider, network authority or execution runtime.
