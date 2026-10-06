import { join } from 'node:path';
import { hashManifest, type PermissionManifest, type Dependency } from '@kivro/contracts';
import { LocalResourceBroker, hashResourceConfiguration, type LocalResource, type FileResource, type ResourceGrant } from '@kivro/resource-broker';
import type { WorkerState } from './state.ts';
import type { SecretStore } from './secrets.ts';
import type { ResourceSnapshot } from './resources.ts';

export function approvedResources(state: WorkerState, permissions: PermissionManifest): LocalResource[] {
  return permissions.resources.map(grant => {
    const configured = state.get<LocalResource>(`brokerResource:${grant.id}`);
    if (configured) { hashResourceConfiguration(configured); return configured; }
    const snapshot = state.get<ResourceSnapshot>(`resource:${grant.id}`);
    if (!snapshot || grant.type !== 'LOCAL_FILE') throw new Error('RESOURCE_CONFIGURATION_REQUIRED');
    const resource: FileResource = {
      id: grant.id, type: 'LOCAL_FILE', dependencyId: `resource:${grant.id}`,
      selections: [{ id: grant.id, root: join(state.root, 'resources'), path: join(state.root, 'resources', grant.id), sha256: snapshot.sha256, sizeBytes: snapshot.sizeBytes, mimeType: snapshot.mimeType as FileResource['selections'][number]['mimeType'] }],
      operations: { read: {
        inputSchema: { type: 'object', additionalProperties: false, properties: { selectionId: { type: 'string', enum: [grant.id] } }, required: ['selectionId'] },
        outputSchema: { type: 'object', additionalProperties: false, properties: { selectionId: { type: 'string' }, content: { type: 'string' }, mimeType: { type: 'string' }, sha256: { type: 'string' } }, required: ['selectionId', 'content', 'mimeType', 'sha256'] },
        limits: { maxRows: 1, maxBytes: Math.min(8 * 1024 ** 2, permissions.limits.maxOutputBytes), timeoutMs: 5000 },
      } },
    };
    return resource;
  });
}

export function createResourceBroker(state: WorkerState, secrets: SecretStore, capability: { capabilityVersionId: string; permissions: PermissionManifest; dependencies: Dependency[] }): LocalResourceBroker {
  const resources = approvedResources(state, capability.permissions);
  const grants = state.get<ResourceGrant[]>(`resourceGrants:${capability.capabilityVersionId}`) ?? [];
  return new LocalResourceBroker({ resources,
    approval: { capabilityVersionId: capability.capabilityVersionId, permissions: capability.permissions, dependencies: capability.dependencies, grants },
    secretResolver: ref => secrets.get(ref), maxConcurrentOperations: 1, maxTrackedJobs: 1,
    budget: { maxBytes: Math.min(4 * 1024 ** 2, capability.permissions.limits.maxOutputBytes), maxDurationMs: Math.min(60_000, capability.permissions.limits.timeoutSeconds * 1000) },
    audit: event => state.audit(`RESOURCE_${event.outcome}`, 'BROKER', event.jobId),
  });
}
export function resourceGrantsForApproval(state: WorkerState, permissions: PermissionManifest): ResourceGrant[] {
  return approvedResources(state, permissions).map(resource => ({ resourceId: resource.id, operations: Object.keys(resource.operations), configurationHash: hashResourceConfiguration(resource) }));
}

export function approveBrokerResource(state: WorkerState, raw: unknown, approvedHash?: string): { approvalHash: string; approved: boolean } {
  // The broker's parser validates all keys, schemas and immutable configuration.
  const resource = raw as LocalResource;
  const approvalHash = hashResourceConfiguration(resource);
  if (resource.type !== 'DATABASE') throw new Error('USE_RESOURCE_APPROVE_FOR_FILE_SNAPSHOTS');
  if (approvedHash !== approvalHash) return { approvalHash, approved: false };
  const existing = state.get(`brokerResource:${resource.id}`);
  if (existing && hashManifest(existing) !== hashManifest(resource)) throw new Error('IMMUTABLE_RESOURCE_USE_NEW_ID');
  state.transaction(() => { state.set(`brokerResource:${resource.id}`, resource); state.audit('DATABASE_RESOURCE_CONSENT', 'LOCAL'); });
  return { approvalHash, approved: true };
}
