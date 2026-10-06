# Local Resource Broker

Worker import: `import { LocalResourceBroker, hashResourceConfiguration } from '@kivro/resource-broker'`.
The package exports its configuration/request/result types from `src/index.ts`.

Construct one host-side broker with `{resources, approval, secretResolver, budget?}`.
`approval` is the seller-approved immutable snapshot
`{capabilityVersionId, permissions, dependencies, grants}`. Each grant is
`{resourceId, operations, configurationHash: hashResourceConfiguration(resource)}`.
Compute and persist that hash at explicit approval, not on receipt of a job or
sandbox request. Changed configurations need a newly approved version.

Call `broker.execute({jobId, resourceId, operation, input, permissions, dependencies}, signal)`.
The host supplies job identity and the verified offer's permission/dependency
snapshots. Only `{resourceId, operation, input}` may originate in a sandbox frame.
The offer must already match the local approved capability version; never let the
sandbox construct approvals, choose job IDs, reset budgets, or call `close()`.

The result is `{data, metadata: {resourceId, operation, dataClasses:
['SELLER_PRIVATE'], untrusted:true, rows, bytes}}`. Failures throw
`ResourceBrokerError` with a stable, sanitized `code`. No connection settings,
source paths, credentials, SQL or database error details appear in that envelope.
The host must retain taint for the rest of the job and supply it to research and
connector authorization. Sandbox-provided labels cannot clear private-data taint.

DATABASE resources declare a password `credentialRef`, fixed `connection`,
`allowedTables`, and named `operations`. Each named operation declares its table,
columns, parameter filters, ordering, JSON input/output schemas and limits.
There is no caller SQL, table, column, connection or shell-command primitive.
LOCAL_FILE resources declare immutable `selections` and a `read` operation taking
`{selectionId}`. Paths remain in trusted host configuration. Selections and grants
belong to this capability approval, not a global worker resource namespace.

Keep the Docker sandbox at `network:none`; route resource frames through the
existing stdin/stdout bridge. Do not mount source files or pass DB credentials,
connection settings, secrets, or broker configuration into the sandbox.

## Installation

The parent workspace owner must run `pnpm install` to refresh the root lockfile and
link the new workspace package; this task only edits `packages/resource-broker`
and this document. Worker dependencies need `@kivro/resource-broker: workspace:*`.

## Validation

Run `pnpm exec vitest run packages/resource-broker` for unit/security checks.
The opt-in PostgreSQL test exercises real `pg` connections and real database ACLs.
It does not substitute a mock database. The fixture is a separate synthetic database
on the existing development Postgres service; it does not modify Kivro app tables.

```sh
docker compose -f infrastructure/compose.yaml exec -T postgres psql -U kivro -d kivro -f - < packages/resource-broker/test/fixture.sql
KIVRO_INTEGRATION=1 pnpm exec vitest run packages/resource-broker
pnpm exec tsc --noEmit -p packages/resource-broker/tsconfig.json
pnpm exec eslint packages/resource-broker --no-warn-ignored
```

`test/fixture.sql` is the exact, rerunnable infrastructure setup. It creates
`kivro_resource_fixture`, role `kivro_resource_reader` with local-only password
`kivro_resource_local_only`, `resource_fixture.table_a(id,name)` and inaccessible
`resource_fixture.table_b(id,secret)`. Only table A gets SELECT. Database CREATE
and TEMPORARY, schema CREATE, table writes, role inheritance and privileged role
attributes are denied. Role defaults include read-only transactions, statement
and lock timeouts, and a connection limit of four. This password is synthetic
test data; production passwords must come from the worker secret resolver.

The default test administrator URL is
`postgresql://kivro:kivro_local_only@127.0.0.1:55432/kivro_resource_fixture`.
Override `KIVRO_RESOURCE_TEST_ADMIN_URL` for a different local port or local admin
identity. The test requires localhost and the fixture database name.

The integration suite verifies table A, SQL-injection parameterization, table B
denial, INSERT/UPDATE/DELETE/TRUNCATE/CREATE/TEMP/COPY/server-file denial, read-only
transaction enforcement even for a privileged role, privileged-credential refusal,
row/byte/schema limits, credential suppression, blocked-query timeouts, cancellation,
and retained budgets after failure. The ACL proof deliberately disables the role's
read-only default before attempting writes, proving grants independently of the
transaction setting. Unit tests exercise immutable snapshots, dependency closure,
operation grants, secret-resolution timeout, concurrent reservations, files,
path traversal, symlinks, hardlinks, content changes, and cumulative job limits.

## Database Configuration

A complete resource configuration for the fixture is:

```ts
import { LocalResourceBroker, type PostgresResource } from '@kivro/resource-broker';

const resource: PostgresResource = {
  id: 'companies', type: 'DATABASE', dependencyId: 'company-database',
  credentialRef: 'company-db-password',
  connection: {
    host: '127.0.0.1', port: 55432, database: 'kivro_resource_fixture',
    user: 'kivro_resource_reader', ssl: false,
  },
  allowedTables: [{ schema: 'resource_fixture', name: 'table_a', columns: ['id', 'name'] }],
  operations: {
    get: {
      table: { schema: 'resource_fixture', name: 'table_a' },
      columns: ['id', 'name'],
      filters: [{ column: 'id', operator: 'eq', parameter: 'id' }],
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['id'],
        properties: { id: { type: 'string', minLength: 1, maxLength: 100 } },
      },
      outputSchema: {
        type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['id', 'name'],
          properties: { id: { type: 'string' }, name: { type: 'string' } },
        },
      },
      limits: { maxRows: 5, maxBytes: 4096, timeoutMs: 2000 },
    },
  },
};

// `approval` is loaded from the trusted capability-version consent record.
// `secrets` is the worker's host-only SecretStore.
const broker = new LocalResourceBroker({
  resources: [resource], approval,
  secretResolver: (ref, signal) => {
    signal?.throwIfAborted();
    return secrets.get(ref);
  },
});
```

The pinned manifest must contain
`{id:'companies',type:'DATABASE',access:'READ_ONLY'}`. Its dependency closure must
include `company-database` of type DATABASE with
`grants:{resources:['companies']}` and `dependsOn:['company-credential']`.
`company-credential` has type CREDENTIAL and
`grants:{credentialRefs:['company-db-password']}`. Both are explicitly approved,
healthy, supported dependencies. Missing children, cycles, duplicate IDs,
unapproved/unhealthy/unsupported nodes, or missing credential grants fail closed.
All required dependencies in the immutable snapshot are checked too.

Named operations use only fixed identifiers, scalar parameter filters and optional
fixed ordering. Supported filters are `eq`, `lt`, `lte`, `gt`, `gte`, `like`, `ilike`.
Input schemas must declare an object with `additionalProperties:false`; schemas
are compiled without coercion/default insertion. There is no raw SQL field, join,
expression, function, caller-controlled limit, offset or generic DB primitive.
The broker generates named prepared SELECTs with bound values and row limits.

Each call uses a dedicated connection, `BEGIN READ ONLY`, a `pg_catalog` search
path, statement/lock/connection timeouts and rollback. The broker verifies role
privileges before querying. The account must have no privileged role attributes,
role memberships, database CREATE/TEMPORARY, table ownership/writes or schema
CREATE. Selected relations must be ordinary tables; views, partitions, inheritance
traversal and non-builtin column types are unavailable. TLS connections require
certificate validation. Host/database/user/TLS settings are trusted seller
configuration and never come from sandbox input; this is not a public web fetch
endpoint, so public-URL SSRF policy does not apply.

Postgres materializes at most `maxRows + 1` selected rows and measures their JSON
size before returning a payload. Oversized results fail without returning partial
private rows. The host validates the returned schema and bounds the final response
including metadata. Closing an active connection cancels database work and rolls
back the transaction. Resolved passwords and configured source paths cannot be
returned as data; arbitrary private contents remain tainted, not reclassified as
safe public output.

## File Configuration

A LOCAL_FILE resource has `id`, `dependencyId`, immutable `selections`, and only a
`read` operation. A selection is
`{id,root,path,sha256,sizeBytes,mimeType}`. Both paths must be absolute, canonical,
and the file must be strictly below its root. Store approved snapshots in a
worker-owned directory with no group/world write access; each file is owned by
the worker, read-only, regular, and has one hardlink. Symlinked roots, ancestors,
final paths, special files and personal-secret locations are denied. Selection
identity, device/inode, size, timestamps and SHA-256 are checked around each
bounded, no-follow descriptor read. UTF-8 text/Markdown/CSV/JSON are supported.

`read` accepts exactly `{selectionId}` and returns
`{selectionId,content,mimeType,sha256}` inside the tainted envelope. Its configured
input/output JSON schemas validate these shapes. Root/source paths never serve
as caller arguments, and selections are included in the approval hash. Changing
a file, selection, operation, schema, database connection or allowlist requires
new seller approval. Existing worker-global file approvals must be captured into
this capability's grant before use.

## Budgets And Host Responsibilities

Defaults per job are 32 operations, 1000 rows, 4 MiB total response bytes, 64 KiB
total input bytes, and 60 seconds from first use. Manifest limits and operation
limits can only tighten these. Each job permits one resource operation at a time;
the broker allows four operations across jobs by default. It retains at most 1000
job ledgers and refuses new jobs when full. There is no eviction or reset method
that could replenish an existing job budget. Supply lower limits through `budget`,
`maxConcurrentOperations`, and `maxTrackedJobs` as needed.

Reservations happen before I/O; successful calls refund unused reserved rows and
bytes. Failed/cancelled operations retain their worst-case reservation. A stuck
secret resolver is signalled and its caller times out; its occupied slot remains
bounded until it settles and it cannot start a DB connection after cancellation.
`close()` aborts active calls and permanently prevents further execution.

Keep the broker alive for the job lifetime, including pauses, and cancel it with
the worker's job signal. Restart/replay prevention and durable attempt identity
belong to the host worker; do not recreate a broker to retry a failed job budget.
Record sanitized `audit` events in the host's durable audit sink. Audit events
contain abstract IDs, operation, outcome, stable code and optional row/byte counts,
never inputs, outputs, paths, secrets or database errors.

The host must validate the approved capability version before routing frames,
retain private output taint even if a model omits it in later requests, deny
private-to-public research egress, and preserve independent connector permissions.
This package implements the local resource boundary; it does not change Docker,
worker transport, publication UI or the Research Broker.

References: MASTER-SPEC sections 14, 71, 90, 102-113 and 261-263;
[node-postgres prepared queries](https://node-postgres.com/features/queries) and
[PostgreSQL read-only transactions](https://www.postgresql.org/docs/current/sql-set-transaction.html).
