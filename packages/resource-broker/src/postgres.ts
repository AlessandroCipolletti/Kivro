import { createHash } from 'node:crypto';
import pg from 'pg';
import { checkSignal } from './files.ts';
import { ResourceBrokerError, type NamedQuery, type PostgresResource } from './types.ts';

const quote = (identifier: string) => `"${identifier}"`;
const operators = { eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=', like: 'LIKE', ilike: 'ILIKE' } as const;

/** Input is already JSON/schema validated; identifiers only come from validated approval. */
export function prepareQuery(query: NamedQuery, input: Record<string, unknown>, maxRows: number, maxBytes: number): pg.QueryConfig {
  const values: unknown[] = [];
  const where = query.filters.map(filter => {
    const value = input[filter.parameter];
    if (value !== null && !['string', 'boolean', 'number'].includes(typeof value)) throw new ResourceBrokerError('INVALID_INPUT');
    values.push(value);
    return `${quote(filter.column)} ${operators[filter.operator]} $${values.length}`;
  });
  values.push(maxRows); const rowsParameter = `$${values.length}`;
  values.push(maxBytes); const bytesParameter = `$${values.length}`;
  const order = query.orderBy?.map(item => `${quote(item.column)} ${item.direction}`).join(', ');
  // PostgreSQL bounds the entire encoded response before sending any private row.
  // MATERIALIZED preserves the same limited row set for both size checks and output.
  const text = `WITH selected AS MATERIALIZED (
    SELECT ${query.columns.map(quote).join(', ')} FROM ONLY ${quote(query.table.schema)}.${quote(query.table.name)}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${order ? `ORDER BY ${order}` : ''}
    LIMIT (${rowsParameter}::int + 1)
  ), encoded AS MATERIALIZED (
    SELECT pg_catalog.row_to_json(selected)::text AS value FROM selected
  ), metrics AS (
    SELECT count(*)::int AS count, COALESCE(sum(pg_catalog.octet_length(value)), 0) + GREATEST(count(*) - 1, 0) + 2 AS bytes FROM encoded
  ) SELECT count, CASE WHEN count <= ${rowsParameter}::int AND bytes <= ${bytesParameter}::int
    THEN (SELECT '[' || COALESCE(pg_catalog.string_agg(value, ','), '') || ']' FROM encoded)
    ELSE NULL END AS payload FROM metrics`;
  return { name: `kivro_resource_${createHash('sha256').update(text).digest('hex').slice(0, 40)}`, text, values };
}

async function assertReadOnlyRole(client: pg.Client): Promise<void> {
  const role = await client.query<{ safe: boolean }>(`SELECT
    NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
    AND session_user = current_user
    AND NOT pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE,TEMPORARY')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
    AND current_setting('transaction_read_only') = 'on' AS safe
    FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`);
  if (role.rows.length !== 1 || role.rows[0]!.safe !== true) throw new ResourceBrokerError('RESOURCE_DENIED');
}

async function assertQueryAccess(client: pg.Client, query: NamedQuery): Promise<void> {
  const columns = [...new Set([...query.columns, ...query.filters.map(item => item.column), ...(query.orderBy ?? []).map(item => item.column)])];
  const table = await client.query<{ safe: boolean }>(`SELECT
    c.relkind = 'r' AND NOT c.relispartition AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
    AND pg_catalog.has_table_privilege(current_user, c.oid, 'SELECT')
    AND NOT pg_catalog.has_table_privilege(current_user, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT pg_catalog.has_any_column_privilege(current_user, c.oid, 'INSERT,UPDATE,REFERENCES')
    AND pg_catalog.has_schema_privilege(current_user, n.oid, 'USAGE')
    AND NOT pg_catalog.has_schema_privilege(current_user, n.oid, 'CREATE')
    AND (SELECT count(*) FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid
      AND a.attname = ANY($3::text[]) AND a.attnum > 0 AND NOT a.attisdropped) = pg_catalog.cardinality($3::text[])
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
      JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
      WHERE a.attrelid = c.oid AND a.attname = ANY($3::text[]) AND a.attnum > 0 AND NOT a.attisdropped
      AND (tn.nspname <> 'pg_catalog' OR t.typname NOT IN
        ('text','varchar','bpchar','int2','int4','int8','bool','float4','float8','numeric','uuid','date','timestamp','timestamptz','json','jsonb'))
    ) AS safe
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2`,
  [query.table.schema, query.table.name, columns]);
  if (table.rows.length !== 1 || table.rows[0]!.safe !== true) throw new ResourceBrokerError('RESOURCE_DENIED');
}

async function withReadOnlyClient<T>(resource: PostgresResource, password: string, timeoutMs: number, signal: AbortSignal,
  action: (client: pg.Client) => Promise<T>): Promise<T> {
  checkSignal(signal);
  const client = new pg.Client({ ...resource.connection, password,
    connectionTimeoutMillis: timeoutMs, statement_timeout: timeoutMs, query_timeout: timeoutMs,
    lock_timeout: Math.min(timeoutMs, 1000), idle_in_transaction_session_timeout: timeoutMs,
    application_name: 'kivro-resource-broker', client_encoding: 'UTF8',
    options: '-c default_transaction_read_only=on -c search_path=pg_catalog',
  });
  let ended: Promise<void> | undefined;
  const end = () => { ended ??= client.end().catch(() => {}); return ended; };
  // Ending an active pg client destroys its socket, terminating the transaction.
  const cancel = () => { void end(); };
  client.on('error', () => {});
  signal.addEventListener('abort', cancel, { once: true });
  try {
    checkSignal(signal);
    await client.connect();
    checkSignal(signal);
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL search_path = pg_catalog');
    await client.query("SELECT pg_catalog.set_config('statement_timeout', $1, true), pg_catalog.set_config('lock_timeout', $2, true)", [String(timeoutMs), String(Math.min(timeoutMs, 1000))]);
    await assertReadOnlyRole(client);
    const result = await action(client);
    checkSignal(signal);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    checkSignal(signal);
    if (error instanceof ResourceBrokerError) throw error;
    const code = (error as { code?: string }).code;
    const timedOut = ['57014', '55P03'].includes(code ?? '') || (error instanceof Error && error.message === 'Query read timeout');
    throw new ResourceBrokerError(code === '42501' ? 'RESOURCE_DENIED' : timedOut ? 'RESOURCE_TIMEOUT' :
      ['42703', '42883', '42P01', '42804', '42P18'].includes(code ?? '') ? 'RESOURCE_CONFIGURATION_INVALID' : 'RESOURCE_UNAVAILABLE');
  } finally {
    signal.removeEventListener('abort', cancel);
    await end();
  }
}

export async function executePostgres(resource: PostgresResource, query: NamedQuery, input: Record<string, unknown>,
  password: string, maxRows: number, maxBytes: number, timeoutMs: number, signal: AbortSignal): Promise<unknown[]> {
  return withReadOnlyClient(resource, password, timeoutMs, signal, async client => {
    await assertQueryAccess(client, query);
    checkSignal(signal);
    const result = await client.query<{ count: number; payload: string | null }>(prepareQuery(query, input, maxRows, maxBytes));
    checkSignal(signal);
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row || row.payload === null || row.count > maxRows ||
      typeof row.payload !== 'string' || Buffer.byteLength(row.payload) > maxBytes) throw new ResourceBrokerError('RESOURCE_LIMIT_EXCEEDED');
    const data: unknown = JSON.parse(row.payload);
    if (!Array.isArray(data) || data.length !== row.count) throw new ResourceBrokerError('INVALID_OUTPUT');
    return data;
  });
}

export async function checkPostgresHealth(resource: PostgresResource, operations: readonly string[], password: string,
  timeoutMs: number, signal: AbortSignal): Promise<void> {
  const timeout = Math.min(timeoutMs, ...operations.map(name => resource.operations[name]!.limits.timeoutMs));
  await withReadOnlyClient(resource, password, timeout, signal, async client => {
    for (const name of operations) {
      checkSignal(signal);
      const operation = resource.operations[name]!;
      await assertQueryAccess(client, operation);
      // PREPARE parses/analyzes/rewrites the approved SQL, including all columns
      // and operators. No EXECUTE is issued, so no application rows are read.
      const query = prepareQuery(operation, Object.fromEntries(operation.filters.map(filter => [filter.parameter, null])), 1, 1024);
      await client.query(`PREPARE ${quote(query.name!)} AS ${query.text}`);
      checkSignal(signal);
      await client.query(`DEALLOCATE ${quote(query.name!)}`);
    }
  });
}
