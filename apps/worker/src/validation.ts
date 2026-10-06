import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, lstat, realpath, open, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { hashManifest, validateInput, MAX_JOB_PAUSE_MS } from '@kivro/contracts';
import { isSellerTestBundle } from '@kivro/contracts/seller-test';
import { FILE_SAFETY_CEILINGS, readFileLimits, type FileLimits } from '@kivro/contracts/file-limits';
import type { AuthorizedJobOffer } from '@kivro/job-protocol';
import { OpenClawAdapter, DockerSandbox, sniffMime, assertWorkerFileContract } from '@kivro/openclaw-adapter';
import { sha256 } from '@kivro/crypto';
import { WorkerState } from './state.ts';
import type { SecretStore } from './secrets.ts';
import { WorkerTransport, type DeviceIdentity } from './transport.ts';
import type { LocalCapability } from './capabilities.ts';
import { checkCapabilityResources } from './capability-health.ts';
import { InferenceBroker, validateInferenceConfig } from './inference.ts';
import { readiness } from './readiness.ts';
import { createResourceBroker } from './resource-config.ts';
import { JobToolBroker } from './tools.ts';
import { selectedConnectors } from './connectors.ts';
import { projectResult } from './results.ts';
import { needsSellerAuthority } from './research-config.ts';
import { observationReport } from './observations.ts';
import { usageReceipt } from './usage.ts';
import { prepareSellerTestBundle, type SellerTestCapability } from './seller-test-bundle.ts';

export async function prepareValidationInput(capability: SellerTestCapability, input: unknown, limits: FileLimits = readFileLimits(process.env)) {
  if (isSellerTestBundle(input)) return prepareSellerTestBundle(capability, input, limits);
  assertWorkerFileContract(capability.ioContract);
  const fixture = z.object({ input: z.record(z.unknown()), assets: z.array(z.object({ id: z.string().uuid(), path: z.string().min(1), filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/), mimeType: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().nonnegative().max(FILE_SAFETY_CEILINGS.workerFileBytes) }).strict()).max(FILE_SAFETY_CEILINGS.maxFiles) }).strict().safeParse(input);
  const selected = fixture.success ? fixture.data.assets : [];
  if (new Set(selected.map(asset => asset.id)).size !== selected.length) throw new Error('DUPLICATE_TEST_ASSET');
  const assets = selected.map(({ path: _path, ...asset }) => asset);
  const values = validateInput(capability.ioContract, fixture.success ? fixture.data.input : input, assets);
  const referenced = new Set(capability.ioContract.inputs.filter(field => ['FILE', 'FILES'].includes(field.type)).flatMap(field => { const value = values[field.key]; return value === undefined ? [] : Array.isArray(value) ? value : [value]; }));
  if (assets.some(asset => !referenced.has(asset.id))) throw new Error('UNDECLARED_TEST_ASSET');
  if (assets.some(asset => asset.sizeBytes > limits.workerFileBytes)) throw new Error('TEST_FILE_LIMIT');
  if (assets.reduce((sum, asset) => sum + asset.sizeBytes, Buffer.byteLength(JSON.stringify(values))) > Math.min(limits.inputBytes, capability.permissions.limits.maxInputBytes)) throw new Error('TEST_INPUT_LIMIT');
  const files = new Map<string, Buffer>();
  for (const selection of selected) {
    const path = resolve(selection.path), stat = await lstat(path);
    if (await realpath(path) !== path || !stat.isFile() || stat.nlink !== 1 || stat.size !== selection.sizeBytes || /(?:^|\/)(?:\.ssh|\.aws|\.gnupg|\.docker|\.openclaw|\.config|\.env(?:\.[^/]*)?|Library)(?:\/|$)/i.test(path)) throw new Error('UNSAFE_TEST_ASSET');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat(); if (before.ino !== stat.ino || before.dev !== stat.dev || before.nlink !== 1) throw new Error('TEST_ASSET_CHANGED');
      const data = Buffer.alloc(stat.size + 1); let offset = 0;
      while (offset < data.length) { const read = await handle.read(data, offset, data.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
      const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1) throw new Error('TEST_ASSET_CHANGED');
      const bytes = data.subarray(0, offset);
      if (offset !== stat.size || sha256(bytes) !== selection.sha256 || sniffMime(bytes, selection.filename) !== selection.mimeType) throw new Error('TEST_ASSET_INTEGRITY_FAILED');
      files.set(selection.id, bytes);
    } finally { await handle.close(); }
  }
  return { values, assets, files };
}

/** Explicit seller test, with real inference and isolation, but no purchase,
 * asset upload or settlement. Buyer jobs only enter through signed notices. */
export async function testCapability(state: WorkerState, secrets: SecretStore, versionId: string, input: unknown, image: string, development: boolean): Promise<unknown> {
  const capability = state.get<LocalCapability>(`capability:${versionId}`);
  if (!capability) throw new Error('CAPABILITY_NOT_APPROVED');
  const { values, assets, files } = await prepareValidationInput(capability, input);
  const owner = randomUUID(); state.acquireLease(owner);
  const timer = setInterval(() => { try { state.heartbeatLease(owner); } catch { cancel(); } }, 1000);
  const docker = new DockerSandbox(), abort = new AbortController();
  let root: string | undefined, testState: WorkerState | undefined, inference: InferenceBroker | undefined, tools: JobToolBroker | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { abort.abort(); inference?.cancel(); tools?.cancel(); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const report = await readiness(state, secrets, docker, image, true, development);
    if (!report.ready || !report.imageId) throw new Error('CAPABILITY_TEST_NOT_READY');
    await checkCapabilityResources(state, secrets, capability);
    const identity = state.get<DeviceIdentity>('identity')!;
    const transport = new WorkerTransport(identity.apiUrl, identity, await secrets.get('device-identity'), development);
    const sellerId = needsSellerAuthority(capability.permissions) ? (await transport.diagnostics()).sellerId : undefined;
    if (needsSellerAuthority(capability.permissions) && !sellerId) throw new Error('AUTHENTICATED_SELLER_REQUIRED');
    const heartbeat = () => transport.heartbeat({ version: '0.1.0', openclawVersion: report.openclawVersion, sandboxReady: true, paused: state.paused(), capabilities: [], runningJobIds: [], health: { ready: true, inference: 'READY', capacity: 1, policyVersion: 1 } });
    const commands = await heartbeat(); for (const command of commands.commands) state.command({ ...command, source: 'REMOTE' });
    const config = validateInferenceConfig(state.get('inference'));
    const offer: AuthorizedJobOffer = { ...capability, maxPauseMs: MAX_JOB_PAUSE_MS, protocolVersion: 1, workerId: identity.workerId, sellerId, jobId: randomUUID(), attemptId: randomUUID(), expiresAt: new Date(Date.now() + 300000).toISOString(), nonce: randomUUID(), paymentSecured: true, input: values, assets };
    root = await mkdtemp(join(state.root, 'validation-')); testState = new WorkerState(join(root, 'state'));
    testState.resume('LOCAL'); testState.claim(offer, `kivro-job-${offer.attemptId}`);
    for (const connector of selectedConnectors(state, capability.permissions, capability.dependencies)) testState.set(`connector:${connector.id}`, connector);
    const resourceBroker = createResourceBroker(state, secrets, capability);
    tools = await JobToolBroker.create(offer, testState, secrets, capability.dependencies, resourceBroker, state);
    inference = new InferenceBroker(config, await secrets.get(config.credentialRef), offer.permissions, state, offer.attemptId);
    deadline = setTimeout(() => { cancel(); }, Math.max(0, testState.attempt(offer.jobId)!.deadline - Date.now()));
    const adapter = new OpenClawAdapter(docker), jobRoot = join(root, 'job'); await mkdir(jobRoot);
    await tools.preparePublicResearch(jobRoot);
    const skills = state.get<import('@kivro/openclaw-adapter').SelectedSkill[]>(`skills:${versionId}`) ?? [];
    const environment = await adapter.buildWorkerEnvironment(jobRoot, offer, skills, tools.researchTools(), tools.downloadedFiles());
    await tools.installResearchFiles(environment.inputDir);
    for (const [id, data] of files) await writeFile(join(environment.inputDir, id), data, { mode: 0o444, flag: 'wx' });
    const result = await adapter.execute({ ...environment, owner: identity.workerId, name: `kivro-job-${offer.attemptId}`, attemptId: offer.attemptId, imageId: report.imageId, limits: offer.permissions.limits }, offer, request => inference!.request(request), abort.signal, async () => { testState!.transition(offer.jobId, 'RUNNING'); }, (name, args) => tools!.execute(name, args));
    if (abort.signal.aborted || Date.now() >= testState.attempt(offer.jobId)!.deadline) throw new Error('TIMED_OUT');
    clearTimeout(deadline);
    if (offer.permissions.resources.some(resource => !tools!.usedResources.has(resource.id))) throw new Error('TEST_MUST_EXERCISE_EACH_RESOURCE');
    const output = projectResult(offer, result, result.files.map(file => ({ id: randomUUID(), filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes, sha256: file.sha256 })));
    const observations = observationReport({ offer, imageId: report.imageId, result, skills, resourceOperations: tools.usedResourceOperations, researchState: testState, usage: usageReceipt(state, offer.attemptId) });
    state.set(`observations:${versionId}`, observations); state.delete(`observationReview:${versionId}`);
    if (observations.missingBindings.length) throw new Error('OBSERVED_DEPENDENCIES_NOT_DECLARED');
    const sandbox = state.get<{ imageId: string; policyVersion: number; testedAt: number }>('sandboxProof')!;
    const inferenceProof = state.get<{ hash: string; testedAt: number }>('inferenceProof')!;
    await heartbeat();
    await transport.request('POST', `/api/worker/capabilities/${versionId}/validation`, { manifestHash: capability.manifestHash, passed: true, proof: { sandbox, inference: { configHash: inferenceProof.hash, testedAt: inferenceProof.testedAt } } });
    state.set(`capabilityProof:${versionId}`, { manifestHash: capability.manifestHash, imageId: report.imageId, inferenceHash: hashManifest(config), testedAt: Date.now(), outputHash: hashManifest(output) });
    state.delete(`revalidationRequired:${versionId}`);
    state.audit('CAPABILITY_TEST_PASSED', 'LOCAL', versionId);
    return { passed: true, versionId, manifestHash: capability.manifestHash, generatedFiles: result.files.map(file => ({ path: file.relativePath, sha256: file.sha256, sizeBytes: file.sizeBytes })), usage: inference.usage(), observations, observationReviewHash: hashManifest(observations), grantsChanged: false };
  } catch (error) { state.delete(`capabilityProof:${versionId}`); state.audit('CAPABILITY_TEST_FAILED', 'LOCAL', versionId); throw error; }
  finally {
    cancel(); clearInterval(timer); if (deadline) clearTimeout(deadline);
    try { await tools?.pause(); testState?.close(); if (root) await rm(root, { recursive: true, force: true }); }
    finally { state.releaseLease(owner); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  }
}
