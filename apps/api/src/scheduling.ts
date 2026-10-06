import { ScheduleSchema, type Schedule } from '@kivro/contracts';
import { isScheduleOpen, nextScheduledTime, schedulePreview } from '@kivro/policy-engine';
import type { Transaction } from '@kivro/database';
import type { ApiContext } from './context.js';
import { activeStates, availability, type CapabilityRecord } from './catalog.js';
import { ApiError } from './errors.js';
import { transition } from './jobs.js';
import { lockSellerCapacity, pendingCapacity } from './pending-capacity.js';

export const acceptanceOrder = [{ createdAt: 'asc' }, { id: 'asc' }] as const;
export async function lockCapacity(tx: Transaction, capabilityId: string): Promise<void> {
  const cap = await tx.capability.findUniqueOrThrow({ where: { id: capabilityId }, select: { sellerId: true } });
  await lockSellerCapacity(tx, cap.sellerId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`capacity:${capabilityId}`}, 0))`;
}

// Partition preview boundaries with the authoritative open/closed predicate.
// Local midnights account for overrides that cancel the prior night's spill.
// Always-open (or multi-day continuous) schedules use local-day reservation buckets.
export function reservationWindow(schedule: Schedule, at: Date): { start: Date; end: Date } | null {
  if (!isScheduleOpen(schedule, at)) return null;
  const anchor = new Date(at.getTime() - 2 * 86400_000);
  const days = schedulePreview({ ...schedule, mode: 'ALWAYS', windows: [], overrides: [] }, anchor, 6);
  const previews = schedulePreview(schedule, anchor, 6);
  const boundaries = [...new Set([...days, ...previews].flatMap(window => [Date.parse(window.start), Date.parse(window.end)]))].sort((a, b) => a - b);
  const windows: { start: number; end: number }[] = [];
  for (let i = 1; i < boundaries.length; i++) {
    const start = boundaries[i - 1]!, end = boundaries[i]!;
    if (!isScheduleOpen(schedule, new Date(start + Math.floor((end - start) / 2)))) continue;
    const prior = windows.at(-1);
    if (prior?.end === start) prior.end = end;
    else windows.push({ start, end });
  }
  const now = at.getTime(), window = windows.find(value => value.start <= now && now < value.end);
  if (!window) return null;
  if (schedule.mode === 'ALWAYS' || window.end - window.start > 2 * 86400_000) {
    const day = days.find(value => Date.parse(value.start) <= now && now < Date.parse(value.end))!;
    return { start: new Date(Math.max(window.start, Date.parse(day.start))), end: new Date(Math.min(window.end, Date.parse(day.end))) };
  }
  return { start: new Date(window.start), end: new Date(window.end) };
}

export function windowReservationLimit(input: {
  concurrency: number; maxQueue: number; maxScheduled: number; remainingMs: number; estimatedDurationSeconds: number;
}): number {
  if (input.remainingMs <= 0 || input.concurrency <= 0) return 0;
  // A final start may finish after closing. The queue limit remains a deliberately
  // conservative per-window ceiling, not a promise to fill every projected slot.
  const starts = Math.ceil(input.remainingMs / (Math.max(1, input.estimatedDurationSeconds) * 1000));
  return Math.max(0, Math.min(input.maxScheduled, input.concurrency + input.maxQueue, starts * input.concurrency));
}

export function estimatedCarryover(schedule: Schedule, backlog: number, concurrency: number, estimatedDurationSeconds: number, now: Date, at: Date): number {
  let cursor = now, openMs = 0;
  while (cursor < at) {
    const next = nextScheduledTime(schedule, cursor);
    if (!next || new Date(next) >= at) break;
    const start = new Date(next), window = reservationWindow(schedule, start);
    if (!window || window.end <= cursor) break;
    const end = new Date(Math.min(window.end.getTime(), at.getTime()));
    openMs += end.getTime() - start.getTime(); cursor = window.end;
  }
  const batches = Math.floor(openMs / (Math.max(1, estimatedDurationSeconds) * 1000));
  return Math.max(0, backlog - batches * Math.max(0, concurrency));
}

export async function scheduledAdmission(ctx: ApiContext, tx: Transaction, cap: CapabilityRecord, available: Awaited<ReturnType<typeof availability>>,
  requestedAt: Date, now = new Date()): Promise<Date> {
  const schedule = ScheduleSchema.parse(cap.schedule);
  const earliest = nextScheduledTime(schedule, new Date(Math.max(now.getTime(), requestedAt.getTime())));
  if (!earliest || Date.parse(earliest) > now.getTime() + ctx.config.maxWaitMs) throw new ApiError(409, 'NO_EXECUTION_WINDOW', 'No execution window within the maximum waiting period');
  const at = new Date(earliest), window = reservationWindow(schedule, at);
  if (!window) throw new ApiError(409, 'NO_EXECUTION_WINDOW', 'No execution window is available');
  const scheduledCount = await tx.job.count({ where: { capabilityId: cap.id, state: 'SCHEDULED' } });
  if (scheduledCount >= cap.maxScheduled) throw new ApiError(409, 'SCHEDULE_FULL', 'Future reservations are full');
  const pending = await tx.job.findMany({ where: { capabilityId: cap.id, paymentState: 'RESERVED', executionRevokedAt: null, OR: [
    { state: { in: [...activeStates, 'QUEUED'] } },
    { state: 'SCHEDULED', OR: [{ scheduledAt: { gte: window.start, lt: window.end } }, { scheduledAt: { lte: now } }] },
  ] }, select: { state: true, scheduledAt: true, version: { select: { estimatedDurationSeconds: true } } } });
  const estimatedDurationSeconds = Math.max(cap.currentVersion!.estimatedDurationSeconds, ...pending.map(job => job.version.estimatedDurationSeconds));
  const future = pending.filter(job => job.state === 'SCHEDULED' && job.scheduledAt && job.scheduledAt > now).length;
  const carryover = estimatedCarryover(schedule, pending.length - future, available.effectiveConcurrency, estimatedDurationSeconds, now, at);
  const limit = windowReservationLimit({ concurrency: available.effectiveConcurrency, maxQueue: cap.maxQueue,
    maxScheduled: cap.maxScheduled, remainingMs: window.end.getTime() - at.getTime(), estimatedDurationSeconds });
  if (future + carryover >= limit) throw new ApiError(409, 'SCHEDULE_WINDOW_FULL', 'This execution window has no remaining reservation capacity',
    { windowStart: window.start.toISOString(), windowEnd: window.end.toISOString(), reservationLimit: limit });
  return at;
}

// Call under the same capability lock as purchases/dispatch. Existing execution
// queue admissions remain valid; due reservations fill freed slots before NOW.
export async function promoteScheduled(ctx: ApiContext, tx: Transaction, cap: CapabilityRecord, now = new Date()): Promise<{ id: string; createdAt: Date } | undefined> {
  await lockCapacity(tx, cap.id);
  const plan = await promoteSellerScheduled(ctx, tx, cap.sellerId, now);
  if (plan.remainingDue.has(cap.id)) return (await tx.job.findFirst({ where: { capabilityId: cap.id, state: 'SCHEDULED', paymentState: 'RESERVED', executionRevokedAt: null,
    waitDeadline: { gt: now }, OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }] }, orderBy: [...acceptanceOrder], select: { id: true, createdAt: true } })) ?? undefined;
}

export async function promoteSellerScheduled(ctx: ApiContext, tx: Transaction, sellerId: string, now = new Date()) {
  await lockSellerCapacity(tx, sellerId);
  const plan = await pendingCapacity(ctx, tx, sellerId, now);
  for (const job of plan.promotions) await transition(tx, job, 'QUEUED', 'Scheduled job is now eligible for execution');
  return plan;
}

export function queueHead(tx: Transaction, capabilityId: string, now = new Date()) {
  return tx.job.findFirst({ where: { capabilityId, state: 'QUEUED', paymentState: 'RESERVED', executionRevokedAt: null,
    waitDeadline: { gt: now }, OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }] },
    orderBy: [...acceptanceOrder], include: { version: true } });
}
