# Kivro architecture

Kivro is a TypeScript pnpm workspace. `apps/web` provides Next.js buyer, seller
and operator views. `apps/api` owns authenticated access, immutable publications,
PostgreSQL transactions, payment state, assets and outbound Worker transport.
`apps/worker` runs on the seller host and delegates every buyer execution to a
separate Docker boundary. The personal OpenClaw directory is only a read-only
discovery source and is never mounted into a job.

Shared `contracts` are runtime validated, versioned and browser safe. The
`policy-engine` is deterministic: input text and inference do not decide financial
authorization, permissions, availability or job transitions. Explicit price tiers
use integer cents and are copied into every job. Schedule windows use IANA timezones
and wall-clock semantics, with overnight ranges and DST handling.

Local PostgreSQL 17, Redis 7 and SeaweedFS S3 run in a Compose project named
`kivro-local`. Host ports bind only to loopback. Application database, queue and
asset code are the same locally and in production. Fake payment and role login
are development-only adapters; they never authorize host execution or bypass
file, ownership or ledger checks.

The API handles durable jobs. Worker offers are signed and pinned to immutable
contract, permission, input and execution attempt snapshots. Device requests
use signatures, timestamps and one-use nonces. Results become billable only
after platform output and asset validation. Failed, cancelled or expired work
releases its reserved credits exactly once.

Platform inference belongs to the Marketplace Agent and is configured separately
from seller inference. A generated plan is data, not an authorization. Purchases
must pass deterministic availability, budget and buyer approval checks.

See the supplied Master Spec for full product scope. Implementation and acceptance
evidence live in `spec/COVERAGE.md` and `docs/implementation-status.md`; the presence
of a package is not evidence that its full milestone is complete.
