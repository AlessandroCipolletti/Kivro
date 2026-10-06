import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BuyerConstraintsSchema, type PlanStepProposal, type AgentTimingPolicy } from '../src/types.js';
import { candidateViolation, eligibleAt, rankCandidates } from '../src/policy.js';
import { validatePlan } from '../src/orchestration.js';
import { buyerId, capability, harness, now } from './fixtures.js';

const timing: AgentTimingPolicy = { mode: 'IMMEDIATE', maxQueueWaitSeconds: 0 };
const constraints = BuyerConstraintsSchema.parse({ maxTotalSpendMinor: 500 });
function step(cap = capability()): PlanStepProposal { return { id: randomUUID(), capabilityId: cap.id, capabilityVersionId: cap.versionId,
  dependsOn: [], inputMapping: [{ kind: 'literal', targetInput: 'subject', value: 'Acme' }] }; }
describe('deterministic availability and constraints', () => {
  it('chooses an available alternative to an unavailable best match', () => {
    const later = capability({ rating: 5, availability: { status: 'SCHEDULED_OFFLINE', canRunNow: false, nextAvailableAt: '2026-10-06T20:00:00.000Z', reason: null } });
    const ready = capability({ rating: 4.6 });
    expect(rankCandidates([later, ready], 'company research', constraints, timing, now)).toEqual([ready]);
    expect(rankCandidates([later, ready], 'company research', constraints)).toHaveLength(2);
  });
  it.each(['OFFLINE', 'PAUSED', 'SECURITY_BLOCKED', 'BUSY', 'SCHEDULED_OFFLINE'] as const)('blocks %s even with a contradictory canRunNow', status => {
    const cap = capability({ availability: { status, canRunNow: true, nextAvailableAt: null, reason: null } });
    expect(eligibleAt(cap, timing, now)).toBeNull();
  });
  it('allows an explicit bounded busy queue but rejects unknown wait', () => {
    const cap = capability({ availability: { status: 'BUSY', canRunNow: false, canQueue: true, nextAvailableAt: null, reason: null } });
    Object.assign(cap.availability, { estimatedQueueWaitSeconds: 20 });
    expect(eligibleAt(cap, { mode: 'IMMEDIATE', maxQueueWaitSeconds: 30 }, now)).not.toBeNull();
    expect(eligibleAt(cap, timing, now)).toBeNull();
    cap.availability.canQueue = false;
    expect(eligibleAt(cap, { mode: 'IMMEDIATE', maxQueueWaitSeconds: 30 }, now)).toBeNull();
  });
  it('requires deadline completion including runtime', () => {
    const cap = capability({ estimatedDurationSeconds: 120, availability: { status: 'SCHEDULED_OFFLINE', canRunNow: false, nextAvailableAt: '2026-10-06T11:00:00.000Z', reason: null } });
    expect(eligibleAt(cap, { mode: 'DEADLINE', allowScheduling: true, deadlineAt: '2026-10-06T11:01:00.000Z' }, now)).toBeNull();
    expect(eligibleAt(cap, { mode: 'EARLIEST_AVAILABLE_ALLOWED', allowScheduling: true }, now)).toEqual(new Date('2026-10-06T11:00:00.000Z'));
  });
  it('never trades permission, rating or price constraints for availability', () => {
    const cap = capability({ priceTierId: 'USD_999' });
    expect(candidateViolation(cap, constraints, timing)).toBe('BUDGET_EXCEEDED');
    cap.priceTierId = 'USD_99'; cap.permissions.network.mode = 'RESEARCH';
    expect(candidateViolation(cap, { ...constraints, noNetwork: true }, timing)).toBe('PERMISSION_CONSTRAINT');
    cap.rating = null;
    expect(candidateViolation(cap, { ...constraints, minRating: 4.5 }, timing)).toBe('RATING_CONSTRAINT');
  });
});
describe('DAG validation', () => {
  it('rejects cycles, duplicate steps and unknown dependencies', () => {
    const cap = capability(); const a = step(cap); const b = step(cap); a.dependsOn = [b.id]; b.dependsOn = [a.id];
    expect(() => validatePlan({ steps: [a, b], capabilities: [cap], constraints, timing, now })).toThrow('CYCLIC_PLAN');
    expect(() => validatePlan({ steps: [a, a], capabilities: [cap], constraints, timing, now })).toThrow('DUPLICATE_STEP');
    expect(() => validatePlan({ steps: [a], capabilities: [cap], constraints, timing, now })).toThrow('UNKNOWN_DEPENDENCY');
  });
  it('applies total budget across branches before approval', () => {
    const cap = capability();
    expect(() => validatePlan({ steps: [step(cap), step(cap)], capabilities: [cap], constraints: { ...constraints, maxTotalSpendMinor: 150 }, timing, now })).toThrow('BUDGET_EXCEEDED');
  });
  it('rejects unavailable middle steps and incompatible mappings', () => {
    const aCap = capability(); const bCap = capability(); const a = step(aCap); const b = step(bCap); b.dependsOn = [a.id];
    b.inputMapping = [{ kind: 'output', sourceStepId: a.id, targetInput: 'subject', pointer: '/text' }];
    bCap.availability.canRunNow = false;
    expect(() => validatePlan({ steps: [a, b], capabilities: [aCap, bCap], constraints, timing, now })).toThrow('NOT_TIMING_ELIGIBLE');
    bCap.availability.canRunNow = true; b.inputMapping[0] = { kind: 'output', sourceStepId: a.id, targetInput: 'subject', pointer: '/json/field' };
    expect(() => validatePlan({ steps: [a, b], capabilities: [aCap, bCap], constraints, timing, now })).toThrow('INCOMPATIBLE_MAPPING');
  });
  it('rejects undeclared source dependencies and prototype traversal', () => {
    const cap = capability(); const a = step(cap); const b = step(cap);
    b.inputMapping = [{ kind: 'output', sourceStepId: a.id, targetInput: 'subject', pointer: '/text' }];
    expect(() => validatePlan({ steps: [a, b], capabilities: [cap], constraints, timing, now })).toThrow('UNDECLARED_DEPENDENCY');
    b.dependsOn = [a.id]; b.inputMapping[0] = { kind: 'output', sourceStepId: a.id, targetInput: 'subject', pointer: '/json/__proto__/key' };
    expect(() => validatePlan({ steps: [a, b], capabilities: [cap], constraints, timing, now })).toThrow('INVALID_INPUT_MAPPING');
  });
  it('estimates the DAG critical path, not the sum of parallel runtimes', () => {
    const cap = capability(); const a = step(cap); const b = step(cap); const c = step(cap); c.dependsOn = [a.id, b.id];
    expect(validatePlan({ steps: [a, b, c], capabilities: [cap], constraints, timing, now }).estimatedCompletionAt).toBe('2026-10-06T10:02:00.000Z');
  });
  function filePlan() {
    const source = capability(); const target = capability(); const a = step(source); const b = step(target);
    source.ioContract.output = { type: 'FILES', description: 'PNG image', required: true,
      files: { allowedMimeTypes: ['image/png'], allowedExtensions: ['.png'], maxFiles: 3, maxTotalSizeBytes: 1000 } };
    target.ioContract.inputs = [{ key: 'document', type: 'FILE', label: 'Document', order: 0, required: true,
      constraints: { allowedMimeTypes: ['application/pdf'], allowedExtensions: ['.pdf'], maxFileSizeBytes: 2000 } }];
    b.dependsOn = [a.id]; b.inputMapping = [{ kind: 'asset', sourceStepId: a.id, targetInput: 'document', assetIndex: 0 }];
    return { source, target, a, b, validate: () => validatePlan({ steps: [a, b], capabilities: [source, target], constraints, timing, now }) };
  }
  it('A13: rejects PNG output to PDF input before any approval or purchase', async () => {
    const f = filePlan(); expect(f.validate).toThrow('INCOMPATIBLE_MAPPING');
    const h = harness([f.source, f.target]);
    await expect(h.service.createDraft({ userId: buyerId, goal: 'impossible', constraints, timing, steps: [f.a, f.b] })).rejects.toThrow('INCOMPATIBLE_MAPPING');
    expect(h.catalog.quote).not.toHaveBeenCalled(); expect(h.executor.createJob).not.toHaveBeenCalled(); expect(h.plans.size).toBe(0);
  });
  it('rejects extension, size, minimum-count and unguaranteed-index mismatches', () => {
    const f = filePlan(); const bounds = f.target.ioContract.inputs[0]!.constraints!;
    bounds.allowedMimeTypes = ['image/png'];
    expect(f.validate).toThrow('INCOMPATIBLE_MAPPING');
    bounds.allowedExtensions = ['.png']; bounds.maxFileSizeBytes = 500;
    expect(f.validate).toThrow('INCOMPATIBLE_MAPPING');
    bounds.maxFileSizeBytes = 2000; bounds.maxTotalSizeBytes = 500;
    expect(f.validate).toThrow('INCOMPATIBLE_MAPPING');
    bounds.maxTotalSizeBytes = 2000;
    expect(f.validate).not.toThrow();
    f.b.inputMapping[0] = { kind: 'asset', sourceStepId: f.a.id, targetInput: 'document', assetIndex: 1 };
    expect(f.validate).toThrow('INCOMPATIBLE_MAPPING');
    f.b.inputMapping[0] = { kind: 'asset', sourceStepId: f.a.id, targetInput: 'document', assetIndex: 0 };
    f.target.ioContract.inputs[0]!.type = 'FILES'; bounds.minFiles = 2;
    expect(f.validate).toThrow('INCOMPATIBLE_MAPPING');
  });
  it('validates guaranteed named file outputs and rejects optional named fields', () => {
    const f = filePlan(); const bounds = f.target.ioContract.inputs[0]!.constraints!;
    bounds.allowedMimeTypes = ['image/png']; bounds.allowedExtensions = ['.png'];
    f.source.ioContract.output.fields = [{ key: 'renders', label: 'Renders', type: 'FILES', required: true, order: 0,
      constraints: { allowedMimeTypes: ['image/png'], allowedExtensions: ['.png'], minFiles: 2, maxFiles: 3, maxFileSizeBytes: 500, maxTotalSizeBytes: 1000 } }];
    f.b.inputMapping[0] = { kind: 'asset', sourceStepId: f.a.id, targetInput: 'document', sourceField: 'renders', assetIndex: 1 };
    expect(f.validate).not.toThrow();
    f.source.ioContract.output.fields[0]!.required = false;
    expect(f.validate).toThrow('SOURCE_OUTPUT_NOT_GUARANTEED');
  });
  it('checks named MARKDOWN/string and JSON property compatibility including requiredness', () => {
    const source = capability(); const target = capability(); const a = step(source); const b = step(target); b.dependsOn = [a.id];
    source.ioContract.output.fields = [{ key: 'report', label: 'Report', type: 'MARKDOWN', required: true, order: 0, constraints: { maxLength: 400 } }];
    b.inputMapping = [{ kind: 'output', sourceStepId: a.id, targetInput: 'subject', pointer: '/fields/report' }];
    const validate = () => validatePlan({ steps: [a, b], capabilities: [source, target], constraints, timing, now });
    expect(validate).not.toThrow();
    source.ioContract.output.fields[0]!.constraints!.maxLength = 501; expect(validate).toThrow('INCOMPATIBLE_MAPPING');
    source.ioContract.output.fields[0]!.constraints!.maxLength = 400; source.ioContract.output.fields[0]!.required = false;
    expect(validate).toThrow('SOURCE_OUTPUT_NOT_GUARANTEED');
    source.ioContract.output = { type: 'JSON', required: true, description: 'json', jsonSchema: {
      type: 'object', properties: { report: { type: 'string', maxLength: 400 } }, additionalProperties: false,
    } };
    b.inputMapping = [{ kind: 'output', sourceStepId: a.id, targetInput: 'subject', pointer: '/json/report' }];
    expect(validate).toThrow('SOURCE_OUTPUT_NOT_GUARANTEED');
    (source.ioContract.output.jsonSchema as Record<string, unknown>).required = ['report']; expect(validate).not.toThrow();
  });
});
describe('approved execution', () => {
  async function draft() {
    const cap = capability(); const h = harness([cap]);
    const plan = await h.service.createDraft({ userId: buyerId, goal: 'research', constraints, timing, steps: [step(cap)] });
    return { ...h, cap, plan };
  }
  it('drafting, malformed approval and foreign ownership cannot purchase', async () => {
    const h = await draft();
    await expect(h.service.execute({ planId: h.plan.id, userId: buyerId })).rejects.toThrow('APPROVAL_REQUIRED');
    await expect(h.service.approve({ planId: h.plan.id, userId: buyerId, expectedRevision: 10 })).rejects.toThrow('PLAN_CONFLICT');
    await expect(h.service.get(h.plan.id, randomUUID())).rejects.toThrow('PLAN_NOT_FOUND');
    expect(h.executor.createJob).not.toHaveBeenCalled();
  });
  it('blocks approval tampering after consent', async () => {
    const h = await draft(); await h.service.approve({ planId: h.plan.id, userId: buyerId, expectedRevision: 0 });
    h.plans.get(h.plan.id)!.constraints.maxTotalSpendMinor = 10000;
    await expect(h.service.execute({ planId: h.plan.id, userId: buyerId })).rejects.toThrow('APPROVAL_REQUIRED');
    expect(h.executor.createJob).not.toHaveBeenCalled();
  });
  it('revalidates authoritative availability and price before any purchase', async () => {
    const h = await draft(); await h.service.approve({ planId: h.plan.id, userId: buyerId, expectedRevision: 0 });
    h.cap.availability.canRunNow = false;
    await expect(h.service.execute({ planId: h.plan.id, userId: buyerId })).rejects.toThrow('NOT_TIMING_ELIGIBLE');
    h.cap.availability.canRunNow = true; h.cap.priceTierId = 'USD_299';
    await expect(h.service.execute({ planId: h.plan.id, userId: buyerId })).rejects.toThrow('QUOTE_REQUIRES_APPROVAL');
    expect(h.executor.createJob).not.toHaveBeenCalled();
  });
  it('rejects expired quotes', async () => {
    const h = await draft(); h.plans.get(h.plan.id)!.steps[0]!.quote.expiresAt = now.toISOString();
    await expect(h.service.approve({ planId: h.plan.id, userId: buyerId, expectedRevision: 0 })).rejects.toThrow('QUOTE_REQUIRES_APPROVAL');
    expect(h.executor.createJob).not.toHaveBeenCalled();
  });
  it('resumes purchased jobs using persisted IDs and stable idempotency keys', async () => {
    const h = await draft(); await h.service.approve({ planId: h.plan.id, userId: buyerId, expectedRevision: 0 });
    const running = await h.service.execute({ planId: h.plan.id, userId: buyerId });
    await h.service.execute({ planId: h.plan.id, userId: buyerId });
    expect(h.executor.createJob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.executor.createJob).mock.calls[0]![0]).toMatchObject({ maxBudgetMinor: 500,
      idempotencyKey: `orchestration:${h.plan.id}:${h.plan.steps[0]!.id}` });
    const id = running.steps[0]!.jobId!; h.jobs.set(id, { id, state: 'SUCCEEDED', output: { text: 'report' } });
    expect((await h.service.execute({ planId: h.plan.id, userId: buyerId })).status).toBe('COMPLETED');
  });
  it('maps an upstream result after success and never before', async () => {
    const cap = capability(); const h = harness([cap]); const a = step(cap); const b = step(cap); b.dependsOn = [a.id];
    b.inputMapping = [{ kind: 'output', sourceStepId: a.id, targetInput: 'subject', pointer: '/text' }];
    const plan = await h.service.createDraft({ userId: buyerId, goal: 'two steps', constraints, timing, steps: [a, b] });
    await h.service.approve({ planId: plan.id, userId: buyerId, expectedRevision: 0 });
    const running = await h.service.execute({ planId: plan.id, userId: buyerId });
    expect(h.executor.createJob).toHaveBeenCalledTimes(1);
    const id = running.steps[0]!.jobId!; h.jobs.set(id, { id, state: 'SUCCEEDED', output: { text: 'upstream report' } });
    await h.service.execute({ planId: plan.id, userId: buyerId });
    expect(vi.mocked(h.executor.createJob).mock.calls[1]![0].input).toEqual({ subject: 'upstream report' });
  });
  it('fails dependent steps without purchasing them after upstream failure', async () => {
    const cap = capability(); const h = harness([cap]); const a = step(cap); const b = step(cap); b.dependsOn = [a.id];
    const plan = await h.service.createDraft({ userId: buyerId, goal: 'two steps', constraints, timing, steps: [a, b] });
    await h.service.approve({ planId: plan.id, userId: buyerId, expectedRevision: 0 });
    const running = await h.service.execute({ planId: plan.id, userId: buyerId });
    const id = running.steps[0]!.jobId!; h.jobs.set(id, { id, state: 'FAILED' });
    const failed = await h.service.execute({ planId: plan.id, userId: buyerId });
    expect(failed.status).toBe('FAILED'); expect(failed.steps[1]!.status).toBe('SKIPPED'); expect(h.executor.createJob).toHaveBeenCalledTimes(1);
  });
});
