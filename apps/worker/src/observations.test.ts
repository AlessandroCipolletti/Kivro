import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionManifestHash, hashManifest, type WorkerUsageReceipt } from '@kivro/contracts';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { WorkerState } from './state.ts';
import { ObservationReportSchema, observationReport, reviewObservations } from './observations.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-observations-'))), state = new WorkerState(root), offer = fixtureOffer();
  cleanups.push(async () => { state.close(); await rm(root, { recursive: true, force: true }); });
  offer.permissions.tools = ['read', 'resource.query', 'blender.render'];
  offer.dependencies.push({ id: 'reviewed-tools', name: 'Reviewed tools', type: 'TOOL', required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { tools: offer.permissions.tools, resources: ['company-db'], domains: ['example.com'] } });
  offer.manifestHash = executionManifestHash(offer);
  const imageId = `sha256:${'a'.repeat(64)}`, usage: WorkerUsageReceipt = { attemptId: offer.attemptId, provider: 'openai-compatible', model: 'test-model', attemptedCalls: 2, successfulCalls: 1, unpricedCalls: 1, inputTokens: 30, outputTokens: 10, estimatedCostMicroUsd: 40, reservedCostMicroUsd: 400, costBasis: 'WORKER_CONFIGURED_RATES' };
  state.set(`capability:${offer.capabilityVersionId}`, offer); state.set('approvedImageId', imageId);
  const input = { offer, imageId, result: { text: 'private result never included', files: [], observations: [{ name: 'read', outcome: 'SUCCEEDED' as const }, { name: 'read', outcome: 'FAILED' as const }, { name: 'resource.query', outcome: 'SUCCEEDED' as const }, { name: 'blender.render', outcome: 'SUCCEEDED' as const }] }, skills: [{ name: 'reviewed-skill', content: 'private skill body never included', sha256: 'b'.repeat(64) }], resourceOperations: new Map([['company-db', new Set(['quarterly_sales'])]]), researchState: state, usage };
  const requestId = randomUUID(); state.set(`researchRequests:${offer.jobId}`, [requestId]);
  state.set(`researchRequest:${requestId}`, { context: { attemptId: offer.attemptId }, host: 'example.com', operation: 'FETCH', ok: true, actualBytes: 123, responseSha256: 'c'.repeat(64), privateCanary: 'not copied', url: 'https://example.com/private-canary' });
  return { state, offer, input };
}
describe('seller-test observed dependency provenance', () => {
  it('records only actual bounded metadata and labels loaded skills without claiming invocation', async () => {
    const { input } = await fixture(), report = observationReport(input), serialized = JSON.stringify(report);
    expect(report).toMatchObject({ toolInstrumentation: 'OPENCLAW_CLI_AND_REVIEWED_PLUGIN', missingBindings: [], tools: expect.arrayContaining([{ name: 'read', succeeded: 1, failed: 1, observedWithoutOutcome: false }]), executables: [{ name: 'blender', viaTool: 'blender.render', provenance: 'PINNED_IMAGE_WRAPPER' }], resources: [{ id: 'company-db', operations: ['quarterly_sales'], evidence: 'HOST_BROKER_COMPLETED' }], skills: [{ name: 'reviewed-skill', sha256: 'b'.repeat(64), evidence: 'LOADED_NOT_PROVEN_INVOKED' }], inference: { unpricedCalls: 1 } });
    expect(serialized).not.toMatch(/private result|private skill|private-canary|not copied|https:\/\//);
    expect(report.network).toEqual([{ host: 'example.com', operation: 'FETCH', succeeded: true, actualBytes: 123, responseSha256: 'c'.repeat(64) }]);
  });
  it('requires review of the exact report without silently changing the manifest or permissions', async () => {
    const { state, offer, input } = await fixture(), report = observationReport(input), before = state.get(`capability:${offer.capabilityVersionId}`);
    state.set(`observations:${offer.capabilityVersionId}`, report);
    expect(reviewObservations(state, offer.capabilityVersionId)).toMatchObject({ reviewed: false, grantsChanged: false, approvalHash: hashManifest(report) });
    expect(state.get(`observationReview:${offer.capabilityVersionId}`)).toBeUndefined();
    expect(reviewObservations(state, offer.capabilityVersionId, hashManifest(report))).toMatchObject({ reviewed: true, grantsChanged: false });
    expect(state.get(`capability:${offer.capabilityVersionId}`)).toEqual(before);
    state.set(`observations:${offer.capabilityVersionId}`, { ...report, testedAt: new Date(Date.now() + 1).toISOString() });
    expect(reviewObservations(state, offer.capabilityVersionId, hashManifest(report)).reviewed).toBe(false);
  });
  it('cannot grant observed undeclared dependencies by reviewing them', async () => {
    const { state, offer, input } = await fixture(); offer.dependencies = [];
    const report = observationReport(input); state.set(`observations:${offer.capabilityVersionId}`, report);
    expect(report.missingBindings).toEqual(['domain:example.com', 'inference:openai-compatible', 'resource:company-db', 'tool:blender.render', 'tool:read', 'tool:resource.query']);
    expect(() => reviewObservations(state, offer.capabilityVersionId, hashManifest(report))).toThrow('OBSERVED_DEPENDENCIES_REQUIRE_NEW_MANIFEST');
    expect(state.get(`observationReview:${offer.capabilityVersionId}`)).toBeUndefined();
  });
  it.each(['image', 'manifest'])('invalidates review when the approved %s changes', async boundary => {
    const { state, offer, input } = await fixture(), report = observationReport(input); state.set(`observations:${offer.capabilityVersionId}`, report);
    if (boundary === 'image') state.set('approvedImageId', `sha256:${'d'.repeat(64)}`);
    else state.set(`capability:${offer.capabilityVersionId}`, { ...offer, manifestHash: 'e'.repeat(64) });
    expect(() => reviewObservations(state, offer.capabilityVersionId, hashManifest(report))).toThrow('OBSERVATION_BINDING_CHANGED');
  });
  it('distinguishes unavailable instrumentation and rejects unexpected tool names or raw payload fields', async () => {
    const { input } = await fixture();
    expect(observationReport({ ...input, result: { text: '', files: [] } }).toolInstrumentation).toBe('UNAVAILABLE');
    expect(() => observationReport({ ...input, result: { text: '', files: [], observations: [{ name: 'exec', outcome: 'SUCCEEDED' }] } })).toThrow('UNDECLARED_TOOL_OBSERVATION');
    expect(() => ObservationReportSchema.parse({ ...observationReport(input), arguments: 'private canary' })).toThrow();
  });
});
