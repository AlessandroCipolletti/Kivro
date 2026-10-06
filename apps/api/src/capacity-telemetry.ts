import { createHash } from 'node:crypto';
import { Prisma, serializable, type Transaction } from '@kivro/database';
import { z } from 'zod';
import type { ApiContext } from './context.js';
import { availability, loadCapability } from './catalog.js';

export const CAPACITY_MAX_OBSERVATION_GAP_MS = 120_000;
const BATCH_SIZE = 100;
const GROUP_LIMIT = 200;
const OBSERVATION = 'CAPACITY_OBSERVATION';
const REJECTION = 'CAPACITY_QUEUE_FULL';
const START_KEY = 'capacity-telemetry-started';
const CURSOR_KEY = 'capacity-telemetry-cursor';
const states = ['ONLINE', 'BUSY', 'OFFLINE', 'SCHEDULED_OFFLINE', 'PAUSED', 'SECURITY_BLOCKED'] as const;
type CapacityState = typeof states[number];
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const checkpointSchema = z.object({ firstAt: timestamp, at: timestamp, status: z.enum(states) });
const count = z.number().int().nonnegative().safe();
const sample = z.number().finite().nonnegative().nullable();
type TelemetryContext = Pick<ApiContext, 'db' | 'config'>;

export type CapabilityAnalyticsItem = {
  capabilityId: string; capabilityTitle: string;
  durations: { onlineMs: number; busyMs: number; offlineMs: number; scheduledOfflineMs: number; pausedMs: number; securityBlockedMs: number };
  coverage: { eligibleMs: number; observedMs: number; unknownMs: number; ratio: number | null;
    firstObservedAt: string | null; lastObservedAt: string | null; observationCount: number; invalidObservationCount: number };
  jobsAccepted: number; acceptedAttempts: number; queueFullRejects: number; queueFullCoverageFrom: string | null;
  queueWait: { sampleCount: number; medianSeconds: number | null; excludedCount: number };
  execution: { sampleCount: number; medianSeconds: number | null; excludedCount: number };
  disconnectFailures: number;
};
export type CapabilityAnalyticsDTO = {
  method: 'BOUNDED_PREVIOUS_OBSERVATION'; maxObservationGapMs: number;
  disconnectFailureBasis: 'RETAINED_PLATFORM_RECONNECT_EXPIRY_EVENTS';
  totalCapabilities: number; truncated: boolean; items: CapabilityAnalyticsItem[];
};

async function startTracking(tx: Transaction, at: Date) {
  await tx.platformSetting.upsert({ where: { key: START_KEY }, create: { key: START_KEY, value: at.toISOString() }, update: {} });
}

// A sample never establishes historical uptime. Only the interval between two
// timely observations is attributed to the previous sampled state.
export async function recordCapacityObservation(tx: Transaction, capabilityId: string, status: CapacityState, at = new Date()): Promise<boolean> {
  z.string().uuid().parse(capabilityId); z.enum(states).parse(status); timestamp.parse(at.getTime());
  const key = `capacity-observation:${capabilityId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  const capability = await tx.capability.findUniqueOrThrow({ where: { id: capabilityId }, select: { sellerId: true, createdAt: true } });
  if (at < capability.createdAt) throw new Error('Observation predates capability');
  const prior = await tx.platformSetting.findUnique({ where: { key } });
  const parsed = checkpointSchema.safeParse(prior?.value);
  const previous = parsed.success && parsed.data.firstAt <= parsed.data.at ? parsed.data : null;
  if (previous && at.getTime() <= previous.at) return false;
  const timely = previous && at.getTime() - previous.at <= CAPACITY_MAX_OBSERVATION_GAP_MS;
  await startTracking(tx, at);
  await tx.auditEvent.create({ data: { sellerId: capability.sellerId, type: OBSERVATION, createdAt: at,
    metadata: { schemaVersion: 1, capabilityId, kind: timely ? 'INTERVAL' : previous ? 'GAP' : prior ? 'RESET' : 'FIRST',
      fromMs: previous?.at ?? null, toMs: at.getTime(), status: previous?.status ?? status, observedStatus: status } } });
  const value = { firstAt: previous?.firstAt ?? at.getTime(), at: at.getTime(), status };
  await tx.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  return true;
}

export function queueFullRejectionId(buyerId: string, capabilityId: string, purchaseKey: string): string {
  z.string().uuid().parse(buyerId); z.string().uuid().parse(capabilityId);
  z.string().min(8).max(200).parse(purchaseKey);
  const hash = createHash('sha256').update(JSON.stringify(['capacity-queue-full-v1', buyerId, capabilityId, purchaseKey])).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

// Called only after the rejected purchase transaction has rolled back. The
// caller must preserve its original 409 if this independent telemetry fails.
export async function recordQueueFullRejection(ctx: TelemetryContext, buyerId: string, capabilityId: string, purchaseKey: string): Promise<void> {
  const id = queueFullRejectionId(buyerId, capabilityId, purchaseKey);
  await serializable(ctx.db, async tx => {
    const capability = await tx.capability.findUniqueOrThrow({ where: { id: capabilityId }, select: { sellerId: true } });
    await startTracking(tx, new Date());
    await tx.auditEvent.createMany({ data: [{ id, actorId: buyerId, sellerId: capability.sellerId, type: REJECTION,
      metadata: { schemaVersion: 1, capabilityId, reason: 'CAPABILITY_QUEUE_FULL' } }], skipDuplicates: true });
  });
}

export async function reconcileCapacityTelemetry(ctx: ApiContext): Promise<void> {
  // Claim a bounded page before observing. A crash can miss one sweep, never
  // manufacture elapsed time; other invocations and restarts advance fairly.
  const ids = await serializable(ctx.db, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${CURSOR_KEY}, 0))`;
    const prior = await tx.platformSetting.findUnique({ where: { key: CURSOR_KEY } });
    const cursor = z.string().uuid().safeParse(prior?.value);
    const query = (after?: string) => tx.capability.findMany({ where: { currentVersionId: { not: null }, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: 'asc' }, take: BATCH_SIZE, select: { id: true } });
    let rows = await query(cursor.success ? cursor.data : undefined);
    if (!rows.length && cursor.success) rows = await query();
    const value = rows.length === BATCH_SIZE ? rows.at(-1)!.id : '';
    await tx.platformSetting.upsert({ where: { key: CURSOR_KEY }, create: { key: CURSOR_KEY, value }, update: { value } });
    await startTracking(tx, new Date());
    return rows.map(row => row.id);
  });
  let failed = false;
  for (const id of ids) {
    try {
      await serializable(ctx.db, async tx => {
        const cap = await loadCapability(tx, id);
        const state = (await tx.platformSetting.findUnique({ where: { key: 'dispatchEnabled' } }))?.value === false ? 'PAUSED' : (await availability(ctx, cap, tx)).status;
        await recordCapacityObservation(tx, id, state);
      });
    } catch { failed = true; }
  }
  await ctx.db.auditEvent.deleteMany({ where: { type: { in: [OBSERVATION, REJECTION] },
    createdAt: { lt: new Date(Date.now() - ctx.config.operationalAuditRetentionDays * 86400_000) } } });
  // The independent maintenance task records a sanitized operator error; a bad
  // capability does not block observation of the rest of this page.
  if (failed) throw new Error('CAPACITY_OBSERVATION_FAILED');
}

const durationRow = z.object({ capabilityId: z.string(), observationCount: count, invalidObservationCount: count,
  onlineMs: count, busyMs: count, offlineMs: count, scheduledOfflineMs: count, pausedMs: count, securityBlockedMs: count });
const timingRow = z.object({ capabilityId: z.string(), queueSamples: count, queueMedian: sample, queueExcluded: count,
  executionSamples: count, executionMedian: sample, executionExcluded: count, disconnectFailures: count });

export async function capacityAnalytics(tx: Transaction, sellerId: string | undefined, from: Date, to: Date, retentionDays: number): Promise<CapabilityAnalyticsDTO> {
  const where = { ...(sellerId ? { sellerId } : {}), createdAt: { lte: to } };
  const totalCapabilities = await tx.capability.count({ where });
  const capabilities = await tx.capability.findMany({ where, orderBy: { id: 'asc' }, take: GROUP_LIMIT,
    select: { id: true, sellerId: true, createdAt: true, currentVersion: { select: { title: true } }, draftVersion: { select: { title: true } } } });
  const result: CapabilityAnalyticsDTO = { method: 'BOUNDED_PREVIOUS_OBSERVATION', maxObservationGapMs: CAPACITY_MAX_OBSERVATION_GAP_MS,
    disconnectFailureBasis: 'RETAINED_PLATFORM_RECONNECT_EXPIRY_EVENTS', totalCapabilities, truncated: totalCapabilities > GROUP_LIMIT, items: [] };
  if (!capabilities.length) return result;
  const ids = Prisma.join(capabilities.map(cap => cap.id));
  const ownerScope = sellerId ? Prisma.sql`j."sellerId" = ${sellerId}::uuid` : Prisma.sql`TRUE`;
  const observedFrom = new Date(Math.max(from.getTime(), to.getTime() - retentionDays * 86400_000));
  const settings = await tx.platformSetting.findMany({ where: { key: { in: [START_KEY, ...capabilities.map(cap => `capacity-observation:${cap.id}`)] } }, select: { key: true, value: true } });
  const tracking = z.string().datetime().safeParse(settings.find(row => row.key === START_KEY)?.value);
  const markers = new Map(settings.map(row => [row.key, checkpointSchema.safeParse(row.value)]));
  const durations = z.array(durationRow).parse(await tx.$queryRaw(Prisma.sql`
    WITH raw AS (
      SELECT c.id AS "capabilityId", c."createdAt", e.metadata,
        CASE WHEN (e.metadata->>'fromMs') ~ '^[0-9]{1,16}$' THEN (e.metadata->>'fromMs')::numeric END AS a,
        CASE WHEN (e.metadata->>'toMs') ~ '^[0-9]{1,16}$' THEN (e.metadata->>'toMs')::numeric END AS b
      FROM "Capability" c JOIN "AuditEvent" e ON e."sellerId" = c."sellerId" AND e.metadata->>'capabilityId' = c.id::text
      WHERE c.id::text IN (${ids}) AND e.type = ${OBSERVATION} AND e."createdAt" >= ${observedFrom} AND e."createdAt" <= ${to}
    ), intervals AS (
      SELECT *, metadata->>'kind' IN ('FIRST', 'GAP', 'RESET') OR
        (metadata->>'kind' = 'INTERVAL' AND a >= 0 AND b > a AND b - a <= ${CAPACITY_MAX_OBSERVATION_GAP_MS}
          AND b <= ${to.getTime()} AND metadata->>'status' IN (${Prisma.join(states)})) AS valid,
        CASE WHEN metadata->>'kind' = 'INTERVAL' AND a >= 0 AND b > a AND b - a <= ${CAPACITY_MAX_OBSERVATION_GAP_MS}
          AND b <= ${to.getTime()} AND metadata->>'status' IN (${Prisma.join(states)}) THEN
          GREATEST(0, LEAST(b, ${to.getTime()}) - GREATEST(a, ${observedFrom.getTime()}, EXTRACT(EPOCH FROM "createdAt") * 1000)) ELSE 0 END AS elapsed
      FROM raw
    ) SELECT "capabilityId", COUNT(*)::float8 AS "observationCount", COUNT(*) FILTER (WHERE valid IS NOT TRUE)::float8 AS "invalidObservationCount",
      COALESCE(SUM(elapsed) FILTER (WHERE metadata->>'status' = 'ONLINE'), 0)::float8 AS "onlineMs",
      COALESCE(SUM(elapsed) FILTER (WHERE metadata->>'status' = 'BUSY'), 0)::float8 AS "busyMs",
      COALESCE(SUM(elapsed) FILTER (WHERE metadata->>'status' = 'OFFLINE'), 0)::float8 AS "offlineMs",
      COALESCE(SUM(elapsed) FILTER (WHERE metadata->>'status' = 'SCHEDULED_OFFLINE'), 0)::float8 AS "scheduledOfflineMs",
      COALESCE(SUM(elapsed) FILTER (WHERE metadata->>'status' = 'PAUSED'), 0)::float8 AS "pausedMs",
      COALESCE(SUM(elapsed) FILTER (WHERE metadata->>'status' = 'SECURITY_BLOCKED'), 0)::float8 AS "securityBlockedMs"
    FROM intervals GROUP BY "capabilityId"`));
  const timings = z.array(timingRow).parse(await tx.$queryRaw(Prisma.sql`
    WITH source AS (
      SELECT j.*, (SELECT MIN(e."createdAt") FROM "JobEvent" e WHERE e."jobId" = j.id AND e.type = 'PAUSED' AND e."createdAt" <= ${to}) AS "firstPause",
        j."startedAt" >= ${from} AND j."startedAt" <= ${to} AS queue_cohort,
        j.state IN ('SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED') AND j."completedAt" >= ${from} AND j."completedAt" <= ${to} AS execution_cohort,
        EXTRACT(EPOCH FROM (j."completedAt" - j."startedAt")) * 1000 AS wall,
        j."pausedDurationMs" + CASE WHEN j."pausedAt" IS NOT NULL THEN EXTRACT(EPOCH FROM (j."completedAt" - j."pausedAt")) * 1000 ELSE 0 END AS pause
      FROM "Job" j WHERE ${ownerScope} AND j."capabilityId"::text IN (${ids})
    ), samples AS (
      SELECT *, ("firstPause" IS NULL AND "pausedDurationMs" = 0 OR "firstPause" >= "startedAt")
        AND ("pausedAt" IS NULL OR "pausedAt" >= "startedAt") AS attributable FROM source
    ), measured AS (
      SELECT *, CASE WHEN queue_cohort AND attributable AND "queuedAt" >= "createdAt" AND "queuedAt" <= "startedAt"
        THEN EXTRACT(EPOCH FROM ("startedAt" - "queuedAt")) END AS queue_seconds,
        CASE WHEN execution_cohort AND attributable AND "startedAt" >= "createdAt" AND wall >= 0 AND pause >= 0 AND pause <= wall
          AND ("pausedAt" IS NULL OR "pausedAt" <= "completedAt") THEN (wall - pause) / 1000.0 END AS execution_seconds FROM samples
    ) SELECT "capabilityId", COUNT(queue_seconds)::float8 AS "queueSamples",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY queue_seconds)::float8 AS "queueMedian",
      COUNT(*) FILTER (WHERE queue_cohort AND queue_seconds IS NULL)::float8 AS "queueExcluded",
      COUNT(execution_seconds)::float8 AS "executionSamples",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY execution_seconds)::float8 AS "executionMedian",
      COUNT(*) FILTER (WHERE execution_cohort AND execution_seconds IS NULL)::float8 AS "executionExcluded",
      COUNT(*) FILTER (WHERE execution_cohort AND state = 'FAILED' AND EXISTS (SELECT 1 FROM "JobEvent" e WHERE e."jobId" = measured.id
        AND e.type = 'FAILED' AND e."createdAt" <= ${to} AND e.metadata->>'source' = 'PLATFORM' AND e.message = 'Worker did not reconnect within the recovery period'))::float8 AS "disconnectFailures"
    FROM measured GROUP BY "capabilityId"`));
  const accepted = z.array(z.object({ capabilityId: z.string(), jobs: count, attempts: count })).parse(await tx.$queryRaw(Prisma.sql`
    SELECT j."capabilityId", COUNT(DISTINCT j.id)::float8 AS jobs, COUNT(*)::float8 AS attempts
    FROM "JobAttempt" a JOIN "Job" j ON j.id = a."jobId" WHERE ${ownerScope} AND j."capabilityId"::text IN (${ids})
      AND a."acceptedAt" >= ${from} AND a."acceptedAt" <= ${to} GROUP BY j."capabilityId"`));
  const rejections = z.array(z.object({ capabilityId: z.string(), rejects: count })).parse(await tx.$queryRaw(Prisma.sql`
    SELECT c.id AS "capabilityId", COUNT(*)::float8 AS rejects FROM "Capability" c JOIN "AuditEvent" e
      ON e."sellerId" = c."sellerId" AND e.metadata->>'capabilityId' = c.id::text
    WHERE c.id::text IN (${ids}) AND e.type = ${REJECTION} AND e.metadata->>'reason' = 'CAPABILITY_QUEUE_FULL'
      AND e."createdAt" >= ${observedFrom} AND e."createdAt" <= ${to} GROUP BY c.id`));
  for (const cap of capabilities) {
    const duration = durations.find(row => row.capabilityId === cap.id), timing = timings.find(row => row.capabilityId === cap.id);
    const values = { onlineMs: duration?.onlineMs ?? 0, busyMs: duration?.busyMs ?? 0, offlineMs: duration?.offlineMs ?? 0,
      scheduledOfflineMs: duration?.scheduledOfflineMs ?? 0, pausedMs: duration?.pausedMs ?? 0, securityBlockedMs: duration?.securityBlockedMs ?? 0 };
    const observedMs = count.parse(Object.values(values).reduce((a, b) => a + b, 0));
    const eligibleMs = count.parse(Math.max(0, to.getTime() - Math.max(from.getTime(), cap.createdAt.getTime())));
    // Corrupted overlapping intervals must not produce impossible coverage.
    if (observedMs > eligibleMs) throw new Error('CAPACITY_COVERAGE_INVALID');
    const marker = markers.get(`capacity-observation:${cap.id}`);
    const validMarker = marker?.success && marker.data.firstAt <= marker.data.at && marker.data.at <= to.getTime() ? marker.data : null;
    const acceptedRow = accepted.find(row => row.capabilityId === cap.id);
    const rejectionStart = tracking.success ? Math.max(observedFrom.getTime(), cap.createdAt.getTime(), Date.parse(tracking.data)) : null;
    result.items.push({ capabilityId: cap.id, capabilityTitle: cap.currentVersion?.title ?? cap.draftVersion?.title ?? 'Untitled capability', durations: values,
      coverage: { eligibleMs, observedMs, unknownMs: eligibleMs - observedMs, ratio: eligibleMs ? observedMs / eligibleMs : null,
        firstObservedAt: validMarker ? new Date(validMarker.firstAt).toISOString() : null,
        lastObservedAt: validMarker ? new Date(validMarker.at).toISOString() : null,
        observationCount: duration?.observationCount ?? 0, invalidObservationCount: duration?.invalidObservationCount ?? 0 },
      jobsAccepted: acceptedRow?.jobs ?? 0, acceptedAttempts: acceptedRow?.attempts ?? 0,
      queueFullRejects: rejections.find(row => row.capabilityId === cap.id)?.rejects ?? 0,
      queueFullCoverageFrom: rejectionStart !== null && rejectionStart <= to.getTime() ? new Date(rejectionStart).toISOString() : null,
      queueWait: { sampleCount: timing?.queueSamples ?? 0, medianSeconds: timing?.queueMedian ?? null, excludedCount: timing?.queueExcluded ?? 0 },
      execution: { sampleCount: timing?.executionSamples ?? 0, medianSeconds: timing?.executionMedian ?? null, excludedCount: timing?.executionExcluded ?? 0 },
      disconnectFailures: timing?.disconnectFailures ?? 0 });
  }
  return result;
}
