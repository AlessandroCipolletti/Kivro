import { randomUUID } from 'node:crypto';
import type { Dependency, PermissionManifest } from '@kivro/contracts';
import { hashResourceConfiguration, type LocalResource, type LocalResourceBrokerConfig, type PostgresResource, type ResourceRequest } from '../src/index.ts';

export const objectInput = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
export const rowSchema = { type: 'array', items: objectInput({ id: { type: 'string' }, name: { type: 'string' } }) };
export const fileOutput = objectInput({ selectionId: { type: 'string' }, content: { type: 'string' }, mimeType: { type: 'string' }, sha256: { type: 'string' } });
export function database(): PostgresResource {
  return {
    id: 'companies', type: 'DATABASE', dependencyId: 'company-database', credentialRef: 'company-db-password',
    connection: { host: '127.0.0.1', port: 55432, database: 'kivro_resource_fixture', user: 'kivro_resource_reader', ssl: false },
    allowedTables: [{ schema: 'resource_fixture', name: 'table_a', columns: ['id', 'name'] }],
    operations: {
      get: { table: { schema: 'resource_fixture', name: 'table_a' }, columns: ['id', 'name'], filters: [{ column: 'id', operator: 'eq', parameter: 'id' }],
        inputSchema: objectInput({ id: { type: 'string', maxLength: 100 } }), outputSchema: rowSchema, limits: { maxRows: 5, maxBytes: 4096, timeoutMs: 2000 } },
      list: { table: { schema: 'resource_fixture', name: 'table_a' }, columns: ['id', 'name'], filters: [], orderBy: [{ column: 'id', direction: 'ASC' }],
        inputSchema: objectInput({}), outputSchema: rowSchema, limits: { maxRows: 5, maxBytes: 16384, timeoutMs: 2000 } },
    },
  };
}
export function configuration(resource: LocalResource): LocalResourceBrokerConfig {
  const permissions: PermissionManifest = { schemaVersion: 1, tools: [], network: { mode: 'NONE', allowedDomains: [] },
    resources: [{ id: resource.id, type: resource.type, access: 'READ_ONLY' }], inference: { provider: 'fixture', model: 'fixture' },
    limits: { timeoutSeconds: 5, memoryMb: 128, cpu: 1, maxPids: 16, maxInputBytes: 65536, maxOutputBytes: 1_000_000, maxTokens: 100 } };
  const dependencies: Dependency[] = [{ id: resource.dependencyId, name: 'Approved private resource', type: resource.type,
    required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { resources: [resource.id] },
    dependsOn: resource.type === 'DATABASE' ? ['company-credential'] : [] }];
  if (resource.type === 'DATABASE') dependencies.push({ id: 'company-credential', name: 'Dedicated credential', type: 'CREDENTIAL',
    required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants: { credentialRefs: [resource.credentialRef] } });
  return { resources: [resource], approval: { capabilityVersionId: randomUUID(), permissions, dependencies,
    grants: [{ resourceId: resource.id, operations: Object.keys(resource.operations), configurationHash: hashResourceConfiguration(resource) }] },
  secretResolver: async () => 'kivro_resource_local_only' };
}
export function request(config: LocalResourceBrokerConfig, input: unknown = { id: 'a1' }, operation = 'get', jobId = randomUUID()): ResourceRequest {
  return { jobId, resourceId: config.resources[0]!.id, operation, input,
    permissions: structuredClone(config.approval.permissions), dependencies: structuredClone(config.approval.dependencies) };
}
