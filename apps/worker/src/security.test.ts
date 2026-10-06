import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashManifest, executionFileCompatibilityIssues } from '@kivro/contracts';
import { sha256 } from '@kivro/crypto';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { WorkerState } from './state.ts';
import { SecretStore } from './secrets.ts';
import { approveResource } from './resources.ts';
import { createResourceBroker, resourceGrantsForApproval } from './resource-config.ts';
import { JobToolBroker } from './tools.ts';
import { InferenceBroker, validateInferenceConfig } from './inference.ts';
import * as http from './http.ts';
import { prepareValidationInput } from './validation.ts';
import { projectResult } from './results.ts';
import { approveCapability, LocalCapabilitySchema } from './capabilities.ts';
import { assertCapabilityConsent } from './capability-health.ts';
import { workerStatus, sandboxSelfTest } from './readiness.ts';
import { DockerSandbox } from '@kivro/openclaw-adapter';

afterEach(() => vi.restoreAllMocks());
async function localState() { const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-security-'))); return { root, state: new WorkerState(join(root, 'state')) }; }
describe('host broker boundaries', () => {
  it.each([undefined, 1, 2])('requires current image timing attestation, version=%s', async timingPolicyVersion => {
    const { root, state } = await localState(), docker = new DockerSandbox(), imageId = `sha256:${'a'.repeat(64)}`;
    const probe = vi.spyOn(docker, 'probe').mockImplementation(async (_id, mode) => ({ type: mode, ok: true, ...(mode === 'config-test' ? { timingPolicyVersion } : {}) }));
    try {
      if (timingPolicyVersion === 2) {
        await sandboxSelfTest(state, docker, imageId); expect(state.get('sandboxTimingProof')).toMatchObject({ imageId, version: 2 }); expect(probe).toHaveBeenCalledTimes(4);
        expect(Object.keys(state.get<object>('sandboxProof')!).sort()).toEqual(['imageId', 'policyVersion', 'testedAt']);
      } else {
        await expect(sandboxSelfTest(state, docker, imageId)).rejects.toThrow('SANDBOX_TIMING_UPDATE_REQUIRED');
        expect(state.get('sandboxTimingProof')).toBeUndefined(); expect(state.get('sandboxProof')).toBeUndefined();
      }
    } finally { state.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('reports startup blockers without leaking diagnostic content or weakening readiness', () => {
    const status = workerStatus({ ready: false, sandboxReady: true, checkedAt: new Date().toISOString(), openclawVersion: 'OpenClaw 2026.8.2 (0965053)', checks: [{ id: 'inference', status: 'FAIL', code: 'INFERENCE_CONFIG_REQUIRED' }, { id: 'sandbox', status: 'FAIL', code: 'private path or secret output', action: 'do not log me' }] }, true);
    expect(status).toMatchObject({ ready: false, paused: true, inference: 'INFERENCE_CONFIG_REQUIRED', next: 'pnpm worker doctor' });
    expect(status.blockers).toContainEqual({ check: 'sandbox', code: 'CHECK_FAILED' });
    expect(JSON.stringify(status)).not.toMatch(/secret|private path|do not log/);
  });
  it.each([
    ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['.glb', 'model/gltf-binary'],
  ])('rejects advertised unsupported %s contracts before approval or test execution', async (extension, mimeType) => {
    const { root, state } = await localState();
    try {
      const offer = fixtureOffer();
      offer.ioContract.inputs = [{ key: 'source', label: 'Source', type: 'FILE', required: true, order: 0, constraints: { allowedExtensions: ['.pdf', extension], allowedMimeTypes: ['application/pdf', mimeType], maxFileSizeBytes: 1000 } }];
      const manifest = LocalCapabilitySchema.parse({ capabilityVersionId: offer.capabilityVersionId, ioContract: offer.ioContract, permissions: offer.permissions, internalInstructions: offer.internalInstructions, dependencies: offer.dependencies });
      expect(() => approveCapability(state, manifest, hashManifest(manifest))).toThrow('UNSUPPORTED_FILE_CONTRACT');
      expect(state.get(`capability:${offer.capabilityVersionId}`)).toBeUndefined();
      await expect(prepareValidationInput(offer, {})).rejects.toThrow('UNSUPPORTED_FILE_CONTRACT');
      expect(() => assertCapabilityConsent(state, { ...manifest, manifestHash: offer.manifestHash, consentHash: '', skillsHash: '', approvedAt: '' })).toThrow('UNSUPPORTED_FILE_CONTRACT');
    } finally { state.close(); await rm(root, { recursive: true, force: true }); }
  });
  it.each([
    ['.webp', 'image/webp'], ['.mov', 'video/quicktime'], ['.webm', 'video/webm'], ['.mp3', 'audio/mpeg'],
    ['.m4a', 'audio/mp4'], ['.obj', 'model/obj'], ['.fbx', 'application/vnd.autodesk.fbx'],
  ])('accepts the validated %s advertised contract (binary validators tested by the media owner)', (extension, mimeType) => {
    const offer = fixtureOffer();
    offer.ioContract.inputs = [{ key: 'source', label: 'Source', type: 'FILE', required: true, order: 0, constraints: { allowedExtensions: [extension], allowedMimeTypes: [mimeType], maxFileSizeBytes: 1000 } }];
    expect(executionFileCompatibilityIssues(offer.ioContract)).toEqual([]);
  });
  it.each(['TEXT', 'JSON'] as const)('projects named scalar and JSON fields without granting write: %s', type => {
    const offer = fixtureOffer();
    offer.ioContract.output = { type, required: true, description: 'Named output', ...(type === 'JSON' ? { jsonSchema: { type: 'boolean' } } : {}), fields: [
      { key: 'summary', label: 'Summary', type: 'SHORT_TEXT', required: true, order: 0 },
      { key: 'data', label: 'Data', type: 'JSON', required: true, order: 1, constraints: { jsonSchema: { type: 'boolean' } } },
    ] };
    const output = { ...(type === 'TEXT' ? { text: 'Done' } : { json: true }), fields: { summary: 'Done', data: true } };
    expect(projectResult(offer, { text: JSON.stringify(output), files: [] }, [])).toEqual(output);
    expect(() => projectResult(offer, { text: `Explanation: ${JSON.stringify(output)}`, files: [] }, [])).toThrow();
    expect(() => projectResult(offer, { text: JSON.stringify({ ...output, fields: { summary: 'Done' } }), files: [] }, [])).toThrow();
    expect(offer.permissions.tools).toEqual([]);
  });
  it.each(['FILE', 'FILES'] as const)('validates required %s seller test selections and rejects unsafe content', async type => {
    const { root, state } = await localState();
    try {
      const offer = fixtureOffer(), id = randomUUID(), path = join(root, 'test.txt'); await writeFile(path, 'test input');
      offer.ioContract.inputs = [{ key: 'source', label: 'Source', type, required: true, order: 0, constraints: { allowedMimeTypes: ['text/plain'], allowedExtensions: ['.txt'], maxFileSizeBytes: 100 } }];
      const asset = { id, path, filename: 'test.txt', mimeType: 'text/plain', sha256: sha256('test input'), sizeBytes: 10 };
      const input = { source: type === 'FILE' ? id : [id] };
      const result = await prepareValidationInput(offer, { input, assets: [asset] });
      expect(result.values).toEqual(input); expect(result.assets[0]).not.toHaveProperty('path'); expect(result.files.get(id)?.toString()).toBe('test input');
      await expect(prepareValidationInput(offer, input)).rejects.toThrow();
      await expect(prepareValidationInput(offer, { input, assets: [{ ...asset, sha256: '0'.repeat(64) }] })).rejects.toThrow('INTEGRITY');
      await expect(prepareValidationInput(offer, { input, assets: [asset, asset] })).rejects.toThrow('DUPLICATE');
      const linked = join(root, 'linked.txt'); await symlink(path, linked);
      await expect(prepareValidationInput(offer, { input, assets: [{ ...asset, path: linked }] })).rejects.toThrow('UNSAFE');
      await writeFile(path, '<script>x</script>');
      await expect(prepareValidationInput(offer, { input, assets: [{ ...asset, sha256: sha256('<script>x</script>'), sizeBytes: 18 }] })).rejects.toThrow();
    } finally { state.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('requires stored capability-scoped resource grants and detects changed snapshots', async () => {
    const { root, state } = await localState();
    try {
      const offer = fixtureOffer(), source = join(root, 'public.txt'); await writeFile(source, 'approved');
      const selection = { id: 'document', path: source, sha256: sha256('approved'), maxBytes: 1000 };
      await approveResource(state, selection, hashManifest(selection));
      offer.permissions.resources = [{ id: 'document', type: 'LOCAL_FILE', access: 'READ_ONLY' }];
      offer.dependencies.push({ id: 'resource:document', name: 'document', type: 'LOCAL_FILE', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { resources: ['document'] } });
      expect(() => createResourceBroker(state, new SecretStore(state), offer)).toThrow();
      state.set(`resourceGrants:${offer.capabilityVersionId}`, resourceGrantsForApproval(state, offer.permissions));
      const broker = createResourceBroker(state, new SecretStore(state), offer);
      const request = { jobId: offer.jobId, resourceId: 'document', operation: 'read', input: { selectionId: 'document' }, permissions: offer.permissions, dependencies: offer.dependencies };
      expect((await broker.execute(request)).metadata.dataClasses).toEqual(['SELLER_PRIVATE']);
      await expect(broker.execute({ ...request, input: { selectionId: '../../secret' } })).rejects.toThrow();
      const file = join(state.root, 'resources', 'document'); await chmod(file, 0o600); await writeFile(file, 'tampered'); await chmod(file, 0o400);
      await expect(broker.execute(request)).rejects.toThrow(); broker.close();
      await expect(broker.execute(request)).rejects.toThrow('BROKER_CLOSED');
    } finally { state.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('denies network egress for private jobs and refuses paused tools', async () => {
    const { root, state } = await localState();
    try {
      const offer = fixtureOffer(); offer.permissions.tools = ['research.fetch']; offer.permissions.network = { mode: 'RESEARCH', allowedDomains: ['example.com'] };
      offer.sellerId = randomUUID();
      state.resume('LOCAL'); state.claim(offer, 'fixture'); state.transition(offer.jobId, 'RUNNING');
      expect(() => new JobToolBroker(offer, state, offer.dependencies)).toThrow('REVIEWED_PUBLIC_RESEARCH_PLAN_REQUIRED');
      offer.ioContract.inputs[0]!.constraints = { semanticType: 'PUBLIC' };
      const tools = new JobToolBroker(offer, state, offer.dependencies);
      await tools.pause(); await expect(tools.execute('research.fetch', { url: 'https://example.com/' })).rejects.toThrow('PAUSED');
      tools.cancel(); expect(() => tools.resume()).toThrow('CANCELLED');
    } finally { state.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('never accepts model-selected providers, arbitrary tools, redirects or budget overruns', async () => {
    const { root, state } = await localState();
    try {
      const offer = fixtureOffer();
      const config = validateInferenceConfig({ provider: 'openai-compatible', model: 'test-model', baseUrl: 'https://example.com/v1', credentialRef: 'seller-inference', maxCallsPerJob: 1, inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 });
      const broker = new InferenceBroker(config, 'dedicated-test-secret', offer.permissions, state, offer.attemptId);
      const request = { model: config.model, messages: [{ role: 'user', content: 'hello' }], max_tokens: 8 };
      const transport = vi.spyOn(http, 'boundedRequest').mockResolvedValue({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ id: 'test', model: config.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })) });
      await expect(broker.request({ ...request, model: 'unapproved' })).rejects.toThrow('MODEL_DENIED');
      await expect(broker.request({ ...request, tools: [{ type: 'function', function: { name: 'exec', parameters: {} } }] })).rejects.toThrow('TOOL_DENIED');
      await expect(broker.request({ ...request, base_url: 'http://127.0.0.1' })).rejects.toThrow();
      expect(transport).not.toHaveBeenCalled(); await broker.request(request);
      expect(transport).toHaveBeenCalledOnce(); await expect(broker.request(request)).rejects.toThrow('CALL_LIMIT');
      expect(state.get(`budget:${new Date().toISOString().slice(0, 10)}`)).toBeTruthy();
      broker.cancel(); await expect(broker.request(request)).rejects.toThrow('PAUSED');
      expect(() => validateInferenceConfig({ ...config, baseUrl: 'http://example.com/v1' })).toThrow();
      expect(() => validateInferenceConfig({ ...config, baseUrl: 'http://localhost:11434/v1', allowLocal: true })).toThrow();
    } finally { state.close(); await rm(root, { recursive: true, force: true }); }
  });
});
