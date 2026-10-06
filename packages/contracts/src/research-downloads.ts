import { z } from 'zod';

export const RESEARCH_DOWNLOAD_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/csv'] as const;
export const ResearchDownloadGrantSchema = z.object({
  schemaVersion: z.literal(1),
  allowedMimeTypes: z.array(z.enum(RESEARCH_DOWNLOAD_MIME_TYPES)).min(1).max(5)
    .refine(values => new Set(values).size === values.length, 'Duplicate download MIME type'),
  maxFiles: z.number().int().min(1).max(5),
  maxFileBytes: z.number().int().min(1).max(500_000),
  maxTotalBytes: z.number().int().min(1).max(5_000_000),
}).strict().refine(grant => grant.maxFileBytes <= grant.maxTotalBytes, 'File limit exceeds total download limit');
export type ResearchDownloadGrant = z.infer<typeof ResearchDownloadGrantSchema>;
