import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { hashManifest, type CapabilityDTO } from '@kivro/contracts';
import { BuyerConstraintsSchema, PlanRepairBodySchema, PlanReplanBodySchema, type PlanStepProposal } from '../src/types.js';
import { planApprovalHash } from '../src/orchestration.js';
import { eligibleAt } from '../src/policy.js';
import { buyerId, capability, harness, now } from './fixtures.js';

const timing = { mode: 'IMMEDIATE' as const, maxQueueWaitSeconds: 0 };
const limits = BuyerConstraintsSchema.parse({ maxTotalSpendMinor: 297, maxJobs: 6 });
function step(cap: CapabilityDTO, source?: PlanStepProposal): PlanStepProposal {
  return { id: randomUUID(), capabilityId: cap.id, capabilityVersionId: cap.versionId, dependsOn: source ? [source.id] : [],
    inputMapping: source ? [{ kind: 'output', pointer: '/text', sourceStepId: source.id, targetInput: 'subject' }] :
      [{ kind: 'literal', targetInput: 'subject', value: 'Acme' }] };
}
function offline(cap: CapabilityDTO) {
  cap.availability = { status: 'SCHEDULED_OFFLINE', canRunNow: false, canQueue: false, nextAvailableAt: '2026-10-07T10:00:00.000Z', reason: null };
}
async function chain(maxTotalSpendMinor = 297) {
  const aCap = capability(); const bCap = capability(); const cCap = capability(); const alternative = capability();
  const a = step(aCap); const b = step(bCap, a); const c = step(cCap, b);
  const h = harness([aCap, bCap, cCap, alternative]);
  const draft = await h.service.createDraft({ userId: buyerId, goal: 'Company research chain', constraints: { ...limits, maxTotalSpendMinor }, timing, steps: [a, b, c] });
  const approved = await h.service.approve({ planId: draft.id, userId: buyerId, expectedRevision: 0 });
  return { ...h, aCap, bCap, cCap, alternative, a, b, c, draft, approved };
}
async function blockedChain(maxTotalSpendMinor = 297) {
  const h = await chain(maxTotalSpendMinor);
  const running = await h.service.execute({ planId: h.draft.id, userId: buyerId }); const jobId = running.steps[0]!.jobId!;
  h.jobs.set(jobId, { id: jobId, state: 'SUCCEEDED', output: { text: 'Paid upstream report' } }); offline(h.bCap);
  const blocked = await h.service.execute({ planId: h.draft.id, userId: buyerId });
  return { ...h, blocked, jobId };
}
function repairRequest(h: Awaited<ReturnType<typeof blockedChain>>) {
  return { planId: h.draft.id, userId: buyerId, expectedRevision: h.blocked.revision, reason: 'Replace unavailable middle step',
    replacements: [{ stepId: h.b.id, capabilityId: h.alternative.id, capabilityVersionId: h.alternative.versionId }] };
}

describe('explicit availability-aware step repair', () => {
  it('preserves paid work, repairs only the unavailable step, and completes after fresh exact-revision approval', async () => {
    const h = await blockedChain(); const before = structuredClone(h.blocked); const paid = structuredClone(before.steps[0]!);
    h.capabilities.delete(h.aCap.id); // A completed seller need not stay available or published.
    const repaired = await h.service.repair(repairRequest(h));
    expect(repaired.status).toBe('AWAITING_APPROVAL'); expect(repaired.approval).toBeUndefined();
    expect(repaired.revision).toBe(before.revision + 1); expect(repaired.steps[0]).toEqual(paid);
    expect(repaired.steps[1]).toMatchObject({ id: h.b.id, capabilityId: h.alternative.id, status: 'PLANNED' });
    expect(repaired.steps[2]!.capabilityId).toBe(h.cCap.id); expect(repaired.estimatedCostMinor).toBe(297);
    expect(repaired.retainedWork).toEqual([{ stepId: h.a.id, jobId: h.jobId, outputHash: hashManifest(paid.output) }]);
    expect(repaired.repairHistory![0]).toMatchObject({ previousPlanHash: planApprovalHash(before),
      previous: { revision: before.revision, status: before.status, steps: [{ id: h.a.id, jobId: h.jobId }, { id: h.b.id, capabilityId: h.bCap.id }, { id: h.c.id }] },
      committedSpendMinor: 99, remainingBudgetMinor: 198, mode: 'EXPLICIT_REPAIR' });
    expect(h.executor.createJob).toHaveBeenCalledTimes(1); expect(h.executor.authorizeAssetTransfer).not.toHaveBeenCalled();
    await expect(h.service.execute({ planId: repaired.id, userId: buyerId })).rejects.toThrow('APPROVAL_REQUIRED');
    await expect(h.service.approve({ planId: repaired.id, userId: buyerId, expectedRevision: before.revision })).rejects.toThrow('PLAN_CONFLICT');
    const approved = await h.service.approve({ planId: repaired.id, userId: buyerId, expectedRevision: repaired.revision });
    expect(approved.approval!.planHash).not.toBe(h.approved.approval!.planHash);
    let progress = await h.service.execute({ planId: repaired.id, userId: buyerId });
    expect(vi.mocked(h.executor.createJob).mock.calls[1]![0]).toMatchObject({ capabilityId: h.alternative.id,
      approvalHash: approved.approval!.planHash, maxBudgetMinor: 297, input: { subject: 'Paid upstream report' } });
    const bJob = progress.steps[1]!.jobId!; h.jobs.set(bJob, { id: bJob, state: 'SUCCEEDED', output: { text: 'Middle report' } });
    progress = await h.service.execute({ planId: repaired.id, userId: buyerId });
    const cJob = progress.steps[2]!.jobId!; h.jobs.set(cJob, { id: cJob, state: 'SUCCEEDED', output: { text: 'Final report' } });
    const done = await h.service.execute({ planId: repaired.id, userId: buyerId });
    expect(done.status).toBe('COMPLETED'); expect(done.steps[0]).toEqual(paid); expect(h.jobs.size).toBe(3);
    expect(vi.mocked(h.executor.createJob).mock.calls.reduce((sum, [request]) => sum + request.quote.amountMinor, 0)).toBe(297);
  });

  it('refreshes unspent quotes but ignores completed quote expiry and catalog definition drift', async () => {
    const h = await blockedChain();
    const oldQuote = h.blocked.steps[0]!.quote.id;
    h.aCap.ioContract.output = { type: 'JSON', description: 'Changed', required: true, jsonSchema: { type: 'object' } };
    h.plans.get(h.draft.id)!.steps[0]!.quote.expiresAt = now.toISOString();
    const repaired = await h.service.repair(repairRequest(h));
    expect(repaired.steps[0]!.quote.id).toBe(oldQuote);
    expect(repaired.steps[1]!.quote.id).not.toBe(h.blocked.steps[1]!.quote.id);
    expect(repaired.steps[2]!.quote.id).not.toBe(h.blocked.steps[2]!.quote.id);
    await expect(h.service.approve({ planId: repaired.id, userId: buyerId, expectedRevision: repaired.revision })).resolves.toMatchObject({ status: 'APPROVED' });
  });

  it('preserves completed files and purchased budget through CAS without rerun or premature asset grants', async () => {
    const source = capability(); const target = capability(); const alternative = capability();
    const fileBounds = { allowedMimeTypes: ['image/png'], allowedExtensions: ['.png'], maxFileSizeBytes: 500 };
    source.ioContract.output = { type: 'FILES', required: true, description: 'Paid render',
      files: { allowedMimeTypes: ['image/png'], allowedExtensions: ['.png'], maxFiles: 1, maxTotalSizeBytes: 500 },
      fields: [{ key: 'render', label: 'Render', order: 0, type: 'FILE', required: true, constraints: fileBounds }] };
    target.ioContract.inputs = [{ key: 'image', label: 'Image', order: 0, type: 'FILE', required: true, constraints: fileBounds }];
    alternative.ioContract.inputs = structuredClone(target.ioContract.inputs);
    const a = step(source); const b = step(target, a);
    b.inputMapping = [{ kind: 'asset', sourceStepId: a.id, sourceField: 'render', assetIndex: 0, targetInput: 'image' }];
    const h = harness([source, target, alternative]);
    const plan = await h.service.createDraft({ userId: buyerId, goal: 'Render and inspect', constraints: { ...limits, maxJobs: 2, maxTotalSpendMinor: 198 }, timing, steps: [a, b] });
    await h.service.approve({ planId: plan.id, userId: buyerId, expectedRevision: 0 });
    const running = await h.service.execute({ planId: plan.id, userId: buyerId }); const sourceJobId = running.steps[0]!.jobId!;
    const asset = { id: randomUUID(), filename: 'paid-render.png', mimeType: 'image/png', sizeBytes: 400, sha256: 'a'.repeat(64) };
    const output = { assets: [asset], fields: { render: asset.id } };
    h.jobs.set(sourceJobId, { id: sourceJobId, state: 'SUCCEEDED', output }); offline(target);
    const blocked = await h.service.execute({ planId: plan.id, userId: buyerId });
    const completed = structuredClone(blocked.steps[0]!); h.capabilities.delete(source.id);
    const repaired = await h.service.repair({ planId: plan.id, userId: buyerId, expectedRevision: blocked.revision,
      reason: 'Keep the paid file and replace its unavailable consumer',
      replacements: [{ stepId: b.id, capabilityId: alternative.id, capabilityVersionId: alternative.versionId }] });
    expect(h.repository.compareAndSwapQuiescent).toHaveBeenCalledExactlyOnceWith(repaired, blocked.revision, [sourceJobId]);
    expect(h.plans.get(plan.id)!.steps[0]).toEqual(completed);
    expect(repaired.steps[0]!.output).toEqual(output);
    expect(repaired.retainedWork).toEqual([{ stepId: a.id, jobId: sourceJobId, outputHash: hashManifest(output) }]);
    expect(repaired.estimatedCostMinor).toBe(198); expect(repaired.repairHistory![0]).toMatchObject({ committedSpendMinor: 99, remainingBudgetMinor: 99 });
    expect(h.executor.createJob).toHaveBeenCalledTimes(1); expect(h.executor.authorizeAssetTransfer).not.toHaveBeenCalled();
    await expect(h.service.execute({ planId: plan.id, userId: buyerId })).rejects.toThrow('APPROVAL_REQUIRED');
    expect(h.executor.authorizeAssetTransfer).not.toHaveBeenCalled();
    await h.service.approve({ planId: plan.id, userId: buyerId, expectedRevision: repaired.revision });
    const next = await h.service.execute({ planId: plan.id, userId: buyerId });
    expect(h.executor.authorizeAssetTransfer).toHaveBeenCalledExactlyOnceWith({ userId: buyerId, planId: plan.id,
      sourceJobId, targetStepId: b.id, assetId: asset.id });
    expect(vi.mocked(h.executor.createJob).mock.calls[1]![0]).toMatchObject({ capabilityId: alternative.id, input: { image: asset.id }, maxBudgetMinor: 198 });
    const targetJobId = next.steps[1]!.jobId!; h.jobs.set(targetJobId, { id: targetJobId, state: 'SUCCEEDED', output: { text: 'Inspection' } });
    const done = await h.service.execute({ planId: plan.id, userId: buyerId });
    await h.service.execute({ planId: plan.id, userId: buyerId });
    expect(done.status).toBe('COMPLETED'); expect(done.steps[0]).toEqual(completed);
    expect(h.executor.createJob).toHaveBeenCalledTimes(2); expect(h.jobs.size).toBe(2);
    expect(vi.mocked(h.executor.createJob).mock.calls.reduce((sum, [request]) => sum + request.quote.amountMinor, 0)).toBe(198);
  });

  it('recalculates the lifetime estimate including already spent budget, not just remaining jobs', async () => {
    const h = await blockedChain(497); h.alternative.priceTierId = 'USD_299';
    const repaired = await h.service.repair(repairRequest(h));
    expect(repaired.estimatedCostMinor).toBe(497); expect(repaired.repairHistory![0]!.committedSpendMinor).toBe(99);
    expect(h.executor.createJob).toHaveBeenCalledTimes(1);
    const over = await blockedChain(496); over.alternative.priceTierId = 'USD_299';
    const prior = structuredClone(over.plans.get(over.draft.id)); vi.mocked(over.catalog.quote).mockClear();
    await expect(over.service.repair(repairRequest(over))).rejects.toThrow('BUDGET_EXCEEDED');
    expect(over.plans.get(over.draft.id)).toEqual(prior); expect(over.catalog.quote).not.toHaveBeenCalled();
  });

  it.each(['permission', 'rating', 'input', 'output', 'version'] as const)('rejects a %s-incompatible replacement without committing an audit or buying', async defect => {
    const h = await blockedChain();
    if (defect === 'permission') { h.plans.get(h.draft.id)!.constraints.noNetwork = true; h.alternative.permissions.network.mode = 'RESEARCH'; }
    if (defect === 'rating') { h.plans.get(h.draft.id)!.constraints.minRating = 4.5; h.alternative.rating = 4; }
    if (defect === 'input') h.alternative.ioContract.inputs[0]!.type = 'INTEGER';
    if (defect === 'output') h.alternative.ioContract.output = { type: 'JSON', required: true, description: 'JSON', jsonSchema: { type: 'object' } };
    const request = repairRequest(h); if (defect === 'version') request.replacements[0]!.capabilityVersionId = randomUUID();
    const prior = structuredClone(h.plans.get(h.draft.id)); vi.mocked(h.catalog.quote).mockClear();
    await expect(h.service.repair(request)).rejects.toThrow();
    expect(h.plans.get(h.draft.id)).toEqual(prior); expect(h.catalog.quote).not.toHaveBeenCalled();
    expect(h.executor.createJob).toHaveBeenCalledTimes(1);
  });

  it('forbids paid completed-step replacement and changed completed output', async () => {
    const h = await blockedChain(); const request = repairRequest(h); request.replacements[0]!.stepId = h.a.id;
    await expect(h.service.repair(request)).rejects.toThrow('COMPLETED_STEP_IMMUTABLE');
    h.jobs.set(h.jobId, { id: h.jobId, state: 'SUCCEEDED', output: { text: 'Changed after settlement' } });
    await expect(h.service.repair(repairRequest(h))).rejects.toThrow('COMPLETED_OUTPUT_CHANGED');
    expect(h.executor.createJob).toHaveBeenCalledTimes(1);
  });

  it('retains failed paid attempts and their cost while a retry receives a new step ID/key', async () => {
    const h = await chain(396); const running = await h.service.execute({ planId: h.draft.id, userId: buyerId }); const jobId = running.steps[0]!.jobId!;
    h.jobs.set(jobId, { id: jobId, state: 'FAILED' });
    const failed = await h.service.execute({ planId: h.draft.id, userId: buyerId });
    const repaired = await h.service.repair({ planId: failed.id, userId: buyerId, expectedRevision: failed.revision,
      reason: 'Retry with an explicit different provider', replacements: [{ stepId: h.a.id, capabilityId: h.alternative.id, capabilityVersionId: h.alternative.versionId }] });
    expect(repaired.retiredSteps).toEqual([failed.steps[0]]); expect(repaired.steps[0]!.id).not.toBe(h.a.id);
    expect(repaired.steps[1]!.dependsOn).toEqual([repaired.steps[0]!.id]);
    expect(repaired.steps[1]!.inputMapping[0]).toMatchObject({ sourceStepId: repaired.steps[0]!.id });
    expect(repaired.estimatedCostMinor).toBe(396); expect(repaired.repairHistory![0]!.committedSpendMinor).toBe(99);
    await h.service.approve({ planId: repaired.id, userId: buyerId, expectedRevision: repaired.revision });
    await h.service.execute({ planId: repaired.id, userId: buyerId });
    expect(h.jobs.size).toBe(2);
    expect(vi.mocked(h.executor.createJob).mock.calls[1]![0].idempotencyKey).not.toBe(vi.mocked(h.executor.createJob).mock.calls[0]![0].idempotencyKey);
  });

  it('counts failed attempts against the total job limit and does not silently reset failed unselected steps', async () => {
    const h = await chain(396); const running = await h.service.execute({ planId: h.draft.id, userId: buyerId }); const jobId = running.steps[0]!.jobId!;
    h.jobs.set(jobId, { id: jobId, state: 'FAILED' }); const failed = await h.service.execute({ planId: h.draft.id, userId: buyerId });
    const request = { planId: failed.id, userId: buyerId, expectedRevision: failed.revision, reason: 'Repair',
      replacements: [{ stepId: h.b.id, capabilityId: h.alternative.id, capabilityVersionId: h.alternative.versionId }] };
    await expect(h.service.repair(request)).rejects.toThrow('UNRESOLVED_FAILED_STEP');
    request.replacements[0]!.stepId = h.a.id; h.plans.get(failed.id)!.constraints.maxJobs = 3;
    await expect(h.service.repair(request)).rejects.toThrow('JOB_COUNT_EXCEEDED');
    expect(h.executor.createJob).toHaveBeenCalledTimes(1);
  });

  it('denies active or committed-but-unrecorded jobs and does not persist a partial repair', async () => {
    const h = await chain(); const running = await h.service.execute({ planId: h.draft.id, userId: buyerId });
    const request = { planId: running.id, userId: buyerId, expectedRevision: running.revision, reason: 'Repair',
      replacements: [{ stepId: h.b.id, capabilityId: h.alternative.id, capabilityVersionId: h.alternative.versionId }] };
    await expect(h.service.repair(request)).rejects.toThrow('ACTIVE_JOBS_PREVENT_REPAIR');
    Reflect.deleteProperty(h.plans.get(running.id)!.steps[0]!, 'jobId'); h.plans.get(running.id)!.steps[0]!.status = 'PLANNED';
    await expect(h.service.repair(request)).rejects.toThrow('ACTIVE_JOBS_PREVENT_REPAIR');
    expect(h.repository.compareAndSwapQuiescent).not.toHaveBeenCalled(); expect(h.executor.createJob).toHaveBeenCalledTimes(1);
  });

  it('fails closed without a transactional quiescence guard', async () => {
    const h = await blockedChain(); delete h.repository.compareAndSwapQuiescent;
    await expect(h.service.repair(repairRequest(h))).rejects.toThrow('REPAIR_PERSISTENCE_UNAVAILABLE');
  });

  it('rejects a job commit racing the final repair CAS, leaving the old definition and audit intact', async () => {
    const h = await blockedChain(); const prior = structuredClone(h.plans.get(h.draft.id));
    const original = h.repository.compareAndSwapQuiescent!;
    h.repository.compareAndSwapQuiescent = vi.fn(async (plan, revision, jobIds) => {
      const unexpected = randomUUID(); h.keys.set(`orchestration:${plan.id}:${h.b.id}`, unexpected); h.jobs.set(unexpected, { id: unexpected, state: 'PENDING' });
      return original(plan, revision, jobIds);
    });
    await expect(h.service.repair(repairRequest(h))).rejects.toThrow('PLAN_CONFLICT');
    expect(h.plans.get(h.draft.id)).toEqual(prior); expect(h.plans.get(h.draft.id)!.repairHistory).toBeUndefined();
    expect(h.executor.createJob).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent repairs by revision and does not implicitly approve either result', async () => {
    const h = await blockedChain(); const outcomes = await Promise.allSettled([h.service.repair(repairRequest(h)), h.service.repair(repairRequest(h))]);
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(1);
    const stored = h.plans.get(h.draft.id)!;
    expect(stored.repairHistory).toHaveLength(1); expect(stored.approval).toBeUndefined(); expect(stored.status).toBe('AWAITING_APPROVAL');
  });

  it('requires owner/revision, bounds repair count, and rejects completed plans', async () => {
    const h = await blockedChain(); const request = repairRequest(h);
    await expect(h.service.repair({ ...request, userId: randomUUID() })).rejects.toThrow('PLAN_NOT_FOUND');
    await expect(h.service.repair({ ...request, expectedRevision: 0 })).rejects.toThrow('PLAN_CONFLICT');
    await expect(h.service.repair({ ...request, replacements: [request.replacements[0]!, request.replacements[0]!] })).rejects.toThrow('DUPLICATE_REPAIR_STEP');
    let repaired = await h.service.repair(request);
    for (let count = 1; count < 5; count++) repaired = await h.service.repair({ ...request, expectedRevision: repaired.revision });
    await expect(h.service.repair({ ...request, expectedRevision: repaired.revision })).rejects.toThrow('REPAIR_LIMIT_EXCEEDED');
    h.plans.get(h.draft.id)!.status = 'COMPLETED';
    await expect(h.service.repair({ ...request, expectedRevision: repaired.revision })).rejects.toThrow('INVALID_PLAN_STATE');
  });

  it('hash-binds preserved provenance and repair history to the new approval', async () => {
    const h = await blockedChain(); const repaired = await h.service.repair(repairRequest(h));
    await h.service.approve({ planId: repaired.id, userId: buyerId, expectedRevision: repaired.revision });
    h.plans.get(repaired.id)!.repairHistory![0]!.committedSpendMinor = 0;
    await expect(h.service.execute({ planId: repaired.id, userId: buyerId })).rejects.toThrow('APPROVAL_REQUIRED');
    expect(h.executor.createJob).toHaveBeenCalledTimes(1);
  });

  it('checks known completed output against the replacement input before quoting', async () => {
    const h = await blockedChain(); h.alternative.ioContract.inputs[0]!.constraints = { maxLength: 5 };
    vi.mocked(h.catalog.quote).mockClear();
    await expect(h.service.repair(repairRequest(h))).rejects.toThrow('INCOMPATIBLE_RETAINED_OUTPUT');
    expect(h.catalog.quote).not.toHaveBeenCalled(); expect(h.executor.createJob).toHaveBeenCalledTimes(1);
    expect(h.executor.authorizeAssetTransfer).not.toHaveBeenCalled();
  });

  it('repairs two unavailable steps in one CAS, preserving paid work and lifetime budget until fresh approval', async () => {
    const h = await blockedChain(); offline(h.cCap); const paid = structuredClone(h.blocked.steps[0]);
    const alternateC = capability(); h.capabilities.set(alternateC.id, alternateC);
    const repaired = await h.service.repair({ planId: h.blocked.id, userId: buyerId, expectedRevision: h.blocked.revision,
      reason: 'Both downstream services became unavailable', replacements: [
        { stepId: h.b.id, capabilityId: h.alternative.id, capabilityVersionId: h.alternative.versionId },
        { stepId: h.c.id, capabilityId: alternateC.id, capabilityVersionId: alternateC.versionId },
      ] });
    expect(repaired.steps.map(item => item.capabilityId)).toEqual([h.aCap.id, h.alternative.id, alternateC.id]);
    expect(repaired.repairHistory![0]!.previous.approval).toEqual(h.blocked.approval);
    expect(repaired.repairHistory![0]).toMatchObject({ committedSpendMinor: 99, remainingBudgetMinor: 198,
      previous: { revision: h.blocked.revision, steps: [{ id: h.a.id, jobId: h.jobId }, { id: h.b.id }, { id: h.c.id }] } });
    expect(repaired.estimatedCostMinor).toBe(297); expect(repaired.steps[0]).toEqual(paid);
    expect(repaired.retainedWork).toEqual([{ stepId: h.a.id, jobId: h.jobId, outputHash: hashManifest(paid!.output) }]);
    expect(h.repository.compareAndSwapQuiescent).toHaveBeenCalledExactlyOnceWith(repaired, h.blocked.revision, [h.jobId]);
    expect(repaired.approval).toBeUndefined(); expect(h.executor.createJob).toHaveBeenCalledTimes(1);
    await expect(h.service.execute({ planId: repaired.id, userId: buyerId })).rejects.toThrow('APPROVAL_REQUIRED');
    await h.service.approve({ planId: repaired.id, userId: buyerId, expectedRevision: repaired.revision });
    let progress = await h.service.execute({ planId: repaired.id, userId: buyerId });
    const bJobId = progress.steps[1]!.jobId!; h.jobs.set(bJobId, { id: bJobId, state: 'SUCCEEDED', output: { text: 'New middle report' } });
    progress = await h.service.execute({ planId: repaired.id, userId: buyerId });
    const cJobId = progress.steps[2]!.jobId!; h.jobs.set(cJobId, { id: cJobId, state: 'SUCCEEDED', output: { text: 'Final' } });
    const done = await h.service.execute({ planId: repaired.id, userId: buyerId });
    await h.service.execute({ planId: repaired.id, userId: buyerId });
    expect(done.status).toBe('COMPLETED'); expect(done.steps[0]).toEqual(paid); expect(h.jobs.size).toBe(3);
    expect(vi.mocked(h.executor.createJob).mock.calls.reduce((sum, [request]) => sum + request.quote.amountMinor, 0)).toBe(297);
  });

  it('rejects an invalid second replacement atomically without persisting the valid first replacement', async () => {
    const h = await blockedChain(); offline(h.cCap); const before = structuredClone(h.plans.get(h.blocked.id));
    const alternateC = capability(); h.capabilities.set(alternateC.id, alternateC); vi.mocked(h.catalog.quote).mockClear();
    await expect(h.service.repair({ ...repairRequest(h), replacements: [
      repairRequest(h).replacements[0]!, { stepId: h.c.id, capabilityId: alternateC.id, capabilityVersionId: randomUUID() },
    ] })).rejects.toThrow('CAPABILITY_VERSION_UNAVAILABLE');
    expect(h.plans.get(h.blocked.id)).toEqual(before); expect(h.repository.compareAndSwapQuiescent).not.toHaveBeenCalled();
    expect(h.catalog.quote).not.toHaveBeenCalled(); expect(h.executor.createJob).toHaveBeenCalledTimes(1);
  });

  it('requires another repair if the replacement version changes before fresh approval', async () => {
    const h = await blockedChain(); const repaired = await h.service.repair(repairRequest(h));
    h.alternative.versionId = randomUUID();
    await expect(h.service.approve({ planId: repaired.id, userId: buyerId, expectedRevision: repaired.revision })).rejects.toThrow('CAPABILITY_VERSION_UNAVAILABLE');
    expect(h.plans.get(repaired.id)!.approval).toBeUndefined(); expect(h.executor.createJob).toHaveBeenCalledTimes(1);
  });
});

describe('bounded deterministic availability replan', () => {
  it('searches and reranks compatible alternatives, returning a new unapproved definition only', async () => {
    const h = await blockedChain(); offline(h.aCap); offline(h.cCap);
    // C remains required, so restore its availability while excluding it from search results.
    h.cCap.availability = { status: 'ONLINE', canRunNow: true, nextAvailableAt: null, reason: null };
    const bad = capability({ rating: 5 }); bad.ioContract.inputs[0]!.type = 'INTEGER';
    const expensive = capability({ priceTierId: 'USD_999', rating: 5 });
    h.capabilities.set(bad.id, bad); h.capabilities.set(expensive.id, expensive);
    h.catalog.search = vi.fn(async () => ({ capabilities: [h.bCap, bad, expensive, h.alternative] }));
    const repaired = await h.service.replan({ planId: h.blocked.id, userId: buyerId, expectedRevision: h.blocked.revision,
      stepId: h.b.id, reason: 'Find an available alternative', query: 'Company research' });
    expect(repaired.steps[1]!.capabilityId).toBe(h.alternative.id); expect(repaired.repairHistory![0]!.mode).toBe('DETERMINISTIC_REPLAN');
    expect(repaired.approval).toBeUndefined(); expect(h.executor.createJob).toHaveBeenCalledTimes(1);
    expect(h.catalog.search).toHaveBeenCalledWith({ userId: buyerId, query: 'Company research', cursor: undefined, limit: 25 });
  });

  it('reports no compatible repair after at most four catalog pages without scheduling or modifying the plan', async () => {
    const h = await blockedChain(); let page = 0;
    h.catalog.search = vi.fn(async () => ({ capabilities: [h.bCap], nextCursor: `page-${++page}` }));
    const prior = structuredClone(h.plans.get(h.draft.id));
    await expect(h.service.replan({ planId: h.blocked.id, userId: buyerId, expectedRevision: h.blocked.revision,
      stepId: h.b.id, reason: 'Search alternatives' })).rejects.toThrow('NO_COMPATIBLE_REPAIR');
    expect(h.catalog.search).toHaveBeenCalledTimes(4); expect(h.plans.get(h.draft.id)).toEqual(prior);
    expect(h.executor.createJob).toHaveBeenCalledTimes(1);
  });

  it('accepts only the published route bodies, with mandatory buyer-reviewed revision', () => {
    expect(PlanRepairBodySchema.safeParse({ reason: 'repair', replacements: [] }).success).toBe(false);
    expect(PlanReplanBodySchema.safeParse({ expectedRevision: 0, reason: 'repair', stepId: randomUUID(), approve: true }).success).toBe(false);
    expect(PlanReplanBodySchema.safeParse({ expectedRevision: 0, reason: 'repair', stepId: randomUUID(), maxTotalSpendMinor: 10000 }).success).toBe(false);
  });
});

describe('explicit BUSY queue procurement', () => {
  it('honors canQueue and a known wait bound while purchasing in NOW mode', async () => {
    const cap = capability({ availability: { status: 'BUSY', canRunNow: false, canQueue: true, nextAvailableAt: null, reason: null } });
    Object.assign(cap.availability, { estimatedQueueWaitSeconds: 20 });
    const h = harness([cap]); const queueTiming = { mode: 'IMMEDIATE' as const, maxQueueWaitSeconds: 30 };
    const plan = await h.service.createDraft({ userId: buyerId, goal: 'short wait', constraints: limits, timing: queueTiming, steps: [step(cap)] });
    expect(h.catalog.quote).toHaveBeenCalledWith(expect.objectContaining({ executionMode: 'NOW' }));
    await h.service.approve({ planId: plan.id, userId: buyerId, expectedRevision: 0 });
    await h.service.execute({ planId: plan.id, userId: buyerId });
    expect(h.executor.createJob).toHaveBeenCalledWith(expect.objectContaining({ executionMode: 'NOW' }));
    expect(vi.mocked(h.executor.createJob).mock.calls[0]![0].scheduledAt).toBeUndefined();
  });

  it.each([undefined, -1, Infinity, 31])('denies unknown or out-of-policy queue estimate %s even when canQueue is true', wait => {
    const cap = capability({ availability: { status: 'BUSY', canRunNow: false, canQueue: true, nextAvailableAt: null, reason: null } });
    Object.assign(cap.availability, { estimatedQueueWaitSeconds: wait });
    expect(eligibleAt(cap, { mode: 'IMMEDIATE', maxQueueWaitSeconds: 30 }, now)).toBeNull();
  });
});
