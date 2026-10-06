import type { CapabilityDTO, IOContract, JobOutput } from '@kivro/contracts';
import { z } from 'zod';
import type { AgentSynthesisResponse } from './synthesis.js';
import { RequiredOutputFilesSchema, type DirectContractMatch, type RequiredOutputFiles, type ResolvedInputAsset } from './contract-matching.js';

export class AgentPolicyError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'AgentPolicyError'; }
}
export const MoneySchema = z.number().int().nonnegative().max(1_000_000_000);
export const BuyerConstraintsSchema = z.object({
  maxTotalSpendMinor: MoneySchema,
  maxPerJobSpendMinor: MoneySchema.optional(),
  minRating: z.number().min(0).max(5).optional(),
  maxRuntimeSeconds: z.number().int().positive().max(604800).optional(),
  maxJobs: z.number().int().min(1).max(32).default(8),
  blockedSellers: z.array(z.string().uuid()).max(100).default([]),
  preferredCapabilityIds: z.array(z.string().uuid()).max(100).refine(ids => new Set(ids).size === ids.length).optional(),
  onlineOnly: z.boolean().optional(),
  noNetwork: z.boolean().default(false),
  outputTypes: z.array(z.enum(['TEXT', 'JSON', 'FILES', 'MIXED'])).optional(),
  requiredOutputFiles: RequiredOutputFilesSchema.optional(),
}).strict();
export type BuyerConstraints = z.infer<typeof BuyerConstraintsSchema>;
export const TimingPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('IMMEDIATE'), maxQueueWaitSeconds: z.number().int().min(0).max(1800).default(0) }).strict(),
  z.object({ mode: z.literal('EARLIEST_AVAILABLE_ALLOWED'), allowScheduling: z.literal(true) }).strict(),
  z.object({ mode: z.literal('DEADLINE'), allowScheduling: z.literal(true), deadlineAt: z.string().datetime() }).strict(),
]);
export type AgentTimingPolicy = z.infer<typeof TimingPolicySchema>;

export interface AgentQuote {
  id: string; capabilityId: string; capabilityVersionId: string; amountMinor: number;
  expiresAt: string; earliestStartAt: string; estimatedDeliveryAt: string;
}
export interface MarketplaceCatalog {
  search(request: { userId: string; query: string; cursor?: string; limit: number }):
    Promise<{ capabilities: CapabilityDTO[]; nextCursor?: string }>;
  get(capabilityId: string, userId: string): Promise<CapabilityDTO | null>;
  quote(request: { userId: string; capabilityId: string; capabilityVersionId: string;
    executionMode: 'NOW' | 'SCHEDULED'; scheduledAt?: string }): Promise<AgentQuote>;
}
export interface ConversationMessage {
  id: string; role: 'user' | 'assistant'; content: string; createdAt: string;
  capabilityIds?: string[]; planId?: string; jobIds?: string[];
  synthesis?: AgentSynthesisResponse;
  recommendationDetails?: AgentRecommendation[];
  inputAssetIds?: string[];
  requiredOutputFiles?: RequiredOutputFiles;
  contractMatches?: AgentContractMatch[];
}
export interface AgentContractMatch extends DirectContractMatch { capabilityId: string; capabilityVersionId: string }
/** Recorded public facts, not an execution quote or model-generated factual claims. */
export interface AgentRecommendation {
  capabilityId: string; capabilityVersionId: string; capabilityTitle: string; generatedAt: string;
  reason: string; matchedTerms: string[]; preferred: boolean;
  price: { currency: 'USD'; amountMinor: number; label: string };
  rating: { value: number | null; reviewCount: number; label: string };
  timing: { status: CapabilityDTO['availability']['status']; estimatedRuntimeSeconds: number;
    canRunNow: boolean; canQueue: boolean; nextAvailableAt: string | null; estimatedQueueWaitSeconds: number | null; label: string };
  permissions: { networkMode: CapabilityDTO['permissions']['network']['mode']; tools: string[]; resourceCount: number; label: string };
  io: { requiredInputs: { key: string; type: string }[]; outputType: CapabilityDTO['ioContract']['output']['type'];
    allowedMimeTypes: string[]; allowedExtensions: string[]; label: string };
  tradeoffs: string[]; limitations: string[];
}
export interface Conversation { id: string; userId: string; createdAt: string; messages: ConversationMessage[] }
export interface ConversationRepository {
  create(userId: string): Promise<Conversation>;
  get(id: string, userId: string): Promise<Conversation | null>;
  list(userId: string): Promise<Conversation[]>;
  append(id: string, userId: string, messages: ConversationMessage[]): Promise<void>;
}

const fieldKey = z.string().min(1).max(100).refine(key => !['__proto__', 'prototype', 'constructor'].includes(key));
export const InputMappingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), targetInput: fieldKey, value: z.unknown() }).strict(),
  z.object({ kind: z.literal('output'), targetInput: fieldKey, sourceStepId: z.string().uuid(),
    pointer: z.string().max(512) }).strict(),
  z.object({ kind: z.literal('asset'), targetInput: fieldKey, sourceStepId: z.string().uuid(),
    assetIndex: z.number().int().min(0).max(99), sourceField: fieldKey.optional() }).strict(),
]);
export type InputMapping = z.infer<typeof InputMappingSchema>;
export const PlanStepProposalSchema = z.object({
  id: z.string().uuid(), capabilityId: z.string().uuid(), capabilityVersionId: z.string().uuid(),
  dependsOn: z.array(z.string().uuid()).max(32), inputMapping: z.array(InputMappingSchema).max(64),
}).strict();
export type PlanStepProposal = z.infer<typeof PlanStepProposalSchema>;
export const PlanRepairBodySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(1000),
  replacements: z.array(z.object({
    stepId: z.string().uuid(), capabilityId: z.string().uuid(), capabilityVersionId: z.string().uuid(),
    inputMapping: z.array(InputMappingSchema).max(64).optional(),
  }).strict()).min(1).max(8),
}).strict();
export type PlanRepairBody = z.infer<typeof PlanRepairBodySchema>;
export const PlanReplanBodySchema = z.object({
  expectedRevision: z.number().int().nonnegative(), reason: z.string().trim().min(1).max(1000),
  stepId: z.string().uuid(), query: z.string().trim().min(1).max(500).optional(),
}).strict();
export type PlanReplanBody = z.infer<typeof PlanReplanBodySchema>;
export interface OrchestrationStep extends PlanStepProposal {
  quote: AgentQuote;
  contractSnapshot: IOContract;
  capabilityDefinitionHash: string;
  status: 'PLANNED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
  jobId?: string; output?: JobExecutionResult['output']; error?: string;
}
export interface RetainedPlanWork { stepId: string; jobId: string; outputHash: string }
export interface PlanRepairAudit {
  id: string; userId: string; createdAt: string; reason: string;
  mode: 'EXPLICIT_REPAIR' | 'DETERMINISTIC_REPLAN';
  previousPlanHash: string;
  previous: {
    revision: number; status: OrchestrationPlan['status']; approval?: OrchestrationPlan['approval'];
    goal: string; constraints: BuyerConstraints; timing: AgentTimingPolicy;
    estimatedCostMinor: number; estimatedCompletionAt: string;
    steps: (Omit<OrchestrationStep, 'output'> & { outputHash?: string })[];
    retiredSteps: (Omit<OrchestrationStep, 'output'> & { outputHash?: string })[];
  };
  replacements: { previousStepId: string; stepId: string; capabilityId: string; capabilityVersionId: string }[];
  committedSpendMinor: number; remainingBudgetMinor: number;
}
export interface OrchestrationPlan {
  id: string; userId: string; conversationId?: string; goal: string; revision: number;
  constraints: BuyerConstraints; timing: AgentTimingPolicy;
  /** Server-resolved buyer-selected inputs, frozen into approval; no URLs or file bytes. */
  inputAssets?: ResolvedInputAsset[];
  steps: OrchestrationStep[]; estimatedCostMinor: number; estimatedCompletionAt: string;
  status: 'AWAITING_APPROVAL' | 'APPROVED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  approval?: { userId: string; approvedAt: string; planHash: string };
  /** Terminal unsuccessful paid attempts retained for provenance and conservative lifetime budgets. */
  retiredSteps?: OrchestrationStep[];
  retainedWork?: RetainedPlanWork[];
  repairHistory?: PlanRepairAudit[];
  createdAt: string; updatedAt: string; error?: string;
}
export interface PlanRepository {
  create(plan: OrchestrationPlan): Promise<void>;
  get(id: string, userId: string): Promise<OrchestrationPlan | null>;
  /** Atomic revision check and replacement. Every successful update increments revision. */
  compareAndSwap(plan: OrchestrationPlan, expectedRevision: number): Promise<boolean>;
  /** Repair-only transaction, serialized with createJob on the same plan lock.
   * Check revision, exact committed job IDs and that EVERY job is terminal; then
   * persist plan plus embedded audit atomically. Unexpected/new/active jobs return false. */
  compareAndSwapQuiescent?(plan: OrchestrationPlan, expectedRevision: number, expectedJobIds: string[]): Promise<boolean>;
}
export interface JobExecutionResult {
  id: string; state: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  output?: JobOutput;
}
export interface PurchaseExecutor {
  /** Read-only recovery after job commit but before plan CAS; must verify plan/step ownership. */
  lookupCreatedJob?(request: { userId: string; planId: string; stepId: string; idempotencyKey: string }): Promise<{ jobId: string } | null>;
  /** Atomically recheck exact plan revision, ownership, approval, immutable version/definition, quote, live eligibility and reserve funds.
   * Deduplicate by idempotencyKey and enforce sum(settled + reserved) <= maxBudgetMinor. */
  createJob(request: {
    userId: string; planId: string; stepId: string; expectedPlanRevision: number; approvalHash: string; maxBudgetMinor: number;
    capabilityId: string; capabilityVersionId: string; quote: AgentQuote;
    input: Record<string, unknown>; executionMode: 'NOW' | 'SCHEDULED'; scheduledAt?: string;
    idempotencyKey: string;
  }): Promise<{ jobId: string }>;
  getJob(jobId: string, userId: string): Promise<JobExecutionResult>;
  /** Idempotently grant only this buyer's upstream asset to this specific next step. */
  authorizeAssetTransfer(request: { userId: string; planId: string; sourceJobId: string;
    targetStepId: string; assetId: string }): Promise<void>;
}
