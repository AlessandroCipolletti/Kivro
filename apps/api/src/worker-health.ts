import { json, serializable, type Prisma, type Transaction, type WorkerDevice } from '@kivro/database';
import { z } from 'zod';
import { WORKER_WARNING_CATALOG, WorkerWarningSignalsSchema, WorkerWarningSnapshotSchema,
  type WorkerWarningCode, type WorkerSecurityWarning, type WorkerWarningSnapshot } from '@kivro/contracts';
import { ADAPTER_POLICY_VERSION } from '@kivro/openclaw-adapter';
import type { ApiContext } from './context.js';
import { categoryPolicyBlocked, loadSecurityPolicy, workerPolicyReason, type SecurityPolicy } from './security-policy.js';
import { ApiError } from './errors.js';

const bindingInclude = { version: { select: { id: true, capabilityId: true, manifestHash: true, category: true,
  capability: { select: { sellerId: true, securityBlocked: true } } } } } satisfies Prisma.WorkerBindingInclude;
type WarningBinding = Prisma.WorkerBindingGetPayload<{ include: typeof bindingInclude }>;
const storedWarnings = z.object({ sellerId: z.string().uuid(), workerId: z.string().uuid(), snapshot: WorkerWarningSnapshotSchema }).strict();
const validationLifetimeMs = 24 * 3600_000;
const warningKey = (workerId: string) => `worker-security-warnings:${workerId}`;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function publicWorkerHealth(value: unknown): Record<string, unknown> {
  // Local signal identifiers are projected only after ownership checks, not
  // echoed through the legacy generic health object.
  return Object.fromEntries(Object.entries(object(value)).filter(([key]) => key !== 'warningSignals'));
}

export function projectWorkerWarnings(worker: WorkerDevice, bindings: WarningBinding[], policy: SecurityPolicy,
  heartbeatTtlMs: number, now: Date, previous?: WorkerWarningSnapshot): WorkerWarningSnapshot {
  const at = now.toISOString(), items = new Map<string, WorkerSecurityWarning>();
  const fresh = !!worker.lastSeenAt && worker.lastSeenAt.getTime() > now.getTime() - heartbeatTtlMs;
  const policyReason = workerPolicyReason(worker, policy);
  const deviceBlocked = !!worker.revokedAt || !!policyReason || !worker.sandboxReady || !fresh;
  const owned = bindings.filter(binding => binding.version.capability.sellerId === worker.sellerId && binding.workerId === worker.id);
  const checked = owned.slice(0, 100), byVersion = new Map(checked.map(binding => [binding.capabilityVersionId, binding]));
  const validationCurrent = (binding: WarningBinding) => binding.validationStatus === 'PASSED'
    && binding.validatedManifestHash === binding.version.manifestHash
    && !!binding.validatedAt && binding.validatedAt.getTime() > now.getTime() - validationLifetimeMs;
  const add = (code: WorkerWarningCode, binding?: WarningBinding, source: WorkerSecurityWarning['source'] = 'PLATFORM_STATE', blocking = true) => {
    const id = `${worker.id}:${binding?.capabilityVersionId ?? 'device'}:${code}`;
    if (items.has(id)) return;
    const prior = previous?.items.find(item => item.id === id && item.affectedEntity.workerId === worker.id);
    const detectedAt = prior && Date.parse(prior.detectedAt) <= now.getTime() ? prior.detectedAt : at;
    items.set(id, { id, code, ...WORKER_WARNING_CATALOG[code], affectedEntity: { workerId: worker.id,
      capabilityId: binding?.version.capabilityId ?? null, capabilityVersionId: binding?.capabilityVersionId ?? null },
      detectedAt, lastObservedAt: at, detectedAtBasis: 'FIRST_PLATFORM_OBSERVATION', source, blocking });
  };
  if (worker.revokedAt) add('DEVICE_REVOKED');
  if (policyReason && policyReason in WORKER_WARNING_CATALOG) add(policyReason as WorkerWarningCode);
  if (!fresh) add('HEARTBEAT_EXPIRED');
  if (!worker.sandboxReady) add('SANDBOX_NOT_READY');
  for (const binding of checked) {
    if (binding.version.capability.securityBlocked) add('CAPABILITY_SECURITY_BLOCKED', binding);
    if (categoryPolicyBlocked(binding.version.category, policy)) add('CATEGORY_BLOCKED', binding);
    if (!validationCurrent(binding)) add('CAPABILITY_REVALIDATION_REQUIRED', binding);
    if (!binding.healthy) add('CAPABILITY_NOT_READY', binding);
    const version = object(object(binding.validationProof).sandbox).policyVersion;
    if (typeof version === 'number' && Number.isFinite(version) && version !== ADAPTER_POLICY_VERSION) add('SECURITY_POLICY_OUTDATED', binding,
      'PLATFORM_STATE', deviceBlocked || !binding.healthy || !validationCurrent(binding));
  }
  const report = WorkerWarningSignalsSchema.safeParse(object(worker.health).warningSignals);
  let ignoredSignalCount = 0;
  if (report.success && fresh) for (const signal of report.data) {
    const binding = signal.capabilityVersionId ? byVersion.get(signal.capabilityVersionId) : undefined;
    if (signal.capabilityVersionId && !binding) { ignoredSignalCount++; continue; }
    // Reports identify observed conditions, never authorize execution or clear a
    // gate. Blocking describes the existing cloud readiness/policy state only.
    add(signal.code, binding, 'WORKER_REPORT', deviceBlocked || !!binding && (!binding.healthy || !validationCurrent(binding)
      || binding.version.capability.securityBlocked || categoryPolicyBlocked(binding.version.category, policy)));
  }
  const priority = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  return WorkerWarningSnapshotSchema.parse({ schemaVersion: 1, observedAt: at,
    items: [...items.values()].sort((a, b) => priority[a.severity] - priority[b.severity] || a.id.localeCompare(b.id)).slice(0, 500),
    capabilityVersionsChecked: checked.length, truncated: owned.length > 100 || items.size > 500,
    coverage: { capabilityScope: 'BOUND_VERSIONS_ONLY', localSignals: report.success ? fresh ? 'REPORTED' : 'STALE' : 'UNAVAILABLE',
      ignoredSignalCount, deviceRevocationSchedule: 'UNAVAILABLE' } });
}

export async function observeWorkerWarnings(tx: Transaction, worker: WorkerDevice, policy: SecurityPolicy, heartbeatTtlMs: number, now?: Date) {
  const key = warningKey(worker.id);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  const saved = storedWarnings.safeParse((await tx.platformSetting.findUnique({ where: { key } }))?.value);
  const previous = saved.success && saved.data.workerId === worker.id && saved.data.sellerId === worker.sellerId ? saved.data.snapshot : undefined;
  const bindings = await tx.workerBinding.findMany({ where: { workerId: worker.id, version: { capability: { sellerId: worker.sellerId } } },
    include: bindingInclude, orderBy: { capabilityVersionId: 'asc' }, take: 101 });
  const snapshot = projectWorkerWarnings(worker, bindings, policy, heartbeatTtlMs, now ?? new Date(), previous);
  await tx.platformSetting.upsert({ where: { key }, create: { key, value: json({ sellerId: worker.sellerId, workerId: worker.id, snapshot }) },
    update: { value: json({ sellerId: worker.sellerId, workerId: worker.id, snapshot }) } });
  const signature = (value?: WorkerWarningSnapshot) => JSON.stringify(value?.items.map(({ id, source, blocking, detectedAt }) => ({ id, source, blocking, detectedAt })) ?? []);
  if (signature(previous) !== signature(snapshot)) await tx.auditEvent.create({ data: { sellerId: worker.sellerId, workerId: worker.id, type: 'WORKER_WARNINGS_CHANGED',
    metadata: { active: snapshot.items.map(({ id, code, blocking, source }) => ({ id, code, blocking, source })),
      localSignals: snapshot.coverage.localSignals, truncated: snapshot.truncated } } });
  return snapshot;
}

export async function getWorkerWarnings(ctx: ApiContext, scope: { workerId: string; sellerId: string }): Promise<WorkerWarningSnapshot> {
  z.object({ workerId: z.string().uuid(), sellerId: z.string().uuid() }).strict().parse(scope);
  return serializable(ctx.db, async tx => {
    const worker = await tx.workerDevice.findFirst({ where: { id: scope.workerId, sellerId: scope.sellerId } });
    if (!worker) throw new ApiError(404, 'NOT_FOUND', 'Worker not found');
    return observeWorkerWarnings(tx, worker, await loadSecurityPolicy(tx), ctx.config.heartbeatTtlMs);
  });
}

export function workerHealthState(worker: WorkerDevice, policy: SecurityPolicy, heartbeatTtlMs: number, dispatchEnabled = true) {
  if (worker.revokedAt) return { status: 'REVOKED', reason: 'DEVICE_REVOKED' };
  const policyReason = workerPolicyReason(worker, policy);
  if (policyReason) return { status: 'SECURITY_BLOCKED', reason: policyReason };
  if (!dispatchEnabled) return { status: 'PAUSED', reason: 'PLATFORM_DISPATCH_DISABLED' };
  if (worker.paused || worker.localPaused) return { status: 'PAUSED', reason: 'SELLER_PAUSED' };
  if (!worker.lastSeenAt || worker.lastSeenAt.getTime() <= Date.now() - heartbeatTtlMs) return { status: 'OFFLINE', reason: 'HEARTBEAT_EXPIRED' };
  if (!worker.sandboxReady) return { status: 'NOT_READY', reason: 'RUNTIME_NOT_READY' };
  return { status: 'READY', reason: 'HEARTBEAT_HEALTHY' };
}

export async function recordWorkerHealth(tx: Transaction, worker: WorkerDevice, policy: SecurityPolicy, heartbeatTtlMs: number) {
  const enabled = (await tx.platformSetting.findUnique({ where: { key: 'dispatchEnabled' } }))?.value !== false;
  const state = workerHealthState(worker, policy, heartbeatTtlMs, enabled);
  const marker = `${state.status}:${state.reason}`;
  if (worker.healthStatus !== marker) {
    const changed = await tx.workerDevice.updateMany({ where: { id: worker.id, healthStatus: worker.healthStatus }, data: { healthStatus: marker } });
    if (changed.count) await tx.auditEvent.create({ data: { sellerId: worker.sellerId, workerId: worker.id, type: 'WORKER_HEALTH',
      metadata: { previous: worker.healthStatus, ...state, version: worker.version, openclawVersion: worker.openclawVersion } } });
  }
  await observeWorkerWarnings(tx, worker, policy, heartbeatTtlMs);
}

export async function reconcileWorkerHealth(ctx: ApiContext) {
  const key = 'worker-health-cursor', prior = await ctx.db.platformSetting.findUnique({ where: { key } });
  const cursor = typeof prior?.value === 'string' ? prior.value : '';
  let workers = await ctx.db.workerDevice.findMany({ where: cursor ? { id: { gt: cursor } } : {}, take: 200, orderBy: { id: 'asc' }, select: { id: true } });
  if (!workers.length && cursor) workers = await ctx.db.workerDevice.findMany({ take: 200, orderBy: { id: 'asc' }, select: { id: true } });
  for (const { id } of workers) await serializable(ctx.db, async tx => {
    const worker = await tx.workerDevice.findUnique({ where: { id } });
    if (worker) await recordWorkerHealth(tx, worker, await loadSecurityPolicy(tx), ctx.config.heartbeatTtlMs);
  });
  const next = workers.length === 200 ? workers.at(-1)!.id : '';
  await ctx.db.platformSetting.upsert({ where: { key }, create: { key, value: next }, update: { value: next } });
  await ctx.db.auditEvent.deleteMany({ where: { type: { in: ['WORKER_HEALTH', 'WORKER_WARNINGS_CHANGED', 'ASSET_DOWNLOAD_GRANTED'] }, createdAt: { lt: new Date(Date.now() - ctx.config.operationalAuditRetentionDays * 86400_000) } } });
}
