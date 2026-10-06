import { randomUUID } from 'node:crypto';
import type { CapabilityDTO, JobOutput } from '@kivro/contracts';
import { describe, expect, it, vi } from 'vitest';
import { BuyerConstraintsSchema, type PlanRepository, type PlanStepProposal, type PurchaseExecutor } from '../src/types.js';
import { buyerId, capability, harness } from './fixtures.js';

const timing = { mode: 'IMMEDIATE' as const, maxQueueWaitSeconds: 0 };
const constraints = BuyerConstraintsSchema.parse({ maxTotalSpendMinor: 297, maxPerJobSpendMinor: 99, maxJobs: 3 });
function step(cap: CapabilityDTO): PlanStepProposal {
  return { id: randomUUID(), capabilityId: cap.id, capabilityVersionId: cap.versionId,
    dependsOn: [], inputMapping: [{ kind: 'literal', targetInput: 'subject', value: 'Acme' }] };
}
async function singleDraft() {
  const cap = capability(); const h = harness([cap]);
  const plan = await h.service.createDraft({ userId: buyerId, goal: 'research', constraints, timing, steps: [step(cap)] });
  return { ...h, cap, plan };
}
function fileFlow() {
  const source = capability(); const target = capability(); const a = step(source); const b = step(target);
  source.ioContract.output = { type: 'FILES', required: true, description: 'Images',
    files: { allowedMimeTypes: ['image/png'], allowedExtensions: ['.png'], maxFiles: 3, maxTotalSizeBytes: 1200 },
    fields: [{ key: 'renders', type: 'FILES', label: 'Renders', required: true, order: 0,
      constraints: { allowedMimeTypes: ['image/png'], allowedExtensions: ['.png'], minFiles: 2, maxFiles: 3,
        maxFileSizeBytes: 500, maxTotalSizeBytes: 1200 } }] };
  target.ioContract.inputs = [{ key: 'document', label: 'Document', type: 'FILE', required: true, order: 0,
    constraints: { allowedMimeTypes: ['image/png'], allowedExtensions: ['.png'], maxFileSizeBytes: 500 } }];
  b.dependsOn = [a.id]; b.inputMapping = [{ kind: 'asset', sourceStepId: a.id, sourceField: 'renders', assetIndex: 1, targetInput: 'document' }];
  const assets = [0, 1].map(index => ({ id: randomUUID(), filename: `render-${index}.png`, mimeType: 'image/png', sizeBytes: 400, sha256: 'a'.repeat(64) }));
  const output: JobOutput = { assets, fields: { renders: assets.map(asset => asset.id) } };
  return { source, target, a, b, output };
}

describe('frozen approval and approved DAG execution', () => {
  it('executes a three-job branched DAG at exactly the approved budget with one approval', async () => {
    const source = capability(); const target = capability();
    target.ioContract.inputs = ['first', 'second'].map((key, order) => ({ key, label: key, order, type: 'SHORT_TEXT', required: true }));
    const a = step(source); const b = step(source); const c = step(target); c.dependsOn = [a.id, b.id];
    c.inputMapping = [a, b].map((upstream, index) => ({ kind: 'output', sourceStepId: upstream.id,
      pointer: '/text', targetInput: index === 0 ? 'first' : 'second' }));
    const h = harness([source, target]);
    const plan = await h.service.createDraft({ userId: buyerId, goal: 'three jobs', constraints, timing, steps: [a, b, c] });
    expect(plan.estimatedCostMinor).toBe(297); expect(h.executor.createJob).not.toHaveBeenCalled();
    const approved = await h.service.approve({ planId: plan.id, userId: buyerId, expectedRevision: 0 });
    const first = await h.service.execute({ planId: plan.id, userId: buyerId });
    expect(first.steps.map(item => item.status)).toEqual(['RUNNING', 'RUNNING', 'PLANNED']);
    expect(h.executor.createJob).toHaveBeenCalledTimes(2);
    for (const [index, item] of first.steps.slice(0, 2).entries()) {
      h.jobs.set(item.jobId!, { id: item.jobId!, state: 'SUCCEEDED', output: { text: `source ${index}` } });
    }
    const next = await h.service.execute({ planId: plan.id, userId: buyerId });
    expect(next.steps.map(item => item.status)).toEqual(['COMPLETED', 'COMPLETED', 'RUNNING']);
    expect(vi.mocked(h.executor.createJob).mock.calls[2]![0].input).toEqual({ first: 'source 0', second: 'source 1' });
    h.jobs.set(next.steps[2]!.jobId!, { id: next.steps[2]!.jobId!, state: 'SUCCEEDED', output: { text: 'final' } });
    const done = await h.service.execute({ planId: plan.id, userId: buyerId });
    expect(done.status).toBe('COMPLETED'); expect(done.approval).toEqual(approved.approval);
    await h.service.execute({ planId: plan.id, userId: buyerId });
    const purchases = vi.mocked(h.executor.createJob).mock.calls.map(([request]) => request);
    expect(purchases).toHaveLength(3); expect(purchases.reduce((sum, item) => sum + item.quote.amountMinor, 0)).toBe(297);
    expect(purchases.map(item => item.expectedPlanRevision)).toEqual([2, 3, 6]);
    for (const purchase of purchases) expect(purchase).toMatchObject({ approvalHash: approved.approval!.planHash,
      maxBudgetMinor: 297, capabilityVersionId: plan.steps.find(item => item.id === purchase.stepId)!.capabilityVersionId });
    expect(new Set(purchases.map(item => item.idempotencyKey)).size).toBe(3);
  });

  it.each(['total', 'per-job', 'job-count'] as const)('rejects the %s budget before quoting or buying any DAG step', async bound => {
    const cap = capability(); const h = harness([cap]);
    const limits = { ...constraints, ...(bound === 'total' ? { maxTotalSpendMinor: 296 } :
      bound === 'per-job' ? { maxPerJobSpendMinor: 98 } : { maxJobs: 2 }) };
    await expect(h.service.createDraft({ userId: buyerId, goal: 'three jobs', constraints: limits, timing,
      steps: [step(cap), step(cap), step(cap)] })).rejects.toThrow();
    expect(h.catalog.quote).not.toHaveBeenCalled(); expect(h.executor.createJob).not.toHaveBeenCalled();
  });

  it.each(['input', 'output', 'permissions'] as const)('rejects same-version %s drift after consent', async change => {
    const h = await singleDraft(); await h.service.approve({ planId: h.plan.id, userId: buyerId, expectedRevision: 0 });
    if (change === 'input') h.cap.ioContract.inputs[0]!.constraints = { maxLength: 400 };
    else if (change === 'output') h.cap.ioContract.output.description = 'Different approved contract';
    else h.cap.permissions.network = { mode: 'RESEARCH', allowedDomains: ['example.org'] };
    await expect(h.service.execute({ planId: h.plan.id, userId: buyerId })).rejects.toThrow('CAPABILITY_DEFINITION_CHANGED');
    expect(h.executor.createJob).not.toHaveBeenCalled();
    expect(h.plans.get(h.plan.id)!.steps[0]!.contractSnapshot).toEqual(h.plan.steps[0]!.contractSnapshot);
  });

  it('refuses to approve a draft whose same-version definition changed or snapshot is absent', async () => {
    const h = await singleDraft(); h.cap.permissions.limits.maxTokens++;
    await expect(h.service.approve({ planId: h.plan.id, userId: buyerId, expectedRevision: 0 })).rejects.toThrow('CAPABILITY_DEFINITION_CHANGED');
    expect(h.plans.get(h.plan.id)!.approval).toBeUndefined();
    Reflect.deleteProperty(h.plans.get(h.plan.id)!.steps[0]!, 'contractSnapshot');
    await expect(h.service.approve({ planId: h.plan.id, userId: buyerId, expectedRevision: 0 })).rejects.toThrow('CAPABILITY_DEFINITION_CHANGED');
    expect(h.executor.createJob).not.toHaveBeenCalled();
  });

  it('binds frozen output definitions to the approval hash', async () => {
    const h = await singleDraft(); await h.service.approve({ planId: h.plan.id, userId: buyerId, expectedRevision: 0 });
    h.plans.get(h.plan.id)!.steps[0]!.contractSnapshot.output.required = false;
    await expect(h.service.execute({ planId: h.plan.id, userId: buyerId })).rejects.toThrow('APPROVAL_REQUIRED');
    expect(h.executor.createJob).not.toHaveBeenCalled();
  });

  it('validates a running job against its frozen contract even after catalog replacement', async () => {
    const h = await singleDraft(); await h.service.approve({ planId: h.plan.id, userId: buyerId, expectedRevision: 0 });
    const running = await h.service.execute({ planId: h.plan.id, userId: buyerId });
    h.cap.versionId = randomUUID(); h.cap.ioContract.output = { type: 'JSON', required: true, description: 'New output', jsonSchema: { type: 'object' } };
    const jobId = running.steps[0]!.jobId!;
    h.jobs.set(jobId, { id: jobId, state: 'SUCCEEDED', output: { text: 'valid old-version result' } });
    expect((await h.service.execute({ planId: h.plan.id, userId: buyerId })).status).toBe('COMPLETED');
    expect(h.executor.createJob).toHaveBeenCalledTimes(1);
  });

  it.each(['version', 'definition'] as const)('does not silently buy a changed downstream %s or mint a new approval', async change => {
    const source = capability(); const target = capability(); const a = step(source); const b = step(target); b.dependsOn = [a.id];
    b.inputMapping = [{ kind: 'output', sourceStepId: a.id, pointer: '/text', targetInput: 'subject' }];
    const h = harness([source, target]);
    const plan = await h.service.createDraft({ userId: buyerId, goal: 'two jobs', constraints, timing, steps: [a, b] });
    await h.service.approve({ planId: plan.id, userId: buyerId, expectedRevision: 0 });
    const running = await h.service.execute({ planId: plan.id, userId: buyerId }); const jobId = running.steps[0]!.jobId!;
    h.jobs.set(jobId, { id: jobId, state: 'SUCCEEDED', output: { text: 'upstream' } });
    if (change === 'version') target.versionId = randomUUID();
    else target.permissions.network = { mode: 'RESEARCH', allowedDomains: [] };
    const blocked = await h.service.execute({ planId: plan.id, userId: buyerId });
    expect(blocked.status).toBe('AWAITING_APPROVAL');
    expect(blocked.error).toBe(change === 'version' ? 'CAPABILITY_VERSION_UNAVAILABLE' : 'CAPABILITY_DEFINITION_CHANGED');
    expect(blocked.approval).toBeUndefined(); expect(blocked.steps[0]!.status).toBe('COMPLETED');
    expect(blocked.steps[1]!.capabilityVersionId).toBe(b.capabilityVersionId);
    await expect(h.service.execute({ planId: plan.id, userId: buyerId })).rejects.toThrow('APPROVAL_REQUIRED');
    expect(h.executor.createJob).toHaveBeenCalledTimes(1);
  });

  it('stops before downstream purchase when the approved downstream price changes', async () => {
    const source = capability(); const target = capability(); const a = step(source); const b = step(target); b.dependsOn = [a.id];
    const h = harness([source, target]);
    const plan = await h.service.createDraft({ userId: buyerId, goal: 'budget', constraints, timing, steps: [a, b] });
    await h.service.approve({ planId: plan.id, userId: buyerId, expectedRevision: 0 });
    const running = await h.service.execute({ planId: plan.id, userId: buyerId }); const jobId = running.steps[0]!.jobId!;
    h.jobs.set(jobId, { id: jobId, state: 'SUCCEEDED', output: { text: 'upstream' } }); target.priceTierId = 'USD_299';
    const stopped = await h.service.execute({ planId: plan.id, userId: buyerId });
    expect(stopped.status).toBe('AWAITING_APPROVAL'); expect(stopped.approval).toBeUndefined();
    expect(h.executor.createJob).toHaveBeenCalledTimes(1);
  });

  it('uses CAS to prevent concurrent first ticks from dispatching duplicate jobs', async () => {
    const h = await singleDraft(); await h.service.approve({ planId: h.plan.id, userId: buyerId, expectedRevision: 0 });
    const result = await Promise.allSettled([h.service.execute({ planId: h.plan.id, userId: buyerId }), h.service.execute({ planId: h.plan.id, userId: buyerId })]);
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter(item => item.status === 'rejected')).toHaveLength(1);
    expect(h.executor.createJob).toHaveBeenCalledTimes(1); expect(h.jobs.size).toBe(1);
  });

  it('binds purchases to the current persisted revision and propagates a stale-revision rejection without buying', async () => {
    const h = await singleDraft(); await h.service.approve({ planId: h.plan.id, userId: buyerId, expectedRevision: 0 });
    const originalCreate = h.executor.createJob;
    h.executor.createJob = vi.fn<PurchaseExecutor['createJob']>(async request => {
      const current = structuredClone(h.plans.get(h.plan.id)!);
      expect(request.expectedPlanRevision).toBe(current.revision);
      expect(request.expectedPlanRevision).toBe(2);
      await h.repository.compareAndSwap({ ...current, revision: current.revision + 1 }, current.revision);
      // The fixture models the API's revision comparison inside its reservation lock.
      return originalCreate(request);
    });
    await expect(h.service.execute({ planId: h.plan.id, userId: buyerId })).rejects.toThrow('PLAN_CONFLICT');
    expect(h.jobs.size).toBe(0); expect(h.keys.size).toBe(0);
    expect(h.plans.get(h.plan.id)!.steps[0]!.jobId).toBeUndefined();
    h.executor.createJob = originalCreate;
    const resumed = await h.service.execute({ planId: h.plan.id, userId: buyerId });
    expect(vi.mocked(originalCreate).mock.calls.map(([request]) => request.expectedPlanRevision)).toEqual([2, 3]);
    expect(h.jobs.size).toBe(1); expect(resumed.steps[0]!.status).toBe('RUNNING');
  });

  it('recovers a committed job after plan-CAS failure without repurchase or fresh approval', async () => {
    const h = await singleDraft(); const approved = await h.service.approve({ planId: h.plan.id, userId: buyerId, expectedRevision: 0 });
    const originalCAS = h.repository.compareAndSwap; let failNextJobSave = true;
    h.repository.compareAndSwap = vi.fn<PlanRepository['compareAndSwap']>(async (plan, revision) => {
      if (failNextJobSave && plan.steps.some(item => item.jobId)) { failNextJobSave = false; return false; }
      return originalCAS(plan, revision);
    });
    await expect(h.service.execute({ planId: h.plan.id, userId: buyerId })).rejects.toThrow('PLAN_CONFLICT');
    expect(h.plans.get(h.plan.id)!.steps[0]!.jobId).toBeUndefined(); expect(h.jobs.size).toBe(1);
    h.cap.availability = { status: 'BUSY', canRunNow: false, nextAvailableAt: null, reason: 'Already executing the purchased job' };
    const recovered = await h.service.execute({ planId: h.plan.id, userId: buyerId });
    expect(recovered.steps[0]!.jobId).toBe([...h.jobs.keys()][0]); expect(recovered.approval).toEqual(approved.approval);
    expect(h.executor.lookupCreatedJob).toHaveBeenLastCalledWith({ userId: buyerId, planId: h.plan.id,
      stepId: h.plan.steps[0]!.id, idempotencyKey: `orchestration:${h.plan.id}:${h.plan.steps[0]!.id}` });
    expect(h.executor.createJob).toHaveBeenCalledTimes(1);
    const jobId = recovered.steps[0]!.jobId!; h.jobs.set(jobId, { id: jobId, state: 'SUCCEEDED', output: { text: 'done' } });
    expect((await h.service.execute({ planId: h.plan.id, userId: buyerId })).status).toBe('COMPLETED');
  });
});

describe('A13 runtime output and asset compatibility', () => {
  it('resolves a named asset by field order, not aggregate asset order, and grants only that asset', async () => {
    const f = fileFlow(); const h = harness([f.source, f.target]); f.output.assets!.reverse();
    const plan = await h.service.createDraft({ userId: buyerId, goal: 'named output', constraints, timing, steps: [f.a, f.b] });
    await h.service.approve({ planId: plan.id, userId: buyerId, expectedRevision: 0 });
    const running = await h.service.execute({ planId: plan.id, userId: buyerId }); const jobId = running.steps[0]!.jobId!;
    h.jobs.set(jobId, { id: jobId, state: 'SUCCEEDED', output: f.output });
    await h.service.execute({ planId: plan.id, userId: buyerId });
    const selected = (f.output.fields!.renders as string[])[1]!;
    expect(vi.mocked(h.executor.createJob).mock.calls[1]![0].input).toEqual({ document: selected });
    expect(h.executor.authorizeAssetTransfer).toHaveBeenCalledExactlyOnceWith({ userId: buyerId, planId: plan.id,
      sourceJobId: jobId, targetStepId: f.b.id, assetId: selected });
  });

  it.each(['mime', 'extension', 'size', 'cardinality', 'missing-field'] as const)('rejects %s output violating the frozen contract before downstream purchase', async defect => {
    const f = fileFlow(); const h = harness([f.source, f.target]);
    const plan = await h.service.createDraft({ userId: buyerId, goal: 'named output', constraints, timing, steps: [f.a, f.b] });
    await h.service.approve({ planId: plan.id, userId: buyerId, expectedRevision: 0 });
    const running = await h.service.execute({ planId: plan.id, userId: buyerId }); const jobId = running.steps[0]!.jobId!;
    if (defect === 'mime') f.output.assets![0]!.mimeType = 'application/pdf';
    if (defect === 'extension') f.output.assets![0]!.filename = 'report.pdf';
    if (defect === 'size') f.output.assets![0]!.sizeBytes = 501;
    if (defect === 'cardinality') f.output.fields!.renders = [f.output.assets![0]!.id];
    if (defect === 'missing-field') f.output.fields = {};
    h.jobs.set(jobId, { id: jobId, state: 'SUCCEEDED', output: f.output });
    const stopped = await h.service.execute({ planId: plan.id, userId: buyerId });
    expect(stopped.status).toBe('FAILED'); expect(stopped.steps[0]!.error).toBe('INVALID_FROZEN_CONTRACT_OUTPUT');
    expect(stopped.steps[1]!.status).toBe('SKIPPED'); expect(h.executor.createJob).toHaveBeenCalledTimes(1);
    expect(h.executor.authorizeAssetTransfer).not.toHaveBeenCalled();
  });
});
