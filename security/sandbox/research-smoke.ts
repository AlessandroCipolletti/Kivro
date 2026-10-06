// Explicit integration fixture only. Production has no synthetic inference path.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionManifestHash, hashManifest } from '../../packages/contracts/src/index.ts';
import { sha256 } from '../../packages/crypto/src/index.ts';
import { DockerSandbox, OpenClawAdapter } from '../../packages/openclaw-adapter/src/index.ts';
import { fixtureOffer } from '../../packages/job-protocol/src/fixtures.ts';
import { WorkerState } from '../../apps/worker/src/state.ts';
import { SecretStore } from '../../apps/worker/src/secrets.ts';
import { approveResource } from '../../apps/worker/src/resources.ts';
import { approveCapability, LocalCapabilitySchema } from '../../apps/worker/src/capabilities.ts';
import { approveResearchPlan } from '../../apps/worker/src/research-config.ts';
import { JobToolBroker } from '../../apps/worker/src/tools.ts';
import { InferenceBroker, validateInferenceConfig } from '../../apps/worker/src/inference.ts';
import { sandboxSelfTest } from '../../apps/worker/src/readiness.ts';
import { observationReport, reviewObservations } from '../../apps/worker/src/observations.ts';
import { usageReceipt } from '../../apps/worker/src/usage.ts';

const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-research-smoke-'))), state = new WorkerState(join(root, 'state'));
const docker = new DockerSandbox(), adapter = new OpenClawAdapter(docker), abort = new AbortController();
const oldKey = process.env.KIVRO_WORKER_MASTER_KEY; process.env.KIVRO_WORKER_MASTER_KEY = randomBytes(32).toString('hex');
let tools: JobToolBroker | undefined, inference: InferenceBroker | undefined, timer: ReturnType<typeof setTimeout> | undefined;
const offer = fixtureOffer(); let calls = 0;
const marker = `synthetic-private-resource-${randomUUID()}`;
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, 'Bearer research-smoke-dedicated-fixture');
    const parts: Buffer[] = []; let bytes = 0; for await (const chunk of request) { bytes += chunk.length; assert(bytes < 2 * 1024 ** 2); parts.push(chunk); }
    const body = JSON.parse(Buffer.concat(parts).toString());
    const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name);
    assert.deepEqual([...names].sort(), ['research_fetch', 'resource_read']);
    const schema = body.tools.find((tool: { function: { name: string } }) => tool.function.name === 'research_fetch').function.parameters;
    assert.deepEqual(schema.required, ['reviewedSourceId']); assert.deepEqual(schema.properties.reviewedSourceId.enum, ['public-example']);
    assert.equal(schema.properties.url, undefined); assert.equal(schema.properties.query, undefined);
    assert.equal(state.get<{ pages: number }>(`research:${offer.jobId}`)?.pages, 1);
    if (calls > 0) assert(JSON.stringify(body.messages).includes(marker), 'private resource was not actually read');
    if (calls > 1) assert(JSON.stringify(body.messages).includes('Example Domain'), 'real prefetched public content missing');
    const steps = [{ name: 'resource_read', arguments: JSON.stringify({ resourceId: 'private-canary' }) }, { name: 'research_fetch', arguments: JSON.stringify({ reviewedSourceId: 'public-example' }) }];
    const next = steps[calls++]; assert(calls <= 3);
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ id: `fixture-${calls}`, object: 'chat.completion', model: 'test-model', choices: [{ index: 0,
      message: next ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${calls}`, type: 'function', function: next }] } : { role: 'assistant', content: marker }, finish_reason: next ? 'tool_calls' : 'stop',
    }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }));
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'FIXTURE_ERROR'}\n`); response.writeHead(400).end(); }
});
try {
  const imageId = await docker.imageId(process.env.KIVRO_SANDBOX_IMAGE ?? 'kivro-sandbox:2026.8.2-research-observed');
  await sandboxSelfTest(state, docker, imageId); state.set('approvedImageId', imageId);
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); assert(address && typeof address === 'object');
  // The authenticated seller scope is synthetic in this library fixture. The
  // actual CLI obtains it from signed-in device diagnostics; never from a model.
  offer.sellerId = randomUUID(); offer.permissions.tools = ['research.fetch', 'resource.read'];
  offer.permissions.network = { mode: 'RESEARCH', allowedDomains: ['example.com'], researchLimits: { maxQueries: 0, maxPages: 1, maxResponseBytes: 50000, maxTotalBytes: 50000, maxDurationMs: 10000 } };
  offer.permissions.resources = [{ id: 'private-canary', type: 'LOCAL_FILE', access: 'READ_ONLY' }]; offer.permissions.limits.timeoutSeconds = 120; offer.permissions.limits.maxTokens = 128000;
  offer.dependencies.push(
    { id: 'tools', name: 'Reviewed tools', type: 'TOOL', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { tools: offer.permissions.tools } },
    { id: 'resource:private-canary', name: 'Private canary', type: 'LOCAL_FILE', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { resources: ['private-canary'] } },
    { id: 'public-domain', name: 'example.com', type: 'NETWORK_DESTINATION', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { domains: ['example.com'] } },
  );
  offer.manifestHash = executionManifestHash(offer);
  const source = join(root, 'private.txt'); await writeFile(source, marker, { mode: 0o600 });
  const selection = { id: 'private-canary', path: source, sha256: sha256(marker), maxBytes: 1000 }; await approveResource(state, selection, hashManifest(selection));
  const manifest = LocalCapabilitySchema.parse({ capabilityVersionId: offer.capabilityVersionId, ioContract: offer.ioContract, permissions: offer.permissions, dependencies: offer.dependencies, internalInstructions: offer.internalInstructions });
  approveCapability(state, manifest, hashManifest(manifest));
  const plan = { schemaVersion: 1, capabilityVersionId: offer.capabilityVersionId, dependencyBindingHash: hashManifest(offer.dependencies), limits: {}, sources: [{ id: 'public-example', operation: 'FETCH', request: { url: 'https://example.com/', method: 'GET' }, provenance: { kind: 'REVIEWED_PUBLIC_LITERAL', sourceUrl: 'https://example.com/', reviewedBy: offer.sellerId, reviewedAt: new Date().toISOString() } }] };
  const review = approveResearchPlan(state, plan, offer.sellerId); approveResearchPlan(state, plan, offer.sellerId, review.approvalHash);
  const secrets = new SecretStore(state), config = validateInferenceConfig({ provider: 'openai-compatible', model: 'test-model', credentialRef: 'seller-inference', allowLocal: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, maxTokensPerJob: 128000, inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 });
  await secrets.put('seller-inference', 'research-smoke-dedicated-fixture');
  state.resume('LOCAL'); state.claim(offer, `kivro-job-${offer.attemptId}`);
  tools = await JobToolBroker.create(offer, state, secrets, offer.dependencies); inference = new InferenceBroker(config, await secrets.get('seller-inference'), offer.permissions, state, offer.attemptId);
  abort.signal.addEventListener('abort', () => { tools?.cancel(); inference?.cancel(); }, { once: true }); timer = setTimeout(() => abort.abort(new Error('TIMED_OUT')), 120000);
  await tools.preparePublicResearch(); assert.equal(calls, 0); assert.equal(tools.usedResources.size, 0);
  const job = join(root, 'job'); await mkdir(job); const environment = await adapter.buildWorkerEnvironment(job, offer, [], tools.researchTools());
  const spec = { ...environment, name: `kivro-job-${offer.attemptId}`, attemptId: offer.attemptId, owner: offer.workerId, imageId, limits: offer.permissions.limits };
  const result = await adapter.execute(spec, offer, body => inference!.request(body), abort.signal, async () => { state.transition(offer.jobId, 'RUNNING'); }, (name, args) => tools!.execute(name, args));
  assert.equal(result.text, marker); assert.equal(calls, 3); assert.equal(await docker.owned(spec), false);
  assert.deepEqual(result.observations, [{ name: 'resource.read', outcome: 'SUCCEEDED' }, { name: 'research.fetch', outcome: 'SUCCEEDED' }]);
  const observations = observationReport({ offer, imageId, result, skills: [], resourceOperations: tools.usedResourceOperations, researchState: state, usage: usageReceipt(state, offer.attemptId) });
  assert.deepEqual(observations.missingBindings, []); assert(!JSON.stringify(observations).includes(marker)); state.set(`observations:${offer.capabilityVersionId}`, observations);
  const observationReview = reviewObservations(state, offer.capabilityVersionId); assert.equal(observationReview.reviewed, false);
  assert.equal(reviewObservations(state, offer.capabilityVersionId, observationReview.approvalHash).reviewed, true);
  const ids = state.get<string[]>(`researchRequests:${offer.jobId}`)!; assert.equal(ids.length, 1);
  const receipt = state.get<{ actualBytes: number; responseSha256: string; status: number }>(`researchRequest:${ids[0]}`)!;
  assert(receipt.actualBytes > 0); assert.match(receipt.responseSha256, /^[a-f0-9]{64}$/); assert.equal(receipt.status, 200);
  await assert.rejects(tools.execute('research.fetch', { url: 'https://example.com/?private=canary' }));
  assert.equal(state.get<string[]>(`researchRequests:${offer.jobId}`)!.length, 1);
  process.stdout.write(`${JSON.stringify({ passed: true, imageId, inference: 'DETERMINISTIC_TEST_ONLY', sellerIdentity: 'SYNTHETIC_FIXTURE', realOpenClaw: '2026.8.2', network: 'NONE', publicFetch: { host: 'example.com', requests: 1, bytes: receipt.actualBytes, sha256: receipt.responseSha256 }, checks: ['image-isolation-probes', 'actual-reviewed-plugin-schema', 'prefetch-before-inference', 'actual-private-resource-read', 'cache-after-private-access', 'arbitrary-url-denied', 'sanitized-receipt', 'actual-tool-observations', 'explicit-observation-review', 'container-cleanup'], usage: inference.usage() })}\n`);
} finally {
  clearTimeout(timer); abort.abort(); await inference?.pause(); await tools?.pause(); provider.closeAllConnections(); provider.close();
  state.close(); await rm(root, { recursive: true, force: true }); if (oldKey === undefined) delete process.env.KIVRO_WORKER_MASTER_KEY; else process.env.KIVRO_WORKER_MASTER_KEY = oldKey;
}
