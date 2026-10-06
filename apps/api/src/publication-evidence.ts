import { z } from 'zod';
import { DependencySchema, hashManifest } from '@kivro/contracts';
import { PublicationEvidenceSchema } from '@kivro/contracts/publication-evidence';
import { ADAPTER_POLICY_VERSION } from '@kivro/openclaw-adapter';
import type { CapabilityVersion, Transaction } from '@kivro/database';
import { loadSecurityPolicy, workerPolicyReason } from './security-policy.js';
import { ApiError } from './errors.js';

const proofSchema = z.object({
  sandbox: z.object({ imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), policyVersion: z.literal(ADAPTER_POLICY_VERSION), testedAt: z.number().int().positive() }).strict(),
  inference: z.object({ configHash: z.string().regex(/^[a-f0-9]{64}$/), testedAt: z.number().int().positive() }).strict(),
}).strict();

export async function publicationEvidence(tx: Transaction, version: CapabilityVersion, sellerId: string, heartbeatTtlMs: number, now = new Date()) {
  const lifecycle = await tx.capabilityVersionLifecycle.findUnique({ where: { versionId: version.id } });
  const cutoff = Math.max(now.getTime() - 24 * 3600_000, lifecycle?.testingStartedAt?.getTime() ?? 0);
  const bindings = await tx.workerBinding.findMany({ where: {
    capabilityVersionId: version.id, healthy: true, validationStatus: 'PASSED', validatedManifestHash: version.manifestHash,
    validatedAt: { gte: new Date(cutoff) }, worker: { sellerId, revokedAt: null, paused: false, localPaused: false, sandboxReady: true, lastSeenAt: { gt: new Date(now.getTime() - heartbeatTtlMs) } },
  }, include: { worker: true }, orderBy: [{ validatedAt: 'desc' }, { workerId: 'asc' }] });
  const policy = await loadSecurityPolicy(tx);
  for (const binding of bindings) {
    const proof = proofSchema.safeParse(binding.validationProof);
    if (workerPolicyReason(binding.worker, policy) || !proof.success || !binding.worker.openclawVersion ||
        [proof.data.sandbox.testedAt, proof.data.inference.testedAt].some(time => time < cutoff || time > now.getTime() + 60_000)) continue;
    const dependencies = z.array(DependencySchema).parse(version.dependencies);
    const evidence = {
      schemaVersion: 1 as const, source: 'SIGNED_WORKER_VALIDATION' as const,
      capabilityVersionId: version.id, manifestHash: version.manifestHash, recordedAt: now.toISOString(),
      localExecutionAcknowledgement: { revision: 1 as const, acceptedBy: sellerId, acceptedAt: now.toISOString() },
      workerId: binding.workerId, workerVersion: binding.worker.version, openclawVersion: binding.worker.openclawVersion,
      workerConfig: { schemaVersion: 1 as const, executionManifestHash: version.manifestHash, inferenceConfigHash: proof.data.inference.configHash },
      sandbox: proof.data.sandbox, inferenceTestedAt: proof.data.inference.testedAt,
      dependencyBundleHash: hashManifest(dependencies),
      skills: dependencies.filter(dependency => dependency.type === 'SKILL').map(dependency => ({ id: dependency.id, name: dependency.name, contentHash: dependency.contentHash ?? null })),
    };
    return PublicationEvidenceSchema.parse({ ...evidence, evidenceHash: hashManifest(evidence) });
  }
  throw new ApiError(409, 'PUBLICATION_EVIDENCE_REQUIRED', 'A fresh validated Worker environment is required for publication');
}
