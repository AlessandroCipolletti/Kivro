// Opt-in real-runtime acceptance. Only the inference provider is deterministic.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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
import { approveResearchScanner, verifyResearchScanner } from '../../apps/worker/src/research-scanner.ts';
import { JobToolBroker } from '../../apps/worker/src/tools.ts';
import { InferenceBroker, validateInferenceConfig } from '../../apps/worker/src/inference.ts';
import { sandboxSelfTest } from '../../apps/worker/src/readiness.ts';

if (process.env.NODE_ENV === 'production' || process.env.KIVRO_ENV === 'production') throw new Error('SMOKE_PRODUCTION_DENIED');
const scannerPort = Number(process.env.KIVRO_TEST_SCANNER_PORT);
if (!Number.isSafeInteger(scannerPort) || scannerPort < 1 || scannerPort > 65535) throw new Error('KIVRO_TEST_SCANNER_PORT_REQUIRED');
const sources = [
  { id: 'public-csv', url: 'https://people.sc.fsu.edu/~jburkardt/data/csv/addresses.csv', mime: 'text/csv' },
  { id: 'public-pdf', url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', mime: 'application/pdf' },
  { id: 'public-image', url: 'https://www.w3.org/Icons/w3c_home.png', mime: 'image/png' },
];
class DownloadSmokeSandbox extends DockerSandbox {
  startedTrace: { correlationId: string; attemptId: string } | undefined;
  configurationProof: Record<string, unknown> | undefined;
  override async probe(...args: Parameters<DockerSandbox['probe']>) {
    const proof = await super.probe(...args);
    if (args[1] === 'config-test') {
      assert.equal(proof.timingPolicyVersion, 2);
      assert.equal(proof.researchDownloadPolicyVersion, 1);
      this.configurationProof = proof;
    }
    return proof;
  }
  override async execute(...[spec, onFrame, signal, onStarted, diagnostics]: Parameters<DockerSandbox['execute']>) {
    await super.execute(spec, async frame => {
      if (frame && typeof frame === 'object' && 'type' in frame && frame.type === 'started') {
        assert('correlationId' in frame && 'attemptId' in frame);
        assert.equal(frame.correlationId, offer.jobId);
        assert.equal(frame.attemptId, offer.attemptId);
        assert.equal(this.startedTrace, undefined);
        this.startedTrace = { correlationId: offer.jobId, attemptId: offer.attemptId };
      }
      return onFrame(frame);
    }, signal, onStarted, diagnostics);
  }
}
const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-download-smoke-'))), state = new WorkerState(join(root, 'state'));
const docker = new DownloadSmokeSandbox(), adapter = new OpenClawAdapter(docker), abort = new AbortController(), offer = fixtureOffer();
const oldKey = process.env.KIVRO_WORKER_MASTER_KEY; process.env.KIVRO_WORKER_MASTER_KEY = randomBytes(32).toString('hex');
const token = randomBytes(32).toString('hex'), marker = `private-fixture-${randomUUID()}`;
let tools: JobToolBroker | undefined, inference: InferenceBroker | undefined, timer: ReturnType<typeof setTimeout> | undefined, calls = 0, csvPath = '', csvSha = '';
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, `Bearer ${token}`);
    const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { size += chunk.length; assert(size < 2 * 1024 ** 2); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(body.store, false); assert.equal(body.stream, false);
    const schema = body.tools.find((tool: { function: { name: string } }) => tool.function.name === 'research_download').function.parameters;
    assert.deepEqual(schema.required, ['reviewedSourceId']); assert.equal(schema.properties.url, undefined);
    assert.equal(state.get<string[]>(`researchRequests:${offer.jobId}`)!.length, 3);
    for (const source of sources) assert.equal(state.get<{ scan: { verdict: string } }>(`researchFile:${offer.jobId}:${source.id}`)!.scan.verdict, 'CLEAN');
    const messages = JSON.stringify(body.messages);
    if (calls > 0) assert(messages.includes(marker), 'private resource not actually consumed');
    if (calls > 2) assert(messages.includes('John'), 'downloaded CSV was not actually read by OpenClaw');
    if (calls > 3) assert(/read.only|cannot write/i.test(messages), 'protected research input write was not denied');
    const steps = [
      { name: 'resource_read', arguments: JSON.stringify({ resourceId: 'private-canary' }) },
      { name: 'research_download', arguments: JSON.stringify({ reviewedSourceId: 'public-csv' }) },
      { name: 'read', arguments: JSON.stringify({ path: csvPath }) },
      { name: 'write', arguments: JSON.stringify({ path: csvPath, content: 'tampered' }) },
      { name: 'write', arguments: JSON.stringify({ path: 'result/receipt.txt', content: `${marker}\n${csvSha}` }) },
    ];
    const next = steps[calls++]; assert(calls <= 6);
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ id: `fixture-${calls}`, object: 'chat.completion', model: 'test-model', choices: [{ index: 0, message: next ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${calls}`, type: 'function', function: next }] } : { role: 'assistant', content: marker }, finish_reason: next ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'FIXTURE_FAILED'}\n`); response.writeHead(400).end(); }
});
try {
  const imageId = await docker.imageId(process.env.KIVRO_SANDBOX_IMAGE ?? 'kivro-sandbox:2026.8.2-download');
  await sandboxSelfTest(state, docker, imageId); state.set('approvedImageId', imageId);
  const scanner = { schemaVersion: 1, host: '127.0.0.1', port: scannerPort }; approveResearchScanner(state, scanner, hashManifest(scanner));
  await verifyResearchScanner(state);
  process.stdout.write('SR06_PHASE scanner-clean-and-eicar-self-test-passed\n');
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const address = provider.address(); assert(address && typeof address === 'object');
  offer.sellerId = randomUUID(); offer.permissions.tools = ['read', 'write', 'research.download', 'resource.read'];
  offer.permissions.network = { mode: 'RESEARCH', allowedDomains: ['people.sc.fsu.edu', 'www.w3.org'], researchLimits: { maxQueries: 0, maxPages: 3, maxResponseBytes: 500000, maxTotalBytes: 1500000, maxDurationMs: 60000 }, downloads: { schemaVersion: 1, allowedMimeTypes: ['text/csv', 'application/pdf', 'image/png'], maxFiles: 3, maxFileBytes: 500000, maxTotalBytes: 1500000 } };
  offer.permissions.resources = [{ id: 'private-canary', type: 'LOCAL_FILE', access: 'READ_ONLY' }]; offer.permissions.limits.timeoutSeconds = 180; offer.permissions.limits.maxTokens = 200000;
  offer.ioContract.output = { type: 'MIXED', description: 'A receipt and one text artifact.', required: true, files: { allowedExtensions: ['.txt'], allowedMimeTypes: ['text/plain'], maxFiles: 1, maxTotalSizeBytes: 2000 } };
  offer.dependencies.push({ id: 'download-tools', name: 'Reviewed tools', type: 'TOOL', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { tools: offer.permissions.tools } },
    { id: 'resource:private-canary', name: 'Synthetic private resource', type: 'LOCAL_FILE', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { resources: ['private-canary'] } },
    { id: 'fixed-domains', name: 'Fixed public sources', type: 'NETWORK_DESTINATION', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { domains: offer.permissions.network.allowedDomains } });
  offer.manifestHash = executionManifestHash(offer);
  const privatePath = join(root, 'private.txt'); await writeFile(privatePath, marker, { mode: 0o600 });
  const selection = { id: 'private-canary', path: privatePath, sha256: sha256(marker), maxBytes: 1000 }; await approveResource(state, selection, hashManifest(selection));
  const manifest = LocalCapabilitySchema.parse({ capabilityVersionId: offer.capabilityVersionId, ioContract: offer.ioContract, permissions: offer.permissions, dependencies: offer.dependencies, internalInstructions: offer.internalInstructions }); approveCapability(state, manifest, hashManifest(manifest));
  const plan = { schemaVersion: 1, capabilityVersionId: offer.capabilityVersionId, dependencyBindingHash: hashManifest(offer.dependencies), limits: {}, sources: sources.map(source => ({ id: source.id, operation: 'DOWNLOAD', request: { url: source.url, expectedMimeType: source.mime }, provenance: { kind: 'REVIEWED_PUBLIC_LITERAL', sourceUrl: source.url, reviewedBy: offer.sellerId, reviewedAt: new Date().toISOString() } })) };
  const review = approveResearchPlan(state, plan, offer.sellerId); approveResearchPlan(state, plan, offer.sellerId, review.approvalHash);
  const secrets = new SecretStore(state), config = validateInferenceConfig({ provider: 'openai-compatible', model: 'test-model', credentialRef: 'seller-inference', allowLocal: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, maxTokensPerJob: 200000, inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 }); await secrets.put('seller-inference', token);
  state.resume('LOCAL'); state.claim(offer, `kivro-job-${offer.attemptId}`); tools = await JobToolBroker.create(offer, state, secrets, offer.dependencies); inference = new InferenceBroker(config, token, offer.permissions, state, offer.attemptId);
  abort.signal.addEventListener('abort', () => { tools?.cancel(); inference?.cancel(); }, { once: true }); timer = setTimeout(() => abort.abort(new Error('TIMED_OUT')), 180000);
  const jobRoot = join(root, 'job'); await mkdir(jobRoot); await tools.preparePublicResearch(jobRoot); assert.equal(calls, 0); assert.equal(tools.usedResources.size, 0);
  const files = tools.downloadedFiles(); assert.equal(files.length, 3); const csv = files.find(file => file.sourceId === 'public-csv')!; csvPath = csv.path; csvSha = csv.sha256;
  const environment = await adapter.buildWorkerEnvironment(jobRoot, offer, [], tools.researchTools(), files); await tools.installResearchFiles(environment.inputDir);
  const request = JSON.parse(await readFile(join(environment.inputDir, 'request.json'), 'utf8'));
  assert.equal(request.correlationId, offer.jobId); assert.equal(request.attemptId, offer.attemptId);
  for (const file of files) assert.equal(sha256(await readFile(join(environment.inputDir, 'research', file.path.split('/').at(-1)!))), file.sha256);
  process.stdout.write('SR06_PHASE real-public-downloads-validated-scanned-staged\n');
  const spec = { ...environment, name: `kivro-job-${offer.attemptId}`, owner: offer.workerId, attemptId: offer.attemptId, imageId, limits: offer.permissions.limits };
  const result = await adapter.execute(spec, offer, body => inference!.request(body), abort.signal, async () => { state.transition(offer.jobId, 'RUNNING'); }, (name, args) => tools!.execute(name, args));
  assert.deepEqual(docker.startedTrace, { correlationId: offer.jobId, attemptId: offer.attemptId });
  assert.equal(docker.configurationProof?.researchDownloadPolicyVersion, 1);
  assert.equal(state.get<{ imageId: string; version: number }>('sandboxDownloadProof')?.imageId, imageId);
  assert.equal(state.get<{ imageId: string; version: number }>('sandboxDownloadProof')?.version, 1);
  assert.equal(result.text, marker); assert.equal(calls, 6); assert.equal(result.files.length, 1); assert.equal(result.files[0]!.data.toString(), `${marker}\n${csvSha}`); assert.equal(await docker.owned(spec), false);
  for (const file of files) assert.equal(sha256(await readFile(join(environment.inputDir, 'research', file.path.split('/').at(-1)!))), file.sha256);
  await assert.rejects(tools.execute('research.download', { reviewedSourceId: 'public-csv', url: `https://example.com/${marker}` }));
  const ids = state.get<string[]>(`researchRequests:${offer.jobId}`)!; assert.equal(ids.length, 3);
  const receipts = ids.map(id => state.get(`researchRequest:${id}`)); assert(!JSON.stringify(receipts).includes(marker));
  process.stdout.write(`${JSON.stringify({ passed: true, imageId, jobId: offer.jobId, attemptId: offer.attemptId, startedTrace: docker.startedTrace, researchDownloadPolicyVersion: docker.configurationProof.researchDownloadPolicyVersion, realOpenClaw: true, realClamAv: true, realPublicHttps: true, downloads: files.map(file => ({ sourceId: file.sourceId, mimeType: file.mimeType, sizeBytes: file.sizeBytes, sha256: file.sha256 })), provider: 'DETERMINISTIC_TEST_ONLY', sellerAuthority: 'SYNTHETIC', signedApi: false, settlement: false, calls, resultSha256: result.files[0]!.sha256, checks: ['scanner-clean-and-EICAR', 'download-policy-v1-attested', 'canonical-job-and-attempt-trace', 'fixed-public-prefetch-before-inference-private', 'CSV-PDF-PNG-content-validation', 'read-only-protected-workspace', 'private-resource-then-cache-only', 'actual-OpenClaw-file-read', 'write-denied', 'private-derived-URL-denied', 'unchanged-input-hashes', 'result-only-collection', 'container-removed'], usage: inference.usage() })}\n`);
} finally {
  clearTimeout(timer); abort.abort(); await inference?.pause(); await tools?.pause(); provider.closeAllConnections(); provider.close(); state.close(); await rm(root, { recursive: true, force: true });
  if (oldKey === undefined) delete process.env.KIVRO_WORKER_MASTER_KEY; else process.env.KIVRO_WORKER_MASTER_KEY = oldKey;
}
