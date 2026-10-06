import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PublicationEvidenceSchema = z.object({
  schemaVersion: z.literal(1), source: z.literal('SIGNED_WORKER_VALIDATION'),
  capabilityVersionId: z.string().uuid(), manifestHash: hash, recordedAt: z.string().datetime(),
  localExecutionAcknowledgement: z.object({ revision: z.literal(1), acceptedBy: z.string().uuid(), acceptedAt: z.string().datetime() }).strict().optional(),
  workerId: z.string().uuid(), workerVersion: z.string().min(1).max(100),
  openclawVersion: z.string().min(1).max(100),
  workerConfig: z.object({ schemaVersion: z.literal(1), executionManifestHash: hash, inferenceConfigHash: hash }).strict(),
  sandbox: z.object({ imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), policyVersion: z.number().int().positive(), testedAt: z.number().int().positive() }).strict(),
  inferenceTestedAt: z.number().int().positive(),
  dependencyBundleHash: hash,
  skills: z.array(z.object({ id: z.string(), name: z.string(), contentHash: hash.nullable() }).strict()).max(100),
  evidenceHash: hash,
}).strict();
export type PublicationEvidence = z.infer<typeof PublicationEvidenceSchema>;
