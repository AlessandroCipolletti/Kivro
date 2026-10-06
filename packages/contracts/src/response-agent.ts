import { z } from 'zod';
import { AssetDTOSchema, AvailabilitySchema, CapabilityDTOSchema, IOContractSchema, JobOutputSchema } from './index.ts';
import { count, isoDate, jsonObject, jsonValue, responseRoutes, sha256, uuid, type ResponseRoute } from './response-common.ts';

const spend = count.max(1_000_000_000);
const outputType = z.enum(['TEXT', 'JSON', 'FILES', 'MIXED']);
const fieldKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  .refine(key => !['__proto__', 'constructor', 'prototype'].includes(key));
const distinctIds = (max: number) => z.array(uuid).max(max).refine(ids => new Set(ids).size === ids.length);
const capability = CapabilityDTOSchema.extend({
  seller: CapabilityDTOSchema.shape.seller.strict(), availability: AvailabilitySchema.strict(),
  dataProcessing: CapabilityDTOSchema.shape.dataProcessing.unwrap().strict().optional(),
}).strict();

export const agentRequiredOutputFilesResponseSchema = z.array(z.object({
  extension: z.string().regex(/^\.[a-z0-9.]+$/).max(40).optional(),
  mimeType: z.string().max(150).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/).optional(),
  count: z.number().int().min(1).max(20),
}).strict().refine(file => file.extension !== undefined || file.mimeType !== undefined)).min(1).max(20)
  .refine(files => files.reduce((sum, file) => sum + file.count, 0) <= 20)
  .refine(files => new Set(files.map(file => `${file.extension ?? ''}:${file.mimeType ?? ''}`)).size === files.length);

export const agentBuyerConstraintsResponseSchema = z.object({
  maxTotalSpendMinor: spend, maxPerJobSpendMinor: spend.optional(),
  minRating: z.number().min(0).max(5).optional(), maxRuntimeSeconds: z.number().int().positive().max(604800).optional(),
  maxJobs: z.number().int().min(1).max(32), blockedSellers: z.array(uuid).max(100), noNetwork: z.boolean(),
  preferredCapabilityIds: distinctIds(100).optional(), onlineOnly: z.boolean().optional(),
  outputTypes: z.array(outputType).optional(), requiredOutputFiles: agentRequiredOutputFilesResponseSchema.optional(),
}).strict();
export const agentTimingPolicyResponseSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('IMMEDIATE'), maxQueueWaitSeconds: z.number().int().min(0).max(1800) }).strict(),
  z.object({ mode: z.literal('EARLIEST_AVAILABLE_ALLOWED'), allowScheduling: z.literal(true) }).strict(),
  z.object({ mode: z.literal('DEADLINE'), allowScheduling: z.literal(true), deadlineAt: isoDate }).strict(),
]);
const inputMapping = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), targetInput: fieldKey, value: jsonValue }).strict(),
  z.object({ kind: z.literal('output'), targetInput: fieldKey, sourceStepId: uuid, pointer: z.string().max(512) }).strict(),
  z.object({ kind: z.literal('asset'), targetInput: fieldKey, sourceStepId: uuid, assetIndex: z.number().int().min(0).max(99), sourceField: fieldKey.optional() }).strict(),
]);
export const agentQuoteResponseSchema = z.object({
  id: uuid, capabilityId: uuid, capabilityVersionId: uuid, amountMinor: spend,
  expiresAt: isoDate, earliestStartAt: isoDate, estimatedDeliveryAt: isoDate,
}).strict();
const jobOutput = JobOutputSchema.extend({ json: jsonValue.optional(), fields: jsonObject.optional() }).strict();
export const agentPlanStepResponseSchema = z.object({
  id: uuid, capabilityId: uuid, capabilityVersionId: uuid, dependsOn: z.array(uuid).max(32), inputMapping: z.array(inputMapping).max(64),
  quote: agentQuoteResponseSchema, contractSnapshot: IOContractSchema, capabilityDefinitionHash: sha256,
  status: z.enum(['PLANNED', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED']), jobId: uuid.optional(), output: jobOutput.optional(), error: z.string().optional(),
}).strict();
const planStatus = z.enum(['AWAITING_APPROVAL', 'APPROVED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']);
const approval = z.object({ userId: uuid, approvedAt: isoDate, planHash: sha256 }).strict();
const auditedStep = agentPlanStepResponseSchema.omit({ output: true }).extend({ outputHash: sha256.optional() }).strict();
export const agentPlanRepairAuditResponseSchema = z.object({
  id: uuid, userId: uuid, createdAt: isoDate, reason: z.string().min(1).max(1000),
  mode: z.enum(['EXPLICIT_REPAIR', 'DETERMINISTIC_REPLAN']), previousPlanHash: sha256,
  previous: z.object({
    revision: count, status: planStatus, approval: approval.optional(), goal: z.string().min(1).max(12000),
    constraints: agentBuyerConstraintsResponseSchema, timing: agentTimingPolicyResponseSchema,
    estimatedCostMinor: spend, estimatedCompletionAt: isoDate,
    steps: z.array(auditedStep).min(1).max(32), retiredSteps: z.array(auditedStep).max(32),
  }).strict(),
  replacements: z.array(z.object({ previousStepId: uuid, stepId: uuid, capabilityId: uuid, capabilityVersionId: uuid }).strict()).min(1).max(8),
  committedSpendMinor: spend, remainingBudgetMinor: spend,
}).strict();
export const agentPlanResponseSchema = z.object({
  id: uuid, userId: uuid, conversationId: uuid.optional(), goal: z.string().min(1).max(12000), revision: count,
  constraints: agentBuyerConstraintsResponseSchema, timing: agentTimingPolicyResponseSchema,
  inputAssets: z.array(AssetDTOSchema.omit({ downloadUrl: true }).extend({ sizeBytes: count }).strict()).max(20).optional(),
  steps: z.array(agentPlanStepResponseSchema).min(1).max(32), estimatedCostMinor: spend, estimatedCompletionAt: isoDate,
  status: planStatus, approval: approval.optional(), retiredSteps: z.array(agentPlanStepResponseSchema).max(32).optional(),
  retainedWork: z.array(z.object({ stepId: uuid, jobId: uuid, outputHash: sha256 }).strict()).max(32).optional(),
  repairHistory: z.array(agentPlanRepairAuditResponseSchema).max(5).optional(),
  createdAt: isoDate, updatedAt: isoDate, error: z.string().optional(),
}).strict();

export const agentRecommendationResponseSchema = z.object({
  capabilityId: uuid, capabilityVersionId: uuid, capabilityTitle: z.string(), generatedAt: isoDate,
  reason: z.string(), matchedTerms: z.array(z.string()), preferred: z.boolean(),
  price: z.object({ currency: z.literal('USD'), amountMinor: spend, label: z.string() }).strict(),
  rating: z.object({ value: z.number().min(0).max(5).nullable(), reviewCount: count, label: z.string() }).strict(),
  timing: z.object({ status: AvailabilitySchema.shape.status, estimatedRuntimeSeconds: count, canRunNow: z.boolean(), canQueue: z.boolean(),
    nextAvailableAt: isoDate.nullable(), estimatedQueueWaitSeconds: z.number().finite().nonnegative().nullable(), label: z.string() }).strict(),
  permissions: z.object({ networkMode: z.enum(['NONE', 'RESEARCH', 'CONNECTORS']), tools: z.array(z.string()), resourceCount: count, label: z.string() }).strict(),
  io: z.object({ requiredInputs: z.array(z.object({ key: fieldKey, type: z.string() }).strict()), outputType,
    allowedMimeTypes: z.array(z.string()), allowedExtensions: z.array(z.string()), label: z.string() }).strict(),
  tradeoffs: z.array(z.string()), limitations: z.array(z.string()),
}).strict();
export const agentContractMatchIssueResponseSchema = z.object({
  code: z.enum(['INVALID_INPUT', 'INACTIVE_INPUT', 'MISSING_INPUT', 'FILE_COUNT_REQUIRED', 'FILE_NOT_ACCEPTED',
    'FILE_ASSIGNMENT_IMPOSSIBLE', 'AMBIGUOUS_FILE_ASSIGNMENT', 'CONDITIONAL_INPUT_UNRESOLVED', 'MATCHING_LIMIT',
    'OUTPUT_TYPE_UNSUPPORTED', 'OUTPUT_FILE_UNSUPPORTED', 'OUTPUT_COUNT_UNSUPPORTED', 'OUTPUT_SIZE_UNSUPPORTED', 'OUTPUT_NOT_GUARANTEED']),
  severity: z.enum(['INCOMPATIBLE', 'CLARIFICATION']), inputKey: fieldKey.optional(), assetId: uuid.optional(), requirementIndex: count.optional(),
}).strict();
export const agentContractMatchResponseSchema = z.object({
  capabilityId: uuid, capabilityVersionId: uuid, status: z.enum(['INCOMPATIBLE', 'NEEDS_INPUT', 'READY']), preparedInput: jsonObject,
  appliedDefaults: z.array(fieldKey), assetOptions: z.array(z.object({ assetId: uuid, inputKeys: z.array(fieldKey) }).strict()),
  issues: z.array(agentContractMatchIssueResponseSchema),
  output: z.object({ compatible: z.boolean(), guaranteed: z.boolean(), issues: z.array(agentContractMatchIssueResponseSchema) }).strict(),
}).strict();

const destination = z.object({ provider: z.string().min(1).max(100), model: z.string().min(1).max(200) }).strict();
const sourceJobIds = z.array(uuid).min(1).max(32).refine(ids => new Set(ids).size === ids.length);
export const agentSynthesisSourceResponseSchema = z.object({
  stepId: uuid, jobId: uuid, capabilityId: uuid, capabilityVersionId: uuid, outputHash: sha256,
  hasText: z.boolean(), hasJson: z.boolean(), fieldKeys: z.array(z.string()).max(50),
  assets: z.array(z.object({ id: uuid, filename: z.string().max(255), mimeType: z.string().max(150), sizeBytes: count, sha256 }).strict()).max(20),
}).strict();
export const agentSynthesisPreviewResponseSchema = z.object({
  planId: uuid, revision: count, sourceManifestHash: sha256, available: z.boolean(), processingDestinations: z.array(destination).max(2),
  sources: z.array(agentSynthesisSourceResponseSchema).min(1).max(32), fileContentsProcessed: z.literal(false), maxContentBytes: z.literal(24000),
}).strict();
export const agentSynthesisResponseSchema = z.object({
  id: uuid, kind: z.literal('AGENT_SYNTHESIS'), planId: uuid, planRevision: count, message: z.string().trim().min(1).max(12000),
  createdAt: isoDate, provider: destination, sources: z.array(agentSynthesisSourceResponseSchema).min(1).max(32), fileContentsProcessed: z.literal(false),
  consent: z.object({ acceptedAt: isoDate, sourceManifestHash: sha256, sourceJobIds, processingDestinations: z.array(destination).min(1).max(2) }).strict(),
}).strict();

export const agentConversationMessageResponseSchema = z.object({
  id: uuid, role: z.enum(['user', 'assistant']), content: z.string(), createdAt: isoDate,
  capabilityIds: z.array(uuid).optional(), planId: uuid.optional(), jobIds: z.array(uuid).optional(),
  synthesis: agentSynthesisResponseSchema.optional(), recommendationDetails: z.array(agentRecommendationResponseSchema).optional(),
  inputAssetIds: distinctIds(20).optional(), requiredOutputFiles: agentRequiredOutputFilesResponseSchema.optional(),
  contractMatches: z.array(agentContractMatchResponseSchema).optional(),
}).strict();
export const agentConversationResponseSchema = z.object({
  id: uuid, userId: uuid, createdAt: isoDate, messages: z.array(agentConversationMessageResponseSchema),
}).strict();
export const agentConversationsResponseSchema = z.array(agentConversationResponseSchema);
export const agentChatResponseSchema = z.object({
  conversationId: uuid, message: z.string(), recommendations: z.array(capability), plan: agentPlanResponseSchema.optional(),
  timingAlternatives: z.array(capability).optional(), recommendationDetails: z.array(agentRecommendationResponseSchema).optional(),
  contractMatches: z.array(agentContractMatchResponseSchema).optional(), inferenceStatus: z.enum(['READY', 'UNAVAILABLE', 'FAILED']),
}).strict();

export type AgentChatResponseDTO = z.infer<typeof agentChatResponseSchema>;
export type AgentConversationResponseDTO = z.infer<typeof agentConversationResponseSchema>;
export type AgentPlanResponseDTO = z.infer<typeof agentPlanResponseSchema>;
export type AgentSynthesisPreviewResponseDTO = z.infer<typeof agentSynthesisPreviewResponseSchema>;
export type AgentSynthesisResponseDTO = z.infer<typeof agentSynthesisResponseSchema>;

export const agentResponseRoutes: ResponseRoute[] = [
  ...responseRoutes('POST', ['/api/agent/chat'], agentChatResponseSchema),
  ...responseRoutes('GET', ['/api/agent/conversations'], agentConversationsResponseSchema),
  ...responseRoutes('GET', ['/api/agent/plans/:id'], agentPlanResponseSchema),
  ...responseRoutes('POST', ['/api/agent/plans/:id/approve', '/api/agent/plans/:id/repair', '/api/agent/plans/:id/replan'], agentPlanResponseSchema),
  ...responseRoutes('GET', ['/api/agent/plans/:id/synthesis-preview'], agentSynthesisPreviewResponseSchema),
  ...responseRoutes('POST', ['/api/agent/plans/:id/synthesize'], agentSynthesisResponseSchema),
];
