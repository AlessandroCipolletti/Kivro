import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type PermissionManifest } from '@kivro/contracts';
import { readFileLimits } from '@kivro/contracts/file-limits';
import { DockerSandbox, scanRuntime, buildOpenClawConfig, SELF_TEST_LIMITS, ADAPTER_POLICY_VERSION, TIMING_POLICY_VERSION, RESEARCH_DOWNLOAD_POLICY_VERSION } from '@kivro/openclaw-adapter';
import { inferenceReady } from './inference.ts';
import type { SecretStore } from './secrets.ts';
import type { WorkerState } from './state.ts';
import { cloudReadiness, nodeRuntimeCheck, workerDatabaseCheck, configReadabilityCheck, deploymentStatus } from './diagnostics.ts';
import { selectedResearchScanner } from './research-scanner.ts';

export const BUILD_COMMAND = 'docker build -t kivro-sandbox:2026.8.2 security/sandbox';
export type Check = { id: string; status: 'PASS' | 'FAIL' | 'WARN'; code: string; action?: string };
export type Readiness = { ready: boolean; sandboxReady: boolean; openclawVersion: string | null; checks: Check[]; imageId?: string; checkedAt: string; cloud?: ReturnType<typeof deploymentStatus>; dailyJobs?: ReturnType<WorkerState['dailyJobs']> };
function dailyAdmission(state: WorkerState): { check: Check; dailyJobs?: Readiness['dailyJobs'] } {
  try {
    const dailyJobs = state.dailyJobs();
    return { dailyJobs, check: { id: 'dailyJobs', status: dailyJobs.remainingJobs > 0 ? 'PASS' : 'FAIL', code: dailyJobs.remainingJobs > 0 ? 'DAILY_JOB_CAPACITY_AVAILABLE' : 'DAILY_JOB_LIMIT_REACHED', ...(dailyJobs.remainingJobs === 0 ? { action: 'New jobs resume on the next UTC day, or after an explicitly approved limit change. Active jobs continue.' } : {}) } };
  } catch (error) {
    const code = error instanceof Error && ['INVALID_WORKER_CLOCK', 'WORKER_CLOCK_ROLLBACK', 'INVALID_WORKER_JOB_LIMITS'].includes(error.message) ? error.message : 'DAILY_JOB_STATUS_UNAVAILABLE';
    return { check: { id: 'dailyJobs', status: 'FAIL', code, action: 'Check the system clock and approved Worker job limits.' } };
  }
}
/** Refresh cheap admission state between the full health polls without clearing any other blocker. */
export function refreshDailyAdmission(report: Readiness, state: WorkerState): Readiness {
  const admission = dailyAdmission(state), { dailyJobs: _previousUsage, ...previous } = report;
  const checks = [...report.checks.filter(check => check.id !== 'dailyJobs'), admission.check];
  const knownDailyBlock = report.checks.some(check => check.id === 'dailyJobs' && check.status === 'FAIL');
  return { ...previous, checks, ...(admission.dailyJobs ? { dailyJobs: admission.dailyJobs } : {}), ready: (report.ready || knownDailyBlock) && checks.every(check => check.status !== 'FAIL') };
}
export function workerStatus(report: Readiness, paused: boolean) {
  const code = (value: string) => /^[A-Z][A-Z0-9_]{1,100}$/.test(value) ? value : 'CHECK_FAILED';
  return { ready: report.ready, paused, sandboxReady: report.sandboxReady, cloud: report.cloud ?? { apiOrigin: null, deploymentEnvironment: 'unknown', verifiedAt: null }, inference: code(report.checks.find(check => check.id === 'inference')?.code ?? 'NOT_CHECKED'), blockers: report.checks.filter(check => check.status === 'FAIL').map(check => ({ check: check.id, code: code(check.code) })), ...(report.dailyJobs ? { dailyJobs: report.dailyJobs } : {}), next: !report.ready ? 'pnpm worker doctor' : paused ? 'pnpm worker resume --all' : null };
}
export function testPermissions(model = 'kivro-health-test', credentialRef = 'seller-inference', provider = 'openai-compatible'): PermissionManifest {
  return { schemaVersion: 1, tools: [], network: { mode: 'NONE', allowedDomains: [] }, resources: [], inference: { provider, model, credentialRef }, limits: SELF_TEST_LIMITS };
}
export async function sandboxSelfTest(state: WorkerState, docker: DockerSandbox, imageId: string): Promise<void> {
  const root = await mkdtemp(join(state.root, 'probe-'));
  try {
    const configDir = join(root, 'config'), inputDir = join(root, 'input');
    await mkdir(configDir, { mode: 0o755 }); await mkdir(inputDir, { mode: 0o755 });
    await writeFile(join(configDir, 'canary.txt'), 'kivro-read-only-canary', { mode: 0o444 });
    await writeFile(join(inputDir, 'canary.txt'), 'kivro-read-only-canary', { mode: 0o444 });
    await writeFile(join(configDir, 'openclaw.json'), JSON.stringify(buildOpenClawConfig(testPermissions())), { mode: 0o444 });
    await docker.probe(imageId, 'self-test', { configDir, inputDir });
    await docker.probe(imageId, 'ssh-test');
    const configured = await docker.probe(imageId, 'config-test', { configDir, inputDir });
    if (configured.timingPolicyVersion !== TIMING_POLICY_VERSION) throw new Error('SANDBOX_TIMING_UPDATE_REQUIRED');
    await docker.probe(imageId, 'media-test');
    state.set('sandboxProof', { imageId, policyVersion: ADAPTER_POLICY_VERSION, testedAt: Date.now() });
    state.set('sandboxTimingProof', { imageId, version: TIMING_POLICY_VERSION, testedAt: Date.now() });
    if (configured.researchDownloadPolicyVersion === RESEARCH_DOWNLOAD_POLICY_VERSION) state.set('sandboxDownloadProof', { imageId, version: RESEARCH_DOWNLOAD_POLICY_VERSION, testedAt: Date.now() });
    else state.delete('sandboxDownloadProof');
  } finally { await rm(root, { recursive: true, force: true }); }
}
export async function readiness(state: WorkerState, secrets: SecretStore, docker: DockerSandbox, image: string, full = false, development = false): Promise<Readiness> {
  const checks: Check[] = []; let openclawVersion: string | null = null, imageId: string | undefined, sandboxReady = false;
  checks.push({ id: 'platform', status: ['darwin', 'linux'].includes(process.platform) ? 'PASS' : 'FAIL', code: 'SUPPORTED_HOST_DARWIN_LINUX' });
  checks.push(nodeRuntimeCheck());
  const database = workerDatabaseCheck(state); checks.push(database);
  if (database.status === 'FAIL') return { ready: false, sandboxReady: false, openclawVersion, checks, cloud: deploymentStatus(state), checkedAt: new Date().toISOString() };
  const admission = dailyAdmission(state), dailyJobs = admission.dailyJobs;
  checks.push(admission.check);
  try { readFileLimits(process.env); checks.push({ id: 'fileLimits', status: 'PASS', code: 'FILE_LIMIT_CONFIGURATION_VALID' }); }
  catch { checks.push({ id: 'fileLimits', status: 'FAIL', code: 'FILE_LIMIT_CONFIGURATION_INVALID', action: 'Review the configured file limits and restart the Worker.' }); }
  try { const detected = await scanRuntime(undefined, undefined, { skills: false }); openclawVersion = detected.version; checks.push({ id: 'openclaw', status: detected.compatible ? 'PASS' : 'FAIL', code: detected.compatible ? 'OPENCLAW_SUPPORTED' : 'OPENCLAW_UNSUPPORTED', action: 'Install OpenClaw 2026.8.2 (0965053); discovery is read-only.' }); checks.push(configReadabilityCheck(detected.configReadable)); }
  catch { checks.push({ id: 'openclaw', status: 'FAIL', code: 'OPENCLAW_NOT_INSTALLED', action: 'Install the supported OpenClaw CLI and set OPENCLAW_BIN.' }); }
  try {
    await docker.available(); imageId = await docker.imageId(image);
    if (state.get('approvedImageId') !== imageId) throw new Error('IMAGE_APPROVAL_REQUIRED');
    if (full) await sandboxSelfTest(state, docker, imageId);
    const proof = state.get<{ imageId: string; policyVersion: number; testedAt: number }>('sandboxProof');
    const timing = state.get<{ imageId: string; version: number; testedAt: number }>('sandboxTimingProof');
    if (!timing || timing.imageId !== imageId || timing.version !== TIMING_POLICY_VERSION || Date.now() - timing.testedAt > 24 * 3600_000) throw new Error('SANDBOX_TIMING_UPDATE_REQUIRED');
    if (!proof || proof.imageId !== imageId || proof.policyVersion !== ADAPTER_POLICY_VERSION || Date.now() - proof.testedAt > 24 * 3600_000) throw new Error('SANDBOX_SELF_TEST_REQUIRED');
    sandboxReady = true; checks.push({ id: 'sandbox', status: 'PASS', code: 'ISOLATION_VERIFIED' });
  } catch (error) { checks.push({ id: 'sandbox', status: 'FAIL', code: error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'SANDBOX_CHECK_FAILED', action: `${BUILD_COMMAND}; pnpm worker sandbox approve-image; pnpm worker sandbox self-test` }); }
  try { await secrets.initialize(); checks.push({ id: 'secretStore', status: 'PASS', code: 'ENCRYPTED_SECRET_STORE_READY' }); }
  catch { checks.push({ id: 'secretStore', status: 'FAIL', code: 'SECRET_STORE_NOT_READY', action: 'Pair using macOS Keychain or supply a dedicated 32-byte KIVRO_WORKER_MASTER_KEY.' }); }
  const inference = await inferenceReady(state, secrets);
  checks.push({ id: 'inference', status: inference.ready ? 'PASS' : 'FAIL', code: inference.reason ?? 'DEDICATED_INFERENCE_VERIFIED', action: inference.ready ? undefined : 'Configure a dedicated credential, approve inference configuration, then run pnpm worker inference test.' });
  checks.push({ id: 'identity', status: state.get('identity') ? 'PASS' : 'FAIL', code: state.get('identity') ? 'DEVICE_PAIRED' : 'PAIRING_REQUIRED' });
  checks.push(...await cloudReadiness(state, secrets, openclawVersion, development));
  if (state.get('researchScanner') || (state.get<string[]>('capabilityIds') ?? []).some(id => state.get<{ permissions: PermissionManifest }>(`capability:${id}`)?.permissions.network.downloads)) {
    try { selectedResearchScanner(state); checks.push({ id: 'researchScanner', status: 'PASS', code: 'RESEARCH_SCANNER_VERIFIED' }); }
    catch (error) { checks.push({ id: 'researchScanner', status: 'WARN', code: error instanceof Error && /^RESEARCH_[A-Z_]+$/.test(error.message) ? error.message : 'RESEARCH_SCANNER_UNAVAILABLE', action: 'Download capabilities remain blocked. Configure dedicated loopback ClamAV with research scanner-configure, then research scanner-test.' }); }
  }
  if (state.get('securityBlock')) checks.push({ id: 'security', status: 'FAIL', code: 'PERSISTED_SECURITY_BLOCK', action: 'Resolve diagnostics, then run security clear --acknowledge after a successful full doctor.' });
  const report = { ready: checks.every(check => check.status !== 'FAIL'), sandboxReady, openclawVersion, checks, cloud: deploymentStatus(state), ...(imageId ? { imageId } : {}), ...(dailyJobs ? { dailyJobs } : {}), checkedAt: new Date().toISOString() };
  state.set('health', report); return report;
}
