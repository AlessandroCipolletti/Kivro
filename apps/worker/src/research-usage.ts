import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashManifest } from '@kivro/contracts';
import { reserveResearchUsage, type ResearchAccounting, type ResearchContext, type ResearchUsage } from '@kivro/research-broker';
import type { WorkerState } from './state.ts';

const host = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,252}$/);
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);
const metadata = z.object({ bytes: z.number().int().nonnegative().max(5000000), ok: z.boolean(), code: code.optional(), status: z.number().int().min(100).max(599).optional(),
  contentType: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/).max(100).optional(), queryHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), provider: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/).optional(),
  destinationHost: host.optional(), publicPlanHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), publicSourceId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), contentBytes: z.number().int().positive().max(500000).optional(),
}).strict();
type Reservation = { id: string; context: ResearchContext; operation: 'SEARCH' | 'FETCH' | 'DOWNLOAD' | 'CONNECTOR'; host: string; reservedBytes: number; startedAt: number; policyHash: string; finishedAt?: number; ok?: boolean; actualBytes?: number | null; code?: string };
export function researchAccounting(state: WorkerState, context: ResearchContext, assertActive: () => void): ResearchAccounting {
  return {
    reserve: async request => {
      assertActive();
      if (hashManifest(request.context) !== hashManifest(context)) throw new Error('BROKER_JOB_BINDING_MISMATCH');
      host.parse(request.host);
      if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0 || request.maxBytes > request.policy.maxResponseBytes) throw new Error('RESEARCH_BUDGET_EXCEEDED');
      return state.transaction(() => {
        const now = Date.now(), key = `research:${context.jobId}`;
        if (request.operation !== 'CONNECTOR') state.set(key, reserveResearchUsage(state.get<ResearchUsage>(key), { operation: request.operation, maxBytes: request.maxBytes, nowMs: now }, request.policy));
        else {
          const usage = state.get<{ count: number; bytes: number; started: number }>(`connectorUsage:${context.jobId}`) ?? { count: 0, bytes: 0, started: now };
          if (usage.count >= 10 || usage.bytes + request.maxBytes > request.policy.maxTotalBytes || now < usage.started || now - usage.started >= request.policy.maxDurationMs) throw new Error('RESEARCH_BUDGET_EXCEEDED');
          state.set(`connectorUsage:${context.jobId}`, { count: usage.count + 1, bytes: usage.bytes + request.maxBytes, started: usage.started });
        }
        const day = new Date(now).toISOString().slice(0, 10), dailyKey = `researchDaily:${day}`, daily = state.get<number>(dailyKey) ?? 0;
        const hostKey = `researchHost:${request.host}`, recent = (state.get<number[]>(hostKey) ?? []).filter(at => now - at < 60000);
        if (daily >= 500 || recent.length >= 30 || recent.some(at => at > now)) throw new Error('RESEARCH_RATE_LIMIT');
        const idsKey = `researchRequests:${context.jobId}`, ids = state.get<string[]>(idsKey) ?? [];
        if (ids.length >= 10) throw new Error('RESEARCH_BUDGET_EXCEEDED');
        const id = randomUUID();
        state.set(`researchRequest:${id}`, { id, context, operation: request.operation, host: request.host, reservedBytes: request.maxBytes, startedAt: now, policyHash: hashManifest(request.policy) } satisfies Reservation);
        state.set(idsKey, [...ids, id]); state.set(dailyKey, daily + 1); state.set(hostKey, [...recent, now]);
        state.audit('RESEARCH_REQUEST_RESERVED', 'BROKER', context.jobId); return id;
      });
    },
    finish: async (id, raw) => {
      const record = state.get<Reservation>(`researchRequest:${z.string().uuid().parse(id)}`);
      if (!record || hashManifest(record.context) !== hashManifest(context) || record.finishedAt !== undefined) throw new Error('RESEARCH_RESERVATION_MISMATCH');
      const parsed = metadata.safeParse(raw);
      const valid = parsed.success && parsed.data.bytes <= record.reservedBytes;
      const result = valid ? parsed.data : { ok: false, code: 'INVALID_RESEARCH_TELEMETRY', bytes: record.reservedBytes };
      const { bytes, ...safe } = result;
      // Failed operations report a worst-case reservation, not measured traffic.
      state.set(`researchRequest:${id}`, { ...record, ...safe, finishedAt: Date.now(), actualBytes: result.ok ? bytes : null });
      state.audit(result.ok ? 'RESEARCH_REQUEST_COMPLETED' : 'RESEARCH_REQUEST_FAILED', 'BROKER', context.jobId);
    },
  };
}

export function recordResearchPage(state: WorkerState, context: ResearchContext, raw: unknown, sourceId?: string): void {
  const page = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative().max(500000), fetchedAt: z.string().datetime() }).parse(raw);
  const ids = state.get<string[]>(`researchRequests:${context.jobId}`) ?? [];
  // Direct fetches are serialized; reviewed prefetches have unique source IDs.
  // Never overwrite a prior receipt or guess if this invariant breaks.
  const candidates = ids.map(id => state.get<Reservation & { publicSourceId?: string; responseSha256?: string }>(`researchRequest:${id}`))
    .filter((record): record is NonNullable<typeof record> => !!record?.ok && record.operation === 'FETCH' && hashManifest(record.context) === hashManifest(context) && record.publicSourceId === sourceId && record.responseSha256 === undefined);
  if (candidates.length !== 1) throw new Error('RESEARCH_RESULT_RESERVATION_AMBIGUOUS');
  const record = candidates[0]!;
  if (page.bytes > (record.actualBytes ?? 0)) throw new Error('INVALID_RESEARCH_TELEMETRY');
  state.set(`researchRequest:${record.id}`, { ...record, responseSha256: page.sha256, contentBytes: page.bytes, fetchedAt: page.fetchedAt });
}
