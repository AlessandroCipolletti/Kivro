// Deterministic TEST FIXTURE only. No real-provider or production-payment acceptance.
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
import { detectRuntime, runProcess } from '../packages/openclaw-adapter/src/index.ts';
import { resolveMediaFixtureImage } from '../packages/storage/src/media-fixtures.js';
import type { S3ObjectStore } from '../packages/storage/src/index.js';

const KIND = 'DETERMINISTIC_LOCAL_MEDIA_FULLSTACK_TEST_FIXTURE';
const MODEL = 'kivro-deterministic-blender-fixture';
const ORIGIN = 'http://127.0.0.1:3000';
const OUTPUT = 'render_0001.png';
// Public synthetic local infrastructure credentials only. Never load .env.
const API_ENV = {
  NODE_ENV: 'test', KIVRO_ENV: 'development', PAYMENT_MODE: 'fake', DEV_AUTH_ENABLED: 'false',
  DATABASE_URL: 'postgresql://kivro:kivro_local_only@127.0.0.1:55432/kivro?schema=public',
  REDIS_URL: 'redis://127.0.0.1:56379', WEB_ORIGIN: ORIGIN,
  S3_ENDPOINT: 'http://127.0.0.1:59000', S3_BUCKET: 'kivro-development', S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'kivro_local', S3_SECRET_KEY: 'kivro_local_storage_only', S3_FORCE_PATH_STYLE: 'true',
};
type Account = { cookie: string; user: { id: string; email: string } };
type Message = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
type Scene = { name: 'validation' | 'purchase'; data: Buffer; width: number; height: number; pngHash: string; pixelHash: string };
type Run = { scene: Scene; assetId: string; step: number; renderReplyObserved: boolean };
type Wallet = { availableMinor: number; reservedMinor: number; spentMinor: number; earnedMinor: number; ledger: { jobId: string | null; type: string }[] };
function check(value: unknown, code: string): asserts value { if (!value) throw new Error(`MEDIA_FIXTURE_${code}`); }
const safeCode = (error: unknown) => error instanceof Error && /^[A-Z0-9_:/.-]{1,200}$/.test(error.message) ? error.message : 'MEDIA_FIXTURE_OPERATION_FAILED';
async function boundedBody(response: Response, maxBytes = 2 * 1024 ** 2): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0; check(response.body, 'RESPONSE_BODY_MISSING');
  const reader = response.body.getReader();
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; check(bytes <= maxBytes, 'RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel(); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/** Trusted fixture preparation/inspection, never a production execution path. */
async function fixtureContainer(imageId: string, program: string): Promise<unknown> {
  const name = `kivro-media-acceptance-${randomUUID()}`;
  try {
    const result = await runProcess('docker', ['run', '--rm', '--name', name, '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--user=1000:1000', '--cpus=1', '--memory=1g', '--memory-swap=1g', '--pids-limit=128', '--log-driver=none',
      '--tmpfs=/job/work:rw,nosuid,nodev,size=134217728,uid=1000,gid=1000', '--tmpfs=/job/output:rw,noexec,nosuid,nodev,size=16777216,uid=1000,gid=1000',
      '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864,uid=1000,gid=1000', '--env=OMP_NUM_THREADS=1', '-i', '--entrypoint=node', imageId, '-'],
    { input: program, timeoutMs: 180000, maxBytes: 8 * 1024 ** 2 });
    check(result.code === 0, 'GENERATION_OR_DECODING_FAILED'); return JSON.parse(result.stdout);
  } finally {
    // Only this invocation's random fixture container is eligible for cleanup.
    await runProcess('docker', ['rm', '-f', name], { timeoutMs: 10000, maxBytes: 4096 });
    const remaining = await runProcess('docker', ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], { timeoutMs: 10000, maxBytes: 4096 });
    check(remaining.code === 0 && !remaining.stdout.trim(), 'FIXTURE_CONTAINER_CLEANUP_FAILED');
  }
}
const containerPrelude = String.raw`
  const {spawnSync}=require('node:child_process'), {readFileSync,writeFileSync}=require('node:fs'), {createHash}=require('node:crypto');
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  function run(binary,args) { const r=spawnSync(binary,args,{timeout:60000,maxBuffer:4*1024*1024}); if(r.status!==0) throw Error('FIXED_MEDIA_OPERATION_FAILED'); return r.stdout; }
  function pixels(path) { return run('/usr/bin/ffmpeg',['-nostdin','-v','error','-threads','1','-filter_threads','1','-i',path,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-threads','1','pipe:1']); }
`;
async function generateScenes(approvedImageId: string): Promise<Scene[]> {
  const imageId = await resolveMediaFixtureImage(approvedImageId), entropy = randomBytes(4);
  const specs = [
    { name: 'validation', width: 128 + entropy[0]! % 16, height: 96 + entropy[1]! % 16, color: [0.8, 0.1, 0.2, 1], rotation: 0.2 },
    { name: 'purchase', width: 192 + entropy[2]! % 16, height: 144 + entropy[3]! % 16, color: [0.1, 0.7, 0.3, 1], rotation: 0.7 },
  ];
  const rows = await fixtureContainer(imageId, containerPrelude + `
    const rows=[];
    for(const s of ${JSON.stringify(specs)}) {
      const path='/job/work/'+s.name+'.blend';
      // Blender factory defaults emit date, file path and render-time metadata.
      // Disable those only in our synthetic scene so whole-file hashes reproduce.
      const python="import bpy; s=bpy.context.scene; s.render.resolution_x="+s.width+"; s.render.resolution_y="+s.height+"; s.render.resolution_percentage=100; s.render.image_settings.file_format='PNG'; s.render.image_settings.color_mode='RGBA'; s.render.image_settings.color_depth='8'; [setattr(s.render,p.identifier,False) for p in s.render.bl_rna.properties if p.identifier.startswith('use_stamp') and p.type=='BOOLEAN']; s.display.shading.color_type='OBJECT'; o=bpy.data.objects['Cube']; o.color="+JSON.stringify(s.color)+"; o.rotation_euler[2]="+s.rotation+"; bpy.ops.wm.save_as_mainfile(filepath='"+path+"',compress=False)";
      run('/usr/bin/blender',['--background','--factory-startup','--disable-autoexec','--threads','1','--python-expr',python]);
      run('/usr/bin/blender',['--background','--factory-startup','--disable-autoexec',path,'--engine','BLENDER_WORKBENCH','--threads','1','--render-format','PNG','--render-output','/job/output/'+s.name+'_','--render-frame','1']);
      const png='/job/output/'+s.name+'_0001.png', decoded=pixels(png);
      if(decoded.length!==s.width*s.height*3 || new Set(decoded).size<16) throw Error('REFERENCE_IMAGE_BLANK');
      rows.push({...s,blend:readFileSync(path).toString('base64'),pngHash:hash(readFileSync(png)),pixelHash:hash(decoded)});
    }
    process.stdout.write(JSON.stringify(rows));
  `) as { name: Scene['name']; width: number; height: number; blend: string; pngHash: string; pixelHash: string }[];
  check(Array.isArray(rows) && rows.length === 2, 'SCENE_GENERATION_COUNT');
  return rows.map((row, i) => {
    assert.equal(row.name, specs[i]!.name); assert.equal(row.width, specs[i]!.width); assert.equal(row.height, specs[i]!.height);
    check(/^[a-f0-9]{64}$/.test(row.pngHash) && /^[a-f0-9]{64}$/.test(row.pixelHash), 'REFERENCE_HASH_INVALID');
    const data = Buffer.from(row.blend, 'base64'); check(data.length > 65536 && data.length < 4 * 1024 ** 2 && data.subarray(0, 7).toString() === 'BLENDER', 'GENERATED_BLEND_INVALID');
    return { name: row.name, data, width: row.width, height: row.height, pngHash: row.pngHash, pixelHash: row.pixelHash };
  });
}
async function inspectDeliveredPng(imageId: string, data: Buffer, scene: Scene): Promise<void> {
  check(data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.toString('ascii', 12, 16) === 'IHDR', 'PNG_HEADER');
  assert.equal(data.readUInt32BE(16), scene.width); assert.equal(data.readUInt32BE(20), scene.height);
  const decoded = await fixtureContainer(imageId, containerPrelude + `
    const path='/job/work/delivered.png'; writeFileSync(path,Buffer.from(${JSON.stringify(data.toString('base64'))},'base64'));
    const bytes=pixels(path); process.stdout.write(JSON.stringify({pixelHash:hash(bytes),size:bytes.length,distinct:new Set(bytes).size}));
  `) as { pixelHash: string; size: number; distinct: number };
  assert.equal(decoded.pixelHash, scene.pixelHash); assert.equal(decoded.size, scene.width * scene.height * 3); check(decoded.distinct >= 16, 'DELIVERED_IMAGE_BLANK');
}

async function main(): Promise<void> {
  if (process.argv.slice(2).join(' ') !== '--run') { console.log('Deterministic local MEDIA TEST FIXTURE, not real-provider acceptance. Run: node --import tsx scripts/e2e-media-fixture.ts --run'); return; }
  check(process.env.NODE_ENV !== 'production' && process.env.KIVRO_ENV !== 'production', 'PRODUCTION_DENIED');
  const id = randomUUID(), token = `kivro-media-test-only-${randomBytes(24).toString('hex')}`;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-media-fullstack-'))), state = new WorkerState(join(root, 'worker')), secrets = new SecretStore(state);
  const abort = new AbortController(), cancel = () => { abort.abort(); state.pause('LOCAL'); state.set('stopRequested', true); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const watchdog = setTimeout(() => process.emit('SIGTERM'), 10 * 60_000);
  const saved = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string) => { if (!saved.has(key)) saved.set(key, process.env[key]); process.env[key] = value; };
  for (const [key, value] of Object.entries({ KIVRO_WORKER_HOME: state.root, KIVRO_WORKER_MASTER_KEY: randomBytes(32).toString('hex'), KIVRO_ENV: 'development', NODE_ENV: 'test', DEV_AUTH_ENABLED: 'false' })) setEnv(key, value);
  let api: Awaited<ReturnType<typeof createApp>> | undefined, apiUrl = '', imageId = '', phase = 'prerequisites', providerError: string | undefined, providerRequests = 0;
  let run: Run | undefined, runtime: WorkerRuntime | undefined, runtimeTask: Promise<void> | undefined, runtimeError: unknown, runtimeDone = false;
  let seller: Account | undefined, buyer: Account | undefined, capability: CapabilityDTO | undefined, identity: DeviceIdentity | undefined;
  let evidence: Record<string, unknown> | undefined, failure: unknown;
  const cleanupErrors: string[] = [];
  const stage = (name: string) => { phase = name; console.log(`MEDIA_TEST_FIXTURE ${name}`); check(!abort.signal.aborted, 'CANCELLED'); };
  const request = (path: string, options: RequestInit = {}, account?: Account, cleanup = false) => {
    check(path.startsWith('/') && !path.startsWith('//'), 'INVALID_API_PATH');
    const timeout = AbortSignal.timeout(20000);
    return fetch(`${apiUrl}${path}`, { ...options, redirect: 'manual', headers: { Origin: ORIGIN, ...(account ? { Cookie: account.cookie } : {}), ...options.headers }, signal: cleanup ? timeout : AbortSignal.any([abort.signal, timeout]) });
  };
  const json = async <T>(path: string, options: RequestInit = {}, account?: Account, cleanup = false): Promise<T> => {
    const response = await request(path, options, account, cleanup), body = JSON.parse((await boundedBody(response)).toString());
    if (!response.ok) throw new Error(`MEDIA_FIXTURE_API_${response.status}_${/^[A-Z0-9_]+$/.test(body.error?.code) ? body.error.code : 'ERROR'}`);
    return body as T;
  };
  const post = <T>(path: string, body: unknown, account?: Account, headers: Record<string, string> = {}, cleanup = false) => json<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }, account, cleanup);
  const register = async (role: 'seller' | 'buyer'): Promise<Account> => {
    const terms = await json<{ version: string }>('/api/terms');
    const response = await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `Media fixture ${role}`, email: `media-fixture-${role}-${id}@kivro.invalid`, password: randomBytes(32).toString('base64url'), acceptedTermsVersion: terms.version }) });
    check(response.ok, `REGISTER_${role.toUpperCase()}_${response.status}`);
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); check(cookie, 'REGISTRATION_SESSION_MISSING');
    return { cookie, ...JSON.parse((await boundedBody(response)).toString()) };
  };
  const download = async (asset: AssetDTO, account: Account): Promise<Buffer> => {
    const response = await request(`/api/assets/${asset.id}/download`, {}, account); check(response.status === 302, 'ASSET_DOWNLOAD_NOT_AUTHORIZED');
    const location = new URL(response.headers.get('location') ?? ''); check(location.origin === API_ENV.S3_ENDPOINT && !location.username && !location.password, 'NONLOCAL_STORAGE_REDIRECT');
    const object = await fetch(location, { redirect: 'manual', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]) }); check(object.ok, 'S3_DOWNLOAD_FAILED');
    const data = await boundedBody(object, 4 * 1024 ** 2); assert.equal(data.length, asset.sizeBytes); assert.equal(sha256(data), asset.sha256); return data;
  };
  const provider = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/v1/models') {
        check(req.headers.authorization === `Bearer ${token}`, 'INFERENCE_TOKEN');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: MODEL }] })); return;
      }
      check(req.method === 'POST' && req.url === '/v1/chat/completions', 'INFERENCE_ROUTE'); check(req.headers.authorization === `Bearer ${token}`, 'INFERENCE_TOKEN');
      check(++providerRequests <= 10, 'INFERENCE_REQUEST_LIMIT');
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; check(size <= 2 * 1024 ** 2, 'INFERENCE_BODY_LIMIT'); chunks.push(Buffer.from(chunk)); }
      const body = JSON.parse(Buffer.concat(chunks).toString()), messages = body.messages as Message[];
      check(body.model === MODEL && body.store === false && body.stream === false && Array.isArray(messages), 'INFERENCE_CONTRACT');
      let content = 'OK', call: { name: string; arguments: string } | undefined;
      if (!body.tools?.length) check(messages.length === 1 && messages[0]?.content === 'Reply with OK.', 'INFERENCE_HEALTH_REQUEST');
      else {
        check(run, 'UNEXPECTED_JOB_INFERENCE');
        check(JSON.stringify((body.tools as { function: { name: string } }[]).map(tool => tool.function.name).sort()) === JSON.stringify(['blender_render']), 'TOOL_ALLOWLIST');
        if (run.step === 0) {
          check(!JSON.stringify(messages).includes(run.scene.pixelHash) && !JSON.stringify(messages).includes(run.scene.pngHash), 'REFERENCE_LEAKED_TO_MODEL');
          check(JSON.stringify(messages).includes(`input/${run.assetId}`), 'INPUT_SNAPSHOT_NOT_DECLARED');
          call = { name: 'blender_render', arguments: JSON.stringify({ assetId: run.assetId, frame: 1 }) };
        } else {
          check(run.step === 1, 'UNEXPECTED_TOOL_RETRY');
          const calls = messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []); check(calls.length === 1, 'REAL_TOOL_CALL_HISTORY_MISSING');
          const prior = calls[0]!; assert.equal(prior.function.name, 'blender_render'); assert.deepEqual(JSON.parse(prior.function.arguments), { assetId: run.assetId, frame: 1 });
          const reply = messages.find(message => message.role === 'tool' && message.tool_call_id === prior.id);
          check(reply && JSON.stringify(reply.content).includes(OUTPUT), 'CANONICAL_RENDER_REPLY_MISSING');
          run.renderReplyObserved = true; content = JSON.stringify({ fields: { render: OUTPUT } });
        }
        run.step++;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `media-fixture-${providerRequests}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL,
        choices: [{ index: 0, message: call ? { role: 'assistant', content: null, tool_calls: [{ id: `render-${run!.scene.name}`, type: 'function', function: call }] } : { role: 'assistant', content }, finish_reason: call ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: !call && content === 'OK' ? 1 : 100, total_tokens: !call && content === 'OK' ? 101 : 200 } }));
    } catch (error) { providerError = safeCode(error); res.writeHead(400).end(JSON.stringify({ error: { code: providerError } })); }
  });
  provider.requestTimeout = 15000; provider.headersTimeout = 10000; provider.maxConnections = 2;
  try {
    imageId = await resolveMediaFixtureImage(); setEnv('KIVRO_SANDBOX_IMAGE', imageId);
    check((await detectRuntime()).compatible, 'UNSUPPORTED_HOST_OPENCLAW');
    api = await createApp({ env: API_ENV, background: false, logger: false }); apiUrl = await api.listen({ host: '127.0.0.1', port: 0 }); setEnv('API_URL', apiUrl);
    const ready = await json<{ status: string; services: Record<string, string> }>('/ready'); check(ready.status === 'ready' && ['database', 'storage', 'redis'].every(name => ready.services[name] === 'ready'), 'LOCAL_SERVICES_NOT_READY');
    await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
    const address = provider.address(); check(address && typeof address === 'object', 'INFERENCE_LISTEN_FAILED');
    stage('register-and-pair'); seller = await register('seller'); buyer = await register('buyer'); check(seller.user.id !== buyer.user.id, 'DISTINCT_IDENTITIES_REQUIRED');
    const pairing = await post<{ code: string }>('/api/seller/pairing-code', {}, seller); await workerCommand(['pair', pairing.code, '--name', `Media fixture ${id}`]);
    identity = state.get<DeviceIdentity>('identity'); check(identity, 'PAIRING_NOT_PERSISTED');
    stage('real-sandbox-and-inference-proofs'); await workerCommand(['sandbox', 'approve-image']); assert.equal(state.get('approvedImageId'), imageId);
    await secrets.put('media-fixture-inference', token);
    const config = validateInferenceConfig({ provider: 'openai-compatible', model: MODEL, credentialRef: 'media-fixture-inference', baseUrl: `http://127.0.0.1:${address.port}/v1`, allowLocal: true,
      maxTokensPerJob: 200000, dailyTokenLimit: 1000000, inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 });
    const configPath = join(root, 'inference.json'); await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await workerCommand(['inference', 'configure', '--file', configPath, '--approve', hashManifest(config)]); await workerCommand(['inference', 'test']);
    check(!providerError && state.get('sandboxProof') && state.get('inferenceProof'), 'LIVE_PROOFS_MISSING');
    stage('generate-synthetic-blend-scenes');
    const scenes = await generateScenes(state.get<string>('approvedImageId')!), validation = scenes[0]!, purchase = scenes[1]!;
    check(validation.pixelHash !== purchase.pixelHash && validation.width !== purchase.width, 'DISTINCT_SCENES_REQUIRED');
    const base = LocalCapabilitySchema.parse({ capabilityVersionId: randomUUID(), selectedSkills: [], dependencies: [],
      internalInstructions: 'Render frame 1 of the required scene with blender.render. Return a strict JSON object whose named render field is the generated relative PNG path. This is a deterministic local TEST FIXTURE.',
      permissions: { schemaVersion: 1, tools: ['blender.render'], resources: [], network: { mode: 'NONE', allowedDomains: [] }, inference: { provider: config.provider, model: config.model, credentialRef: config.credentialRef },
        limits: { timeoutSeconds: 180, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 4 * 1024 ** 2, maxOutputBytes: 2 * 1024 ** 2, maxTokens: 200000 } },
      ioContract: { schemaVersion: 1, inputs: [{ key: 'scene', label: 'Scene', type: 'FILE', required: true, order: 0, constraints: { allowedMimeTypes: ['application/x-blender'], allowedExtensions: ['.blend'], maxFileSizeBytes: 4 * 1024 ** 2 } }],
        output: { type: 'FILES', description: 'Rendered scene', required: true, fields: [{ key: 'render', label: 'Render', type: 'FILE', required: true, order: 0, constraints: { allowedMimeTypes: ['image/png'], allowedExtensions: ['.png'], maxFileSizeBytes: 1024 ** 2 } }],
          files: { allowedMimeTypes: ['image/png'], allowedExtensions: ['.png'], maxFiles: 1, maxTotalSizeBytes: 1024 ** 2 } } } });
    base.dependencies = discoveredDependencyGrants(state, base).map(dependency => ({ ...dependency, approved: true })); check(base.dependencies.every(dependency => dependency.healthy && dependency.supported), 'UNHEALTHY_DEPENDENCY');
    const definition = CreateCapabilitySchema.parse({ title: `Media fixture ${id}`, summary: 'Deterministic local Blender render fixture.', description: 'Private synthetic required-file acceptance. Not real-provider acceptance.', category: 'Design & media', tags: ['test-fixture'],
      priceTierId: 'USD_99', ioContract: base.ioContract, permissions: base.permissions, dependencies: base.dependencies, internalInstructions: base.internalInstructions, workerId: identity.workerId, estimatedDurationSeconds: 120 });
    capability = await post<CapabilityDTO>('/api/seller/capabilities', definition, seller);
    const manifest = LocalCapabilitySchema.parse({ ...base, capabilityVersionId: capability.versionId }); approveCapability(state, manifest, hashManifest(manifest));
    stage('real-capability-validation');
    const validationPath = join(root, 'validation.blend'), validationId = randomUUID(); await writeFile(validationPath, validation.data, { mode: 0o444 });
    run = { scene: validation, assetId: validationId, step: 0, renderReplyObserved: false };
    const validationResult = await testCapability(state, secrets, capability.versionId, { input: { scene: validationId }, assets: [{ id: validationId, path: validationPath, filename: 'scene.blend', mimeType: 'application/x-blender', sizeBytes: validation.data.length, sha256: sha256(validation.data) }] }, imageId, true) as { passed: boolean; generatedFiles: { path: string; sha256: string }[] };
    check(!providerError && run.renderReplyObserved && run.step === 2 && validationResult.passed, 'VALIDATION_FLOW_INCOMPLETE');
    stage('verify-capability-reference-render');
    check(validationResult.generatedFiles.length === 1 && validationResult.generatedFiles[0]!.path === OUTPUT, 'VALIDATION_RENDER_FILE_MISSING');
    check(validationResult.generatedFiles[0]!.sha256 === validation.pngHash, 'VALIDATION_REFERENCE_PNG_MISMATCH');
    await workerCommand(['resume', '--all']);
    stage('runtime-readiness-and-private-publication'); runtime = new WorkerRuntime(state, secrets, imageId, true);
    runtimeTask = runtime.start().catch(error => { runtimeError = error; }).finally(() => { runtimeDone = true; });
    const until = async (predicate: () => Promise<boolean>, timeoutMs: number, code: string) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) { check(!abort.signal.aborted, 'CANCELLED'); check(!runtimeDone, 'RUNTIME_STOPPED'); if (providerError) throw new Error(providerError); if (await predicate()) return; await delay(500); }
      throw new Error(`MEDIA_FIXTURE_${code}`);
    };
    await until(async () => { const workers = await json<{ id: string; sandboxReady: boolean; localPaused: boolean; bindings: { capabilityVersionId: string; healthy: boolean }[] }[]>('/api/seller/workers', {}, seller); return runtime!.readyCapabilityIds().includes(capability!.versionId) && workers.some(worker => worker.id === identity!.workerId && worker.sandboxReady && !worker.localPaused && worker.bindings.some(binding => binding.capabilityVersionId === capability!.versionId && binding.healthy)); }, 60000, 'RUNTIME_NOT_READY');
    await post(`/api/seller/capabilities/${capability.id}/publish`, { visibility: 'PRIVATE', localExecutionAcknowledged: true }, seller);
    check((await request(`/api/capabilities/${capability.id}`, {}, buyer)).status === 404, 'PRIVATE_CAPABILITY_WITHOUT_GRANT');
    await post(`/api/seller/capabilities/${capability.id}/grants`, { email: buyer.user.email, allowed: true }, seller);
    const visible = await json<CapabilityDTO>(`/api/capabilities/${capability.id}`, {}, buyer); check(visible.visibility === 'PRIVATE' && visible.availability.canRunNow, 'CAPABILITY_UNAVAILABLE');
    stage('required-blend-upload-and-purchase');
    const form = new FormData(); form.set('file', new Blob([new Uint8Array(purchase.data)], { type: 'application/x-blender' }), 'scene.blend');
    const inputAsset = await json<AssetDTO>('/api/assets/upload', { method: 'POST', body: form }, buyer);
    assert.equal(inputAsset.sha256, sha256(purchase.data)); assert.deepEqual(await download(inputAsset, buyer), purchase.data);
    run = { scene: purchase, assetId: inputAsset.id, step: 0, renderReplyObserved: false };
    await post('/api/wallet/topup', { amountMinor: 1000 }, buyer, { 'Idempotency-Key': randomUUID() });
    const beforeBuyer = await json<Wallet>('/api/wallet', {}, buyer), beforeSeller = await json<Wallet>('/api/wallet', {}, seller);
    const quote = await post<{ id: string }>(`/api/capabilities/${capability.id}/quote`, { executionMode: 'NOW' }, buyer);
    const body = { capabilityId: capability.id, input: { scene: inputAsset.id }, executionMode: 'NOW', quoteId: quote.id }, key = { 'Idempotency-Key': randomUUID() };
    let job = await post<JobDTO>('/api/jobs', body, buyer, key); assert.equal((await post<JobDTO>('/api/jobs', body, buyer, key)).id, job.id);
    await until(async () => { job = await json<JobDTO>(`/api/jobs/${job.id}`, {}, buyer); return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(job.state); }, 240000, 'JOB_TIMEOUT');
    check(job.state === 'SUCCEEDED' && job.paymentState === 'SETTLED', `JOB_${job.state}`); check(run.renderReplyObserved && run.step === 2, 'PURCHASE_RENDER_NOT_OBSERVED');
    const assets = job.output?.assets; check(assets?.length === 1, 'GENERATED_FILE_MISSING'); const outputAsset = assets[0]!;
    assert.equal(outputAsset.filename, OUTPUT); assert.equal(outputAsset.mimeType, 'image/png'); assert.equal(job.output?.fields?.render, outputAsset.id);
    stage('download-render-pixels-and-idempotent-settlement');
    const png = await download(outputAsset, buyer); assert.equal(sha256(png), purchase.pngHash); await inspectDeliveredPng(imageId, png, purchase);
    check((await request(`/api/assets/${outputAsset.id}/download`)).status === 401, 'ANONYMOUS_OUTPUT_ACCESS'); check((await request(`/api/assets/${outputAsset.id}/download`, {}, seller)).status === 404, 'SELLER_OUTPUT_ACCESS');
    const attempts = await api.kivro.db.jobAttempt.findMany({ where: { jobId: job.id } }); check(attempts.length === 1 && attempts[0]!.workerId === identity.workerId && attempts[0]!.state === 'SUCCEEDED', 'SINGLE_REAL_ATTEMPT_REQUIRED');
    const transport = new WorkerTransport(apiUrl, identity, await secrets.get('device-identity'), true); await transport.request('POST', `/api/worker/jobs/${job.id}/result`, { attemptId: attempts[0]!.id, output: job.output });
    await runtime.flush(); await runtime.flushUsage();
    await until(async () => { await runtime!.flush(); await runtime!.flushUsage(); return !runtime!.active.size && !state.pending().length; }, 40000, 'DELIVERY_OUTBOX_NOT_DRAINED');
    const afterBuyer = await json<Wallet>('/api/wallet', {}, buyer), afterSeller = await json<Wallet>('/api/wallet', {}, seller);
    check(afterBuyer.ledger.filter(entry => entry.jobId === job.id && entry.type === 'JOB_CAPTURE').length === 1, 'CAPTURE_COUNT'); check(afterSeller.ledger.filter(entry => entry.jobId === job.id && entry.type === 'SELLER_EARNING').length === 1, 'EARNING_COUNT');
    assert.equal(beforeBuyer.availableMinor - afterBuyer.availableMinor, job.priceSnapshot.buyerPriceMinor); assert.equal(afterBuyer.spentMinor - beforeBuyer.spentMinor, job.priceSnapshot.buyerPriceMinor); assert.equal(afterBuyer.reservedMinor, 0); assert.equal(afterSeller.earnedMinor - beforeSeller.earnedMinor, job.priceSnapshot.sellerNetMinor);
    const settlement = await api.kivro.db.ledgerEntry.findMany({ where: { jobId: job.id, type: { in: ['JOB_CAPTURE', 'SELLER_EARNING', 'PLATFORM_FEE'] } } });
    check(settlement.length === 3 && new Set(settlement.map(entry => entry.type)).size === 3 && new Set(settlement.map(entry => entry.transactionId)).size === 1, 'SETTLEMENT_TRANSACTION_COUNT'); assert.equal(settlement.reduce((sum, entry) => sum + entry.amountMinor, 0), 0);
    const events = job.events.map(event => event.type); for (const type of ['ACCEPTED', 'RUNNING', 'VALIDATING_RESULTS', 'SUCCEEDED']) check(events.includes(type), `MISSING_${type}_EVENT`);
    evidence = { kind: KIND, realProviderAcceptance: false, paymentMode: 'fake', malwareScan: 'DEVELOPMENT_ONLY', backgroundReconciliationTested: false,
      at: new Date().toISOString(), fixtureId: id, jobId: job.id, capabilityId: capability.id, sellerId: seller.user.id, buyerId: buyer.user.id, workerId: identity.workerId, attemptId: attempts[0]!.id, imageId,
      tools: ['blender.render'], arbitraryShellGranted: false, events, inferenceRequests: providerRequests, canonicalRenderReplyObserved: true,
      requiredScene: { id: inputAsset.id, sha256: inputAsset.sha256, sizeBytes: inputAsset.sizeBytes },
      generatedPng: { id: outputAsset.id, sha256: outputAsset.sha256, sizeBytes: outputAsset.sizeBytes, width: purchase.width, height: purchase.height, pixelSha256: purchase.pixelHash },
      referencePngAndPixelsMatch: true, captures: 1, sellerEarnings: 1, platformFees: 1, balancedSettlementTransactions: 1, resultReplayChecked: true };
  } catch (error) {
    failure = error;
    const audit = state.db.prepare("SELECT event FROM audit WHERE event LIKE 'EXECUTION_STOPPED_%' ORDER BY id DESC LIMIT 3").all();
    console.error(JSON.stringify({ kind: KIND, passed: false, phase, code: providerError ?? safeCode(error), errorType: error instanceof Error ? error.name : 'unknown', providerRequests,
      renderStep: run?.step, renderReplyObserved: run?.renderReplyObserved, audit }));
  } finally {
    clearTimeout(watchdog);
    const cleanup = async (name: string, action: () => Promise<unknown>) => { try { await action(); } catch { cleanupErrors.push(name); } };
    state.pause('LOCAL'); state.set('stopRequested', true);
    if (capability && seller) await cleanup('pause-capability', () => post(`/api/seller/capabilities/${capability!.id}/pause`, { paused: true }, seller, {}, true));
    if (runtimeTask) await cleanup('stop-runtime', () => runtimeTask!); if (runtimeError) cleanupErrors.push('runtime-error');
    if (identity && seller) { await cleanup('pause-worker', () => post(`/api/seller/workers/${identity!.workerId}/pause`, {}, seller, {}, true)); await cleanup('revoke-worker', () => post(`/api/seller/workers/${identity!.workerId}/revoke`, {}, seller, {}, true)); }
    if (capability && seller && buyer) await cleanup('revoke-buyer-grant', () => post(`/api/seller/capabilities/${capability!.id}/grants`, { email: buyer!.user.email, allowed: false }, seller, {}, true));
    for (const account of [buyer, seller]) if (account) await cleanup('logout', () => post('/api/auth/logout', {}, account, {}, true));
    if (api) await cleanup('verify-cleanup-state', async () => {
      if (identity) { const worker = await api!.kivro.db.workerDevice.findUniqueOrThrow({ where: { id: identity.workerId } }); check(worker.paused && worker.revokedAt && !worker.sandboxReady, 'WORKER_CLEANUP_NOT_PERSISTED'); }
      if (capability) { const cap = await api!.kivro.db.capability.findUniqueOrThrow({ where: { id: capability.id } }); check(cap.paused && await api!.kivro.db.capabilityGrant.count({ where: { capabilityId: capability.id } }) === 0, 'CAPABILITY_CLEANUP_NOT_PERSISTED'); }
      for (const account of [buyer, seller]) if (account) check(await api!.kivro.db.session.count({ where: { userId: account.user.id } }) === 0, 'SESSION_CLEANUP_NOT_PERSISTED');
      check(!state.get('securityBlock') && !state.activeAttempts().length && !runtime?.active.size && !state.pending().length, 'LOCAL_RUNTIME_CLEANUP_INCOMPLETE');
    });
    await cleanup('inference-server', async () => { provider.closeAllConnections(); if (provider.listening) await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())); });
    if (api) await cleanup('api-server', async () => { await api!.close(); (api!.kivro.storage as S3ObjectStore).client.destroy(); });
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); state.close();
    await cleanup('temporary-worker-state', () => rm(root, { recursive: true, force: true }));
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  if (failure || cleanupErrors.length || !evidence) { console.error(JSON.stringify({ kind: KIND, passed: false, fixtureId: id, workerId: identity?.workerId, capabilityId: capability?.id, cleanupErrors })); process.exitCode = 1; }
  else console.log(JSON.stringify({ ...evidence, cleanup: 'worker-paused-and-revoked-capability-paused-grant-revoked-sessions-logged-out-temp-state-removed', passed: true }));
}
main().catch(error => { console.error(JSON.stringify({ kind: KIND, passed: false, code: safeCode(error) })); process.exitCode = 1; });
