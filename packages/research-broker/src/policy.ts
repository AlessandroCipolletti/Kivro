import { z } from 'zod';
import { NetworkPolicyError, parsePublicUrl } from './egress.js';
import { DownloadMimeSchema } from './requests.js';

export const ResearchDownloadPolicySchema = z.object({ schemaVersion: z.literal(1), allowedMimeTypes: z.array(DownloadMimeSchema).min(1).max(5)
  .refine(values => new Set(values).size === values.length), maxFiles: z.number().int().min(1).max(5),
  maxFileBytes: z.number().int().min(1).max(500000), maxTotalBytes: z.number().int().min(1).max(5000000),
}).strict().refine(value => value.maxFileBytes <= value.maxTotalBytes);

export const ResearchPolicySchema = z.object({
  mode: z.enum(['NO_NETWORK', 'PUBLIC_WEB_RESEARCH', 'DECLARED_API_ACCESS']),
  searchEnabled: z.boolean().default(false), fetchEnabled: z.boolean().default(false),
  allowedDomains: z.array(z.string().min(1).max(253)).max(100).optional(),
  maxQueries: z.number().int().min(0).max(30).default(0),
  maxPages: z.number().int().min(0).max(50).default(0),
  maxResponseBytes: z.number().int().min(1).max(5_000_000).default(1_000_000),
  maxTotalBytes: z.number().int().min(1).max(50_000_000).default(5_000_000),
  maxDurationMs: z.number().int().min(1).max(300_000).default(60_000),
  allowedContentTypes: z.array(z.enum(['text/html', 'text/plain', 'application/json'])).default(['text/html', 'text/plain']),
  connectors: z.array(z.string()).max(20).default([]),
  downloads: ResearchDownloadPolicySchema.optional(),
}).strict();
export type ResearchPolicy = z.infer<typeof ResearchPolicySchema>;
export const ResearchLimitsSchema = ResearchPolicySchema.omit({ mode: true, connectors: true, downloads: true }).partial();
export type ResearchLimits = z.infer<typeof ResearchLimitsSchema>;

function domains(values: readonly string[]): string[] {
  return [...new Set(values.map(value => {
    const normalized = value.toLowerCase().replace(/\.$/, '');
    const url = parsePublicUrl(`https://${normalized}/`);
    if (url.hostname !== normalized) throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
    return normalized;
  }))];
}

/** Intersect seller limits with the platform grant. Never changes mode or broadens authority. */
export function narrowResearchPolicy(platform: ResearchPolicy, seller: unknown): ResearchPolicy {
  const base = ResearchPolicySchema.parse(platform); const limit = ResearchLimitsSchema.parse(seller);
  const allowed = base.allowedDomains === undefined ? undefined : domains(base.allowedDomains);
  const requested = limit.allowedDomains === undefined ? undefined : domains(limit.allowedDomains);
  return ResearchPolicySchema.parse({ ...base,
    searchEnabled: base.searchEnabled && (limit.searchEnabled ?? true), fetchEnabled: base.fetchEnabled && (limit.fetchEnabled ?? true),
    allowedDomains: requested === undefined ? allowed : allowed === undefined ? requested : allowed.filter(domain => requested.includes(domain)),
    allowedContentTypes: base.allowedContentTypes.filter(type => !limit.allowedContentTypes || limit.allowedContentTypes.includes(type)),
    ...Object.fromEntries((['maxQueries', 'maxPages', 'maxResponseBytes', 'maxTotalBytes', 'maxDurationMs'] as const)
      .map(key => [key, Math.min(base[key], limit[key] ?? base[key])])),
  });
}

export const ResearchUsageSchema = z.object({ startedAtMs: z.number().int().nonnegative(), queries: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(), reservedBytes: z.number().int().nonnegative(), downloads: z.number().int().nonnegative().optional(), downloadBytes: z.number().int().nonnegative().optional() }).strict();
export type ResearchUsage = z.infer<typeof ResearchUsageSchema>;

/** Call inside the host's durable job-keyed transaction; failed/uncertain calls retain their reservation. */
export function reserveResearchUsage(prior: ResearchUsage | undefined, request: {
  operation: 'SEARCH' | 'FETCH' | 'DOWNLOAD'; maxBytes: number; nowMs: number;
}, rawPolicy: ResearchPolicy): ResearchUsage {
  const policy = ResearchPolicySchema.parse(rawPolicy);
  const { operation, maxBytes, nowMs } = z.object({ operation: z.enum(['SEARCH', 'FETCH', 'DOWNLOAD']), maxBytes: z.number().int().positive(),
    nowMs: z.number().int().nonnegative() }).strict().parse(request);
  const usage = ResearchUsageSchema.parse(prior ?? { startedAtMs: nowMs, queries: 0, pages: 0, reservedBytes: 0 });
  if (policy.mode !== 'PUBLIC_WEB_RESEARCH' || (operation === 'SEARCH' ? !policy.searchEnabled : operation === 'DOWNLOAD' ? !policy.downloads : !policy.fetchEnabled)) throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
  const next = { ...usage, queries: usage.queries + Number(operation === 'SEARCH'), pages: usage.pages + Number(operation !== 'SEARCH'), reservedBytes: usage.reservedBytes + maxBytes,
    ...(operation === 'DOWNLOAD' ? { downloads: (usage.downloads ?? 0) + 1, downloadBytes: (usage.downloadBytes ?? 0) + maxBytes } : {}) };
  if (operation === 'DOWNLOAD' && (!policy.downloads || next.downloads! > policy.downloads.maxFiles || next.downloadBytes! > policy.downloads.maxTotalBytes || maxBytes > policy.downloads.maxFileBytes)) throw new NetworkPolicyError('NETWORK_BUDGET_EXCEEDED');
  if (nowMs < usage.startedAtMs || nowMs - usage.startedAtMs >= policy.maxDurationMs || maxBytes > policy.maxResponseBytes ||
    next.queries > policy.maxQueries || next.pages > policy.maxPages || next.reservedBytes > policy.maxTotalBytes || !Number.isSafeInteger(next.reservedBytes)) {
    throw new NetworkPolicyError('NETWORK_BUDGET_EXCEEDED');
  }
  return next;
}
