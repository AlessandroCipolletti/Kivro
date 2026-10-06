import { randomUUID } from 'node:crypto';
import { getPriceTier, type CapabilityDTO } from '@kivro/contracts';
import { vi } from 'vitest';
import { AgentPolicyError, type JobExecutionResult, type MarketplaceCatalog, type OrchestrationPlan, type PlanRepository, type PurchaseExecutor } from '../src/types.js';
import { OrchestrationService } from '../src/orchestration.js';

export const now = new Date('2026-10-06T10:00:00.000Z');
export const buyerId = randomUUID();
export function capability(overrides: Partial<CapabilityDTO> = {}): CapabilityDTO {
  return { id: randomUUID(), slug: 'research', title: 'Company research', summary: 'Company research report', description: 'Public description', category: 'Research', tags: ['company'],
    seller: { id: randomUUID(), name: 'Seller' }, visibility: 'PUBLIC', version: 1, versionId: randomUUID(), priceTierId: 'USD_99',
    ioContract: { schemaVersion: 1, inputs: [{ key: 'subject', label: 'Subject', type: 'SHORT_TEXT', required: true, order: 0 }],
      output: { type: 'TEXT', description: 'Report', required: true } },
    permissions: { schemaVersion: 1, tools: [], network: { mode: 'NONE', allowedDomains: [] }, resources: [],
      inference: { provider: 'seller-provider', model: 'seller-model', credentialRef: 'never-send-seller-secret' },
      limits: { timeoutSeconds: 120, memoryMb: 512, cpu: 1, maxPids: 32, maxInputBytes: 10000, maxOutputBytes: 10000, maxTokens: 1000 } },
    dependencies: [], availability: { status: 'ONLINE', canRunNow: true, nextAvailableAt: null, reason: null },
    estimatedDurationSeconds: 60, successRate: 100, completedJobs: 20, rating: 4.8, reviewCount: 20, examples: [], ...overrides };
}
export function harness(initial: CapabilityDTO[] = [capability()]) {
  const capabilities = new Map(initial.map(c => [c.id, c])); const plans = new Map<string, OrchestrationPlan>();
  const jobs = new Map<string, JobExecutionResult>(); const keys = new Map<string, string>();
  const catalog: MarketplaceCatalog = {
    search: vi.fn(async () => ({ capabilities: [...capabilities.values()] })),
    get: vi.fn(async id => structuredClone(capabilities.get(id) ?? null)),
    quote: vi.fn(async request => ({ id: randomUUID(), capabilityId: request.capabilityId, capabilityVersionId: request.capabilityVersionId,
      amountMinor: getPriceTier(capabilities.get(request.capabilityId)!.priceTierId).buyerPriceMinor,
      expiresAt: '2026-10-06T10:30:00.000Z', earliestStartAt: now.toISOString(), estimatedDeliveryAt: '2026-10-06T10:01:00.000Z' })),
  };
  const repository: PlanRepository = {
    create: vi.fn(async plan => { plans.set(plan.id, structuredClone(plan)); }),
    get: vi.fn(async (id, userId) => { const plan = plans.get(id); return plan && plan.userId === userId ? structuredClone(plan) : null; }),
    compareAndSwap: vi.fn(async (plan, revision) => { if (plans.get(plan.id)?.revision !== revision) return false; plans.set(plan.id, structuredClone(plan)); return true; }),
    compareAndSwapQuiescent: vi.fn(async (plan, revision, expectedJobs) => {
      const actualJobs = [...keys].filter(([key]) => key.startsWith(`orchestration:${plan.id}:`)).map(([, id]) => id).sort();
      if (plans.get(plan.id)?.revision !== revision || JSON.stringify(actualJobs) !== JSON.stringify(expectedJobs) ||
        actualJobs.some(id => jobs.get(id)?.state === 'PENDING')) return false;
      plans.set(plan.id, structuredClone(plan)); return true;
    }),
  };
  const executor: PurchaseExecutor = {
    lookupCreatedJob: vi.fn(async request => { const jobId = keys.get(request.idempotencyKey); return jobId ? { jobId } : null; }),
    createJob: vi.fn(async request => {
      const existing = keys.get(request.idempotencyKey); if (existing) return { jobId: existing };
      if (plans.get(request.planId)?.revision !== request.expectedPlanRevision) throw new AgentPolicyError('PLAN_CONFLICT');
      const jobId = randomUUID(); keys.set(request.idempotencyKey, jobId); jobs.set(jobId, { id: jobId, state: 'PENDING' }); return { jobId };
    }),
    getJob: vi.fn(async id => structuredClone(jobs.get(id)!)), authorizeAssetTransfer: vi.fn(async () => {}),
  };
  const service = new OrchestrationService({ catalog, plans: repository, executor, now: () => now });
  return { capabilities, plans, jobs, keys, catalog, repository, executor, service };
}
