import { describe, expect, it } from 'vitest';
import { executionManifestHash, type Dependency, type IOContract, type PermissionManifest } from '@kivro/contracts';
import type { CapabilityVersion, Review } from '@kivro/database';
import { exampleValidationIssues, requireDiffReview, versionDiff } from '../src/capability-lifecycle.js';
import { reviewHash, reviewStatus } from '../src/catalog-reviews.js';

const contract: IOContract = { schemaVersion: 1, inputs: [{ key: 'text', label: 'Text', type: 'LONG_TEXT', required: true, order: 0 }], output: { type: 'TEXT', description: 'Summary', required: true } };
const permissions: PermissionManifest = { schemaVersion: 1, tools: ['read'], network: { mode: 'NONE', allowedDomains: [] }, resources: [],
  inference: { provider: 'openai-compatible', model: 'fixture', credentialRef: 'dedicated-ref' },
  limits: { timeoutSeconds: 300, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 1048576, maxOutputBytes: 1048576, maxTokens: 10000 } };
const dependencies: Dependency[] = [{ id: 'inference', name: 'Inference', type: 'INFERENCE', required: true, approved: true, healthy: true, supported: true,
  confidence: 'DECLARED', grants: { inferenceProviders: ['openai-compatible'], tools: ['read'], credentialRefs: ['dedicated-ref'] } }];
const storedContract = (value: IOContract): CapabilityVersion['ioContract'] => JSON.parse(JSON.stringify(value)) as CapabilityVersion['ioContract'];
function version(overrides: Partial<CapabilityVersion> = {}): CapabilityVersion {
  return { id: '50000000-0000-4000-a000-000000000001', capabilityId: '50000000-0000-4000-a000-000000000000', version: 1,
    title: 'Summary', summary: 'Text summary', description: '', category: 'Writing', tags: [], priceTierId: 'USD_99',
    ioContract: storedContract(contract), permissions, dependencies, internalInstructions: 'Summarize', manifestHash: executionManifestHash({ ioContract: contract, permissions, dependencies, internalInstructions: 'Summarize' }),
    examples: [], estimatedDurationSeconds: 60, createdAt: new Date('2026-01-01'), publishedAt: null, publicationEvidence: null, consentAt: null, testPassedAt: null, ...overrides };
}
const targetId = '50000000-0000-4000-a000-000000000002';
describe('catalog immutable diffs and example checks', () => {
  it('binds review hashes to both frozen definitions, not mutable validation timestamps', () => {
    const from = version(), to = version({ id: targetId, version: 2, title: 'New title' });
    const diff = versionDiff(from, to);
    expect(diff.changes).toEqual([{ path: 'title', category: 'METADATA', before: 'Summary', after: 'New title' }]);
    expect(versionDiff(from, { ...to, testPassedAt: new Date(), publishedAt: new Date(), consentAt: new Date() }).diffHash).toBe(diff.diffHash);
    expect(versionDiff(from, { ...to, internalInstructions: 'Changed instructions' }).diffHash).not.toBe(diff.diffHash);
    expect(() => requireDiffReview(from, to, '0'.repeat(64))).toThrow('Review and explicitly confirm');
    expect(requireDiffReview(from, to, diff.diffHash)).toEqual(diff);
  });
  it('highlights resource, network, credential, dependency and runtime grant expansion', () => {
    const to = version({ id: targetId, permissions: { ...permissions, network: { mode: 'RESEARCH', allowedDomains: ['example.com'] },
      resources: [{ id: 'dataset', type: 'DATASET', access: 'READ_ONLY' }], limits: { ...permissions.limits, maxTokens: 20000 } },
    dependencies: [{ ...dependencies[0]!, grants: { ...dependencies[0]!.grants, credentialRefs: ['new-ref'], tools: ['read', 'write'] } }] });
    const diff = versionDiff(version(), to);
    expect(diff.permissionExpansion).toBe(true);
    expect(diff.warnings).toEqual(expect.arrayContaining([
      { code: 'NEW_NETWORK_ACCESS', path: 'permissions.network' }, { code: 'NEW_PRIVATE_RESOURCE', path: 'permissions.resources' },
      { code: 'PERMISSION_EXPANSION', path: 'permissions.limits' }, { code: 'NEW_CREDENTIAL', path: 'dependencies.inference.grants.credentialRefs' },
      { code: 'PERMISSION_EXPANSION', path: 'dependencies.inference.grants.tools' },
    ]));
    expect(() => requireDiffReview(version(), to)).toThrow('Review and explicitly confirm');
  });
  it('conservatively flags input/output changes and price changes without calling reductions expansions', () => {
    const to = version({ id: targetId, priceTierId: 'USD_299', ioContract: { ...contract, inputs: [], output: { type: 'JSON', description: 'Structured', required: true, jsonSchema: { type: 'object' } } },
      permissions: { ...permissions, tools: [], limits: { ...permissions.limits, maxTokens: 100 } } });
    const diff = versionDiff(version(), to);
    expect(diff.permissionExpansion).toBe(false);
    expect(diff.warnings).toEqual(expect.arrayContaining([
      { code: 'INPUT_CONTRACT_CHANGED', path: 'ioContract.inputs' }, { code: 'OUTPUT_CONTRACT_CHANGED', path: 'ioContract.output' }, { code: 'PRICE_CHANGED', path: 'priceTierId' },
    ]));
  });
  it('validates curated JSON examples, duplicate identifiers and execution manifest provenance', () => {
    const example = { id: 'example', title: 'Example', input: { text: 'Input' }, output: 'Output' };
    expect(exampleValidationIssues(version({ examples: [example] }))).toEqual([]);
    expect(exampleValidationIssues(version({ examples: [example, example] }))).toEqual([{ id: 'example', code: 'EXAMPLE_NEEDS_REVALIDATION' }]);
    const executed = { ...example, source: 'REAL_EXECUTION', provenance: { manifestHash: version().manifestHash } };
    expect(exampleValidationIssues(version({ examples: [executed] }))).toEqual([]);
    expect(exampleValidationIssues(version({ examples: [executed], manifestHash: '0'.repeat(64) }))).toEqual([{ id: 'example', code: 'EXAMPLE_NEEDS_REVALIDATION' }]);
    const jsonContract: IOContract = { ...contract, output: { type: 'JSON', description: 'Structured', required: true, jsonSchema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } }, additionalProperties: false } } };
    expect(exampleValidationIssues(version({ ioContract: storedContract(jsonContract), examples: [{ ...example, output: '{"summary":"Valid"}' }] }))).toEqual([]);
    expect(exampleValidationIssues(version({ ioContract: storedContract(jsonContract), examples: [{ ...example, output: '{}' }] }))).toHaveLength(1);
  });
});

describe('verified review edit policy', () => {
  const createdAt = new Date('2026-01-01T00:00:00Z');
  const review: Review = { id: 'review', jobId: 'job', userId: 'buyer', capabilityId: 'capability', rating: 4, comment: 'Original', createdAt };
  const job = { buyerId: 'buyer', sellerId: 'seller', state: 'SUCCEEDED' as const, paymentState: 'SETTLED' as const, buyerPriceMinor: 99 };
  it('closes edits exactly thirty days after original creation, not after the latest edit', () => {
    const deadline = createdAt.getTime() + 30 * 86400_000;
    expect(reviewStatus(job, review, new Date(deadline - 1)).canEdit).toBe(true);
    expect(reviewStatus(job, review, new Date(deadline))).toMatchObject({ eligible: false, canEdit: false, reason: 'REVIEW_EDIT_WINDOW_CLOSED', policy: { editDeadlineAt: new Date(deadline).toISOString() } });
  });
  it('does not let refunds censor existing reviews or qualify previously unreviewed work', () => {
    const refunded = { ...job, paymentState: 'REFUNDED' as const };
    expect(reviewStatus(refunded, review, createdAt).canEdit).toBe(true);
    expect(reviewStatus(refunded, null, createdAt)).toMatchObject({ eligible: false, canEdit: false, reason: 'JOB_NOT_PAID' });
    expect(reviewStatus({ ...job, buyerPriceMinor: 0 }, null, createdAt).eligible).toBe(false);
  });
  it('binds an edit token to the saved content and original creation time', () => {
    expect(reviewHash({ ...review })).toBe(reviewHash(review));
    expect(reviewHash({ ...review, rating: 1 })).not.toBe(reviewHash(review));
    expect(reviewHash({ ...review, comment: 'Changed' })).not.toBe(reviewHash(review));
    expect(reviewHash({ ...review, createdAt: new Date(createdAt.getTime() + 1) })).not.toBe(reviewHash(review));
  });
});
