import { z } from 'zod';
import { hashManifest, type Dependency, type IOContract, type PermissionManifest } from '@kivro/contracts';
import { ReviewedPublicResearchPlanSchema, publicResearchPlanHash, narrowResearchPolicy, ResearchPolicySchema, parsePublicUrl } from '@kivro/research-broker';
import type { WorkerState } from './state.ts';
import type { LocalCapability } from './capabilities.ts';

export const RESEARCH_POLICY_VERSION = 1;
export const RESEARCH_CEILINGS = Object.freeze({ maxQueries: 5, maxPages: 5, maxResponseBytes: 500000, maxTotalBytes: 5000000, maxDurationMs: 60000 });
type ResearchCapability = { capabilityVersionId: string; ioContract: IOContract; permissions: PermissionManifest; dependencies: Dependency[] };
export const ResearchConsentSchema = z.object({ plan: ReviewedPublicResearchPlanSchema, planHash: z.string().regex(/^[a-f0-9]{64}$/), dependencyBindingHash: z.string().regex(/^[a-f0-9]{64}$/), sellerId: z.string().uuid(), approvedAt: z.string().datetime(), policyVersion: z.literal(RESEARCH_POLICY_VERSION) }).strict();
export type ResearchConsent = z.infer<typeof ResearchConsentSchema>;
export function researchPolicy(permissions: PermissionManifest, connectors: string[] = []) {
  return narrowResearchPolicy(ResearchPolicySchema.parse({ mode: permissions.network.mode === 'RESEARCH' ? 'PUBLIC_WEB_RESEARCH' : permissions.network.mode === 'CONNECTORS' ? 'DECLARED_API_ACCESS' : 'NO_NETWORK', connectors,
    searchEnabled: permissions.tools.includes('research.search'), fetchEnabled: permissions.tools.includes('research.fetch'), allowedDomains: permissions.network.allowedDomains, ...RESEARCH_CEILINGS,
    ...(permissions.tools.includes('research.download') ? { downloads: permissions.network.downloads } : {}),
  }), permissions.network.researchLimits ?? {});
}
export function needsSellerAuthority(permissions: PermissionManifest): boolean { return permissions.tools.some(tool => ['research.search', 'research.fetch', 'research.download', 'connector.call'].includes(tool)); }
export function privateResearch(capability: Pick<ResearchCapability, 'ioContract' | 'permissions' | 'dependencies'>): boolean {
  return capability.permissions.resources.length > 0 || capability.dependencies.some(dep => dep.type === 'SKILL') || capability.ioContract.inputs.some(field => ['FILE', 'FILES'].includes(field.type) || field.constraints?.semanticType !== 'PUBLIC');
}
function checkPlan(capability: ResearchCapability, consent: ResearchConsent, sellerId?: string): void {
  const { plan } = consent;
  if (capability.permissions.network.mode !== 'RESEARCH' || plan.capabilityVersionId !== capability.capabilityVersionId || consent.planHash !== publicResearchPlanHash(plan) ||
    plan.dependencyBindingHash !== hashManifest(capability.dependencies) || consent.dependencyBindingHash !== plan.dependencyBindingHash || sellerId !== undefined && consent.sellerId !== sellerId ||
    plan.sources.some(source => source.provenance.reviewedBy !== consent.sellerId || Date.parse(source.provenance.reviewedAt) > Date.now())) throw new Error('RESEARCH_CONSENT_MISMATCH');
  const policy = narrowResearchPolicy(researchPolicy(capability.permissions), plan.limits);
  if (plan.sources.filter(source => source.operation === 'SEARCH').length > policy.maxQueries || plan.sources.filter(source => source.operation !== 'SEARCH').length > policy.maxPages ||
    plan.sources.length * Math.min(policy.maxResponseBytes, policy.maxTotalBytes) > policy.maxTotalBytes) throw new Error('RESEARCH_PLAN_EXCEEDS_BUDGET');
  const downloads = plan.sources.filter(source => source.operation === 'DOWNLOAD');
  if (downloads.length && (!policy.downloads || downloads.length > policy.downloads.maxFiles || downloads.length * Math.min(policy.downloads.maxFileBytes, policy.maxResponseBytes) > policy.downloads.maxTotalBytes || downloads.some(source => !policy.downloads!.allowedMimeTypes.includes(source.request.expectedMimeType)))) throw new Error('RESEARCH_DOWNLOAD_PLAN_EXCEEDS_GRANT');
  if (policy.downloads && !downloads.length) throw new Error('RESEARCH_DOWNLOAD_SOURCE_REQUIRED');
  for (const source of plan.sources) {
    if (source.operation === 'SEARCH' ? !policy.searchEnabled : source.operation === 'DOWNLOAD' ? !policy.downloads : !policy.fetchEnabled) throw new Error('RESEARCH_PLAN_TOOL_NOT_GRANTED');
    if (source.operation !== 'SEARCH') parsePublicUrl(source.request.url, { httpsOnly: true, allowedDomains: policy.allowedDomains });
  }
}
export function selectedResearchConsent(state: WorkerState, capability: ResearchCapability, sellerId?: string): ResearchConsent | undefined {
  if (!capability.permissions.tools.some(tool => tool.startsWith('research.'))) return;
  const raw = state.get(`researchPlan:${capability.capabilityVersionId}`);
  if (!raw) { if (privateResearch(capability) || capability.permissions.network.downloads) throw new Error('REVIEWED_PUBLIC_RESEARCH_PLAN_REQUIRED'); return; }
  const consent = ResearchConsentSchema.parse(raw); checkPlan(capability, consent, sellerId); return consent;
}
function invalidate(state: WorkerState, id: string): void {
  state.delete(`capabilityProof:${id}`); state.delete(`capabilityHealth:${id}`); state.set(`revalidationRequired:${id}`, true);
}
/** sellerId comes only from authenticated device diagnostics, never the plan. */
export function approveResearchPlan(state: WorkerState, raw: unknown, sellerId: string, approval?: string) {
  z.string().uuid().parse(sellerId);
  const plan = ReviewedPublicResearchPlanSchema.parse(raw), capability = state.get<LocalCapability>(`capability:${plan.capabilityVersionId}`);
  if (!capability) throw new Error('CAPABILITY_NOT_APPROVED');
  const consent: ResearchConsent = { plan, planHash: publicResearchPlanHash(plan), dependencyBindingHash: plan.dependencyBindingHash, sellerId, approvedAt: new Date().toISOString(), policyVersion: RESEARCH_POLICY_VERSION };
  checkPlan(capability, consent, sellerId);
  const approvalHash = hashManifest({ planHash: consent.planHash, sellerId, policyVersion: RESEARCH_POLICY_VERSION });
  if (approval !== approvalHash) return { approved: false, plan, approvalHash, effectivePolicy: narrowResearchPolicy(researchPolicy(capability.permissions), plan.limits), consent: 'Approve only fixed public literals. No buyer/file/database interpolation. Every selected source is fetched before private execution; seller-origin traffic and dedicated search charges remain visible to the provider.' };
  const history = state.get<{ approvalHash: string }>(`researchPlanHistory:${plan.capabilityVersionId}`);
  if (history && history.approvalHash !== approvalHash) throw new Error('IMMUTABLE_RESEARCH_PLAN_USE_NEW_VERSION');
  state.transaction(() => {
    state.set(`researchPlan:${plan.capabilityVersionId}`, consent); state.set(`researchPlanHistory:${plan.capabilityVersionId}`, { approvalHash });
    invalidate(state, plan.capabilityVersionId); state.audit('PUBLIC_RESEARCH_PLAN_CONSENT', 'LOCAL', plan.capabilityVersionId);
  });
  return { approved: true, approvalHash, planHash: consent.planHash, versionId: plan.capabilityVersionId, revalidationRequired: true };
}
export function revokeResearchPlan(state: WorkerState, id: string): void {
  z.string().uuid().parse(id);
  state.transaction(() => { state.delete(`researchPlan:${id}`); invalidate(state, id); state.audit('PUBLIC_RESEARCH_PLAN_REVOKED', 'LOCAL', id); });
}
