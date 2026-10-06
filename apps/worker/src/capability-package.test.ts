import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionManifestHash, hashManifest, type Dependency } from '@kivro/contracts';
import { sha256 } from '@kivro/crypto';
import { ADAPTER_POLICY_VERSION, SUPPORTED_OPENCLAW, buildOpenClawConfig } from '@kivro/openclaw-adapter';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { approveCapability, LocalCapabilitySchema } from './capabilities.ts';
import { approveConnector } from './connectors.ts';
import { validateInferenceConfig } from './inference.ts';
import { approveBrokerResource } from './resource-config.ts';
import { approveResource } from './resources.ts';
import { WorkerState } from './state.ts';
import { CAPABILITY_PACKAGE_MAX_BYTES, CapabilityPackageSchema, exportCapabilityPackage, parseCapabilityPackage, prepareCapabilityPackageImport, reviewCapabilityPackageExport, type CapabilityPackage } from './capability-package.ts';

const opened: { root: string; state: WorkerState }[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const item of opened.splice(0)) { item.state.close(); await rm(item.root, { recursive: true, force: true }); } });
async function worker() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-cap-package-'))), state = new WorkerState(join(root, 'worker'));
  opened.push({ root, state }); return { root, state };
}
function databaseSnapshot(state: WorkerState) {
  return ['settings', 'audit', 'attempts', 'outbox', 'commands'].map(table => state.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}
async function fixture() {
  const { state, root } = await worker(), offer = fixtureOffer();
  const source = join(root, 'selected.txt'), privateContent = 'private-resource-content-not-a-bundle-asset';
  await writeFile(source, privateContent);
  const selection = { id: 'document', path: source, sha256: sha256(privateContent), maxBytes: 1000 };
  await approveResource(state, selection, hashManifest(selection));
  const database = { id: 'reports', type: 'DATABASE' as const, dependencyId: 'resource:reports', credentialRef: 'reports-password',
    connection: { host: 'private-database.internal', port: 5432, database: 'private_db', user: 'private_user', ssl: false as const },
    allowedTables: [{ schema: 'private_schema', name: 'private_table', columns: ['name'] }],
    operations: { list: { table: { schema: 'private_schema', name: 'private_table' }, columns: ['name'], filters: [],
      inputSchema: { type: 'object', additionalProperties: false, properties: {} }, outputSchema: { type: 'array', items: { type: 'object' } },
      limits: { maxRows: 10, maxBytes: 4096, timeoutMs: 1000 } } } };
  const dbReview = approveBrokerResource(state, database); approveBrokerResource(state, database, dbReview.approvalHash);
  const connector = { id: 'lookup', endpoint: 'https://example.com/private_connector', parameters: { term: { type: 'string', required: true } }, response: { answer: { type: 'string', required: true } } };
  const connectorReview = approveConnector(state, connector); approveConnector(state, connector, connectorReview.approvalHash);
  const config = validateInferenceConfig({ provider: 'openai-compatible', model: 'test-model', credentialRef: 'seller-inference', baseUrl: 'https://example.com/v1', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 });
  const permissions = { ...offer.permissions, tools: ['resource.read', 'connector.call'], network: { mode: 'CONNECTORS' as const, allowedDomains: ['example.com'] },
    resources: [{ id: 'document', type: 'LOCAL_FILE' as const, access: 'READ_ONLY' as const }, { id: 'reports', type: 'DATABASE' as const, access: 'READ_ONLY' as const }] };
  const content = 'Use the selected read-only resources and the approved lookup connector.', selected = { name: 'report', content, sha256: sha256(content), sourceHash: sha256('selected source'), localMetadata: '/Users/fixture/private-skill-location' };
  const node = (id: string, type: string, grants: Dependency['grants'], dependsOn: string[] = []): Dependency => ({ id, name: id, type, required: true, approved: true, healthy: true, supported: true, confidence: 'DECLARED', grants, dependsOn });
  const dependencies: Dependency[] = [...offer.dependencies,
    node('tool:resource.read', 'TOOL', { tools: ['resource.read'] }), node('tool:connector.call', 'TOOL', { tools: ['connector.call'] }),
    node('resource:document', 'LOCAL_FILE', { resources: ['document'] }), node('credential:reports', 'CREDENTIAL', { credentialRefs: ['reports-password'] }),
    node('resource:reports', 'DATABASE', { resources: ['reports'] }, ['credential:reports']),
    { ...node('connector:lookup', 'CONNECTOR', { tools: ['connector.call'] }), name: 'lookup', contentHash: connectorReview.approvalHash },
    node('network:example.com', 'NETWORK_DESTINATION', { domains: ['example.com'] }),
    { ...node('skill:report', 'SKILL', {}, ['inference', 'resource:document', 'resource:reports', 'connector:lookup']), name: 'report', contentHash: selected.sha256,
      source: '/Users/fixture/personal/SKILL.md', details: 'private-discovery-metadata' },
  ];
  dependencies.find(item => item.type === 'CREDENTIAL')!.contentHash = sha256('local-secret-revision');
  const raw = LocalCapabilitySchema.parse({ capabilityVersionId: offer.capabilityVersionId, ioContract: offer.ioContract, permissions, dependencies, internalInstructions: 'Use the report skill to return a short report.', selectedSkills: ['report'] });
  state.set('approvedImageId', `sha256:${'2'.repeat(64)}`); state.set('inference', config); state.set('importedSkills', [selected]);
  state.set('secret:unrelated', { encrypted: 'not-exported-secret-state' }); state.set('personalConfig', { apiKey: 'not-exported-personal-config' });
  state.set('identity', { workerId: randomUUID(), apiUrl: 'https://private-api.example.com', privateMetadata: 'not-exported-identity' });
  const capability = approveCapability(state, raw, hashManifest(raw)), id = capability.capabilityVersionId;
  // Synthetic recorded proofs exercise packaging only; no Docker, database resource or provider claim.
  state.set('sandboxProof', { imageId: state.get('approvedImageId'), policyVersion: ADAPTER_POLICY_VERSION, testedAt: Date.now() - 1000 });
  state.set('inferenceProof', { hash: hashManifest(config), testedAt: Date.now() - 1000 });
  state.set(`capabilityProof:${id}`, { manifestHash: capability.manifestHash, imageId: state.get('approvedImageId'), inferenceHash: hashManifest(config), testedAt: Date.now() - 500, outputHash: hashManifest({ privateOutput: 'not-exported-test-output' }) });
  return { state, root, capability, id, config, selected };
}
function rehash(pkg: CapabilityPackage) {
  const c = pkg.content;
  c.hashes.definition = executionManifestHash(c.definition); c.hashes.permissions = hashManifest(c.definition.permissions);
  c.hashes.dependencyBundle = hashManifest({ dependencies: c.definition.dependencies, skills: c.skills, resources: c.resourceContracts, connectors: c.connectorContracts, inference: c.inference });
  c.runtime.generatedConfig.hash = hashManifest(buildOpenClawConfig(c.definition.permissions));
  pkg.contentHash = hashManifest(c); return pkg;
}
async function packageFixture() { const context = await fixture(); return { ...context, pkg: reviewCapabilityPackageExport(context.state, context.id, 'USD_99').package }; }

describe('portable dependency-aware capability package', () => {
  it('exports the selected immutable definition and contracts without private paths, resource data, credentials or personal state', async () => {
    const { state, id, capability, selected } = await fixture(), before = databaseSnapshot(state), reads = vi.spyOn(state, 'get');
    const review = reviewCapabilityPackageExport(state, id, 'USD_99'), json = exportCapabilityPackage(state, id, 'USD_99', review.approvalHash), pkg = parseCapabilityPackage(json);
    expect(CapabilityPackageSchema.safeParse(pkg).success).toBe(true);
    expect(pkg.content.definition.ioContract).toEqual(capability.ioContract); expect(pkg.content.definition.permissions).toEqual(capability.permissions);
    expect(pkg.content.definition.internalInstructions).toBe(capability.internalInstructions); expect(pkg.content.pricing.tier.id).toBe('USD_99');
    expect(pkg.content.skills).toEqual([{ name: selected.name, content: selected.content, sha256: selected.sha256 }]);
    expect(pkg.content.source.manifestHash).toBe(capability.manifestHash); expect(pkg.content.hashes.definition).not.toBe(capability.manifestHash);
    expect(pkg.content.definition.dependencies.every(item => item.approved === false && item.healthy === false)).toBe(true);
    expect(pkg.content.definition.dependencies.filter(item => item.type === 'CREDENTIAL').every(item => !item.contentHash)).toBe(true);
    expect(pkg.content.resourceContracts.find(item => item.type === 'DATABASE')).toMatchObject({ credentialRef: 'reports-password', operations: { list: { limits: { maxRows: 10 } } } });
    expect(pkg.content.inference.credentialRef).toBe('seller-inference'); expect(pkg.content.connectorContracts[0]).not.toHaveProperty('endpoint');
    for (const forbidden of ['/Users/', state.root, 'private-resource-content', 'private-database.internal', 'private_db', 'private_user', 'private_schema', 'private_table', 'private_connector', 'private-discovery-metadata', 'localMetadata', 'not-exported', 'local-secret-revision']) expect(json).not.toContain(forbidden);
    expect(reads.mock.calls.map(([key]) => key).some(key => /secret:|personal|identity|importedSkills/.test(key))).toBe(false);
    expect(databaseSnapshot(state)).toEqual(before);
    expect(exportCapabilityPackage(state, id, 'USD_99', review.approvalHash)).toBe(json);
  });
  it('requires explicit exact-payload export review and detects changed pricing/provenance after review', async () => {
    const { state, id } = await fixture(), review = reviewCapabilityPackageExport(state, id, 'USD_99');
    expect(() => exportCapabilityPackage(state, id, 'USD_99', '0'.repeat(64))).toThrow('CAPABILITY_PACKAGE_EXPORT_REVIEW_REQUIRED');
    expect(() => exportCapabilityPackage(state, id, 'USD_499', review.approvalHash)).toThrow('CAPABILITY_PACKAGE_EXPORT_REVIEW_REQUIRED');
    state.delete(`capabilityProof:${id}`);
    expect(() => exportCapabilityPackage(state, id, 'USD_99', review.approvalHash)).toThrow('CAPABILITY_PACKAGE_EXPORT_REVIEW_REQUIRED');
  });
  it('imports an inert new draft; repeated previews cannot install skills, transfer proofs or approve permissions', async () => {
    const { pkg } = await packageFixture(), { state } = await worker(), before = databaseSnapshot(state), id = randomUUID();
    const preview = prepareCapabilityPackageImport(state, Buffer.from(JSON.stringify(pkg)), id);
    expect(preview).toMatchObject({ status: 'REVIEW_REQUIRED', permissionsGranted: false, testsAccepted: false, provenanceAuthenticity: 'UNVERIFIED_SOURCE_CLAIMS' });
    expect(preview.definition.capabilityVersionId).toBe(id);
    expect(preview.definition.dependencies.every(item => !item.approved && !item.healthy && !item.supported)).toBe(true);
    expect(preview.requestedTargets).toContainEqual({ kind: 'RESOURCE', ref: 'reports' }); expect(preview.requestedTargets).toContainEqual({ kind: 'CREDENTIAL', ref: 'reports-password' });
    expect(preview.requestedTargets).toContainEqual({ kind: 'CONNECTOR', ref: 'lookup' });
    expect(prepareCapabilityPackageImport(state, pkg, id)).toEqual(preview);
    expect(() => approveCapability(state, preview.definition, hashManifest(preview.definition))).toThrow();
    expect(databaseSnapshot(state)).toEqual(before);
    expect(state.get('importedSkills')).toBeUndefined(); expect(state.get(`capabilityProof:${id}`)).toBeUndefined();
  });
  it('requires a fresh local version and preserves existing versions', async () => {
    const { pkg, state, id } = await packageFixture(), before = databaseSnapshot(state), other = randomUUID();
    expect(() => prepareCapabilityPackageImport(state, pkg, id)).toThrow('CAPABILITY_PACKAGE_NEW_VERSION_REQUIRED');
    expect(() => prepareCapabilityPackageImport(state, pkg, 'not-a-uuid')).toThrow('CAPABILITY_PACKAGE_NEW_VERSION_REQUIRED');
    state.set(`capability:${other}`, { sentinel: true });
    expect(() => prepareCapabilityPackageImport(state, pkg, other)).toThrow('CAPABILITY_PACKAGE_NEW_VERSION_REQUIRED');
    state.delete(`capability:${other}`); expect(databaseSnapshot(state)).toEqual(before);
  });
  it('keeps historical or absent test receipts explicit, never converting them to destination readiness', async () => {
    const { state, id } = await fixture(); state.set('sandboxProof', { imageId: state.get('approvedImageId'), policyVersion: ADAPTER_POLICY_VERSION, testedAt: 1 });
    state.delete('inferenceProof'); state.delete(`capabilityProof:${id}`);
    const pkg = reviewCapabilityPackageExport(state, id, 'USD_99').package;
    expect(pkg.content.tests).toMatchObject({ basis: 'LOCAL_RECORDED_PROOFS_NOT_PORTABLE_AUTHORITY', sandbox: { testedAt: 1 }, inference: null, capability: null });
    expect(prepareCapabilityPackageImport(state, pkg, randomUUID()).requiredActions).toContain('RERUN_LOCAL_TESTS');
  });
  it('supports a minimal no-skill/no-resource capability without manufacturing grants or test evidence', async () => {
    const { state } = await worker(), offer = fixtureOffer(), raw = LocalCapabilitySchema.parse({ capabilityVersionId: offer.capabilityVersionId,
      ioContract: offer.ioContract, permissions: offer.permissions, dependencies: offer.dependencies, internalInstructions: offer.internalInstructions });
    state.set('approvedImageId', `sha256:${'2'.repeat(64)}`);
    state.set('inference', validateInferenceConfig({ provider: 'openai-compatible', model: 'test-model', credentialRef: 'seller-inference', baseUrl: 'http://127.0.0.1:8080/v1', allowLocal: true, inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 }));
    approveCapability(state, raw, hashManifest(raw));
    const pkg = reviewCapabilityPackageExport(state, raw.capabilityVersionId, 'USD_99').package;
    expect(pkg.content.skills).toEqual([]); expect(pkg.content.resourceContracts).toEqual([]); expect(pkg.content.connectorContracts).toEqual([]);
    expect(pkg.content.tests).toMatchObject({ sandbox: null, inference: null, capability: null }); expect(pkg.content.publicationEvidence).toBeNull();
    expect(prepareCapabilityPackageImport(state, pkg, randomUUID()).inferenceProposal.allowLocal).toBe(true);
  });
  it('replays import review after a Worker restart without persisting trust or changing the package', async () => {
    const { pkg } = await packageFixture(), target = await worker(), id = randomUUID(), before = databaseSnapshot(target.state);
    const first = prepareCapabilityPackageImport(target.state, pkg, id), root = target.state.root;
    target.state.close(); target.state = new WorkerState(root); opened.find(item => item.root === target.root)!.state = target.state;
    expect(prepareCapabilityPackageImport(target.state, pkg, id)).toEqual(first); expect(databaseSnapshot(target.state)).toEqual(before);
    expect(pkg.content.definition.capabilityVersionId).not.toBe(id);
  });
  it('rejects embedded sensitive source instructions during export, not merely on import', async () => {
    const { state, id, capability } = await fixture();
    const { manifestHash: _manifest, consentHash: _consent, approvedAt, skillsHash, ...definition } = capability;
    definition.internalInstructions = 'password=do-not-export-this';
    const changed = { ...definition, manifestHash: executionManifestHash(definition), consentHash: hashManifest(definition), approvedAt, skillsHash };
    state.set(`capability:${id}`, changed); state.set(`consent:${id}`, { ...state.get<object>(`consent:${id}`), manifestHash: changed.manifestHash, consentHash: changed.consentHash });
    state.delete(`capabilityProof:${id}`);
    expect(() => reviewCapabilityPackageExport(state, id, 'USD_99')).toThrow('CAPABILITY_PACKAGE_SENSITIVE_CONTENT');
  });
  it.each(['manifest', 'consent', 'skill', 'image', 'resource'] as const)('rejects changed source %s with bounded error and no state changes', async what => {
    const { state, id, capability } = await fixture();
    if (what === 'manifest') state.set(`capability:${id}`, { ...capability, internalInstructions: 'changed' });
    if (what === 'consent') state.set(`consent:${id}`, { consentHash: '0'.repeat(64) });
    if (what === 'skill') state.set(`skills:${id}`, []);
    if (what === 'image') state.set('approvedImageId', `sha256:${'3'.repeat(64)}`);
    if (what === 'resource') state.set(`resourceGrants:${id}`, []);
    const before = databaseSnapshot(state);
    expect(() => reviewCapabilityPackageExport(state, id, 'USD_99')).toThrow('CAPABILITY_PACKAGE_SOURCE_CHANGED');
    expect(databaseSnapshot(state)).toEqual(before);
  });
  it('includes explicit immutable publication evidence using the shared schema without treating its hash as a signature', async () => {
    const { state, id, capability, config } = await fixture();
    const evidence = { schemaVersion: 1, source: 'SIGNED_WORKER_VALIDATION', capabilityVersionId: id, manifestHash: capability.manifestHash, recordedAt: new Date().toISOString(),
      workerId: randomUUID(), workerVersion: '0.1.0', openclawVersion: SUPPORTED_OPENCLAW,
      workerConfig: { schemaVersion: 1, executionManifestHash: capability.manifestHash, inferenceConfigHash: hashManifest(config) },
      sandbox: state.get('sandboxProof'), inferenceTestedAt: Date.now() - 1000, dependencyBundleHash: hashManifest(capability.dependencies),
      skills: capability.dependencies.filter(node => node.type === 'SKILL').map(node => ({ id: node.id, name: node.name, contentHash: node.contentHash ?? null })) };
    const publicationEvidence = { ...evidence, evidenceHash: hashManifest(evidence) }, review = reviewCapabilityPackageExport(state, id, 'USD_99', { publicationEvidence });
    expect(review.package.content.publicationEvidence).toEqual(publicationEvidence);
    expect(() => exportCapabilityPackage(state, id, 'USD_99', review.approvalHash)).toThrow('CAPABILITY_PACKAGE_EXPORT_REVIEW_REQUIRED');
    const preview = prepareCapabilityPackageImport(state, exportCapabilityPackage(state, id, 'USD_99', review.approvalHash, { publicationEvidence }), randomUUID());
    expect(preview.provenance.publicationEvidence).toEqual(publicationEvidence); expect(preview.testsAccepted).toBe(false);
    expect(() => reviewCapabilityPackageExport(state, id, 'USD_99', { publicationEvidence: { ...publicationEvidence, manifestHash: '0'.repeat(64) } })).toThrow('CAPABILITY_PACKAGE_INTEGRITY_FAILED');
  });
});

describe('untrusted capability package validation', () => {
  it.each(['content', 'skill-hash', 'config-hash', 'policy-hash', 'source-proof'] as const)('rejects %s integrity failures, including attacker recomputed outer hashes', async what => {
    const { pkg } = await packageFixture();
    if (what === 'content') pkg.content.definition.internalInstructions = 'changed';
    if (what === 'skill-hash') { pkg.content.skills[0]!.content += 'changed'; rehash(pkg); }
    if (what === 'config-hash') { pkg.content.runtime.generatedConfig.hash = '0'.repeat(64); pkg.contentHash = hashManifest(pkg.content); }
    if (what === 'policy-hash') { pkg.content.runtime.policy.hash = '0'.repeat(64); pkg.contentHash = hashManifest(pkg.content); }
    if (what === 'source-proof') { pkg.content.tests.capability!.manifestHash = '0'.repeat(64); pkg.contentHash = hashManifest(pkg.content); }
    expect(() => parseCapabilityPackage(pkg)).toThrow('CAPABILITY_PACKAGE_INTEGRITY_FAILED');
  });
  it.each(['missing-child', 'cycle', 'duplicate', 'missing-skill', 'extra-skill', 'unscoped-grant', 'missing-resource', 'credential-closure', 'future-proof', 'transferred-approval'] as const)('rejects %s even with recomputed bundle hashes', async what => {
    const { pkg } = await packageFixture(), c = pkg.content;
    if (what === 'missing-child') c.definition.dependencies[0]!.dependsOn = ['missing'];
    if (what === 'cycle') c.definition.dependencies[0]!.dependsOn = [c.definition.dependencies[0]!.id];
    if (what === 'duplicate') c.definition.dependencies.push(c.definition.dependencies[0]!);
    if (what === 'missing-skill') c.skills = [];
    if (what === 'extra-skill') c.skills.push({ name: 'other', content: 'text', sha256: sha256('text') });
    if (what === 'unscoped-grant') c.definition.dependencies[0]!.grants!.tools = ['exec'];
    if (what === 'missing-resource') c.resourceContracts = [];
    if (what === 'credential-closure') c.definition.dependencies[0]!.dependsOn = [];
    if (what === 'future-proof') c.tests.sandbox!.testedAt = Date.now() + 1_000_000;
    if (what === 'transferred-approval') Object.assign(c.definition.dependencies[0]!, { approved: true });
    rehash(pkg); expect(() => parseCapabilityPackage(pkg)).toThrow('CAPABILITY_PACKAGE_INVALID');
  });
  it.each(['sk-proj-abcdefghijklmnopqrstuv12345', '-----BEGIN PRIVATE KEY-----', 'password=dedicated-value', 'Bearer abcdefghijklmnop', '/Users/alice/.ssh/id_rsa', '/private/tmp/private-data', '/etc/secret-config', 'C:\\private\\settings', 'postgres://user:password@db.example.com/name'])( 'rejects sensitive instruction text without echoing it (%s)', async sensitive => {
    const { pkg } = await packageFixture(); pkg.content.definition.internalInstructions = sensitive; rehash(pkg);
    expect(() => parseCapabilityPackage(pkg)).toThrow('CAPABILITY_PACKAGE_SENSITIVE_CONTENT');
    const result = CapabilityPackageSchema.safeParse(pkg); expect(result.success).toBe(false);
    if (!result.success) expect(JSON.stringify(result.error.issues)).not.toContain(sensitive);
  });
  it.each(['secret-field', 'personal-config', 'schema-default', 'endpoint-userinfo', 'endpoint-query', 'unsupported-runtime', 'path-entry'] as const)('rejects %s rather than silently stripping it', async what => {
    const { pkg } = await packageFixture();
    if (what === 'secret-field') Object.assign(pkg.content.inference, { apiKey: 'raw-value' });
    if (what === 'personal-config') Object.assign(pkg.content, { personalConfig: { harmless: true } });
    if (what === 'schema-default') pkg.content.definition.ioContract.inputs[0]!.default = { password: 'raw-value' };
    if (what === 'endpoint-userinfo') pkg.content.inference.baseUrl = 'https://user:password@example.com/v1';
    if (what === 'endpoint-query') pkg.content.inference.baseUrl = 'https://example.com/v1?token=value';
    if (what === 'unsupported-runtime') Object.assign(pkg.content.runtime, { openclawVersion: '2099.1.1' });
    if (what === 'path-entry') Object.assign(pkg.content.skills[0]!, { path: '../../outside/SKILL.md' });
    pkg.contentHash = hashManifest(pkg.content); expect(() => parseCapabilityPackage(pkg)).toThrow(/^CAPABILITY_PACKAGE_/);
  });
  it('bounds bytes, UTF-8, depth, nodes, cycles, getters, prototypes and sparse arrays before normal parsing', () => {
    expect(() => parseCapabilityPackage('x'.repeat(CAPABILITY_PACKAGE_MAX_BYTES + 1))).toThrow('CAPABILITY_PACKAGE_TOO_LARGE');
    expect(() => parseCapabilityPackage(Buffer.from([0xff]))).toThrow('CAPABILITY_PACKAGE_INVALID');
    expect(() => parseCapabilityPackage('secret-invalid-json')).toThrow('CAPABILITY_PACKAGE_INVALID');
    let deep: unknown = {}; for (let i = 0; i < 34; i++) deep = { next: deep };
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const getter = vi.fn(() => 'should-not-run'), withGetter = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
    for (const raw of [deep, cycle, withGetter, new Date(), Array(2), { number: Infinity }, { number: Number.MAX_SAFE_INTEGER + 1 }, JSON.parse('{"__proto__":{}}'), { list: Array(50_001).fill(null) }]) expect(() => parseCapabilityPackage(raw)).toThrow('CAPABILITY_PACKAGE_INVALID');
    expect(getter).not.toHaveBeenCalled();
  });
});
