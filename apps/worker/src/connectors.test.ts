import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { hashManifest, type Dependency } from '@kivro/contracts';
import { NetworkPolicyError, SafeHttpClient, type HttpTransport } from '@kivro/research-broker';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { approveConnector, ConnectorConfigSchema, connectorDefinition, selectedConnectors } from './connectors.ts';
import { WorkerState } from './state.ts';
import { SecretStore } from './secrets.ts';
import { JobToolBroker } from './tools.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const legacy = () => ({ id: 'company.lookup', endpoint: 'https://api.example.com/research',
  parameters: { query: { type: 'string', required: true, maxLength: 80 }, limit: { type: 'number', required: false }, exact: { type: 'boolean', required: false } },
  response: { matches: { type: 'number', required: true } }, array: false, credentialRef: 'connector-token', maxResponseBytes: 1024 });
async function fixture(method?: 'GET' | 'POST') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-connectors-'))), state = new WorkerState(root), secrets = new SecretStore(state);
  cleanups.push(async () => { state.close(); await rm(root, { recursive: true, force: true }); });
  vi.stubEnv('KIVRO_WORKER_MASTER_KEY', '11'.repeat(32)); await secrets.put('connector-token', 'synthetic-connector-test-secret');
  const config = ConnectorConfigSchema.parse({ ...legacy(), ...(method ? { method } : {}) });
  const approvalHash = hashManifest(config); expect(approveConnector(state, config, approvalHash).approved).toBe(true);
  const offer = fixtureOffer(); offer.sellerId = randomUUID(); offer.permissions.tools = ['connector.call'];
  offer.ioContract.inputs[0]!.constraints = { semanticType: 'PUBLIC' };
  offer.permissions.network = { mode: 'CONNECTORS', allowedDomains: ['api.example.com'], researchLimits: { maxQueries: 0, maxPages: 5, maxResponseBytes: 1024, maxTotalBytes: 10240, maxDurationMs: 10000 } };
  const credential: Dependency = { id: 'connector-credential', name: 'Dedicated connector key', type: 'CREDENTIAL', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { credentialRefs: ['connector-token'] } };
  const dependency: Dependency = { id: 'connector', name: config.id, type: 'CONNECTOR', required: true, approved: true, supported: true, healthy: true, confidence: 'DECLARED', contentHash: approvalHash, dependsOn: [credential.id], grants: { tools: ['connector.call'] } };
  offer.dependencies.push(credential, dependency); state.resume('LOCAL'); state.claim(offer, `kivro-job-${offer.attemptId}`); state.transition(offer.jobId, 'RUNNING');
  const request = vi.spyOn(SafeHttpClient.prototype, 'request').mockImplementation(async input => ({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"matches":2}'), finalUrl: input.url }));
  const create = async () => { const broker = await JobToolBroker.create(offer, state, secrets, offer.dependencies); cleanups.push(async () => broker.cancel()); return broker; };
  return { root, state, secrets, config, offer, dependency, credential, request, create };
}
const call = (query = 'public company') => ({ connectorId: 'company.lookup', input: { query, limit: 3, exact: true } });
async function isolatedWire(context: Awaited<ReturnType<typeof fixture>>, status = 200) {
  const requests: { method: string | undefined; url: string | undefined; body: string; authorization: string | undefined; contentType: string | undefined }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString('utf8'), authorization: request.headers.authorization, contentType: request.headers['content-type'] });
    response.writeHead(status, { 'content-type': 'application/json', ...(status === 302 ? { location: 'https://other.example.com/redirect' } : {}) });
    response.end('{"matches":2}');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('INVALID_TEST_SERVER');
  // Replace only the network transport seam: production selection, schema,
  // credentials, registry and accounting still execute unchanged.
  context.request.mockImplementation(async input => {
    expect(input.url.startsWith(context.config.endpoint)).toBe(true);
    expect(input.httpsOnly).toBe(true); expect(input.maxRedirects).toBe(0);
    const source = new URL(input.url);
    const response = await fetch(`http://127.0.0.1:${address.port}${source.pathname}${source.search}`, {
      method: input.method, headers: input.headers, body: input.body, redirect: 'manual', signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()), finalUrl: input.url };
  });
  return requests;
}

describe('immutable declared Worker connector methods', () => {
  it.each([undefined, 'GET', 'POST'] as const)('delivers the declared %s request to an isolated actual HTTP server', async method => {
    const context = await fixture(method), requests = await isolatedWire(context), broker = await context.create();
    expect(await broker.execute('connector.call', call())).toMatchObject({ data: { matches: 2 } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: method ?? 'GET', authorization: 'Bearer synthetic-connector-test-secret', contentType: 'application/json' });
    if (method === 'POST') {
      expect(requests[0]!.url).toBe('/research'); expect(JSON.parse(requests[0]!.body)).toEqual(call().input);
    } else {
      expect(requests[0]!.body).toBe(''); const url = new URL(requests[0]!.url!, 'https://api.example.com');
      expect(Object.fromEntries(url.searchParams)).toEqual({ query: 'public company', limit: '3', exact: 'true' });
    }
  });
  it('refuses an actual POST redirect without forwarding its body or credential', async () => {
    const context = await fixture('POST'), requests = await isolatedWire(context, 302), broker = await context.create();
    await expect(broker.execute('connector.call', call())).rejects.toThrow('NETWORK_UNAVAILABLE');
    expect(requests).toHaveLength(1); expect(context.request).toHaveBeenCalledOnce();
    expect(context.state.get(`connectorUsage:${context.offer.jobId}`)).toMatchObject({ count: 1, bytes: 1024 });
  });
  it('preserves legacy GET approval hashes and stored objects byte-for-byte without adding method', async () => {
    const { state, secrets, config, offer, create, request } = await fixture();
    const before = JSON.stringify(state.get(`connector:${config.id}`));
    expect(config).toEqual(legacy()); expect(config).not.toHaveProperty('method'); expect(hashManifest(config)).toBe(hashManifest(legacy()));
    const selected = selectedConnectors(state, offer.permissions, offer.dependencies)[0]!;
    expect(connectorDefinition(selected, secrets).method).toBe('GET');
    const broker = await create(); await broker.execute('connector.call', call());
    const outbound = request.mock.calls[0]![0]; expect(outbound.method).toBe('GET'); expect(outbound.body).toBeUndefined();
    expect(new URL(outbound.url).searchParams.get('query')).toBe('public company');
    expect(JSON.stringify(state.get(`connector:${config.id}`))).toBe(before);
  });
  it('sends approved POST through production selection, secret resolution, tool policy and durable accounting', async () => {
    const { state, config, create, request, offer } = await fixture('POST'); const broker = await create();
    expect(await broker.execute('connector.call', call())).toMatchObject({ data: { matches: 2 }, source: { url: config.endpoint, untrusted: true } });
    expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0]![0]).toMatchObject({ url: config.endpoint, method: 'POST',
      body: JSON.stringify(call().input), headers: { authorization: 'Bearer synthetic-connector-test-secret', 'content-type': 'application/json' },
      maxRedirects: 0, maxBytes: 1024, httpsOnly: true, allowedDomains: ['api.example.com'] });
    expect(state.get(`connectorUsage:${offer.jobId}`)).toMatchObject({ count: 1, bytes: 1024 });
    const receipts = state.get<string[]>(`researchRequests:${offer.jobId}`)!;
    expect(receipts).toHaveLength(1); const receipt = state.get(`researchRequest:${receipts[0]}`);
    expect(receipt).toMatchObject({ operation: 'CONNECTOR', ok: true, host: 'api.example.com', actualBytes: 13 });
    expect(JSON.stringify(receipt)).not.toMatch(/synthetic-connector-test-secret|public company|https:/);
  });
  it('requires a new immutable connector ID and new dependency consent to change GET into POST', async () => {
    const { state, config, offer, dependency } = await fixture(); const changed = { ...config, method: 'POST' as const };
    expect(approveConnector(state, changed, hashManifest(config)).approved).toBe(false);
    expect(() => approveConnector(state, changed, hashManifest(changed))).toThrow('IMMUTABLE_CONNECTOR_USE_NEW_ID');
    expect(state.get(`connector:${config.id}`)).toEqual(config);
    state.set(`connector:${config.id}`, changed);
    expect(() => selectedConnectors(state, offer.permissions, offer.dependencies)).toThrow('CONNECTOR_CONSENT_MISMATCH');
    state.set(`connector:${config.id}`, config); const next = { ...changed, id: 'company.lookup-v2' };
    expect(approveConnector(state, next).approved).toBe(false); expect(state.get(`connector:${next.id}`)).toBeUndefined();
    approveConnector(state, next, hashManifest(next)); dependency.name = next.id;
    expect(() => selectedConnectors(state, offer.permissions, offer.dependencies)).toThrow('CONNECTOR_CONSENT_MISMATCH');
    dependency.contentHash = hashManifest(next); expect(selectedConnectors(state, offer.permissions, offer.dependencies)[0]?.method).toBe('POST');
  });
  it('accepts explicit GET distinctly without silently normalizing the old consent hash', async () => {
    const { config, secrets } = await fixture('GET'); expect(hashManifest(config)).not.toBe(hashManifest(legacy()));
    expect(connectorDefinition(config, secrets).method).toBe('GET'); expect(ConnectorConfigSchema.parse(config).method).toBe('GET');
  });
  it('rolls back new immutable consent if its audit cannot be stored', async () => {
    const { state, config } = await fixture('POST'), next = { ...config, id: 'company.other' };
    const audit = vi.spyOn(state, 'audit').mockImplementation(() => { throw new Error('SYNTHETIC_AUDIT_FAILURE'); });
    expect(() => approveConnector(state, next, hashManifest(next))).toThrow('SYNTHETIC_AUDIT_FAILURE');
    expect(state.get(`connector:${next.id}`)).toBeUndefined(); audit.mockRestore();
    expect(approveConnector(state, next, hashManifest(next)).approved).toBe(true);
    const second = new WorkerState(state.root);
    try { const changed = { ...next, method: 'GET' as const }; expect(() => approveConnector(second, changed, hashManifest(changed))).toThrow('IMMUTABLE_CONNECTOR_USE_NEW_ID'); }
    finally { second.close(); }
  });
  it.each(['PUT', 'PATCH', 'DELETE', 'HEAD', 'post', '', null])('rejects unsupported method %s', method => {
    expect(ConnectorConfigSchema.safeParse({ ...legacy(), method }).success).toBe(false);
  });
  it.each(['endpoint', 'method', 'headers', 'body', 'credentialRef', 'sideEffect'])('rejects model override %s before credentials, accounting or HTTP', async field => {
    const { state, secrets, create, request, offer } = await fixture('POST'); const broker = await create(); const get = vi.spyOn(secrets, 'get');
    await expect(broker.execute('connector.call', { ...call(), input: { ...call().input, [field]: 'model-override' } })).rejects.toThrow();
    await expect(broker.execute('connector.call', { ...call(), [field]: 'model-override' })).rejects.toThrow();
    expect(get).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); expect(state.get(`connectorUsage:${offer.jobId}`)).toBeUndefined();
  });
  it('bounds typed fields and aggregate serialized POST bytes before any transport', async () => {
    const { config, secrets } = await fixture('POST'), definition = connectorDefinition(config, secrets);
    for (const input of [{ query: 'x'.repeat(81) }, { query: { nested: 'value' } }, { query: 'ok', limit: Infinity }, { query: 'ok', exact: 'true' }, ['ok'], null]) expect(definition.requestSchema.safeParse(input).success).toBe(false);
    const parameters = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, { type: 'string', required: true, maxLength: 10000 }]));
    const large = connectorDefinition(ConnectorConfigSchema.parse({ ...config, parameters }), secrets);
    expect(large.requestSchema.safeParse(Object.fromEntries(Object.keys(parameters).map(key => [key, '\u0000'.repeat(10000)]))).success).toBe(false);
    const excessive = ConnectorConfigSchema.parse({ ...config, parameters: { ...parameters, extra: { type: 'string', required: false } } });
    expect(() => connectorDefinition(excessive, secrets)).toThrow('CONNECTOR_FIELD_LIMIT');
  });
  it.each(['unapproved', 'wrong-hash', 'wrong-domain', 'missing-credential', 'unsupported', 'unhealthy'] as const)('denies selection for %s', async failure => {
    const { state, offer, dependency, credential, create, request } = await fixture('POST');
    if (failure === 'unapproved') dependency.approved = false;
    if (failure === 'wrong-hash') dependency.contentHash = '0'.repeat(64);
    if (failure === 'wrong-domain') offer.permissions.network.allowedDomains = ['other.example.com'];
    if (failure === 'missing-credential') credential.approved = false;
    if (failure === 'unsupported') dependency.supported = false;
    if (failure === 'unhealthy') dependency.healthy = false;
    if (failure === 'unapproved') { const broker = await create(); await expect(broker.execute('connector.call', call())).rejects.toThrow('NETWORK_POLICY_DENIED'); }
    else await expect(create()).rejects.toThrow();
    expect(request).not.toHaveBeenCalled(); expect(state.get(`connectorUsage:${offer.jobId}`)).toBeUndefined();
  });
  it.each(['private-input', 'private-resource', 'missing-tool', 'paused', 'cancelled'] as const)('retains production policy denial for %s', async failure => {
    const { offer, create, request } = await fixture('POST');
    if (failure === 'private-input') offer.ioContract.inputs[0]!.constraints = { semanticType: 'TEXT' };
    if (failure === 'private-resource') offer.permissions.resources = [{ id: 'private', type: 'LOCAL_FILE', access: 'READ_ONLY' }];
    if (failure === 'missing-tool') offer.permissions.tools = [];
    if (failure === 'private-resource') { await expect(create()).rejects.toThrow('RESOURCE_CONFIGURATION_REQUIRED'); expect(request).not.toHaveBeenCalled(); return; }
    const broker = await create(); if (failure === 'paused') await broker.pause(); if (failure === 'cancelled') broker.cancel();
    await expect(broker.execute('connector.call', call())).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
  });
  it('keeps the ten-call budget across broker recreation and consumes failed attempts conservatively', async () => {
    const { state, offer, create, request } = await fixture('POST'); const broker = await create();
    request.mockRejectedValueOnce(new NetworkPolicyError('NETWORK_UNAVAILABLE'));
    await expect(broker.execute('connector.call', call())).rejects.toThrow('NETWORK_UNAVAILABLE');
    for (let index = 1; index < 10; index++) await broker.execute('connector.call', call()); broker.cancel();
    const next = await create(); await expect(next.execute('connector.call', call())).rejects.toThrow('RESEARCH_BUDGET_EXCEEDED');
    expect(request).toHaveBeenCalledTimes(10); expect(state.get(`connectorUsage:${offer.jobId}`)).toMatchObject({ count: 10 });
    const first = state.get<string[]>(`researchRequests:${offer.jobId}`)![0]!;
    expect(state.get(`researchRequest:${first}`)).toMatchObject({ ok: false, actualBytes: null, reservedBytes: 1024 });
  });
  it('validates provider output and uses the existing egress denial without returning response bodies', async () => {
    const { create, request } = await fixture('POST'); const broker = await create();
    const invalid: Awaited<ReturnType<HttpTransport['request']>> = { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"matches":"not-a-number","extra":"untrusted"}'), finalUrl: 'https://api.example.com/research' };
    request.mockResolvedValueOnce(invalid); await expect(broker.execute('connector.call', call())).rejects.toThrow(/^NETWORK_UNAVAILABLE$/);
    request.mockRejectedValueOnce(new NetworkPolicyError('NETWORK_POLICY_DENIED')); await expect(broker.execute('connector.call', call())).rejects.toThrow(/^NETWORK_POLICY_DENIED$/);
  });
});
