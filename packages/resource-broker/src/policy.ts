import { createHash } from 'node:crypto';
import { DependencySchema, PermissionManifestSchema, stableStringify, type Dependency, type PermissionManifest } from '@kivro/contracts';
import Ajv, { type ValidateFunction } from 'ajv';
import { z } from 'zod';
import { ResourceBrokerError, type LocalResource, type ResourceApproval } from './types.ts';

export const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,62}$/);
export const resourceId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/);
export const operationId = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/);
const schema = z.record(z.unknown());
const limits = z.object({ maxRows: z.number().int().min(1).max(1000), maxBytes: z.number().int().min(32).max(8 * 1024 ** 2), timeoutMs: z.number().int().min(1).max(60_000) }).strict();
const operationContract = z.object({ inputSchema: schema, outputSchema: schema, limits }).strict();
const table = z.object({ schema: identifier, name: identifier, columns: z.array(identifier).min(1).max(100) }).strict();
const query = operationContract.extend({
  table: table.omit({ columns: true }), columns: z.array(identifier).min(1).max(100),
  filters: z.array(z.object({ column: identifier, operator: z.enum(['eq', 'lt', 'lte', 'gt', 'gte', 'like', 'ilike']), parameter: identifier }).strict()).max(30),
  orderBy: z.array(z.object({ column: identifier, direction: z.enum(['ASC', 'DESC']) }).strict()).max(10).optional(),
}).strict();
const base = { id: resourceId, dependencyId: z.string().min(1).max(128) };
export const ResourceSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('DATABASE'), credentialRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
    connection: z.object({ host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535), database: identifier, user: identifier,
      ssl: z.union([z.literal(false), z.object({ ca: z.string().max(65536).optional(), rejectUnauthorized: z.literal(true) }).strict()]) }).strict(),
    allowedTables: z.array(table).min(1).max(30), operations: z.record(operationId, query),
  }).strict(),
  z.object({ ...base, type: z.literal('LOCAL_FILE'), selections: z.array(z.object({
    id: resourceId, root: z.string().min(1).max(4096), path: z.string().min(1).max(4096),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().min(0).max(8 * 1024 ** 2),
    mimeType: z.enum(['text/plain', 'text/markdown', 'text/csv', 'application/json']),
  }).strict()).min(1).max(100), operations: z.object({ read: operationContract }).strict() }).strict(),
]);
export const ApprovalSchema = z.object({
  capabilityVersionId: z.string().uuid(), permissions: PermissionManifestSchema,
  dependencies: z.array(DependencySchema).max(100), grants: z.array(z.object({
    resourceId, operations: z.array(operationId).min(1).max(50), configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(50),
}).strict();
export const RequestSchema = z.object({ jobId: z.string().uuid(), resourceId, operation: operationId, input: z.unknown(),
  permissions: PermissionManifestSchema, dependencies: z.array(DependencySchema).max(100) }).strict();

export function hashResourceConfiguration(resource: LocalResource): string {
  return createHash('sha256').update(stableStringify(ResourceSchema.parse(resource))).digest('hex');
}
export function snapshotHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Reject non-JSON input before pg can invoke object coercion/toPostgres hooks. */
export function boundedJson(value: unknown, maxBytes: number, code: 'INVALID_INPUT' | 'INVALID_OUTPUT'): { value: unknown; json: string; bytes: number } {
  let nodes = 0, roughBytes = 0;
  const inspect = (item: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 32) throw new ResourceBrokerError(code);
    if (typeof item === 'string') roughBytes += Buffer.byteLength(item);
    else if (typeof item === 'number') {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) throw new ResourceBrokerError(code);
      roughBytes += 8;
    }
    else if (item !== null && typeof item === 'object') {
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new ResourceBrokerError(code);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if (Array.isArray(item) && key === 'length') continue;
        if (!('value' in descriptor) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new ResourceBrokerError(code);
        roughBytes += Buffer.byteLength(key); inspect(descriptor.value, depth + 1);
      }
    } else if (item !== null && typeof item !== 'boolean') throw new ResourceBrokerError(code);
    if (roughBytes > maxBytes) throw new ResourceBrokerError(code === 'INVALID_OUTPUT' ? 'RESOURCE_LIMIT_EXCEEDED' : code);
  };
  inspect(value, 0);
  const json = JSON.stringify(value), bytes = Buffer.byteLength(json);
  if (bytes > maxBytes) throw new ResourceBrokerError(code === 'INVALID_OUTPUT' ? 'RESOURCE_LIMIT_EXCEEDED' : code);
  return { value: JSON.parse(json), json, bytes };
}

export function assertClosure(resource: LocalResource, permissions: PermissionManifest, dependencies: Dependency[]): void {
  const grants = permissions.resources.filter(grant => grant.id === resource.id);
  if (grants.length !== 1 || grants[0]!.type !== resource.type || grants[0]!.access !== 'READ_ONLY') throw new ResourceBrokerError('RESOURCE_DENIED');
  const graph = new Map(dependencies.map(dependency => [dependency.id, dependency]));
  if (graph.size !== dependencies.length) throw new ResourceBrokerError('RESOURCE_DENIED');
  const root = graph.get(resource.dependencyId);
  if (!root || root.type !== resource.type || !root.grants?.resources?.includes(resource.id)) throw new ResourceBrokerError('RESOURCE_DENIED');
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new ResourceBrokerError('RESOURCE_DENIED');
    if (visited.has(id)) return;
    const node = graph.get(id);
    if (!node || !node.approved || !node.healthy || node.supported === false) throw new ResourceBrokerError('RESOURCE_DENIED');
    visiting.add(id); for (const child of node.dependsOn ?? []) visit(child); visiting.delete(id); visited.add(id);
  };
  visit(resource.dependencyId);
  if (resource.type === 'DATABASE' && ![...visited].some(id => {
    const node = graph.get(id)!;
    return node.type === 'CREDENTIAL' && node.grants?.credentialRefs?.includes(resource.credentialRef);
  })) throw new ResourceBrokerError('RESOURCE_DENIED');
  for (const node of dependencies) if (node.required) visit(node.id);
}

export interface CompiledOperation { input: ValidateFunction; output: ValidateFunction }
export function compileResources(resources: LocalResource[], approval: ResourceApproval): Map<string, Map<string, CompiledOperation>> {
  const ajv = new Ajv({ strict: true, allErrors: false, validateFormats: true, ownProperties: true });
  const compiled = new Map<string, Map<string, CompiledOperation>>();
  if (new Set(approval.grants.map(grant => grant.resourceId)).size !== approval.grants.length) throw new ResourceBrokerError('RESOURCE_CONFIGURATION_INVALID');
  for (const resource of resources) {
    if (compiled.has(resource.id)) throw new ResourceBrokerError('RESOURCE_CONFIGURATION_INVALID');
    const grant = approval.grants.find(item => item.resourceId === resource.id);
    if (!grant || grant.configurationHash !== hashResourceConfiguration(resource)) throw new ResourceBrokerError('RESOURCE_CONFIGURATION_INVALID');
    assertClosure(resource, approval.permissions, approval.dependencies);
    const operations = new Map<string, CompiledOperation>();
    for (const [name, operation] of Object.entries(resource.operations)) {
      if (operation.inputSchema.type !== 'object' || operation.inputSchema.additionalProperties !== false ||
        operation.inputSchema.$async || operation.outputSchema.$async) throw new ResourceBrokerError('RESOURCE_CONFIGURATION_INVALID');
      if (resource.type === 'DATABASE') {
        const query = resource.operations[name]!;
        const allowed = resource.allowedTables.find(table => table.schema === query.table.schema && table.name === query.table.name);
        if (!allowed || /^(pg_|information_schema$)/i.test(allowed.schema) ||
          new Set(query.columns).size !== query.columns.length ||
          [...query.columns, ...query.filters.map(filter => filter.column), ...(query.orderBy ?? []).map(order => order.column)].some(column => !allowed.columns.includes(column))) {
          throw new ResourceBrokerError('RESOURCE_CONFIGURATION_INVALID');
        }
      }
      operations.set(name, { input: ajv.compile(operation.inputSchema), output: ajv.compile(operation.outputSchema) });
    }
    if (!operations.size || operations.size > 50 || grant.operations.some(name => !operations.has(name)) ||
      (resource.type === 'LOCAL_FILE' && new Set(resource.selections.map(file => file.id)).size !== resource.selections.length)) throw new ResourceBrokerError('RESOURCE_CONFIGURATION_INVALID');
    compiled.set(resource.id, operations);
  }
  if (approval.grants.some(grant => !compiled.has(grant.resourceId))) throw new ResourceBrokerError('RESOURCE_CONFIGURATION_INVALID');
  return compiled;
}
