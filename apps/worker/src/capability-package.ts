import { z } from 'zod';
import { DependencySchema, PriceTierSchema, executionManifestHash, getPriceTier, hashManifest, stableStringify, type Dependency } from '@kivro/contracts';
import { PublicationEvidenceSchema } from '@kivro/contracts/publication-evidence';
import { sha256 } from '@kivro/crypto';
import { ADAPTER_POLICY_VERSION, TIMING_POLICY_VERSION, RESEARCH_DOWNLOAD_POLICY_VERSION, SUPPORTED_OPENCLAW, SUPPORTED_COMMIT, assertWorkerPermissions, assertWorkerFileContract, buildOpenClawConfig } from '@kivro/openclaw-adapter';
import { assertPublishable } from '@kivro/policy-engine';
import { hashResourceConfiguration, type ResourceGrant } from '@kivro/resource-broker';
import { LocalCapabilitySchema } from './capabilities.ts';
import { ConnectorConfigSchema, selectedConnectors } from './connectors.ts';
import { InferenceConfigSchema, validateInferenceConfig } from './inference.ts';
import { ImportTargetSchema, type ImportedSkill } from './imports.ts';
import { approvedResources } from './resource-config.ts';
import type { WorkerState } from './state.ts';

export const CAPABILITY_PACKAGE_MAX_BYTES = 4 * 1024 ** 2;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const skill = z.object({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/), content: z.string().min(1).max(256 * 1024), sha256: digest }).strict();
const operation = z.object({
  inputSchema: z.record(z.unknown()), outputSchema: z.record(z.unknown()),
  limits: z.object({ maxRows: z.number().int().min(1).max(1000), maxBytes: z.number().int().min(32).max(8 * 1024 ** 2), timeoutMs: z.number().int().min(1).max(60_000) }).strict(),
}).strict();
const resourceContract = z.object({
  id: ref, type: z.enum(['LOCAL_FILE', 'DATABASE']), dependencyId: z.string().min(1).max(128),
  sourceConfigurationHash: digest, credentialRef: ref.optional(), operations: z.record(ref, operation),
}).strict();
const connectorContract = ConnectorConfigSchema.omit({ endpoint: true }).extend({ sourceConfigurationHash: digest }).strict();
const policies = { adapter: ADAPTER_POLICY_VERSION, timing: TIMING_POLICY_VERSION, researchDownload: RESEARCH_DOWNLOAD_POLICY_VERSION };
const contentSchema = z.object({
  definition: LocalCapabilitySchema.extend({ dependencies: z.array(DependencySchema.omit({ source: true, details: true }).extend({ approved: z.literal(false), healthy: z.literal(false) }).strict()).max(100) }).strict(),
  pricing: z.object({ basis: z.literal('SOURCE_TIER_SNAPSHOT_NOT_IMPORT_AUTHORITY'), tier: PriceTierSchema }).strict(),
  inference: InferenceConfigSchema,
  skills: z.array(skill).max(10), resourceContracts: z.array(resourceContract).max(50), connectorContracts: z.array(connectorContract).max(50),
  source: z.object({ manifestHash: digest, consentHash: digest, skillsHash: digest, dependencyBundleHash: digest, approvedAt: z.string().datetime(),
    normalization: z.literal('LOCAL_GRANTS_AND_DISCOVERY_METADATA_REMOVED') }).strict(),
  publicationEvidence: PublicationEvidenceSchema.nullable(),
  runtime: z.object({
    openclawVersion: z.literal(SUPPORTED_OPENCLAW), openclawCommit: z.literal(SUPPORTED_COMMIT), approvedImageId: imageId,
    generatedConfig: z.object({ schemaVersion: z.literal(1), hash: digest, basis: z.literal('BASE_CAPABILITY_CONFIG_NOT_JOB_SPECIFIC') }).strict(),
    policy: z.object({ adapter: z.literal(ADAPTER_POLICY_VERSION), timing: z.literal(TIMING_POLICY_VERSION), researchDownload: z.literal(RESEARCH_DOWNLOAD_POLICY_VERSION), hash: digest, basis: z.literal('VERSIONED_POLICY_DESCRIPTOR') }).strict(),
  }).strict(),
  tests: z.object({
    basis: z.literal('LOCAL_RECORDED_PROOFS_NOT_PORTABLE_AUTHORITY'),
    sandbox: z.object({ imageId, policyVersion: z.number().int().positive(), testedAt: timestamp }).strict().nullable(),
    inference: z.object({ hash: digest, testedAt: timestamp }).strict().nullable(),
    capability: z.object({ manifestHash: digest, imageId, inferenceHash: digest, testedAt: timestamp, outputHash: digest }).strict().nullable(),
  }).strict(),
  hashes: z.object({ definition: digest, permissions: digest, dependencyBundle: digest }).strict(),
}).strict();
const envelopeSchema = z.object({ kind: z.literal('KIVRO_CAPABILITY_PACKAGE'), schemaVersion: z.literal(1), content: contentSchema, contentHash: digest }).strict();
export type CapabilityPackage = z.infer<typeof envelopeSchema>;
type Content = CapabilityPackage['content'];
type PackageErrorCode = 'CAPABILITY_PACKAGE_INVALID' | 'CAPABILITY_PACKAGE_TOO_LARGE' | 'CAPABILITY_PACKAGE_SENSITIVE_CONTENT' | 'CAPABILITY_PACKAGE_INTEGRITY_FAILED' | 'CAPABILITY_PACKAGE_SOURCE_CHANGED' | 'CAPABILITY_PACKAGE_EXPORT_REVIEW_REQUIRED' | 'CAPABILITY_PACKAGE_NEW_VERSION_REQUIRED';
export class CapabilityPackageError extends Error {
  constructor(readonly code: PackageErrorCode) { super(code); this.name = 'CapabilityPackageError'; }
}
function reject(code: PackageErrorCode = 'CAPABILITY_PACKAGE_INVALID'): never { throw new CapabilityPackageError(code); }

// This is a backstop, not a claim that arbitrary prose can be classified secret-free.
// Export also requires explicit review of the entire exact payload; no secret store is read.
function inspectText(value: string): void {
  if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,})\b|\bBearer\s+[A-Za-z0-9._~+/-]{8,}|\b(?:api[_-]?key|password|access[_-]?token|client[_-]?secret)\s*["']?\s*[:=]\s*["']?[^\s"',;]{4,}/i.test(value) ||
    /(?:https?|postgres(?:ql)?):\/\/[^\s/]*@|\/(?:Users|home|private|tmp|var|etc|Volumes|root|Library)\/|[A-Z]:\\|~\/|(?:^|[\s"'(])(?:file:\/\/|\.ssh\/|\.aws\/|\.openclaw\/)/i.test(value)) reject('CAPABILITY_PACKAGE_SENSITIVE_CONTENT');
}

function boundedJson(raw: unknown, inspectSensitive: boolean): unknown {
  let nodes = 0, bytes = 0;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 50_000 || depth > 32) reject();
    if (typeof value === 'string') { bytes += Buffer.byteLength(value); if (inspectSensitive) inspectText(value); }
    else if (typeof value === 'number') { if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) reject(); bytes += 8; }
    else if (value !== null && typeof value === 'object') {
      if (seen.has(value) || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) reject();
      seen.add(value);
      if (Object.getOwnPropertySymbols(value).length) reject();
      for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (Array.isArray(value) && key === 'length') continue;
        if (!('value' in property) || !property.enumerable || ['__proto__', 'constructor', 'prototype'].includes(key)) reject();
        if (Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/.test(key)) reject();
        bytes += Buffer.byteLength(key);
        if (inspectSensitive) {
          inspectText(key);
          if (/^(?:apiKey|api_key|password|privateKey|private_key|accessToken|access_token|clientSecret|client_secret|authorization|authProfiles|auth-profiles|env|environment|secrets)$/i.test(key)) reject('CAPABILITY_PACKAGE_SENSITIVE_CONTENT');
        }
        visit(property.value, depth + 1);
      }
      if (Array.isArray(value) && Object.keys(value).length !== value.length) reject();
      seen.delete(value);
    } else if (value !== null && typeof value !== 'boolean') reject();
    if (bytes > CAPABILITY_PACKAGE_MAX_BYTES) reject('CAPABILITY_PACKAGE_TOO_LARGE');
  };
  visit(raw, 0);
  const json = JSON.stringify(raw);
  if (Buffer.byteLength(json) > CAPABILITY_PACKAGE_MAX_BYTES) reject('CAPABILITY_PACKAGE_TOO_LARGE');
  return JSON.parse(json);
}
function bundleHash(content: Pick<Content, 'definition' | 'skills' | 'resourceContracts' | 'connectorContracts' | 'inference'>): string {
  return hashManifest({ dependencies: content.definition.dependencies, skills: content.skills, resources: content.resourceContracts, connectors: content.connectorContracts, inference: content.inference });
}
function unique(values: string[]): void { if (new Set(values).size !== values.length) reject(); }
function targets(content: Content) {
  const candidates = [
    { kind: 'INFERENCE', ref: 'configured' },
    ...content.definition.permissions.tools.map(ref => ({ kind: 'TOOL', ref })),
    ...content.definition.permissions.resources.map(({ id }) => ({ kind: 'RESOURCE', ref: id })),
    ...content.definition.permissions.network.allowedDomains.map(ref => ({ kind: 'NETWORK', ref })),
    ...content.connectorContracts.map(({ id }) => ({ kind: 'CONNECTOR', ref: id })),
    ...[...new Set([content.inference.credentialRef, ...content.definition.dependencies.flatMap(node => node.grants?.credentialRefs ?? [])])].map(ref => ({ kind: 'CREDENTIAL', ref })),
  ];
  return z.array(ImportTargetSchema).max(90).parse(candidates);
}
function checkContent(pkg: CapabilityPackage): void {
  const c = pkg.content, d = c.definition, permissions = d.permissions;
  if (hashManifest(c) !== pkg.contentHash || executionManifestHash(d) !== c.hashes.definition || hashManifest(permissions) !== c.hashes.permissions || bundleHash(c) !== c.hashes.dependencyBundle ||
    hashManifest(policies) !== c.runtime.policy.hash || hashManifest(buildOpenClawConfig(permissions)) !== c.runtime.generatedConfig.hash) reject('CAPABILITY_PACKAGE_INTEGRITY_FAILED');
  assertWorkerPermissions(permissions); assertWorkerFileContract(d.ioContract); validateInferenceConfig(c.inference);
  if (permissions.inference.provider !== c.inference.provider || permissions.inference.model !== c.inference.model || permissions.inference.credentialRef !== c.inference.credentialRef) reject();
  const graph = new Map(d.dependencies.map(node => [node.id, node]));
  unique(d.dependencies.map(node => node.id)); unique(d.selectedSkills); unique(c.skills.map(item => item.name));
  const visited = new Set<string>(), visiting = new Set<string>();
  const walk = (id: string): void => {
    if (visiting.has(id)) reject(); if (visited.has(id)) return;
    const node = graph.get(id); if (!node) reject();
    visiting.add(id); for (const child of node.dependsOn ?? []) walk(child); visiting.delete(id); visited.add(id);
  };
  for (const node of d.dependencies) {
    walk(node.id);
    if (node.type === 'CREDENTIAL' && node.contentHash !== undefined) reject();
    if (node.grants?.tools?.some(tool => !permissions.tools.includes(tool)) || node.grants?.resources?.some(id => !permissions.resources.some(resource => resource.id === id)) ||
      node.grants?.domains?.some(domain => !permissions.network.allowedDomains.includes(domain)) || node.grants?.inferenceProviders?.some(provider => provider !== permissions.inference.provider)) reject();
  }
  if (c.skills.length !== d.selectedSkills.length || c.skills.length !== d.dependencies.filter(node => node.type === 'SKILL').length) reject();
  for (const item of c.skills) if (sha256(item.content) !== item.sha256 || !d.selectedSkills.includes(item.name) ||
    !d.dependencies.some(node => node.type === 'SKILL' && node.name === item.name && node.contentHash === item.sha256)) reject('CAPABILITY_PACKAGE_INTEGRITY_FAILED');
  const credentials = new Set(d.dependencies.filter(node => node.type === 'CREDENTIAL').flatMap(node => node.grants?.credentialRefs ?? []));
  if (!credentials.has(c.inference.credentialRef) || !d.dependencies.some(node => node.type === 'INFERENCE' && node.grants?.inferenceProviders?.includes(c.inference.provider))) reject();
  for (const tool of permissions.tools) if (!d.dependencies.some(node => node.grants?.tools?.includes(tool))) reject();
  for (const domain of permissions.network.allowedDomains) if (!d.dependencies.some(node => node.grants?.domains?.includes(domain))) reject();
  const reachesCredential = (nodeId: string, credentialRef: string): boolean => {
    const pending = [nodeId], seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!; if (seen.has(id)) continue; seen.add(id);
      const node = graph.get(id)!;
      if (node.type === 'CREDENTIAL' && node.grants?.credentialRefs?.includes(credentialRef)) return true;
      pending.push(...node.dependsOn ?? []);
    }
    return false;
  };
  if (!d.dependencies.some(node => node.type === 'INFERENCE' && reachesCredential(node.id, c.inference.credentialRef))) reject();
  unique(c.resourceContracts.map(item => item.id)); unique(c.connectorContracts.map(item => item.id));
  if (c.resourceContracts.length !== permissions.resources.length) reject();
  for (const resource of c.resourceContracts) {
    const node = graph.get(resource.dependencyId);
    if (!permissions.resources.some(grant => grant.id === resource.id && grant.type === resource.type) || node?.type !== resource.type || !node.grants?.resources?.includes(resource.id) ||
      !Object.keys(resource.operations).length || Object.keys(resource.operations).length > 50 ||
      (resource.type === 'DATABASE' ? !resource.credentialRef || !credentials.has(resource.credentialRef) || !reachesCredential(node.id, resource.credentialRef) : resource.credentialRef !== undefined)) reject();
  }
  if (c.connectorContracts.length !== d.dependencies.filter(node => node.type === 'CONNECTOR').length) reject();
  for (const connector of c.connectorContracts) if (!d.dependencies.some(node => node.type === 'CONNECTOR' && node.name === connector.id && node.contentHash === connector.sourceConfigurationHash) ||
    connector.credentialRef && !credentials.has(connector.credentialRef)) reject();
  const proof = c.tests;
  if (proof.sandbox && (proof.sandbox.imageId !== c.runtime.approvedImageId || proof.sandbox.policyVersion !== c.runtime.policy.adapter) ||
    proof.inference && proof.inference.hash !== hashManifest(c.inference) ||
    proof.capability && (proof.capability.manifestHash !== c.source.manifestHash || proof.capability.imageId !== c.runtime.approvedImageId || proof.capability.inferenceHash !== hashManifest(c.inference))) reject('CAPABILITY_PACKAGE_INTEGRITY_FAILED');
  if ([proof.sandbox, proof.inference, proof.capability].some(item => item && item.testedAt > Date.now())) reject();
  if (c.publicationEvidence) {
    const { evidenceHash, ...evidence } = c.publicationEvidence;
    const skills = d.dependencies.filter(node => node.type === 'SKILL').map(node => ({ id: node.id, name: node.name, contentHash: node.contentHash ?? null }));
    if (hashManifest(evidence) !== evidenceHash || evidence.capabilityVersionId !== d.capabilityVersionId || evidence.manifestHash !== c.source.manifestHash ||
      evidence.workerConfig.executionManifestHash !== c.source.manifestHash || evidence.workerConfig.inferenceConfigHash !== hashManifest(c.inference) ||
      evidence.dependencyBundleHash !== c.source.dependencyBundleHash || hashManifest(evidence.skills) !== hashManifest(skills) ||
      evidence.sandbox.imageId !== c.runtime.approvedImageId || evidence.sandbox.policyVersion !== c.runtime.policy.adapter ||
      ![SUPPORTED_OPENCLAW, `OpenClaw ${SUPPORTED_OPENCLAW} (${SUPPORTED_COMMIT})`].includes(evidence.openclawVersion)) reject('CAPABILITY_PACKAGE_INTEGRITY_FAILED');
  }
  targets(c);
}

export const CapabilityPackageSchema = z.unknown().transform((value, context) => {
  try {
    const pkg = envelopeSchema.parse(boundedJson(value, true)); checkContent(pkg); return pkg;
  } catch (error) {
    context.addIssue({ code: 'custom', message: error instanceof CapabilityPackageError ? error.code : 'CAPABILITY_PACKAGE_INVALID' });
    return z.NEVER;
  }
});

/** No extraction, network requests, secret lookups or Worker state writes. */
export function parseCapabilityPackage(raw: unknown): CapabilityPackage {
  try {
    let value = raw;
    if (typeof value === 'string' || value instanceof Uint8Array) {
      if (Buffer.byteLength(value) > CAPABILITY_PACKAGE_MAX_BYTES) reject('CAPABILITY_PACKAGE_TOO_LARGE');
      value = JSON.parse(typeof value === 'string' ? value : new TextDecoder('utf-8', { fatal: true }).decode(value));
    }
    const parsed = CapabilityPackageSchema.safeParse(value);
    if (!parsed.success) reject(parsed.error.issues[0]?.message as PackageErrorCode);
    return parsed.data;
  } catch (error) { if (error instanceof CapabilityPackageError) throw error; reject(); }
}

function portableDependency(node: Dependency): Content['definition']['dependencies'][number] {
  const { source: _source, details: _details, contentHash, ...rest } = node;
  return { ...rest, ...(contentHash && node.type !== 'CREDENTIAL' ? { contentHash } : {}), approved: false, healthy: false };
}

/** Reads only explicitly approved capability-scoped state, never personal discovery/config files. */
export function reviewCapabilityPackageExport(state: WorkerState, capabilityVersionId: string, priceTierId: string, options: { publicationEvidence?: unknown } = {}): { package: CapabilityPackage; approvalHash: string } {
  try {
    z.string().uuid().parse(capabilityVersionId);
    const stored = LocalCapabilitySchema.extend({ manifestHash: digest, consentHash: digest, approvedAt: z.string().datetime(), skillsHash: digest }).strict()
      .parse(boundedJson(state.get(`capability:${capabilityVersionId}`), false));
    const { manifestHash, consentHash, approvedAt, skillsHash, ...definition } = stored;
    if (definition.capabilityVersionId !== capabilityVersionId || executionManifestHash(definition) !== manifestHash || hashManifest(definition) !== consentHash) reject('CAPABILITY_PACKAGE_SOURCE_CHANGED');
    assertPublishable(definition.permissions, definition.dependencies);
    const consent = state.get<{ consentHash: string; manifestHash: string; skillsHash: string; imageId: string }>(`consent:${capabilityVersionId}`);
    const approvedImageId = imageId.parse(state.get('approvedImageId'));
    if (!consent || consent.consentHash !== consentHash || consent.manifestHash !== manifestHash || consent.skillsHash !== skillsHash || consent.imageId !== approvedImageId) reject('CAPABILITY_PACKAGE_SOURCE_CHANGED');
    const pinned = state.get<ImportedSkill[]>(`skills:${capabilityVersionId}`) ?? [];
    if (hashManifest(pinned) !== skillsHash) reject('CAPABILITY_PACKAGE_SOURCE_CHANGED');
    const skills = pinned.map(({ name, content, sha256 }) => ({ name, content, sha256 }));
    const grants = state.get<ResourceGrant[]>(`resourceGrants:${capabilityVersionId}`) ?? [];
    const resourceContracts = approvedResources(state, definition.permissions).map(resource => {
      const sourceConfigurationHash = hashResourceConfiguration(resource), grant = grants.find(item => item.resourceId === resource.id);
      if (!grant || grant.configurationHash !== sourceConfigurationHash || hashManifest([...grant.operations].sort()) !== hashManifest(Object.keys(resource.operations).sort())) reject('CAPABILITY_PACKAGE_SOURCE_CHANGED');
      return { id: resource.id, type: resource.type, dependencyId: resource.dependencyId, sourceConfigurationHash,
        ...(resource.type === 'DATABASE' ? { credentialRef: resource.credentialRef } : {}),
        operations: Object.fromEntries(Object.entries(resource.operations).map(([name, contract]) => [name, { inputSchema: contract.inputSchema, outputSchema: contract.outputSchema, limits: contract.limits }])) };
    });
    const connectorContracts = selectedConnectors(state, definition.permissions, definition.dependencies).map(config => {
      const { endpoint: _endpoint, ...contract } = config; return { ...contract, sourceConfigurationHash: hashManifest(config) };
    });
    const inference = validateInferenceConfig(state.get('inference'));
    const portable = { ...definition, dependencies: definition.dependencies.map(portableDependency) };
    const partial = { definition: portable, skills, resourceContracts, connectorContracts, inference };
    const content: Content = contentSchema.parse({ ...partial,
      pricing: { basis: 'SOURCE_TIER_SNAPSHOT_NOT_IMPORT_AUTHORITY', tier: getPriceTier(priceTierId) },
      source: { manifestHash, consentHash, approvedAt, skillsHash, dependencyBundleHash: hashManifest(definition.dependencies), normalization: 'LOCAL_GRANTS_AND_DISCOVERY_METADATA_REMOVED' },
      publicationEvidence: options.publicationEvidence ?? null,
      runtime: { openclawVersion: SUPPORTED_OPENCLAW, openclawCommit: SUPPORTED_COMMIT, approvedImageId,
        generatedConfig: { schemaVersion: 1, hash: hashManifest(buildOpenClawConfig(definition.permissions)), basis: 'BASE_CAPABILITY_CONFIG_NOT_JOB_SPECIFIC' },
        policy: { ...policies, hash: hashManifest(policies), basis: 'VERSIONED_POLICY_DESCRIPTOR' } },
      tests: { basis: 'LOCAL_RECORDED_PROOFS_NOT_PORTABLE_AUTHORITY', sandbox: state.get('sandboxProof') ?? null, inference: state.get('inferenceProof') ?? null, capability: state.get(`capabilityProof:${capabilityVersionId}`) ?? null },
      hashes: { definition: executionManifestHash(portable), permissions: hashManifest(definition.permissions), dependencyBundle: bundleHash(partial) },
    });
    const pkg = parseCapabilityPackage({ kind: 'KIVRO_CAPABILITY_PACKAGE', schemaVersion: 1, content, contentHash: hashManifest(content) });
    return { package: pkg, approvalHash: hashManifest(pkg) };
  } catch (error) { if (error instanceof CapabilityPackageError) throw error; reject(); }
}

export function exportCapabilityPackage(state: WorkerState, capabilityVersionId: string, priceTierId: string, approvalHash: string, options: { publicationEvidence?: unknown } = {}): string {
  const review = reviewCapabilityPackageExport(state, capabilityVersionId, priceTierId, options);
  if (review.approvalHash !== approvalHash) reject('CAPABILITY_PACKAGE_EXPORT_REVIEW_REQUIRED');
  return stableStringify(review.package);
}

/** Returned content is untrusted review material, not an installed capability or transferable consent. */
export function prepareCapabilityPackageImport(state: WorkerState, raw: unknown, newCapabilityVersionId: string) {
  const pkg = parseCapabilityPackage(raw);
  if (!z.string().uuid().safeParse(newCapabilityVersionId).success || newCapabilityVersionId === pkg.content.definition.capabilityVersionId || state.get(`capability:${newCapabilityVersionId}`) !== undefined) reject('CAPABILITY_PACKAGE_NEW_VERSION_REQUIRED');
  const definition = LocalCapabilitySchema.parse({ ...pkg.content.definition, capabilityVersionId: newCapabilityVersionId,
    dependencies: pkg.content.definition.dependencies.map(node => ({ ...node, approved: false, healthy: false, supported: false })) });
  return {
    status: 'REVIEW_REQUIRED' as const, provenanceAuthenticity: 'UNVERIFIED_SOURCE_CLAIMS' as const, sourcePackageHash: hashManifest(pkg), definition,
    requestedTargets: targets(pkg.content), skills: pkg.content.skills, resourceContracts: pkg.content.resourceContracts, connectorContracts: pkg.content.connectorContracts,
    inferenceProposal: pkg.content.inference, pricingProposal: pkg.content.pricing, provenance: { source: pkg.content.source, runtime: pkg.content.runtime, tests: pkg.content.tests, publicationEvidence: pkg.content.publicationEvidence },
    requiredActions: ['APPROVE_LOCAL_IMAGE', 'BIND_DEDICATED_CREDENTIALS', 'APPROVE_LOCAL_RESOURCES_AND_CONNECTORS', 'REVIEW_SKILL_IMPORT_GRANTS', 'APPROVE_NEW_CAPABILITY_VERSION', 'RERUN_LOCAL_TESTS', 'CONFIRM_CURRENT_PRICE_TIER'] as const,
    permissionsGranted: false as const, testsAccepted: false as const,
  };
}
