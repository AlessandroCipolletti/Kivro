// Opt-in acceptance fixture only. Real API/Worker/OpenClaw/DB/HTTPS; synthetic inference/payment.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../apps/api/src/app.js';
import { main as workerCommand } from '../apps/worker/src/index.ts';
import { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { WorkerState } from '../apps/worker/src/state.ts';
import { SecretStore } from '../apps/worker/src/secrets.ts';
import { WorkerTransport, type DeviceIdentity } from '../apps/worker/src/transport.ts';
import { LocalCapabilitySchema, approveCapability, discoveredDependencyGrants } from '../apps/worker/src/capabilities.ts';
import { approveBrokerResource, createResourceBroker } from '../apps/worker/src/resource-config.ts';
import { approveResearchPlan } from '../apps/worker/src/research-config.ts';
import { reviewObservations } from '../apps/worker/src/observations.ts';
import { testCapability } from '../apps/worker/src/validation.ts';
import { validateInferenceConfig } from '../apps/worker/src/inference.ts';
import { CreateCapabilitySchema, hashManifest, type CapabilityDTO, type JobDTO } from '../packages/contracts/src/index.ts';
import { sha256 } from '../packages/crypto/src/index.ts';
import { DockerSandbox, detectRuntime } from '../packages/openclaw-adapter/src/index.ts';
import { database } from '../packages/resource-broker/test/helpers.ts';
import { hashResourceConfiguration } from '../packages/resource-broker/src/index.ts';
import type { S3ObjectStore } from '../packages/storage/src/index.ts';
import { fixtureSchema } from './e2e-fixture-background.js';

const KIND = 'DETERMINISTIC_LOCAL_RESEARCH_DB_FULLSTACK_TEST_FIXTURE';
const MODEL = 'kivro-deterministic-research-db-fixture', ORIGIN = 'http://127.0.0.1:3000';
// Public synthetic infrastructure credentials, never .env or personal configuration.
const API_ENV = {
  NODE_ENV: 'test', KIVRO_ENV: 'development', PAYMENT_MODE: 'fake', DEV_AUTH_ENABLED: 'false',
  DATABASE_URL: 'postgresql://kivro:kivro_local_only@127.0.0.1:55432/kivro?schema=public', REDIS_URL: 'redis://127.0.0.1:56379', WEB_ORIGIN: ORIGIN,
  S3_ENDPOINT: 'http://127.0.0.1:59000', S3_BUCKET: 'kivro-development', S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'kivro_local', S3_SECRET_KEY: 'kivro_local_storage_only', S3_FORCE_PATH_STYLE: 'true',
};
type Account = { cookie: string; user: { id: string; email: string } };
type Message = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
type Receipt = { id: string; context: { userId: string; jobId: string; attemptId: string; capabilityVersionId: string }; operation: string; host: string;
  publicSourceId: string; publicPlanHash: string; startedAt: number; finishedAt: number; ok: boolean; status: number; actualBytes: number; responseSha256: string };
type Run = { name: 'validation' | 'purchase'; rowId: string; privateName: string; trace: string; step: number; receipt?: Receipt; firstInferenceAt?: number; rawUrlDenied: boolean };
type Wallet = { availableMinor: number; reservedMinor: number; spentMinor: number; earnedMinor: number; ledger: { jobId: string | null; type: string }[] };
function check(value: unknown, code: string): asserts value { if (!value) throw new Error(`RESEARCH_FIXTURE_${code}`); }
const safeCode = (error: unknown) => error instanceof Error && /^[A-Z0-9_:/.-]{1,200}$/.test(error.message) ? error.message : 'RESEARCH_FIXTURE_OPERATION_FAILED';
async function boundedBody(response: Response): Promise<Buffer> {
  check(response.body, 'RESPONSE_BODY_MISSING'); const reader = response.body.getReader(), chunks: Buffer[] = []; let bytes = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; check(bytes <= 2 * 1024 ** 2, 'RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel(); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  if (process.argv.slice(2).join(' ') !== '--run') {
    console.log('Opt-in synthetic-inference acceptance: node --import tsx scripts/e2e-research-fixture.ts --run. Requires local services, resource-broker/test/fixture.sql and approved-compatible sandbox image. No Next/CORS or database setup is performed.'); return;
  }
  check(process.env.NODE_ENV !== 'production' && process.env.KIVRO_ENV !== 'production', 'PRODUCTION_DENIED');
  const schema = fixtureSchema(process.env.KIVRO_FIXTURE_SCHEMA), image = process.env.KIVRO_RESEARCH_FIXTURE_IMAGE ?? 'kivro-sandbox:2026.8.2';
  check(image === 'kivro-sandbox:2026.8.2' || /^sha256:[a-f0-9]{64}$/.test(image), 'INVALID_IMAGE');
  const dbUrl = new URL(API_ENV.DATABASE_URL); dbUrl.searchParams.set('schema', schema);
  const id = randomUUID(), token = `kivro-research-test-only-${randomBytes(24).toString('hex')}`;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-research-fullstack-'))), state = new WorkerState(join(root, 'worker')), secrets = new SecretStore(state);
  const abort = new AbortController(), cancel = () => { abort.abort(); state.pause('LOCAL'); state.set('stopRequested', true); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel); const watchdog = setTimeout(cancel, 10 * 60_000);
  const saved = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string) => { if (!saved.has(key)) saved.set(key, process.env[key]); process.env[key] = value; };
  for (const [key, value] of Object.entries({ KIVRO_WORKER_HOME: state.root, KIVRO_WORKER_MASTER_KEY: randomBytes(32).toString('hex'),
    KIVRO_SANDBOX_IMAGE: image, KIVRO_ENV: 'development', NODE_ENV: 'test', DEV_AUTH_ENABLED: 'false' })) setEnv(key, value);
  let api: Awaited<ReturnType<typeof createApp>> | undefined, apiUrl = '', phase = 'prerequisites', imageId = '';
  let seller: Account | undefined, buyer: Account | undefined, identity: DeviceIdentity | undefined, capability: CapabilityDTO | undefined;
  let runtime: WorkerRuntime | undefined, runtimeTask: Promise<void> | undefined, runtimeError: unknown, runtimeDone = false;
  let run: Run | undefined, providerError: string | undefined, providerRequests = 0, evidence: Record<string, unknown> | undefined, failure: unknown;
  const cleanupErrors: string[] = [];
  const stage = (name: string) => { phase = name; console.log(`RESEARCH_TEST_FIXTURE ${name}`); check(!abort.signal.aborted, 'CANCELLED'); };
  const request = (path: string, options: RequestInit = {}, account?: Account, cleanup = false) => {
    check(path.startsWith('/') && !path.startsWith('//'), 'INVALID_API_PATH');
    const timeout = AbortSignal.timeout(20000);
    return fetch(`${apiUrl}${path}`, { ...options, redirect: 'manual', headers: { Origin: ORIGIN, ...(account ? { Cookie: account.cookie } : {}), ...options.headers },
      signal: cleanup ? timeout : AbortSignal.any([abort.signal, timeout]) });
  };
  const json = async <T>(path: string, options: RequestInit = {}, account?: Account, cleanup = false): Promise<T> => {
    const response = await request(path, options, account, cleanup), body = JSON.parse((await boundedBody(response)).toString());
    if (!response.ok) throw new Error(`RESEARCH_FIXTURE_API_${response.status}_${/^[A-Z0-9_]+$/.test(body.error?.code) ? body.error.code : 'ERROR'}`); return body as T;
  };
  const post = <T>(path: string, body: unknown, account?: Account, headers: Record<string, string> = {}, cleanup = false) =>
    json<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }, account, cleanup);
  const register = async (role: 'buyer' | 'seller'): Promise<Account> => {
    const terms = await json<{ version: string }>('/api/terms');
    const response = await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      name: `Research fixture ${role}`, email: `research-fixture-${role}-${id}@kivro.invalid`, password: randomBytes(32).toString('base64url'), acceptedTermsVersion: terms.version }) });
    check(response.ok, `REGISTER_${role.toUpperCase()}_${response.status}`);
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); check(cookie, 'SESSION_MISSING');
    return { cookie, ...JSON.parse((await boundedBody(response)).toString()) };
  };
  const readReceipt = (jobId: string): Receipt => {
    const ids = state.get<string[]>(`researchRequests:${jobId}`); assert.equal(ids?.length, 1, 'Exactly one fixed public request, never a private-derived request');
    const receipt = state.get<Receipt>(`researchRequest:${ids![0]}`)!;
    check(receipt.ok && receipt.status === 200 && receipt.actualBytes > 0 && receipt.actualBytes <= 50000 && /^[a-f0-9]{64}$/.test(receipt.responseSha256), 'PUBLIC_RECEIPT_INCOMPLETE');
    assert.equal(receipt.context.userId, seller!.user.id); assert.equal(receipt.context.jobId, jobId); assert.equal(receipt.context.capabilityVersionId, capability!.versionId);
    assert.equal(receipt.host, 'example.com'); assert.equal(receipt.operation, 'FETCH'); assert.equal(receipt.publicSourceId, 'public-example');
    return receipt;
  };
  const provider = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/v1/models') {
        check(req.headers.authorization === `Bearer ${token}`, 'INFERENCE_TOKEN');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: MODEL }] })); return;
      }
      check(req.method === 'POST' && req.url === '/v1/chat/completions' && req.headers.authorization === `Bearer ${token}`, 'PROVIDER_AUTH_ROUTE');
      check(++providerRequests <= 12, 'PROVIDER_CALL_CAP'); const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; check(bytes <= 2 * 1024 ** 2, 'PROVIDER_BODY_CAP'); chunks.push(Buffer.from(chunk)); }
      const body = JSON.parse(Buffer.concat(chunks).toString()), messages = body.messages as Message[];
      check(body.model === MODEL && body.store === false && body.stream === false && Array.isArray(messages), 'PROVIDER_CONTRACT');
      let content = 'OK', call: { name: string; arguments: string } | undefined;
      if (!body.tools?.length) check(messages.length === 1 && messages[0]?.content === 'Reply with OK.', 'UNEXPECTED_HEALTH_PROMPT');
      else {
        check(run, 'UNEXPECTED_INFERENCE'); const current = run;
        assert.deepEqual(body.tools.map((tool: { function: { name: string } }) => tool.function.name).sort(), ['research_fetch', 'resource_query']);
        const parameters = body.tools.find((tool: { function: { name: string } }) => tool.function.name === 'research_fetch').function.parameters;
        assert.deepEqual(parameters.required, ['reviewedSourceId']); assert.deepEqual(parameters.properties.reviewedSourceId.enum, ['public-example']);
        assert.equal(parameters.additionalProperties, false); assert.equal(parameters.properties.url, undefined); assert.equal(parameters.properties.query, undefined);
        const history = messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []);
        const toolReply = (index: number) => { const previous = history[index]; check(previous, 'TOOL_HISTORY_MISSING'); const reply = messages.find(message => message.role === 'tool' && message.tool_call_id === previous.id); check(reply, 'TOOL_REPLY_MISSING'); return JSON.stringify(reply.content); };
        if (current.name === 'purchase') {
          const attempts = state.activeAttempts(); assert.equal(attempts.length, 1); const attempt = attempts[0]!;
          const receipt = readReceipt(attempt.jobId);
          if (!current.receipt) {
            current.receipt = receipt; current.firstInferenceAt = Date.now(); assert(receipt.finishedAt <= current.firstInferenceAt);
            assert.equal(state.db.prepare("SELECT count(*) AS n FROM audit WHERE jobId=? AND event='RESOURCE_ALLOWED'").get(attempt.jobId)?.n, 0);
            const cloud = await api!.kivro.db.jobAttempt.findUniqueOrThrow({ where: { id: attempt.attemptId } }); check(cloud.acceptedAt && cloud.state === 'RUNNING', 'SIGNED_ACCEPTANCE_BEFORE_INFERENCE');
          } else assert.deepEqual(receipt, current.receipt, 'Cache reads and denied URLs cannot add or mutate network receipts');
        }
        if (current.step === 0) {
          check(!JSON.stringify(messages).includes(current.privateName), 'PRIVATE_ROW_LEAKED_BEFORE_TOOL');
          check(JSON.stringify(messages).includes(current.trace), 'BUYER_INPUT_MISSING');
          call = { name: 'resource_query', arguments: JSON.stringify({ resourceId: 'companies', operation: 'get', input: { id: current.rowId } }) };
        } else {
          assert.equal(history[0]?.function.name, 'resource_query'); check(toolReply(0).includes(current.privateName) && toolReply(0).includes('SELLER_PRIVATE'), 'REAL_PRIVATE_DB_ROW_MISSING');
          for (const secret of ['kivro_resource_local_only', 'kivro_resource_reader', 'resource_fixture', '127.0.0.1']) check(!toolReply(0).includes(secret), 'HOST_DB_METADATA_LEAKED');
          if (current.step === 1) call = { name: 'research_fetch', arguments: JSON.stringify({ reviewedSourceId: 'public-example' }) };
          else {
            check(toolReply(1).includes('Example Domain'), 'REAL_PUBLIC_CACHE_CONTENT_MISSING');
            if (current.step === 2) call = { name: 'research_fetch', arguments: JSON.stringify({ reviewedSourceId: 'public-example', url: `https://example.com/?private=${encodeURIComponent(current.privateName)}&buyer=${current.trace}` }) };
            else {
              check(current.step === 3, 'UNEXPECTED_RETRY');
              check(/error|invalid|denied|additional|unexpected/i.test(toolReply(2)), 'PRIVATE_DERIVED_URL_NOT_DENIED'); current.rawUrlDenied = true;
              content = `${current.trace}: ${current.privateName}; Example Domain`;
            }
          }
        }
        current.step++;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `research-fixture-${providerRequests}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL,
        choices: [{ index: 0, message: call ? { role: 'assistant', content: null, tool_calls: [{ id: `research-${run!.name}-${run!.step}`, type: 'function', function: call }] } : { role: 'assistant', content }, finish_reason: call ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: body.tools?.length ? 30 : 1, total_tokens: body.tools?.length ? 130 : 101 } }));
    } catch (error) { providerError = safeCode(error); res.writeHead(400).end(JSON.stringify({ error: { code: providerError } })); }
  });
  provider.headersTimeout = 10000; provider.requestTimeout = 15000; provider.maxConnections = 2;
  const until = async (predicate: () => Promise<boolean>, timeoutMs: number, code: string) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { check(!abort.signal.aborted && !runtimeDone, 'RUNTIME_STOPPED'); if (providerError) throw new Error(providerError); if (await predicate()) return; await delay(250); }
    throw new Error(`RESEARCH_FIXTURE_${code}`);
  };
  try {
    const docker = new DockerSandbox(); imageId = await docker.imageId(image); setEnv('KIVRO_SANDBOX_IMAGE', imageId); check((await detectRuntime()).compatible, 'HOST_OPENCLAW_UNSUPPORTED');
    api = await createApp({ env: { ...API_ENV, DATABASE_URL: dbUrl.toString() }, background: false, logger: false }); apiUrl = await api.listen({ host: '127.0.0.1', port: 0 }); setEnv('API_URL', apiUrl);
    const ready = await json<{ status: string; services: Record<string, string> }>('/ready'); check(ready.status === 'ready' && ['database', 'storage', 'redis'].every(key => ready.services[key] === 'ready'), 'SERVICES_NOT_READY');
    await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); }); const address = provider.address(); check(address && typeof address === 'object', 'PROVIDER_LISTEN');
    stage('pair-and-actual-proofs'); seller = await register('seller'); buyer = await register('buyer');
    const pairing = await post<{ code: string }>('/api/seller/pairing-code', {}, seller); await workerCommand(['pair', pairing.code, '--name', `Research fixture ${id}`]);
    identity = state.get<DeviceIdentity>('identity'); check(identity, 'PAIRING_MISSING'); await workerCommand(['sandbox', 'approve-image']);
    await secrets.put('fixture-inference', token);
    const config = validateInferenceConfig({ provider: 'openai-compatible', model: MODEL, credentialRef: 'fixture-inference', baseUrl: `http://127.0.0.1:${address.port}/v1`, allowLocal: true,
      maxTokensPerJob: 200000, dailyTokenLimit: 1000000, inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 });
    const path = join(root, 'inference.json'); await writeFile(path, JSON.stringify(config), { mode: 0o600 }); await workerCommand(['inference', 'configure', '--file', path, '--approve', hashManifest(config)]); await workerCommand(['inference', 'test']);
    stage('explicit-database-and-research-consent');
    const resource = database(); resource.dependencyId = 'resource:companies'; resource.operations = { get: resource.operations.get! };
    await secrets.put(resource.credentialRef, 'kivro_resource_local_only'); approveBrokerResource(state, resource, hashResourceConfiguration(resource));
    const base = LocalCapabilitySchema.parse({ capabilityVersionId: randomUUID(), dependencies: [], selectedSkills: [], internalInstructions: 'Read the requested row using the approved get operation, then the reviewed public-example cache. Return the buyer trace, private name and public page title. Synthetic fixture only.',
      permissions: { schemaVersion: 1, tools: ['resource.query', 'research.fetch'], resources: [{ id: 'companies', type: 'DATABASE', access: 'READ_ONLY' }],
        network: { mode: 'RESEARCH', allowedDomains: ['example.com'], researchLimits: { maxQueries: 0, maxPages: 1, maxResponseBytes: 50000, maxTotalBytes: 50000, maxDurationMs: 10000 } },
        inference: { provider: config.provider, model: config.model, credentialRef: config.credentialRef }, limits: { timeoutSeconds: 120, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 65536, maxOutputBytes: 65536, maxTokens: 200000 } },
      ioContract: { schemaVersion: 1, inputs: [{ key: 'rowId', label: 'Synthetic row', type: 'SHORT_TEXT', required: true, order: 0 }, { key: 'trace', label: 'Buyer trace', type: 'SHORT_TEXT', required: true, order: 1 }],
        output: { type: 'TEXT', required: true, description: 'Private read-only row combined with reviewed public page title' } } });
    base.dependencies = discoveredDependencyGrants(state, base).map(dep => ({ ...dep, approved: true, ...(dep.id === resource.dependencyId ? { dependsOn: ['company-credential'] } : {}) }));
    base.dependencies.push({ id: 'company-credential', name: 'Dedicated synthetic read-only DB credential', type: 'CREDENTIAL', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', dependsOn: [], grants: { credentialRefs: [resource.credentialRef] } });
    capability = await post<CapabilityDTO>('/api/seller/capabilities', CreateCapabilitySchema.parse({ ioContract: base.ioContract, permissions: base.permissions, dependencies: base.dependencies, internalInstructions: base.internalInstructions,
      title: `Research DB fixture ${id}`, summary: 'Synthetic read-only database plus reviewed public research acceptance.', description: 'Private ephemeral test capability. No paid provider acceptance.', category: 'Research', tags: ['test-fixture'], priceTierId: 'USD_99', workerId: identity.workerId, estimatedDurationSeconds: 60 }), seller);
    const manifest = LocalCapabilitySchema.parse({ ...base, capabilityVersionId: capability.versionId }); approveCapability(state, manifest, hashManifest(manifest));
    const resourceBroker = createResourceBroker(state, secrets, manifest);
    try { await resourceBroker.checkHealth(); } catch { throw new Error('RESEARCH_FIXTURE_RESOURCE_SETUP_REQUIRED'); } finally { resourceBroker.close(); }
    const transport = new WorkerTransport(apiUrl, identity, await secrets.get('device-identity'), true), authenticated = await transport.diagnostics(); assert.equal(authenticated.sellerId, seller.user.id);
    const plan = { schemaVersion: 1, capabilityVersionId: capability.versionId, dependencyBindingHash: hashManifest(manifest.dependencies), limits: {}, sources: [{ id: 'public-example', operation: 'FETCH', request: { url: 'https://example.com/', method: 'GET' },
      provenance: { kind: 'REVIEWED_PUBLIC_LITERAL', sourceUrl: 'https://example.com/', reviewedBy: authenticated.sellerId, reviewedAt: new Date().toISOString() } }] };
    const review = approveResearchPlan(state, plan, authenticated.sellerId!); approveResearchPlan(state, plan, authenticated.sellerId!, review.approvalHash);
    stage('real-validation-with-readonly-postgres'); run = { name: 'validation', rowId: 'a1', privateName: 'Allowed company', trace: `validation-${randomUUID()}`, step: 0, rawUrlDenied: false };
    await testCapability(state, secrets, capability.versionId, { rowId: run.rowId, trace: run.trace }, imageId, true);
    check(run.step === 4 && run.rawUrlDenied && !providerError, 'VALIDATION_INCOMPLETE');
    const observed = reviewObservations(state, capability.versionId); check(observed.report, 'OBSERVATIONS_MISSING');
    assert.deepEqual(observed.report.resources, [{ id: 'companies', operations: ['get'], evidence: 'HOST_BROKER_COMPLETED' }]);
    assert.equal(observed.report.network.length, 1); assert.equal(observed.report.network[0]!.host, 'example.com');
    reviewObservations(state, capability.versionId, observed.approvalHash);
    await workerCommand(['resume', '--all']); runtime = new WorkerRuntime(state, secrets, imageId, true);
    runtimeTask = runtime.start().catch(error => { runtimeError = error; }).finally(() => { runtimeDone = true; });
    await until(async () => (await json<{ id: string; localPaused: boolean; bindings: { capabilityVersionId: string; healthy: boolean }[] }[]>('/api/seller/workers', {}, seller)).some(worker => worker.id === identity!.workerId && !worker.localPaused && worker.bindings.some(binding => binding.capabilityVersionId === capability!.versionId && binding.healthy)), 60000, 'WORKER_NOT_READY');
    await post(`/api/seller/capabilities/${capability.id}/publish`, { visibility: 'PRIVATE', localExecutionAcknowledged: true }, seller); await post(`/api/seller/capabilities/${capability.id}/grants`, { email: buyer.user.email, allowed: true }, seller);
    check((await json<CapabilityDTO>(`/api/capabilities/${capability.id}`, {}, buyer)).availability.canRunNow, 'NOT_AVAILABLE');
    await post('/api/wallet/topup', { amountMinor: 500 }, buyer, { 'Idempotency-Key': randomUUID() });
    const beforeBuyer = await json<Wallet>('/api/wallet', {}, buyer), beforeSeller = await json<Wallet>('/api/wallet', {}, seller);
    stage('signed-purchase-db-and-cache'); run = { name: 'purchase', rowId: 'a2', privateName: 'Second company', trace: `buyer-${randomUUID()}`, step: 0, rawUrlDenied: false };
    const quote = await post<{ id: string }>(`/api/capabilities/${capability.id}/quote`, { executionMode: 'NOW' }, buyer), key = { 'Idempotency-Key': randomUUID() };
    const body = { capabilityId: capability.id, input: { rowId: run.rowId, trace: run.trace }, executionMode: 'NOW', quoteId: quote.id };
    let job = await post<JobDTO>('/api/jobs', body, buyer, key); assert.equal((await post<JobDTO>('/api/jobs', body, buyer, key)).id, job.id);
    await until(async () => { job = await json<JobDTO>(`/api/jobs/${job.id}`, {}, buyer); return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(job.state); }, 180000, 'JOB_TIMEOUT');
    assert.equal(job.state, 'SUCCEEDED'); assert.equal(job.paymentState, 'SETTLED'); assert.equal(job.output?.text, `${run.trace}: ${run.privateName}; Example Domain`);
    check(run.step === 4 && run.rawUrlDenied && run.receipt, 'PURCHASE_TOOL_FLOW_INCOMPLETE'); assert.deepEqual(readReceipt(job.id), run.receipt);
    const rows = state.db.prepare('SELECT id,event FROM audit WHERE jobId=? ORDER BY id').all(job.id) as { id: number; event: string }[];
    const prefetch = rows.find(row => row.event === 'RESEARCH_REQUEST_COMPLETED'), privateRead = rows.find(row => row.event === 'RESOURCE_ALLOWED');
    check(prefetch && privateRead && prefetch.id < privateRead.id, 'PREFETCH_BEFORE_PRIVATE_PROOF');
    assert.equal(rows.filter(row => row.event === 'RESEARCH_REQUEST_RESERVED').length, 1);
    for (const secret of [run.privateName, run.trace, 'kivro_resource_local_only', 'kivro_resource_reader', 'resource_fixture']) check(!JSON.stringify(run.receipt).includes(secret), 'RECEIPT_PRIVATE_DATA_LEAK');
    const attempts = await api.kivro.db.jobAttempt.findMany({ where: { jobId: job.id } }); assert.equal(attempts.length, 1); assert.equal(attempts[0]!.workerId, identity.workerId);
    stage('exact-result-replay-and-settlement');
    // API normalization adds assets:[] to stored TEXT output. Replay the exact
    // original Worker shape, independently checked against its committed hash.
    const wireOutput = { text: job.output!.text! };
    assert.equal(hashManifest(wireOutput), attempts[0]!.resultHash);
    await transport.request('POST', `/api/worker/jobs/${job.id}/result`, { attemptId: attempts[0]!.id, output: wireOutput }); await runtime.flush();
    await until(async () => state.attempt(job.id)?.state === 'SUCCEEDED' && !runtime!.active.size, 20000, 'LOCAL_FINALIZATION');
    const afterBuyer = await json<Wallet>('/api/wallet', {}, buyer), afterSeller = await json<Wallet>('/api/wallet', {}, seller);
    assert.equal(afterBuyer.ledger.filter(entry => entry.jobId === job.id && entry.type === 'JOB_CAPTURE').length, 1); assert.equal(afterSeller.ledger.filter(entry => entry.jobId === job.id && entry.type === 'SELLER_EARNING').length, 1);
    assert.equal(beforeBuyer.availableMinor - afterBuyer.availableMinor, job.priceSnapshot.buyerPriceMinor); assert.equal(afterBuyer.spentMinor - beforeBuyer.spentMinor, job.priceSnapshot.buyerPriceMinor); assert.equal(afterBuyer.reservedMinor, 0); assert.equal(afterSeller.earnedMinor - beforeSeller.earnedMinor, job.priceSnapshot.sellerNetMinor);
    const ledger = await api.kivro.db.ledgerEntry.findMany({ where: { jobId: job.id, type: { in: ['JOB_CAPTURE', 'SELLER_EARNING', 'PLATFORM_FEE'] } } });
    assert.equal(ledger.length, 3); assert.equal(new Set(ledger.map(entry => entry.type)).size, 3); assert.equal(new Set(ledger.map(entry => entry.transactionId)).size, 1); assert.equal(ledger.reduce((sum, entry) => sum + entry.amountMinor, 0), 0);
    const sourceProbe = createResourceBroker(state, secrets, manifest), probeId = randomUUID();
    try {
      for (const [rowId, name] of [['a1', 'Allowed company'], ['a2', 'Second company']] as const) {
        const observed = await sourceProbe.execute({ jobId: probeId, resourceId: resource.id, operation: 'get', input: { id: rowId }, permissions: manifest.permissions, dependencies: manifest.dependencies });
        assert.deepEqual(observed.data, [{ id: rowId, name }]);
      }
    } finally { sourceProbe.close(); }
    evidence = { kind: KIND, at: new Date().toISOString(), fixtureId: id, jobId: job.id, capabilityId: capability.id, attemptId: attempts[0]!.id, workerId: identity.workerId, sellerId: seller.user.id, imageId,
      databaseSchema: schema, syntheticReadonlyPostgres: true, realOpenClaw: true, signedWorkerProtocol: true, realProviderAcceptance: false, paymentMode: 'fake', background: false, browser: false,
      inferenceRequests: providerRequests, publicFetch: { host: run.receipt.host, requests: 1, status: run.receipt.status, bytes: run.receipt.actualBytes, responseSha256: run.receipt.responseSha256 },
      prefetchBeforePrivateAndInference: true, cacheAfterPrivate: true, privateDerivedUrlDenied: true, publicRequestsAfterPrivate: 0, sanitizedReceipt: true, syntheticSourceRowsUnchanged: true,
      resultSha256: sha256(job.output!.text!), captures: 1, sellerEarnings: 1, platformFees: 1, balancedSettlementTransactions: 1, resultReplayChecked: true };
  } catch (error) { failure = error; console.error(JSON.stringify({ kind: KIND, passed: false, phase, code: providerError ?? safeCode(error) })); }
  finally {
    clearTimeout(watchdog); const cleanup = async (name: string, action: () => Promise<unknown>) => { try { await action(); } catch { cleanupErrors.push(name); } };
    if (api && capability && seller) await cleanup('cancel-owned-unfinished-jobs', async () => {
      const jobs = await api!.kivro.db.job.findMany({ where: { capabilityId: capability!.id, sellerId: seller!.user.id, paymentState: 'RESERVED' } });
      for (const job of jobs) await post(`/api/jobs/${job.id}/cancel`, {}, seller, {}, true);
    });
    state.pause('LOCAL'); state.set('stopRequested', true);
    if (capability && seller) await cleanup('pause-capability', () => post(`/api/seller/capabilities/${capability!.id}/pause`, { paused: true }, seller, {}, true));
    if (runtimeTask) await cleanup('stop-runtime', () => runtimeTask!); if (runtimeError) cleanupErrors.push('runtime-error');
    if (identity) await cleanup('owned-container-cleanup', async () => {
      const docker = new DockerSandbox(), ids = (await docker.call(['ps', '-aq', '--filter', `label=io.kivro.owner=${identity!.workerId}`])).trim().split(/\s+/).filter(Boolean);
      for (const containerId of ids) { const info = JSON.parse(await docker.call(['inspect', containerId]))[0]; assert.equal(info.Config.Labels['io.kivro.owner'], identity!.workerId); await docker.remove({ name: info.Name.replace(/^\//, ''), owner: identity!.workerId, attemptId: info.Config.Labels['io.kivro.attempt'] }); }
      check(!(await docker.call(['ps', '-aq', '--filter', `label=io.kivro.owner=${identity!.workerId}`])).trim(), 'CONTAINERS_REMAIN');
    });
    if (identity && seller) { await cleanup('pause-worker', () => post(`/api/seller/workers/${identity!.workerId}/pause`, {}, seller, {}, true)); await cleanup('revoke-worker', () => post(`/api/seller/workers/${identity!.workerId}/revoke`, {}, seller, {}, true)); }
    if (capability && seller && buyer) await cleanup('revoke-grant', () => post(`/api/seller/capabilities/${capability!.id}/grants`, { email: buyer!.user.email, allowed: false }, seller, {}, true));
    for (const account of [buyer, seller]) if (account) await cleanup('logout', () => post('/api/auth/logout', {}, account, {}, true));
    if (api) await cleanup('verify-cleanup', async () => {
      if (identity) { const worker = await api!.kivro.db.workerDevice.findUniqueOrThrow({ where: { id: identity.workerId } }); check(worker.paused && worker.revokedAt && !worker.sandboxReady, 'WORKER_NOT_REVOKED'); }
      if (capability) { check((await api!.kivro.db.capability.findUniqueOrThrow({ where: { id: capability.id } })).paused, 'CAPABILITY_NOT_PAUSED'); assert.equal(await api!.kivro.db.capabilityGrant.count({ where: { capabilityId: capability.id } }), 0); }
      for (const account of [buyer, seller]) if (account) assert.equal(await api!.kivro.db.session.count({ where: { userId: account.user.id } }), 0);
      check(!state.get('securityBlock') && !state.activeAttempts().length && !runtime?.active.size && !state.pending().length, 'LOCAL_CLEANUP_INCOMPLETE');
    });
    await cleanup('provider-server', async () => { provider.closeAllConnections(); if (provider.listening) await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())); });
    if (api) await cleanup('api-server', async () => { await api!.close(); (api!.kivro.storage as S3ObjectStore).client.destroy(); });
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); state.close(); await cleanup('temporary-state', () => rm(root, { recursive: true, force: true }));
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  if (failure || cleanupErrors.length || !evidence) { console.error(JSON.stringify({ kind: KIND, passed: false, phase, code: providerError ?? safeCode(failure), fixtureId: id, cleanupErrors })); process.exitCode = 1; }
  else console.log(JSON.stringify({ ...evidence, cleanup: 'worker-revoked-capability-paused-grant-revoked-sessions-ended-containers-and-temp-state-removed', passed: true }));
}
main().catch(error => { console.error(JSON.stringify({ kind: KIND, passed: false, code: safeCode(error) })); process.exitCode = 1; });
