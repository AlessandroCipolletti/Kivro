import type { PrismaClient } from '@kivro/database';
import type { SellerCapabilityLiveState } from '@kivro/contracts/responses';

type Load = Pick<SellerCapabilityLiveState, 'runningJobs' | 'queueDepth' | 'effectiveConcurrency' | 'capacityLoad'>;

export async function sellerCapabilityLiveState(db: PrismaClient, sellerId: string, capabilityId: string, load: Load): Promise<SellerCapabilityLiveState> {
  const observedAt = new Date();
  // A historical success proves that version only, never the current draft's readiness.
  const lastSuccess = await db.job.findFirst({ where: { sellerId, capabilityId, state: 'SUCCEEDED', completedAt: { lte: observedAt } },
    orderBy: [{ completedAt: 'desc' }, { id: 'desc' }], select: { id: true, capabilityVersionId: true, completedAt: true } });
  const scheduledJobs = await db.job.count({ where: { sellerId, capabilityId, state: 'SCHEDULED' } });
  return { observedAt: observedAt.toISOString(), ...load, scheduledJobs,
    lastSuccess: lastSuccess?.completedAt ? { jobId: lastSuccess.id, capabilityVersionId: lastSuccess.capabilityVersionId,
      completedAt: lastSuccess.completedAt.toISOString() } : null };
}
