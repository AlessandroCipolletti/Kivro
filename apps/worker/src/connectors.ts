import { z } from 'zod';
import { hashManifest, type Dependency, type PermissionManifest } from '@kivro/contracts';
import { type ConnectorDefinition } from '@kivro/research-broker';
import type { WorkerState } from './state.ts';
import type { SecretStore } from './secrets.ts';

const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const field = z.object({ type: z.enum(['string', 'number', 'boolean']), required: z.boolean(), maxLength: z.number().int().min(1).max(10000).optional() }).strict();
export const ConnectorConfigSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/), endpoint: z.string().url(),
  // Omitted legacy methods must stay omitted in the immutable approval hash.
  method: z.enum(['GET', 'POST']).optional(),
  parameters: z.record(key, field), response: z.record(key, field), array: z.boolean().default(false),
  credentialRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/).optional(), maxResponseBytes: z.number().int().min(1).max(500000).default(100000),
}).strict();
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;
function fieldsSchema(fields: ConnectorConfig['parameters']) {
  const shape: Record<string, z.ZodTypeAny> = {};
  if (Object.keys(fields).length > 30) throw new Error('CONNECTOR_FIELD_LIMIT');
  for (const [name, field] of Object.entries(fields)) {
    if (['constructor', 'prototype', '__proto__'].includes(name)) throw new Error('CONNECTOR_UNSAFE_FIELD');
    const schema = field.type === 'string' ? z.string().max(field.maxLength ?? 1000) : field.type === 'number' ? z.number().finite() : z.boolean();
    shape[name] = field.required ? schema : schema.optional();
  }
  return z.object(shape).strict();
}
export function approveConnector(state: WorkerState, raw: unknown, approval?: string) {
  const config = ConnectorConfigSchema.parse(raw), url = new URL(config.endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) throw new Error('CONNECTOR_ENDPOINT_INVALID');
  fieldsSchema(config.parameters); fieldsSchema(config.response);
  const approvalHash = hashManifest(config);
  if (approval !== approvalHash) return { config, approvalHash, approved: false };
  return state.transaction(() => {
    const existing = state.get(`connector:${config.id}`);
    if (existing && hashManifest(existing) !== approvalHash) throw new Error('IMMUTABLE_CONNECTOR_USE_NEW_ID');
    state.set(`connector:${config.id}`, config); state.audit('READ_ONLY_CONNECTOR_CONSENT', 'LOCAL');
    return { approvalHash, approved: true };
  });
}
export function selectedConnectors(state: WorkerState, permissions: PermissionManifest, dependencies: Dependency[]): ConnectorConfig[] {
  return dependencies.filter(dep => dep.type === 'CONNECTOR' && dep.approved).map(dep => {
    const config = ConnectorConfigSchema.parse(state.get(`connector:${dep.name}`));
    if (dep.contentHash !== hashManifest(config) || !dep.supported || !dep.healthy || !dep.grants?.tools?.includes('connector.call') || !permissions.network.allowedDomains.includes(new URL(config.endpoint).hostname)) throw new Error('CONNECTOR_CONSENT_MISMATCH');
    if (config.credentialRef && !dependencies.some(item => dep.dependsOn?.includes(item.id) && item.type === 'CREDENTIAL' && item.approved && item.healthy && item.supported && item.grants?.credentialRefs?.includes(config.credentialRef!))) throw new Error('CONNECTOR_CREDENTIAL_CONSENT_REQUIRED');
    return config;
  });
}
export function connectorDefinition(config: ConnectorConfig, secrets: SecretStore): ConnectorDefinition {
  const output = fieldsSchema(config.response), input = fieldsSchema(config.parameters), method = config.method ?? 'GET';
  return { id: config.id, endpoint: config.endpoint, method, sideEffect: 'READ_ONLY', allowedDataClasses: ['PUBLIC'],
    requestSchema: method === 'POST' ? input.refine(value => Buffer.byteLength(JSON.stringify(value)) <= 256000, 'CONNECTOR_BODY_LIMIT') : input,
    responseSchema: config.array ? z.array(output).max(1000) : output, maxResponseBytes: config.maxResponseBytes,
    headers: config.credentialRef ? async () => ({ authorization: `Bearer ${await secrets.get(config.credentialRef!)}` }) : undefined,
  };
}
