import { z } from 'zod';
import { hashManifest, WorkerUsageReceiptSchema, type JobOffer } from '@kivro/contracts';
import type { ExecutionResult, SelectedSkill } from '@kivro/openclaw-adapter';
import type { WorkerState } from './state.ts';
import type { LocalCapability } from './capabilities.ts';

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/), resourceId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ObservationReportSchema = z.object({ schemaVersion: z.literal(1), capabilityVersionId: z.string().uuid(), attemptId: z.string().uuid(), manifestHash: digest, imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), testedAt: z.string().datetime(),
  toolInstrumentation: z.enum(['OPENCLAW_CLI_AND_REVIEWED_PLUGIN', 'UNAVAILABLE']),
  toolSummary: z.object({ calls: z.number().int().min(0).max(128), failures: z.number().int().min(0).max(128) }).strict().optional(),
  tools: z.array(z.object({ name, succeeded: z.number().int().nonnegative().max(128), failed: z.number().int().nonnegative().max(128), observedWithoutOutcome: z.boolean() }).strict()).max(50),
  executables: z.array(z.object({ name: z.enum(['blender', 'ffmpeg']), viaTool: name, provenance: z.literal('PINNED_IMAGE_WRAPPER') }).strict()).max(2),
  skills: z.array(z.object({ name, sha256: digest, evidence: z.literal('LOADED_NOT_PROVEN_INVOKED') }).strict()).max(10),
  resources: z.array(z.object({ id: resourceId, operations: z.array(name).max(30), evidence: z.literal('HOST_BROKER_COMPLETED') }).strict()).max(50),
  network: z.array(z.object({ host: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,252}$/), operation: z.enum(['SEARCH', 'FETCH', 'DOWNLOAD', 'CONNECTOR']), succeeded: z.boolean(), actualBytes: z.number().int().nonnegative().max(5000000).nullable(), responseSha256: digest.optional() }).strict()).max(10),
  inference: WorkerUsageReceiptSchema,
  missingBindings: z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,280}$/)).max(100),
}).strict();
export type ObservationReport = z.infer<typeof ObservationReportSchema>;
export function observationReport(input: { offer: JobOffer; imageId: string; result: ExecutionResult; skills: SelectedSkill[]; resourceOperations: ReadonlyMap<string, Set<string>>; researchState: WorkerState; usage: z.infer<typeof WorkerUsageReceiptSchema> }): ObservationReport {
  const { offer, result } = input, tools = new Map<string, { name: string; succeeded: number; failed: number; observedWithoutOutcome: boolean }>(), missing = new Set<string>();
  const declared = offer.dependencies.filter(dep => dep.approved && dep.healthy && dep.supported === true);
  for (const observation of result.observations ?? []) {
    name.parse(observation.name);
    if (!offer.permissions.tools.includes(observation.name)) throw new Error('UNDECLARED_TOOL_OBSERVATION');
    const entry = tools.get(observation.name) ?? { name: observation.name, succeeded: 0, failed: 0, observedWithoutOutcome: false };
    if (observation.outcome === 'OBSERVED') entry.observedWithoutOutcome = true; else entry[observation.outcome === 'SUCCEEDED' ? 'succeeded' : 'failed']++; tools.set(entry.name, entry);
    if (!declared.some(dep => dep.grants?.tools?.includes(entry.name))) missing.add(`tool:${entry.name}`);
  }
  const resources = [...input.resourceOperations].map(([id, operations]) => {
    if (!declared.some(dep => dep.grants?.resources?.includes(id))) missing.add(`resource:${id}`);
    return { id, operations: [...operations].sort(), evidence: 'HOST_BROKER_COMPLETED' as const };
  });
  const network = (input.researchState.get<string[]>(`researchRequests:${offer.jobId}`) ?? []).map(id => {
    const entry = input.researchState.get<{ context: { attemptId: string }; host: string; operation: 'SEARCH' | 'FETCH' | 'DOWNLOAD' | 'CONNECTOR'; ok?: boolean; actualBytes?: number | null; responseSha256?: string }>(`researchRequest:${id}`)!;
    if (entry.context.attemptId !== offer.attemptId) return undefined;
    const specializedSearch = entry.operation === 'SEARCH' && entry.host === 'api.search.brave.com' && declared.some(dep => dep.grants?.credentialRefs?.includes('research-brave'));
    if (!specializedSearch && !declared.some(dep => dep.grants?.domains?.includes(entry.host))) missing.add(`domain:${entry.host}`);
    return { host: entry.host, operation: entry.operation, succeeded: entry.ok === true, actualBytes: entry.actualBytes ?? null, ...(entry.responseSha256 ? { responseSha256: entry.responseSha256 } : {}) };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (input.usage.attemptedCalls && !declared.some(dep => dep.grants?.inferenceProviders?.includes(input.usage.provider))) missing.add(`inference:${input.usage.provider}`);
  return ObservationReportSchema.parse({ schemaVersion: 1, capabilityVersionId: offer.capabilityVersionId, attemptId: offer.attemptId, manifestHash: offer.manifestHash, imageId: input.imageId, testedAt: new Date().toISOString(),
    toolInstrumentation: result.observations === undefined ? 'UNAVAILABLE' : 'OPENCLAW_CLI_AND_REVIEWED_PLUGIN', toolSummary: result.toolSummary, tools: [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)),
    executables: [...tools.values()].filter(tool => tool.succeeded && ['blender.render', 'ffmpeg.transcode'].includes(tool.name)).map(tool => ({ name: tool.name === 'blender.render' ? 'blender' : 'ffmpeg', viaTool: tool.name, provenance: 'PINNED_IMAGE_WRAPPER' })),
    skills: input.skills.map(skill => ({ name: skill.name, sha256: skill.sha256, evidence: 'LOADED_NOT_PROVEN_INVOKED' })), resources, network, inference: input.usage, missingBindings: [...missing].sort(),
  });
}
export function reviewObservations(state: WorkerState, versionId: string, approval?: string) {
  z.string().uuid().parse(versionId);
  const report = ObservationReportSchema.parse(state.get(`observations:${versionId}`)), capability = state.get<LocalCapability>(`capability:${versionId}`);
  if (!capability || report.capabilityVersionId !== versionId || report.manifestHash !== capability.manifestHash || report.imageId !== state.get('approvedImageId')) throw new Error('OBSERVATION_BINDING_CHANGED');
  const approvalHash = hashManifest(report);
  if (approval !== approvalHash) return { report, approvalHash, reviewed: false, grantsChanged: false };
  if (report.missingBindings.length) throw new Error('OBSERVED_DEPENDENCIES_REQUIRE_NEW_MANIFEST');
  state.set(`observationReview:${versionId}`, { approvalHash, manifestHash: report.manifestHash, reviewedAt: new Date().toISOString() }); state.audit('DEPENDENCY_OBSERVATIONS_REVIEWED', 'LOCAL', versionId);
  return { approvalHash, reviewed: true, grantsChanged: false };
}
