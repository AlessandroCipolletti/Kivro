import type { Check } from './readiness.ts';
import type { SecretStore } from './secrets.ts';
import type { WorkerState } from './state.ts';
import { DeploymentEnvironmentSchema, TransportError, WorkerTransport, type DeviceIdentity, type WorkerDiagnostics } from './transport.ts';
import { randomUUID } from 'node:crypto';

export const WORKER_VERSION = '0.1.0';
export const MAX_CLOCK_SKEW_MS = 30000;
export function deploymentStatus(state: WorkerState) {
  const identity = state.get<DeviceIdentity>('identity');
  let apiOrigin: string | null = null;
  try { const url = new URL(identity?.apiUrl ?? ''); if (['http:', 'https:'].includes(url.protocol)) apiOrigin = url.origin; } catch { /* Unpaired or invalid configuration remains unknown. */ }
  const saved = state.get<{ workerId: string; apiOrigin: string; deploymentEnvironment: unknown; verifiedAt: string }>('cloudDeployment');
  const parsed = DeploymentEnvironmentSchema.safeParse(saved?.deploymentEnvironment), bound = apiOrigin && saved?.apiOrigin === apiOrigin && saved.workerId === identity?.workerId && parsed.success;
  return { apiOrigin, deploymentEnvironment: bound ? parsed.data : 'unknown' as const, verifiedAt: bound ? saved.verifiedAt : null };
}
export async function refreshDeployment(state: WorkerState, secrets: SecretStore, development: boolean): Promise<WorkerDiagnostics> {
  const identity = state.get<DeviceIdentity>('identity'); if (!identity) throw new Error('NOT_PAIRED');
  const transport = new WorkerTransport(identity.apiUrl, identity, await secrets.get('device-identity'), development);
  try {
    const report = await transport.diagnostics(); recordDeployment(state, transport, report); return report;
  } catch (error) { state.delete('cloudDeployment'); throw error; }
}
function recordDeployment(state: WorkerState, transport: WorkerTransport, report: WorkerDiagnostics): void {
  state.set('cloudDeployment', { workerId: report.workerId, apiOrigin: transport.origin.origin, deploymentEnvironment: report.deploymentEnvironment ?? 'unknown', verifiedAt: new Date().toISOString() });
}
export function workerDatabaseCheck(state: WorkerState): Check {
  try {
    const key = `doctorProbe:${randomUUID()}`;
    state.transaction(() => { state.set(key, true); if (state.get(key) !== true) throw new Error(); state.delete(key); });
    return { id: 'workerDatabase', status: 'PASS', code: 'WORKER_DATABASE_WRITABLE' };
  } catch { return { id: 'workerDatabase', status: 'FAIL', code: 'WORKER_DATABASE_NOT_WRITABLE', action: 'Check Worker home ownership, private file permissions, free disk space and database locks. Do not delete state or replay unfinished jobs.' }; }
}
export function configReadabilityCheck(readable: boolean): Check {
  return { id: 'openclawConfig', status: readable ? 'PASS' : 'FAIL', code: readable ? 'OPENCLAW_CONFIG_READABLE' : 'OPENCLAW_CONFIG_UNREADABLE_OR_UNSAFE', ...(!readable ? { action: 'Check the personal openclaw.json exists and is a readable regular, non-linked file. The Worker never repairs or writes personal OpenClaw configuration.' } : {}) };
}
function release(raw: string): number[] | undefined {
  if (!/^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(raw)) return;
  return raw.split('.').map(Number);
}
function atLeast(actual: number[], minimum: number[]): boolean {
  for (let index = 0; index < 3; index++) { if (actual[index] !== minimum[index]) return actual[index]! > minimum[index]!; }
  return true;
}
export function nodeRuntimeCheck(version = process.versions.node, sqliteAvailable = typeof process.getBuiltinModule?.('node:sqlite')?.DatabaseSync === 'function'): Check {
  const parsed = release(version);
  return parsed && atLeast(parsed, [22, 13, 0]) && sqliteAvailable
    ? { id: 'node', status: 'PASS', code: 'NODE_SQLITE_SUPPORTED' }
    : { id: 'node', status: 'FAIL', code: 'NODE_RUNTIME_UNSUPPORTED', action: 'Use Node >=22.13.0 with node:sqlite; ensure the foreground CLI and LaunchAgent use that same executable.' };
}
export function clockCheck(serverTime: string, startedAt: number, endedAt: number, elapsedMs: number, authenticated = true): Check {
  const server = Date.parse(serverTime), duration = endedAt - startedAt;
  if (![server, startedAt, endedAt, elapsedMs].every(Number.isFinite) || elapsedMs < 0 || elapsedMs > 10000 || Math.abs(duration - elapsedMs) > 1000) return { id: 'clock', status: 'FAIL', code: 'CLOCK_UNVERIFIED', action: 'Check network latency and host clock stability, then rerun doctor.' };
  const skew = server - (startedAt + endedAt) / 2;
  if (Math.abs(skew) + elapsedMs / 2 > MAX_CLOCK_SKEW_MS) return { id: 'clock', status: 'FAIL', code: 'CLOCK_SKEW_EXCEEDED', action: 'Enable automatic date/time synchronization on this host and confirm API server time. Worker allows 30 seconds including round-trip uncertainty; it never adjusts signing time.' };
  return { id: 'clock', status: authenticated ? 'PASS' : 'WARN', code: authenticated ? 'CLOCK_SYNCHRONIZED' : 'PUBLIC_CLOCK_HINT_ONLY', ...(!authenticated ? { action: 'Public health time is diagnostic only; authenticated device verification must still pass.' } : {}) };
}
export function cloudPolicyCheck(policy: Pick<WorkerDiagnostics, 'minimumWorkerVersion' | 'minimumOpenClawVersion' | 'policyReason' | 'revokedWorkerVersions' | 'revokedOpenClawVersions'>, openclawVersion: string | null): Check {
  const { minimumWorkerVersion, minimumOpenClawVersion, policyReason, revokedWorkerVersions, revokedOpenClawVersions } = policy;
  const worker = release(WORKER_VERSION)!, minimumWorker = release(minimumWorkerVersion), minimumClaw = release(minimumOpenClawVersion);
  const match = /^OpenClaw (\d+\.\d+\.\d+) \([a-f0-9]+\)$/.exec(openclawVersion ?? ''), claw = match && release(match[1]!);
  const fail = (code: string, action: string): Check => ({ id: 'cloudPolicy', status: 'FAIL', code, action });
  if (!minimumWorker || !minimumClaw) return fail('SERVER_VERSION_POLICY_UNSUPPORTED', 'The Worker supports stable x.y.z minimum-version policies. Contact the operator; policy cannot be ignored.');
  if (revokedWorkerVersions.includes(WORKER_VERSION)) return fail('WORKER_VERSION_REVOKED', 'This local Worker version is revoked by the API. Install an approved release before executing jobs.');
  if (match && revokedOpenClawVersions.includes(match[1]!)) return fail('OPENCLAW_VERSION_REVOKED', 'This local OpenClaw version is revoked by the API. An approved adapter/runtime/image update is required.');
  if (!atLeast(worker, minimumWorker)) return fail('WORKER_UPDATE_REQUIRED', 'Install an approved Worker release satisfying the API minimum version, then rerun doctor.');
  if (!claw || !atLeast(claw, minimumClaw)) return fail('OPENCLAW_UPDATE_REQUIRED', 'Use an approved adapter/image and OpenClaw version satisfying both the local pin and API policy. No unreviewed upgrade fallback is allowed.');
  // Pairing has no runtime heartbeat yet. Known mirror-version reasons are
  // recomputed against the complete authenticated policy and local versions.
  if (policyReason && !['WORKER_UPDATE_REQUIRED', 'OPENCLAW_UPDATE_REQUIRED', 'WORKER_VERSION_REVOKED', 'OPENCLAW_VERSION_REVOKED'].includes(policyReason)) return fail('SERVER_EXECUTION_POLICY_BLOCKED', 'The API returned an unknown execution policy block. Contact the operator; it cannot be overridden locally.');
  return { id: 'cloudPolicy', status: 'PASS', code: 'SERVER_EXECUTION_POLICY_SATISFIED' };
}
export async function cloudReadiness(state: WorkerState, secrets: SecretStore, openclawVersion: string | null, development: boolean): Promise<Check[]> {
  const identity = state.get<DeviceIdentity>('identity');
  if (!identity) return [{ id: 'cloudDevice', status: 'FAIL', code: 'PAIRING_REQUIRED', action: 'Pair this Worker with the intended API before validation or execution.' }, { id: 'clock', status: 'FAIL', code: 'CLOCK_UNVERIFIED' }];
  let transport: WorkerTransport | undefined;
  try {
    transport = new WorkerTransport(identity.apiUrl, identity, await secrets.get('device-identity'), development);
    const startedAt = Date.now(), started = performance.now(), report = await transport.diagnostics();
    recordDeployment(state, transport, report);
    return [{ id: 'cloudDevice', status: 'PASS', code: 'CLOUD_DEVICE_AUTHENTICATED' }, clockCheck(report.serverTime, startedAt, Date.now(), performance.now() - started), cloudPolicyCheck(report, openclawVersion)];
  } catch (error) {
    state.delete('cloudDeployment');
    const rejected = error instanceof TransportError && [401, 403].includes(error.status);
    const code = rejected ? 'CLOUD_DEVICE_AUTH_REJECTED' : error instanceof Error && ['CLOUD_DEVICE_MISMATCH', 'CLOUD_DIAGNOSTICS_INVALID'].includes(error.message) ? error.message : 'CLOUD_DIAGNOSTICS_UNAVAILABLE';
    const checks: Check[] = [{ id: 'cloudDevice', status: 'FAIL', code, action: rejected ? 'Check clock diagnostics and the cloud device revocation status. Never auto-repair or reuse a revoked identity; contact the operator.' : 'Check the paired API endpoint, TLS/network access and device Keychain availability, then rerun doctor.' }];
    if (rejected && transport) {
      try { const startedAt = Date.now(), started = performance.now(), time = await transport.publicClock(); checks.push(clockCheck(time, startedAt, Date.now(), performance.now() - started, false)); }
      catch { checks.push({ id: 'clock', status: 'FAIL', code: 'CLOCK_UNVERIFIED' }); }
    } else checks.push({ id: 'clock', status: 'FAIL', code: 'CLOCK_UNVERIFIED' });
    return checks;
  }
}
