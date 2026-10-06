import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { AssetDTOSchema, CapabilityExampleDTOSchema, IOContractSchema, JobOutputSchema, hashManifest, stableStringify, validateInput, validateOutput,
  type AssetDTO, type CapabilityExampleDTO, type JobOutput } from '@kivro/contracts';
import { inspectFile, safeFilename, scanWithClamAv, sha256 } from '@kivro/storage';
import { json, serializable, type Asset, type CapabilityExampleAsset, type CapabilityVersion, type PrismaClient, type Transaction } from '@kivro/database';
import type { FastifyInstance } from 'fastify';
import type { ApiContext } from './context.js';
import { requireIdentity } from './auth.js';
import { ApiError, requireValue } from './errors.js';
import { assertCapabilityAccess, capabilityInclude, loadCapability, type CapabilityRecord } from './catalog.js';
import { assertLifecycleRevision, LifecycleCAS, lockCapability, ownedVersion, sellerCapability, versionHistory, versionSnapshot } from './capability-lifecycle.js';
import { abandonObject, commitObject, stageObject } from './pending-objects.js';

type Db = PrismaClient | Transaction;
type FileFields = ReadonlyArray<{ key: string; type: string }>;
type StagedObject = Awaited<ReturnType<typeof stageObject>>;
const MAX_COPY_BYTES = 100 * 1024 ** 2;
export const StoredExampleSchema = CapabilityExampleDTOSchema.extend({ provenance: z.object({ manifestHash: z.string() }).passthrough().optional() });
type StoredExample = z.infer<typeof StoredExampleSchema>;
const Promotion = z.object({ expectedRevision: z.number().int().nonnegative(), title: z.string().trim().min(1).max(200), description: z.string().max(2000).optional(), confirmPublic: z.literal(true),
  approvedAssetIds: z.array(z.string().uuid()).max(40).default([]), reusableInputAssetIds: z.array(z.string().uuid()).max(40).default([]), replaceExampleId: z.string().min(1).max(200).optional() });
type PromotionBody = z.infer<typeof Promotion>;

function metadata(asset: Pick<Asset, 'id' | 'filename' | 'mimeType' | 'sizeBytes' | 'sha256'>): AssetDTO {
  return { id: asset.id, filename: asset.filename, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, sha256: asset.sha256 };
}
function fileIds(fields: FileFields, values: Record<string, unknown>): string[] {
  return [...new Set(fields.flatMap(field => {
    const value = values[field.key];
    if (!['FILE', 'FILES'].includes(field.type) || value === undefined || value === null || value === '') return [];
    return z.array(z.string().uuid()).max(40).parse(field.type === 'FILE' ? [value] : value);
  }))];
}
function remapFiles(fields: FileFields, input: Record<string, unknown>, ids: Map<string, string>, partial = false) {
  const result = { ...input };
  for (const field of fields) {
    if (!['FILE', 'FILES'].includes(field.type) || result[field.key] === undefined || result[field.key] === null || result[field.key] === '') continue;
    const old = field.type === 'FILE' ? [result[field.key]] : result[field.key];
    const next = z.array(z.string().uuid()).parse(old).flatMap(id => ids.has(id) ? [ids.get(id)!] : []);
    if (!partial && next.length !== (old as string[]).length) throw new ApiError(409, 'EXAMPLE_ASSET_UNAVAILABLE', 'Every file must have an approved copy');
    if (!next.length) delete result[field.key]; else result[field.key] = field.type === 'FILE' ? next[0] : next;
  }
  return result;
}
function sameIds(left: string[], right: string[]) { return left.length === right.length && new Set(left).size === left.length && left.every(id => right.includes(id)); }
function allowedScan(ctx: ApiContext, status: string) { return status === 'CLEAN' || ctx.config.development && status === 'DEVELOPMENT_ONLY'; }
function assetRefs(example: StoredExample) { return [...example.inputAssets ?? [], ...example.outputAssets ?? []]; }

export function preserveExampleEvidence(prior: unknown, edited: Array<{ id: string; title: string; input: Record<string, unknown>; output: string }>) {
  const previous = z.array(StoredExampleSchema).safeParse(prior);
  return edited.map(example => {
    const old = previous.success ? previous.data.find(row => row.id === example.id) : undefined;
    return old && old.output === example.output && stableStringify(old.input) === stableStringify(example.input) ? { ...old, title: example.title } : example;
  });
}

export function validateStoredExample(version: Pick<CapabilityVersion, 'ioContract' | 'manifestHash'>, example: StoredExample) {
  const contract = IOContractSchema.parse(version.ioContract), inputs = example.inputAssets ?? [], outputs = example.outputAssets ?? [];
  if (!sameIds(fileIds(contract.inputs, example.input), inputs.map(asset => asset.id))) throw new Error('Input file references differ from approved example assets');
  validateInput(contract, example.input, inputs.map(metadata));
  const output: JobOutput = example.outputValue ?? (contract.output.type === 'JSON' ? { json: JSON.parse(example.output) } : { text: example.output });
  if (!sameIds((output.assets ?? []).map(asset => asset.id), outputs.map(asset => asset.id))) throw new Error('Output files differ from approved example assets');
  for (const asset of output.assets ?? []) if (stableStringify(metadata(asset)) !== stableStringify(metadata(outputs.find(row => row.id === asset.id)!))) throw new Error('Output asset metadata differs');
  validateOutput(contract, { ...output, ...(outputs.length ? { assets: outputs.map(metadata) } : {}) });
  if (example.source === 'REAL_EXECUTION' && example.provenance?.manifestHash !== version.manifestHash) throw new Error('Execution belongs to another manifest');
  return output;
}

export async function exampleAssetIssues(ctx: ApiContext, db: Db, version: CapabilityVersion, ownerId: string) {
  const examples = z.array(StoredExampleSchema).safeParse(version.examples);
  if (!examples.success) return [{ id: '', code: 'INVALID_EXAMPLES' }];
  const refs = examples.data.flatMap(assetRefs), ids = [...new Set(refs.map(asset => asset.id))];
  if (!ids.length) return [];
  const copies = await db.capabilityExampleAsset.findMany({ where: { id: { in: ids }, capabilityId: version.capabilityId, ownerId, revokedAt: null, deletedAt: null } });
  return examples.data.flatMap(example => assetRefs(example).some(ref => {
    const copy = copies.find(asset => asset.id === ref.id);
    return !copy || !allowedScan(ctx, copy.scanStatus) || copy.reusableTemplate !== ref.reusableTemplate || stableStringify(metadata(copy)) !== stableStringify(metadata(ref));
  }) ? [{ id: example.id, code: 'EXAMPLE_ASSET_UNAVAILABLE' }] : []);
}

export async function exampleDtos(ctx: ApiContext, cap: CapabilityRecord, version: CapabilityVersion, sellerView: boolean): Promise<CapabilityExampleDTO[]> {
  if (!Array.isArray(version.examples)) return [];
  const invalid = new Set((await exampleAssetIssues(ctx, ctx.db, version, cap.sellerId)).map(issue => issue.id));
  const result: CapabilityExampleDTO[] = [];
  for (const raw of version.examples) {
    const parsed = StoredExampleSchema.safeParse(raw);
    if (!parsed.success || !sellerView && invalid.has(parsed.data.id)) continue;
    const example = parsed.data;
    const assetDto = (asset: NonNullable<StoredExample['inputAssets']>[number]) => ({ ...metadata(asset), reusableTemplate: asset.reusableTemplate,
      ...(cap.currentVersionId === version.id && version.publishedAt && cap.visibility !== 'DRAFT' && !invalid.has(example.id)
        ? { downloadUrl: `/api/capabilities/${cap.id}/examples/${encodeURIComponent(example.id)}/assets/${asset.id}` } : {}) });
    const inputAssets = (example.inputAssets ?? []).map(assetDto), outputAssets = (example.outputAssets ?? []).map(assetDto);
    const outputValue = example.outputValue ? { ...example.outputValue, ...(example.outputValue.assets ? { assets: outputAssets.map(asset => AssetDTOSchema.parse({ ...metadata(asset), ...(asset.downloadUrl ? { downloadUrl: asset.downloadUrl } : {}) })) } : {}) } : undefined;
    result.push(CapabilityExampleDTOSchema.parse({ id: example.id, title: example.title, input: example.input, output: example.output,
      description: example.description, order: example.order, source: example.source ?? 'SELLER_CURATED', inputAssets, outputAssets, outputValue,
      ...(example.source === 'REAL_EXECUTION' && example.provenance?.capabilityVersionId ? { provenance: { capabilityVersionId: example.provenance.capabilityVersionId,
        manifestHash: example.provenance.manifestHash, completedAt: example.provenance.completedAt } } : {}) }));
  }
  return result;
}

async function checkedBytes(ctx: ApiContext, asset: Pick<Asset, 'filename' | 'mimeType' | 'sizeBytes' | 'sha256' | 'objectKey' | 'scanStatus'>, rescan: boolean) {
  if (!allowedScan(ctx, asset.scanStatus)) throw new ApiError(409, 'EXAMPLE_ASSET_UNSCANNED', 'Example files must pass the configured scanner');
  if (asset.sizeBytes > ctx.config.maxUploadBytes) throw new ApiError(413, 'EXAMPLE_ASSET_TOO_LARGE', 'Example file exceeds the upload limit');
  const bytes = await ctx.storage.get(asset.objectKey, asset.sizeBytes);
  if (bytes.length !== asset.sizeBytes || sha256(bytes) !== asset.sha256) throw new ApiError(409, 'EXAMPLE_ASSET_INTEGRITY', 'Example file failed integrity verification');
  await inspectFile(bytes, asset.filename, asset.mimeType, ctx.config.maxUploadBytes);
  if (rescan && ctx.config.scannerHost) await scanWithClamAv(bytes, ctx.config.scannerHost, ctx.config.scannerPort);
  return bytes;
}
async function sourceAssets(ctx: ApiContext, db: Db, ids: string[], ownerId: string) {
  if (!ids.length) return [];
  const rows = await db.asset.findMany({ where: { id: { in: ids }, ownerId, deletedAt: null, expiresAt: { gt: new Date() } }, include: { job: true } });
  if (rows.length !== ids.length || rows.some(asset => !allowedScan(ctx, asset.scanStatus) || (asset.kind !== 'INPUT' && asset.kind !== 'OUTPUT') ||
    (asset.kind === 'OUTPUT' || asset.jobId) && (!asset.job || asset.job.buyerId !== ownerId || asset.job.sellerId !== ownerId || asset.job.state !== 'SUCCEEDED' || asset.job.paymentState !== 'SETTLED'))) {
    throw new ApiError(404, 'EXAMPLE_SOURCE_UNAVAILABLE', 'Only your own approved uploads or successful self-owned test outputs can be used');
  }
  if (rows.reduce((size, row) => size + row.sizeBytes, 0) > MAX_COPY_BYTES) throw new ApiError(413, 'EXAMPLE_TOO_LARGE', 'An example may copy at most 100 MiB');
  return rows;
}
async function discard(ctx: ApiContext, objects: StagedObject[]) {
  for (const object of objects) await abandonObject(ctx, object.pendingId).catch(() => undefined);
}
async function activeExample(ctx: ApiContext, db: Db, capabilityId: string, exampleId: string, userId?: string) {
  const cap = await loadCapability(db, capabilityId);
  if (cap.seller.suspendedAt || cap.securityBlocked || cap.visibility === 'DRAFT' || !cap.currentVersion?.publishedAt) throw new ApiError(404, 'NOT_FOUND', 'Example not found');
  await assertCapabilityAccess(db, cap, userId);
  if ((await db.capabilityVersionLifecycle.findUnique({ where: { versionId: cap.currentVersionId! } }))?.retiredAt) throw new ApiError(404, 'NOT_FOUND', 'Example not found');
  const examples = z.array(StoredExampleSchema).parse(cap.currentVersion.examples), example = requireValue(examples.find(row => row.id === exampleId));
  validateStoredExample(cap.currentVersion, example);
  if ((await exampleAssetIssues(ctx, db, cap.currentVersion, cap.sellerId)).some(issue => issue.id === example.id || !issue.id)) throw new ApiError(404, 'NOT_FOUND', 'Example assets are unavailable');
  return { cap, version: cap.currentVersion, example };
}

async function ownedExecution(db: Db, capabilityId: string, userId: string, jobId: string, manifestHash: string) {
  const job = requireValue(await db.job.findFirst({ where: { id: jobId, capabilityId, buyerId: userId, sellerId: userId, state: 'SUCCEEDED', paymentState: 'SETTLED' }, include: { version: true } }));
  if (job.contentDeletedAt || job.version.manifestHash !== manifestHash) throw new ApiError(409, 'EXAMPLE_VERSION_MISMATCH', 'Rerun the example against this immutable manifest with retained content');
  return job;
}

async function promoteExample(ctx: ApiContext, capabilityId: string, versionId: string, userId: string, body: PromotionBody,
  curated?: { input: Record<string, unknown>; outputValue: JobOutput }, jobId?: string) {
  const cap = await sellerCapability(ctx.db, capabilityId, userId); assertLifecycleRevision(cap, body.expectedRevision);
  const source = await ownedVersion(ctx.db, capabilityId, versionId), contract = IOContractSchema.parse(source.ioContract);
  const job = jobId ? await ownedExecution(ctx.db, capabilityId, userId, jobId, source.manifestHash) : null;
  const input = job ? z.record(z.unknown()).parse(job.input) : curated!.input, output = JobOutputSchema.parse(job ? job.output : curated!.outputValue);
  const inputs = fileIds(contract.inputs, input), outputs = (output.assets ?? []).map(asset => asset.id);
  const namedOutputs = fileIds(contract.output.fields ?? [], output.fields ?? {});
  if (!namedOutputs.every(id => outputs.includes(id))) throw new ApiError(400, 'EXAMPLE_ASSET_ENVELOPE_REQUIRED', 'Named output files must be included in output assets');
  const ids = [...new Set([...inputs, ...outputs])];
  if (!sameIds(ids, body.approvedAssetIds) || new Set(body.reusableInputAssetIds).size !== body.reusableInputAssetIds.length || !body.reusableInputAssetIds.every(id => inputs.includes(id))) {
    throw new ApiError(400, 'EXAMPLE_ASSET_APPROVAL_REQUIRED', 'Explicitly approve every referenced file and only mark input files reusable');
  }
  const rows = await sourceAssets(ctx, ctx.db, ids, userId), byId = new Map(rows.map(row => [row.id, row]));
  if (job && outputs.some(id => byId.get(id)?.kind !== 'OUTPUT' || byId.get(id)?.jobId !== job.id || byId.get(id)?.attemptId !== job.activeAttemptId)) throw new ApiError(409, 'EXAMPLE_OUTPUT_MISMATCH', 'Output files must belong to this successful execution');
  validateInput(contract, input, rows.map(metadata));
  validateOutput(contract, { ...output, ...(outputs.length ? { assets: outputs.map(id => metadata(byId.get(id)!)) } : {}) });
  const existing = z.array(StoredExampleSchema).parse(source.examples);
  if (body.replaceExampleId && !existing.some(example => example.id === body.replaceExampleId)) throw new ApiError(404, 'NOT_FOUND', 'Example to replace was not found');
  if (!body.replaceExampleId && existing.length >= 3) throw new ApiError(409, 'EXAMPLE_LIMIT_EXCEEDED', 'At most three examples are allowed');
  const objects: StagedObject[] = [], copies: Array<Pick<CapabilityExampleAsset, 'id' | 'sourceAssetId' | 'filename' | 'mimeType' | 'sizeBytes' | 'sha256' | 'objectKey' | 'scanStatus' | 'reusableTemplate'>> = [];
  let updated: CapabilityRecord;
  try {
    for (const row of rows) {
      const stored = await stageObject(ctx, { ownerId: userId, bytes: await checkedBytes(ctx, row, true), filename: row.filename, mimeType: row.mimeType }); objects.push(stored);
      if (stored.sha256 !== row.sha256 || stored.sizeBytes !== row.sizeBytes) throw new ApiError(409, 'EXAMPLE_ASSET_INTEGRITY', 'Approved copy failed integrity verification');
      copies.push({ ...metadata(row), id: randomUUID(), sourceAssetId: row.id, objectKey: stored.key, scanStatus: row.scanStatus, reusableTemplate: body.reusableInputAssetIds.includes(row.id) });
    }
    const copyMap = new Map(copies.map(copy => [copy.sourceAssetId!, copy])), remap = new Map(copies.map(copy => [copy.sourceAssetId!, copy.id]));
    const exampleInput = remapFiles(contract.inputs, input, remap), exampleOutput: JobOutput = { ...output,
      ...(output.assets ? { assets: outputs.map(id => metadata(copyMap.get(id)!)) } : {}),
      ...(output.fields ? { fields: remapFiles(contract.output.fields ?? [], output.fields, remap) } : {}) };
    const example: StoredExample = { id: body.replaceExampleId ?? randomUUID(), title: body.title, ...(body.description ? { description: body.description } : {}),
      input: exampleInput, output: (exampleOutput.text ?? JSON.stringify(exampleOutput.json ?? exampleOutput.fields ?? { files: exampleOutput.assets?.map(asset => asset.filename) })).slice(0, 10_000),
      outputValue: exampleOutput, source: job ? 'REAL_EXECUTION' : 'SELLER_CURATED',
      inputAssets: inputs.map(id => ({ ...metadata(copyMap.get(id)!), reusableTemplate: copyMap.get(id)!.reusableTemplate })),
      outputAssets: outputs.map(id => ({ ...metadata(copyMap.get(id)!), reusableTemplate: copyMap.get(id)!.reusableTemplate })),
      ...(job ? { provenance: { jobId: job.id, capabilityVersionId: job.capabilityVersionId, manifestHash: source.manifestHash, inputHash: hashManifest(job.input), outputHash: hashManifest(job.output), completedAt: job.completedAt?.toISOString() } } : {}) };
    validateStoredExample(source, example);
    updated = await serializable(ctx.db, async tx => {
      await lockCapability(tx, capabilityId);
      const current = await sellerCapability(tx, capabilityId, userId); assertLifecycleRevision(current, body.expectedRevision);
      const fresh = await ownedVersion(tx, capabilityId, versionId);
      if (hashManifest(versionSnapshot(fresh)) !== hashManifest(versionSnapshot(source))) throw new ApiError(409, 'CAPABILITY_CONFLICT', 'Example source changed');
      const stillOwned = await sourceAssets(ctx, tx, ids, userId);
      if (stillOwned.some(row => stableStringify(metadata(row)) !== stableStringify(metadata(byId.get(row.id)!)))) throw new ApiError(409, 'EXAMPLE_SOURCE_CHANGED', 'Source file metadata changed');
      if (job && !await tx.job.count({ where: { id: job.id, buyerId: userId, sellerId: userId, state: 'SUCCEEDED', paymentState: 'SETTLED', contentDeletedAt: null } })) throw new ApiError(409, 'EXAMPLE_SOURCE_UNAVAILABLE', 'Source job is no longer eligible');
      if (copies.length) await tx.capabilityExampleAsset.createMany({ data: copies.map(copy => ({ ...copy, capabilityId, ownerId: userId })) });
      for (const copy of copies) await commitObject(tx, requireValue(objects.find(object => object.key === copy.objectKey)).pendingId, { exampleAssetId: copy.id });
      const examples = body.replaceExampleId ? existing.map(old => old.id === body.replaceExampleId ? example : old) : [...existing, example];
      const latest = await tx.capabilityVersion.aggregate({ where: { capabilityId }, _max: { version: true } });
      const draft = await tx.capabilityVersion.create({ data: { ...versionSnapshot(source), capabilityId, version: (latest._max.version ?? 0) + 1,
        ioContract: json(source.ioContract), permissions: json(source.permissions), dependencies: json(source.dependencies), examples: json(examples) } });
      const bindings = await tx.workerBinding.findMany({ where: { capabilityVersionId: source.id } });
      await tx.workerBinding.createMany({ data: bindings.map(binding => ({ workerId: binding.workerId, capabilityVersionId: draft.id, healthy: false })) });
      await tx.auditEvent.create({ data: { actorId: userId, sellerId: userId, ...(job ? { jobId: job.id } : {}), type: job ? 'EXECUTED_EXAMPLE_APPROVED' : 'CURATED_EXAMPLE_APPROVED',
        metadata: json({ capabilityId, versionId: draft.id, exampleId: example.id, approvedAssetIds: body.approvedAssetIds, copyIds: copies.map(copy => copy.id), reusableInputAssetIds: body.reusableInputAssetIds, provenance: example.provenance }) } });
      return tx.capability.update({ where: { id: capabilityId }, data: { draftVersionId: draft.id, lifecycleRevision: { increment: 1 } }, include: capabilityInclude });
    });
  } catch (error) { await discard(ctx, objects); throw error; }
  return versionHistory(ctx, ctx.db, updated);
}

export async function cleanupExampleAssets(ctx: ApiContext): Promise<number> {
  const rows = await ctx.db.capabilityExampleAsset.findMany({ where: { revokedAt: { not: null }, deletedAt: null }, orderBy: { revokedAt: 'asc' }, take: 100 });
  let count = 0;
  for (const row of rows) {
    try {
      await ctx.storage.delete(row.objectKey);
      const updated = await ctx.db.capabilityExampleAsset.updateMany({ where: { id: row.id, deletedAt: null }, data: { deletedAt: new Date() } }); count += updated.count;
    } catch { ctx.app.log.warn({ assetId: row.id }, 'Revoked example file cleanup will retry'); }
  }
  return count;
}

export function registerExampleAssets(app: FastifyInstance, ctx: ApiContext) {
  const sellerPath = '/api/seller/capabilities/:id/versions/:versionId/examples';
  app.get(`${sellerPath}/from-job/:jobId`, async request => {
    const { user } = requireIdentity(request), { id, versionId, jobId } = request.params as { id: string; versionId: string; jobId: string };
    const cap = await sellerCapability(ctx.db, id, user.id), version = await ownedVersion(ctx.db, cap.id, versionId), contract = IOContractSchema.parse(version.ioContract);
    const job = await ownedExecution(ctx.db, cap.id, user.id, z.string().uuid().parse(jobId), version.manifestHash);
    const input = z.record(z.unknown()).parse(job.input), output = JobOutputSchema.parse(job.output);
    const inputs = fileIds(contract.inputs, input), outputs = (output.assets ?? []).map(asset => asset.id);
    const rows = await sourceAssets(ctx, ctx.db, [...new Set([...inputs, ...outputs])], user.id), byId = new Map(rows.map(row => [row.id, row]));
    if (outputs.some(assetId => byId.get(assetId)?.kind !== 'OUTPUT' || byId.get(assetId)?.jobId !== job.id || byId.get(assetId)?.attemptId !== job.activeAttemptId)) throw new ApiError(409, 'EXAMPLE_OUTPUT_MISMATCH', 'Output files must belong to this successful execution');
    const dto = (assetId: string): AssetDTO => { const asset = byId.get(assetId)!; return { ...metadata(asset), expiresAt: asset.expiresAt.toISOString(), downloadUrl: `/api/assets/${asset.id}/download` }; };
    const inputAssets = inputs.map(dto), outputAssets = outputs.map(dto), outputValue = { ...output, ...(outputs.length ? { assets: outputAssets } : {}) };
    validateInput(contract, input, inputAssets); validateOutput(contract, outputValue);
    return { jobId: job.id, capabilityVersionId: job.capabilityVersionId, targetVersionId: version.id, input, outputValue, inputAssets, outputAssets };
  });
  app.post(sellerPath, async request => {
    const { user } = requireIdentity(request), { id, versionId } = request.params as { id: string; versionId: string };
    const body = Promotion.extend({ input: z.record(z.unknown()), outputValue: JobOutputSchema }).strict().parse(request.body);
    return promoteExample(ctx, id, versionId, user.id, body, body);
  });
  app.post(`${sellerPath}/from-job`, async request => {
    const { user } = requireIdentity(request), { id, versionId } = request.params as { id: string; versionId: string };
    const body = Promotion.extend({ jobId: z.string().uuid() }).strict().parse(request.body);
    return promoteExample(ctx, id, versionId, user.id, body, undefined, body.jobId);
  });
  app.post('/api/seller/capabilities/:id/example-assets/:assetId/revoke', async request => {
    const { user } = requireIdentity(request), { id, assetId } = request.params as { id: string; assetId: string };
    const body = LifecycleCAS.extend({ reason: z.string().trim().min(3).max(1000) }).strict().parse(request.body);
    return serializable(ctx.db, async tx => {
      await lockCapability(tx, id);
      const cap = await sellerCapability(tx, id, user.id); assertLifecycleRevision(cap, body.expectedRevision);
      const asset = requireValue(await tx.capabilityExampleAsset.findFirst({ where: { id: z.string().uuid().parse(assetId), capabilityId: cap.id, ownerId: user.id } }));
      if (asset.revokedAt) return { revoked: true, lifecycleRevision: cap.lifecycleRevision };
      await tx.capabilityExampleAsset.update({ where: { id: asset.id }, data: { revokedAt: new Date() } });
      const updated = await tx.capability.update({ where: { id }, data: { lifecycleRevision: { increment: 1 } } });
      await tx.auditEvent.create({ data: { actorId: user.id, sellerId: user.id, type: 'EXAMPLE_ASSET_REVOKED', metadata: { capabilityId: id, assetId: asset.id, reason: body.reason } } });
      return { revoked: true, lifecycleRevision: updated.lifecycleRevision };
    });
  });
  const publicPath = '/api/capabilities/:id/examples/:exampleId';
  app.get(`${publicPath}/assets/:assetId`, async (request, reply) => {
    if (request.identity?.kind === 'api-key') requireIdentity(request, 'capabilities:read');
    const { id, exampleId, assetId } = request.params as { id: string; exampleId: string; assetId: string };
    const selected = await activeExample(ctx, ctx.db, id, exampleId, request.identity?.user.id);
    if (!assetRefs(selected.example).some(asset => asset.id === assetId)) throw new ApiError(404, 'NOT_FOUND', 'Example asset not found');
    const asset = requireValue(await ctx.db.capabilityExampleAsset.findFirst({ where: { id: z.string().uuid().parse(assetId), capabilityId: selected.cap.id, revokedAt: null, deletedAt: null } }));
    safeFilename(asset.filename);
    let start = 0, end = asset.sizeBytes - 1;
    if (request.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (!range || !range[1] && !range[2]) return reply.code(416).header('Content-Range', `bytes */${asset.sizeBytes}`).send();
      start = range[1] ? Number(range[1]) : Math.max(0, asset.sizeBytes - Number(range[2])); end = range[1] && range[2] ? Math.min(end, Number(range[2])) : end;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= asset.sizeBytes) return reply.code(416).header('Content-Range', `bytes */${asset.sizeBytes}`).send();
    }
    const bytes = request.method === 'HEAD' ? null : ctx.storage.getStream ? await ctx.storage.getStream(asset.objectKey, asset.sizeBytes) : Readable.from([await checkedBytes(ctx, asset, false)]);
    try {
      const current = await activeExample(ctx, ctx.db, id, exampleId, request.identity?.user.id);
      if (current.version.id !== selected.version.id || !assetRefs(current.example).some(ref => ref.id === assetId)) throw new ApiError(404, 'NOT_FOUND', 'Example asset is no longer published');
    } catch (error) { bytes?.destroy(); throw error; }
    if (request.headers.range) reply.code(206).header('Content-Range', `bytes ${start}-${end}/${asset.sizeBytes}`);
    const inline = /^(image\/(png|jpeg|webp|gif)|audio\/(mpeg|wav|x-wav|flac)|video\/(mp4|quicktime|webm)|application\/pdf)$/.test(asset.mimeType);
    reply.header('Content-Type', inline ? asset.mimeType : 'application/octet-stream').header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(asset.filename)}`)
      .header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "sandbox; default-src 'none'").header('Cache-Control', 'private, no-store')
      .header('Accept-Ranges', 'bytes').header('Content-Length', end - start + 1);
    if (!bytes) return reply.send(Readable.from([]));
    return reply.send(Readable.from((async function* () {
      let offset = 0;
      try { for await (const chunk of bytes) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), next = offset + buffer.length;
        if (next > start && offset <= end) yield buffer.subarray(Math.max(0, start - offset), Math.min(buffer.length, end + 1 - offset));
        offset = next; if (offset > end) break;
      } } finally { bytes.destroy(); }
    })()));
  });
  app.post(`${publicPath}/template`, async request => {
    const { user } = requireIdentity(request, 'assets:create'), { id, exampleId } = request.params as { id: string; exampleId: string };
    const body = z.object({ capabilityVersionId: z.string().uuid(), assetIds: z.array(z.string().uuid()).max(40).default([]), confirmCopy: z.literal(true).optional() }).strict().parse(request.body);
    if (body.assetIds.length && (!body.confirmCopy || new Set(body.assetIds).size !== body.assetIds.length)) throw new ApiError(400, 'TEMPLATE_COPY_CONSENT_REQUIRED', 'Explicitly confirm copying the selected reusable input files');
    const selected = await activeExample(ctx, ctx.db, id, exampleId, user.id);
    if (selected.version.id !== body.capabilityVersionId) throw new ApiError(409, 'EXAMPLE_VERSION_CHANGED', 'The capability version changed');
    if (!body.assetIds.every(assetId => selected.example.inputAssets?.some(asset => asset.id === assetId && asset.reusableTemplate))) throw new ApiError(403, 'TEMPLATE_ASSET_NOT_REUSABLE', 'Only seller-approved reusable input assets can be copied');
    const copies = await ctx.db.capabilityExampleAsset.findMany({ where: { id: { in: body.assetIds }, capabilityId: selected.cap.id, reusableTemplate: true, revokedAt: null, deletedAt: null } });
    if (copies.length !== body.assetIds.length) throw new ApiError(404, 'NOT_FOUND', 'Template file unavailable');
    const objects: StagedObject[] = [], assets: Array<{ sourceId: string; id: string; stored: StagedObject; scanStatus: string }> = [];
    try {
      for (const copy of copies) {
        const stored = await stageObject(ctx, { ownerId: user.id, bytes: await checkedBytes(ctx, copy, true), filename: copy.filename, mimeType: copy.mimeType }); objects.push(stored);
        if (stored.sha256 !== copy.sha256 || stored.sizeBytes !== copy.sizeBytes) throw new ApiError(409, 'EXAMPLE_ASSET_INTEGRITY', 'Template copy failed integrity verification');
        assets.push({ sourceId: copy.id, id: randomUUID(), stored, scanStatus: copy.scanStatus });
      }
      return await serializable(ctx.db, async tx => {
        await lockCapability(tx, selected.cap.id);
        const current = await activeExample(ctx, tx, selected.cap.id, exampleId, user.id);
        if (current.version.id !== body.capabilityVersionId) throw new ApiError(409, 'EXAMPLE_VERSION_CHANGED', 'The capability version changed');
        const expiresAt = new Date(Date.now() + ctx.config.assetRetentionDays * 86400_000), copied: AssetDTO[] = [];
        for (const asset of assets) {
          const row = await tx.asset.create({ data: { id: asset.id, ownerId: user.id, kind: 'INPUT', filename: asset.stored.filename, mimeType: asset.stored.mimeType,
            sizeBytes: asset.stored.sizeBytes, sha256: asset.stored.sha256, objectKey: asset.stored.key, scanStatus: asset.scanStatus, expiresAt } });
          await commitObject(tx, asset.stored.pendingId, { assetId: row.id });
          copied.push({ ...metadata(row), expiresAt: row.expiresAt.toISOString(), downloadUrl: `/api/assets/${row.id}/download` });
        }
        const input = remapFiles(IOContractSchema.parse(current.version.ioContract).inputs, current.example.input, new Map(assets.map(asset => [asset.sourceId, asset.id])), true);
        await tx.auditEvent.create({ data: { actorId: user.id, sellerId: current.cap.sellerId, type: 'EXAMPLE_TEMPLATE_COPIED', metadata: json({ capabilityId: current.cap.id, capabilityVersionId: current.version.id, exampleId, approvedAssetIds: body.assetIds, copiedAssetIds: copied.map(asset => asset.id) }) } });
        return { capabilityId: current.cap.id, capabilityVersionId: current.version.id, input, assets: copied };
      });
    } catch (error) { await discard(ctx, objects); throw error; }
  });
}
