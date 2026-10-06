import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { SUPPORTED_EXECUTION_TOOLS, type Schedule, type Availability, type JobState, type PermissionManifest, type Dependency } from '@kivro/contracts';
import { isScheduleOpen, nextScheduledTime } from './schedule.ts';
export { isScheduleOpen, nextScheduledTime, schedulePreview } from './schedule.ts';

export class PolicyError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'PolicyError'; }
}

export type AvailabilityContext = {
  schedule: Schedule; workerOnline: boolean; sandboxReady: boolean; paused: boolean; securityBlocked: boolean;
  runningJobs: number; concurrency: number; queueDepth: number; maxQueue: number; dependenciesHealthy?: boolean;
};
export function evaluateAvailability(context: AvailabilityContext, now: Date = new Date()): Availability {
  const unavailable = (status: Availability['status'], reason: string, nextAvailableAt: string | null = null): Availability => ({ status, reason, canRunNow: false, canQueue: false, nextAvailableAt });
  if (context.securityBlocked) return unavailable('SECURITY_BLOCKED', 'Security verification is required.');
  if (context.paused || context.schedule.mode === 'MANUAL') return unavailable('PAUSED', 'The seller has paused new jobs.');
  if (!context.workerOnline) return unavailable('OFFLINE', 'The worker is disconnected.');
  if (!context.sandboxReady || context.dependenciesHealthy !== true) return unavailable('OFFLINE', 'Required execution dependencies are unavailable or unverified.');
  if (!isScheduleOpen(context.schedule, now)) return unavailable('SCHEDULED_OFFLINE', 'Outside the seller execution window.', nextScheduledTime(context.schedule, now));
  if (context.concurrency < 1 || context.runningJobs >= context.concurrency || context.queueDepth > 0) {
    const canQueue = context.concurrency > 0 && context.maxQueue > 0 && context.runningJobs + context.queueDepth < context.concurrency + context.maxQueue;
    return { ...unavailable('BUSY', canQueue ? 'Previously accepted jobs are awaiting execution.' : 'All execution and queue slots are occupied.'), canQueue };
  }
  return { status: 'ONLINE', canRunNow: true, canQueue: false, nextAvailableAt: null, reason: null };
}

const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  CREATED: ['PAYMENT_RESERVED', 'CANCELLED', 'FAILED'],
  PAYMENT_RESERVED: ['QUEUED', 'SCHEDULED', 'CANCELLED', 'FAILED'],
  SCHEDULED: ['QUEUED', 'CANCELLED', 'TIMED_OUT', 'FAILED'],
  QUEUED: ['OFFERED', 'SCHEDULED', 'CANCELLED', 'TIMED_OUT', 'FAILED'],
  OFFERED: ['ACCEPTED', 'QUEUED', 'CANCELLED', 'TIMED_OUT', 'FAILED'],
  ACCEPTED: ['RUNNING', 'PAUSE_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'FAILED'],
  RUNNING: ['PAUSE_REQUESTED', 'UPLOADING_RESULTS', 'VALIDATING_RESULTS', 'CANCELLED', 'TIMED_OUT', 'FAILED'],
  PAUSE_REQUESTED: ['PAUSED', 'CANCELLED', 'TIMED_OUT', 'FAILED'],
  PAUSED: ['RESUMING', 'CANCELLED', 'TIMED_OUT', 'FAILED'],
  RESUMING: ['RUNNING', 'PAUSE_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'FAILED'],
  UPLOADING_RESULTS: ['VALIDATING_RESULTS', 'PAUSE_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'FAILED'],
  VALIDATING_RESULTS: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  SUCCEEDED: [], FAILED: [], CANCELLED: [], TIMED_OUT: [],
};
export const TERMINAL_JOB_STATES: readonly JobState[] = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
export function canTransition(from: string, to: string): boolean { return from === to ? from in TRANSITIONS : (TRANSITIONS[from as JobState] ?? []).includes(to as JobState); }
export function assertTransition(from: string, to: string): void { if (!canTransition(from, to)) throw new PolicyError('INVALID_JOB_TRANSITION', `Cannot transition from ${from} to ${to}.`); }

export function assertSafeRelativePath(path: string): string {
  if (!path || path.length > 512 || path.startsWith('/') || /^[a-zA-Z]:/.test(path) || /[\\\x00-\x1f\x7f]/.test(path)) throw new PolicyError('UNSAFE_PATH', 'Expected a safe relative path.');
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { throw new PolicyError('UNSAFE_PATH', 'Malformed path encoding.'); }
  if (decoded !== path || path.split('/').some(segment => !segment || segment === '..' || segment === '.')) throw new PolicyError('UNSAFE_PATH', 'Path traversal and encoded paths are not permitted.');
  return path;
}
export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address.replace(/^\[|\]$/g, ''));
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) return isPublicAddress((parsed as ipaddr.IPv6).toIPv4Address().toString());
    return parsed.range() === 'unicast';
  } catch { return false; }
}
export async function resolvePublicUrl(raw: string): Promise<{ url: URL; addresses: { address: string; family: number }[] }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new PolicyError('INVALID_URL', 'A valid HTTP(S) URL is required.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || raw.length > 4096) throw new PolicyError('BLOCKED_URL', 'URL is not permitted.');
  if (url.port && !['80', '443'].includes(url.port)) throw new PolicyError('BLOCKED_URL', 'Only public HTTP(S) ports are permitted.');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || host === 'localhost' || /\.(localhost|local|internal|home|lan|test|invalid)$/.test(host) || (!host.includes('.') && !isIP(host))) throw new PolicyError('BLOCKED_URL', 'Private hostnames are not permitted.');
  let addresses: { address: string; family: number }[];
  try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true }); }
  catch { throw new PolicyError('DNS_FAILURE', 'The remote hostname could not be resolved.'); }
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new PolicyError('SSRF_BLOCKED', 'Private, reserved or mixed DNS destinations are blocked.');
  return { url, addresses };
}
// Callers making network requests must pin the returned address, including after redirects.
export async function validatePublicUrl(raw: string): Promise<URL> { return (await resolvePublicUrl(raw)).url; }

export function assertProductionConfiguration(env: Record<string, string | undefined>): void {
  const production = env.NODE_ENV === 'production' || env.KIVRO_ENV === 'production';
  if (!production) return;
  for (const key of ['DEV_AUTH_ENABLED', 'KIVRO_DEV_AUTH', 'DEV_MODE', 'KIVRO_DEMO']) if (['1', 'true', 'yes'].includes(env[key]?.toLowerCase() ?? '')) throw new PolicyError('UNSAFE_PRODUCTION_CONFIG', `${key} cannot be enabled in production.`);
  if (env.PAYMENT_MODE !== 'stripe') throw new PolicyError('UNSAFE_PRODUCTION_CONFIG', 'Production requires Stripe payments.');
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32 || /replace|local|example/i.test(env.SESSION_SECRET)) throw new PolicyError('UNSAFE_PRODUCTION_CONFIG', 'Production requires a strong dedicated session secret.');
  for (const key of ['WEB_ORIGIN', 'API_URL']) if (!env[key]?.startsWith('https://')) throw new PolicyError('UNSAFE_PRODUCTION_CONFIG', `${key} must use HTTPS in production.`);
  if (!env.STRIPE_SECRET_KEY?.startsWith('sk_live_') || !env.STRIPE_WEBHOOK_SECRET) throw new PolicyError('UNSAFE_PRODUCTION_CONFIG', 'Production requires live Stripe credentials and webhook verification.');
  if ([env.DATABASE_URL, env.S3_ACCESS_KEY, env.S3_SECRET_KEY].some(v => !v || /kivro_local|local_only/.test(v))) throw new PolicyError('UNSAFE_PRODUCTION_CONFIG', 'Development infrastructure credentials cannot be used in production.');
}
export function assertPublishable(permissions: PermissionManifest, dependencies: Dependency[]): void {
  const supportedTools = new Set<string>(SUPPORTED_EXECUTION_TOOLS);
  if (permissions.tools.some(t => !supportedTools.has(t))) throw new PolicyError('UNSAFE_TOOL', 'Only reviewed narrow tools can be published.');
  const byId = new Map(dependencies.map(d => [d.id, d]));
  if (byId.size !== dependencies.length) throw new PolicyError('DEPENDENCY_CONFLICT', 'Dependency IDs must be unique.');
  const visited = new Set<string>(); const active = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) throw new PolicyError('DEPENDENCY_CYCLE', 'Dependency graphs must be acyclic.');
    if (visited.has(id)) return;
    const dependency = byId.get(id);
    if (!dependency || !dependency.approved || !dependency.healthy || dependency.supported !== true) throw new PolicyError('DEPENDENCY_NOT_READY', 'Every granted dependency and its prerequisites must be explicitly approved, supported and healthy.');
    active.add(id);
    for (const child of dependency.dependsOn ?? []) visit(child);
    active.delete(id); visited.add(id);
  };
  for (const dependency of dependencies) if (dependency.required || dependency.approved) visit(dependency.id);
  const approved = dependencies.filter(d => visited.has(d.id));
  const grant = (kind: keyof NonNullable<Dependency['grants']>, value: string) => {
    if (!approved.some(d => d.grants?.[kind]?.includes(value))) throw new PolicyError('PERMISSION_NOT_APPROVED', `The ${kind} permission ${value} has no approved dependency grant.`);
  };
  for (const tool of permissions.tools) grant('tools', tool);
  for (const resource of permissions.resources) grant('resources', resource.id);
  for (const domain of permissions.network.allowedDomains) grant('domains', domain);
  grant('inferenceProviders', permissions.inference.provider);
  if (permissions.inference.credentialRef) grant('credentialRefs', permissions.inference.credentialRef);
  if (!approved.some(d => /inference/i.test(d.type) && d.required && d.grants?.inferenceProviders?.includes(permissions.inference.provider))) throw new PolicyError('INFERENCE_REQUIRED', 'A verified and approved inference dependency is required.');
  if (permissions.network.mode === 'NONE' && permissions.network.allowedDomains.length) throw new PolicyError('NETWORK_CONFLICT', 'A no-network capability cannot include allowed domains.');
  for (const domain of permissions.network.allowedDomains) if (!/^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/.test(domain) || domain.includes('*') || /\.(local|internal|localhost)$/.test(domain)) throw new PolicyError('UNSAFE_DOMAIN', 'Network domains must be explicit public hostnames.');
}
