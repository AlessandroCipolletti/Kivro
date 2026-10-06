import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ResearchContext } from './broker.js';
import { NetworkPolicyError, parsePublicUrl } from './egress.js';
import { ResearchLimitsSchema, type ResearchLimits } from './policy.js';
import { FetchRequestSchema, SearchRequestSchema, DownloadRequestSchema } from './requests.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const PublicResearchReferenceSchema = z.object({ reviewedSourceId: sourceId }).strict();
const provenance = z.object({ kind: z.literal('REVIEWED_PUBLIC_LITERAL'), sourceUrl: z.string().url().max(4096),
  reviewedBy: z.string().uuid(), reviewedAt: z.string().datetime() }).strict();
const source = z.discriminatedUnion('operation', [
  z.object({ id: sourceId, provenance, operation: z.literal('SEARCH'), request: SearchRequestSchema }).strict(),
  z.object({ id: sourceId, provenance, operation: z.literal('FETCH'), request: FetchRequestSchema }).strict(),
  z.object({ id: sourceId, provenance, operation: z.literal('DOWNLOAD'), request: DownloadRequestSchema }).strict(),
]);
export const ReviewedPublicResearchPlanSchema = z.object({ schemaVersion: z.literal(1), capabilityVersionId: z.string().uuid(),
  dependencyBindingHash: digest, limits: ResearchLimitsSchema, sources: z.array(source).min(1).max(30),
}).strict().superRefine((plan, context) => {
  if (new Set(plan.sources.map(item => item.id)).size !== plan.sources.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate source ID.' });
  for (const item of plan.sources) {
    try {
      parsePublicUrl(item.provenance.sourceUrl, { httpsOnly: true });
      if (item.operation !== 'SEARCH') parsePublicUrl(item.request.url, { httpsOnly: true });
    } catch { context.addIssue({ code: z.ZodIssueCode.custom, message: 'Public HTTPS source required.' }); }
  }
});
export type ReviewedPublicResearchPlan = z.infer<typeof ReviewedPublicResearchPlanSchema>;
const scopeSchema = z.object({ userId: z.string().uuid(), jobId: z.string().uuid(), capabilityVersionId: z.string().uuid(), attemptId: z.string().uuid() }).strict();
export type PublicResearchScope = z.infer<typeof scopeSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Hash the normalized, fully reviewed plan. This is not itself approval or a publicness classifier. */
export function publicResearchPlanHash(raw: unknown): string {
  return createHash('sha256').update(canonical(ReviewedPublicResearchPlanSchema.parse(raw))).digest('hex');
}
export interface CompiledPublicResearchPlan {
  readonly planHash: string; readonly scope: Readonly<PublicResearchScope>; readonly expiresAt: string;
  readonly dependencyBindingHash: string;
  readonly searchSourceIds: readonly string[]; readonly fetchSourceIds: readonly string[]; readonly downloadSourceIds: readonly string[];
}
const registered = new WeakMap<CompiledPublicResearchPlan, ReviewedPublicResearchPlan>();

/** Trusted host only. Approval hashes must come from immutable local consent, never model/request input. */
export function compilePublicResearchPlan(input: {
  plan: unknown; scope: PublicResearchScope; approvedPlanHash: string; approvedDependencyBindingHash: string; expiresAt: string; now?: Date;
}): CompiledPublicResearchPlan {
  const plan = ReviewedPublicResearchPlanSchema.parse(input.plan); const scope = scopeSchema.parse(input.scope);
  const planHash = publicResearchPlanHash(plan); const expiresAt = z.string().datetime().parse(input.expiresAt);
  const now = (input.now ?? new Date()).getTime(); const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(now) || expiry <= now || expiry - now > 24 * 3600_000 ||
    planHash !== digest.parse(input.approvedPlanHash) || plan.dependencyBindingHash !== digest.parse(input.approvedDependencyBindingHash) ||
    plan.capabilityVersionId !== scope.capabilityVersionId || plan.sources.some(item => Date.parse(item.provenance.reviewedAt) > now)) {
    throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
  }
  const token = Object.freeze({ planHash, scope: Object.freeze(scope), expiresAt, dependencyBindingHash: plan.dependencyBindingHash,
    searchSourceIds: Object.freeze(plan.sources.filter(item => item.operation === 'SEARCH').map(item => item.id)),
    fetchSourceIds: Object.freeze(plan.sources.filter(item => item.operation === 'FETCH').map(item => item.id)),
    downloadSourceIds: Object.freeze(plan.sources.filter(item => item.operation === 'DOWNLOAD').map(item => item.id)) });
  registered.set(token, plan); return token;
}

export function resolvePublicResearchRequest(token: CompiledPublicResearchPlan | undefined, context: ResearchContext,
  operation: 'SEARCH' | 'FETCH' | 'DOWNLOAD', raw: unknown): { request: unknown; limits: ResearchLimits; publicPlanHash: string; publicSourceId: string } {
  const reference = PublicResearchReferenceSchema.parse(raw); const plan = token && registered.get(token);
  if (!token || !plan || Date.now() >= Date.parse(token.expiresAt) ||
    (Object.keys(token.scope) as (keyof PublicResearchScope)[]).some(key => context[key] !== token.scope[key])) throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
  const item = plan.sources.find(item => item.id === reference.reviewedSourceId && item.operation === operation);
  if (!item) throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
  return { request: structuredClone(item.request), limits: structuredClone(plan.limits), publicPlanHash: token.planHash, publicSourceId: item.id };
}
