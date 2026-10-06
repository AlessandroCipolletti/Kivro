import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalResourceBroker, hashResourceConfiguration, type LocalResourceBrokerConfig, type PostgresResource } from '../src/index.ts';
import { configuration, database, request } from './helpers.ts';

const enabled = process.env.KIVRO_INTEGRATION === '1';
const adminUrl = process.env.KIVRO_RESOURCE_TEST_ADMIN_URL ?? 'postgresql://kivro:kivro_local_only@127.0.0.1:55432/kivro_resource_fixture';
function integrationConfig(resource: PostgresResource = database()): LocalResourceBrokerConfig {
  const url = new URL(adminUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/kivro_resource_fixture') throw new Error('LOCAL_RESOURCE_FIXTURE_REQUIRED');
  resource.connection.host = url.hostname;
  resource.connection.port = Number(url.port || '5432');
  return configuration(resource);
}
async function admin(): Promise<pg.Client> {
  integrationConfig();
  const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 2000 });
  await client.connect(); return client;
}
async function reader(): Promise<pg.Client> {
  const config = integrationConfig(), resource = config.resources[0] as PostgresResource;
  const client = new pg.Client({ ...resource.connection, password: 'kivro_resource_local_only', connectionTimeoutMillis: 2000 });
  await client.connect(); return client;
}

describe.skipIf(!enabled)('real private PostgreSQL resource broker', () => {
  it('reads table A through named prepared queries with private taint and no host metadata', async () => {
    const config = integrationConfig(), broker = new LocalResourceBroker(config);
    try {
      const result = await broker.execute(request(config));
      expect(result.data).toEqual([{ id: 'a1', name: 'Allowed company' }]);
      expect(result.metadata.dataClasses).toEqual(['SELLER_PRIVATE']);
      expect(result.metadata.bytes).toBe(Buffer.byteLength(JSON.stringify(result)));
      for (const secret of ['kivro_resource_local_only', '127.0.0.1', 'resource_fixture', 'SELECT', 'connection']) expect(JSON.stringify(result)).not.toContain(secret);
    } finally { broker.close(); }
  });

  it('parameterizes injection, denies writes and raw SQL, and leaves table A intact', async () => {
    const config = integrationConfig(), broker = new LocalResourceBroker(config);
    try {
      expect((await broker.execute(request(config, { id: "a1' OR true; DELETE FROM resource_fixture.table_a; --" }))).data).toEqual([]);
      await expect(broker.execute(request(config, { id: 'a1', sql: 'SELECT * FROM resource_fixture.table_b' }))).rejects.toThrow('INVALID_INPUT');
      for (const operation of ['insert', 'update', 'delete', 'copy', 'execute']) await expect(broker.execute(request(config, {}, operation))).rejects.toThrow('RESOURCE_DENIED');
      expect((await broker.execute(request(config))).data).toEqual([{ id: 'a1', name: 'Allowed company' }]);
    } finally { broker.close(); }
  });

  it('proves actual role ACLs deny table B, DML, DDL, server files and COPY even after disabling default read-only', async () => {
    const client = await reader();
    try {
      expect((await client.query('SHOW default_transaction_read_only')).rows[0]).toEqual({ default_transaction_read_only: 'on' });
      await client.query('SET default_transaction_read_only = off');
      expect((await client.query('SELECT id FROM resource_fixture.table_a WHERE id = $1', ['a1'])).rows).toEqual([{ id: 'a1' }]);
      for (const sql of [
        'SELECT * FROM resource_fixture.table_b',
        "INSERT INTO resource_fixture.table_a VALUES ('forbidden', 'forbidden')",
        "UPDATE resource_fixture.table_a SET name = 'forbidden' WHERE id = 'a1'",
        "DELETE FROM resource_fixture.table_a WHERE id = 'a1'",
        'TRUNCATE resource_fixture.table_a',
        'CREATE TABLE resource_fixture.forbidden (id int)',
        'CREATE TEMP TABLE forbidden_temp (id int)',
        "SELECT pg_catalog.pg_read_file('/etc/passwd')",
        "COPY resource_fixture.table_a TO '/tmp/kivro-resource-forbidden.csv'",
      ]) await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
    } finally { await client.end(); }
  });

  it('proves READ ONLY transaction protection independently of the role ACL', async () => {
    const client = await admin();
    try {
      await client.query('BEGIN READ ONLY');
      expect((await client.query('SHOW transaction_read_only')).rows[0]).toEqual({ transaction_read_only: 'on' });
      await expect(client.query("UPDATE resource_fixture.table_a SET name = 'forbidden' WHERE id = 'a1'")).rejects.toMatchObject({ code: '25006' });
    } finally { await client.query('ROLLBACK'); await client.end(); }
  });

  it('refuses a named table B operation when the database role lacks access', async () => {
    const resource = database();
    resource.allowedTables.push({ schema: 'resource_fixture', name: 'table_b', columns: ['id', 'secret'] });
    resource.operations.get!.table.name = 'table_b'; resource.operations.get!.columns = ['id', 'secret'];
    const config = integrationConfig(resource), broker = new LocalResourceBroker(config);
    try { await expect(broker.execute(request(config, { id: 'b1' }))).rejects.toThrow('RESOURCE_DENIED'); }
    finally { broker.close(); }
  });

  it('refuses privileged credentials even with an approved operation', async () => {
    const config = integrationConfig(), resource = config.resources[0] as PostgresResource, url = new URL(adminUrl);
    resource.connection.user = decodeURIComponent(url.username);
    config.secretResolver = async () => decodeURIComponent(url.password);
    config.approval.grants[0]!.configurationHash = hashResourceConfiguration(resource);
    const broker = new LocalResourceBroker(config);
    try { await expect(broker.execute(request(config))).rejects.toThrow('RESOURCE_DENIED'); }
    finally { broker.close(); }
  });

  it('caps rows and encoded bytes at the database before returning data', async () => {
    const resource = database(); resource.operations.list!.limits.maxRows = 1;
    const config = integrationConfig(resource), broker = new LocalResourceBroker(config);
    try {
      await expect(broker.execute(request(config, {}, 'list'))).rejects.toThrow('RESOURCE_LIMIT_EXCEEDED');
      await expect(broker.execute(request(config, { id: 'large' }))).rejects.toThrow('RESOURCE_LIMIT_EXCEEDED');
    } finally { broker.close(); }
  });

  it('validates real database output before exposing it', async () => {
    const resource = database(); resource.operations.get!.outputSchema = { type: 'array', maxItems: 0 };
    const config = integrationConfig(resource), broker = new LocalResourceBroker(config);
    try { await expect(broker.execute(request(config))).rejects.toThrow('INVALID_OUTPUT'); }
    finally { broker.close(); }
  });

  it('blocks an output row containing the resolved credential', async () => {
    const client = await admin(), config = integrationConfig(), broker = new LocalResourceBroker(config);
    try {
      await client.query('INSERT INTO resource_fixture.table_a(id, name) VALUES ($1, $2)', ['credential-marker', 'kivro_resource_local_only']);
      await expect(broker.execute(request(config, { id: 'credential-marker' }))).rejects.toThrow('INVALID_OUTPUT');
    } finally {
      await client.query('DELETE FROM resource_fixture.table_a WHERE id = $1', ['credential-marker']);
      await client.end(); broker.close();
    }
  });

  it('times out a genuinely blocked database query', async () => {
    const locker = await admin(), resource = database(); resource.operations.get!.limits.timeoutMs = 200;
    const config = integrationConfig(resource), broker = new LocalResourceBroker(config);
    try {
      await locker.query('BEGIN'); await locker.query('LOCK TABLE resource_fixture.table_a IN ACCESS EXCLUSIVE MODE');
      const start = performance.now();
      await expect(broker.execute(request(config))).rejects.toThrow('RESOURCE_TIMEOUT');
      expect(performance.now() - start).toBeLessThan(1500);
    } finally { broker.close(); await locker.query('ROLLBACK'); await locker.end(); }
  });

  it('cancels blocked database work and does not refund a failed job reservation', async () => {
    const locker = await admin(), config = integrationConfig(); config.budget = { maxOperations: 1 };
    const broker = new LocalResourceBroker(config), abort = new AbortController(), call = request(config);
    try {
      await locker.query('BEGIN'); await locker.query('LOCK TABLE resource_fixture.table_a IN ACCESS EXCLUSIVE MODE');
      const timer = setTimeout(() => abort.abort(), 80);
      try { await expect(broker.execute(call, abort.signal)).rejects.toThrow('RESOURCE_CANCELLED'); } finally { clearTimeout(timer); }
      await locker.query('ROLLBACK');
      await new Promise(resolve => setTimeout(resolve, 20));
      const active = await locker.query("SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity WHERE application_name = 'kivro-resource-broker' AND wait_event_type = 'Lock'");
      expect(active.rows[0]!.count).toBe(0);
      await expect(broker.execute(call)).rejects.toThrow('RESOURCE_BUDGET_EXCEEDED');
      expect((await broker.execute(request(config))).data).toEqual([{ id: 'a1', name: 'Allowed company' }]);
    } finally { broker.close(); await locker.query('ROLLBACK'); await locker.end(); }
  });
});

describe.skipIf(!enabled)('real PostgreSQL resource health', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const role = `krh_${suffix}`, tableA = `health_a_${suffix}`, tableB = `health_b_${suffix}`, guard = `health_guard_${suffix}`;
  const password = 'kivro_health_synthetic_only';
  const relationA = `resource_fixture."${tableA}"`, relationB = `resource_fixture."${tableB}"`;
  let provisioned = false;
  function healthConfig(): LocalResourceBrokerConfig {
    const resource = database(); resource.connection.user = role;
    resource.allowedTables = [tableA, tableB].map(name => ({ schema: 'resource_fixture', name, columns: ['id', 'name', 'rank'] }));
    resource.operations.get!.table.name = tableA;
    resource.operations.list!.table.name = tableA;
    resource.operations.second = { ...structuredClone(resource.operations.get!), table: { schema: 'resource_fixture', name: tableB } };
    const config = integrationConfig(resource); config.secretResolver = async () => password;
    return config;
  }
  beforeAll(async () => {
    const client = await admin();
    try {
      await client.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2`);
      provisioned = true;
      await client.query(`ALTER ROLE "${role}" SET default_transaction_read_only = on`);
      await client.query(`GRANT CONNECT ON DATABASE kivro_resource_fixture TO "${role}"`);
      await client.query(`GRANT USAGE ON SCHEMA resource_fixture TO "${role}"`);
      for (const table of [relationA, relationB]) {
        await client.query(`CREATE TABLE ${table} (id text PRIMARY KEY, name text NOT NULL, rank integer NOT NULL)`);
        await client.query(`INSERT INTO ${table}(id, name, rank) VALUES ($1, $2, $3)`, ['a1', 'Health row canary', 1]);
        await client.query(`GRANT SELECT ON ${table} TO "${role}"`);
      }
    } finally { await client.end(); }
  });
  afterAll(async () => {
    if (!provisioned) return;
    const client = await admin();
    try {
      await client.query(`DROP TABLE IF EXISTS ${relationA}, ${relationB}`);
      await client.query(`DROP FUNCTION IF EXISTS resource_fixture."${guard}"()`);
      await client.query(`DROP OWNED BY "${role}"`);
      await client.query(`DROP ROLE "${role}"`);
    } finally { await client.end(); }
  });

  it('authenticates and prepares every granted operation without returning rows or consuming job budgets', async () => {
    const config = healthConfig(); config.budget = { maxOperations: 1 };
    const broker = new LocalResourceBroker(config);
    try {
      const health = await broker.checkHealth();
      expect(health).toEqual({ ready: true, capabilityVersionId: config.approval.capabilityVersionId,
        checkedAt: expect.any(String), resources: [{ resourceId: 'companies', operations: ['get', 'list', 'second'] }] });
      for (const privateValue of [password, tableA, tableB, role, 'Health row canary', '127.0.0.1']) expect(JSON.stringify(health)).not.toContain(privateValue);
      const call = request(config);
      expect((await broker.execute(call)).data).toEqual([{ id: 'a1', name: 'Health row canary' }]);
      await broker.checkHealth();
      await expect(broker.execute(call)).rejects.toThrow('RESOURCE_BUDGET_EXCEEDED');
    } finally { broker.close(); }
  });

  it('detects revoked SELECT on a second operation after initial approval and successful health', async () => {
    const client = await admin(), broker = new LocalResourceBroker(healthConfig());
    try {
      await broker.checkHealth();
      await client.query(`REVOKE SELECT ON ${relationB} FROM "${role}"`);
      await expect(broker.checkHealth()).rejects.toThrow('RESOURCE_DENIED');
    } finally { await client.query(`GRANT SELECT ON ${relationB} TO "${role}"`); await client.end(); broker.close(); }
  });

  it('reauthenticates and rejects a changed database password after initial approval', async () => {
    const client = await admin(), config = healthConfig();
    let resolvedPassword = password;
    config.secretResolver = async () => resolvedPassword;
    const broker = new LocalResourceBroker(config);
    try {
      await broker.checkHealth();
      await client.query(`ALTER ROLE "${role}" PASSWORD 'kivro_health_rotated_synthetic_only'`);
      await expect(broker.checkHealth()).rejects.toThrow(/^RESOURCE_UNAVAILABLE$/);
      resolvedPassword = 'kivro_health_rotated_synthetic_only';
      await expect(broker.checkHealth()).resolves.toHaveProperty('ready', true);
    } finally { await client.query(`ALTER ROLE "${role}" PASSWORD '${password}'`); await client.end(); broker.close(); }
  });

  it('detects newly granted write access and revoked schema USAGE', async () => {
    const client = await admin(), broker = new LocalResourceBroker(healthConfig());
    try {
      await broker.checkHealth();
      await client.query(`GRANT UPDATE ON ${relationB} TO "${role}"`);
      await expect(broker.checkHealth()).rejects.toThrow('RESOURCE_DENIED');
      await client.query(`REVOKE UPDATE ON ${relationB} FROM "${role}"`);
      await client.query(`REVOKE USAGE ON SCHEMA resource_fixture FROM "${role}"`);
      await expect(broker.checkHealth()).rejects.toThrow('RESOURCE_DENIED');
    } finally {
      await client.query(`REVOKE UPDATE ON ${relationB} FROM "${role}"`);
      await client.query(`GRANT USAGE ON SCHEMA resource_fixture TO "${role}"`);
      await client.end(); broker.close();
    }
  });

  it('detects removed columns on an operation not used by the first query', async () => {
    const client = await admin(), broker = new LocalResourceBroker(healthConfig());
    try {
      await broker.checkHealth();
      await client.query(`ALTER TABLE ${relationB} RENAME COLUMN name TO renamed_name`);
      await expect(broker.checkHealth()).rejects.toThrow('RESOURCE_DENIED');
    } finally { await client.query(`ALTER TABLE ${relationB} RENAME COLUMN renamed_name TO name`); await client.end(); broker.close(); }
  });

  it('validates filter operators through PREPARE and ignores operations lacking an approval grant', async () => {
    const config = healthConfig(), resource = config.resources[0] as PostgresResource;
    resource.operations.second!.filters = [{ column: 'rank', operator: 'like', parameter: 'id' }];
    config.approval.grants[0]!.configurationHash = hashResourceConfiguration(resource);
    const broker = new LocalResourceBroker(config);
    try { await expect(broker.checkHealth()).rejects.toThrow('RESOURCE_CONFIGURATION_INVALID'); }
    finally { broker.close(); }
    config.approval.grants[0]!.operations = ['get', 'list'];
    const restricted = new LocalResourceBroker(config);
    try { expect((await restricted.checkHealth()).resources[0]!.operations).toEqual(['get', 'list']); }
    finally { restricted.close(); }
  });

  it('does not execute application queries or row-security functions during a health pass', async () => {
    const client = await admin(), config = healthConfig(), broker = new LocalResourceBroker(config);
    try {
      expect((await broker.execute(request(config, { id: 'a1' }, 'second'))).data).toEqual([{ id: 'a1', name: 'Health row canary' }]);
      await client.query(`CREATE FUNCTION resource_fixture."${guard}"() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'APPLICATION_ROWS_MUST_NOT_BE_READ_BY_HEALTH'; END $$`);
      await client.query(`ALTER TABLE ${relationB} ENABLE ROW LEVEL SECURITY`);
      await client.query(`CREATE POLICY health_no_read ON ${relationB} FOR SELECT USING (resource_fixture."${guard}"())`);
      await expect(broker.checkHealth()).resolves.toHaveProperty('ready', true);
      await expect(broker.execute(request(config, { id: 'a1' }, 'second'))).rejects.toThrow('RESOURCE_UNAVAILABLE');
    } finally {
      await client.query(`ALTER TABLE ${relationB} DISABLE ROW LEVEL SECURITY`);
      await client.query(`DROP POLICY IF EXISTS health_no_read ON ${relationB}`);
      await client.query(`DROP FUNCTION IF EXISTS resource_fixture."${guard}"()`);
      await client.end(); broker.close();
    }
  });

  it('bounds blocked PREPARE work and cancels active health sessions', async () => {
    const client = await admin(), config = healthConfig();
    (config.resources[0] as PostgresResource).operations.get!.limits.timeoutMs = 150;
    config.approval.grants[0]!.configurationHash = hashResourceConfiguration(config.resources[0]!);
    const broker = new LocalResourceBroker(config);
    try {
      await client.query('BEGIN'); await client.query(`LOCK TABLE ${relationA} IN ACCESS EXCLUSIVE MODE`);
      await expect(broker.checkHealth()).rejects.toThrow('RESOURCE_TIMEOUT');
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 40);
      try { await expect(broker.checkHealth(abort.signal)).rejects.toThrow('RESOURCE_CANCELLED'); }
      finally { clearTimeout(timer); }
    } finally { await client.query('ROLLBACK'); await client.end(); broker.close(); }
  });
});
