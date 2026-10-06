// Deterministic TEST FIXTURE only. Never imported by production services.
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
import { testCapability } from '../apps/worker/src/validation.ts';
import { validateInferenceConfig } from '../apps/worker/src/inference.ts';
import { CreateCapabilitySchema, hashManifest, type AssetDTO, type CapabilityDTO, type JobDTO } from '../packages/contracts/src/index.js';
import { sha256 } from '../packages/crypto/src/index.ts';
import { DockerSandbox, detectRuntime } from '../packages/openclaw-adapter/src/index.ts';
import type { S3ObjectStore } from '../packages/storage/src/index.js';
import { FixtureBrowser, fixtureWebOrigin } from './e2e-fixture-browser.js';
import { FixtureBackground, fixtureSchema, ISOLATED_FIXTURE_REDIS } from './e2e-fixture-background.js';
import { FixtureInferenceGate, FixturePauseMatrix, PAUSE_FIXTURE_BUDGET_MS, pauseFixtureImage, type PauseScenario } from './e2e-fixture-pause.js';

const MODEL = 'kivro-deterministic-fullstack-fixture';
const IMAGE = 'kivro-sandbox:2026.8.2';
const ORIGIN = 'http://127.0.0.1:3000';
// Public synthetic credentials from infrastructure/compose.yaml and s3.local.json.
// Do not load .env or spread process.env into the API configuration.
const API_ENV = {
  NODE_ENV: 'test', KIVRO_ENV: 'development', PAYMENT_MODE: 'fake', DEV_AUTH_ENABLED: 'false',
  DATABASE_URL: 'postgresql://kivro:kivro_local_only@127.0.0.1:55432/kivro?schema=public',
  REDIS_URL: 'redis://127.0.0.1:56379', WEB_ORIGIN: ORIGIN,
  S3_ENDPOINT: 'http://127.0.0.1:59000', S3_BUCKET: 'kivro-development', S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'kivro_local', S3_SECRET_KEY: 'kivro_local_storage_only', S3_FORCE_PATH_STYLE: 'true',
};
type Account = { cookie: string; user: { id: string; email: string } };
type Message = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
type FixtureRun = { name: 'validation' | 'purchase' | 'seller-cancel' | 'invalid-output' | 'timeout' | PauseScenario; assetId: string; marker: string; step: number; readObserved: boolean; report?: string; holding?: boolean; gate?: FixtureInferenceGate };
type Wallet = { availableMinor: number; reservedMinor: number; spentMinor: number; earnedMinor: number; ledger: { jobId: string | null; type: string }[] };

function check(value: unknown, code: string): asserts value { if (!value) throw new Error(`FIXTURE_${code}`); }
function safeCode(error: unknown): string {
  return error instanceof Error && /^[A-Z0-9_:/.-]{1,200}$/.test(error.message) ? error.message : 'FIXTURE_OPERATION_FAILED';
}
async function boundedBody(response: Response, maxBytes = 2 * 1024 ** 2): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0;
  check(response.body, 'RESPONSE_BODY_MISSING');
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; check(bytes <= maxBytes, 'RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).join(' '), faults = args === '--run --faults', browserMode = args === '--run --browser', pauseMode = args === '--run --pause';
  if (args !== '--run' && !faults && !browserMode && !pauseMode) {
    console.log('Deterministic local TEST FIXTURE, not real-provider acceptance. Run: node --import tsx scripts/e2e-fixture.ts --run [--faults|--browser|--pause]');
    return;
  }
  check(process.env.NODE_ENV !== 'production' && process.env.KIVRO_ENV !== 'production', 'PRODUCTION_DENIED');
  // Validate before temp state, networking, browser/CORS, DB or queue mutation.
  const schema = fixtureSchema(process.env.KIVRO_FIXTURE_SCHEMA);
  const image = pauseMode ? pauseFixtureImage(process.env.KIVRO_PAUSE_FIXTURE_IMAGE ?? IMAGE) : IMAGE;
  const backgroundEnabled = browserMode && schema !== 'public';
  const origin = browserMode ? await fixtureWebOrigin() : ORIGIN;
  const databaseUrl = new URL(API_ENV.DATABASE_URL); databaseUrl.searchParams.set('schema', schema);
  const apiEnv = { ...API_ENV, DATABASE_URL: databaseUrl.toString(), WEB_ORIGIN: origin,
    ...(pauseMode ? { KIVRO_MAX_JOB_PAUSE_MS: String(PAUSE_FIXTURE_BUDGET_MS) } : {}),
    REDIS_URL: backgroundEnabled ? ISOLATED_FIXTURE_REDIS : API_ENV.REDIS_URL };
  const id = randomUUID(), fixtureToken = `kivro-test-only-${randomBytes(24).toString('hex')}`;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-fullstack-fixture-')));
  const state = new WorkerState(join(root, 'worker'));
  const secrets = new SecretStore(state);
  const abort = new AbortController();
  const cancel = () => { abort.abort(); state.pause('LOCAL'); state.set('stopRequested', true); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const watchdog = setTimeout(() => process.emit('SIGTERM'), 10 * 60_000);
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries({ KIVRO_WORKER_HOME: state.root, KIVRO_WORKER_MASTER_KEY: randomBytes(32).toString('hex'),
    KIVRO_SANDBOX_IMAGE: image, KIVRO_ENV: 'development', NODE_ENV: 'test', DEV_AUTH_ENABLED: 'false' })) {
    saved.set(key, process.env[key]); process.env[key] = value;
  }
  let api: Awaited<ReturnType<typeof createApp>> | undefined;
  let apiUrl = '', phase = 'prerequisites', providerError: string | undefined, providerRequests = 0;
  let run: FixtureRun | undefined, runtime: WorkerRuntime | undefined, runtimeTask: Promise<void> | undefined, runtimeError: unknown;
  let seller: Account | undefined, buyer: Account | undefined, capability: CapabilityDTO | undefined, identity: DeviceIdentity | undefined;
  let evidence: Record<string, unknown> | undefined, failure: unknown;
  let browser: FixtureBrowser | undefined, background: FixtureBackground | undefined, corsChanged = false;
  let pauseMatrix: FixturePauseMatrix | undefined;
  const createdJobs: string[] = [], faultReceipts: Record<string, unknown>[] = [];
  const cleanupErrors: string[] = [];
  const stage = (name: string) => { phase = name; console.log(`TEST_FIXTURE ${name}`); check(!abort.signal.aborted, 'CANCELLED'); };
  const request = async (path: string, options: RequestInit = {}, account?: Account, cleanup = false) => {
    check(path.startsWith('/') && !path.startsWith('//'), 'INVALID_API_PATH');
    const timeout = AbortSignal.timeout(20_000);
    return fetch(`${apiUrl}${path}`, { ...options, redirect: 'manual', headers: {
      Origin: origin, ...(account ? { Cookie: account.cookie } : {}), ...options.headers,
    }, signal: cleanup ? timeout : AbortSignal.any([abort.signal, timeout]) });
  };
  const json = async <T>(path: string, options: RequestInit = {}, account?: Account, cleanup = false): Promise<T> => {
    const response = await request(path, options, account, cleanup);
    const body = JSON.parse((await boundedBody(response)).toString());
    if (!response.ok) throw new Error(`FIXTURE_API_${response.status}_${/^[A-Z0-9_]+$/.test(body.error?.code) ? body.error.code : 'ERROR'}`);
    if (path === '/api/jobs' && options.method === 'POST' || /^\/api\/jobs\/[a-f0-9-]{36}$/.test(path)) {
      assert.equal(response.headers.get('x-kivro-correlation-id'), body.id);
      assert.equal(body.correlationId, body.id);
    }
    return body as T;
  };
  const post = <T>(path: string, body: unknown, account?: Account, headers: Record<string, string> = {}, cleanup = false) =>
    json<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }, account, cleanup);
  const register = async (role: 'seller' | 'buyer'): Promise<Account> => {
    const terms = await json<{ version: string }>('/api/terms');
    const response = await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Deterministic fixture ${role}`, email: `fixture-${role}-${id}@kivro.invalid`, password: randomBytes(32).toString('base64url'), acceptedTermsVersion: terms.version }) });
    check(response.ok, `REGISTER_${role.toUpperCase()}_${response.status}`);
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    check(cookie, 'REGISTRATION_SESSION_MISSING');
    return { cookie, ...JSON.parse((await boundedBody(response)).toString()) };
  };
  const provider = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/v1/models') {
        check(req.headers.authorization === `Bearer ${fixtureToken}`, 'INFERENCE_TOKEN');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: MODEL }] })); return;
      }
      check(req.method === 'POST' && req.url === '/v1/chat/completions', 'INFERENCE_ROUTE');
      check(req.headers.authorization === `Bearer ${fixtureToken}`, 'INFERENCE_TOKEN');
      check(++providerRequests <= (faults || pauseMode ? 48 : 12), 'INFERENCE_REQUEST_LIMIT');
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { bytes += chunk.length; check(bytes <= 2 * 1024 ** 2, 'INFERENCE_BODY_LIMIT'); chunks.push(Buffer.from(chunk)); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      check(body.model === MODEL && body.store === false && body.stream === false, 'INFERENCE_CONTRACT');
      const messages = body.messages as Message[];
      check(Array.isArray(messages), 'INFERENCE_MESSAGES');
      let content = 'OK', call: { name: string; arguments: string } | undefined;
      if (!run) {
        check(!body.tools?.length && messages.length === 1 && messages[0]?.content === 'Reply with OK.', 'INFERENCE_HEALTH_REQUEST');
      } else {
        const current = run;
        const tools = (body.tools as { function: { name: string } }[]).map(tool => tool.function.name).sort();
        check(JSON.stringify(tools) === JSON.stringify(['read', 'write']), 'TOOL_ALLOWLIST');
        if (current.gate) {
          const gate = current.gate, closed = () => gate.release();
          res.once('close', closed);
          await gate.enter();
          res.removeListener('close', closed);
          if (res.destroyed) return;
        }
        if (current.name === 'seller-cancel' || current.name === 'timeout') {
          current.holding = true;
          await new Promise<void>(resolve => res.once('close', resolve));
          return;
        }
        const toolReply = (step: number) => {
          // OpenClaw may normalize provider call IDs before its next request.
          const prior = messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? [])[step - 1];
          check(prior, 'REAL_TOOL_CALL_HISTORY_MISSING');
          const expectedPaths = [`input/${current.assetId}`, 'result/report.txt', 'result/kivro-result.json'];
          check(prior.function.name === (step === 1 ? 'read' : 'write') && JSON.parse(prior.function.arguments).path === expectedPaths[step - 1], 'TOOL_CALL_HISTORY_MISMATCH');
          return messages.find(message => message.role === 'tool' && message.tool_call_id === prior.id);
        };
        if (current.step === 0) {
          check(!JSON.stringify(messages).includes(current.marker), 'INPUT_MARKER_LEAKED_IN_PROMPT');
          check(JSON.stringify(messages).includes(`input/${current.assetId}`), 'INPUT_SNAPSHOT_NOT_DECLARED');
          call = { name: 'read', arguments: JSON.stringify({ path: `input/${current.assetId}` }) };
        } else if (current.step === 1) {
          const reply = toolReply(1); check(reply, 'REAL_READ_TOOL_REPLY_MISSING');
          const observed = JSON.stringify(reply.content).match(/KIVRO_FILE_BYTES_[a-f0-9-]{36}/g);
          check(observed?.length === 1 && observed[0] === current.marker, 'REQUIRED_FILE_NOT_CONSUMED');
          current.readObserved = true;
          current.report = `Deterministic full-stack TEST FIXTURE\nConsumed reference: ${observed[0]}\n`;
          if (current.name === 'invalid-output') content = JSON.stringify({ text: 'Intentionally incomplete fixture output', fields: { summary: current.marker } });
          else call = { name: 'write', arguments: JSON.stringify({ path: 'result/report.txt', content: current.report }) };
        } else if (current.step === 2) {
          check(JSON.stringify(toolReply(2)?.content).includes('Successfully wrote'), 'REAL_REPORT_WRITE_MISSING');
          call = { name: 'write', arguments: JSON.stringify({ path: 'result/kivro-result.json', content: JSON.stringify({ text: current.marker, fields: { summary: current.marker, document: 'report.txt' } }) }) };
        } else {
          check(current.step === 3 && JSON.stringify(toolReply(3)?.content).includes('Successfully wrote'), 'REAL_MANIFEST_WRITE_MISSING');
          content = current.marker;
        }
        current.step++;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: `fixture-${providerRequests}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL,
        choices: [{ index: 0, message: call ? { role: 'assistant', content: null, tool_calls: [{ id: `fixture-${run!.name}-${run!.step}`, type: 'function', function: call }] } : { role: 'assistant', content }, finish_reason: call ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: call ? 100 : 1, total_tokens: call ? 200 : 101 },
      }));
    } catch (error) { providerError = safeCode(error); res.writeHead(400).end(JSON.stringify({ error: { code: providerError } })); }
  });
  provider.requestTimeout = 15_000; provider.headersTimeout = 10_000; provider.maxConnections = 2;
  try {
    const docker = new DockerSandbox(); await docker.available(); await docker.imageId(image);
    check((await detectRuntime()).compatible, 'UNSUPPORTED_HOST_OPENCLAW');
    // No injected DB, storage, billing, transport, sandbox or proof substitutes.
    // Real maintenance runs only against a caller-created disposable schema and
    // an exclusive local Redis namespace, never the shared public-schema jobs.
    if (backgroundEnabled) { background = new FixtureBackground(id, abort.signal); await background.acquire(); }
    api = await createApp({ env: apiEnv, background: backgroundEnabled, logger: false });
    apiUrl = await api.listen({ host: '127.0.0.1', port: 0 });
    saved.set('API_URL', process.env.API_URL); process.env.API_URL = apiUrl;
    const ready = await json<{ status: string; services: Record<string, string> }>('/ready');
    check(ready.status === 'ready' && ['database', 'storage', 'redis'].every(name => ready.services[name] === 'ready'), 'LOCAL_SERVICES_NOT_READY');
    await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
    const address = provider.address(); check(address && typeof address === 'object', 'INFERENCE_LISTEN_FAILED');
    stage('register-and-pair'); seller = await register('seller'); buyer = await register('buyer');
    check(seller.user.id !== buyer.user.id, 'IDENTITIES_MUST_DIFFER');
    const pairing = await post<{ code: string }>('/api/seller/pairing-code', {}, seller);
    await workerCommand(['pair', pairing.code, '--name', `Deterministic fixture ${id}`]);
    identity = state.get<DeviceIdentity>('identity'); check(identity, 'PAIRING_NOT_PERSISTED');
    stage('real-sandbox-and-inference-proofs');
    await workerCommand(['sandbox', 'approve-image']);
    await secrets.put('fixture-inference', fixtureToken);
    const config = validateInferenceConfig({ provider: 'openai-compatible', model: MODEL, credentialRef: 'fixture-inference',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, allowLocal: true, maxTokensPerJob: 200000, dailyTokenLimit: 1000000,
      inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 });
    const configPath = join(root, 'inference.json'); await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await workerCommand(['inference', 'configure', '--file', configPath, '--approve', hashManifest(config)]);
    await workerCommand(['inference', 'test']);
    check(!providerError && state.get('sandboxProof') && state.get('inferenceProof'), 'LIVE_PROOFS_MISSING');
    const base = LocalCapabilitySchema.parse({ capabilityVersionId: randomUUID(), selectedSkills: [], dependencies: [],
      internalInstructions: 'Read the required source file. Preserve its exact reference in summary and report.txt. Write the named-field result manifest. This is a deterministic local TEST FIXTURE, not a real-provider acceptance test.',
      permissions: { schemaVersion: 1, tools: ['read', 'write'], resources: [], network: { mode: 'NONE', allowedDomains: [] },
        inference: { provider: config.provider, model: config.model, credentialRef: config.credentialRef },
        limits: { timeoutSeconds: faults || pauseMode ? 30 : 120, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 65536, maxOutputBytes: 65536, maxTokens: 200000 } },
      ioContract: { schemaVersion: 1, inputs: [{ key: 'source', label: 'Source', type: 'FILE', required: true, order: 0,
        constraints: { allowedMimeTypes: ['text/plain'], allowedExtensions: ['.txt'], maxFileSizeBytes: 4096 } }],
        output: { type: 'MIXED', description: 'Consumed source reference and report', required: true,
          fields: [{ key: 'summary', label: 'Summary', type: 'SHORT_TEXT', required: true, order: 0 },
            { key: 'document', label: 'Report', type: 'FILE', required: true, order: 1, constraints: { allowedMimeTypes: ['text/plain'], allowedExtensions: ['.txt'], maxFileSizeBytes: 4096 } }],
          files: { allowedMimeTypes: ['text/plain'], allowedExtensions: ['.txt'], maxFiles: 1, maxTotalSizeBytes: 4096 } } },
    });
    base.dependencies = discoveredDependencyGrants(state, base).map(dependency => ({ ...dependency, approved: true }));
    check(base.dependencies.every(dependency => dependency.healthy && dependency.supported), 'UNHEALTHY_DEPENDENCY');
    const definition = CreateCapabilitySchema.parse({ title: `Deterministic fixture ${id}`, summary: 'Local deterministic file roundtrip test fixture only.',
      description: 'Synthetic, private, ephemeral-worker validation. Not real-provider acceptance.', category: 'Writing & documents', tags: ['test-fixture'],
      priceTierId: 'USD_99', ioContract: base.ioContract, permissions: base.permissions, dependencies: base.dependencies,
      internalInstructions: base.internalInstructions, workerId: identity.workerId, estimatedDurationSeconds: 60 });
    capability = await post<CapabilityDTO>('/api/seller/capabilities', definition, seller);
    const manifest = LocalCapabilitySchema.parse({ ...base, capabilityVersionId: capability.versionId });
    approveCapability(state, manifest, hashManifest(manifest));
    stage('real-capability-validation');
    const validationMarker = `KIVRO_FILE_BYTES_${randomUUID()}`, validationId = randomUUID();
    const validationPath = join(root, 'validation-source.txt'); await writeFile(validationPath, validationMarker, { mode: 0o444 });
    run = { name: 'validation', assetId: validationId, marker: validationMarker, step: 0, readObserved: false };
    await testCapability(state, secrets, capability.versionId, { input: { source: validationId }, assets: [{ id: validationId, path: validationPath,
      filename: 'source.txt', mimeType: 'text/plain', sizeBytes: Buffer.byteLength(validationMarker), sha256: sha256(validationMarker) }] }, image, true);
    check(!providerError && run.readObserved && run.step === 4, 'VALIDATION_FLOW_INCOMPLETE');
    await workerCommand(['resume', '--all']);
    stage('runtime-readiness-and-private-publication');
    let runtimeDone = false;
    const startRuntime = (runtimeImage = image) => {
      runtimeDone = false; runtimeError = undefined; runtime = new WorkerRuntime(state, secrets, runtimeImage, true);
      runtimeTask = runtime.start().catch(error => { runtimeError = error; }).finally(() => { runtimeDone = true; });
    };
    startRuntime();
    const until = async (predicate: () => Promise<boolean>, timeoutMs: number, code: string, requireRuntime = true) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        check(!abort.signal.aborted, 'CANCELLED'); if (requireRuntime) check(!runtimeDone, 'RUNTIME_STOPPED');
        if (providerError) throw new Error(providerError);
        if (await predicate()) return;
        await delay(500);
      }
      throw new Error(`FIXTURE_${code}`);
    };
    await until(async () => {
      const workers = await json<{ id: string; sandboxReady: boolean; localPaused: boolean; bindings: { capabilityVersionId: string; healthy: boolean }[] }[]>('/api/seller/workers', {}, seller);
      return runtime!.readyCapabilityIds().includes(capability!.versionId) && workers.some(worker => worker.id === identity!.workerId && worker.sandboxReady && !worker.localPaused && worker.bindings.some(binding => binding.capabilityVersionId === capability!.versionId && binding.healthy));
    }, 60_000, 'RUNTIME_NOT_READY');
    await post(`/api/seller/capabilities/${capability.id}/publish`, { visibility: 'PRIVATE', localExecutionAcknowledged: true }, seller);
    check((await request(`/api/capabilities/${capability.id}`, {}, buyer)).status === 404, 'PRIVATE_CAPABILITY_WITHOUT_GRANT');
    await post(`/api/seller/capabilities/${capability.id}/grants`, { email: buyer.user.email, allowed: true }, seller);
    const visible = await json<CapabilityDTO>(`/api/capabilities/${capability.id}`, {}, buyer);
    check(visible.visibility === 'PRIVATE' && visible.availability.canRunNow, 'CAPABILITY_UNAVAILABLE');
    stage('required-file-purchase');
    const marker = `KIVRO_FILE_BYTES_${randomUUID()}`;
    let inputAsset: AssetDTO;
    if (browserMode) {
      stage('real-next-buyer-file-upload');
      corsChanged = true;
      await (api.kivro.storage as S3ObjectStore).configureBrowserOrigin(origin);
      browser = new FixtureBrowser(origin, abort.signal);
      await browser.start(apiUrl, buyer.cookie);
      console.log(`TEST_FIXTURE buyer-browser-origin ${origin}`);
      inputAsset = await browser.uploadSource(visible, marker, API_ENV.S3_ENDPOINT);
      const finalized = await api.kivro.db.asset.findUniqueOrThrow({ where: { id: inputAsset.id } });
      assert.equal(finalized.ownerId, buyer.user.id); assert.equal(finalized.sha256, inputAsset.sha256);
    } else {
      const upload = new FormData(); upload.set('file', new Blob([marker], { type: 'text/plain' }), 'source.txt');
      inputAsset = await json<AssetDTO>('/api/assets/upload', { method: 'POST', body: upload }, buyer);
    }
    assert.equal(inputAsset.sha256, sha256(marker)); assert.equal(inputAsset.sizeBytes, Buffer.byteLength(marker));
    if (faults) {
      const stopRuntime = async () => { state.set('stopRequested', true); await runtimeTask; check(!runtimeError, 'RUNTIME_STOP_FAILED'); };
      const readyAgain = async () => {
        await workerCommand(['resume', '--all']); startRuntime();
        await until(async () => (await json<CapabilityDTO>(`/api/capabilities/${capability!.id}`, {}, buyer)).availability.canRunNow, 60_000, 'RESTORED_RUNTIME_NOT_READY');
      };
      const purchaseBody = { capabilityId: capability.id, input: { source: inputAsset.id }, executionMode: 'NOW' };
      const rejectAdmission = async (name: string, status: number, code: string) => {
        const before = await json<Wallet>('/api/wallet', {}, buyer), count = await api!.kivro.db.job.count({ where: { capabilityId: capability!.id } });
        const response = await request('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(purchaseBody) }, buyer);
        const result = JSON.parse((await boundedBody(response)).toString());
        assert.equal(response.status, status); assert.equal(result.error?.code, code);
        assert.deepEqual(await json<Wallet>('/api/wallet', {}, buyer), before);
        assert.equal(await api!.kivro.db.job.count({ where: { capabilityId: capability!.id } }), count);
        faultReceipts.push({ case: name, boundary: 'admission', httpStatus: status, code, jobsCreated: 0, captures: 0, reservesCreated: 0 });
      };
      stage('fault-insufficient-funds'); await rejectAdmission('insufficient-funds', 402, 'INSUFFICIENT_FUNDS');
      stage('fault-runtime-offline'); await stopRuntime();
      await until(async () => (await json<CapabilityDTO>(`/api/capabilities/${capability!.id}`, {}, buyer)).availability.status === 'OFFLINE', 90_000, 'OFFLINE_NOT_OBSERVED', false);
      await rejectAdmission('runtime-offline', 409, 'CAPABILITY_OFFLINE');
      stage('fault-sandbox-unavailable'); await workerCommand(['resume', '--all']);
      const missingImage = `kivro-missing-fixture-${id}:absent`;
      await assert.rejects(docker.imageId(missingImage)); startRuntime(missingImage);
      await until(async () => {
        const report = state.get<{ sandboxReady: boolean; checks: { id: string; status: string }[] }>('health');
        const workers = await json<{ id: string; sandboxReady: boolean }[]>('/api/seller/workers', {}, seller);
        return report?.sandboxReady === false && report.checks.some(check => check.id === 'sandbox' && check.status === 'FAIL') && workers.some(worker => worker.id === identity!.workerId && !worker.sandboxReady);
      }, 60_000, 'SANDBOX_FAILURE_NOT_OBSERVED');
      await rejectAdmission('sandbox-unavailable', 409, 'CAPABILITY_OFFLINE'); await stopRuntime(); await readyAgain();
      await post('/api/wallet/topup', { amountMinor: 1000 }, buyer, { 'Idempotency-Key': randomUUID() });
      const reservedJob = async (mode: 'NOW' | 'SCHEDULED' = 'NOW') => {
        const job = await post<JobDTO>('/api/jobs', { ...purchaseBody, executionMode: mode, ...(mode === 'SCHEDULED' ? { scheduledAt: new Date(Date.now() + 300_000).toISOString() } : {}) }, buyer, { 'Idempotency-Key': randomUUID() });
        createdJobs.push(job.id); return job;
      };
      const failedLedger = async (job: JobDTO, expected: 'CANCELLED' | 'FAILED' | 'TIMED_OUT', before: Wallet) => {
        await until(async () => {
          job = await json<JobDTO>(`/api/jobs/${job.id}`, {}, buyer);
          return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(job.state) && !runtime!.active.size && !state.activeAttempts().length;
        }, 100_000, 'FAULT_TERMINAL_TIMEOUT');
        await runtime!.flush(); check(job.state === expected, `EXPECTED_${expected}_GOT_${job.state}`); check(job.paymentState === 'RELEASED', `FAULT_PAYMENT_${job.paymentState}`);
        const after = await json<Wallet>('/api/wallet', {}, buyer);
        assert.equal(after.availableMinor, before.availableMinor); assert.equal(after.reservedMinor, before.reservedMinor); assert.equal(after.spentMinor, before.spentMinor);
        const entries = await api!.kivro.db.ledgerEntry.findMany({ where: { jobId: job.id } });
        assert.equal(entries.filter(entry => ['JOB_CAPTURE', 'SELLER_EARNING', 'PLATFORM_FEE'].includes(entry.type)).length, 0);
        assert.equal(entries.filter(entry => entry.type === 'JOB_RESERVE').length, 1); assert.equal(entries.filter(entry => entry.type === 'JOB_RELEASE').length, 1);
        const attempts = await api!.kivro.db.jobAttempt.findMany({ where: { jobId: job.id } });
        for (const attempt of attempts) check(!await docker.owned({ name: `kivro-job-${attempt.id}`, owner: identity!.workerId, attemptId: attempt.id }), 'FAULT_CONTAINER_REMAINS');
        const local = state.attempt(job.id);
        return { jobId: job.id, attemptIds: attempts.map(attempt => attempt.id), state: job.state, paymentState: job.paymentState, captures: 0, reserves: 1, releases: 1,
          containersRemaining: 0, events: job.events.map(event => event.type), startedAt: job.startedAt, completedAt: job.completedAt,
          ...(local ? { localAcceptedAt: new Date(local.createdAt).toISOString(), executionDeadlineAt: new Date(local.deadline).toISOString() } : {}) };
      };
      stage('fault-buyer-cancel-before-start');
      let before = await json<Wallet>('/api/wallet', {}, buyer), failed = await reservedJob('SCHEDULED');
      check(!failed.startedAt && failed.state === 'SCHEDULED', 'BUYER_CANCEL_NOT_BEFORE_START');
      await post(`/api/jobs/${failed.id}/cancel`, {}, buyer); await post(`/api/jobs/${failed.id}/cancel`, {}, buyer);
      faultReceipts.push({ case: 'buyer-cancel-before-start', boundary: 'scheduled-before-worker', ...await failedLedger(failed, 'CANCELLED', before) });
      for (const scenario of ['seller-cancel', 'invalid-output', 'timeout'] as const) {
        stage(`fault-${scenario}`); before = await json<Wallet>('/api/wallet', {}, buyer);
        run = { name: scenario, assetId: inputAsset.id, marker, step: 0, readObserved: false };
        await until(async () => (await json<CapabilityDTO>(`/api/capabilities/${capability!.id}`, {}, buyer)).availability.canRunNow, 30_000, 'FAULT_CAPABILITY_NOT_READY');
        failed = await reservedJob();
        await until(async () => {
          failed = await json<JobDTO>(`/api/jobs/${failed.id}`, {}, buyer);
          return failed.state === 'RUNNING' && !!runtime!.active.get(failed.id) && (scenario === 'invalid-output' || run!.holding === true);
        }, 45_000, 'FAULT_DID_NOT_RUN');
        await docker.inspect(runtime!.active.get(failed.id)!.spec);
        if (scenario === 'seller-cancel') {
          const denied = await request(`/api/jobs/${failed.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, buyer);
          assert.equal(denied.status, 409);
          await post(`/api/jobs/${failed.id}/cancel`, {}, seller);
        }
        const receipt = await failedLedger(failed, scenario === 'seller-cancel' ? 'CANCELLED' : scenario === 'timeout' ? 'TIMED_OUT' : 'FAILED', before);
        if (scenario === 'invalid-output') check(run.readObserved && run.step === 2, 'INVALID_OUTPUT_NOT_REAL_EXECUTION');
        let timing: Record<string, number> | undefined;
        if (scenario === 'timeout') {
          const attempt = state.attempt(failed.id), timeout = state.db.prepare("SELECT at FROM audit WHERE jobId=? AND event='TIMED_OUT' ORDER BY id LIMIT 1").get(failed.id) as { at: number } | undefined;
          check(run.holding && attempt && timeout, 'TIMEOUT_EVIDENCE_MISSING');
          // The persisted budget starts at acceptance, before preparation and RUNNING.
          assert.equal(attempt.deadline - attempt.createdAt, base.permissions.limits.timeoutSeconds * 1000);
          check(timeout.at >= attempt.deadline, 'TIMEOUT_TOO_EARLY');
          check(timeout.at - attempt.deadline <= 5000, 'TIMEOUT_DEADLINE_OVERRUN');
          timing = { localExecutionElapsedMs: timeout.at - attempt.createdAt, deadlineOvershootMs: timeout.at - attempt.deadline,
            maxDeadlineOvershootMs: 5000, cloudFinalizationElapsedMs: Date.parse(receipt.completedAt!) - attempt.createdAt };
        }
        faultReceipts.push({ case: scenario, boundary: scenario === 'invalid-output' ? 'worker-output-contract' : 'running-docker-execution', realContainerInspected: true,
          inferenceRequestsObserved: scenario === 'invalid-output' ? run.step : run.holding ? 1 : 0, timeoutSeconds: base.permissions.limits.timeoutSeconds, ...receipt, ...timing });
      }
      run = undefined;
      check(faultReceipts.length === 7, 'FAULT_MATRIX_INCOMPLETE');
      await until(async () => (await json<CapabilityDTO>(`/api/capabilities/${capability!.id}`, {}, buyer)).availability.canRunNow, 30_000, 'POST_FAULT_RUNTIME_NOT_READY');
    }
    if (pauseMode) {
      await post('/api/wallet/topup', { amountMinor: 1000 }, buyer, { 'Idempotency-Key': randomUUID() });
      pauseMatrix = new FixturePauseMatrix({ db: api.kivro.db, docker, state, runtime: runtime!, signal: abort.signal,
        workerId: identity.workerId, timeoutSeconds: base.permissions.limits.timeoutSeconds, stage, wait: until,
        job: jobId => json<JobDTO>(`/api/jobs/${jobId}`, {}, buyer),
        control: (jobId, action) => post<JobDTO>(`/api/jobs/${jobId}/${action}`, {}, seller),
        wallet: role => json<Wallet>('/api/wallet', {}, role === 'buyer' ? buyer : seller),
        purchase: async () => {
          await until(async () => (await json<CapabilityDTO>(`/api/capabilities/${capability!.id}`, {}, buyer)).availability.canRunNow, 30_000, 'PAUSE_CAPABILITY_NOT_READY');
          const job = await post<JobDTO>('/api/jobs', { capabilityId: capability!.id, input: { source: inputAsset.id }, executionMode: 'NOW' }, buyer, { 'Idempotency-Key': randomUUID() });
          createdJobs.push(job.id); return job;
        },
        begin: scenario => {
          const gate = new FixtureInferenceGate();
          run = { name: scenario, assetId: inputAsset.id, marker, step: 0, readObserved: false, gate }; return gate;
        }, providerRequests: () => providerRequests });
      await pauseMatrix.failures();
      await until(async () => (await json<CapabilityDTO>(`/api/capabilities/${capability!.id}`, {}, buyer)).availability.canRunNow, 30_000, 'POST_PAUSE_RUNTIME_NOT_READY');
    }
    run = { name: pauseMode ? 'pause-success' : 'purchase', assetId: inputAsset.id, marker, step: 0, readObserved: false,
      ...(pauseMode ? { gate: new FixtureInferenceGate() } : {}) };
    await post('/api/wallet/topup', { amountMinor: 1000 }, buyer, { 'Idempotency-Key': randomUUID() });
    const beforeBuyer = await json<Wallet>('/api/wallet', {}, buyer), beforeSeller = await json<Wallet>('/api/wallet', {}, seller);
    let body: Record<string, unknown>, key: { 'Idempotency-Key': string }, job: JobDTO;
    if (browser) {
      stage('real-next-quoted-consent-and-purchase');
      const purchase = await browser.purchase(visible, inputAsset, async () => {
        assert.equal(await api!.kivro.db.job.count({ where: { capabilityId: capability!.id } }), 0);
        assert.deepEqual(await json<Wallet>('/api/wallet', {}, buyer), beforeBuyer);
      }, created => { createdJobs.push(created.id); });
      job = purchase.job; body = purchase.body; key = { 'Idempotency-Key': purchase.idempotencyKey };
    } else {
      const quote = await post<{ id: string }>(`/api/capabilities/${capability.id}/quote`, { executionMode: 'NOW' }, buyer);
      body = { capabilityId: capability.id, input: { source: inputAsset.id }, executionMode: 'NOW', quoteId: quote.id };
      key = { 'Idempotency-Key': randomUUID() };
      job = await post<JobDTO>('/api/jobs', body, buyer, key);
      createdJobs.push(job.id);
    }
    assert.equal((await post<JobDTO>('/api/jobs', body, buyer, key)).id, job.id);
    if (pauseMatrix) { check(run.gate, 'PAUSE_GATE_MISSING'); await pauseMatrix.success(job, run.gate, beforeBuyer, beforeSeller); }
    await until(async () => {
      job = await json<JobDTO>(`/api/jobs/${job.id}`, {}, buyer);
      return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(job.state);
    }, 180_000, 'JOB_TIMEOUT');
    check(job.state === 'SUCCEEDED' && job.paymentState === 'SETTLED', `JOB_${job.state}`);
    check(run.readObserved && run.step === 4 && run.report, 'PURCHASE_FILE_NOT_CONSUMED');
    const assets = job.output?.assets;
    check(assets?.length === 1, 'GENERATED_FILE_MISSING');
    const outputAsset = assets[0]!;
    assert.equal(job.output?.fields?.document, outputAsset.id); assert.equal(job.output?.fields?.summary, marker);
    const browserReceipt = browser ? await browser.download(job, outputAsset, run.report, API_ENV.S3_ENDPOINT) : undefined;
    if (browserReceipt) {
      const grants = await api.kivro.db.auditEvent.findMany({ where: { actorId: buyer.user.id, jobId: job.id, type: 'ASSET_DOWNLOAD_GRANTED' } });
      assert.equal(grants.length, 1);
      const granted = grants[0]!.metadata as { assetId?: unknown; bytesGranted?: unknown; delivery?: unknown };
      assert.equal(granted.assetId, outputAsset.id); assert.equal(granted.bytesGranted, outputAsset.sizeBytes); assert.equal(granted.delivery, 'PRESIGNED_OBJECT_STORE');
      browserReceipt.downloadAuthorizationAuditId = grants[0]!.id;
    }
    let backgroundReceipt: Record<string, unknown> | undefined;
    if (background) {
      check(browser?.purchaseWindow, 'BACKGROUND_PURCHASE_WINDOW_MISSING');
      backgroundReceipt = await background.proveCompleted(browser.purchaseWindow);
      const cursors = await api.kivro.db.platformSetting.findMany({ where: { key: { in: ['job-recovery-active-cursor', 'job-recovery-waiting-cursor'] } } });
      assert.equal(cursors.length, 2);
      assert.equal(await api.kivro.db.platformSetting.count({ where: { OR: [{ key: { startsWith: 'maintenance-error:' } }, { key: { startsWith: 'job-recovery-error:' } }] } }), 0);
      backgroundReceipt.reconcilerCursorsPersisted = true; backgroundReceipt.persistedMaintenanceErrors = 0;
    }
    stage('s3-delivery-and-idempotent-settlement');
    const download = await request(`/api/assets/${outputAsset.id}/download`, {}, buyer);
    check(download.status === 302, 'BUYER_DOWNLOAD_NOT_AUTHORIZED');
    const location = new URL(download.headers.get('location') ?? '');
    check(location.origin === API_ENV.S3_ENDPOINT && !location.username && !location.password, 'NONLOCAL_STORAGE_REDIRECT');
    const object = await fetch(location, { redirect: 'manual', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]) });
    check(object.ok, 'S3_DOWNLOAD_FAILED');
    const data = await boundedBody(object, 4096);
    assert.equal(data.toString(), run.report); assert.equal(sha256(data), outputAsset.sha256); assert.equal(data.length, outputAsset.sizeBytes);
    check((await request(`/api/assets/${outputAsset.id}/download`)).status === 401, 'ANONYMOUS_OUTPUT_ACCESS');
    check((await request(`/api/assets/${outputAsset.id}/download`, {}, seller)).status === 404, 'SELLER_OUTPUT_ACCESS');
    const attempts = await api.kivro.db.jobAttempt.findMany({ where: { jobId: job.id } });
    check(attempts.length === 1 && attempts[0]!.workerId === identity.workerId && attempts[0]!.state === 'SUCCEEDED', 'SINGLE_REAL_ATTEMPT_REQUIRED');
    assert.equal(job.correlationId, job.id);
    const persistedOutput = await api.kivro.db.asset.findUniqueOrThrow({ where: { id: outputAsset.id } });
    assert.equal(persistedOutput.jobId, job.id); assert.equal(persistedOutput.attemptId, attempts[0]!.id);
    const persistedUpload = await api.kivro.db.assetUpload.findFirstOrThrow({ where: { assetId: outputAsset.id } });
    assert.equal(persistedUpload.jobId, job.id); assert.equal(persistedUpload.attemptId, attempts[0]!.id);
    assert.equal(state.attempt(job.id)?.jobId, job.id);
    // Exercise the production result replay endpoint with the exact already-validated result.
    const transport = new WorkerTransport(apiUrl, identity, await secrets.get('device-identity'), true);
    await transport.request('POST', `/api/worker/jobs/${job.id}/result`, { attemptId: attempts[0]!.id, output: job.output });
    await runtime!.flush();
    if (pauseMatrix) {
      await until(async () => state.attempt(job.id)?.state === 'SUCCEEDED' && !runtime!.active.has(job.id), 20_000, 'PAUSE_SUCCESS_LOCAL_FINALIZATION');
      await pauseMatrix.verifySuccess(job);
    }
    const afterBuyer = await json<Wallet>('/api/wallet', {}, buyer), afterSeller = await json<Wallet>('/api/wallet', {}, seller);
    check(afterBuyer.ledger.filter(entry => entry.jobId === job.id && entry.type === 'JOB_CAPTURE').length === 1, 'CAPTURE_COUNT');
    check(afterSeller.ledger.filter(entry => entry.jobId === job.id && entry.type === 'SELLER_EARNING').length === 1, 'EARNING_COUNT');
    assert.equal(beforeBuyer.availableMinor - afterBuyer.availableMinor, job.priceSnapshot.buyerPriceMinor);
    assert.equal(afterBuyer.spentMinor - beforeBuyer.spentMinor, job.priceSnapshot.buyerPriceMinor);
    assert.equal(afterBuyer.reservedMinor, 0);
    assert.equal(afterSeller.earnedMinor - beforeSeller.earnedMinor, job.priceSnapshot.sellerNetMinor);
    const settlement = await api.kivro.db.ledgerEntry.findMany({ where: { jobId: job.id, type: { in: ['JOB_CAPTURE', 'SELLER_EARNING', 'PLATFORM_FEE'] } } });
    check(settlement.length === 3 && new Set(settlement.map(entry => entry.type)).size === 3 && new Set(settlement.map(entry => entry.transactionId)).size === 1, 'SETTLEMENT_TRANSACTION_COUNT');
    assert.equal(settlement.reduce((sum, entry) => sum + entry.amountMinor, 0), 0);
    const events = job.events.map(event => event.type);
    for (const type of ['ACCEPTED', 'RUNNING', 'VALIDATING_RESULTS', 'SUCCEEDED']) check(events.includes(type), `MISSING_${type}_EVENT`);
    evidence = { kind: 'DETERMINISTIC_LOCAL_FULLSTACK_TEST_FIXTURE', realProviderAcceptance: false, paymentMode: 'fake', malwareScan: 'DEVELOPMENT_ONLY',
      databaseSchema: schema, browserBuyerPathTested: !!browserReceipt, backgroundReconciliationTested: !!backgroundReceipt,
      background: backgroundReceipt ?? { enabled: false, reason: schema === 'public' ? 'shared-public-schema-protection' : 'API-or-fault-mode-unchanged' },
      ...(browserReceipt ? { browser: browserReceipt } : {}), at: new Date().toISOString(), fixtureId: id, jobId: job.id, capabilityId: capability.id,
      sellerId: seller.user.id, buyerId: buyer.user.id, workerId: identity.workerId, attemptId: attempts[0]!.id,
      imageId: state.get('approvedImageId'), events, inferenceRequests: providerRequests, requiredFileReadObserved: true,
      generatedFile: { id: outputAsset.id, sha256: outputAsset.sha256, sizeBytes: outputAsset.sizeBytes },
      captures: 1, sellerEarnings: 1, platformFees: 1, balancedSettlementTransactions: 1, resultReplayChecked: true };
    evidence.correlation = { canonicalJobId: job.id, httpHeaderAndDto: true, workerAttempt: true, assetUploadId: persistedUpload.id,
      outputAssetId: persistedOutput.id, ledgerEntries: settlement.length, lineageChecked: true };
    if (faults) evidence.faultMatrix = faultReceipts;
    if (pauseMatrix) evidence.pauseMatrix = pauseMatrix.receipts;
  } catch (error) {
    failure = error;
    const audit = state.db.prepare("SELECT event FROM audit WHERE event LIKE 'EXECUTION_STOPPED_%' ORDER BY id DESC LIMIT 3").all();
    console.error(JSON.stringify({ kind: 'DETERMINISTIC_LOCAL_FULLSTACK_TEST_FIXTURE', passed: false, phase, code: providerError ?? safeCode(error), audit,
      ...(browser ? { browser: browser.diagnostics() } : {}) }));
  } finally {
    clearTimeout(watchdog);
    const cleanup = async (name: string, action: () => Promise<unknown>) => { try { await action(); } catch { cleanupErrors.push(name); } };
    if (browser) await cleanup('browser-and-next-server', () => browser!.close());
    if (browser && api && capability && buyer && seller) await cleanup('discover-browser-purchase-for-cleanup', async () => {
      // A lost browser response must not hide a committed reservation from cleanup.
      const owned = await api!.kivro.db.job.findMany({ where: { capabilityId: capability!.id, buyerId: buyer!.user.id, sellerId: seller!.user.id }, select: { id: true } });
      for (const job of owned) if (!createdJobs.includes(job.id)) createdJobs.push(job.id);
    });
    for (const jobId of createdJobs) if (api && seller) await cleanup('cancel-unfinished-fixture-job', async () => {
      const job = await api!.kivro.db.job.findUniqueOrThrow({ where: { id: jobId } });
      if (job.paymentState === 'RESERVED') await post(`/api/jobs/${jobId}/cancel`, {}, seller, {}, true);
    });
    run?.gate?.open();
    state.pause('LOCAL'); state.set('stopRequested', true);
    if (capability && seller) await cleanup('pause-capability', () => post(`/api/seller/capabilities/${capability!.id}/pause`, { paused: true }, seller, {}, true));
    if (runtimeTask) await cleanup('stop-runtime', () => runtimeTask!);
    if (runtimeError) cleanupErrors.push('runtime-error');
    if (identity) await cleanup('fixture-container-cleanup', async () => {
      const docker = new DockerSandbox(), ids = (await docker.call(['ps', '-aq', '--filter', `label=io.kivro.owner=${identity!.workerId}`])).trim().split(/\s+/).filter(Boolean);
      for (const containerId of ids) {
        const info = JSON.parse(await docker.call(['inspect', containerId]))[0];
        check(info.Config.Labels?.['io.kivro.owner'] === identity!.workerId, 'CONTAINER_OWNERSHIP_MISMATCH');
        await docker.remove({ name: info.Name.replace(/^\//, ''), owner: identity!.workerId, attemptId: info.Config.Labels['io.kivro.attempt'] });
      }
      check(!(await docker.call(['ps', '-aq', '--filter', `label=io.kivro.owner=${identity!.workerId}`])).trim(), 'FIXTURE_CONTAINERS_REMAIN');
    });
    if (identity && seller) {
      await cleanup('pause-worker', () => post(`/api/seller/workers/${identity!.workerId}/pause`, {}, seller, {}, true));
      await cleanup('revoke-worker', () => post(`/api/seller/workers/${identity!.workerId}/revoke`, {}, seller, {}, true));
    }
    if (capability && seller && buyer) await cleanup('revoke-buyer-grant', () => post(`/api/seller/capabilities/${capability!.id}/grants`, { email: buyer!.user.email, allowed: false }, seller, {}, true));
    for (const account of [buyer, seller]) if (account) await cleanup('logout', () => post('/api/auth/logout', {}, account, {}, true));
    if (api) await cleanup('verify-cleanup-state', async () => {
      if (identity) {
        const worker = await api!.kivro.db.workerDevice.findUniqueOrThrow({ where: { id: identity.workerId } });
        check(worker.paused && worker.revokedAt && !worker.sandboxReady, 'WORKER_CLEANUP_NOT_PERSISTED');
      }
      if (capability) {
        const cap = await api!.kivro.db.capability.findUniqueOrThrow({ where: { id: capability.id } });
        check(cap.paused, 'CAPABILITY_CLEANUP_NOT_PERSISTED');
        check(await api!.kivro.db.capabilityGrant.count({ where: { capabilityId: capability.id } }) === 0, 'GRANT_CLEANUP_NOT_PERSISTED');
      }
      for (const account of [buyer, seller]) if (account) check(await api!.kivro.db.session.count({ where: { userId: account.user.id } }) === 0, 'SESSION_CLEANUP_NOT_PERSISTED');
      check(!state.get('securityBlock') && !state.activeAttempts().length && !runtime?.active.size && !state.pending().length, 'LOCAL_RUNTIME_CLEANUP_INCOMPLETE');
    });
    await cleanup('inference-server', async () => { provider.closeAllConnections(); if (provider.listening) await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())); });
    if (corsChanged && api) await cleanup('restore-storage-cors-localhost3000', () => (api!.kivro.storage as S3ObjectStore).configureBrowserOrigin('http://localhost:3000'));
    if (api) await cleanup('api-server', async () => { await api!.close(); (api!.kivro.storage as S3ObjectStore).client.destroy(); });
    if (background) await cleanup('isolated-background-queue', () => background!.close());
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    state.close();
    await cleanup('temporary-worker-state', () => rm(root, { recursive: true, force: true }));
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  if (failure || cleanupErrors.length || !evidence) {
    console.error(JSON.stringify({ kind: 'DETERMINISTIC_LOCAL_FULLSTACK_TEST_FIXTURE', passed: false, phase, code: safeCode(failure), databaseSchema: schema,
      browserMode, pauseMode, backgroundEnabled, fixtureId: id, workerId: identity?.workerId, capabilityId: capability?.id,
      faultMatrix: faultReceipts, ...(pauseMatrix ? { pauseMatrix: pauseMatrix.receipts } : {}), cleanupErrors }));
    process.exitCode = 1;
  } else console.log(JSON.stringify({ ...evidence, cleanup: 'worker-paused-and-revoked-capability-paused-grant-revoked-sessions-logged-out-fixture-containers-and-temp-state-removed', passed: true }));
}

main().catch(error => { console.error(JSON.stringify({ kind: 'DETERMINISTIC_LOCAL_FULLSTACK_TEST_FIXTURE', passed: false, code: safeCode(error) })); process.exitCode = 1; });
