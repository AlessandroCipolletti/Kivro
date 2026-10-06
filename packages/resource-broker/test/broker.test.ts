import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalResourceBroker, ResourceBrokerError, RESOURCE_HEALTH_TIMEOUT_MS, hashResourceConfiguration, type FileResource, type LocalResourceBrokerConfig } from '../src/index.ts';
import { prepareQuery } from '../src/postgres.ts';
import { configuration, database, fileOutput, objectInput, request } from './helpers.ts';

describe('authorization and named queries', () => {
  it('compiles fixed, named, parameterized read-only SQL with no buyer SQL interpolation', () => {
    const query = database().operations.get!;
    const attack = "a1'; DELETE FROM resource_fixture.table_a; --";
    const prepared = prepareQuery(query, { id: attack }, 4, 1024);
    expect(prepared.name).toMatch(/^kivro_resource_[a-f0-9]{40}$/);
    expect(prepared.text).toContain('FROM ONLY "resource_fixture"."table_a"');
    expect(prepared.text).toContain('"id" = $1');
    expect(prepared.text).not.toContain(attack);
    expect(prepared.values).toEqual([attack, 4, 1024]);
    expect(prepareQuery(query, { id: 'other' }, 2, 300).name).toBe(prepared.name);
  });

  it('rejects a table outside the allowlist and raw SQL configuration', () => {
    const resource = database(); resource.operations.get!.table.name = 'table_b';
    expect(() => new LocalResourceBroker(configuration(resource))).toThrow('RESOURCE_CONFIGURATION_INVALID');
    const config = configuration(database());
    Object.assign(config.resources[0]!, { sql: 'DELETE FROM table_a' });
    expect(() => new LocalResourceBroker(config)).toThrow('RESOURCE_CONFIGURATION_INVALID');
  });

  it.each(['delete', 'update', 'insert', 'execute', 'table_b', '__proto__', 'constructor'])('denies unapproved operation %s before resolving credentials', async operation => {
    const config = configuration(database()), secret = vi.fn(config.secretResolver); config.secretResolver = secret;
    const broker = new LocalResourceBroker(config);
    await expect(broker.execute(request(config, {}, operation))).rejects.toBeInstanceOf(ResourceBrokerError);
    expect(secret).not.toHaveBeenCalled();
  });

  it('requires an explicit permission resource and approved credential closure', () => {
    for (const change of [
      (config: LocalResourceBrokerConfig) => { config.approval.permissions.resources = []; },
      (config: LocalResourceBrokerConfig) => { config.approval.dependencies[0]!.grants = {}; },
      (config: LocalResourceBrokerConfig) => { config.approval.dependencies[0]!.dependsOn = []; },
      (config: LocalResourceBrokerConfig) => { config.approval.dependencies[1]!.approved = false; },
      (config: LocalResourceBrokerConfig) => { config.approval.dependencies[1]!.healthy = false; },
      (config: LocalResourceBrokerConfig) => { config.approval.dependencies[1]!.supported = false; },
      (config: LocalResourceBrokerConfig) => { config.approval.dependencies[1]!.dependsOn = ['company-database']; },
      (config: LocalResourceBrokerConfig) => { config.approval.dependencies[0]!.dependsOn = ['missing']; },
      (config: LocalResourceBrokerConfig) => { config.approval.dependencies.push(config.approval.dependencies[0]!); },
    ]) {
      const config = configuration(database()); change(config);
      expect(() => new LocalResourceBroker(config)).toThrow('RESOURCE_CONFIGURATION_INVALID');
    }
  });

  it('denies altered request snapshots and resource configuration after approval', async () => {
    const config = configuration(database()), secret = vi.fn(config.secretResolver); config.secretResolver = secret;
    const broker = new LocalResourceBroker(config), changed = request(config);
    changed.permissions.resources.push({ id: 'tableB', type: 'DATABASE', access: 'READ_ONLY' });
    await expect(broker.execute(changed)).rejects.toThrow('RESOURCE_DENIED');
    const missing = request(config); missing.dependencies.pop();
    await expect(broker.execute(missing)).rejects.toThrow('RESOURCE_DENIED');
    const resource = config.resources[0]!;
    if (resource.type === 'DATABASE') resource.connection.host = 'new-host';
    expect(() => new LocalResourceBroker(config)).toThrow('RESOURCE_CONFIGURATION_INVALID');
    expect(secret).not.toHaveBeenCalled();
  });

  it('requires an operation grant even when the named operation exists', async () => {
    const config = configuration(database()), secret = vi.fn(config.secretResolver); config.secretResolver = secret;
    config.approval.grants[0]!.operations = ['get'];
    await expect(new LocalResourceBroker(config).execute(request(config, {}, 'list'))).rejects.toThrow('RESOURCE_DENIED');
    expect(secret).not.toHaveBeenCalled();
  });

  it.each([{ id: 4 }, { id: 'a1', sql: 'SELECT * FROM table_b' }, { id: { toPostgres: () => 'attack' } }, { id: 'x'.repeat(101) }])('validates input before secret lookup', async input => {
    const config = configuration(database()), secret = vi.fn(config.secretResolver); config.secretResolver = secret;
    await expect(new LocalResourceBroker(config).execute(request(config, input))).rejects.toThrow('INVALID_INPUT');
    expect(secret).not.toHaveBeenCalled();
  });

  it('bounds credential resolution, cancels without connecting, and retains failed budgets', async () => {
    const resource = database(); resource.operations.get!.limits.timeoutMs = 30;
    const config = configuration(resource); config.budget = { maxOperations: 1 };
    let resolveSecret!: (secret: string) => void;
    const secret = vi.fn(() => new Promise<string>(resolve => { resolveSecret = resolve; })); config.secretResolver = secret;
    const broker = new LocalResourceBroker(config), call = request(config);
    await expect(broker.execute(call)).rejects.toThrow('RESOURCE_TIMEOUT');
    resolveSecret('unused'); await new Promise(resolve => setTimeout(resolve, 0));
    await expect(broker.execute(call)).rejects.toThrow('RESOURCE_BUDGET_EXCEEDED');
    expect(secret).toHaveBeenCalledOnce();
  });

  it('cancels on abort or close while sanitizing resolver failures', async () => {
    const config = configuration(database()); config.secretResolver = async () => { throw new Error('password=secret /Users/private/data'); };
    const broker = new LocalResourceBroker(config);
    await expect(broker.execute(request(config))).rejects.toThrow(/^RESOURCE_UNAVAILABLE$/);
    const abort = new AbortController(); abort.abort();
    await expect(broker.execute(request(config), abort.signal)).rejects.toThrow('RESOURCE_CANCELLED');
    broker.close(); await expect(broker.execute(request(config))).rejects.toThrow('BROKER_CLOSED');
  });

  it('reserves global and per-job slots before awaiting credentials', async () => {
    const config = configuration(database()); config.maxConcurrentOperations = 1;
    let finish!: (secret: string) => void;
    config.secretResolver = () => new Promise(resolve => { finish = resolve; });
    const broker = new LocalResourceBroker(config), abort = new AbortController(), call = request(config);
    const pending = broker.execute(call, abort.signal);
    const rejected = expect(pending).rejects.toThrow('RESOURCE_CANCELLED');
    await expect(broker.execute(request(config))).rejects.toThrow('RESOURCE_BUSY');
    await expect(broker.execute(call)).rejects.toThrow('RESOURCE_BUSY');
    abort.abort(); await rejected; finish('unused');
  });
});

describe('immutable file selections and budgets', () => {
  let root: string, resource: FileResource;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-resource-')));
    const content = 'Approved contents';
    await writeFile(join(root, 'approved.txt'), content, { mode: 0o400 });
    resource = { id: 'documents', type: 'LOCAL_FILE', dependencyId: 'selected-documents', selections: [{
      id: 'approved', root, path: join(root, 'approved.txt'), sizeBytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'), mimeType: 'text/plain',
    }], operations: { read: { inputSchema: objectInput({ selectionId: { type: 'string' } }), outputSchema: fileOutput,
      limits: { maxRows: 1, maxBytes: 4096, timeoutMs: 1000 } } } };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('checks every file selection without returning contents or consuming job budgets', async () => {
    const selected = resource.selections[0]!;
    await writeFile(join(root, 'second.txt'), 'Approved contents', { mode: 0o400 });
    resource.selections.push({ ...selected, id: 'second', path: join(root, 'second.txt') });
    const config = configuration(resource); config.budget = { maxOperations: 1, maxRows: 1 };
    const broker = new LocalResourceBroker(config);
    const health = await broker.checkHealth();
    expect(health).toEqual({ ready: true, capabilityVersionId: config.approval.capabilityVersionId,
      checkedAt: expect.any(String), resources: [{ resourceId: 'documents', operations: ['read'] }] });
    expect(JSON.stringify(health)).not.toContain(root);
    expect(JSON.stringify(health)).not.toContain('Approved contents');
    const call = request(config, { selectionId: 'approved' }, 'read');
    await broker.execute(call);
    await broker.checkHealth();
    await expect(broker.execute(call)).rejects.toThrow('RESOURCE_BUDGET_EXCEEDED');
    await chmod(join(root, 'second.txt'), 0o600);
    await expect(broker.checkHealth()).rejects.toThrow('RESOURCE_CHANGED');
  });

  it('reads only the approved selection, validates output and emits private taint without paths', async () => {
    const config = configuration(resource), audit = vi.fn(); config.audit = audit;
    const result = await new LocalResourceBroker(config).execute(request(config, { selectionId: 'approved' }, 'read'));
    expect(result.data).toMatchObject({ selectionId: 'approved', content: 'Approved contents' });
    expect(result.metadata).toMatchObject({ dataClasses: ['SELLER_PRIVATE'], untrusted: true, rows: 1 });
    expect(result.metadata.bytes).toBe(Buffer.byteLength(JSON.stringify(result)));
    expect(JSON.stringify(result)).not.toContain(root);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ALLOWED', code: 'OK' }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain(root);
  });

  it('pins configuration/permissions against caller mutation', async () => {
    const config = configuration(resource), call = request(config, { selectionId: 'approved' }, 'read');
    const broker = new LocalResourceBroker(config);
    config.approval.permissions.resources.length = 0;
    resource.selections[0]!.path = '/unselected';
    (resource.operations.read.inputSchema.properties as Record<string, unknown>).selectionId = { type: 'number' };
    const result = await broker.execute(call);
    expect(result.data).toMatchObject({ content: 'Approved contents' });
  });

  it.each([{ selectionId: 'sibling' }, { selectionId: '../approved.txt' }, { path: '/etc/passwd' }, { selectionId: 'approved', path: '/etc/passwd' }])('rejects unselected and arbitrary paths', async input => {
    const config = configuration(resource);
    await expect(new LocalResourceBroker(config).execute(request(config, input, 'read'))).rejects.toBeInstanceOf(ResourceBrokerError);
  });

  it('denies same-size modified content even if the new file has read-only permissions', async () => {
    await chmod(resource.selections[0]!.path, 0o600);
    await writeFile(resource.selections[0]!.path, 'Unchosen contents'); await chmod(resource.selections[0]!.path, 0o400);
    const config = configuration(resource);
    await expect(new LocalResourceBroker(config).execute(request(config, { selectionId: 'approved' }, 'read'))).rejects.toThrow('RESOURCE_CHANGED');
  });

  it('denies hardlinks, final symlinks, ancestor symlinks and writable snapshots', async () => {
    const target = resource.selections[0]!.path;
    await link(target, join(root, 'hardlink'));
    let config = configuration(resource);
    await expect(new LocalResourceBroker(config).execute(request(config, { selectionId: 'approved' }, 'read'))).rejects.toThrow('RESOURCE_CHANGED');
    await rm(join(root, 'hardlink')); await rename(target, join(root, 'original')); await symlink(join(root, 'original'), target);
    config = configuration(resource);
    await expect(new LocalResourceBroker(config).execute(request(config, { selectionId: 'approved' }, 'read'))).rejects.toThrow('RESOURCE_CHANGED');
    await rm(target); await rename(join(root, 'original'), target); await chmod(target, 0o600);
    config = configuration(resource);
    await expect(new LocalResourceBroker(config).execute(request(config, { selectionId: 'approved' }, 'read'))).rejects.toThrow('RESOURCE_CHANGED');
    await chmod(target, 0o400); await mkdir(join(root, 'real'), { mode: 0o700 });
    await rename(target, join(root, 'real', 'approved.txt')); await symlink(join(root, 'real'), join(root, 'alias'));
    resource.selections[0]!.path = join(root, 'alias', 'approved.txt'); config = configuration(resource);
    await expect(new LocalResourceBroker(config).execute(request(config, { selectionId: 'approved' }, 'read'))).rejects.toThrow('RESOURCE_CHANGED');
  });

  it('rejects wrong output schema and limits bytes including the response envelope', async () => {
    resource.operations.read.outputSchema = { type: 'array' };
    let config = configuration(resource);
    await expect(new LocalResourceBroker(config).execute(request(config, { selectionId: 'approved' }, 'read'))).rejects.toThrow('INVALID_OUTPUT');
    resource.operations.read.outputSchema = fileOutput; resource.operations.read.limits.maxBytes = 40; config = configuration(resource);
    await expect(new LocalResourceBroker(config).execute(request(config, { selectionId: 'approved' }, 'read'))).rejects.toThrow('RESOURCE_LIMIT_EXCEEDED');
  });

  it('keeps job deadlines and input-byte budgets across successful calls', async () => {
    const config = configuration(resource); config.budget = { maxDurationMs: 30 };
    const broker = new LocalResourceBroker(config), call = request(config, { selectionId: 'approved' }, 'read');
    await broker.execute(call);
    await new Promise(resolve => setTimeout(resolve, 40));
    await expect(broker.execute(call)).rejects.toThrow('RESOURCE_BUDGET_EXCEEDED');
    const inputConfig = configuration(resource); inputConfig.budget = { maxInputBytes: 40 };
    const inputBroker = new LocalResourceBroker(inputConfig), inputCall = request(inputConfig, { selectionId: 'approved' }, 'read');
    await inputBroker.execute(inputCall);
    await expect(inputBroker.execute(inputCall)).rejects.toThrow('RESOURCE_BUDGET_EXCEEDED');
  });

  it('enforces cumulative row, operation and byte budgets per immutable job', async () => {
    for (const budget of [{ maxRows: 1 }, { maxOperations: 1 }, { maxBytes: 500 }]) {
      const config = configuration(resource); config.budget = budget;
      const broker = new LocalResourceBroker(config), call = request(config, { selectionId: 'approved' }, 'read');
      await broker.execute(call);
      await expect(broker.execute(call)).rejects.toBeInstanceOf(ResourceBrokerError);
      await expect(broker.execute({ ...call, jobId: randomUUID() })).resolves.toHaveProperty('metadata.rows', 1);
    }
  });

  it('pins operation grants and bounds the number of tracked jobs', async () => {
    const config = configuration(resource); config.maxTrackedJobs = 1;
    const broker = new LocalResourceBroker(config);
    await broker.execute(request(config, { selectionId: 'approved' }, 'read'));
    await expect(broker.execute(request(config, { selectionId: 'approved' }, 'read'))).rejects.toThrow('RESOURCE_BUDGET_EXCEEDED');
    config.approval.grants[0]!.configurationHash = hashResourceConfiguration({ ...resource, id: 'other' });
    expect(() => new LocalResourceBroker(config)).toThrow('RESOURCE_CONFIGURATION_INVALID');
  });
});

describe('bounded resource health lifecycle', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('refuses to advertise readiness when a declared or required resource is not configured', async () => {
    const config = configuration(database());
    config.resources = []; config.approval.grants = [];
    config.secretResolver = vi.fn(config.secretResolver);
    await expect(new LocalResourceBroker(config).checkHealth()).rejects.toThrow('RESOURCE_DENIED');
    config.approval.permissions.resources = [];
    await expect(new LocalResourceBroker(config).checkHealth()).rejects.toThrow('RESOURCE_DENIED');
    expect(config.secretResolver).not.toHaveBeenCalled();
  });

  it('has a fixed deadline including credential resolution and retains an occupied slot until cleanup', async () => {
    vi.useFakeTimers();
    const config = configuration(database()); config.maxConcurrentOperations = 1;
    let finish!: (password: string) => void;
    config.secretResolver = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const broker = new LocalResourceBroker(config);
    const result = expect(broker.checkHealth()).rejects.toThrow('RESOURCE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(RESOURCE_HEALTH_TIMEOUT_MS);
    await result;
    await expect(broker.checkHealth()).rejects.toThrow('RESOURCE_BUSY');
    await expect(broker.execute(request(config))).rejects.toThrow('RESOURCE_BUSY');
    finish('never-connected'); await vi.advanceTimersByTimeAsync(0);
    expect(config.secretResolver).toHaveBeenCalledOnce();
    broker.close();
  });

  it.each(['abort', 'close'])('shares cancellation with the %s path and denies overlapping health passes', async mode => {
    const config = configuration(database());
    let finish!: (password: string) => void;
    config.secretResolver = () => new Promise(resolve => { finish = resolve; });
    const broker = new LocalResourceBroker(config), abort = new AbortController();
    const pending = broker.checkHealth(abort.signal);
    const rejected = expect(pending).rejects.toThrow(mode === 'abort' ? 'RESOURCE_CANCELLED' : 'BROKER_CLOSED');
    await Promise.resolve();
    await expect(broker.checkHealth()).rejects.toThrow('RESOURCE_BUSY');
    if (mode === 'abort') abort.abort(new Error('host-private-reason')); else broker.close();
    await rejected; finish('never-connected');
  });

  it('sanitizes resolver errors and honors cancellation before any health I/O', async () => {
    const config = configuration(database());
    config.secretResolver = vi.fn(async () => { throw new Error('/private/credentials password=secret'); });
    const broker = new LocalResourceBroker(config), signal = AbortSignal.abort();
    await expect(broker.checkHealth(signal)).rejects.toThrow(/^RESOURCE_CANCELLED$/);
    expect(config.secretResolver).not.toHaveBeenCalled();
    await expect(broker.checkHealth()).rejects.toThrow(/^RESOURCE_UNAVAILABLE$/);
    broker.close(); await expect(broker.checkHealth()).rejects.toThrow(/^BROKER_CLOSED$/);
  });
});
