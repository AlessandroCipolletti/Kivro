# Resource Health

The host worker can validate every approved resource before advertising a
capability as ready:

```ts
import { LocalResourceBroker, type ResourceHealthResult } from '@kivro/resource-broker';

const broker = new LocalResourceBroker({ resources, approval, secretResolver });
try {
  const health: ResourceHealthResult = await broker.checkHealth(signal);
  // Only successful completion provides ready:true for this pinned approval.
  recordCapabilityHealth(health);
} finally {
  broker.close();
}
```

`checkHealth(signal?: AbortSignal)` accepts no job ID, sample query values or buyer
data. It returns `{ready:true, capabilityVersionId, checkedAt, resources:
[{resourceId,operations}]}` only after every granted operation passes. Failures
throw the existing sanitized `ResourceBrokerError`; the host must mark the
capability not ready. Missing declared/required resource configurations fail
closed. Do not expose this host-only method as a sandbox tool.

Each pass freshly resolves credentials and authenticates to PostgreSQL. It uses
`BEGIN READ ONLY`, checks role safety, database/schema/table/column permissions,
relation types, all referenced columns and built-in types for each granted named
operation. It then issues `PREPARE` and `DEALLOCATE` to validate the operation's
parameterized SQL, including filter operators, without executing it. No
application rows, parameter values or output data are fetched. Database password
changes, revoked SELECT/schema access, newly granted writes, missing columns and
invalid SQL operators invalidate the next probe.

Approved file selections use the normal no-follow identity, permission,
single-hardlink, content hash, UTF-8 and input/output schema checks. File contents
are inspected locally and discarded; the health result contains no contents,
host paths, credentials, connection details or SQL.

`RESOURCE_HEALTH_TIMEOUT_MS` is a fixed 5000 ms for the entire pass, including
credential resolution. There is one health pass per broker at a time, one DB
connection at a time within the pass, and it shares the broker's
`maxConcurrentOperations` limit with execution. Abort and `close()` cancel active
database work. An uncooperative secret resolver retains its bounded slot until
settled and cannot start database work after cancellation. A health pass neither
consumes nor replenishes a job budget.

Readiness is a point-in-time check. Keep periodic probes and all execution-time
checks; schema, credentials or permissions can change immediately afterward.
Row-dependent output schema validation, data availability, business correctness
and complete paid-job behavior still require representative execution. A
successful probe does not assert those outcomes or bypass runtime limits.

Run the package's unit tests and real local PostgreSQL regressions with:

```sh
KIVRO_INTEGRATION=1 pnpm exec vitest run packages/resource-broker
```

The base fixture is `test/fixture.sql`. Health tests create isolated, randomly
named synthetic roles/tables in that local fixture database and clean them up.
They revoke SELECT, rotate a password after approval, add writes, revoke schema
access and rename a column. A real row-security function raises an error whenever
application rows are read: health succeeds while actual execution triggers it,
proving health does not execute the application query. Lock-based timeout and
cancellation tests use actual PostgreSQL locks. Unit tests cover the fixed total
deadline, shared concurrency, caller cancellation, close, complete resource
configuration, file selections and independent job budgets.

Other broker setup and fixture commands are documented in
`../../docs/RESOURCE-BROKER.md`.

The distinction between preparation and execution follows the
[PostgreSQL PREPARE documentation](https://www.postgresql.org/docs/current/sql-prepare.html).
