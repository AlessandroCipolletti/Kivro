# Buyer API v1

The stable buyer base path is `/api/v1`. Existing `/api` routes remain compatible
aliases for the web application. Versioning does not create a separate handler,
permission model or idempotency namespace. A repeated purchase key across either
base path refers to the same operation. Successful v1 responses carry
`X-Kivro-API-Version: 1`.

Use `Authorization: Bearer API_KEY` with explicit scopes. API keys cannot access
seller or administrator operations. Browser-cookie mutations additionally require
the configured Origin and reject cross-site requests. Never send an API key to
object-storage URLs or include it in a query string.

| Scope | Operations |
|---|---|
| `capabilities:read` | `GET /capabilities`, `GET /capabilities/page`, `GET /capabilities/:idOrSlug` |
| `jobs:create` | `POST /jobs`, `POST /capabilities/:id/quote`, `POST /jobs/:id/cancel` |
| `jobs:read` | `GET /jobs`, `GET /jobs/:id` |
| `assets:create` | `POST /assets/uploads`, direct signed PUT, `POST /assets/uploads/:id/finalize` |
| `assets:read` | `GET /assets/:id/download` |
| `webhooks:manage` | Endpoint registration, delivery status, test and disabling |

Session-only wallet, key-management and review operations are not promoted to
API-key privileges simply because they have a v1 alias. Accept the current
marketplace terms through the web account before an API-key purchase.

Purchase bodies use capability IDs and asset IDs, never local filesystem paths.
`POST /jobs` requires `Idempotency-Key` (8-200 printable characters). The durable
operation checks the immutable capability version, funding, scheduling, capacity,
current security policy and uploaded-file ownership again before reserving money.

Canonical capability, job and asset schemas live in `@kivro/contracts` and are
checked at the response boundary. Jobs return the exact pinned version and price,
state/payment state, typed named outputs and owner-authorized asset identifiers.
Failed result validation does not become a successful paid job. Error responses
are `{ "error": { "code": "...", "message": "..." } }`; 401/403 indicate
authorization failure, 409 stale/conflicting state, 428 terms acceptance, 429 rate
limits and 503 unavailable required infrastructure. Do not interpret HTTP 200
from a health endpoint as permission to execute a paid job.

Direct-upload tickets return a short-lived signed URL, required headers and
expiry. Upload exact bytes, then finalize. A ticket is not a ready asset. Retry a
409 `UPLOAD_PROCESSING` shortly; successful finalization is idempotent. Expired
tickets require a new upload. Storage transport URLs are temporary and are not
stable resource identifiers.
