// Deterministic local TEST FIXTURE. Not production code or real-provider acceptance.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
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
import { AssetDTOSchema, CreateCapabilitySchema, hashManifest, type CapabilityDTO, type IOContract, type JobDTO } from '../packages/contracts/src/index.js';
import { sha256 } from '../packages/crypto/src/index.ts';
import { DockerSandbox, detectRuntime } from '../packages/openclaw-adapter/src/index.ts';
import { OpenAIPlatformProvider, type AgentChatResponse, type AgentSynthesisPreview, type AgentSynthesisResponse, type OrchestrationPlan } from '../packages/marketplace-agent/src/index.js';
import type { HttpTransport } from '../packages/research-broker/src/index.js';
import type { S3ObjectStore } from '../packages/storage/src/index.js';

const KIND = 'DETERMINISTIC_LOCAL_ORCHESTRATION_FIXTURE';
const MODEL = 'kivro-orchestration-fixture';
const IMAGE = 'kivro-sandbox:2026.8.2';
const ORIGIN = 'http://127.0.0.1:3000';
// Public local-only credentials. Never load .env or inherit provider configuration.
const API_ENV = {
  NODE_ENV: 'test', KIVRO_ENV: 'development', PAYMENT_MODE: 'fake', DEV_AUTH_ENABLED: 'false',
  DATABASE_URL: 'postgresql://kivro:kivro_local_only@127.0.0.1:55432/kivro?schema=public',
  REDIS_URL: 'redis://127.0.0.1:56379', WEB_ORIGIN: ORIGIN,
  S3_ENDPOINT: 'http://127.0.0.1:59000', S3_BUCKET: 'kivro-development', S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'kivro_local', S3_SECRET_KEY: 'kivro_local_storage_only', S3_FORCE_PATH_STYLE: 'true',
  PLATFORM_INFERENCE_PROVIDER: 'openai', PLATFORM_INFERENCE_MODEL: MODEL,
  PLATFORM_INFERENCE_INPUT_MICRO_USD_PER_MILLION: '1', PLATFORM_INFERENCE_OUTPUT_MICRO_USD_PER_MILLION: '1',
};
type Account = { cookie: string; user: { id: string; email: string } };
type Wallet = { availableMinor: number; reservedMinor: number; spentMinor: number; earnedMinor: number };
type Host = { state: WorkerState; secrets: SecretStore; account?: Account; identity?: DeviceIdentity;
  runtime?: WorkerRuntime; task?: Promise<void>; done?: boolean; error?: unknown };
type Source = { company: string; marker: string; text: string };
type Run = { trace: string; role: 'research' | 'pdf'; sources: Source[]; step: number; readMarkers: string[]; assetIds: string[]; pdf?: string };
type Message = { role: string; content?: unknown; tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[] };

function check(value: unknown, code: string): asserts value { if (!value) throw new Error(`FIXTURE_${code}`); }
function safeCode(error: unknown): string {
  return error instanceof Error && /^[A-Z0-9_:/.-]{1,200}$/.test(error.message) ? error.message : 'FIXTURE_OPERATION_FAILED';
}
async function boundedBody(response: Response, maxBytes = 2 * 1024 ** 2): Promise<Buffer> {
  check(response.body, 'RESPONSE_BODY_MISSING');
  const reader = response.body.getReader(), chunks: Buffer[] = []; let bytes = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; check(bytes <= maxBytes, 'RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(value)); }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

// Small ASCII PDF fixture, delivered through the real OpenClaw write tool and S3.
// Poppler independently parses and renders the downloaded result below.
function fixturePdf(sources: Source[]): string {
  const lines = ['Kivro company comparison', 'Deterministic local test data, not real research.', '',
    ...sources.flatMap(source => [source.company, `Evidence: ${source.marker}`, '']),
    'Three upstream artifacts were read by the PDF Worker.'];
  const escaped = lines.map(line => line.replace(/[\\()]/g, '\\$&'));
  const stream = `BT /F1 10 Tf 48 744 Td 18 TL\n${escaped.map((line, index) => `${index ? 'T* ' : ''}(${line}) Tj`).join('\n')}\nET\n`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
  let result = '%PDF-1.4\n'; const offsets: number[] = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return `${result}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
}

async function recoverStoppedFixture(id: string): Promise<void> {
  AssetDTOSchema.shape.id.parse(id);
  check(process.env.NODE_ENV !== 'production' && process.env.KIVRO_ENV !== 'production', 'PRODUCTION_DENIED');
  const api = await createApp({ env: API_ENV, background: false, logger: false });
  try {
    const accounts = await api.kivro.db.user.findMany({ where: { email: { in: ['buyer', 'seller-0', 'seller-1'].map(role => `orchestration-${role}-${id}@kivro.invalid`) } } });
    check(accounts.length > 0, 'CLEANUP_FIXTURE_NOT_FOUND');
    const ids = accounts.map(account => account.id), buyer = accounts.find(account => account.email === `orchestration-buyer-${id}@kivro.invalid`);
    check(await api.kivro.db.workerDevice.count({ where: { sellerId: { in: ids }, OR: [{ paused: false }, { revokedAt: null }] } }) === 0, 'CLEANUP_WORKERS_NOT_STOPPED');
    check(await api.kivro.db.capability.count({ where: { sellerId: { in: ids }, paused: false } }) === 0, 'CLEANUP_CAPABILITIES_NOT_PAUSED');
    if (buyer) {
      check(await api.kivro.db.job.count({ where: { buyerId: buyer.id, state: { notIn: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] } } }) === 0, 'CLEANUP_JOBS_NOT_TERMINAL');
      check((await api.kivro.db.wallet.findUniqueOrThrow({ where: { userId: buyer.id } })).reservedMinor === 0, 'CLEANUP_RESERVED_FUNDS');
      check(await api.kivro.db.agentPlan.count({ where: { userId: { not: buyer.id }, state: { in: ['APPROVED', 'RUNNING'] } } }) === 0, 'OTHER_ACTIVE_PLAN_STOP_CONCURRENT_FIXTURES');
      await api.kivro.tickPlans!();
      check(await api.kivro.db.agentPlan.count({ where: { userId: buyer.id, state: { in: ['APPROVED', 'RUNNING'] } } }) === 0, 'CLEANUP_PLAN_STILL_ACTIVE');
    }
    // Expire only this stopped synthetic fixture's sessions; never edit financial records.
    await api.kivro.db.session.deleteMany({ where: { userId: { in: ids } } });
    console.log(JSON.stringify({ kind: KIND, cleanupOnly: true, fixtureId: id, passed: true, financialHistoryPreserved: true }));
  } finally { await api.close(); (api.kivro.storage as S3ObjectStore).client.destroy(); }
}

async function main(): Promise<void> {
  if (process.argv[2] === '--cleanup' && process.argv.length === 4) { await recoverStoppedFixture(process.argv[3]!); return; }
  if (process.argv.slice(2).join(' ') !== '--run') {
    console.log('Local deterministic fixture only. Run: node --import tsx scripts/e2e-orchestration-fixture.ts --run; stopped-run recovery: --cleanup <fixtureId>'); return;
  }
  check(process.env.NODE_ENV !== 'production' && process.env.KIVRO_ENV !== 'production', 'PRODUCTION_DENIED');
  const id = randomUUID(), token = `kivro-test-only-${randomBytes(24).toString('hex')}`;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-orchestration-fixture-')));
  const hosts: Host[] = [0, 1].map(index => { const state = new WorkerState(join(root, `worker-${index}`)); return { state, secrets: new SecretStore(state) }; });
  const saved = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string) => { if (!saved.has(key)) saved.set(key, process.env[key]); process.env[key] = value; };
  for (const [key, value] of Object.entries({ KIVRO_WORKER_MASTER_KEY: randomBytes(32).toString('hex'), KIVRO_SANDBOX_IMAGE: IMAGE,
    KIVRO_ENV: 'development', NODE_ENV: 'test', DEV_AUTH_ENABLED: 'false' })) setEnv(key, value);
  const abort = new AbortController(), cleanupErrors: string[] = [];
  const cancel = () => { abort.abort(); for (const host of hosts) { host.state.pause('LOCAL'); host.state.set('stopRequested', true); } };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const watchdog = setTimeout(cancel, 15 * 60_000);
  let api: Awaited<ReturnType<typeof createApp>> | undefined, apiUrl = '', providerUrl = '', buyer: Account | undefined;
  let phase = 'prerequisites', providerError: string | undefined, providerRequests = 0, platformRequests = 0;
  let failure: unknown, evidence: Record<string, unknown> | undefined, plan: OrchestrationPlan | undefined;
  const caps: { dto: CapabilityDTO; host: Host; role: Run['role']; company?: string }[] = [];
  const jobs: JobDTO[] = [], runs = new Map<string, Run>(), planTraces = ['a', 'b', 'c', 'pdf'].map(key => `plan-${key}-${id}`);
  const originalGenerate = OpenAIPlatformProvider.prototype.generate;
  const stage = (name: string) => { phase = name; console.log(`ORCHESTRATION_FIXTURE ${name}`); check(!abort.signal.aborted, 'CANCELLED'); };
  const request = (path: string, options: RequestInit = {}, account?: Account, cleanup = false) => {
    check(path.startsWith('/') && !path.startsWith('//'), 'INVALID_API_PATH');
    const timeout = AbortSignal.timeout(20_000);
    return fetch(`${apiUrl}${path}`, { ...options, redirect: 'manual', headers: { Origin: ORIGIN,
      ...(account ? { Cookie: account.cookie } : {}), ...options.headers }, signal: cleanup ? timeout : AbortSignal.any([abort.signal, timeout]) });
  };
  const json = async <T>(path: string, options: RequestInit = {}, account?: Account, cleanup = false): Promise<T> => {
    let response = await request(path, options, account, cleanup);
    if (cleanup && response.status === 429) {
      const seconds = Number(response.headers.get('retry-after') ?? 60);
      await boundedBody(response); await delay((Math.min(60, Math.max(1, Number.isFinite(seconds) ? seconds : 60)) + 1) * 1000);
      response = await request(path, options, account, cleanup);
    }
    const body = JSON.parse((await boundedBody(response)).toString());
    if (!response.ok) throw new Error(`FIXTURE_API_${response.status}_${/^[A-Z0-9_]+$/.test(body.error?.code) ? body.error.code : 'ERROR'}`);
    return body as T;
  };
  const post = <T>(path: string, body: unknown, account?: Account, headers: Record<string, string> = {}, cleanup = false) =>
    json<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }, account, cleanup);
  const register = async (role: string): Promise<Account> => {
    const terms = await json<{ version: string }>('/api/terms');
    const response = await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      name: `Orchestration fixture ${role}`, email: `orchestration-${role}-${id}@kivro.invalid`, password: randomBytes(32).toString('base64url'), acceptedTermsVersion: terms.version }) });
    check(response.ok, `REGISTER_${response.status}`);
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); check(cookie, 'SESSION_MISSING');
    return { cookie, ...JSON.parse((await boundedBody(response)).toString()) };
  };
  const newResearch = (trace: string, company: string): Run => {
    const marker = `KIVRO_SOURCE_${randomUUID()}`, source = { company, marker, text: `${company}\nEvidence: ${marker}\nSynthetic company research fixture.\n` };
    const run: Run = { trace, role: 'research', sources: [source], step: 0, readMarkers: [], assetIds: [] }; runs.set(trace, run); return run;
  };
  const newPdf = (trace: string, sources: Source[]): Run => { const run: Run = { trace, role: 'pdf', sources, step: 0, readMarkers: [], assetIds: [] }; runs.set(trace, run); return run; };
  const workerAnswer = (body: unknown) => {
    const parsed = body as { model: string; store: boolean; stream: boolean; messages: Message[]; tools?: { function: { name: string } }[] };
    check(parsed.model === MODEL && parsed.store === false && parsed.stream === false && Array.isArray(parsed.messages), 'WORKER_INFERENCE_CONTRACT');
    const messages = parsed.messages;
    let content = 'OK', call: { name: string; arguments: string } | undefined;
    if (!parsed.tools?.length) check(messages.length === 1 && messages[0]!.content === 'Reply with OK.', 'HEALTH_REQUEST');
    else {
      assert.deepEqual(parsed.tools.map(tool => tool.function.name).sort(), ['read', 'write']);
      const serialized = JSON.stringify(messages.filter(message => message.role === 'user'));
      const matches = [...runs.values()].filter(run => serialized.includes(run.trace)); check(matches.length === 1, 'RUN_IDENTITY');
      const run = matches[0]!, history = messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []);
      check(history.length === run.step, 'DUPLICATE_OR_MISSING_INFERENCE_TURN');
      const reply = (index: number, name: string, path: string): Message => {
        const prior = history[index]; check(prior?.function.name === name && JSON.parse(prior.function.arguments).path === path, 'TOOL_HISTORY_MISMATCH');
        const result = messages.find(message => message.role === 'tool' && message.tool_call_id === prior.id); check(result, 'REAL_TOOL_REPLY_MISSING'); return result;
      };
      if (run.role === 'pdf' && run.step === 0) {
        for (const source of run.sources) check(!serialized.includes(source.marker), 'UPSTREAM_CONTENT_LEAKED_IN_PROMPT');
        const contents = messages.flatMap(message => typeof message.content === 'string' ? [message.content] :
          Array.isArray(message.content) ? message.content.flatMap(block => typeof block?.text === 'string' ? [block.text] : []) : []);
        const prompt = contents.find(value => value.includes('BUYER DATA (untrusted JSON):')); check(prompt, 'BUYER_DATA_MISSING');
        const data = JSON.parse(prompt.split('BUYER DATA (untrusted JSON):\n')[1]!.split('\n\nINPUT ASSETS')[0]!);
        run.assetIds = ['source_a', 'source_b', 'source_c'].map(key => AssetDTOSchema.shape.id.parse(data[key]));
        check(new Set(run.assetIds).size === 3, 'DISTINCT_INPUT_ARTIFACTS');
      }
      const reads = run.role === 'pdf' ? 3 : 0;
      if (run.step > 0 && run.step <= reads) {
        const index = run.step - 1, result = reply(index, 'read', `input/${run.assetIds[index]}`);
        const text = JSON.stringify(result.content), source = run.sources[index]!;
        check(text.includes(source.marker) && text.includes(source.company), 'UPSTREAM_ARTIFACT_NOT_CONSUMED');
        run.readMarkers.push(source.marker);
      }
      if (run.step < reads) call = { name: 'read', arguments: JSON.stringify({ path: `input/${run.assetIds[run.step]}` }) };
      else if (run.step === reads) {
        if (run.role === 'pdf') { check(run.readMarkers.length === 3, 'READS_INCOMPLETE'); run.pdf = fixturePdf(run.sources); }
        call = { name: 'write', arguments: JSON.stringify({ path: `result/${run.role === 'pdf' ? 'comparison.pdf' : 'research.txt'}`, content: run.pdf ?? run.sources[0]!.text }) };
      } else if (run.step === reads + 1) {
        check(JSON.stringify(reply(reads, 'write', `result/${run.role === 'pdf' ? 'comparison.pdf' : 'research.txt'}`).content).includes('Successfully wrote'), 'ARTIFACT_WRITE_MISSING');
        call = { name: 'write', arguments: JSON.stringify({ path: 'result/kivro-result.json', content: JSON.stringify({
          text: run.role === 'pdf' ? 'Comparison produced from three upstream files.' : `Synthetic research for ${run.sources[0]!.company}.`,
          fields: { summary: run.role === 'pdf' ? 'Three-company comparison' : run.sources[0]!.company, document: run.role === 'pdf' ? 'comparison.pdf' : 'research.txt' } }) }) };
      } else {
        check(run.step === reads + 2 && JSON.stringify(reply(reads + 1, 'write', 'result/kivro-result.json').content).includes('Successfully wrote'), 'MANIFEST_WRITE_MISSING');
        content = 'Completed deterministic local fixture.';
      }
      run.step++;
    }
    return { id: `fixture-${providerRequests}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL,
      choices: [{ index: 0, message: call ? { role: 'assistant', content: null, tool_calls: [{ id: `fixture-${providerRequests}`, type: 'function', function: call }] } : { role: 'assistant', content }, finish_reason: call ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: call ? 1500 : 1, total_tokens: call ? 1600 : 101 } };
  };
  const platformAnswer = (raw: unknown) => {
    const body = raw as { model: string; store: boolean; instructions: string; input: { role: string; content: string }[]; text?: { format?: { type?: string } } };
    check(body.model === MODEL && body.store === false && typeof body.instructions === 'string' && Array.isArray(body.input) && body.text?.format?.type === 'json_schema', 'PLATFORM_INFERENCE_CONTRACT');
    check(++platformRequests <= 3, 'PLATFORM_REQUEST_LIMIT');
    let answer: unknown;
    if (body.instructions.includes('Extract constraints')) answer = { query: `orchestration ${id}`, maxSpendMinor: 1500, maxPerJobSpendMinor: 99, maxJobs: 4, minRating: 4.5, maxRuntimeSeconds: 600, noNetwork: true, onlineOnly: null };
    else if (body.instructions.includes('Plan a DAG')) {
      const input = JSON.parse(body.input.at(-1)!.content), records = input.untrustedMarketplaceRecords as Pick<CapabilityDTO, 'id' | 'versionId' | 'rating'>[];
      check(Array.isArray(records), 'CATALOG_RECORDS');
      check(caps.length === 4 && caps.every(cap => records.some(record => record.id === cap.dto.id && record.versionId === cap.dto.versionId && (record.rating ?? 0) >= 4.5)), 'REAL_CATALOG_CANDIDATES_MISSING');
      const mapping = (targetInput: string, value: unknown) => ({ kind: 'literal', targetInput, valueJson: JSON.stringify(value), sourceStepKey: null, pointer: null, assetIndex: null, sourceField: null });
      answer = { clarification: null, steps: caps.map((cap, index) => ({ key: `step-${index}`, capabilityId: cap.dto.id, capabilityVersionId: cap.dto.versionId,
        dependsOn: index === 3 ? ['step-0', 'step-1', 'step-2'] : [], inputMapping: [mapping('trace', planTraces[index]),
          ...(index === 3 ? ['a', 'b', 'c'].map((key, source) => ({ kind: 'asset', targetInput: `source_${key}`, valueJson: null, sourceStepKey: `step-${source}`, pointer: null, assetIndex: 0, sourceField: 'document' })) : [mapping('company', cap.company)])] })) };
    } else {
      check(body.instructions.startsWith('Summarize only'), 'UNEXPECTED_PLATFORM_TASK');
      const inputs = JSON.parse(body.input[0]!.content); check(inputs.fileContentsIncluded === false && inputs.untrustedProviderOutputs.length === 4, 'SYNTHESIS_SCOPE');
      answer = { summary: 'Three synthetic company research jobs supplied the files for the PDF comparison. The PDF is available as the report job artifact; this summary has not inspected its contents.', sourceJobIds: inputs.untrustedProviderOutputs.map((value: { jobId: string }) => value.jobId) };
    }
    return { status: 'completed', model: MODEL, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }], usage: { input_tokens: 100, output_tokens: 1500 } };
  };
  const provider = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/v1/models') {
        check(req.headers.authorization === `Bearer ${token}`, 'INFERENCE_TOKEN');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: MODEL }] })); return;
      }
      check(req.method === 'POST' && ['/v1/chat/completions', '/v1/responses'].includes(req.url ?? ''), 'INFERENCE_ROUTE');
      check(req.headers.authorization === `Bearer ${token}`, 'INFERENCE_TOKEN'); check(++providerRequests <= 100, 'INFERENCE_LIMIT');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; check(bytes <= 2 * 1024 ** 2, 'INFERENCE_BODY_LIMIT'); chunks.push(Buffer.from(chunk)); }
      const body = JSON.parse(Buffer.concat(chunks).toString()), result = req.url === '/v1/responses' ? platformAnswer(body) : workerAnswer(body);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) { providerError = safeCode(error); res.writeHead(400).end(JSON.stringify({ error: { code: providerError } })); }
  });
  provider.requestTimeout = 15_000; provider.headersTimeout = 10_000; provider.maxConnections = 8;
  const until = async (predicate: () => Promise<boolean>, timeoutMs: number, code: string) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      check(!abort.signal.aborted, 'CANCELLED'); check(!hosts.some(host => host.done), 'RUNTIME_STOPPED');
      if (providerError) throw new Error(providerError);
      if (await predicate()) return; await delay(2000);
    }
    throw new Error(`FIXTURE_${code}`);
  };
  const remember = (job: JobDTO) => { const index = jobs.findIndex(item => item.id === job.id); if (index < 0) jobs.push(job); else jobs[index] = job; return job; };
  const waitJob = async (id: string) => {
    let result: JobDTO | undefined;
    await until(async () => { result = remember(await json<JobDTO>(`/api/jobs/${id}`, {}, buyer)); return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(result.state); }, 180_000, 'JOB_TIMEOUT');
    check(result?.state === 'SUCCEEDED' && result.paymentState === 'SETTLED', `JOB_${result?.state}`); return result;
  };
  const review = async (job: JobDTO) => {
    const status = await json<{ eligible: boolean }>(`/api/jobs/${job.id}/review`, {}, buyer); check(status.eligible, 'REVIEW_INELIGIBLE');
    const body = { jobId: job.id, rating: 5, comment: 'Deterministic local synthetic fixture, not a real-provider quality rating.' };
    const row = await post<{ id: string }>(`/api/capabilities/${job.capabilityId}/reviews`, body, buyer);
    check((await request(`/api/capabilities/${job.capabilityId}/reviews`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, buyer)).status === 409, 'DUPLICATE_REVIEW_ACCEPTED');
    return row.id;
  };
  const tick = async () => {
    // tickPlans is production reconciliation, not a test replacement. Never knowingly touch another run's plan.
    check(await api!.kivro.db.agentPlan.count({ where: { state: { in: ['APPROVED', 'RUNNING'] }, ...(plan ? { id: { not: plan.id } } : {}) } }) === 0, 'OTHER_ACTIVE_PLAN_STOP_CONCURRENT_FIXTURES');
    await api!.kivro.tickPlans!();
  };
  try {
    const docker = new DockerSandbox(); await docker.available(); await docker.imageId(IMAGE); check((await detectRuntime()).compatible, 'UNSUPPORTED_OPENCLAW');
    execFileSync('pdfinfo', ['-v'], { stdio: 'ignore', timeout: 10_000 });
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore', timeout: 10_000 });
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore', timeout: 10_000 });
    await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
    const address = provider.address(); check(address && typeof address === 'object', 'INFERENCE_LISTEN'); providerUrl = `http://127.0.0.1:${address.port}`;
    const localTransport: HttpTransport = { async request(input) {
      check(input.url === 'https://api.openai.com/v1/responses' && input.method === 'POST', 'UNEXPECTED_PLATFORM_DESTINATION');
      const response = await fetch(`${providerUrl}/v1/responses`, { method: 'POST', headers: input.headers, body: input.body, redirect: 'manual', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]) });
      return { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? '' }, body: await boundedBody(response), finalUrl: input.url };
    } };
    const localPlatform = new OpenAIPlatformProvider(token, localTransport);
    // Fixture-only seam: retain the real provider encoder/parser/router/accounting; redirect ONLY its transport.
    OpenAIPlatformProvider.prototype.generate = function (request) { check(request.model === MODEL, 'UNEXPECTED_PLATFORM_MODEL'); return originalGenerate.call(localPlatform, request); };
    stage('start-isolated-api');
    api = await createApp({ env: { ...API_ENV, PLATFORM_OPENAI_API_KEY: token }, background: false, logger: false });
    apiUrl = await api.listen({ host: '127.0.0.1', port: 0 }); setEnv('API_URL', apiUrl);
    stage('verify-local-services-and-idle-plan-reconciler');
    check((await json<{ status: string }>('/ready')).status === 'ready', 'LOCAL_SERVICES_UNAVAILABLE');
    await tick();
    stage('synthetic-accounts-and-two-workers');
    buyer = await register('buyer');
    for (const [index, host] of hosts.entries()) {
      host.account = await register(`seller-${index}`); setEnv('KIVRO_WORKER_HOME', host.state.root);
      const pairing = await post<{ code: string }>('/api/seller/pairing-code', {}, host.account);
      await workerCommand(['pair', pairing.code, '--name', `Orchestration fixture ${id}-${index}`]);
      host.identity = host.state.get<DeviceIdentity>('identity'); check(host.identity, 'PAIRING_MISSING');
      await workerCommand(['sandbox', 'approve-image']); await host.secrets.put('fixture-inference', token);
      const config = validateInferenceConfig({ provider: 'openai-compatible', model: MODEL, credentialRef: 'fixture-inference', baseUrl: `${providerUrl}/v1`, allowLocal: true,
        maxTokensPerJob: 200000, dailyTokenLimit: 2000000, inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 });
      const path = join(host.state.root, 'inference.json'); await writeFile(path, JSON.stringify(config), { mode: 0o600 });
      await workerCommand(['inference', 'configure', '--file', path, '--approve', hashManifest(config)]); await workerCommand(['inference', 'test']);
      check(host.state.get('sandboxProof') && host.state.get('inferenceProof'), 'REAL_PROOFS_MISSING');
    }
    check(new Set([buyer.user.id, ...hosts.map(host => host.account!.user.id)]).size === 3, 'IDENTITIES_NOT_DISTINCT');
    stage('four-capability-definitions-and-real-validation');
    const fileConstraints = { allowedMimeTypes: ['text/plain'], allowedExtensions: ['.txt'], maxFileSizeBytes: 4096 };
    for (let index = 0; index < 4; index++) {
      const role = index === 3 ? 'pdf' : 'research', company = role === 'research' ? ['Alpha', 'Beta', 'Gamma'][index]! : undefined;
      const host = hosts[index === 1 || index === 3 ? 1 : 0]!; setEnv('KIVRO_WORKER_HOME', host.state.root);
      const ioContract: IOContract = { schemaVersion: 1, inputs: [{ key: 'trace', label: 'Fixture trace', type: 'SHORT_TEXT', required: true, order: 0 },
        ...(role === 'research' ? [{ key: 'company', label: 'Company', type: 'SHORT_TEXT' as const, required: true, order: 1 }] :
          ['a', 'b', 'c'].map((key, order) => ({ key: `source_${key}`, label: `Research ${key}`, type: 'FILE' as const, required: true, order: order + 1, constraints: fileConstraints })))],
        output: { type: 'MIXED', required: true, description: role === 'pdf' ? 'PDF comparison and summary' : 'Synthetic research file and summary',
          fields: [{ key: 'summary', label: 'Summary', type: 'SHORT_TEXT', required: true, order: 0 }, { key: 'document', label: 'Document', type: 'FILE', required: true, order: 1,
            constraints: role === 'pdf' ? { allowedMimeTypes: ['application/pdf'], allowedExtensions: ['.pdf'], maxFileSizeBytes: 16384 } : fileConstraints }],
          files: { allowedMimeTypes: [role === 'pdf' ? 'application/pdf' : 'text/plain'], allowedExtensions: [role === 'pdf' ? '.pdf' : '.txt'], maxFiles: 1, maxTotalSizeBytes: role === 'pdf' ? 16384 : 4096 } } };
      const base = LocalCapabilitySchema.parse({ capabilityVersionId: randomUUID(), selectedSkills: [], dependencies: [], ioContract,
        internalInstructions: role === 'pdf' ? 'Read all three input files with the read tool. Write comparison.pdf from their contents, then the named-field result manifest. Synthetic local test only.' :
          `Write a synthetic ${company} research.txt and named-field result manifest. Synthetic local test only; no real research claim.`,
        permissions: { schemaVersion: 1, tools: ['read', 'write'], resources: [], network: { mode: 'NONE', allowedDomains: [] },
          inference: { provider: 'openai-compatible', model: MODEL, credentialRef: 'fixture-inference' },
          limits: { timeoutSeconds: 120, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 65536, maxOutputBytes: 65536, maxTokens: 200000 } } });
      base.dependencies = discoveredDependencyGrants(host.state, base).map(dependency => ({ ...dependency, approved: true }));
      check(base.dependencies.every(dependency => dependency.healthy && dependency.supported), 'DEPENDENCY_UNHEALTHY');
      const dto = await post<CapabilityDTO>('/api/seller/capabilities', CreateCapabilitySchema.parse({ title: `Orchestration ${id} ${company ?? 'PDF'}`,
        summary: `Synthetic orchestration ${id} ${role} fixture.`, description: 'Deterministic local fixture, not real-provider acceptance.', category: 'Writing & documents', tags: ['test-fixture'],
        priceTierId: 'USD_99', ioContract, permissions: base.permissions, dependencies: base.dependencies, internalInstructions: base.internalInstructions,
        workerId: host.identity!.workerId, estimatedDurationSeconds: 30 }), host.account);
      caps.push({ dto, host, role, company });
      const manifest = LocalCapabilitySchema.parse({ ...base, capabilityVersionId: dto.versionId }); approveCapability(host.state, manifest, hashManifest(manifest));
      const trace = `validation-${index}-${id}`, input: Record<string, unknown> = { trace }, assets: { id: string; path: string; filename: string; mimeType: string; sizeBytes: number; sha256: string }[] = [];
      let run: Run;
      if (role === 'research') { input.company = company; run = newResearch(trace, company!); }
      else {
        const sources = ['Alpha', 'Beta', 'Gamma'].map(name => newResearch(`validation-source-${name}-${id}`, name).sources[0]!); run = newPdf(trace, sources);
        for (const [offset, source] of sources.entries()) {
          const assetId = randomUUID(), path = join(root, `validation-${offset}.txt`); await writeFile(path, source.text, { mode: 0o444 });
          input[`source_${['a', 'b', 'c'][offset]}`] = assetId; assets.push({ id: assetId, path, filename: `${offset}.txt`, mimeType: 'text/plain', sizeBytes: Buffer.byteLength(source.text), sha256: sha256(source.text) });
        }
      }
      await testCapability(host.state, host.secrets, dto.versionId, { input, assets }, IMAGE, true);
      check(!providerError && run.step === (role === 'pdf' ? 6 : 3), 'VALIDATION_FLOW_INCOMPLETE');
    }
    stage('runtime-readiness-and-public-test-catalog');
    for (const host of hosts) {
      setEnv('KIVRO_WORKER_HOME', host.state.root); await workerCommand(['resume', '--all']); host.runtime = new WorkerRuntime(host.state, host.secrets, IMAGE, true);
      host.task = host.runtime.start().catch(error => { host.error = error; }).finally(() => { host.done = true; });
    }
    await until(async () => {
      for (const host of hosts) {
        const workers = await json<{ id: string; sandboxReady: boolean; localPaused: boolean; bindings: { capabilityVersionId: string; healthy: boolean }[] }[]>('/api/seller/workers', {}, host.account);
        if (!caps.filter(cap => cap.host === host).every(cap => host.runtime!.readyCapabilityIds().includes(cap.dto.versionId) && workers.some(worker => worker.id === host.identity!.workerId && worker.sandboxReady && !worker.localPaused && worker.bindings.some(binding => binding.capabilityVersionId === cap.dto.versionId && binding.healthy)))) return false;
      }
      return true;
    }, 60_000, 'RUNTIME_NOT_READY');
    for (const cap of caps) await post(`/api/seller/capabilities/${cap.dto.id}/publish`, { visibility: 'PUBLIC', localExecutionAcknowledged: true }, cap.host.account);
    await post('/api/wallet/topup', { amountMinor: 1500 }, buyer, { 'Idempotency-Key': randomUUID() });
    stage('real-paid-warmups-and-rating-evidence');
    const warmups: JobDTO[] = [], warmupSources: Source[] = [];
    for (const [index, cap] of caps.entries()) {
      const trace = `warmup-${index}-${id}`, input: Record<string, unknown> = { trace };
      if (cap.role === 'research') { input.company = cap.company; warmupSources.push(newResearch(trace, cap.company!).sources[0]!); }
      else { newPdf(trace, warmupSources); warmups.forEach((job, offset) => { input[`source_${['a', 'b', 'c'][offset]}`] = job.output!.fields!.document; }); }
      const quote: { id: string } = await post(`/api/capabilities/${cap.dto.id}/quote`, { executionMode: 'NOW' }, buyer);
      const body: { capabilityId: string; input: Record<string, unknown>; executionMode: string; quoteId: string } = { capabilityId: cap.dto.id, input, executionMode: 'NOW', quoteId: quote.id };
      const key = { 'Idempotency-Key': randomUUID() };
      const job = remember(await post<JobDTO>('/api/jobs', body, buyer, key)); assert.equal((await post<JobDTO>('/api/jobs', body, buyer, key)).id, job.id);
      const completed = await waitJob(job.id); warmups.push(completed); await review(completed);
      cap.dto = await json<CapabilityDTO>(`/api/capabilities/${cap.dto.id}`, {}, buyer); check(cap.dto.rating === 5 && cap.dto.reviewCount === 1, 'VERIFIED_RATING_MISSING');
    }
    const beforeBuyer = await json<Wallet>('/api/wallet', {}, buyer), beforeSellers = await Promise.all(hosts.map(host => json<Wallet>('/api/wallet', {}, host.account)));
    stage('actual-agent-chat-and-unpurchased-draft');
    const sources = caps.slice(0, 3).map((cap, index) => newResearch(planTraces[index]!, cap.company!).sources[0]!);
    const pdfRun = newPdf(planTraces[3]!, sources);
    const chat = await post<AgentChatResponse>('/api/agent/chat', { message: `Research Alpha, Beta and Gamma and create one PDF comparing them. Use orchestration fixture ${id}. Maximum budget $15; minimum provider rating 4.5.`,
      mode: 'PLAN', budgetMinor: 1500, maxPerJobSpendMinor: 99, maxJobs: 4, minRating: 4.5, noNetwork: true, timingMode: 'IMMEDIATE', allowScheduling: false, maxQueueWaitSeconds: 300 }, buyer);
    check(chat.inferenceStatus === 'READY' && chat.plan, 'PLANNER_FAILED'); plan = chat.plan;
    check(plan.status === 'AWAITING_APPROVAL' && plan.steps.length === 4 && !plan.approval && plan.steps.every(step => !step.jobId), 'UNAPPROVED_PURCHASE');
    assert.equal(plan.estimatedCostMinor, 396); assert.equal(plan.constraints.minRating, 4.5); assert.equal(plan.constraints.maxTotalSpendMinor, 1500);
    const finalStep = plan.steps.find(step => step.capabilityId === caps[3]!.dto.id)!; check(finalStep?.dependsOn.length === 3, 'DAG_DEPENDENCIES');
    check(plan.steps.filter(step => !step.dependsOn.length).length === 3 && new Set(chat.recommendations.map(cap => cap.seller.id)).size === 2, 'DAG_SELLERS');
    check(chat.recommendations.every(cap => (cap.rating ?? 0) >= 4.5 && cap.availability.canRunNow), 'CATALOG_CONSTRAINTS');
    check(plan.steps.every(step => step.quote.amountMinor === 99 && Date.parse(step.quote.expiresAt) > Date.now()), 'CURRENT_QUOTES');
    await tick(); assert.equal((await api.kivro.db.agentPlan.findUniqueOrThrow({ where: { id: plan.id } })).jobIds.length, 0);
    assert.equal((await json<Wallet>('/api/wallet', {}, buyer)).spentMinor, beforeBuyer.spentMinor);
    check((await request(`/api/agent/plans/${plan.id}`, {}, hosts[0]!.account)).status === 404, 'PLAN_OWNERSHIP');
    stage('explicit-approval-and-real-DAG-execution');
    const approval = await post<OrchestrationPlan>(`/api/agent/plans/${plan.id}/approve`, { expectedRevision: plan.revision }, buyer);
    check(approval.approval?.userId === buyer.user.id, 'EXPLICIT_APPROVAL_MISSING');
    check((await request(`/api/agent/plans/${plan.id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: plan.revision }) }, buyer)).status === 409, 'STALE_APPROVAL_ACCEPTED');
    const planId = plan.id;
    await until(async () => {
      await tick(); plan = await json<OrchestrationPlan>(`/api/agent/plans/${planId}`, {}, buyer);
      check(plan.status !== 'FAILED', `PLAN_FAILED_${plan.error ?? 'UNKNOWN'}`);
      const downstream = plan.steps.find(step => step.id === finalStep.id)!;
      if (downstream.jobId) check(plan.steps.filter(step => step.id !== downstream.id).every(step => step.status === 'COMPLETED'), 'DOWNSTREAM_STARTED_EARLY');
      return plan.status === 'COMPLETED';
    }, 240_000, 'PLAN_TIMEOUT');
    check(plan.steps.every(step => step.status === 'COMPLETED' && step.jobId && step.output), 'PLAN_INCOMPLETE');
    for (const step of plan.steps) remember(await json<JobDTO>(`/api/jobs/${step.jobId!}`, {}, buyer));
    const planJobs = plan.steps.map(step => jobs.find(job => job.id === step.jobId)!); check(planJobs.length === 4 && new Set(planJobs.map(job => job.id)).size === 4, 'PLAN_JOB_COUNT');
    const pdfJob = planJobs.find(job => job.capabilityId === caps[3]!.dto.id)!;
    for (const [index, cap] of caps.slice(0, 3).entries()) {
      const upstream = planJobs.find(job => job.capabilityId === cap.dto.id)!;
      assert.equal(pdfJob.input[`source_${['a', 'b', 'c'][index]}`], upstream.output!.fields!.document);
      check(Date.parse(upstream.completedAt!) <= Date.parse(pdfJob.createdAt), 'DAG_EXECUTION_ORDER');
    }
    const grants = await api.kivro.db.assetGrant.findMany({ where: { jobId: pdfJob.id } });
    assert.deepEqual(grants.map(grant => grant.assetId).sort(), [...pdfRun.assetIds].sort());
    check(grants.length === 3 && grants.every(grant => grant.expiresAt.getTime() > Date.now()), 'SCOPED_ARTIFACT_GRANTS');
    assert.deepEqual(pdfRun.readMarkers, sources.map(source => source.marker)); check(pdfRun.step === 6 && pdfRun.pdf, 'PDF_INPUT_READ_PROOF');
    stage('S3-PDF-integrity-parse-and-render');
    const asset = pdfJob.output!.assets?.[0]; check(asset && pdfJob.output!.assets!.length === 1 && asset.mimeType === 'application/pdf', 'FINAL_PDF_MISSING');
    assert.equal(pdfJob.output!.fields!.document, asset.id);
    const download = await request(`/api/assets/${asset.id}/download`, {}, buyer); check(download.status === 302, 'PDF_DOWNLOAD_UNAUTHORIZED');
    const location = new URL(download.headers.get('location') ?? ''); check(location.origin === API_ENV.S3_ENDPOINT && !location.username && !location.password, 'NONLOCAL_STORAGE');
    const object = await fetch(location, { redirect: 'manual', signal: AbortSignal.timeout(20_000) }); check(object.ok, 'S3_DOWNLOAD_FAILED');
    const bytes = await boundedBody(object, 16384); assert.equal(bytes.toString(), pdfRun.pdf); assert.equal(sha256(bytes), asset.sha256); assert.equal(bytes.length, asset.sizeBytes);
    const pdfPath = join(root, 'delivered.pdf'); await writeFile(pdfPath, bytes);
    const info = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8', timeout: 10_000 }); check(/Pages:\s+1\b/.test(info), 'PDF_PARSE_FAILED');
    const text = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8', timeout: 10_000 });
    for (const source of sources) check(text.includes(source.company) && text.includes(source.marker), 'PDF_PROVENANCE_TEXT_MISSING');
    execFileSync('pdftoppm', ['-singlefile', '-scale-to', '1000', '-png', pdfPath, join(root, 'delivered')], { timeout: 20_000 });
    const rendered = await readFile(join(root, 'delivered.png')); check(rendered.length > 1000 && rendered.subarray(1, 4).toString() === 'PNG', 'PDF_RENDER_FAILED');
    check((await request(`/api/assets/${asset.id}/download`)).status === 401, 'ANONYMOUS_ARTIFACT_ACCESS');
    for (const host of hosts) check((await request(`/api/assets/${asset.id}/download`, {}, host.account)).status === 404, 'SELLER_ARTIFACT_ACCESS');
    stage('source-consented-synthesis-and-persisted-provenance');
    check(platformRequests === 2, 'UNEXPECTED_PRECONSENT_SYNTHESIS');
    const preview = await json<AgentSynthesisPreview>(`/api/agent/plans/${plan.id}/synthesis-preview`, {}, buyer); assert.equal(platformRequests, 2);
    check(preview.available && preview.sources.length === 4 && preview.fileContentsProcessed === false, 'SYNTHESIS_PREVIEW');
    for (const source of preview.sources) {
      const step: OrchestrationPlan['steps'][number] = plan.steps.find(step => step.id === source.stepId)!;
      assert.equal(source.jobId, step.jobId); assert.equal(source.capabilityVersionId, step.capabilityVersionId); assert.equal(source.outputHash, hashManifest(step.output));
    }
    const consent = { expectedRevision: preview.revision, sourceManifestHash: preview.sourceManifestHash, sourceJobIds: preview.sources.map(source => source.jobId), consentToProviderProcessing: true };
    check((await request(`/api/agent/plans/${plan.id}/synthesize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...consent, consentToProviderProcessing: false }) }, buyer)).status === 400, 'SYNTHESIS_WITHOUT_CONSENT');
    assert.equal(platformRequests, 2);
    const synthesis = await post<AgentSynthesisResponse>(`/api/agent/plans/${plan.id}/synthesize`, consent, buyer); assert.equal(platformRequests, 3);
    assert.deepEqual(synthesis.sources.map(source => source.jobId).sort(), planJobs.map(job => job.id).sort());
    const conversation = await api.kivro.db.agentConversation.findUniqueOrThrow({ where: { id: chat.conversationId } });
    check(JSON.stringify(conversation.messages).includes(synthesis.id), 'SYNTHESIS_NOT_PERSISTED');
    stage('exactly-once-result-replay-settlement-and-reviews');
    const reviewIds: string[] = [], settlementEvidence: Record<string, unknown>[] = [];
    for (const job of planJobs) {
      check(job.state === 'SUCCEEDED' && job.paymentState === 'SETTLED', 'PLAN_JOB_NOT_SETTLED');
      const cap = caps.find(cap => cap.dto.id === job.capabilityId)!, attempts = await api.kivro.db.jobAttempt.findMany({ where: { jobId: job.id } });
      check(attempts.length === 1 && attempts[0]!.state === 'SUCCEEDED' && attempts[0]!.workerId === cap.host.identity!.workerId, 'SINGLE_REAL_ATTEMPT');
      const transport = new WorkerTransport(apiUrl, cap.host.identity!, await cap.host.secrets.get('device-identity'), true);
      await transport.request('POST', `/api/worker/jobs/${job.id}/result`, { attemptId: attempts[0]!.id, output: job.output });
      const entries: { type: string; transactionId: string; amountMinor: number }[] = await api.kivro.db.ledgerEntry.findMany({ where: { jobId: job.id, type: { in: ['JOB_CAPTURE', 'SELLER_EARNING', 'PLATFORM_FEE'] } } });
      check(entries.length === 3 && new Set(entries.map(entry => entry.type)).size === 3 && new Set(entries.map(entry => entry.transactionId)).size === 1, 'EXACTLY_ONCE_SETTLEMENT');
      assert.equal(entries.reduce((sum, entry) => sum + entry.amountMinor, 0), 0);
      const types = job.events.map(event => event.type); for (const type of ['ACCEPTED', 'RUNNING', 'VALIDATING_RESULTS', 'SUCCEEDED']) check(types.includes(type), `MISSING_${type}`);
      reviewIds.push(await review(job)); settlementEvidence.push({ jobId: job.id, sellerId: job.sellerId, capabilityVersionId: job.capabilityVersionId, attemptId: attempts[0]!.id,
        buyerPriceMinor: job.priceSnapshot.buyerPriceMinor, sellerNetMinor: job.priceSnapshot.sellerNetMinor, platformFeeMinor: job.priceSnapshot.platformFeeMinor, captures: 1, earnings: 1, fees: 1 });
    }
    await tick(); await tick();
    const retained = await api.kivro.db.agentPlan.findUniqueOrThrow({ where: { id: plan.id } });
    assert.deepEqual([...retained.jobIds].sort(), planJobs.map(job => job.id).sort());
    const afterBuyer = await json<Wallet>('/api/wallet', {}, buyer); assert.equal(afterBuyer.reservedMinor, 0);
    assert.equal(beforeBuyer.availableMinor - afterBuyer.availableMinor, 396); assert.equal(afterBuyer.spentMinor - beforeBuyer.spentMinor, 396);
    for (const [index, host] of hosts.entries()) {
      const after = await json<Wallet>('/api/wallet', {}, host.account), expected = planJobs.filter(job => job.sellerId === host.account!.user.id).reduce((sum, job) => sum + job.priceSnapshot.sellerNetMinor, 0);
      assert.equal(after.earnedMinor - beforeSellers[index]!.earnedMinor, expected);
    }
    check(await api.kivro.db.job.count({ where: { buyerId: buyer.user.id } }) === 8, 'EXTRA_PURCHASE_OR_RERUN');
    evidence = { kind: KIND, fixtureId: id, at: new Date().toISOString(), realProviderAcceptance: false, paymentMode: 'fake', malwareScan: 'DEVELOPMENT_ONLY',
      backgroundReconciliationTested: false, planner: 'real-agent-chat-and-provider-adapter-with-loopback-inference-transport', browserTested: false,
      planId: plan.id, conversationId: chat.conversationId, buyerId: buyer.user.id, sellerIds: hosts.map(host => host.account!.user.id),
      workerIds: hosts.map(host => host.identity!.workerId), capabilityIds: caps.map(cap => cap.dto.id), imageIds: hosts.map(host => host.state.get('approvedImageId')),
      ratingFloor: 4.5, warmupJobs: warmups.map(job => job.id), planJobs: settlementEvidence, explicitApproval: approval.approval,
      maximumBudgetMinor: 1500, actualPlanCostMinor: 396, walletReservedAfterMinor: 0, unspentAuthorizationMinor: 1104,
      reservationModel: 'per-job reservation; unused authorization was never debited', dependencyFilesActuallyRead: 3,
      pdf: { id: asset.id, sha256: asset.sha256, sizeBytes: asset.sizeBytes, popplerParsed: true, popplerRendered: true, renderedSha256: sha256(rendered) },
      synthesisId: synthesis.id, provenance: synthesis.sources, reviewIds, resultReplayChecked: true, repeatedReconciliationChecked: true, providerRequests, platformRequests };
  } catch (error) {
    failure = error;
    const audit = hosts.flatMap(host => host.state.db.prepare("SELECT event FROM audit WHERE event LIKE 'EXECUTION_STOPPED_%' ORDER BY id DESC LIMIT 3").all());
    console.error(JSON.stringify({ kind: KIND, passed: false, phase, code: providerError ?? safeCode(error), audit,
      errorClass: error instanceof Error ? error.name : 'UNKNOWN',
      locations: error instanceof Error ? error.stack?.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 5) : [] }));
  } finally {
    clearTimeout(watchdog);
    const cleanup = async (name: string, action: () => Promise<unknown>) => { try { await action(); } catch { cleanupErrors.push(name); } };
    // Financial/job/review/artifact history is intentionally retained. Never truncate shared stores.
    for (const cap of caps) await cleanup('pause-capability', () => post(`/api/seller/capabilities/${cap.dto.id}/pause`, { paused: true }, cap.host.account, {}, true));
    if (api && buyer) await cleanup('cancel-own-unfinished-jobs', async () => {
      const pending = await api!.kivro.db.job.findMany({ where: { buyerId: buyer!.user.id, state: { notIn: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] } } });
      for (const job of pending) await post(`/api/jobs/${job.id}/cancel`, {}, buyer, {}, true);
    });
    for (const host of hosts) { host.state.pause('LOCAL'); host.state.set('stopRequested', true); }
    for (const host of hosts) {
      if (host.task) await cleanup('stop-runtime', () => host.task!);
      if (host.error) cleanupErrors.push('runtime-error');
      if (host.identity && host.account) {
        await cleanup('pause-worker', () => post(`/api/seller/workers/${host.identity!.workerId}/pause`, {}, host.account, {}, true));
        await cleanup('revoke-worker', () => post(`/api/seller/workers/${host.identity!.workerId}/revoke`, {}, host.account, {}, true));
      }
    }
    if (api && plan) await cleanup('reconcile-stopped-plan', tick);
    for (const account of [buyer, ...hosts.map(host => host.account)]) if (account) await cleanup('logout', () => post('/api/auth/logout', {}, account, {}, true));
    if (api) await cleanup('verify-cleanup', async () => {
      for (const host of hosts) {
        if (host.identity) { const worker = await api!.kivro.db.workerDevice.findUniqueOrThrow({ where: { id: host.identity.workerId } }); check(worker.paused && worker.revokedAt && !worker.sandboxReady, 'WORKER_CLEANUP'); }
        check(!host.state.get('securityBlock') && !host.state.activeAttempts().length && !host.runtime?.active.size && !host.state.pending().length, 'RUNTIME_CLEANUP');
      }
      for (const cap of caps) check((await api!.kivro.db.capability.findUniqueOrThrow({ where: { id: cap.dto.id } })).paused, 'CAPABILITY_CLEANUP');
      for (const account of [buyer, ...hosts.map(host => host.account)]) if (account) check(await api!.kivro.db.session.count({ where: { userId: account.user.id } }) === 0, 'SESSION_CLEANUP');
      if (buyer) check((await api!.kivro.db.wallet.findUniqueOrThrow({ where: { userId: buyer.user.id } })).reservedMinor === 0, 'UNRELEASED_RESERVATION');
    });
    OpenAIPlatformProvider.prototype.generate = originalGenerate;
    await cleanup('inference-server', async () => { provider.closeAllConnections(); if (provider.listening) await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())); });
    if (api) await cleanup('api-server', async () => { await api!.close(); (api!.kivro.storage as S3ObjectStore).client.destroy(); });
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    for (const host of hosts) host.state.close();
    await cleanup('temporary-state', () => rm(root, { recursive: true, force: true }));
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  if (failure || cleanupErrors.length || !evidence) {
    console.error(JSON.stringify({ kind: KIND, passed: false, fixtureId: id, planId: plan?.id, workerIds: hosts.map(host => host.identity?.workerId), capabilityIds: caps.map(cap => cap.dto.id), cleanupErrors })); process.exitCode = 1;
  } else console.log(JSON.stringify({ ...evidence, passed: true, cleanup: 'capabilities-paused-workers-revoked-sessions-logged-out-temp-state-removed-financial-history-preserved' }));
}

main().catch(error => { console.error(JSON.stringify({ kind: KIND, passed: false, code: safeCode(error) })); process.exitCode = 1; });
