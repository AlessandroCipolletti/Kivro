import { randomUUID } from 'node:crypto';
import { hashManifest, IOContractSchema, validateInput, validateOutput, type CapabilityDTO, type IOContract, type InputField, type OutputField } from '@kivro/contracts';
import { z } from 'zod';
import { candidateViolation, capabilityPrice, eligibleAt, executionModeFor, rankCandidates } from './policy.js';
import { inputAssetHints, matchPlanFinalOutputs, ResolvedInputAssetSchema, validatePlanEntryAssets, type ResolvedInputAsset } from './contract-matching.js';
import { AgentPolicyError, BuyerConstraintsSchema, MoneySchema, PlanRepairBodySchema, PlanReplanBodySchema, PlanStepProposalSchema, TimingPolicySchema,
  type AgentTimingPolicy, type BuyerConstraints, type MarketplaceCatalog, type OrchestrationPlan,
  type OrchestrationStep, type PlanRepository, type PlanStepProposal, type PurchaseExecutor, type AgentQuote,
  type PlanRepairBody, type PlanReplanBody, type PlanRepairAudit } from './types.js';

function fail(code: string): never { throw new AgentPolicyError(code); }
function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith('/') || pointer.length > 512 || /~(?![01])/u.test(pointer)) fail('INVALID_INPUT_MAPPING');
  const parts = pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part)) || !['text', 'json', 'fields'].includes(parts[0]!)) fail('INVALID_INPUT_MAPPING');
  return parts;
}
function readPointer(value: unknown, pointer: string): unknown {
  for (const part of pointerParts(pointer)) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) fail('SOURCE_OUTPUT_MISSING');
    value = (value as Record<string, unknown>)[part];
  }
  return structuredClone(value);
}
function assertSchemaFitsInput(schema: Record<string, unknown>, field: InputField): void {
  const expected: Record<string, string[]> = { SHORT_TEXT: ['string'], LONG_TEXT: ['string'], INTEGER: ['integer'],
    NUMBER: ['integer', 'number'], BOOLEAN: ['boolean'], SELECT: ['string'], MULTI_SELECT: ['array'], URL: ['string'], JSON: ['object', 'array'] };
  if (typeof schema.type !== 'string' || !expected[field.type]?.includes(schema.type)) fail('INCOMPATIBLE_MAPPING');
  const target = field.constraints ?? {};
  if (['SHORT_TEXT', 'LONG_TEXT', 'URL', 'SELECT'].includes(field.type)) {
    const maxLength = target.maxLength ?? (field.type === 'SHORT_TEXT' ? 500 : 10000);
    if (typeof schema.maxLength !== 'number' || schema.maxLength > maxLength ||
      Number(schema.minLength ?? 0) < (target.minLength ?? 0)) fail('INCOMPATIBLE_MAPPING');
    if (field.type === 'SELECT' && (!Array.isArray(schema.enum) || schema.enum.some(value => !target.allowedValues?.includes(String(value))))) fail('INCOMPATIBLE_MAPPING');
    if (field.type === 'URL' && schema.format !== 'uri') fail('INCOMPATIBLE_MAPPING');
  }
  if (field.type === 'INTEGER' || field.type === 'NUMBER') {
    if ((target.minimum !== undefined && (typeof schema.minimum !== 'number' || schema.minimum < target.minimum)) ||
      (target.maximum !== undefined && (typeof schema.maximum !== 'number' || schema.maximum > target.maximum))) fail('INCOMPATIBLE_MAPPING');
  }
  if (field.type === 'MULTI_SELECT') {
    const items = schema.items as Record<string, unknown> | undefined;
    if (schema.uniqueItems !== true || !Array.isArray(items?.enum) || items.enum.some(value => !target.allowedValues?.includes(String(value)))) fail('INCOMPATIBLE_MAPPING');
  }
  if (field.type === 'JSON' && target.jsonSchema && hashManifest(schema) !== hashManifest(target.jsonSchema)) fail('INCOMPATIBLE_MAPPING');
}
function fieldSchema(field: OutputField): Record<string, unknown> {
  const constraints = field.constraints ?? {};
  if (field.type === 'JSON') return constraints.jsonSchema ?? { type: 'object' };
  if (['SHORT_TEXT', 'LONG_TEXT', 'MARKDOWN', 'SELECT', 'URL'].includes(field.type)) return { type: 'string', minLength: constraints.minLength ?? 0,
    maxLength: constraints.maxLength ?? (field.type === 'SHORT_TEXT' ? 500 : 10000),
    ...(field.type === 'SELECT' ? { enum: constraints.allowedValues } : {}), ...(field.type === 'URL' ? { format: 'uri' } : {}) };
  if (field.type === 'INTEGER' || field.type === 'NUMBER') return { type: field.type === 'INTEGER' ? 'integer' : 'number', minimum: constraints.minimum, maximum: constraints.maximum };
  if (field.type === 'BOOLEAN') return { type: 'boolean' };
  if (field.type === 'MULTI_SELECT') return { type: 'array', uniqueItems: true, items: { type: 'string', enum: constraints.allowedValues } };
  fail('INCOMPATIBLE_MAPPING');
}
function checkOutputMapping(source: IOContract, field: InputField, pointer: string): void {
  const parts = pointerParts(pointer);
  if (parts[0] === 'text') {
    if (!source.output.required || parts.length !== 1 || !['TEXT', 'MIXED'].includes(source.output.type) || !['SHORT_TEXT', 'LONG_TEXT'].includes(field.type)) fail('INCOMPATIBLE_MAPPING');
    // Aggregate text guarantees presence, but has no useful declared text bound.
    // Full downstream validation still gates purchase; use named fields for static bounds.
    return;
  }
  let schema: Record<string, unknown> | undefined; let path: string[];
  if (parts[0] === 'fields') {
    const named = source.output.fields?.find(item => item.key === parts[1]);
    if (!named?.required) fail('SOURCE_OUTPUT_NOT_GUARANTEED');
    schema = fieldSchema(named); path = parts.slice(2);
  } else {
    if (!source.output.required || source.output.type !== 'JSON') fail('INCOMPATIBLE_MAPPING');
    schema = source.output.jsonSchema as Record<string, unknown> | undefined; path = parts.slice(1);
  }
  for (const part of path) {
    if (schema?.type === 'array' && /^(0|[1-9]\d*)$/.test(part)) {
      if (typeof schema.minItems !== 'number' || Number(part) >= schema.minItems) fail('SOURCE_OUTPUT_NOT_GUARANTEED');
      schema = schema.items as Record<string, unknown>;
    } else {
      if (!Array.isArray(schema?.required) || !schema.required.includes(part)) fail('SOURCE_OUTPUT_NOT_GUARANTEED');
      schema = (schema?.properties as Record<string, Record<string, unknown>> | undefined)?.[part];
    }
    if (!schema) fail('INCOMPATIBLE_MAPPING');
  }
  if (!schema) fail('INCOMPATIBLE_MAPPING');
  assertSchemaFitsInput(schema, field);
}

function checkAssetMapping(source: IOContract, target: InputField, assetIndex: number, sourceField?: string): void {
  if (!['FILES', 'MIXED'].includes(source.output.type) || !['FILE', 'FILES'].includes(target.type)) fail('INCOMPATIBLE_MAPPING');
  const files = source.output.files;
  if (!files) fail('INCOMPATIBLE_MAPPING');
  let mimeTypes = files.allowedMimeTypes; let extensions = files.allowedExtensions;
  let guaranteedCount = source.output.required ? 1 : 0;
  let maxCount = files.maxFiles; let maxFileBytes = files.maxTotalSizeBytes;
  let sourceRole: string | undefined;
  if (sourceField) {
    const field = source.output.fields?.find(item => item.key === sourceField);
    if (!field?.required || !['FILE', 'FILES'].includes(field.type)) fail('SOURCE_OUTPUT_NOT_GUARANTEED');
    const bounds = field.constraints;
    if (!bounds?.allowedMimeTypes?.length || !bounds.allowedExtensions?.length || !bounds.maxFileSizeBytes) fail('INCOMPATIBLE_MAPPING');
    mimeTypes = bounds.allowedMimeTypes; extensions = bounds.allowedExtensions;
    sourceRole = bounds.semanticType;
    guaranteedCount = field.type === 'FILE' ? 1 : bounds.minFiles ?? 1;
    maxCount = Math.min(maxCount, field.type === 'FILE' ? 1 : bounds.maxFiles ?? 10);
    maxFileBytes = Math.min(maxFileBytes, bounds.maxFileSizeBytes, bounds.maxTotalSizeBytes ?? Infinity);
    if ((field.type === 'FILE' && (bounds.minFiles ?? 1) > 1) || mimeTypes.some(type => !files.allowedMimeTypes.includes(type)) ||
      extensions.some(extension => !files.allowedExtensions.some(allowed => extension.endsWith(allowed)))) fail('INCOMPATIBLE_MAPPING');
  }
  const input = target.constraints;
  // An untyped target is generic. A typed target requires the same explicit source role;
  // neither MIME nor a model's semantic guess may supply a missing or different role.
  const targetRole = input?.semanticType?.trim() || undefined;
  if (targetRole && (!sourceRole?.trim() || sourceRole.trim() !== targetRole)) fail('INCOMPATIBLE_SEMANTIC_ROLE');
  if (!input?.allowedMimeTypes?.length || !input.allowedExtensions?.length || !input.maxFileSizeBytes ||
    guaranteedCount > maxCount || assetIndex >= guaranteedCount || assetIndex >= maxCount ||
    mimeTypes.some(type => !input.allowedMimeTypes!.includes(type)) ||
    extensions.some(extension => !input.allowedExtensions!.some(allowed => extension.toLowerCase().endsWith(allowed.toLowerCase()))) ||
    maxFileBytes > input.maxFileSizeBytes || maxFileBytes > (input.maxTotalSizeBytes ?? Infinity) ||
    (input.minFiles ?? (target.required ? 1 : 0)) > 1 ||
    (target.type === 'FILES' && (input.maxFiles ?? 10) < 1)) fail('INCOMPATIBLE_MAPPING');
}

interface PlanValidationRequest { steps: PlanStepProposal[]; capabilities: CapabilityDTO[];
  constraints: BuyerConstraints; timing: AgentTimingPolicy; now?: Date; inputAssets?: ResolvedInputAsset[] }
export function validatePlan(request: PlanValidationRequest): { order: string[]; estimatedCostMinor: number; estimatedCompletionAt: string } {
  return validateWithProgress(request);
}
function validateWithProgress(request: PlanValidationRequest & { completedSteps?: OrchestrationStep[]; retiredSteps?: OrchestrationStep[] }) {
  const now = request.now ?? new Date();
  const constraints = BuyerConstraintsSchema.parse(request.constraints);
  const timing = TimingPolicySchema.parse(request.timing);
  const steps = z.array(PlanStepProposalSchema).min(1).max(constraints.maxJobs).parse(request.steps);
  const completed = new Map((request.completedSteps ?? []).map(step => [step.id, step]));
  const retired = request.retiredSteps ?? [];
  if (steps.length + retired.length > constraints.maxJobs) fail('JOB_COUNT_EXCEEDED');
  if (JSON.stringify(steps).length > 200_000) fail('PLAN_TOO_LARGE');
  const byId = new Map(steps.map(step => [step.id, step]));
  if (byId.size !== steps.length) fail('DUPLICATE_STEP');
  const capabilities = new Map(request.capabilities.map(capability => [capability.id, capability]));
  const order: string[] = []; const visiting = new Set<string>(); const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) fail('CYCLIC_PLAN');
    if (visited.has(id)) return;
    const step = byId.get(id);
    if (!step) fail('UNKNOWN_DEPENDENCY');
    if (new Set(step.dependsOn).size !== step.dependsOn.length) fail('DUPLICATE_DEPENDENCY');
    visiting.add(id);
    for (const dependency of step.dependsOn) visit(dependency);
    visiting.delete(id); visited.add(id); order.push(id);
  }
  for (const step of steps) visit(step.id);
  const intermediateIds = new Set(steps.flatMap(step => step.dependsOn));
  const finalContracts = steps.filter(step => !intermediateIds.has(step.id)).map(step =>
    completed.get(step.id)?.contractSnapshot ?? capabilities.get(step.capabilityId)?.ioContract).filter((contract): contract is IOContract => !!contract);
  if (!matchPlanFinalOutputs(finalContracts, { types: constraints.outputTypes,
    files: constraints.requiredOutputFiles?.map(({ count, ...format }) => ({ ...format, minCount: count })) })) fail('FINAL_OUTPUT_CONSTRAINT');
  let estimatedCostMinor = retired.reduce((sum, step) => sum + MoneySchema.parse(step.quote.amountMinor), 0);
  const completion = new Map<string, number>();
  for (const id of order) {
    const step = byId.get(id)!; const capability = capabilities.get(step.capabilityId);
    const finished = completed.get(id);
    if (finished) {
      if (finished.status !== 'COMPLETED' || !finished.jobId || finished.capabilityVersionId !== step.capabilityVersionId ||
        hashManifest(proposal(finished)) !== hashManifest(step)) fail('INVALID_RETAINED_WORK');
      validateOutput(finished.contractSnapshot, finished.output);
      estimatedCostMinor += MoneySchema.parse(finished.quote.amountMinor);
      if (estimatedCostMinor > constraints.maxTotalSpendMinor) fail('BUDGET_EXCEEDED');
      completion.set(id, now.getTime()); continue;
    }
    if (!capability || capability.versionId !== step.capabilityVersionId) fail('CAPABILITY_VERSION_UNAVAILABLE');
    const violation = candidateViolation(capability, { ...constraints, outputTypes: undefined, requiredOutputFiles: undefined }, timing, now);
    if (violation) fail(violation);
    estimatedCostMinor += capabilityPrice(capability);
    if (!Number.isSafeInteger(estimatedCostMinor) || estimatedCostMinor > constraints.maxTotalSpendMinor) fail('BUDGET_EXCEEDED');
    const keys = new Set<string>(); const literals: Record<string, unknown> = Object.create(null);
    for (const mapping of step.inputMapping) {
      const field = capability.ioContract.inputs.find(input => input.key === mapping.targetInput);
      if (!field || keys.has(mapping.targetInput)) fail('INVALID_INPUT_MAPPING');
      keys.add(mapping.targetInput);
      if (mapping.kind === 'literal') {
        if (mapping.value === undefined) fail('INVALID_INPUT_MAPPING');
        literals[field.key] = mapping.value;
      } else {
        if (!step.dependsOn.includes(mapping.sourceStepId)) fail('UNDECLARED_DEPENDENCY');
        const upstream = byId.get(mapping.sourceStepId)!;
        const source = completed.get(upstream.id)?.contractSnapshot ?? capabilities.get(upstream.capabilityId)?.ioContract;
        if (!source) fail('CAPABILITY_VERSION_UNAVAILABLE');
        if (mapping.kind === 'asset') {
          checkAssetMapping(source, field, mapping.assetIndex, mapping.sourceField);
        } else checkOutputMapping(source, field, mapping.pointer);
      }
    }
    for (const field of capability.ioContract.inputs) {
      if (field.required && field.default === undefined && !keys.has(field.key)) fail('MISSING_INPUT');
    }
    // Validate known values now; dependent values are validated with the full contract before purchase.
    const partial = { ...capability.ioContract, inputs: capability.ioContract.inputs.map(field => ({ ...field,
      required: field.required && Object.hasOwn(literals, field.key), visibleWhen: undefined })) };
    try { validateInput(partial, literals); } catch { fail('INVALID_INPUT'); }
    validateBuyerFileLiterals(capability.ioContract, literals, request.inputAssets ?? [], now);
    const start = Math.max(eligibleAt(capability, timing, now)!.getTime(), ...step.dependsOn.map(dep => completion.get(dep)!));
    completion.set(id, start + capability.estimatedDurationSeconds * 1000);
  }
  const finish = Math.max(...completion.values());
  if (timing.mode === 'DEADLINE' && finish > Date.parse(timing.deadlineAt)) fail('DEADLINE_EXCEEDED');
  return { order, estimatedCostMinor, estimatedCompletionAt: new Date(finish).toISOString() };
}

function validateBuyerFileLiterals(contract: IOContract, literals: Record<string, unknown>, approvedAssets: ResolvedInputAsset[], now: Date): void {
  const ids = contract.inputs.filter(field => ['FILE', 'FILES'].includes(field.type)).flatMap(field => {
    const value = literals[field.key]; return typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  });
  if (!ids.length) return;
  const match = validatePlanEntryAssets({ contract, input: literals, assets: approvedAssets.filter(asset => ids.includes(asset.id)), now, allowSellerDefaults: true });
  if (!match.valid) fail('INVALID_BUYER_FILE_MAPPING');
}

const QuoteSchema = z.object({ id: z.string().uuid(), capabilityId: z.string().uuid(), capabilityVersionId: z.string().uuid(),
  amountMinor: MoneySchema, expiresAt: z.string().datetime(), earliestStartAt: z.string().datetime(), estimatedDeliveryAt: z.string().datetime() }).strict();
function proposal(step: OrchestrationStep): PlanStepProposal {
  return { id: step.id, capabilityId: step.capabilityId, capabilityVersionId: step.capabilityVersionId, dependsOn: step.dependsOn, inputMapping: step.inputMapping };
}
export function capabilityDefinitionHash(capability: Pick<CapabilityDTO, 'ioContract' | 'permissions'>): string {
  return hashManifest({ ioContract: capability.ioContract, permissions: capability.permissions });
}
export function planApprovalHash(plan: OrchestrationPlan): string {
  return hashManifest({ id: plan.id, userId: plan.userId, goal: plan.goal, constraints: plan.constraints, timing: plan.timing,
    estimatedCostMinor: plan.estimatedCostMinor, estimatedCompletionAt: plan.estimatedCompletionAt,
    steps: plan.steps.map(step => ({ ...proposal(step), quote: step.quote,
      contractSnapshot: step.contractSnapshot, capabilityDefinitionHash: step.capabilityDefinitionHash })),
    ...(plan.retainedWork ? { retainedWork: plan.retainedWork } : {}),
    ...(plan.retiredSteps ? { retiredSteps: plan.retiredSteps.map(auditStep) } : {}),
    ...(plan.repairHistory ? { repairHistory: plan.repairHistory } : {}),
    ...(plan.inputAssets ? { inputAssets: plan.inputAssets } : {}) });
}
function auditStep(step: OrchestrationStep): Omit<OrchestrationStep, 'output'> & { outputHash?: string } {
  const { output, ...definition } = step;
  return { ...structuredClone(definition), ...(output ? { outputHash: hashManifest(output) } : {}) };
}
function retainedWork(plan: OrchestrationPlan) {
  return plan.steps.filter(step => step.status === 'COMPLETED').map(step => ({ stepId: step.id,
    jobId: z.string().uuid().parse(step.jobId), outputHash: hashManifest(step.output) }));
}
function committedJobIds(plan: OrchestrationPlan): string[] {
  return [...plan.steps, ...(plan.retiredSteps ?? [])].flatMap(step => step.jobId ? [step.jobId] : []).sort();
}

export class OrchestrationService {
  private readonly now: () => Date;
  constructor(private readonly options: { catalog: MarketplaceCatalog; plans: PlanRepository; executor: PurchaseExecutor; now?: () => Date }) { this.now = options.now ?? (() => new Date()); }
  async get(planId: string, userId: string): Promise<OrchestrationPlan> {
    const plan = await this.options.plans.get(planId, userId);
    if (!plan || plan.userId !== userId || plan.id !== planId) fail('PLAN_NOT_FOUND');
    return structuredClone(plan);
  }
  async createDraft(request: { userId: string; conversationId?: string; goal: string; constraints: BuyerConstraints;
    timing: AgentTimingPolicy; steps: PlanStepProposal[]; inputAssets?: ResolvedInputAsset[] }): Promise<OrchestrationPlan> {
    z.string().uuid().parse(request.userId); z.string().min(1).max(12000).parse(request.goal);
    const constraints = BuyerConstraintsSchema.parse(request.constraints); const timing = TimingPolicySchema.parse(request.timing);
    const steps = z.array(PlanStepProposalSchema).min(1).max(constraints.maxJobs).parse(request.steps);
    const inputAssets = request.inputAssets?.map(asset => ResolvedInputAssetSchema.parse(asset));
    if (inputAssets) inputAssetHints(inputAssets, this.now());
    const capabilities = await this.loadCapabilities(steps, request.userId);
    const validated = validatePlan({ steps, capabilities, constraints, timing, now: this.now(), inputAssets });
    const selectedIds = new Set(steps.flatMap(step => step.inputMapping.flatMap(mapping => {
      const field = capabilities.find(capability => capability.id === step.capabilityId)!.ioContract.inputs.find(field => field.key === mapping.targetInput);
      return mapping.kind === 'literal' && field && ['FILE', 'FILES'].includes(field.type) ?
        typeof mapping.value === 'string' ? [mapping.value] : Array.isArray(mapping.value) ? mapping.value : [] : [];
    })));
    if (inputAssets?.some(asset => !selectedIds.has(asset.id))) fail('UNUSED_BUYER_FILE');
    const quoted: OrchestrationStep[] = [];
    for (const step of steps) {
      const capability = capabilities.find(item => item.id === step.capabilityId)!;
      const start = eligibleAt(capability, timing, this.now())!;
      const executionMode = executionModeFor(capability, timing);
      const quote = QuoteSchema.parse(await this.options.catalog.quote({ userId: request.userId, capabilityId: step.capabilityId,
        capabilityVersionId: step.capabilityVersionId, executionMode, ...(executionMode === 'SCHEDULED' ? { scheduledAt: start.toISOString() } : {}) }));
      this.checkQuote(quote, capability, constraints, timing);
      quoted.push({ ...step, quote, contractSnapshot: structuredClone(capability.ioContract),
        capabilityDefinitionHash: capabilityDefinitionHash(capability), status: 'PLANNED' });
    }
    const quotedCost = quoted.reduce((sum, step) => sum + step.quote.amountMinor, 0);
    if (quotedCost > constraints.maxTotalSpendMinor) fail('BUDGET_EXCEEDED');
    const createdAt = this.now().toISOString();
    const plan: OrchestrationPlan = { id: randomUUID(), userId: request.userId, conversationId: request.conversationId,
      goal: request.goal, revision: 0, constraints, timing, steps: quoted, estimatedCostMinor: quotedCost,
      estimatedCompletionAt: validated.estimatedCompletionAt, status: 'AWAITING_APPROVAL', createdAt, updatedAt: createdAt,
      ...(inputAssets?.length ? { inputAssets } : {}) };
    await this.options.plans.create(plan);
    return plan;
  }
  async approve(request: { planId: string; userId: string; expectedRevision: number }): Promise<OrchestrationPlan> {
    const plan = await this.get(request.planId, request.userId);
    if (plan.revision !== request.expectedRevision) fail('PLAN_CONFLICT');
    if (plan.status !== 'AWAITING_APPROVAL') fail('INVALID_PLAN_STATE');
    await this.validateLive(plan);
    plan.approval = { userId: request.userId, approvedAt: this.now().toISOString(), planHash: planApprovalHash(plan) };
    plan.status = 'APPROVED';
    await this.save(plan);
    return plan;
  }
  /** One bounded tick. A durable API worker calls again for pending jobs and after restart. */
  async execute(request: { planId: string; userId: string }): Promise<OrchestrationPlan> {
    const plan = await this.get(request.planId, request.userId);
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(plan.status)) return plan;
    if (!['APPROVED', 'RUNNING'].includes(plan.status) || !plan.approval || plan.approval.userId !== request.userId ||
      plan.approval.planHash !== planApprovalHash(plan)) fail('APPROVAL_REQUIRED');
    this.checkRetainedWork(plan);
    if (plan.status === 'APPROVED') {
      await this.validateLive(plan);
      plan.status = 'RUNNING'; await this.save(plan);
    }
    for (const step of plan.steps.filter(item => item.status === 'RUNNING')) {
      if (!step.jobId) fail('INVALID_PLAN_STATE');
      const job = await this.options.executor.getJob(step.jobId, plan.userId);
      if (job.id !== step.jobId) fail('JOB_OWNERSHIP_MISMATCH');
      if (job.state === 'PENDING') continue;
      if (job.state === 'SUCCEEDED' && job.output) {
        try { step.output = validateOutput(step.contractSnapshot, job.output); step.status = 'COMPLETED'; }
        catch { step.status = 'FAILED'; step.error = 'INVALID_FROZEN_CONTRACT_OUTPUT'; }
      }
      else { step.status = 'FAILED'; step.error = job.state === 'SUCCEEDED' ? 'MISSING_OUTPUT' : 'JOB_FAILED'; }
      await this.save(plan);
    }
    if (plan.steps.some(step => step.status === 'FAILED')) {
      for (const step of plan.steps) if (step.status === 'PLANNED') step.status = 'SKIPPED';
      // Already running independent jobs remain observable until they finish.
      if (!plan.steps.some(step => step.status === 'RUNNING')) plan.status = 'FAILED';
      plan.error = 'UPSTREAM_JOB_FAILED'; await this.save(plan); return plan;
    }
    for (const step of plan.steps.filter(item => item.status === 'PLANNED')) {
      if (!step.dependsOn.every(id => plan.steps.find(item => item.id === id)?.status === 'COMPLETED')) continue;
      const idempotencyKey = `orchestration:${plan.id}:${step.id}`;
      const existing = await this.options.executor.lookupCreatedJob?.({ userId: plan.userId, planId: plan.id, stepId: step.id, idempotencyKey });
      if (existing) {
        z.string().uuid().parse(existing.jobId);
        step.jobId = existing.jobId; step.status = 'RUNNING'; await this.save(plan); continue;
      }
      const capability = await this.options.catalog.get(step.capabilityId, plan.userId);
      if (!capability || capability.versionId !== step.capabilityVersionId) return this.needsApproval(plan, 'CAPABILITY_VERSION_UNAVAILABLE');
      if (capabilityDefinitionHash(capability) !== step.capabilityDefinitionHash) return this.needsApproval(plan, 'CAPABILITY_DEFINITION_CHANGED');
      const violation = candidateViolation(capability, { ...plan.constraints, outputTypes: undefined, requiredOutputFiles: undefined }, plan.timing, this.now());
      if (violation) return this.needsApproval(plan, violation);
      try { this.checkQuote(step.quote, capability, plan.constraints, plan.timing); }
      catch { return this.needsApproval(plan, 'QUOTE_REQUIRES_APPROVAL'); }
      let input: Record<string, unknown>;
      try { input = await this.resolveInput(plan, step, capability); }
      catch { return this.needsApproval(plan, 'INVALID_INPUT'); }
      const executionMode = executionModeFor(capability, plan.timing);
      // The callback's transaction is the final financial boundary, including any race after these reads.
      const created = await this.options.executor.createJob({ userId: plan.userId, planId: plan.id, stepId: step.id,
        expectedPlanRevision: plan.revision, approvalHash: plan.approval!.planHash, maxBudgetMinor: plan.constraints.maxTotalSpendMinor,
        capabilityId: step.capabilityId, capabilityVersionId: step.capabilityVersionId, quote: step.quote, input,
        executionMode, ...(executionMode === 'SCHEDULED' ? { scheduledAt: step.quote.earliestStartAt } : {}),
        idempotencyKey });
      z.string().uuid().parse(created.jobId);
      step.jobId = created.jobId; step.status = 'RUNNING'; await this.save(plan);
    }
    if (plan.steps.every(step => step.status === 'COMPLETED')) { plan.status = 'COMPLETED'; await this.save(plan); }
    return plan;
  }
  async repair(request: PlanRepairBody & { planId: string; userId: string }): Promise<OrchestrationPlan> {
    const { planId, userId, ...raw } = request;
    const body = PlanRepairBodySchema.parse(raw);
    const { original, base } = await this.prepareRepair({ planId, userId, expectedRevision: body.expectedRevision });
    const replacement = await this.replaceSteps(base, body.replacements);
    return this.commitRepair(original, base, replacement, body.reason, 'EXPLICIT_REPAIR');
  }
  /** Explicitly requested, bounded deterministic alternative search, never an AI or purchase claim. */
  async replan(request: PlanReplanBody & { planId: string; userId: string }): Promise<OrchestrationPlan> {
    const { planId, userId, ...raw } = request;
    const body = PlanReplanBodySchema.parse(raw);
    const { original, base } = await this.prepareRepair({ planId, userId, expectedRevision: body.expectedRevision });
    const target = base.steps.find(step => step.id === body.stepId);
    if (!target) fail('UNKNOWN_REPAIR_STEP');
    if (target.status === 'COMPLETED') fail('COMPLETED_STEP_IMMUTABLE');
    const current = await this.options.catalog.get(target.capabilityId, userId);
    const query = body.query ?? current?.title ?? base.goal.slice(0, 500);
    const candidates = new Map<string, CapabilityDTO>(); const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const result = await this.options.catalog.search({ userId, query, cursor, limit: 25 });
      for (const capability of result.capabilities.slice(0, 25)) candidates.set(capability.id, capability);
      if (!result.nextCursor || cursors.has(result.nextCursor)) break;
      cursor = result.nextCursor; cursors.add(cursor);
    }
    const ranked = rankCandidates([...candidates.values()], query, { ...base.constraints, outputTypes: undefined, requiredOutputFiles: undefined }, base.timing, this.now());
    for (const candidate of ranked) {
      if (candidate.id === target.capabilityId && candidate.versionId === target.capabilityVersionId) continue;
      let replacement: Awaited<ReturnType<OrchestrationService['replaceSteps']>>;
      try {
        replacement = await this.replaceSteps(base, [{ stepId: target.id, capabilityId: candidate.id, capabilityVersionId: candidate.versionId }]);
      } catch (error) {
        if (error instanceof AgentPolicyError || error instanceof z.ZodError) continue;
        throw error;
      }
      return this.commitRepair(original, base, replacement, body.reason, 'DETERMINISTIC_REPLAN');
    }
    fail('NO_COMPATIBLE_REPAIR');
  }
  private async prepareRepair(request: { planId: string; userId: string; expectedRevision: number }) {
    const original = await this.get(request.planId, request.userId);
    if (original.revision !== request.expectedRevision) fail('PLAN_CONFLICT');
    if (['COMPLETED', 'CANCELLED'].includes(original.status)) fail('INVALID_PLAN_STATE');
    if ((original.repairHistory?.length ?? 0) >= 5) fail('REPAIR_LIMIT_EXCEEDED');
    if (!this.options.plans.compareAndSwapQuiescent) fail('REPAIR_PERSISTENCE_UNAVAILABLE');
    this.checkRetainedWork(original);
    const base = structuredClone(original);
    for (const step of [...base.steps, ...(base.retiredSteps ?? [])]) {
      if (!step.jobId) {
        const existing = await this.options.executor.lookupCreatedJob?.({ userId: base.userId, planId: base.id, stepId: step.id,
          idempotencyKey: `orchestration:${base.id}:${step.id}` });
        if (existing) step.jobId = z.string().uuid().parse(existing.jobId);
      }
      if (!step.jobId) {
        if (step.status === 'RUNNING' || step.status === 'COMPLETED') fail('INVALID_PLAN_STATE');
        continue;
      }
      const job = await this.options.executor.getJob(step.jobId, base.userId);
      if (job.id !== step.jobId) fail('JOB_OWNERSHIP_MISMATCH');
      if (job.state === 'PENDING') fail('ACTIVE_JOBS_PREVENT_REPAIR');
      if (base.retiredSteps?.includes(step)) continue;
      if (step.status === 'COMPLETED') {
        if (job.state !== 'SUCCEEDED' || !job.output || hashManifest(job.output) !== hashManifest(step.output)) fail('COMPLETED_OUTPUT_CHANGED');
        validateOutput(step.contractSnapshot, step.output);
      } else if (job.state === 'SUCCEEDED' && job.output) {
        try { step.output = validateOutput(step.contractSnapshot, job.output); step.status = 'COMPLETED'; delete step.error; }
        catch { step.status = 'FAILED'; step.error = 'INVALID_FROZEN_CONTRACT_OUTPUT'; }
      } else { step.status = 'FAILED'; step.error = 'JOB_FAILED'; }
    }
    const ids = committedJobIds(base);
    if (new Set(ids).size !== ids.length) fail('INVALID_PLAN_STATE');
    return { original, base };
  }
  private async replaceSteps(base: OrchestrationPlan, replacements: PlanRepairBody['replacements']) {
    if (new Set(replacements.map(item => item.stepId)).size !== replacements.length) fail('DUPLICATE_REPAIR_STEP');
    const plan = structuredClone(base); const changed = new Map(replacements.map(item => [item.stepId, item]));
    const remapped = new Map<string, string>(); const audit: PlanRepairAudit['replacements'] = [];
    plan.retiredSteps ??= [];
    for (const replacement of replacements) {
      const old = plan.steps.find(step => step.id === replacement.stepId);
      if (!old) fail('UNKNOWN_REPAIR_STEP');
      if (old.status === 'COMPLETED') fail('COMPLETED_STEP_IMMUTABLE');
      const id = old.jobId ? randomUUID() : old.id;
      if (old.jobId) { remapped.set(old.id, id); plan.retiredSteps.push(structuredClone(old)); }
      audit.push({ previousStepId: old.id, stepId: id, capabilityId: replacement.capabilityId, capabilityVersionId: replacement.capabilityVersionId });
    }
    plan.steps = plan.steps.map(step => {
      if (step.status === 'COMPLETED') return step;
      const replacement = changed.get(step.id);
      if (step.jobId && !replacement) fail('UNRESOLVED_FAILED_STEP');
      return { ...proposal(step), id: remapped.get(step.id) ?? step.id,
        capabilityId: replacement?.capabilityId ?? step.capabilityId,
        capabilityVersionId: replacement?.capabilityVersionId ?? step.capabilityVersionId,
        dependsOn: step.dependsOn.map(id => remapped.get(id) ?? id),
        inputMapping: (replacement?.inputMapping ?? step.inputMapping).map(mapping => mapping.kind === 'literal' ? structuredClone(mapping) :
          { ...mapping, sourceStepId: remapped.get(mapping.sourceStepId) ?? mapping.sourceStepId }),
        quote: step.quote, contractSnapshot: step.contractSnapshot, capabilityDefinitionHash: step.capabilityDefinitionHash, status: 'PLANNED' };
    });
    const capabilities = await this.loadCapabilities(plan.steps.filter(step => step.status === 'PLANNED'), plan.userId);
    for (const step of plan.steps.filter(item => item.status === 'PLANNED')) {
      const capability = capabilities.find(item => item.id === step.capabilityId)!;
      if (!audit.some(item => item.stepId === step.id) && capabilityDefinitionHash(capability) !== step.capabilityDefinitionHash) fail('CAPABILITY_DEFINITION_CHANGED');
    }
    const validated = validateWithProgress({ steps: plan.steps.map(proposal), capabilities, constraints: plan.constraints, timing: plan.timing,
      completedSteps: plan.steps.filter(step => step.status === 'COMPLETED'), retiredSteps: plan.retiredSteps, now: this.now(), inputAssets: plan.inputAssets });
    for (const step of plan.steps.filter(item => item.status === 'PLANNED')) {
      const capability = capabilities.find(item => item.id === step.capabilityId)!;
      this.checkKnownInputs(plan, step, capability);
    }
    plan.estimatedCompletionAt = validated.estimatedCompletionAt;
    return { plan, capabilities, replacements: audit };
  }
  private async commitRepair(original: OrchestrationPlan, base: OrchestrationPlan,
    replacement: Awaited<ReturnType<OrchestrationService['replaceSteps']>>, reason: string, mode: PlanRepairAudit['mode']) {
    const { plan, capabilities } = replacement;
    for (const step of plan.steps.filter(item => item.status === 'PLANNED')) {
      const capability = capabilities.find(item => item.id === step.capabilityId)!;
      const executionMode = executionModeFor(capability, plan.timing);
      const start = eligibleAt(capability, plan.timing, this.now());
      if (!start) fail('NOT_TIMING_ELIGIBLE');
      step.quote = QuoteSchema.parse(await this.options.catalog.quote({ userId: plan.userId, capabilityId: step.capabilityId,
        capabilityVersionId: step.capabilityVersionId, executionMode, ...(executionMode === 'SCHEDULED' ? { scheduledAt: start.toISOString() } : {}) }));
      this.checkQuote(step.quote, capability, plan.constraints, plan.timing);
      step.contractSnapshot = structuredClone(capability.ioContract); step.capabilityDefinitionHash = capabilityDefinitionHash(capability);
    }
    plan.estimatedCostMinor = [...plan.steps, ...plan.retiredSteps!].reduce((sum, step) => sum + step.quote.amountMinor, 0);
    if (plan.estimatedCostMinor > plan.constraints.maxTotalSpendMinor) fail('BUDGET_EXCEEDED');
    const committedSpendMinor = [...base.steps, ...(base.retiredSteps ?? [])].reduce((sum, step) => sum + (step.jobId ? step.quote.amountMinor : 0), 0);
    plan.repairHistory = [...(base.repairHistory ?? []), {
      id: randomUUID(), userId: plan.userId, createdAt: this.now().toISOString(), reason, mode,
      previousPlanHash: planApprovalHash(original),
      previous: { revision: original.revision, status: original.status, approval: original.approval,
        goal: original.goal, constraints: structuredClone(original.constraints), timing: structuredClone(original.timing),
        estimatedCostMinor: original.estimatedCostMinor, estimatedCompletionAt: original.estimatedCompletionAt,
        steps: original.steps.map(auditStep), retiredSteps: (original.retiredSteps ?? []).map(auditStep) },
      replacements: replacement.replacements, committedSpendMinor, remainingBudgetMinor: plan.constraints.maxTotalSpendMinor - committedSpendMinor,
    }];
    plan.retainedWork = retainedWork(plan); plan.status = 'AWAITING_APPROVAL'; delete plan.approval; delete plan.error;
    const expected = plan.revision; plan.revision++; plan.updatedAt = this.now().toISOString();
    if (JSON.stringify(plan).length > 8_000_000) fail('PLAN_TOO_LARGE');
    // This guard closes the race with a purchase committing after our quiescent read.
    if (!await this.options.plans.compareAndSwapQuiescent!(plan, expected, committedJobIds(base))) fail('PLAN_CONFLICT');
    return plan;
  }
  async cancel(request: { planId: string; userId: string; expectedRevision: number }): Promise<OrchestrationPlan> {
    const plan = await this.get(request.planId, request.userId);
    if (plan.revision !== request.expectedRevision) fail('PLAN_CONFLICT');
    // Cancelling already purchased jobs requires the API's job cancellation service.
    if (plan.steps.some(step => step.jobId)) fail('CANCEL_JOBS_FIRST');
    plan.status = 'CANCELLED'; await this.save(plan); return plan;
  }
  private async loadCapabilities(steps: PlanStepProposal[], userId: string): Promise<CapabilityDTO[]> {
    const result: CapabilityDTO[] = [];
    for (const id of new Set(steps.map(step => step.capabilityId))) {
      const capability = await this.options.catalog.get(id, userId);
      if (!capability || capability.id !== id) fail('CAPABILITY_NOT_FOUND');
      result.push(capability);
    }
    return result;
  }
  private async validateLive(plan: OrchestrationPlan): Promise<void> {
    this.checkRetainedWork(plan);
    const pending = plan.steps.filter(step => step.status !== 'COMPLETED');
    const capabilities = await this.loadCapabilities(pending, plan.userId);
    validateWithProgress({ steps: plan.steps.map(proposal), capabilities, constraints: plan.constraints, timing: plan.timing,
      completedSteps: plan.steps.filter(step => step.status === 'COMPLETED'), retiredSteps: plan.retiredSteps, now: this.now(), inputAssets: plan.inputAssets });
    for (const step of pending) {
      const capability = capabilities.find(item => item.id === step.capabilityId)!;
      if (!IOContractSchema.safeParse(step.contractSnapshot).success) fail('CAPABILITY_DEFINITION_CHANGED');
      if (capabilityDefinitionHash(capability) !== step.capabilityDefinitionHash || hashManifest(step.contractSnapshot) !== hashManifest(capability.ioContract)) fail('CAPABILITY_DEFINITION_CHANGED');
      this.checkQuote(step.quote, capability, plan.constraints, plan.timing);
    }
    if (plan.estimatedCostMinor !== [...plan.steps, ...(plan.retiredSteps ?? [])].reduce((sum, step) => sum + step.quote.amountMinor, 0)) fail('BUDGET_EXCEEDED');
  }
  private checkRetainedWork(plan: OrchestrationPlan): void {
    for (const retained of plan.retainedWork ?? []) {
      const step = plan.steps.find(item => item.id === retained.stepId);
      if (!step || step.status !== 'COMPLETED' || step.jobId !== retained.jobId || hashManifest(step.output) !== retained.outputHash) fail('INVALID_RETAINED_WORK');
    }
  }
  private checkKnownInputs(plan: OrchestrationPlan, step: OrchestrationStep, capability: CapabilityDTO): void {
    const input: Record<string, unknown> = Object.create(null);
    for (const mapping of step.inputMapping) {
      if (mapping.kind === 'literal') input[mapping.targetInput] = structuredClone(mapping.value);
      else {
        const source = plan.steps.find(item => item.id === mapping.sourceStepId);
        if (source?.status !== 'COMPLETED') continue;
        if (mapping.kind === 'output') input[mapping.targetInput] = readPointer(source.output, mapping.pointer);
        else {
          const field = capability.ioContract.inputs.find(item => item.key === mapping.targetInput)!;
          const named = mapping.sourceField ? source.output?.fields?.[mapping.sourceField] : undefined;
          const assetId = mapping.sourceField ? (Array.isArray(named) ? named[mapping.assetIndex] : named) : source.output?.assets?.[mapping.assetIndex]?.id;
          input[mapping.targetInput] = field.type === 'FILES' ? [assetId] : assetId;
          try { validateInput({ ...capability.ioContract, inputs: [{ ...field, visibleWhen: undefined }] },
            { [field.key]: input[field.key] }, source.output?.assets ?? []); }
          catch { fail('INCOMPATIBLE_RETAINED_OUTPUT'); }
        }
      }
    }
    const known = { ...capability.ioContract, inputs: capability.ioContract.inputs.map(field => ({ ...field, required: false, visibleWhen: undefined })) };
    try {
      validateInput(known, input);
      if (step.dependsOn.every(id => plan.steps.find(item => item.id === id)?.status === 'COMPLETED')) validateInput(capability.ioContract, input);
    } catch { fail('INCOMPATIBLE_RETAINED_OUTPUT'); }
  }
  private checkQuote(raw: AgentQuote, capability: CapabilityDTO, constraints: BuyerConstraints, timing: AgentTimingPolicy): void {
    const quote = QuoteSchema.parse(raw); const now = this.now();
    if (quote.capabilityId !== capability.id || quote.capabilityVersionId !== capability.versionId || Date.parse(quote.expiresAt) <= now.getTime() ||
      quote.amountMinor !== capabilityPrice(capability) || quote.amountMinor > (constraints.maxPerJobSpendMinor ?? constraints.maxTotalSpendMinor) ||
      Date.parse(quote.estimatedDeliveryAt) < Date.parse(quote.earliestStartAt)) fail('QUOTE_REQUIRES_APPROVAL');
    if (timing.mode === 'IMMEDIATE' && Date.parse(quote.earliestStartAt) > now.getTime() + timing.maxQueueWaitSeconds * 1000) fail('NOT_TIMING_ELIGIBLE');
    if (timing.mode === 'DEADLINE' && Date.parse(quote.estimatedDeliveryAt) > Date.parse(timing.deadlineAt)) fail('DEADLINE_EXCEEDED');
  }
  private async resolveInput(plan: OrchestrationPlan, step: OrchestrationStep, capability: CapabilityDTO): Promise<Record<string, unknown>> {
    const input: Record<string, unknown> = Object.create(null);
    const literals = Object.fromEntries(step.inputMapping.filter(mapping => mapping.kind === 'literal').map(mapping => [mapping.targetInput, mapping.value]));
    validateBuyerFileLiterals(capability.ioContract, literals, plan.inputAssets ?? [], this.now());
    for (const mapping of step.inputMapping) {
      if (mapping.kind === 'literal') input[mapping.targetInput] = structuredClone(mapping.value);
      else {
        const source = plan.steps.find(item => item.id === mapping.sourceStepId);
        if (!source?.jobId || source.status !== 'COMPLETED' || !step.dependsOn.includes(source.id)) fail('SOURCE_OUTPUT_MISSING');
        if (mapping.kind === 'output') input[mapping.targetInput] = readPointer(source.output, mapping.pointer);
        else {
          let asset = source.output?.assets?.[mapping.assetIndex];
          if (mapping.sourceField) {
            const value = source.output?.fields?.[mapping.sourceField];
            const id = Array.isArray(value) ? value[mapping.assetIndex] : mapping.assetIndex === 0 ? value : undefined;
            asset = source.output?.assets?.find(item => item.id === id);
          }
          if (!asset) fail('SOURCE_OUTPUT_MISSING');
          const field = capability.ioContract.inputs.find(item => item.key === mapping.targetInput)!;
          checkAssetMapping(source.contractSnapshot, field, mapping.assetIndex, mapping.sourceField);
          input[mapping.targetInput] = field.type === 'FILES' ? [asset.id] : asset.id;
          validateInput({ ...capability.ioContract, inputs: [{ ...field, visibleWhen: undefined }] }, { [field.key]: input[field.key] }, [asset]);
          await this.options.executor.authorizeAssetTransfer({ userId: plan.userId, planId: plan.id, sourceJobId: source.jobId, targetStepId: step.id, assetId: asset.id });
        }
      }
    }
    return validateInput(capability.ioContract, input);
  }
  private async needsApproval(plan: OrchestrationPlan, code: string): Promise<OrchestrationPlan> {
    plan.status = 'AWAITING_APPROVAL'; delete plan.approval; plan.error = code; await this.save(plan); return plan;
  }
  private async save(plan: OrchestrationPlan): Promise<void> {
    const expected = plan.revision; plan.revision++; plan.updatedAt = this.now().toISOString();
    if (!await this.options.plans.compareAndSwap(plan, expected)) fail('PLAN_CONFLICT');
  }
}
