import { randomUUID } from 'node:crypto';
import type { AssetDTO, CapabilityDTO, IOContract } from '@kivro/contracts';
import { describe, expect, it, vi } from 'vitest';
import { AgentChatBodySchema, MarketplaceAgent } from '../src/agent.js';
import { InferenceProfileSchema, PlatformInferenceRouter, type PlatformInferenceRequest } from '../src/inference.js';
import { capabilityDefinitionHash, planApprovalHash, validatePlan } from '../src/orchestration.js';
import { candidateViolation } from '../src/policy.js';
import { BuyerConstraintsSchema, type Conversation, type PlanStepProposal } from '../src/types.js';
import { buyerId, capability, harness } from './fixtures.js';

const fileBounds = { allowedMimeTypes: ['image/png'], allowedExtensions: ['.png'], maxFileSizeBytes: 500, maxTotalSizeBytes: 500 };
const timing = { mode: 'IMMEDIATE' as const, maxQueueWaitSeconds: 0 };
const constraints = BuyerConstraintsSchema.parse({ maxTotalSpendMinor: 500 });
function image(): AssetDTO { return { id: randomUUID(), filename: 'private-client-name.png', mimeType: 'image/png', sizeBytes: 200, sha256: 'a'.repeat(64) }; }
function imageInput(cap: CapabilityDTO) {
  cap.ioContract.inputs = [{ key: 'image', label: 'Image', type: 'FILE', required: true, order: 0, constraints: { ...fileBounds } }];
  return cap;
}
function imageOutput(cap: CapabilityDTO, role?: string) {
  cap.ioContract.output = { type: 'FILES', description: 'PNG', required: true,
    files: { ...fileBounds, maxFiles: 1 }, fields: [{ key: 'render', label: 'Render', type: 'FILE', required: true, order: 0,
      constraints: { ...fileBounds, ...(role ? { semanticType: role } : {}) } }] };
  // Output envelopes use only aggregate restrictions.
  Reflect.deleteProperty(cap.ioContract.output.files!, 'maxFileSizeBytes');
  return cap;
}
function proposal(cap: CapabilityDTO, value = 'Acme'): PlanStepProposal {
  return { id: randomUUID(), capabilityId: cap.id, capabilityVersionId: cap.versionId, dependsOn: [],
    inputMapping: [{ kind: 'literal', targetInput: cap.ioContract.inputs[0]!.key, value }] };
}
function setup(caps: CapabilityDTO[], planner?: (caps: CapabilityDTO[]) => unknown) {
  const h = harness(caps); const seen: PlatformInferenceRequest[] = [];
  const conversation: Conversation = { id: randomUUID(), userId: buyerId, createdAt: new Date().toISOString(), messages: [] };
  const conversations = { create: vi.fn(async () => conversation), get: vi.fn(async () => conversation), list: vi.fn(async () => [conversation]),
    append: vi.fn(async (_id: string, _userId: string, messages: Conversation['messages']) => { conversation.messages.push(...messages); }) };
  const profile = InferenceProfileSchema.parse({ provider: 'openai', model: 'local-fixture', inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1, structuredOutput: true });
  const inference = planner ? new PlatformInferenceRouter({ providers: [{ id: 'openai', healthCheck: async () => ({ configured: true, healthy: true }), generate: async req => {
    seen.push(req);
    const output = req.task === 'INTENT_EXTRACTION' ? { query: 'company', maxSpendMinor: null, maxPerJobSpendMinor: null, maxJobs: null,
      minRating: null, maxRuntimeSeconds: null, noNetwork: false, onlineOnly: null } : req.task === 'RECOMMENDATION' ? { capabilityIds: caps.map(cap => cap.id) } : planner(caps);
    return { provider: 'openai', model: 'local-fixture', text: JSON.stringify(output), toolCalls: [], usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 }, latencyMs: 1 };
  } }], profiles: { INTENT_EXTRACTION: profile, ORCHESTRATION_PLANNING: profile, RECOMMENDATION: profile },
  accounting: { reserve: async () => 'fixture', finish: async () => {} } }) : undefined;
  return { ...h, seen, conversation, conversations, agent: new MarketplaceAgent({ catalog: h.catalog, orchestration: h.service, conversations, inference }) };
}
function modelStep(cap: CapabilityDTO, value: unknown) {
  return { key: 'one', capabilityId: cap.id, capabilityVersionId: cap.versionId, dependsOn: [], inputMapping: [{ kind: 'literal',
    targetInput: cap.ioContract.inputs[0]!.key, valueJson: JSON.stringify(value), sourceStepKey: null, pointer: null, assetIndex: null, sourceField: null }] };
}

describe('208/233 trusted attachments at chat boundary', () => {
  it('accepts only IDs and bounded file output selectors in the public body', () => {
    const body = { message: 'company', budgetMinor: 500, inputAssetIds: [randomUUID()], requiredOutputFiles: [{ extension: '.pdf', count: 1 }] };
    expect(AgentChatBodySchema.parse(body)).toMatchObject(body);
    for (const extra of [{ inputAssets: [image()] }, { metadata: [] }, { fileBytes: 'data' }]) expect(AgentChatBodySchema.safeParse({ ...body, ...extra }).success).toBe(false);
    expect(AgentChatBodySchema.safeParse({ ...body, inputAssetIds: Array.from({ length: 21 }, randomUUID) }).success).toBe(false);
    expect(AgentChatBodySchema.safeParse({ ...body, inputAssetIds: [...body.inputAssetIds, ...body.inputAssetIds] }).success).toBe(false);
    expect(AgentChatBodySchema.safeParse({ ...body, requiredOutputFiles: [{ extension: 'PDF', count: 1 }] }).success).toBe(false);
  });
  it.each(['missing', 'extra', 'wrong', 'duplicate'] as const)('rejects %s resolved metadata before inference or conversation creation', async kind => {
    const cap = imageInput(capability()); const h = setup([cap], () => ({ clarification: null, steps: [] }));
    const a = image(), b = image();
    const ids = kind === 'duplicate' ? [a.id, b.id] : [a.id];
    const assets = kind === 'missing' ? [] : kind === 'extra' ? [a, b] : kind === 'wrong' ? [b] : [a, a];
    await expect(h.agent.chat({ userId: buyerId, message: 'company', budgetMinor: 500, inputAssetIds: ids, inputAssets: assets })).rejects.toThrow('INPUT_ASSETS_NOT_RESOLVED');
    expect(h.seen).toHaveLength(0); expect(h.conversations.create).not.toHaveBeenCalled(); expect(h.catalog.quote).not.toHaveBeenCalled();
  });
  it('filters incompatible formats before semantic ranking and saves prepared IDs/clarifications', async () => {
    const text = capability(), files = imageInput(capability()), a = image();
    files.ioContract.inputs.push({ key: 'resolution', label: 'Resolution', type: 'INTEGER', required: true, order: 1 });
    const h = setup([text, files]);
    const result = await h.agent.chat({ userId: buyerId, message: 'company', budgetMinor: 500, inputAssetIds: [a.id], inputAssets: [a], preferredCapabilityIds: [text.id] });
    expect(result.recommendations.map(cap => cap.id)).toEqual([files.id]);
    expect(result.contractMatches).toMatchObject([{ capabilityId: files.id, status: 'NEEDS_INPUT', preparedInput: { image: a.id },
      issues: [{ code: 'MISSING_INPUT', inputKey: 'resolution' }] }]);
    expect(h.conversation.messages[0]!.inputAssetIds).toEqual([a.id]);
    expect(h.conversation.messages[1]!.contractMatches).toEqual(result.contractMatches);
    expect(h.catalog.quote).not.toHaveBeenCalled(); expect(h.executor.createJob).not.toHaveBeenCalled();
  });
  it('keeps output-only discovery strict and records its output request', async () => {
    const h = setup([imageOutput(capability()), capability()]);
    const requiredOutputFiles = [{ extension: '.pdf', mimeType: 'application/pdf', count: 1 }];
    const result = await h.agent.chat({ userId: buyerId, message: 'company', budgetMinor: 500, requiredOutputFiles });
    expect(result.recommendations).toEqual([]); expect(h.conversation.messages[0]!.requiredOutputFiles).toEqual(requiredOutputFiles);
    expect(candidateViolation(imageOutput(capability()), { ...constraints, requiredOutputFiles })).toBe('OUTPUT_CONSTRAINT');
  });
  it('sends minimal type/size/ID hints, never private filenames, hashes, URLs or bytes', async () => {
    const cap = imageInput(capability()), a = image(); const h = setup([cap], () => ({ clarification: null, steps: [modelStep(cap, a.id)] }));
    const result = await h.agent.chat({ userId: buyerId, message: 'company', budgetMinor: 500, mode: 'PLAN', inputAssetIds: [a.id],
      inputAssets: [{ ...a, downloadUrl: 'https://private.invalid/token' }] });
    expect(result.plan?.inputAssets).toEqual([a]);
    const prompt = JSON.stringify(h.seen); expect(prompt).toContain(a.id); expect(prompt).toContain('.png');
    for (const secret of [a.filename, a.sha256, 'private.invalid', 'downloadUrl']) expect(prompt).not.toContain(secret);
    expect(h.executor.createJob).not.toHaveBeenCalled();
  });
  it('blocks model-invented asset IDs before plan creation or quotes', async () => {
    const cap = imageInput(capability()), a = image(); const h = setup([cap], () => ({ clarification: null, steps: [modelStep(cap, randomUUID())] }));
    const result = await h.agent.chat({ userId: buyerId, message: 'company', budgetMinor: 500, mode: 'PLAN', inputAssetIds: [a.id], inputAssets: [a] });
    expect(result.inferenceStatus).toBe('FAILED'); expect(result.plan).toBeUndefined(); expect(h.plans.size).toBe(0);
    expect(h.catalog.quote).not.toHaveBeenCalled(); expect(h.executor.createJob).not.toHaveBeenCalled();
  });
  it('excludes incompatible file contracts from recommendation model context before semantic selection', async () => {
    const text = capability(), file = imageInput(capability()), a = image(), h = setup([text, file], () => null);
    const result = await h.agent.chat({ userId: buyerId, message: 'company', budgetMinor: 500, inputAssetIds: [a.id], inputAssets: [a] });
    const context = JSON.parse(h.seen.find(request => request.task === 'RECOMMENDATION')!.messages.at(-1)!.content);
    expect(context.untrustedMarketplaceRecords.map((record: { id: string }) => record.id)).toEqual([file.id]);
    // The fixture model attempts to return both IDs; deterministic enforcement keeps the safe fallback.
    expect(result.inferenceStatus).toBe('FAILED'); expect(result.recommendations.map(cap => cap.id)).toEqual([file.id]);
    expect(h.executor.createJob).not.toHaveBeenCalled();
  });
});

describe('asset approval and final-output plan policy', () => {
  it('permits a buyer-image -> text -> image pipeline without applying final FILES constraints to the text producer', async () => {
    const source = imageInput(capability()), target = imageOutput(capability()), a = image();
    target.ioContract.inputs[0]!.type = 'LONG_TEXT';
    const first = proposal(source, a.id), second = proposal(target); second.dependsOn = [first.id];
    second.inputMapping = [{ kind: 'output', sourceStepId: first.id, pointer: '/text', targetInput: 'subject' }];
    const h = harness([source, target]);
    const plan = await h.service.createDraft({ userId: buyerId, goal: 'pipeline', timing,
      constraints: { ...constraints, outputTypes: ['FILES'], requiredOutputFiles: [{ extension: '.png', count: 1 }] }, steps: [first, second], inputAssets: [a] });
    expect(plan.inputAssets).toEqual([a]); expect(plan.estimatedCostMinor).toBe(198);
    const before = planApprovalHash(plan); const tampered = structuredClone(plan); tampered.inputAssets![0]!.sizeBytes++;
    expect(planApprovalHash(tampered)).not.toBe(before);
    await h.service.approve({ planId: plan.id, userId: buyerId, expectedRevision: 0 });
    const running = await h.service.execute({ planId: plan.id, userId: buyerId });
    expect(h.executor.createJob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.executor.createJob).mock.calls[0]![0].input).toEqual({ image: a.id });
    h.jobs.set(running.steps[0]!.jobId!, { id: running.steps[0]!.jobId!, state: 'SUCCEEDED', output: { text: 'description' } });
    await h.service.execute({ planId: plan.id, userId: buyerId });
    expect(h.executor.createJob).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.executor.createJob).mock.calls[1]![0].input).toEqual({ subject: 'description' });
  });
  it('rejects unconsumed selected files and unsupported final formats before quoting any upstream job', async () => {
    const cap = capability(), h = harness([cap]);
    await expect(h.service.createDraft({ userId: buyerId, goal: 'unused', constraints, timing, steps: [proposal(cap)], inputAssets: [image()] })).rejects.toThrow('UNUSED_BUYER_FILE');
    await expect(h.service.createDraft({ userId: buyerId, goal: 'unsupported', constraints: { ...constraints, requiredOutputFiles: [{ extension: '.pdf', count: 1 }] }, timing,
      steps: [proposal(cap)] })).rejects.toThrow('FINAL_OUTPUT_CONSTRAINT');
    expect(h.catalog.quote).not.toHaveBeenCalled(); expect(h.executor.createJob).not.toHaveBeenCalled();
  });
  it.each([null, '', []])('rejects missing literal required files %j before quoting even an independent upstream step', async value => {
    const source = capability(), target = imageInput(capability()); target.ioContract.inputs[0]!.type = 'FILES';
    const h = harness([source, target]); const missingFile = proposal(target); missingFile.inputMapping = [{ kind: 'literal', targetInput: 'image', value }];
    await expect(h.service.createDraft({ userId: buyerId, goal: 'missing file', constraints, timing,
      steps: [proposal(source), missingFile] })).rejects.toThrow('INVALID_INPUT');
    expect(h.catalog.quote).not.toHaveBeenCalled(); expect(h.executor.createJob).not.toHaveBeenCalled();
  });
  it('requires fresh approval validation for expired buyer files with zero purchase', async () => {
    const cap = imageInput(capability()), a = image(), h = harness([cap]);
    const plan = await h.service.createDraft({ userId: buyerId, goal: 'image', constraints, timing, steps: [proposal(cap, a.id)], inputAssets: [a] });
    h.plans.get(plan.id)!.inputAssets![0]!.expiresAt = '2020-01-01T00:00:00Z';
    await expect(h.service.approve({ planId: plan.id, userId: buyerId, expectedRevision: 0 })).rejects.toThrow('expired');
    expect(h.executor.createJob).not.toHaveBeenCalled();
  });
  it('preserves approved buyer attachments and paid completed work through repair CAS without silent rerun', async () => {
    const source = imageInput(capability()), target = capability(), alternative = capability(), a = image();
    target.ioContract.inputs[0]!.type = 'LONG_TEXT'; alternative.ioContract.inputs[0]!.type = 'LONG_TEXT';
    const first = proposal(source, a.id), second = proposal(target); second.dependsOn = [first.id];
    second.inputMapping = [{ kind: 'output', sourceStepId: first.id, pointer: '/text', targetInput: 'subject' }];
    const h = harness([source, target, alternative]);
    const draft = await h.service.createDraft({ userId: buyerId, goal: 'repair', constraints: { ...constraints, maxTotalSpendMinor: 198 }, timing,
      steps: [first, second], inputAssets: [a] });
    await h.service.approve({ planId: draft.id, userId: buyerId, expectedRevision: 0 });
    const running = await h.service.execute({ planId: draft.id, userId: buyerId }); const paidId = running.steps[0]!.jobId!;
    h.jobs.set(paidId, { id: paidId, state: 'SUCCEEDED', output: { text: 'paid description' } });
    target.availability = { status: 'OFFLINE', canRunNow: false, nextAvailableAt: null, reason: null };
    const blocked = await h.service.execute({ planId: draft.id, userId: buyerId });
    const repaired = await h.service.repair({ planId: draft.id, userId: buyerId, expectedRevision: blocked.revision, reason: 'Replace unavailable text producer',
      replacements: [{ stepId: second.id, capabilityId: alternative.id, capabilityVersionId: alternative.versionId }] });
    expect(repaired.inputAssets).toEqual([a]); expect(repaired.steps[0]).toEqual(blocked.steps[0]);
    expect(repaired.repairHistory![0]).toMatchObject({ committedSpendMinor: 99, remainingBudgetMinor: 99 });
    expect(h.repository.compareAndSwapQuiescent).toHaveBeenCalledExactlyOnceWith(repaired, blocked.revision, [paidId]);
    await expect(h.service.execute({ planId: draft.id, userId: buyerId })).rejects.toThrow('APPROVAL_REQUIRED');
    expect(h.executor.createJob).toHaveBeenCalledTimes(1);
    await h.service.approve({ planId: draft.id, userId: buyerId, expectedRevision: repaired.revision });
    await h.service.execute({ planId: draft.id, userId: buyerId });
    expect(h.executor.createJob).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.executor.createJob).mock.calls[1]![0]).toMatchObject({ capabilityId: alternative.id, maxBudgetMinor: 198, input: { subject: 'paid description' } });
  });
  it('rechecks final formats during repair and refuses an incompatible replacement without new quotes', async () => {
    const original = imageOutput(capability()), replacement = capability(), h = harness([original, replacement]);
    const draft = await h.service.createDraft({ userId: buyerId, goal: 'image', timing,
      constraints: { ...constraints, requiredOutputFiles: [{ extension: '.png', count: 1 }] }, steps: [proposal(original)] });
    vi.mocked(h.catalog.quote).mockClear();
    await expect(h.service.repair({ planId: draft.id, userId: buyerId, expectedRevision: draft.revision, reason: 'Wrong replacement',
      replacements: [{ stepId: draft.steps[0]!.id, capabilityId: replacement.id, capabilityVersionId: replacement.versionId }] })).rejects.toThrow('FINAL_OUTPUT_CONSTRAINT');
    expect(h.catalog.quote).not.toHaveBeenCalled(); expect(h.executor.createJob).not.toHaveBeenCalled();
    expect(h.plans.get(draft.id)).toEqual(draft);
  });
});

describe('SR-03 semantic file roles', () => {
  function chain(sourceRole?: string, targetRole?: string) {
    const source = imageOutput(capability(), sourceRole), target = imageInput(capability());
    if (targetRole) target.ioContract.inputs[0]!.constraints!.semanticType = targetRole;
    const a = proposal(source), b = proposal(target); b.dependsOn = [a.id];
    b.inputMapping = [{ kind: 'asset', sourceStepId: a.id, sourceField: 'render', assetIndex: 0, targetInput: 'image' }];
    return { source, target, a, b, request: { capabilities: [source, target], steps: [a, b], constraints, timing } };
  }
  it.each([
    ['product_image', 'product_image', true], ['product_image', 'reference_image', false],
    [undefined, 'reference_image', false], ['product_image', undefined, true], [undefined, undefined, true],
  ] as const)('compares source %s to target %s explicitly (allowed=%s)', (source, target, allowed) => {
    const f = chain(source, target);
    if (allowed) expect(() => validatePlan(f.request)).not.toThrow();
    else expect(() => validatePlan(f.request)).toThrow('INCOMPATIBLE_SEMANTIC_ROLE');
  });
  it('cannot bypass a typed target by dropping the named field and selecting the aggregate asset list', () => {
    const f = chain('product_image', 'reference_image');
    Reflect.deleteProperty(f.b.inputMapping[0]!, 'sourceField');
    expect(() => validatePlan(f.request)).toThrow('INCOMPATIBLE_SEMANTIC_ROLE');
  });
  it('retains MIME, extension, cardinality and size enforcement even for equal roles', () => {
    for (const mutate of [
      (contract: IOContract) => { contract.inputs[0]!.constraints!.allowedMimeTypes = ['application/pdf']; },
      (contract: IOContract) => { contract.inputs[0]!.constraints!.allowedExtensions = ['.pdf']; },
      (contract: IOContract) => { contract.inputs[0]!.constraints!.maxFileSizeBytes = 100; },
      (contract: IOContract) => { contract.inputs[0]!.type = 'FILES'; contract.inputs[0]!.constraints!.minFiles = 2; },
    ]) {
      const f = chain('product_image', 'product_image'); mutate(f.target.ioContract);
      expect(() => validatePlan(f.request)).toThrow('INCOMPATIBLE_MAPPING');
    }
  });
  it('rejects a mismatched-role chain before upstream billing or quotes', async () => {
    const f = chain('product_image', 'reference_image'), h = harness([f.source, f.target]);
    await expect(h.service.createDraft({ ...f.request, userId: buyerId, goal: 'roles' })).rejects.toThrow('INCOMPATIBLE_SEMANTIC_ROLE');
    expect(h.catalog.quote).not.toHaveBeenCalled(); expect(h.executor.createJob).not.toHaveBeenCalled();
  });
  it('also blocks a previously approved legacy mismatched role at runtime before grants or downstream purchase', async () => {
    const f = chain('product_image', 'product_image'), h = harness([f.source, f.target]);
    const draft = await h.service.createDraft({ ...f.request, userId: buyerId, goal: 'legacy snapshot' });
    await h.service.approve({ planId: draft.id, userId: buyerId, expectedRevision: 0 });
    const running = await h.service.execute({ planId: draft.id, userId: buyerId }); const paidId = running.steps[0]!.jobId!, output = image();
    h.jobs.set(paidId, { id: paidId, state: 'SUCCEEDED', output: { assets: [output], fields: { render: output.id } } });
    // Model a pre-fix approved snapshot, not a mutation that bypasses current hash validation.
    f.target.ioContract.inputs[0]!.constraints!.semanticType = 'reference_image';
    const legacy = h.plans.get(draft.id)!;
    legacy.steps[1]!.contractSnapshot = structuredClone(f.target.ioContract);
    legacy.steps[1]!.capabilityDefinitionHash = capabilityDefinitionHash(f.target);
    legacy.approval!.planHash = planApprovalHash(legacy);
    const stopped = await h.service.execute({ planId: draft.id, userId: buyerId });
    expect(stopped).toMatchObject({ status: 'AWAITING_APPROVAL', error: 'INVALID_INPUT' });
    expect(stopped.steps[0]!.status).toBe('COMPLETED'); expect(stopped.approval).toBeUndefined();
    expect(h.executor.authorizeAssetTransfer).not.toHaveBeenCalled(); expect(h.executor.createJob).toHaveBeenCalledTimes(1);
  });
});
