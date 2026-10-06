import { z } from 'zod';
import { DependencySchema, IOContractSchema, PermissionManifestSchema, executionManifestHash, getPriceTier, hashManifest,
  stableStringify } from '@kivro/contracts';
import { assertPublishable } from '@kivro/policy-engine';
import { ADAPTER_POLICY_VERSION, assertWorkerPermissions } from '@kivro/openclaw-adapter';
import { json, serializable, type CapabilityVersion, type PrismaClient, type Transaction } from '@kivro/database';
import type { FastifyInstance } from 'fastify';
import type { ApiContext } from './context.js';
import { requireIdentity } from './auth.js';
import { ApiError, requireValue } from './errors.js';
import { assertRuntimeContract, capabilityInclude, loadCapability, type CapabilityRecord } from './catalog.js';
import { categoryPolicyBlocked, loadSecurityPolicy, workerPolicyReason, type SecurityPolicy } from './security-policy.js';
import { exampleAssetIssues, exampleDtos, StoredExampleSchema, validateStoredExample } from './example-assets.js';

type Db = PrismaClient | Transaction;
type Version = CapabilityVersion;
type Category = 'SKILLS' | 'INFERENCE' | 'PERMISSIONS' | 'INPUTS' | 'OUTPUTS' | 'PRICE' | 'RUNTIME' | 'METADATA' | 'EXAMPLES';
type Change = { path: string; category: Category; before: unknown; after: unknown };
export const LifecycleCAS = z.object({ expectedRevision: z.number().int().nonnegative() });

export async function lockCapability(tx: Transaction, id: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`capacity:${id}`}, 0))`;
}
export function assertLifecycleRevision(cap: CapabilityRecord, expected?: number) {
  if (expected !== undefined && cap.lifecycleRevision !== expected) throw new ApiError(409, 'CAPABILITY_CONFLICT', 'Capability changed; reload its current revision', { lifecycleRevision: cap.lifecycleRevision });
}
export async function sellerCapability(db: Db, id: string, sellerId: string) {
  const cap = await loadCapability(db, z.string().uuid().parse(id));
  if (cap.sellerId !== sellerId) throw new ApiError(404, 'NOT_FOUND', 'Capability not found');
  return cap;
}
export async function ownedVersion(db: Db, capabilityId: string, versionId: string) {
  return requireValue(await db.capabilityVersion.findFirst({ where: { id: z.string().uuid().parse(versionId), capabilityId } }));
}

export function versionSnapshot(version: Version) {
  return { title: version.title, summary: version.summary, description: version.description, category: version.category, tags: version.tags,
    priceTierId: version.priceTierId, ioContract: version.ioContract, permissions: version.permissions, dependencies: version.dependencies,
    internalInstructions: version.internalInstructions, manifestHash: version.manifestHash, examples: version.examples,
    estimatedDurationSeconds: version.estimatedDurationSeconds };
}

export function versionDiff(from: Version | null, to: Version) {
  const changes: Change[] = [], warnings: { code: string; path: string }[] = [];
  const oldPermissions = from ? PermissionManifestSchema.parse(from.permissions) : null;
  const permissions = PermissionManifestSchema.parse(to.permissions);
  const compare = (path: string, category: Category, before: unknown, after: unknown) => {
    if (stableStringify(before ?? null) !== stableStringify(after ?? null)) changes.push({ path, category, before: before ?? null, after: after ?? null });
  };
  for (const field of ['title', 'summary', 'description', 'category', 'tags'] as const) compare(field, 'METADATA', from?.[field], to[field]);
  compare('dependencies', 'SKILLS', from?.dependencies, to.dependencies);
  compare('permissions.inference', 'INFERENCE', oldPermissions?.inference, permissions.inference);
  for (const field of ['tools', 'network', 'resources'] as const) compare(`permissions.${field}`, 'PERMISSIONS', oldPermissions?.[field], permissions[field]);
  compare('permissions.limits', 'RUNTIME', oldPermissions?.limits, permissions.limits);
  compare('internalInstructions', 'RUNTIME', from?.internalInstructions, to.internalInstructions);
  compare('estimatedDurationSeconds', 'RUNTIME', from?.estimatedDurationSeconds, to.estimatedDurationSeconds);
  const oldContract = from ? IOContractSchema.parse(from.ioContract) : null, contract = IOContractSchema.parse(to.ioContract);
  compare('ioContract.inputs', 'INPUTS', oldContract?.inputs, contract.inputs);
  compare('ioContract.output', 'OUTPUTS', oldContract?.output, contract.output);
  compare('priceTierId', 'PRICE', from?.priceTierId, to.priceTierId);
  compare('examples', 'EXAMPLES', from?.examples, to.examples);
  const added = (previous: string[] | undefined, next: string[]) => next.some(value => !previous?.includes(value));
  if (added(oldPermissions?.tools, permissions.tools)) warnings.push({ code: 'PERMISSION_EXPANSION', path: 'permissions.tools' });
  if (permissions.network.mode !== 'NONE' && (permissions.network.mode !== oldPermissions?.network.mode || added(oldPermissions?.network.allowedDomains, permissions.network.allowedDomains))) warnings.push({ code: 'NEW_NETWORK_ACCESS', path: 'permissions.network' });
  if (permissions.resources.some(resource => !oldPermissions?.resources.some(old => stableStringify(old) === stableStringify(resource)))) warnings.push({ code: 'NEW_PRIVATE_RESOURCE', path: 'permissions.resources' });
  if (permissions.inference.credentialRef && permissions.inference.credentialRef !== oldPermissions?.inference.credentialRef) warnings.push({ code: 'NEW_CREDENTIAL', path: 'permissions.inference.credentialRef' });
  if (oldPermissions && Object.entries(permissions.limits).some(([key, value]) => value > oldPermissions.limits[key as keyof typeof oldPermissions.limits])) warnings.push({ code: 'PERMISSION_EXPANSION', path: 'permissions.limits' });
  const oldDependencies = from ? z.array(DependencySchema).parse(from.dependencies) : [], dependencies = z.array(DependencySchema).parse(to.dependencies);
  for (const dependency of dependencies) {
    const previous = oldDependencies.find(old => old.id === dependency.id);
    for (const [grant, values] of Object.entries(dependency.grants ?? {})) {
      const oldValues = previous?.grants?.[grant as keyof NonNullable<typeof dependency.grants>];
      if (added(oldValues, values ?? [])) warnings.push({ code: grant === 'credentialRefs' ? 'NEW_CREDENTIAL' : 'PERMISSION_EXPANSION', path: `dependencies.${dependency.id}.grants.${grant}` });
    }
  }
  if (from && stableStringify(oldContract?.inputs) !== stableStringify(contract.inputs)) warnings.push({ code: 'INPUT_CONTRACT_CHANGED', path: 'ioContract.inputs' });
  if (from && stableStringify(oldContract?.output) !== stableStringify(contract.output)) warnings.push({ code: 'OUTPUT_CONTRACT_CHANGED', path: 'ioContract.output' });
  if (from && from.priceTierId !== to.priceTierId) warnings.push({ code: 'PRICE_CHANGED', path: 'priceTierId' });
  if (from && from.manifestHash !== to.manifestHash && Array.isArray(to.examples) && to.examples.length) warnings.push({ code: 'RERUN_EXAMPLES_RECOMMENDED', path: 'examples' });
  const permissionExpansion = warnings.some(warning => ['PERMISSION_EXPANSION', 'NEW_NETWORK_ACCESS', 'NEW_PRIVATE_RESOURCE', 'NEW_CREDENTIAL'].includes(warning.code));
  const result = { fromVersionId: from?.id ?? null, toVersionId: to.id, changes, warnings, permissionExpansion };
  return { ...result, diffHash: hashManifest({ ...result, from: from ? versionSnapshot(from) : null, to: versionSnapshot(to) }) };
}

export function exampleValidationIssues(version: Version): { id: string; code: string }[] {
  if (!Array.isArray(version.examples)) return [{ id: '', code: 'INVALID_EXAMPLES' }];
  if (version.examples.length > 3) return [{ id: '', code: 'EXAMPLE_LIMIT_EXCEEDED' }];
  const issues: { id: string; code: string }[] = [], ids = new Set<string>();
  for (const raw of version.examples) {
    const parsed = StoredExampleSchema.safeParse(raw);
    if (!parsed.success) { issues.push({ id: '', code: 'INVALID_EXAMPLE' }); continue; }
    const example = parsed.data;
    try {
      if (ids.has(example.id)) throw new Error('Duplicate example identifier'); ids.add(example.id);
      validateStoredExample(version, example);
    } catch { issues.push({ id: example.id, code: 'EXAMPLE_NEEDS_REVALIDATION' }); }
  }
  return issues;
}

export async function versionReadiness(ctx: ApiContext, db: Db, cap: CapabilityRecord, version: Version, policy?: SecurityPolicy) {
  const reasons: string[] = [];
  const securityPolicy = policy ?? await loadSecurityPolicy(db);
  if (categoryPolicyBlocked(version.category, securityPolicy)) reasons.push('CATEGORY_BLOCKED');
  if (cap.seller.suspendedAt) reasons.push('ACCOUNT_SUSPENDED');
  if (cap.securityBlocked) reasons.push('SECURITY_BLOCKED');
  if (ctx.config.paymentMode === 'stripe' && cap.seller.connectStatus !== 'READY') reasons.push('SELLER_PAYMENT_NOT_READY');
  try { assertPublishable(PermissionManifestSchema.parse(version.permissions), z.array(DependencySchema).parse(version.dependencies)); }
  catch { reasons.push('DEPENDENCIES_NOT_READY'); }
  try { assertWorkerPermissions(version.permissions); assertRuntimeContract(version.ioContract); }
  catch { reasons.push('UNSUPPORTED_RUNTIME_CONTRACT'); }
  try { if (executionManifestHash(version) !== version.manifestHash) reasons.push('MANIFEST_MISMATCH'); }
  catch { reasons.push('INVALID_CONTRACT'); }
  try { getPriceTier(version.priceTierId); } catch { reasons.push('INVALID_PRICE_TIER'); }
  if (!version.title.trim() || !version.summary.trim() || !version.category.trim()) reasons.push('PUBLIC_METADATA_INCOMPLETE');
  if (exampleValidationIssues(version).length) reasons.push('EXAMPLE_NEEDS_REVALIDATION');
  if ((await exampleAssetIssues(ctx, db, version, cap.sellerId)).length) reasons.push('EXAMPLE_ASSET_UNAVAILABLE');
  const lifecycle = await db.capabilityVersionLifecycle.findUnique({ where: { versionId: version.id } });
  if (lifecycle?.retiredAt) reasons.push('VERSION_RETIRED');
  const cutoff = Math.max(Date.now() - 24 * 3600_000, lifecycle?.testingStartedAt?.getTime() ?? 0);
  const bindings = await db.workerBinding.findMany({ where: { capabilityVersionId: version.id, healthy: true, validationStatus: 'PASSED',
    validatedManifestHash: version.manifestHash, validatedAt: { gte: new Date(cutoff) },
    worker: { sellerId: cap.sellerId, revokedAt: null, paused: false, localPaused: false, sandboxReady: true, lastSeenAt: { gt: new Date(Date.now() - ctx.config.heartbeatTtlMs) } } }, include: { worker: true } });
  const proofSchema = z.object({ sandbox: z.object({ imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), policyVersion: z.literal(ADAPTER_POLICY_VERSION), testedAt: z.number().finite() }),
    inference: z.object({ configHash: z.string().regex(/^[a-f0-9]{64}$/), testedAt: z.number().finite() }) });
  const ready = bindings.some(binding => {
    const proof = proofSchema.safeParse(binding.validationProof);
    return !workerPolicyReason(binding.worker, securityPolicy) && proof.success && [proof.data.sandbox.testedAt, proof.data.inference.testedAt].every(time => time >= cutoff && time <= Date.now() + 60_000);
  });
  if (bindings.length && bindings.every(binding => workerPolicyReason(binding.worker, securityPolicy))) reasons.push(...new Set(bindings.map(binding => workerPolicyReason(binding.worker, securityPolicy)!)));
  if (!ready) reasons.push('CAPABILITY_NOT_VALIDATED');
  return { ready: reasons.length === 0, reasons };
}

export async function versionSummary(ctx: ApiContext, db: Db, cap: CapabilityRecord, version: Version, policy?: SecurityPolicy) {
  const lifecycle = await db.capabilityVersionLifecycle.findUnique({ where: { versionId: version.id } });
  const readiness = await versionReadiness(ctx, db, cap, version, policy);
  const testing = lifecycle?.testingStartedAt && !await db.workerBinding.count({ where: { capabilityVersionId: version.id, validatedAt: { gte: lifecycle.testingStartedAt }, validationStatus: { in: ['PASSED', 'FAILED'] } } });
  return { id: version.id, version: version.version, title: version.title,
    state: lifecycle?.retiredAt ? 'RETIRED' : version.publishedAt ? 'PUBLISHED' : readiness.ready ? 'READY_TO_PUBLISH' : testing ? 'TESTING' : 'DRAFT',
    isActive: cap.currentVersionId === version.id, isDraft: cap.draftVersionId === version.id, createdAt: version.createdAt.toISOString(),
    publishedAt: version.publishedAt?.toISOString() ?? null, retiredAt: lifecycle?.retiredAt?.toISOString() ?? null,
    testPassedAt: version.testPassedAt?.toISOString() ?? null, consentAt: version.consentAt?.toISOString() ?? null,
    manifestHash: version.manifestHash, priceTierId: version.priceTierId, readiness,
    publicationEvidence: version.publicationEvidence ?? null,
    exampleIssues: [...exampleValidationIssues(version), ...await exampleAssetIssues(ctx, db, version, cap.sellerId)] };
}
export async function versionHistory(ctx: ApiContext, db: Db, cap: CapabilityRecord, before?: number) {
  const securityPolicy = await loadSecurityPolicy(db);
  const rows = await db.capabilityVersion.findMany({ where: { capabilityId: cap.id, ...(before ? { version: { lt: before } } : {}) }, orderBy: { version: 'desc' }, take: 101 });
  const versions = [];
  for (const row of rows.slice(0, 100)) versions.push(await versionSummary(ctx, db, cap, row, securityPolicy));
  return { capabilityId: cap.id, currentVersionId: cap.currentVersionId, draftVersionId: cap.draftVersionId, lifecycleRevision: cap.lifecycleRevision,
    visibility: cap.visibility, versions, nextCursor: rows.length > 100 ? String(rows[99]!.version) : null };
}

export function requireDiffReview(from: Version | null, target: Version, reviewedDiffHash?: string) {
  const diff = versionDiff(from, target);
  if ((from && from.id !== target.id && diff.permissionExpansion || reviewedDiffHash !== undefined) && reviewedDiffHash !== diff.diffHash) {
    throw new ApiError(409, 'PERMISSION_REVIEW_REQUIRED', 'Review and explicitly confirm the current version diff', { diffHash: diff.diffHash, warnings: diff.warnings });
  }
  return diff;
}

export function registerCapabilityLifecycle(app: FastifyInstance, ctx: ApiContext) {
  const path = '/api/seller/capabilities/:id/versions';
  app.get(path, async request => {
    const { user } = requireIdentity(request), { id } = request.params as { id: string };
    const { cursor } = z.object({ cursor: z.coerce.number().int().positive().optional() }).strict().parse(request.query);
    return versionHistory(ctx, ctx.db, await sellerCapability(ctx.db, id, user.id), cursor);
  });
  app.get(`${path}/:versionId`, async request => {
    const { user } = requireIdentity(request), { id, versionId } = request.params as { id: string; versionId: string };
    const cap = await sellerCapability(ctx.db, id, user.id), version = await ownedVersion(ctx.db, cap.id, versionId);
    const previews = await exampleDtos(ctx, cap, version, true);
    const examples = Array.isArray(version.examples) ? version.examples.map(raw => {
      const parsed = StoredExampleSchema.safeParse(raw), preview = parsed.success ? previews.find(example => example.id === parsed.data.id) : undefined;
      return parsed.success && preview ? { ...parsed.data, ...preview, provenance: parsed.data.provenance } : raw;
    }) : version.examples;
    return { capabilityId: cap.id, currentVersionId: cap.currentVersionId, draftVersionId: cap.draftVersionId, lifecycleRevision: cap.lifecycleRevision,
      ...await versionSummary(ctx, ctx.db, cap, version), ...versionSnapshot(version), examples };
  });
  app.get(`${path}/:versionId/diff`, async request => {
    const { user } = requireIdentity(request), { id, versionId } = request.params as { id: string; versionId: string };
    const { fromVersionId } = z.object({ fromVersionId: z.string().uuid().optional() }).strict().parse(request.query);
    const cap = await sellerCapability(ctx.db, id, user.id), target = await ownedVersion(ctx.db, cap.id, versionId);
    const from = fromVersionId ? await ownedVersion(ctx.db, cap.id, fromVersionId) : cap.currentVersion;
    return { lifecycleRevision: cap.lifecycleRevision, ...versionDiff(from, target) };
  });
  app.post(`${path}/:versionId/activate`, async request => {
    const { user } = requireIdentity(request), { id, versionId } = request.params as { id: string; versionId: string };
    const body = LifecycleCAS.extend({ reason: z.string().trim().min(3).max(1000), reviewedDiffHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(request.body);
    const cap = await serializable(ctx.db, async tx => {
      await lockCapability(tx, id);
      const current = await sellerCapability(tx, id, user.id); assertLifecycleRevision(current, body.expectedRevision);
      const target = await ownedVersion(tx, id, versionId);
      if (!target.publishedAt) throw new ApiError(409, 'VERSION_NOT_PUBLISHED', 'Publish a tested draft before activation');
      const readiness = await versionReadiness(ctx, tx, current, target);
      if (!readiness.ready) throw new ApiError(409, 'ROLLBACK_NOT_READY', 'The target version is not ready for activation', readiness);
      const diff = requireDiffReview(current.currentVersion, target, body.reviewedDiffHash);
      if (current.currentVersionId === target.id) return current;
      await tx.auditEvent.create({ data: { actorId: user.id, sellerId: user.id, type: 'CAPABILITY_VERSION_ACTIVATED', metadata: json({ capabilityId: id, fromVersionId: current.currentVersionId,
        toVersionId: target.id, manifestHash: target.manifestHash, reason: body.reason, diffHash: diff.diffHash, previousRevision: current.lifecycleRevision }) } });
      return tx.capability.update({ where: { id }, data: { currentVersionId: target.id, lifecycleRevision: { increment: 1 } }, include: capabilityInclude });
    });
    await ctx.wake(); return versionHistory(ctx, ctx.db, cap);
  });
  app.post(`${path}/:versionId/retire`, async request => {
    const { user } = requireIdentity(request), { id, versionId } = request.params as { id: string; versionId: string };
    const body = LifecycleCAS.extend({ reason: z.string().trim().min(3).max(1000), deactivate: z.literal(true).optional() }).strict().parse(request.body);
    const cap = await serializable(ctx.db, async tx => {
      await lockCapability(tx, id);
      const current = await sellerCapability(tx, id, user.id); assertLifecycleRevision(current, body.expectedRevision);
      const target = await ownedVersion(tx, id, versionId), active = current.currentVersionId === target.id;
      if (active && !body.deactivate) throw new ApiError(409, 'ACTIVE_VERSION_RETIREMENT_BLOCKED', 'Explicitly confirm deactivation to stop new purchases without changing existing jobs');
      const prior = await tx.capabilityVersionLifecycle.findUnique({ where: { versionId } });
      if (prior?.retiredAt) return current;
      await tx.capabilityVersionLifecycle.upsert({ where: { versionId }, create: { versionId, retiredAt: new Date() }, update: { retiredAt: new Date() } });
      await tx.auditEvent.create({ data: { actorId: user.id, sellerId: user.id, type: 'CAPABILITY_VERSION_RETIRED', metadata: { capabilityId: id, versionId, reason: body.reason, deactivated: active, previousRevision: current.lifecycleRevision } } });
      return tx.capability.update({ where: { id }, data: { lifecycleRevision: { increment: 1 }, ...(active ? { currentVersionId: null, visibility: 'DRAFT' } : {}),
        ...(current.draftVersionId === versionId ? { draftVersionId: null } : {}) }, include: capabilityInclude });
    });
    return versionHistory(ctx, ctx.db, cap);
  });
  app.post(`${path}/:versionId/testing`, async request => {
    const { user } = requireIdentity(request), { id, versionId } = request.params as { id: string; versionId: string };
    const body = LifecycleCAS.strict().parse(request.body);
    const cap = await serializable(ctx.db, async tx => {
      await lockCapability(tx, id);
      const current = await sellerCapability(tx, id, user.id); assertLifecycleRevision(current, body.expectedRevision);
      const target = await ownedVersion(tx, id, versionId);
      if (target.publishedAt || (await tx.capabilityVersionLifecycle.findUnique({ where: { versionId } }))?.retiredAt) throw new ApiError(409, 'VERSION_NOT_DRAFT', 'Testing lifecycle changes require an unretired draft');
      const at = new Date();
      await tx.capabilityVersionLifecycle.upsert({ where: { versionId }, create: { versionId, testingStartedAt: at }, update: { testingStartedAt: at } });
      await tx.workerBinding.updateMany({ where: { capabilityVersionId: versionId }, data: { healthy: false, validationStatus: 'PENDING' } });
      await tx.auditEvent.create({ data: { actorId: user.id, sellerId: user.id, type: 'CAPABILITY_VERSION_TESTING', metadata: { capabilityId: id, versionId } } });
      return tx.capability.update({ where: { id }, data: { lifecycleRevision: { increment: 1 } }, include: capabilityInclude });
    });
    return versionHistory(ctx, ctx.db, cap);
  });
  app.post('/api/seller/capabilities/:id/visibility', async request => {
    const { user } = requireIdentity(request), { id } = request.params as { id: string };
    const body = LifecycleCAS.extend({ visibility: z.enum(['DRAFT', 'PRIVATE', 'UNLISTED', 'PUBLIC']) }).strict().parse(request.body);
    const cap = await serializable(ctx.db, async tx => {
      await lockCapability(tx, id);
      const current = await sellerCapability(tx, id, user.id); assertLifecycleRevision(current, body.expectedRevision);
      if (body.visibility !== 'DRAFT') {
        const version = requireValue(current.currentVersion, 'CAPABILITY_NOT_PUBLISHED', 'Publish a version before sharing it');
        if (!version.publishedAt || (await tx.capabilityVersionLifecycle.findUnique({ where: { versionId: version.id } }))?.retiredAt) throw new ApiError(409, 'VERSION_NOT_PUBLISHED', 'The active version must be published and unretired');
        const exposure = ['DRAFT', 'PRIVATE', 'UNLISTED', 'PUBLIC'];
        if (exposure.indexOf(body.visibility) > exposure.indexOf(current.visibility)) {
          const readiness = await versionReadiness(ctx, tx, current, version);
          if (!readiness.ready) throw new ApiError(409, 'CAPABILITY_NOT_VALIDATED', 'Current version must pass publication checks before increasing exposure', readiness);
        }
      }
      if (current.visibility === body.visibility) return current;
      await tx.auditEvent.create({ data: { actorId: user.id, sellerId: user.id, type: 'CAPABILITY_VISIBILITY_CHANGED', metadata: { capabilityId: id, previous: current.visibility, next: body.visibility } } });
      return tx.capability.update({ where: { id }, data: { visibility: body.visibility, lifecycleRevision: { increment: 1 } }, include: capabilityInclude });
    });
    return versionHistory(ctx, ctx.db, cap);
  });
}
