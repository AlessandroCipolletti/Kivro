import type { Dependency, PermissionManifest } from '@kivro/contracts';

export type JsonSchema = Record<string, unknown>;
export interface OperationLimits { maxRows: number; maxBytes: number; timeoutMs: number }
export interface OperationContract {
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  limits: OperationLimits;
}
export interface NamedQuery extends OperationContract {
  /** All identifiers are fixed at approval time. There is deliberately no SQL field. */
  table: { schema: string; name: string };
  columns: string[];
  filters: { column: string; operator: 'eq' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'ilike'; parameter: string }[];
  orderBy?: { column: string; direction: 'ASC' | 'DESC' }[];
}
export interface PostgresResource {
  id: string;
  type: 'DATABASE';
  dependencyId: string;
  credentialRef: string;
  connection: { host: string; port: number; database: string; user: string; ssl: false | { ca?: string; rejectUnauthorized: true } };
  allowedTables: { schema: string; name: string; columns: string[] }[];
  operations: Record<string, NamedQuery>;
}
export interface FileSelection {
  id: string;
  /** Host-only, canonical paths to an immutable, owner-controlled snapshot. */
  root: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  mimeType: 'text/plain' | 'text/markdown' | 'text/csv' | 'application/json';
}
export interface FileResource {
  id: string;
  type: 'LOCAL_FILE';
  dependencyId: string;
  selections: FileSelection[];
  operations: { read: OperationContract };
}
export type LocalResource = PostgresResource | FileResource;
export interface ResourceGrant {
  resourceId: string;
  operations: string[];
  /** hashResourceConfiguration(resource), recorded during explicit seller approval. */
  configurationHash: string;
}
export interface ResourceApproval {
  capabilityVersionId: string;
  permissions: PermissionManifest;
  dependencies: Dependency[];
  grants: ResourceGrant[];
}
export interface JobResourceBudget {
  maxOperations: number;
  maxRows: number;
  maxBytes: number;
  maxInputBytes: number;
  maxDurationMs: number;
}
export interface LocalResourceBrokerConfig {
  resources: LocalResource[];
  /** Trusted, immutable local approval; never assemble it from a sandbox frame. */
  approval: ResourceApproval;
  secretResolver: (credentialRef: string, signal?: AbortSignal) => Promise<string>;
  budget?: Partial<JobResourceBudget>;
  maxConcurrentOperations?: number;
  maxTrackedJobs?: number;
  audit?: (event: ResourceAuditEvent) => void;
}
export interface ResourceRequest {
  jobId: string;
  resourceId: string;
  operation: string;
  input: unknown;
  permissions: PermissionManifest;
  dependencies: Dependency[];
}
export interface ResourceResult {
  data: unknown;
  metadata: {
    resourceId: string;
    operation: string;
    dataClasses: ['SELLER_PRIVATE'];
    untrusted: true;
    rows: number;
    bytes: number;
  };
}
export interface ResourceHealthResult {
  ready: true;
  capabilityVersionId: string;
  checkedAt: string;
  resources: { resourceId: string; operations: string[] }[];
}
export interface ResourceAuditEvent {
  jobId: string;
  resourceId: string;
  operation: string;
  outcome: 'ALLOWED' | 'DENIED' | 'FAILED';
  code: string;
  rows?: number;
  bytes?: number;
}
export type ResourceErrorCode = 'RESOURCE_DENIED' | 'INVALID_INPUT' | 'INVALID_OUTPUT' |
  'RESOURCE_CONFIGURATION_INVALID' | 'RESOURCE_CHANGED' | 'RESOURCE_UNAVAILABLE' |
  'RESOURCE_LIMIT_EXCEEDED' | 'RESOURCE_BUDGET_EXCEEDED' | 'RESOURCE_BUSY' |
  'RESOURCE_TIMEOUT' | 'RESOURCE_CANCELLED' | 'BROKER_CLOSED';
export class ResourceBrokerError extends Error {
  constructor(readonly code: ResourceErrorCode) { super(code); this.name = 'ResourceBrokerError'; }
}
