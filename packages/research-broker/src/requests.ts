import { z } from 'zod';

export const SearchRequestSchema = z.object({ query: z.string().trim().min(1).max(600).refine(s => s.split(/\s+/).length <= 75),
  maxResults: z.number().int().min(1).max(20).default(10), locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/).optional(),
  freshness: z.enum(['pd', 'pw', 'pm', 'py']).optional() }).strict();
export const FetchRequestSchema = z.object({ url: z.string().max(4096), method: z.enum(['GET', 'HEAD']).default('GET') }).strict();
export const DownloadMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/csv']);
export const DownloadRequestSchema = z.object({ url: z.string().max(4096), expectedMimeType: DownloadMimeSchema,
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
