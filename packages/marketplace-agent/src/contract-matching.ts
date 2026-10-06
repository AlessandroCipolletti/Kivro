import {
  AssetDTOSchema, ContractError, validateContractDefinition, validateInput,
  type InputField, type IOContract,
} from '@kivro/contracts';
import { z } from 'zod';

const MAX_ASSIGNMENT_STATES = 4096;
export const MAX_MATCH_INPUT_ASSETS = 20;
const fieldKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  .refine(key => !['__proto__', 'constructor', 'prototype'].includes(key));

/** Server-resolved metadata only. Parsing this does NOT establish ownership or scan status. */
export const ResolvedInputAssetSchema = AssetDTOSchema.omit({ downloadUrl: true }).extend({
  sizeBytes: z.number().int().nonnegative().safe(),
}).strict();
export type ResolvedInputAsset = z.infer<typeof ResolvedInputAssetSchema>;
const assetsSchema = z.array(ResolvedInputAssetSchema).max(MAX_MATCH_INPUT_ASSETS)
  .refine(assets => new Set(assets.map(asset => asset.id)).size === assets.length, 'Duplicate asset metadata.');

export const RequiredOutputFilesSchema = z.array(z.object({
  extension: z.string().regex(/^\.[a-z0-9.]+$/).max(40).optional(),
  mimeType: z.string().max(150).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/).optional(),
  count: z.number().int().min(1).max(20),
}).strict().refine(value => value.extension !== undefined || value.mimeType !== undefined,
  'Request a MIME type or extension.')).min(1).max(20)
  .refine(files => files.reduce((sum, file) => sum + file.count, 0) <= 20, 'Request at most 20 files in total.')
  .refine(files => new Set(files.map(file => `${file.extension ?? ''}:${file.mimeType ?? ''}`)).size === files.length,
    'Combine duplicate format selectors using count.');
export type RequiredOutputFiles = z.infer<typeof RequiredOutputFilesSchema>;

export const OutputRequirementsSchema = z.object({
  types: z.array(z.enum(['TEXT', 'JSON', 'FILES', 'MIXED'])).min(1).max(4).optional(),
  // Each entry describes a distinct group of desired files, not alternative formats.
  files: z.array(z.object({
    mimeType: z.string().min(1).max(150).optional(),
    extension: z.string().regex(/^\.[a-z0-9.]+$/).max(40).optional(),
    minCount: z.number().int().min(1).max(20).default(1),
    sourceField: fieldKey.optional(),
    maxFileSizeBytes: z.number().int().positive().safe().optional(),
    maxTotalSizeBytes: z.number().int().positive().safe().optional(),
  }).strict().refine(value => value.mimeType !== undefined || value.extension !== undefined,
    'Request a MIME type or extension.')).min(1).max(20).optional(),
}).strict();
export type OutputRequirements = z.infer<typeof OutputRequirementsSchema>;

export interface ContractMatchIssue {
  code: 'INVALID_INPUT' | 'INACTIVE_INPUT' | 'MISSING_INPUT' | 'FILE_COUNT_REQUIRED' |
    'FILE_NOT_ACCEPTED' | 'FILE_ASSIGNMENT_IMPOSSIBLE' | 'AMBIGUOUS_FILE_ASSIGNMENT' |
    'CONDITIONAL_INPUT_UNRESOLVED' | 'MATCHING_LIMIT' | 'OUTPUT_TYPE_UNSUPPORTED' |
    'OUTPUT_FILE_UNSUPPORTED' | 'OUTPUT_COUNT_UNSUPPORTED' | 'OUTPUT_SIZE_UNSUPPORTED' |
    'OUTPUT_NOT_GUARANTEED';
  severity: 'INCOMPATIBLE' | 'CLARIFICATION';
  inputKey?: string;
  assetId?: string;
  requirementIndex?: number;
}
export interface OutputMatch {
  compatible: boolean;
  /** A maximum or an allowlist alone never guarantees a requested number/format of files. */
  guaranteed: boolean;
  issues: ContractMatchIssue[];
}
export interface DirectContractMatch {
  status: 'INCOMPATIBLE' | 'NEEDS_INPUT' | 'READY';
  /** Partial preparation, not purchase authority. Use only after status READY and fresh API validation. */
  preparedInput: Record<string, unknown>;
  appliedDefaults: string[];
  assetOptions: { assetId: string; inputKeys: string[] }[];
  issues: ContractMatchIssue[];
  output: OutputMatch;
}
export interface ContractInputContext {
  contract: IOContract;
  /** API must resolve the buyer's explicit ID set by owner, scan, deletion and expiry first. */
  assets: readonly ResolvedInputAsset[];
  input?: Record<string, unknown>;
  allowSellerDefaults?: boolean;
  /** Server time (or scheduled start); never accept a buyer-supplied clock. */
  now?: Date;
}

function resolvedAssets(raw: readonly ResolvedInputAsset[], now = new Date()): ResolvedInputAsset[] {
  const assets = assetsSchema.parse(raw);
  if (!Number.isFinite(now.getTime())) throw new ContractError('INVALID_TIME', 'Use a valid server time.');
  if (assets.some(asset => asset.expiresAt !== undefined && Date.parse(asset.expiresAt) <= now.getTime())) {
    throw new ContractError('ASSET_NOT_AVAILABLE', 'An input asset has expired.');
  }
  return assets;
}

/** Filename, URLs, hashes, storage paths and file contents are intentionally not inference hints. */
export function inputAssetHints(assets: readonly ResolvedInputAsset[], now?: Date) {
  return resolvedAssets(assets, now).map(({ id, mimeType, sizeBytes, filename }) => {
    const extension = /\.[a-z0-9]{1,20}$/i.exec(filename)?.[0].toLowerCase();
    return { id, mimeType, sizeBytes, ...(extension ? { extension } : {}) };
  });
}

const isFile = (field: { type: string }) => field.type === 'FILE' || field.type === 'FILES';
const missing = (value: unknown) => value === undefined || value === null || value === '';
type Visibility = 'ACTIVE' | 'INACTIVE' | 'UNRESOLVED';
const noOutput: IOContract['output'] = { type: 'TEXT', description: '', required: false };

function validateField(field: InputField, value: unknown, assets: ResolvedInputAsset[]): boolean {
  const { visibleWhen: _condition, default: _default, ...unconditional } = field;
  try {
    validateInput({ schemaVersion: 1, inputs: [{ ...unconditional, required: false }], output: noOutput },
      { [field.key]: value }, assets);
    return true;
  } catch { return false; }
}

function inputContext(request: ContractInputContext) {
  const contract = validateContractDefinition(request.contract);
  const assets = resolvedAssets(request.assets, request.now);
  const source = request.input ?? {};
  if (!source || Array.isArray(source) || typeof source !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(source))) {
    throw new ContractError('INVALID_INPUT', 'Inputs must be an object.');
  }
  const input: Record<string, unknown> = {};
  const issues: ContractMatchIssue[] = [];
  const appliedDefaults: string[] = [];
  for (const key of Object.keys(source)) {
    if (!contract.inputs.some(field => field.key === key)) issues.push({ code: 'INVALID_INPUT', severity: 'INCOMPATIBLE' });
    else input[key] = structuredClone(source[key]);
  }
  const visibility = new Map<string, Visibility>();
  function resolve(field: InputField): Visibility {
    const cached = visibility.get(field.key);
    if (cached) return cached;
    let state: Visibility = 'ACTIVE';
    if (field.visibleWhen) {
      const controller = contract.inputs.find(item => item.key === field.visibleWhen!.key)!;
      const controllerState = resolve(controller);
      state = controllerState === 'INACTIVE' ? 'INACTIVE' : controllerState === 'UNRESOLVED' || missing(input[controller.key]) ?
        'UNRESOLVED' : input[controller.key] === field.visibleWhen.equals ? 'ACTIVE' : 'INACTIVE';
    }
    visibility.set(field.key, state);
    if (state === 'ACTIVE' && input[field.key] === undefined && request.allowSellerDefaults === true && field.default !== undefined) {
      input[field.key] = structuredClone(field.default);
      appliedDefaults.push(field.key);
    }
    return state;
  }
  for (const field of contract.inputs) resolve(field);
  for (const field of contract.inputs) {
    if (input[field.key] === undefined) continue;
    const state = visibility.get(field.key)!;
    if (state === 'INACTIVE') issues.push({ code: 'INACTIVE_INPUT', severity: 'INCOMPATIBLE', inputKey: field.key });
    if (state === 'UNRESOLVED') issues.push({ code: 'CONDITIONAL_INPUT_UNRESOLVED', severity: 'CLARIFICATION', inputKey: field.key });
    if (!validateField(field, input[field.key], assets)) issues.push({ code: 'INVALID_INPUT', severity: 'INCOMPATIBLE', inputKey: field.key });
  }
  return { contract, assets, input, issues, appliedDefaults, visibility };
}

function fileRefs(field: InputField, value: unknown): string[] {
  if (missing(value)) return [];
  return field.type === 'FILE' ? [value as string] : value as string[];
}

function fits(field: InputField, selected: ResolvedInputAsset[]): boolean {
  // Discovery can ask for further required files; this pass tests only the hard upper bounds.
  const limits = field.constraints!;
  return selected.length <= (field.type === 'FILE' ? 1 : limits.maxFiles ?? 10) &&
    selected.reduce((sum, asset) => sum + asset.sizeBytes, 0) <= (limits.maxTotalSizeBytes ?? 100 * 1024 ** 2) &&
    selected.every(asset => asset.sizeBytes <= limits.maxFileSizeBytes! && limits.allowedMimeTypes!.includes(asset.mimeType) &&
      limits.allowedExtensions!.some(extension => asset.filename.toLowerCase().endsWith(extension)));
}

/** Single-capability discovery only. Do NOT run this against every step in a plan. */
export function matchDirectContract(request: ContractInputContext & { outputRequirements?: OutputRequirements }): DirectContractMatch {
  const context = inputContext(request);
  const { contract, assets, input, issues, visibility } = context;
  const output = matchOutputRequirements(contract, request.outputRequirements);
  const assetOptions: DirectContractMatch['assetOptions'] = [];
  if (!issues.some(issue => issue.severity === 'INCOMPATIBLE')) {
    const used = new Set(contract.inputs.filter(isFile).flatMap(field => fileRefs(field, input[field.key])));
    const remaining = assets.filter(asset => !used.has(asset.id));
    const fields = contract.inputs.filter(field => isFile(field) && missing(input[field.key]) && visibility.get(field.key) !== 'INACTIVE');
    for (const asset of remaining) {
      const inputKeys = fields.filter(field => fits(field, [asset])).map(field => field.key);
      assetOptions.push({ assetId: asset.id, inputKeys });
      if (!inputKeys.length) issues.push({ code: 'FILE_NOT_ACCEPTED', severity: 'INCOMPATIBLE', assetId: asset.id });
    }
    if (remaining.length && !issues.some(issue => issue.severity === 'INCOMPATIBLE')) {
      const ordered = [...remaining].sort((a, b) => assetOptions.find(item => item.assetId === a.id)!.inputKeys.length -
        assetOptions.find(item => item.assetId === b.id)!.inputKeys.length || a.id.localeCompare(b.id));
      const assignments = new Map<string, ResolvedInputAsset[]>();
      const solutions: Map<string, ResolvedInputAsset[]>[] = [];
      let states = 0;
      let limited = false;
      function search(index: number): void {
        if (++states > MAX_ASSIGNMENT_STATES) { limited = true; return; }
        if (index === ordered.length) { solutions.push(new Map([...assignments].map(([key, values]) => [key, [...values]]))); return; }
        const asset = ordered[index]!;
        const options = assetOptions.find(item => item.assetId === asset.id)!.inputKeys;
        for (const key of options) {
          const field = fields.find(item => item.key === key)!;
          const previous = assignments.get(key) ?? [];
          const selected = [...previous, asset];
          if (!fits(field, selected)) continue;
          assignments.set(key, selected);
          search(index + 1);
          if (previous.length) assignments.set(key, previous); else assignments.delete(key);
          if (solutions.length >= 2 || limited) return;
        }
      }
      search(0);
      if (limited) issues.push({ code: 'MATCHING_LIMIT', severity: 'CLARIFICATION' });
      else if (!solutions.length) issues.push({ code: 'FILE_ASSIGNMENT_IMPOSSIBLE', severity: 'INCOMPATIBLE' });
      else if (solutions.length > 1) issues.push({ code: 'AMBIGUOUS_FILE_ASSIGNMENT', severity: 'CLARIFICATION' });
      else for (const [key, selected] of solutions[0]!) {
        if (visibility.get(key) !== 'ACTIVE') issues.push({ code: 'CONDITIONAL_INPUT_UNRESOLVED', severity: 'CLARIFICATION', inputKey: key });
        else input[key] = fields.find(field => field.key === key)!.type === 'FILE' ? selected[0]!.id : selected.map(asset => asset.id);
      }
    }
    for (const field of contract.inputs) {
      if (visibility.get(field.key) !== 'ACTIVE') continue;
      const value = input[field.key];
      if (missing(value) && field.required) issues.push({ code: 'MISSING_INPUT', severity: 'CLARIFICATION', inputKey: field.key });
      else if (isFile(field) && !missing(value) && fileRefs(field, value).length < (field.constraints?.minFiles ?? (field.required ? 1 : 0))) {
        issues.push({ code: 'FILE_COUNT_REQUIRED', severity: 'CLARIFICATION', inputKey: field.key });
      }
    }
  }
  if (!issues.length) {
    const preparedContract = { ...contract, inputs: contract.inputs.map(field => {
      const { default: _default, ...withoutDefault } = field;
      return request.allowSellerDefaults === true ? field : withoutDefault;
    }) };
    try { validateInput(preparedContract, input, assets); }
    catch { issues.push({ code: 'INVALID_INPUT', severity: 'INCOMPATIBLE' }); }
  }
  issues.push(...output.issues);
  const status = issues.some(issue => issue.severity === 'INCOMPATIBLE') ? 'INCOMPATIBLE' : issues.length ? 'NEEDS_INPUT' : 'READY';
  return { status, preparedInput: input, appliedDefaults: context.appliedDefaults, assetOptions, issues, output };
}

/** Check explicit literal buyer-file mappings only; other inputs can be supplied by upstream steps.
 * Pass ALL literal step inputs for condition evaluation. DAG edge validation remains separate.
 * assets is the approved buyer attachment set, not every asset that the buyer happens to own.
 */
export function validatePlanEntryAssets(request: ContractInputContext): {
  valid: boolean; assetIds: string[]; issues: ContractMatchIssue[];
} {
  const { contract, input, issues } = inputContext(request);
  if (!issues.length) for (const field of contract.inputs.filter(isFile)) {
    if (!Object.hasOwn(input, field.key)) continue;
    if (field.required && missing(input[field.key])) issues.push({ code: 'MISSING_INPUT', severity: 'CLARIFICATION', inputKey: field.key });
    else if (!missing(input[field.key]) && fileRefs(field, input[field.key]).length < (field.constraints?.minFiles ?? (field.required ? 1 : 0))) {
      issues.push({ code: 'FILE_COUNT_REQUIRED', severity: 'CLARIFICATION', inputKey: field.key });
    }
  }
  const assetIds = issues.length ? [] : [...new Set(contract.inputs.filter(isFile).flatMap(field => fileRefs(field, input[field.key])))];
  return { valid: issues.length === 0, assetIds, issues };
}

/** Evaluate only the selected final-output producer(s), never every intermediate plan step. */
export function matchOutputRequirements(rawContract: IOContract, rawRequirements?: OutputRequirements): OutputMatch {
  const output = validateContractDefinition(rawContract).output;
  const requirements = OutputRequirementsSchema.parse(rawRequirements ?? {});
  const issues: ContractMatchIssue[] = [];
  if (requirements.types && !requirements.types.includes(output.type)) issues.push({ code: 'OUTPUT_TYPE_UNSUPPORTED', severity: 'INCOMPATIBLE' });
  const requests = requirements.files ?? [];
  const envelope = output.files;
  let guaranteed = !requests.length;
  if (requests.length && (!['FILES', 'MIXED'].includes(output.type) || !envelope)) {
    issues.push({ code: 'OUTPUT_FILE_UNSUPPORTED', severity: 'INCOMPATIBLE' });
  } else if (envelope && requests.length) {
    if (requests.reduce((sum, request) => sum + request.minCount, 0) > envelope.maxFiles) {
      issues.push({ code: 'OUTPUT_COUNT_UNSUPPORTED', severity: 'INCOMPATIBLE' });
    }
    const requestedByField = new Map<string, number>();
    for (const request of requests) if (request.sourceField) requestedByField.set(request.sourceField,
      (requestedByField.get(request.sourceField) ?? 0) + request.minCount);
    // Different format groups cannot reuse the same file. Overlapping groups need explicit clarification.
    guaranteed = requests.every((request, index) => requests.slice(index + 1).every(other =>
      request.mimeType && other.mimeType && request.mimeType !== other.mimeType ||
      request.extension && other.extension && !request.extension.endsWith(other.extension) && !other.extension.endsWith(request.extension)));
    for (const [requirementIndex, request] of requests.entries()) {
      const named = request.sourceField ? output.fields?.find(field => field.key === request.sourceField) : undefined;
      if (request.sourceField && (!named || !isFile(named))) {
        issues.push({ code: 'OUTPUT_FILE_UNSUPPORTED', severity: 'INCOMPATIBLE', requirementIndex }); continue;
      }
      const c = named?.constraints;
      const mimeTypes = c?.allowedMimeTypes ? envelope.allowedMimeTypes.filter(mime => c.allowedMimeTypes!.includes(mime)) : envelope.allowedMimeTypes;
      const extensions = c?.allowedExtensions ? [...new Set(envelope.allowedExtensions.flatMap(outer => c.allowedExtensions!
        .flatMap(inner => inner.endsWith(outer) ? [inner] : outer.endsWith(inner) ? [outer] : [])))] : envelope.allowedExtensions;
      if (!mimeTypes.length || !extensions.length || request.mimeType && !mimeTypes.includes(request.mimeType) ||
          request.extension && !extensions.some(ext => request.extension!.endsWith(ext))) {
        issues.push({ code: 'OUTPUT_FILE_UNSUPPORTED', severity: 'INCOMPATIBLE', requirementIndex });
      }
      const maxCount = Math.min(envelope.maxFiles, named?.type === 'FILE' ? 1 : c?.maxFiles ?? (named ? 10 : envelope.maxFiles));
      if ((request.sourceField ? requestedByField.get(request.sourceField)! : request.minCount) > maxCount ||
          named?.required && (named.type === 'FILE' ? 1 : c?.minFiles ?? 1) > maxCount) {
        issues.push({ code: 'OUTPUT_COUNT_UNSUPPORTED', severity: 'INCOMPATIBLE', requirementIndex });
      }
      const maxTotal = Math.min(envelope.maxTotalSizeBytes, named ? c?.maxTotalSizeBytes ?? 100 * 1024 ** 2 : envelope.maxTotalSizeBytes);
      const maxPerFile = Math.min(maxTotal, c?.maxFileSizeBytes ?? maxTotal);
      if (request.maxFileSizeBytes !== undefined && maxPerFile > request.maxFileSizeBytes ||
          request.maxTotalSizeBytes !== undefined && maxTotal > request.maxTotalSizeBytes) {
        issues.push({ code: 'OUTPUT_SIZE_UNSUPPORTED', severity: 'INCOMPATIBLE', requirementIndex });
      }
      let minCount = named ? named.required ? named.type === 'FILE' ? 1 : c?.minFiles ?? 1 : 0 : output.required ? 1 : 0;
      let narrow = !(request.mimeType && mimeTypes.some(mime => mime !== request.mimeType) ||
        request.extension && extensions.some(ext => !ext.endsWith(request.extension!)));
      if (!named) for (const field of output.fields ?? []) {
        if (!field.required || !isFile(field)) continue;
        const namedMatch = matchOutputRequirements(rawContract, { files: [{ ...request, sourceField: field.key }] });
        if (namedMatch.guaranteed) { minCount = Math.max(minCount, request.minCount); narrow = true; }
      }
      if (minCount < request.minCount || !narrow) guaranteed = false;
    }
  }
  const compatible = !issues.some(issue => issue.severity === 'INCOMPATIBLE');
  guaranteed = guaranteed && compatible;
  if (compatible && !guaranteed) issues.push({ code: 'OUTPUT_NOT_GUARANTEED', severity: 'CLARIFICATION' });
  return { compatible, guaranteed, issues };
}

/** Final constraints are satisfied by terminal producers collectively, not by every DAG step. */
export function matchPlanFinalOutputs(contracts: IOContract[], requirements: OutputRequirements): boolean {
  const parsed = OutputRequirementsSchema.parse(requirements);
  const finals = contracts.map(contract => validateContractDefinition(contract));
  if (parsed.types && !finals.some(contract => parsed.types!.includes(contract.output.type))) return false;
  const requests = parsed.files ?? [];
  const assigned = new Map<number, NonNullable<OutputRequirements['files']>>();
  let states = 0;
  function search(index: number): boolean {
    if (++states > MAX_ASSIGNMENT_STATES) return false;
    if (index === requests.length) return true;
    for (const [producer, contract] of finals.entries()) {
      const previous = assigned.get(producer) ?? [];
      const files = [...previous, requests[index]!];
      if (!matchOutputRequirements(contract, { files }).guaranteed) continue;
      assigned.set(producer, files);
      if (search(index + 1)) return true;
      if (previous.length) assigned.set(producer, previous); else assigned.delete(producer);
    }
    return false;
  }
  return search(0);
}
