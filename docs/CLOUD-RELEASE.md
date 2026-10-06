# Cloud Private-Beta Artifacts

Stop the development web server before building; Next.js development and
production compilation share a build directory.

```sh
pnpm build
pnpm cloud:package
pnpm test:cloud-artifacts
```

Packaging produces `dist/kivro-api-VERSION-PLATFORM-ARCH.tar.gz` and
`dist/kivro-web-VERSION-PLATFORM-ARCH.tar.gz`, each with a SHA-256 checksum.
Archives contain the exact production dependency closure, internal relocatable
symlinks and a per-file `RELEASE-MANIFEST.json`. The API includes its generated
Prisma client/engine and migrations. The web archive includes Next.js standalone
output and browser assets. Use the matching operating system and architecture.

No `.env`, private Worker state or personal credentials are included. The
packager rejects symlinks escaping its staged bundle. The verification command
extracts both archives into a new temporary directory with a separate HOME,
starts the API and standalone web server, and checks API health/config, the web
page and static assets. It does not contact inference or Stripe. It deliberately
does not claim database readiness or a full production deployment acceptance.

Deployment requires operator-provided PostgreSQL, Redis, S3, TLS/reverse proxy,
SMTP, reviewed terms and provider/payment configuration. Apply the included
Prisma migrations using the deployment's controlled migration process before
serving traffic. Do not run local setup against production.

Example process entry points after extracting into separate directories:

```sh
# From api/, using a private operator-managed environment file:
node --env-file=/secure/kivro.env --import tsx src/main.ts

# From web/:
HOSTNAME=127.0.0.1 PORT=3000 node apps/web/server.js
```

`API_INTERNAL_URL` for Next.js rewrites is set **at build time**; the default is
`http://127.0.0.1:4000`. Build with the intended internal API address when the API
and web processes are not colocated. `WEB_ORIGIN` in API configuration must match
the externally visible origin. Neither service should be publicly exposed without
the operator's deployment security controls.

The artifacts are unsigned private-beta builds, not public-release certification.
Remote CI is defined but must actually run before its status can be treated as
release evidence. No signing, infrastructure provisioning or public deployment
is performed by packaging.
