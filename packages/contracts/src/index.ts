import { z } from 'zod';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { FinancialBreakdownSchema } from './payment-policy.ts';
import { ResearchDownloadGrantSchema } from './research-downloads.ts';
import { DEFAULT_FILE_LIMITS, FILE_SAFETY_CEILINGS, ExecutionFileLimitsSchema } from './file-limits.ts';
export { ResearchDownloadGrantSchema, RESEARCH_DOWNLOAD_MIME_TYPES, type ResearchDownloadGrant } from './research-downloads.ts';
export { FinancialBreakdownSchema, prepaidFinancialBreakdown, PREPAID_PAYMENT_POLICY, type FinancialBreakdown } from './payment-policy.ts';
export { WorkerUsageReceiptSchema, type WorkerUsageReceipt } from './worker-usage.ts';
export { WorkerWarningCodeSchema, WorkerWarningSignalSchema, WorkerWarningSignalsSchema, WorkerSecurityWarningSchema,
  WorkerWarningSnapshotSchema, WORKER_WARNING_CATALOG, type WorkerWarningCode, type WorkerWarningSignal,
  type WorkerSecurityWarning, type WorkerWarningSnapshot } from './worker-warnings.ts';

export const SCHEMA_VERSION = 1 as const;
export const MAX_JOB_PAUSE_MS = 15 * 60_000;
export const JobPauseLimitSchema = z.number().int().min(1000).max(MAX_JOB_PAUSE_MS);
export const SUPPORTED_EXECUTION_TOOLS = Object.freeze(['read', 'write', 'edit', 'research.search', 'research.fetch', 'research.download', 'resource.read', 'resource.query', 'connector.call', 'blender.render', 'ffmpeg.transcode'] as const);
export const CATEGORIES = ['Research', 'Data & analytics', 'Writing & documents', 'Design & media', 'Development', 'Business'] as const;
export const PriceTierSchema = z.object({
  id: z.string(), currency: z.literal('USD'), buyerPriceMinor: z.number().int().positive(),
  platformFeeMinor: z.number().int().nonnegative(), sellerNetMinor: z.number().int().positive(),
  enabled: z.boolean(), sortOrder: z.number().int().nonnegative(),
}).strict().refine(t => t.buyerPriceMinor === t.platformFeeMinor + t.sellerNetMinor, 'Price tier does not balance');
export type PriceTier = z.infer<typeof PriceTierSchema>;
export type MarketplacePriceTier = PriceTier;
export const PRICE_TIERS: readonly PriceTier[] = Object.freeze([
  [99, 19, 80], [299, 59, 240], [499, 99, 400], [999, 199, 800], [1499, 299, 1200],
  [1999, 399, 1600], [2999, 599, 2400], [4999, 999, 4000], [9999, 1999, 8000],
].map(([buyerPriceMinor, platformFeeMinor, sellerNetMinor], sortOrder) => Object.freeze({
  id: `USD_${buyerPriceMinor}`, currency: 'USD' as const, buyerPriceMinor: buyerPriceMinor!,
  platformFeeMinor: platformFeeMinor!, sellerNetMinor: sellerNetMinor!, enabled: true, sortOrder,
})));
export function getPriceTier(id: string): PriceTier {
  const tier = PRICE_TIERS.find(t => t.id === id && t.enabled);
  if (!tier) throw new ContractError('INVALID_PRICE_TIER', 'Select an enabled platform price tier.');
  return { ...tier };
}

export class ContractError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); this.name = 'ContractError'; }
}
const Identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).refine(v => !['constructor', 'prototype', '__proto__'].includes(v));
const JsonObject = z.record(z.unknown());
export const InputFieldTypeSchema = z.enum(['SHORT_TEXT', 'LONG_TEXT', 'INTEGER', 'NUMBER', 'BOOLEAN', 'SELECT', 'MULTI_SELECT', 'URL', 'JSON', 'FILE', 'FILES']);
export type InputFieldType = z.infer<typeof InputFieldTypeSchema>;
export const InputConstraintsSchema = z.object({
  minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().min(1).max(100_000).optional(),
  minimum: z.number().finite().optional(), maximum: z.number().finite().optional(),
  allowedValues: z.array(z.string().max(500)).min(1).max(100).optional(),
  minFiles: z.number().int().nonnegative().max(20).optional(), maxFiles: z.number().int().positive().max(20).optional(),
  maxFileSizeBytes: z.number().int().positive().max(FILE_SAFETY_CEILINGS.singleFileBytes).optional(),
  maxTotalSizeBytes: z.number().int().positive().max(FILE_SAFETY_CEILINGS.totalBytes).optional(),
  allowedMimeTypes: z.array(z.string().max(150)).max(50).optional(),
  allowedExtensions: z.array(z.string().regex(/^\.[a-z0-9.]+$/)).max(50).optional(),
  jsonSchema: JsonObject.optional(), semanticType: z.string().max(100).optional(),
}).strict();
export const InputFieldSchema = z.object({
  key: Identifier, label: z.string().trim().min(1).max(160), type: InputFieldTypeSchema,
  required: z.boolean(), order: z.number().int().nonnegative(), description: z.string().max(2000).optional(),
  constraints: InputConstraintsSchema.optional(), default: z.unknown().optional(), group: z.string().max(100).optional(),
  visibleWhen: z.object({ key: Identifier, equals: z.union([z.string(), z.number(), z.boolean()]) }).strict().optional(),
}).strict().superRefine((f, ctx) => {
  const c = f.constraints;
  if (['FILE', 'FILES'].includes(f.type) && (!c?.allowedMimeTypes?.length || !c?.allowedExtensions?.length || !c.maxFileSizeBytes)) {
    ctx.addIssue({ code: 'custom', message: 'File inputs require MIME, extension and size restrictions.' });
  }
  if (['FILE', 'FILES'].includes(f.type) && f.default !== undefined) ctx.addIssue({ code: 'custom', message: 'File defaults are forbidden; the buyer must explicitly provide assets.' });
  if (['SELECT', 'MULTI_SELECT'].includes(f.type) && !c?.allowedValues?.length) ctx.addIssue({ code: 'custom', message: 'Choice inputs require allowedValues.' });
  if (c?.minimum !== undefined && c.maximum !== undefined && c.minimum > c.maximum) ctx.addIssue({ code: 'custom', message: 'Minimum must not exceed maximum.' });
  if (c?.minLength !== undefined && c.maxLength !== undefined && c.minLength > c.maxLength) ctx.addIssue({ code: 'custom', message: 'Invalid text length bounds.' });
  if (c?.minFiles !== undefined && c.minFiles > (f.type === 'FILE' ? 1 : c.maxFiles ?? 10)) ctx.addIssue({ code: 'custom', message: 'Minimum file count exceeds the permitted maximum.' });
});
export type InputField = z.infer<typeof InputFieldSchema>;
export type InputConstraints = z.infer<typeof InputConstraintsSchema>;
export const OutputFieldSchema = z.object({
  key: Identifier, label: z.string().trim().min(1).max(160),
  type: z.enum(['SHORT_TEXT', 'LONG_TEXT', 'MARKDOWN', 'INTEGER', 'NUMBER', 'BOOLEAN', 'SELECT', 'MULTI_SELECT', 'URL', 'JSON', 'FILE', 'FILES']),
  required: z.boolean(), order: z.number().int().nonnegative(), description: z.string().max(2000).optional(),
  constraints: InputConstraintsSchema.optional(), group: z.string().max(100).optional(),
}).strict().superRefine((field, ctx) => {
  const input = InputFieldSchema.safeParse({ ...field, type: field.type === 'MARKDOWN' ? 'LONG_TEXT' : field.type });
  if (!input.success) for (const issue of input.error.issues) ctx.addIssue(issue);
});
export type OutputField = z.infer<typeof OutputFieldSchema>;
export const OutputContractSchema = z.object({
  type: z.enum(['TEXT', 'JSON', 'FILES', 'MIXED']), description: z.string().max(4000), required: z.boolean(),
  jsonSchema: JsonObject.optional(),
  fields: z.array(OutputFieldSchema).max(50).optional(),
  files: z.object({
    allowedMimeTypes: z.array(z.string()).min(1), allowedExtensions: z.array(z.string()).min(1),
    maxFiles: z.number().int().min(1).max(FILE_SAFETY_CEILINGS.maxFiles), maxTotalSizeBytes: z.number().int().positive().max(FILE_SAFETY_CEILINGS.totalBytes),
  }).strict().optional(),
}).strict().superRefine((o, ctx) => {
  if (o.fields && new Set(o.fields.map(f => f.key)).size !== o.fields.length) ctx.addIssue({ code: 'custom', message: 'Output field keys must be unique.' });
  if (o.type === 'JSON' && !o.jsonSchema) ctx.addIssue({ code: 'custom', message: 'JSON output needs a JSON Schema.' });
  if (['FILES', 'MIXED'].includes(o.type) && !o.files) ctx.addIssue({ code: 'custom', message: 'File output needs explicit restrictions.' });
});
export const IOContractSchema = z.object({
  schemaVersion: z.literal(1), inputs: z.array(InputFieldSchema).max(50), output: OutputContractSchema,
}).strict().superRefine((c, ctx) => {
  const keys = new Set(c.inputs.map(f => f.key));
  if (keys.size !== c.inputs.length) ctx.addIssue({ code: 'custom', message: 'Input field keys must be unique.' });
  for (const f of c.inputs) if (f.visibleWhen && (!keys.has(f.visibleWhen.key) || f.visibleWhen.key === f.key)) ctx.addIssue({ code: 'custom', message: 'Conditional field refers to an invalid field.' });
  for (const field of c.inputs) {
    const chain = new Set<string>(); let cursor: InputField | undefined = field;
    while (cursor?.visibleWhen) {
      if (chain.has(cursor.key)) { ctx.addIssue({ code: 'custom', message: 'Conditional inputs cannot contain a dependency cycle.' }); break; }
      chain.add(cursor.key); cursor = c.inputs.find(f => f.key === cursor!.visibleWhen!.key);
    }
  }
});
export type IOContract = z.infer<typeof IOContractSchema>;

// The current reviewed adapter is deliberately narrower than object storage.
export const WORKER_FILE_FORMATS: Readonly<Record<string, string>> = Object.freeze({
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.blend': 'application/x-blender', '.mp4': 'video/mp4', '.wav': 'audio/wav',
  '.webp': 'image/webp', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.obj': 'model/obj', '.fbx': 'application/vnd.autodesk.fbx',
});
export function executionFileCompatibilityIssues(contract: IOContract): string[] {
  const issues: string[] = [];
  const check = (name: string, constraints?: Pick<InputConstraints, 'allowedExtensions' | 'allowedMimeTypes'>) => {
    if (!constraints) return;
    const extensions = constraints.allowedExtensions ?? [], mimes = constraints.allowedMimeTypes ?? [];
    for (const extension of extensions) {
      const mime = WORKER_FILE_FORMATS[extension.toLowerCase()];
      if (!mime) issues.push(`${name}: ${extension} is unsupported by the current worker.`);
      else if (!mimes.includes(mime)) issues.push(`${name}: ${extension} requires ${mime}.`);
    }
    for (const mime of mimes) if (!extensions.some(extension => WORKER_FILE_FORMATS[extension.toLowerCase()] === mime)) issues.push(`${name}: ${mime} has no supported declared extension.`);
  };
  for (const field of contract.inputs) if (field.type === 'FILE' || field.type === 'FILES') check(`Input ${field.label}`, field.constraints);
  check('Output files', contract.output.files);
  for (const field of contract.output.fields ?? []) if (field.type === 'FILE' || field.type === 'FILES') check(`Output ${field.label}`, field.constraints);
  return issues;
}
export type OutputContract = z.infer<typeof OutputContractSchema>;
export const DependencySchema = z.object({
  id: z.string().min(1).max(128), name: z.string().min(1).max(200), type: z.string().min(1).max(100),
  required: z.boolean(), approved: z.boolean(), healthy: z.boolean(),
  confidence: z.enum(['DECLARED', 'DETECTED', 'INFERRED']), details: z.string().max(4000).optional(),
  certainty: z.enum(['CONFIRMED', 'LIKELY', 'POSSIBLE', 'UNKNOWN']).optional(),
  dependsOn: z.array(z.string().min(1).max(128)).max(100).optional(),
  supported: z.boolean().optional(), source: z.string().max(500).optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  grants: z.object({
    tools: z.array(z.string().max(120)).max(50).optional(),
    resources: z.array(z.string().max(128)).max(50).optional(),
    domains: z.array(z.string().max(253)).max(50).optional(),
    inferenceProviders: z.array(z.string().max(100)).max(20).optional(),
    credentialRefs: z.array(z.string().max(200)).max(20).optional(),
  }).strict().optional(),
}).strict();
export type Dependency = z.infer<typeof DependencySchema>;
export const ResearchExecutionLimitsSchema = z.object({
  maxQueries: z.number().int().min(0).max(5).optional(),
  maxPages: z.number().int().min(0).max(5).optional(),
  maxResponseBytes: z.number().int().min(1).max(500_000).optional(),
  maxTotalBytes: z.number().int().min(1).max(5_000_000).optional(),
  maxDurationMs: z.number().int().min(1).max(60_000).optional(),
}).strict();
export const PermissionManifestSchema = z.object({
  schemaVersion: z.literal(1), tools: z.array(z.string().min(1).max(120)).max(50),
  network: z.object({ mode: z.enum(['NONE', 'RESEARCH', 'CONNECTORS']), allowedDomains: z.array(z.string().max(253)).max(50), researchLimits: ResearchExecutionLimitsSchema.optional(), downloads: ResearchDownloadGrantSchema.optional() }).strict(),
  resources: z.array(z.object({ id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/), type: z.string().max(100), access: z.literal('READ_ONLY') }).strict()).max(50),
  inference: z.object({ provider: z.string().min(1).max(100), model: z.string().min(1).max(200), credentialRef: z.string().max(200).optional() }).strict(),
  limits: z.object({
    timeoutSeconds: z.number().int().min(5).max(3600), memoryMb: z.number().int().min(128).max(8192),
    cpu: z.number().min(0.1).max(8), maxPids: z.number().int().min(16).max(512),
    maxInputBytes: z.number().int().positive().max(FILE_SAFETY_CEILINGS.singleFileBytes),
    maxOutputBytes: z.number().int().positive().max(FILE_SAFETY_CEILINGS.totalBytes), maxTokens: z.number().int().min(1).max(200_000),
  }).strict(),
}).strict().superRefine((permissions, context) => {
  const granted = permissions.tools.includes('research.download');
  if (granted !== !!permissions.network.downloads || granted && permissions.network.mode !== 'RESEARCH') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['network', 'downloads'], message: 'Downloads require an explicit versioned grant and research.download tool in RESEARCH mode' });
  }
});
export type PermissionManifest = z.infer<typeof PermissionManifestSchema>;

export const ExecutionManifestSchema = z.object({
  ioContract: IOContractSchema,
  permissions: PermissionManifestSchema,
  internalInstructions: z.string().max(50_000),
  dependencies: z.array(DependencySchema).max(100),
}).strict();
export type ExecutionManifest = z.infer<typeof ExecutionManifestSchema>;
export type ExecutionManifestSource = { [K in keyof ExecutionManifest]: unknown };
export function executionManifestProjection(value: ExecutionManifestSource): ExecutionManifest {
  return ExecutionManifestSchema.parse({ ioContract: validateContractDefinition(value.ioContract), permissions: value.permissions,
    internalInstructions: value.internalInstructions, dependencies: value.dependencies });
}
export function executionManifestHash(value: ExecutionManifestSource): string {
  return hashManifest(executionManifestProjection(value));
}

const Clock = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/);
const Timezone = z.string().refine(zone => { try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; } }, 'Use an IANA timezone');
const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Use an actual calendar date');
export const ScheduleSchema = z.object({
  mode: z.enum(['ALWAYS', 'WEEKLY', 'MANUAL']), timezone: Timezone,
  windows: z.array(z.object({ day: z.number().int().min(0).max(6), start: Clock, end: z.union([Clock, z.literal('24:00')]) }).strict()).max(28),
  overrides: z.array(z.object({ date: CalendarDate, available: z.boolean(), start: Clock.optional(), end: z.union([Clock, z.literal('24:00')]).optional() }).strict()).max(365),
}).strict().refine(schedule => new Set(schedule.overrides.map(override => override.date)).size === schedule.overrides.length, 'Only one override per date is allowed');
export type Schedule = z.infer<typeof ScheduleSchema>;
export const DEFAULT_SCHEDULE: Schedule = { mode: 'ALWAYS', timezone: 'UTC', windows: [], overrides: [] };
export const AvailabilitySchema = z.object({
  status: z.enum(['ONLINE', 'BUSY', 'SCHEDULED_OFFLINE', 'OFFLINE', 'PAUSED', 'SECURITY_BLOCKED']),
  canRunNow: z.boolean(), canQueue: z.boolean().optional(), nextAvailableAt: z.string().datetime().nullable(), reason: z.string().nullable(),
  estimatedQueueWaitSeconds: z.number().finite().nonnegative().optional(),
});
export type Availability = z.infer<typeof AvailabilitySchema>;
export const AssetDTOSchema = z.object({
  id: z.string().uuid(), filename: z.string().min(1).max(255), mimeType: z.string().min(1).max(150),
  sizeBytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), downloadUrl: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
}).strict();
export type AssetDTO = z.infer<typeof AssetDTOSchema>;
export const ExampleAssetDTOSchema = AssetDTOSchema.extend({ reusableTemplate: z.boolean().default(false) });
export type ExampleAssetDTO = z.infer<typeof ExampleAssetDTOSchema>;
export const CapabilityExampleDTOSchema = z.object({
  id: z.string().min(1).max(200), title: z.string().min(1).max(200), input: JsonObject, output: z.string(),
  description: z.string().max(2000).optional(), order: z.number().int().nonnegative().optional(),
  source: z.enum(['REAL_EXECUTION', 'SELLER_CURATED']).optional(),
  inputAssets: z.array(ExampleAssetDTOSchema).max(40).optional(), outputAssets: z.array(ExampleAssetDTOSchema).max(20).optional(),
  outputValue: z.lazy(() => JobOutputSchema).optional(),
  provenance: z.object({ capabilityVersionId: z.string().uuid(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/), completedAt: z.string().datetime().optional() }).optional(),
});
export type CapabilityExampleDTO = z.infer<typeof CapabilityExampleDTOSchema>;
export const CapabilityDTOSchema = z.object({
  executionFileLimits: ExecutionFileLimitsSchema.optional(),
  id: z.string().uuid(), slug: z.string(), title: z.string(), summary: z.string(), description: z.string(), category: z.string(), tags: z.array(z.string()),
  seller: z.object({ id: z.string().uuid(), name: z.string(), bio: z.string().optional() }),
  visibility: z.enum(['DRAFT', 'PRIVATE', 'UNLISTED', 'PUBLIC']), version: z.number().int(), versionId: z.string().uuid(),
  priceTierId: z.string(), ioContract: IOContractSchema, permissions: PermissionManifestSchema,
  dependencies: z.array(DependencySchema), availability: AvailabilitySchema, schedule: ScheduleSchema.optional(),
  estimatedDurationSeconds: z.number(), successRate: z.number().nullable(), completedJobs: z.number().int(),
  rating: z.number().nullable(), reviewCount: z.number().int(), isFavorite: z.boolean().optional(),
  pauseSupport: z.enum(['FULL_RESUME', 'RESTART_STEP', 'NOT_SUPPORTED']).optional(),
  dataProcessing: z.object({ assetRetentionDays: z.number().int().positive(), jobContentRetentionDays: z.number().int().positive(),
    inferenceProvider: z.string(), inferenceModel: z.string(), privateSellerRuntime: z.boolean() }).optional(),
  examples: z.array(CapabilityExampleDTOSchema),
});
export type CapabilityDTO = z.infer<typeof CapabilityDTOSchema>;
export const JobStateSchema = z.enum(['CREATED', 'PAYMENT_RESERVED', 'SCHEDULED', 'QUEUED', 'OFFERED', 'ACCEPTED', 'RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'RESUMING', 'UPLOADING_RESULTS', 'VALIDATING_RESULTS', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);
export type JobState = z.infer<typeof JobStateSchema>;
export const PaymentStateSchema = z.enum(['RESERVED', 'SETTLED', 'RELEASED', 'REFUNDED']);
export type PaymentState = z.infer<typeof PaymentStateSchema>;
export const JobOutputSchema = z.object({ text: z.string().max(1_000_000).optional(), json: z.unknown().optional(), assets: z.array(AssetDTOSchema).max(20).optional(), fields: JsonObject.optional() }).strict();
export type JobOutput = z.infer<typeof JobOutputSchema>;
export const JobWaitReasonSchema = z.enum(['WAITING_FOR_SCHEDULE', 'ELIGIBLE_BUT_WORKER_OFFLINE', 'PROVIDER_PAUSED', 'PROVIDER_UNAVAILABLE',
  'WAITING_FOR_CAPACITY', 'WAITING_FOR_WORKER_ACCEPTANCE', 'WAITING_FOR_WORKER_START', 'DISPATCH_PAUSED', 'WAIT_LIMIT_REACHED']);
export type JobWaitReason = z.infer<typeof JobWaitReasonSchema>;
export const JobDTOSchema = z.object({
  correlationId: z.string().uuid().optional(),
  id: z.string().uuid(), capabilityId: z.string().uuid(), capabilityVersionId: z.string().uuid(), capabilityTitle: z.string(),
  capabilityVersionNumber: z.number().int().positive().optional(), inputContract: z.array(InputFieldSchema).optional(), outputContract: OutputContractSchema.optional(),
  buyerId: z.string().uuid(), sellerId: z.string().uuid(), sellerName: z.string().min(1).max(100).nullable().optional(), state: JobStateSchema, paymentState: PaymentStateSchema,
  input: JsonObject, output: JobOutputSchema.nullable(), priceSnapshot: PriceTierSchema,
  financialBreakdown: FinancialBreakdownSchema.optional(),
  maxPauseMs: JobPauseLimitSchema.optional(), pausedDurationMs: z.number().int().nonnegative().optional(), pausedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string(), updatedAt: z.string(), scheduledAt: z.string().nullable(), startedAt: z.string().nullable(), completedAt: z.string().nullable(),
  originalScheduledAt: z.string().datetime().nullable().optional(), eligibleAt: z.string().datetime().nullable().optional(), queuedAt: z.string().datetime().nullable().optional(),
  waitDeadline: z.string().datetime().optional(), waitReason: JobWaitReasonSchema.nullable().optional(),
  contentDeletedAt: z.string().datetime().nullable().optional(), contentExpiresAt: z.string().datetime().nullable().optional(), pauseSupport: z.enum(['FULL_RESUME', 'RESTART_STEP', 'NOT_SUPPORTED']).optional(),
  error: z.string().nullable(), events: z.array(z.object({ id: z.string(), type: z.string(), message: z.string(), createdAt: z.string(), metadata: JsonObject.optional() })),
});
export type JobDTO = z.infer<typeof JobDTOSchema>;
export const JobOfferSchema = z.object({
  protocolVersion: z.literal(1), jobId: z.string().uuid(), attemptId: z.string().uuid(), workerId: z.string().uuid(),
  sellerId: z.string().uuid().optional(), maxPauseMs: JobPauseLimitSchema.optional(),
  capabilityVersionId: z.string().uuid(), expiresAt: z.string().datetime(), paymentSecured: z.literal(true),
  nonce: z.string().uuid(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/), input: JsonObject,
  ioContract: IOContractSchema, permissions: PermissionManifestSchema, internalInstructions: z.string().max(50_000),
  dependencies: z.array(DependencySchema).max(100), assets: z.array(AssetDTOSchema).max(20),
}).strict();
export type JobOffer = z.infer<typeof JobOfferSchema>;
export const SignedJobOfferSchema = z.object({ payload: JobOfferSchema, signature: z.string().min(1) }).strict();
export type SignedJobOffer = z.infer<typeof SignedJobOfferSchema>;
export const JobNoticeSchema = JobOfferSchema.omit({ input: true, internalInstructions: true, assets: true }).extend({ payloadHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type JobNotice = z.infer<typeof JobNoticeSchema>;
export const SignedJobNoticeSchema = z.object({ payload: JobNoticeSchema, signature: z.string().min(1) }).strict();
export type SignedJobNotice = z.infer<typeof SignedJobNoticeSchema>;

export function stableStringify(value: unknown): string {
  if (value === undefined) throw new ContractError('INVALID_JSON', 'Undefined is not a JSON value.');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
export function hashManifest(value: unknown): string { return bytesToHex(sha256(new TextEncoder().encode(stableStringify(value)))); }
const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: true, ownProperties: true });
addFormats(ajv);
const compiledSchemas = new Map<string, ValidateFunction>();
function compileJsonSchema(schema: Record<string, unknown>): ValidateFunction {
  if (JSON.stringify(schema).length > 20_000) throw new ContractError('INVALID_SCHEMA', 'JSON Schema is too large.');
  const inspect = (value: unknown, depth: number): void => {
    if (depth > 16) throw new ContractError('INVALID_SCHEMA', 'JSON Schema is too deeply nested.');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'pattern' || key === 'patternProperties' || (key === 'format' && child === 'regex')) throw new ContractError('INVALID_SCHEMA', 'Untrusted regular expressions are not permitted in contracts.');
      if (key === '$ref') throw new ContractError('INVALID_SCHEMA', 'Contract schemas must be self-contained and nonrecursive.');
      inspect(child, depth + 1);
    }
  };
  inspect(schema, 0);
  const key = stableStringify(schema), cached = compiledSchemas.get(key);
  if (cached) { compiledSchemas.delete(key); compiledSchemas.set(key, cached); return cached; }
  let validate: ValidateFunction;
  try { validate = ajv.compile(schema); }
  catch { throw new ContractError('INVALID_SCHEMA', 'Unsupported or invalid JSON Schema.'); }
  finally { ajv.removeSchema(schema); }
  compiledSchemas.set(key, validate);
  if (compiledSchemas.size > 128) compiledSchemas.delete(compiledSchemas.keys().next().value!);
  return validate;
}
function validateJson(schema: Record<string, unknown>, data: unknown): void {
  const validate = compileJsonSchema(schema);
  if (!validate(data)) throw new ContractError('INVALID_JSON', 'Structured value does not match its schema.', validate.errors);
}
export function validateContractDefinition(raw: unknown): IOContract {
  const contract = IOContractSchema.parse(raw);
  for (const field of [...contract.inputs, ...(contract.output.fields ?? [])]) if (field.constraints?.jsonSchema) compileJsonSchema(field.constraints.jsonSchema);
  if (contract.output.jsonSchema) compileJsonSchema(contract.output.jsonSchema);
  if (contract.output.fields?.some(field => ['FILE', 'FILES'].includes(field.type)) && !['FILES', 'MIXED'].includes(contract.output.type)) throw new ContractError('INVALID_CONTRACT', 'Named file outputs require a file-capable output envelope.');
  for (const field of contract.inputs) if (field.default !== undefined) {
    const { visibleWhen: _condition, ...unconditional } = field;
    validateInput({ schemaVersion: 1, inputs: [unconditional], output: { type: 'TEXT', description: '', required: false } }, {});
  }
  return contract;
}
function validateFileValue(field: InputField, value: unknown, assets?: AssetDTO[]): void {
  const refs = field.type === 'FILE' ? [value] : value;
  if (!Array.isArray(refs) || refs.some(v => typeof v !== 'string' || !z.string().uuid().safeParse(v).success)) throw new Error('Use uploaded asset IDs.');
  const c = field.constraints!;
  if (refs.length < (c.minFiles ?? (field.required ? 1 : 0)) || refs.length > (field.type === 'FILE' ? 1 : c.maxFiles ?? 10)) throw new Error('File count is outside the allowed range.');
  if (new Set(refs).size !== refs.length) throw new Error('Duplicate files are not allowed.');
  if (assets) {
    const selected = refs.map(id => assets.find(a => a.id === id));
    if (selected.some(a => !a)) throw new Error('File is unavailable or not authorized.');
    let total = 0;
    for (const asset of selected as AssetDTO[]) {
      total += asset.sizeBytes;
      if (asset.sizeBytes > (c.maxFileSizeBytes ?? DEFAULT_FILE_LIMITS.uploadBytes)) throw new Error('File is too large.');
      if (!c.allowedMimeTypes?.includes(asset.mimeType) || !c.allowedExtensions?.some(ext => asset.filename.toLowerCase().endsWith(ext))) throw new Error('File type is not allowed.');
    }
    if (total > (c.maxTotalSizeBytes ?? FILE_SAFETY_CEILINGS.singleFileBytes)) throw new Error('Total file size is too large.');
  }
}
export function validateInput(contract: IOContract, input: unknown, assets?: AssetDTO[]): Record<string, unknown> {
  const parsedContract = IOContractSchema.parse(contract);
  const parsed = JsonObject.safeParse(input);
  if (!parsed.success) throw new ContractError('INVALID_INPUT', 'Inputs must be an object.');
  const data = { ...parsed.data };
  const issues: { key: string; message: string }[] = [];
  for (const key of Object.keys(data)) if (!parsedContract.inputs.some(f => f.key === key)) issues.push({ key, message: 'Unknown input field.' });
  const visibility = new Map<string, boolean>();
  const resolveVisibility = (field: InputField): boolean => {
    if (visibility.has(field.key)) return visibility.get(field.key)!;
    const controller = field.visibleWhen ? parsedContract.inputs.find(f => f.key === field.visibleWhen!.key) : undefined;
    const visible = !field.visibleWhen || !!controller && resolveVisibility(controller) && data[controller.key] === field.visibleWhen.equals;
    visibility.set(field.key, visible);
    if (visible && data[field.key] === undefined && field.default !== undefined) data[field.key] = structuredClone(field.default);
    return visible;
  };
  for (const field of parsedContract.inputs) resolveVisibility(field);
  for (const f of parsedContract.inputs) {
    const visible = visibility.get(f.key);
    if (!visible) { if (data[f.key] !== undefined) issues.push({ key: f.key, message: 'Field is not active for these inputs.' }); continue; }
    const v = data[f.key];
    if (v === undefined || v === null || v === '') { if (f.required) issues.push({ key: f.key, message: 'This field is required.' }); continue; }
    const c = f.constraints ?? {};
    try {
      if (['SHORT_TEXT', 'LONG_TEXT', 'URL', 'SELECT'].includes(f.type)) {
        if (typeof v !== 'string') throw new Error('Expected text.');
        if (v.length < (c.minLength ?? 0) || v.length > (c.maxLength ?? (f.type === 'SHORT_TEXT' ? 500 : 10_000))) throw new Error('Text length is outside the allowed range.');
        if (f.type === 'SELECT' && !c.allowedValues?.includes(v)) throw new Error('Select an allowed option.');
        if (f.type === 'URL') { const url = new URL(v); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Expected an HTTP(S) URL without credentials.'); }
      } else if (f.type === 'NUMBER' || f.type === 'INTEGER') {
        if (typeof v !== 'number' || !Number.isFinite(v) || (f.type === 'INTEGER' && !Number.isSafeInteger(v))) throw new Error('Expected a valid number.');
        if ((c.minimum !== undefined && v < c.minimum) || (c.maximum !== undefined && v > c.maximum)) throw new Error('Number is outside the allowed range.');
      } else if (f.type === 'BOOLEAN') { if (typeof v !== 'boolean') throw new Error('Expected true or false.'); }
      else if (f.type === 'MULTI_SELECT') { if (!Array.isArray(v) || new Set(v).size !== v.length || v.some(s => typeof s !== 'string' || !c.allowedValues?.includes(s))) throw new Error('Select distinct allowed options.'); }
      else if (f.type === 'JSON') { if (c.jsonSchema) validateJson(c.jsonSchema, v); else if (!v || typeof v !== 'object') throw new Error('Expected a structured object or array.'); }
      else validateFileValue(f, v, assets);
    } catch (e) { issues.push({ key: f.key, message: e instanceof Error ? e.message : 'Invalid value.' }); }
  }
  if (issues.length) throw new ContractError('INVALID_INPUT', 'Check the capability inputs.', issues);
  return data;
}
export function validateOutput(contract: IOContract, output: unknown): JobOutput {
  const definition = IOContractSchema.parse(contract).output;
  const value = JobOutputSchema.parse(output);
  if (definition.type === 'TEXT' && value.json !== undefined) throw new ContractError('INVALID_OUTPUT', 'This contract allows only text.');
  if (definition.type === 'JSON' && value.text !== undefined) throw new ContractError('INVALID_OUTPUT', 'This contract allows only structured output.');
  if (definition.type === 'FILES' && (value.text !== undefined || value.json !== undefined)) throw new ContractError('INVALID_OUTPUT', 'This contract allows only file output.');
  if (definition.type === 'MIXED' && value.json !== undefined) {
    if (!definition.jsonSchema) throw new ContractError('INVALID_OUTPUT', 'Undeclared structured output is not allowed.');
    validateJson(definition.jsonSchema, value.json);
  }
  if (value.fields !== undefined && !definition.fields?.length) throw new ContractError('INVALID_OUTPUT', 'Undeclared output fields are not allowed.');
  if (definition.type === 'TEXT' || definition.type === 'MIXED') {
    if (definition.required && !value.text?.trim()) throw new ContractError('INVALID_OUTPUT', 'A nonempty text result is required.');
  }
  if (definition.type === 'JSON') { if (definition.required && value.json === undefined) throw new ContractError('INVALID_OUTPUT', 'A structured result is required.'); if (value.json !== undefined) validateJson(definition.jsonSchema!, value.json); }
  if (definition.type === 'FILES' || definition.type === 'MIXED') {
    const files = value.assets ?? [];
    if (definition.required && files.length === 0) throw new ContractError('INVALID_OUTPUT', 'At least one generated file is required.');
    const limits = definition.files!;
    if (files.length > limits.maxFiles || files.reduce((sum, a) => sum + a.sizeBytes, 0) > limits.maxTotalSizeBytes) throw new ContractError('INVALID_OUTPUT', 'Generated files exceed contract limits.');
    if (new Set(files.map(f => f.id)).size !== files.length) throw new ContractError('INVALID_OUTPUT', 'Duplicate result assets.');
    for (const a of files) if (!limits.allowedMimeTypes.includes(a.mimeType) || !limits.allowedExtensions.some(ext => a.filename.toLowerCase().endsWith(ext))) throw new ContractError('INVALID_OUTPUT', 'Generated file type is not allowed.');
  } else if (value.assets?.length) throw new ContractError('INVALID_OUTPUT', 'The output contract does not allow files.');
  if (definition.fields?.length) validateInput({ schemaVersion: 1, inputs: definition.fields.map(field => ({ ...field, type: field.type === 'MARKDOWN' ? 'LONG_TEXT' : field.type })), output: { type: 'TEXT', description: '', required: false } }, value.fields ?? {}, value.assets ?? []);
  return value;
}

export const CreateCapabilitySchema = z.object({
  title: z.string().trim().min(3).max(120), summary: z.string().trim().min(10).max(300), description: z.string().max(12_000),
  category: z.string().min(1).max(100), tags: z.array(z.string().trim().min(1).max(40)).max(12),
  priceTierId: z.string().refine(id => PRICE_TIERS.some(t => t.id === id)), ioContract: IOContractSchema,
  permissions: PermissionManifestSchema, dependencies: z.array(DependencySchema).max(100),
  schedule: ScheduleSchema.optional(), estimatedDurationSeconds: z.number().int().positive().max(3600),
  concurrency: z.number().int().min(1).max(4).optional(), maxQueue: z.number().int().min(0).max(10).optional(),
  maxScheduled: z.number().int().min(0).max(20).optional(),
  internalInstructions: z.string().min(1).max(50_000), workerId: z.string().uuid().optional(),
  examples: z.array(z.object({ id: z.string(), title: z.string().max(200), input: JsonObject, output: z.string().max(10_000) })).max(10).optional(),
}).strict();
