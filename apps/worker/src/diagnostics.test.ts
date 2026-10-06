import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as adapter from '@kivro/openclaw-adapter';
import { generateDeviceIdentity } from '@kivro/crypto';
import { hashManifest } from '@kivro/contracts';
import { verifyRequest } from '@kivro/job-protocol';
import { clockCheck, cloudPolicyCheck as evaluatePolicy, cloudReadiness, nodeRuntimeCheck, workerDatabaseCheck, configReadabilityCheck, deploymentStatus } from './diagnostics.ts';
import { readiness } from './readiness.ts';
import { WorkerState } from './state.ts';
import { SecretStore } from './secrets.ts';
import { validateInferenceConfig } from './inference.ts';
import { WorkerTransport } from './transport.ts';
import { main } from './index.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const version = 'OpenClaw 2026.8.2 (0965053)';
const cloudPolicyCheck = (minimumWorkerVersion: string, minimumOpenClawVersion: string, policyReason: string | null, openclawVersion: string, revokedWorkerVersions: string[] = [], revokedOpenClawVersions: string[] = []) => evaluatePolicy({ minimumWorkerVersion, minimumOpenClawVersion, policyReason, revokedWorkerVersions, revokedOpenClawVersions }, openclawVersion);
async function fixture(status = 200, changes: Record<string, unknown> = {}, clockOffset = 0, legacy = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-diagnostics-'))), state = new WorkerState(root), keys = generateDeviceIdentity(), workerId = randomUUID();
  const requests: string[] = [], errors: unknown[] = [];
  const server = createServer((req, res) => {
    try {
      requests.push(req.url!); expect(req.method).toBe('GET');
      if (req.url === '/api/worker/diagnostics/v2' || req.url === '/api/worker/diagnostics') {
        expect(verifyRequest(keys.publicKey, 'GET', req.url, Buffer.alloc(0), req.headers as Record<string, string>)).toBe(true);
        if (legacy && req.url.endsWith('/v2')) { res.writeHead(404).end(); return; }
        res.writeHead(status).end(JSON.stringify(status === 200 ? { serverTime: new Date(Date.now() + clockOffset).toISOString(), workerId, minimumWorkerVersion: '0.1.0', minimumOpenClawVersion: '2026.8.2', revokedWorkerVersions: [], revokedOpenClawVersions: [], policyReason: null, ...(!legacy ? { sellerId: randomUUID(), deploymentEnvironment: 'development' } : {}), ...changes } : { error: { code: 'WORKER_REVOKED', message: 'private diagnostic must not escape' } }));
      } else if (req.url === '/api/health') {
        expect(Object.keys(req.headers).filter(name => /worker|authorization|cookie/i.test(name))).toEqual([]);
        res.end(JSON.stringify({ serverTime: new Date(Date.now() + clockOffset).toISOString(), status: 'ok' }));
      } else res.writeHead(404).end();
    } catch (error) { errors.push(error); res.writeHead(500).end(); }
  });
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); state.close(); await rm(root, { recursive: true, force: true }); expect(errors).toEqual([]); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const address = server.address(); if (!address || typeof address === 'string') throw new Error('TEST_ADDRESS');
  const apiUrl = `http://127.0.0.1:${address.port}`; state.set('identity', { workerId, publicKey: keys.publicKey, serverPublicKey: keys.publicKey, apiUrl });
  const secrets = new SecretStore(state); vi.spyOn(secrets, 'get').mockResolvedValue(keys.privateKey); vi.spyOn(secrets, 'initialize').mockResolvedValue();
  return { state, secrets, requests, keys };
}
describe('read-only Worker doctor diagnostics', () => {
  it('returns a structured private-state initialization failure without exposing or repairing the file', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-doctor-init-'))), path = join(root, 'not-a-directory');
    cleanups.push(() => rm(root, { recursive: true, force: true })); await writeFile(path, 'private-canary', { mode: 0o600 });
    vi.stubEnv('KIVRO_WORKER_HOME', path); const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true), exit = process.exitCode;
    try {
      await main(['doctor']); expect(process.exitCode).toBe(1);
      const report = JSON.parse(String(output.mock.calls[0]?.[0]));
      expect(report).toMatchObject({ ready: false, checks: [{ code: 'WORKER_DATABASE_UNAVAILABLE' }] });
      expect(JSON.stringify(report)).not.toMatch(/private-canary|not-a-directory/); expect(await readFile(path, 'utf8')).toBe('private-canary');
    } finally { process.exitCode = exit; }
  });
  it.each(['22.13.0', '22.99.0', '24.0.0'])('accepts Node %s with SQLite', version => { expect(nodeRuntimeCheck(version, true).status).toBe('PASS'); });
  it.each(['20.20.0', '22.12.9', '22.13.0-rc.1', 'garbage', '9999999999.0.0'])('rejects unsupported or malformed Node %s', version => { expect(nodeRuntimeCheck(version, true).code).toBe('NODE_RUNTIME_UNSUPPORTED'); });
  it('requires SQLite even with a supported Node version', () => { expect(nodeRuntimeCheck('24.0.0', false).status).toBe('FAIL'); });
  it('reports private configuration readability as a distinct fail-closed check', () => {
    expect(configReadabilityCheck(true)).toMatchObject({ id: 'openclawConfig', status: 'PASS' });
    expect(configReadabilityCheck(false)).toMatchObject({ id: 'openclawConfig', status: 'FAIL', code: 'OPENCLAW_CONFIG_UNREADABLE_OR_UNSAFE' });
  });
  it('probes actual SQLite writes transactionally and reports query-only failure without changing state', async () => {
    const { state, secrets } = await fixture(); state.set('preserved', 'original');
    expect(workerDatabaseCheck(state).status).toBe('PASS'); expect(state.db.prepare("SELECT key FROM settings WHERE key LIKE 'doctorProbe:%'").all()).toEqual([]);
    state.db.exec('PRAGMA query_only=ON');
    const check = workerDatabaseCheck(state); expect(check).toMatchObject({ id: 'workerDatabase', status: 'FAIL', code: 'WORKER_DATABASE_NOT_WRITABLE' });
    const docker = new adapter.DockerSandbox(), available = vi.spyOn(docker, 'available');
    expect(await readiness(state, secrets, docker, 'fixture')).toMatchObject({ ready: false, sandboxReady: false, checks: expect.arrayContaining([check]) });
    expect(available).not.toHaveBeenCalled(); expect(state.get('preserved')).toBe('original'); state.db.exec('PRAGMA query_only=OFF');
  });
  it('bounds signed clock skew including uncertainty, rejects long RTT and wall-clock jumps', () => {
    const now = Date.now();
    expect(clockCheck(new Date(now + 100).toISOString(), now, now + 200, 200).code).toBe('CLOCK_SYNCHRONIZED');
    for (const skew of [-31000, 31000]) expect(clockCheck(new Date(now + skew).toISOString(), now, now, 0).code).toBe('CLOCK_SKEW_EXCEEDED');
    expect(clockCheck(new Date(now + 30000).toISOString(), now, now + 500, 1000).status).toBe('FAIL');
    expect(clockCheck(new Date(now).toISOString(), now, now + 10001, 10001).code).toBe('CLOCK_UNVERIFIED');
    expect(clockCheck(new Date(now).toISOString(), now, now + 2000, 1).code).toBe('CLOCK_UNVERIFIED');
    expect(clockCheck('bad', now, now, 0).code).toBe('CLOCK_UNVERIFIED');
  });
  it('keeps remote minimum/revocation checks additional to the local exact OpenClaw pin', () => {
    expect(cloudPolicyCheck('0.1.0', '2026.8.2', null, version).status).toBe('PASS');
    expect(cloudPolicyCheck('0.2.0', '2026.8.2', null, version).code).toBe('WORKER_UPDATE_REQUIRED');
    expect(cloudPolicyCheck('0.1.0', '2026.8.3', null, version).code).toBe('OPENCLAW_UPDATE_REQUIRED');
    expect(cloudPolicyCheck('0.1.0', '2026.8.2', null, version, [], ['2026.8.2']).code).toBe('OPENCLAW_VERSION_REVOKED');
    expect(cloudPolicyCheck('0.1.0', '2026.8.2', null, version, ['0.1.0']).code).toBe('WORKER_VERSION_REVOKED');
    expect(cloudPolicyCheck('0.1.0', '2026.8.2', 'OPENCLAW_VERSION_REVOKED', version, [], ['2026.8.1']).status).toBe('PASS');
    expect(cloudPolicyCheck('0.1.0', '2026.8.2', 'OPENCLAW_UPDATE_REQUIRED', version).status).toBe('PASS');
    expect(cloudPolicyCheck('0.1.0', '2026.8.2', 'WORKER_UPDATE_REQUIRED', version).status).toBe('PASS');
    expect(cloudPolicyCheck('0.1.0', '2026.8.2', 'NEW_POLICY_BLOCK', version).code).toBe('SERVER_EXECUTION_POLICY_BLOCKED');
    expect(cloudPolicyCheck('0.1.0-beta', '2026.8.2', null, version).code).toBe('SERVER_VERSION_POLICY_UNSUPPORTED');
  });
  it('uses real signed read-only diagnostics without heartbeat, pairing or public fallback on success', async () => {
    const { state, secrets, requests } = await fixture();
    expect((await cloudReadiness(state, secrets, version, true)).map(check => check.status)).toEqual(['PASS', 'PASS', 'PASS']);
    expect(requests).toEqual(['/api/worker/diagnostics/v2']); expect(state.paused()).toBe(true);
  });
  it('accepts optional typed V2 security warnings without changing readiness or legacy parsing', async () => {
    const securityWarnings = { schemaVersion: 1, observedAt: new Date().toISOString(), items: [], capabilityVersionsChecked: 0, truncated: false, coverage: { capabilityScope: 'BOUND_VERSIONS_ONLY', localSignals: 'UNAVAILABLE', ignoredSignalCount: 0, deviceRevocationSchedule: 'UNAVAILABLE' } };
    const { state, secrets, keys, requests } = await fixture(200, { securityWarnings }), identity = state.get<import('./transport.ts').DeviceIdentity>('identity')!;
    expect((await new WorkerTransport(identity.apiUrl, identity, keys.privateKey, true).diagnostics()).securityWarnings).toEqual(securityWarnings);
    expect((await cloudReadiness(state, secrets, version, true)).map(check => check.status)).toEqual(['PASS', 'PASS', 'PASS']);
    expect(requests).toEqual(['/api/worker/diagnostics/v2', '/api/worker/diagnostics/v2']);
    const legacy = await fixture(200, { securityWarnings }, 0, true);
    expect((await cloudReadiness(legacy.state, legacy.secrets, version, true))[0]?.status).toBe('FAIL');
  });
  it.each([{ schemaVersion: 2 }, { schemaVersion: 1, privateDetail: 'private warning data' }, null])('rejects malformed V2 security warnings without fallback or data disclosure: %j', async securityWarnings => {
    const { state, secrets, requests } = await fixture(200, { securityWarnings }), checks = await cloudReadiness(state, secrets, version, true);
    expect(checks[0]?.status).toBe('FAIL'); expect(JSON.stringify(checks)).not.toContain('private warning data'); expect(requests).toEqual(['/api/worker/diagnostics/v2']);
  });
  it.each([401, 403])('keeps rejected identity %s blocked even when public clock is healthy', async status => {
    const { state, secrets, requests } = await fixture(status);
    const checks = await cloudReadiness(state, secrets, version, true);
    expect(checks).toMatchObject([{ status: 'FAIL', code: 'CLOUD_DEVICE_AUTH_REJECTED' }, { status: 'WARN', code: 'PUBLIC_CLOCK_HINT_ONLY' }]);
    expect(requests).toEqual(['/api/worker/diagnostics/v2', '/api/health']); expect(JSON.stringify(checks)).not.toContain('private diagnostic');
  });
  it('explains signature failure caused by excessive clock skew without changing local time or credentials', async () => {
    const { state, secrets } = await fixture(401, {}, 120000), before = state.get('identity');
    const checks = await cloudReadiness(state, secrets, version, true); expect(checks[1]?.code).toBe('CLOCK_SKEW_EXCEEDED'); expect(state.get('identity')).toEqual(before);
  });
  it.each([{ workerId: randomUUID() }, { serverTime: 'private invalid content' }, { sellerId: undefined }, { deploymentEnvironment: undefined }, { deploymentEnvironment: 'private invalid content' }, { policyReason: 'private invalid content' }, { revokedWorkerVersions: undefined }, { revokedOpenClawVersions: undefined }, { revokedWorkerVersions: Array(101).fill('0.1.0') }, { unexpectedField: 'private invalid content' }])('refuses mismatched/malformed authenticated diagnostics %j', async changes => {
    const { state, secrets, requests } = await fixture(200, changes), checks = await cloudReadiness(state, secrets, version, true);
    expect(checks[0]?.status).toBe('FAIL'); expect(JSON.stringify(checks)).not.toContain('private invalid content'); expect(requests).toHaveLength(1);
  });
  it('redacts network/TLS errors and refuses HTTP production endpoints before egress', async () => {
    const { state, secrets, requests } = await fixture();
    expect((await cloudReadiness(state, secrets, version, false))[0]?.code).toBe('CLOUD_DIAGNOSTICS_UNAVAILABLE'); expect(requests).toHaveLength(0);
    vi.spyOn(WorkerTransport.prototype, 'diagnostics').mockRejectedValue(new Error('secret network diagnostic'));
    expect(JSON.stringify(await cloudReadiness(state, secrets, version, true))).not.toContain('secret');
  });
  it.each([['WORKER_VERSION_REVOKED', false], ['OPENCLAW_UPDATE_REQUIRED', true], ['WORKER_UPDATE_REQUIRED', true]])('checks local versions before first heartbeat but fails closed for %s', async (policyReason, ready) => {
    const { state, secrets, requests } = await fixture(200, { policyReason, revokedWorkerVersions: ready ? [] : ['0.1.0'] });
    vi.spyOn(adapter, 'scanRuntime').mockResolvedValue({ version, compatible: true, configReadable: true, dependencies: [], warnings: [] });
    const docker = new adapter.DockerSandbox(), imageId = `sha256:${'1'.repeat(64)}`;
    vi.spyOn(docker, 'available').mockResolvedValue(); vi.spyOn(docker, 'imageId').mockResolvedValue(imageId);
    state.set('approvedImageId', imageId); state.set('sandboxProof', { imageId, policyVersion: 1, testedAt: Date.now() });
    state.set('sandboxTimingProof', { imageId, version: adapter.TIMING_POLICY_VERSION, testedAt: Date.now() });
    const config = validateInferenceConfig({ provider: 'anthropic', model: 'claude-sonnet-4-6', baseUrl: 'https://api.anthropic.com/v1', credentialRef: 'dedicated', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 });
    state.set('inference', config); state.set('inferenceProof', { hash: hashManifest(config), testedAt: Date.now() });
    const report = await readiness(state, secrets, docker, 'fixture', false, true);
    expect(report.ready).toBe(ready); expect(report.sandboxReady).toBe(true); expect(report.checks.find(check => check.id === 'cloudPolicy')?.code).toBe(ready ? 'SERVER_EXECUTION_POLICY_SATISFIED' : policyReason); expect(state.get('health')).toEqual(report); expect(requests).toEqual(['/api/worker/diagnostics/v2']);
  });
  it.each(['production', 'staging', 'preview', 'development', 'test', 'unknown'])('displays the authenticated %s environment despite conflicting local environment', async deploymentEnvironment => {
    const { state, secrets } = await fixture(200, { deploymentEnvironment }); vi.stubEnv('KIVRO_ENV', 'production');
    await cloudReadiness(state, secrets, version, true);
    expect(deploymentStatus(state)).toMatchObject({ deploymentEnvironment, apiOrigin: state.get<{ apiUrl: string }>('identity')!.apiUrl, verifiedAt: expect.any(String) });
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true); vi.stubEnv('KIVRO_WORKER_HOME', state.root); await main(['health']);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({ cloud: { deploymentEnvironment } });
  });
  it('falls back only on v2 HTTP 404, with unknown legacy environment and no seller authority', async () => {
    const { state, secrets, requests, keys } = await fixture(200, {}, 0, true), identity = state.get<import('./transport.ts').DeviceIdentity>('identity')!;
    const report = await new WorkerTransport(identity.apiUrl, identity, keys.privateKey, true).diagnostics();
    expect(report.deploymentEnvironment).toBe('unknown'); expect(report.sellerId).toBeUndefined(); expect(requests).toEqual(['/api/worker/diagnostics/v2', '/api/worker/diagnostics']);
    await cloudReadiness(state, secrets, version, true); expect(deploymentStatus(state).deploymentEnvironment).toBe('unknown');
  });
  it.each([500, 503])('never falls back from v2 HTTP %s to a weaker diagnostic', async status => {
    const { state, secrets, requests } = await fixture(status); expect((await cloudReadiness(state, secrets, version, true))[0]?.status).toBe('FAIL');
    expect(requests).toEqual(['/api/worker/diagnostics/v2']); expect(deploymentStatus(state).deploymentEnvironment).toBe('unknown');
  });
  it('does not reuse an environment label for another worker or API origin', async () => {
    const { state, secrets } = await fixture(200, { deploymentEnvironment: 'staging' }); await cloudReadiness(state, secrets, version, true);
    state.set('identity', { ...state.get<object>('identity'), workerId: randomUUID() }); expect(deploymentStatus(state).deploymentEnvironment).toBe('unknown');
    state.set('identity', { ...state.get<object>('identity'), apiUrl: 'https://user:secret@example.com/private?token=secret' });
    expect(deploymentStatus(state)).toEqual({ apiOrigin: 'https://example.com', deploymentEnvironment: 'unknown', verifiedAt: null });
  });
});
