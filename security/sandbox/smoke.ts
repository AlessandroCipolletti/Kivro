// Deterministic verification only: never imported by production Worker code.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, realpath, mkdir, rm, writeFile, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionManifestHash, hashManifest } from '../../packages/contracts/src/index.ts';
import { OpenClawAdapter, DockerSandbox, validateResultFiles, scanRuntime, runProcess } from '../../packages/openclaw-adapter/src/index.ts';
import { fixtureOffer } from '../../packages/job-protocol/src/fixtures.ts';
import { WorkerState } from '../../apps/worker/src/state.ts';
import { SecretStore } from '../../apps/worker/src/secrets.ts';
import { approveResource } from '../../apps/worker/src/resources.ts';
import { JobToolBroker } from '../../apps/worker/src/tools.ts';
import { resourceGrantsForApproval } from '../../apps/worker/src/resource-config.ts';
import { projectResult } from '../../apps/worker/src/results.ts';
import { sha256 } from '../../packages/crypto/src/index.ts';
import { InferenceBroker, validateInferenceConfig } from '../../apps/worker/src/inference.ts';
import { sandboxSelfTest } from '../../apps/worker/src/readiness.ts';
import { reviewSkillImport, type ImportedSkill } from '../../apps/worker/src/imports.ts';
import { approveCapability, LocalCapabilitySchema } from '../../apps/worker/src/capabilities.ts';

const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-sandbox-smoke-')));
const state = new WorkerState(join(root, 'state'));
const oldMasterKey = process.env.KIVRO_WORKER_MASTER_KEY;
process.env.KIVRO_WORKER_MASTER_KEY = randomBytes(32).toString('hex');
const marker = `kivro-real-container-${randomUUID()}`, offer = fixtureOffer();
const nativeAnthropic = process.argv.includes('--anthropic');
class DiagnosticDocker extends DockerSandbox {
  override async execute(spec: Parameters<DockerSandbox['execute']>[0], frame: Parameters<DockerSandbox['execute']>[1], signal: AbortSignal, onStarted?: Parameters<DockerSandbox['execute']>[3]) {
    return super.execute(spec, async raw => {
      if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'failed') {
        process.stderr.write(`TEST_SANDBOX_DIAGNOSTIC ${JSON.stringify(raw)}\n`);
      }
      return frame(raw);
    }, signal, onStarted, chunk => process.stderr.write(chunk.slice(0, 8000)));
  }
}
const docker = new DiagnosticDocker(), adapter = new OpenClawAdapter(docker);
let tools: JobToolBroker | undefined;
let provider: ReturnType<typeof createServer> | undefined;
try {
  if (nativeAnthropic) {
    offer.permissions.inference.provider = 'anthropic';
    offer.dependencies.find(dependency => dependency.type === 'INFERENCE')!.grants!.inferenceProviders = ['anthropic'];
  }
  offer.permissions.tools = ['write', 'resource.read'];
  offer.permissions.limits.timeoutSeconds = 120;
  offer.permissions.limits.maxTokens = 128000;
  offer.permissions.resources = [{ id: 'canary', type: 'LOCAL_FILE', access: 'READ_ONLY' }];
  offer.dependencies.push(
    { id: 'tools', name: 'Reviewed tools', type: 'TOOL', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { tools: offer.permissions.tools } },
    { id: 'resource:canary', name: 'canary', type: 'LOCAL_FILE', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { resources: ['canary'] } },
  );
  offer.ioContract.output = { type: 'MIXED', description: 'Named text and generated file', required: true,
    fields: [{ key: 'summary', label: 'Summary', type: 'MARKDOWN', required: true, order: 0 }, { key: 'document', label: 'Document', type: 'FILE', required: true, order: 1, constraints: { allowedMimeTypes: ['text/plain'], allowedExtensions: ['.txt'], maxFileSizeBytes: 10000 } }],
    files: { allowedMimeTypes: ['text/plain'], allowedExtensions: ['.txt'], maxFiles: 1, maxTotalSizeBytes: 10000 },
  };
  offer.manifestHash = executionManifestHash(offer);
  const source = join(root, 'canary.txt'); await writeFile(source, marker);
  const selection = { id: 'canary', path: source, sha256: sha256(marker), maxBytes: 10000 };
  await approveResource(state, selection, hashManifest(selection));
  state.set(`resourceGrants:${offer.capabilityVersionId}`, resourceGrantsForApproval(state, offer.permissions));
  const imageId = await docker.imageId(process.env.KIVRO_SANDBOX_IMAGE ?? 'kivro-sandbox:2026.8.2');
  await sandboxSelfTest(state, docker, imageId); state.set('approvedImageId', imageId);
  let count = 0;
  const reply = async (request: Record<string, unknown>) => {
    if (!request.tools) return { id: 'health', model: 'test-model', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    const names = (request.tools as { function: { name: string } }[]).map(item => item.function.name);
    assert(names.includes('resource_read'), `Plugin missing: ${names.join(',')}`);
    assert(names.includes('write')); assert(!names.includes('exec'));
    const messages = request.messages as { role: string; content: unknown }[];
    assert(JSON.stringify(messages).includes('IMPORTED_CANARY_SKILL'), 'Reviewed imported instructions missing from actual OpenClaw request');
    if (count > 0) assert(JSON.stringify(messages).includes(count === 1 ? marker : 'Successfully wrote'), 'Expected real tool response not observed');
    const steps = [
      { name: 'resource_read', arguments: JSON.stringify({ resourceId: 'canary' }) },
      { name: 'write', arguments: JSON.stringify({ path: 'result/answer.txt', content: marker }) },
      { name: 'write', arguments: JSON.stringify({ path: 'result/kivro-result.json', content: JSON.stringify({ text: marker, fields: { summary: marker, document: 'answer.txt' } }) }) },
    ];
    const call = steps[count++]; if (count > 5) throw new Error('UNEXPECTED_INFERENCE_LOOP');
    return { id: `test-${count}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'test-model', choices: [{ index: 0, message: call ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${count}`, type: 'function', function: call }] } : { role: 'assistant', content: marker }, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } };
  };
  provider = createServer(async (request, response) => {
    try {
      assert.equal(request.url, nativeAnthropic ? '/v1/messages' : '/v1/chat/completions');
      if (nativeAnthropic) { assert.equal(request.headers['x-api-key'], 'kivro-smoke-test-token'); assert.equal(request.headers['anthropic-version'], '2023-06-01'); assert.equal(request.headers.authorization, undefined); }
      else assert.equal(request.headers.authorization, 'Bearer kivro-smoke-test-token');
      const parts: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert(bytes <= 2 * 1024 ** 2); parts.push(chunk); }
      const body = JSON.parse(Buffer.concat(parts).toString()); assert.equal(body.stream, false);
      if (nativeAnthropic) {
        assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'service_tier', 'stream', 'thinking', ...(body.system ? ['system'] : []), ...(body.tools ? ['tools', 'tool_choice'] : [])].sort());
        assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.service_tier, 'standard_only');
        const completion = await reply({ ...body, messages: [...(body.system ? [{ role: 'system', content: body.system }] : []), ...body.messages], ...(body.tools ? { tools: body.tools.map((tool: { name: string }) => ({ function: tool })) } : {}) });
        const message = completion.choices[0]!.message;
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: completion.id, type: 'message', role: 'assistant', model: completion.model,
          content: 'tool_calls' in message && message.tool_calls ? message.tool_calls.map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })) : [{ type: 'text', text: message.content }],
          stop_reason: completion.choices[0]!.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn', usage: { input_tokens: completion.usage.prompt_tokens, output_tokens: completion.usage.completion_tokens },
        }));
      } else { assert.equal(body.store, false); response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await reply(body))); }
    } catch (error) { process.stderr.write(String(error) + '\n'); response.writeHead(400).end(); }
  });
  await new Promise<void>(resolve => provider!.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address === 'object');
  const config = validateInferenceConfig({ provider: nativeAnthropic ? 'anthropic' : 'openai-compatible', model: 'test-model', credentialRef: 'seller-inference', baseUrl: `http://127.0.0.1:${address.port}/v1`, allowLocal: true, maxTokensPerJob: 128000, dailyTokenLimit: 500000, inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 });
  const secrets = new SecretStore(state); await secrets.put('seller-inference', 'kivro-smoke-test-token'); state.set('inference', config);
  const healthBroker = new InferenceBroker(config, await secrets.get('seller-inference'), offer.permissions, state, randomUUID());
  try { await healthBroker.request({ model: config.model, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 8 }); } finally { healthBroker.cancel(); }
  state.set('inferenceProof', { hash: hashManifest(config), testedAt: Date.now() });
  const personal = join(root, 'synthetic-personal'), skillPath = join(personal, 'skills', 'canary', 'SKILL.md');
  await mkdir(join(personal, 'skills', 'canary'), { recursive: true }); await writeFile(join(personal, 'openclaw.json'), '{}');
  await writeFile(skillPath, '---\nmetadata: {"kivro":{"requires":{"tools":["resource.read","write"],"resources":["canary"],"inference":true}}}\n---\nIMPORTED_CANARY_SKILL: Read the approved canary resource and write only the contracted result files.');
  const before = { content: await readFile(skillPath, 'utf8'), stat: await lstat(skillPath) };
  const discovery = await scanRuntime(undefined, personal); assert(discovery.compatible);
  const plan = { schemaVersion: 1, discoveryHash: hashManifest(discovery), selectedIds: discovery.dependencies.map(node => node.id), permissions: offer.permissions,
    targets: [{ kind: 'INFERENCE', ref: 'configured' }, { kind: 'CREDENTIAL', ref: 'seller-inference' }, { kind: 'TOOL', ref: 'resource.read' }, { kind: 'TOOL', ref: 'write' }, { kind: 'RESOURCE', ref: 'canary' }],
    bindings: discovery.dependencies.filter(node => node.type !== 'SKILL').map(node => ({ discoveredId: node.id, dependencyId: node.type === 'INFERENCE' ? 'inference' : node.type === 'RESOURCE' ? 'resource:canary' : `tool:${node.name}` })),
  };
  const review = await reviewSkillImport(state, secrets, discovery, plan), planPath = join(root, 'import-plan.json'); await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
  const cli = await runProcess(process.execPath, ['--import', 'tsx', 'apps/worker/src/index.ts', 'import', '--config-root', personal, '--file', planPath, '--approve', review.approvalHash], { env: { ...process.env, KIVRO_WORKER_HOME: state.root }, timeoutMs: 30000, maxBytes: 64000 });
  assert.equal(cli.code, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).approved, true);
  const after = await lstat(skillPath); assert.equal(await readFile(skillPath, 'utf8'), before.content); assert.deepEqual([after.mode, after.mtimeMs, after.ctimeMs], [before.stat.mode, before.stat.mtimeMs, before.stat.ctimeMs]);
  offer.dependencies = review.review.dependencies; offer.manifestHash = executionManifestHash(offer);
  const manifest = LocalCapabilitySchema.parse({ capabilityVersionId: offer.capabilityVersionId, ioContract: offer.ioContract, permissions: offer.permissions, dependencies: offer.dependencies, internalInstructions: offer.internalInstructions, selectedSkills: ['canary'] });
  approveCapability(state, manifest, hashManifest(manifest));
  state.resume('LOCAL'); state.claim(offer, `kivro-job-${offer.attemptId}`);
  tools = await JobToolBroker.create(offer, state, secrets, offer.dependencies);
  const job = join(root, 'job'); await mkdir(job);
  const environment = await adapter.buildWorkerEnvironment(job, offer, state.get<ImportedSkill[]>('importedSkills'));
  const inference = new InferenceBroker(config, 'kivro-smoke-test-token', offer.permissions, state, offer.attemptId);
  const result = await adapter.execute({ ...environment, name: `kivro-job-${offer.attemptId}`, owner: offer.workerId, attemptId: offer.attemptId, imageId: await docker.imageId(process.env.KIVRO_SANDBOX_IMAGE ?? 'kivro-sandbox:2026.8.2'), limits: offer.permissions.limits }, offer, request => inference.request(request), new AbortController().signal, async () => { state.transition(offer.jobId, 'RUNNING'); }, (name, input) => tools!.execute(name, input));
  process.stdout.write(JSON.stringify({ phase: 'dependency-import-production-broker-mixed-output', provider: config.provider, deterministic: true, passed: true, imageId, usage: inference.usage() }) + '\n');
  assert.equal(count, 4); assert.equal(result.files.length, 1); assert.equal(result.files[0]!.data.toString(), marker);
  const assets = result.files.map(file => ({ id: randomUUID(), filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes, sha256: file.sha256 }));
  assert.equal(projectResult(offer, result, assets).fields?.document, assets[0]!.id);
  assert.throws(() => validateResultFiles([{ path: '../escape.txt', sizeBytes: 1, data: 'eA==' }], offer.ioContract, 1000));
  const empty = fixtureOffer(), emptyRoot = join(root, 'empty'); await mkdir(emptyRoot);
  empty.ioContract.output.fields = [
    { key: 'summary', label: 'Summary', type: 'SHORT_TEXT', required: true, order: 0 },
    { key: 'structured', label: 'Structured', type: 'JSON', required: true, order: 1, constraints: { jsonSchema: { type: 'object', additionalProperties: false, properties: { marker: { type: 'string' } }, required: ['marker'] } } },
  ];
  empty.manifestHash = executionManifestHash(empty);
  const emptyContent = JSON.stringify({ text: marker, fields: { summary: marker, structured: { marker } } });
  const emptyEnvironment = await adapter.buildWorkerEnvironment(emptyRoot, empty);
  const emptyResult = await adapter.execute({ ...emptyEnvironment, name: `kivro-job-${empty.attemptId}`, owner: empty.workerId, attemptId: empty.attemptId, imageId, limits: empty.permissions.limits }, empty, async request => {
    assert.equal((request.tools as unknown[] | undefined)?.length ?? 0, 0, 'Empty allowlist must not expose any tool');
    return { id: 'empty-test', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'test-model', choices: [{ index: 0, message: { role: 'assistant', content: emptyContent }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } };
  }, new AbortController().signal, async () => {});
  assert.equal(emptyResult.text, emptyContent); assert.equal(emptyResult.files.length, 0);
  assert.deepEqual(projectResult(empty, emptyResult, []).fields, { summary: marker, structured: { marker } });
  const cancelled = fixtureOffer(), cancelRoot = join(root, 'cancel'); await mkdir(cancelRoot);
  const cancelEnvironment = await adapter.buildWorkerEnvironment(cancelRoot, cancelled), controller = new AbortController();
  const cancelSpec = { ...cancelEnvironment, name: `kivro-job-${cancelled.attemptId}`, owner: cancelled.workerId, attemptId: cancelled.attemptId, imageId, limits: cancelled.permissions.limits };
  const deadline = setTimeout(() => controller.abort(), 90000);
  try {
    await assert.rejects(adapter.execute(cancelSpec, cancelled, async () => {
      await docker.pause(cancelSpec); await docker.resume(cancelSpec); controller.abort(); throw new Error('CANCELLED');
    }, controller.signal, async () => {}), /CANCELLED/);
    assert.equal(await docker.owned(cancelSpec), false, 'Cancellation must reap the entire container');
  } finally { clearTimeout(deadline); await docker.remove(cancelSpec); }
  process.stdout.write(JSON.stringify({ passed: true, realOpenClaw: '2026.8.2', inference: 'DETERMINISTIC_TEST_ONLY', network: 'NONE', checks: ['production-inference-broker', 'plugin-loaded', 'resource-broker-read', 'ssh-workspace-write', 'result-only-collection', 'named-output-asset-mapping', 'unique-marker-integrity', 'empty-tool-allowlist', 'process-tree-pause-resume-cancel'] }) + '\n');
} finally { provider?.closeAllConnections(); provider?.close(); tools?.cancel(); await tools?.pause(); state.close(); await rm(root, { recursive: true, force: true }); if (oldMasterKey === undefined) delete process.env.KIVRO_WORKER_MASTER_KEY; else process.env.KIVRO_WORKER_MASTER_KEY = oldMasterKey; }
