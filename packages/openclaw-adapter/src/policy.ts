import { type IOContract, type PermissionManifest, PermissionManifestSchema, SUPPORTED_EXECUTION_TOOLS, executionFileCompatibilityIssues } from '@kivro/contracts';
import { z } from 'zod';
import { FILE_SAFETY_CEILINGS } from '@kivro/contracts/file-limits';
import { MAX_JOB_PAUSE_MS, sandboxWallTimeoutSeconds } from './timing.ts';

export const SUPPORTED_OPENCLAW = '2026.8.2';
export const SUPPORTED_COMMIT = '0965053';
export const ADAPTER_POLICY_VERSION = 1;
export const TOOL_NAMES: Record<string, string> = Object.fromEntries(SUPPORTED_EXECUTION_TOOLS.map(name => [name, name.replaceAll('.', '_')]));
export const SUPPORTED_TOOLS = new Set<string>(SUPPORTED_EXECUTION_TOOLS);
export function runtimeToolName(name: string): string { const result = TOOL_NAMES[name]; if (!result) throw new Error('UNSUPPORTED_TOOL'); return result; }
export function publicToolName(name: string): string { const result = Object.keys(TOOL_NAMES).find(key => TOOL_NAMES[key] === name); if (!result) throw new Error('UNSUPPORTED_TOOL'); return result; }
export function assertWorkerFileContract(contract: IOContract): void {
  const issues = executionFileCompatibilityIssues(contract);
  if (issues.length) throw new Error('UNSUPPORTED_FILE_CONTRACT', { cause: issues });
}
export function assertWorkerPermissions(raw: unknown): PermissionManifest {
  const permissions = PermissionManifestSchema.parse(raw);
  if (permissions.tools.some(tool => !SUPPORTED_TOOLS.has(tool)) || new Set(permissions.tools).size !== permissions.tools.length) throw new Error('UNSUPPORTED_TOOL');
  if (permissions.tools.some(tool => tool.startsWith('research.')) && permissions.network.mode !== 'RESEARCH') throw new Error('NETWORK_PERMISSION_REQUIRED');
  if (permissions.tools.includes('connector.call') && permissions.network.mode !== 'CONNECTORS') throw new Error('CONNECTOR_PERMISSION_REQUIRED');
  if (permissions.network.mode === 'NONE' && permissions.network.allowedDomains.length) throw new Error('NETWORK_PERMISSION_REQUIRED');
  if (permissions.network.mode !== 'NONE' && !permissions.network.allowedDomains.length) throw new Error('DOMAIN_ALLOWLIST_REQUIRED');
  if (permissions.resources.some(resource => !['LOCAL_FILE', 'DATABASE'].includes(resource.type) || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(resource.id))) throw new Error('RESOURCE_BROKER_NOT_CONFIGURED');
  if (permissions.limits.maxInputBytes > FILE_SAFETY_CEILINGS.workerInputBytes || permissions.limits.maxOutputBytes > FILE_SAFETY_CEILINGS.workerOutputBytes) throw new Error('ADAPTER_BYTE_LIMIT_16_MIB');
  if (permissions.limits.memoryMb < 1024 || permissions.limits.maxPids < 64) throw new Error('OPENCLAW_REQUIRES_1024_MB_64_PIDS');
  if (!['openai-compatible', 'anthropic'].includes(permissions.inference.provider)) throw new Error('UNSUPPORTED_INFERENCE_TRANSPORT');
  return permissions;
}

export type ReviewedResearchTools = { searchSourceIds: readonly string[]; fetchSourceIds: readonly string[]; downloadSourceIds?: readonly string[] };
export function buildOpenClawConfig(permissions: PermissionManifest, research?: ReviewedResearchTools, maxPauseMs = MAX_JOB_PAUSE_MS): Record<string, unknown> {
  assertWorkerPermissions(permissions);
  const ids = z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(5);
  const reviewed = research && z.object({ searchSourceIds: ids, fetchSourceIds: ids, downloadSourceIds: ids.optional() }).strict().parse(research);
  if (reviewed && (reviewed.searchSourceIds.length && !permissions.tools.includes('research.search') || reviewed.fetchSourceIds.length && !permissions.tools.includes('research.fetch'))) throw new Error('RESEARCH_PLAN_TOOL_NOT_GRANTED');
  if (reviewed?.downloadSourceIds?.length && !permissions.tools.includes('research.download')) throw new Error('RESEARCH_PLAN_TOOL_NOT_GRANTED');
  const tools = permissions.tools.filter(name => !reviewed || (name !== 'research.search' || reviewed.searchSourceIds.length > 0) && (name !== 'research.fetch' || reviewed.fetchSourceIds.length > 0)).map(runtimeToolName);
  return {
    agents: { defaults: {
      workspace: '/job/work/seed', skipBootstrap: true, timeoutSeconds: sandboxWallTimeoutSeconds(permissions.limits.timeoutSeconds, maxPauseMs),
      model: { primary: `kivro/${permissions.inference.model}`, fallbacks: [] },
      sandbox: { mode: 'all', backend: 'ssh', scope: 'session', workspaceAccess: 'rw', ssh: {
        target: 'node@127.0.0.1:2222', workspaceRoot: '/job/work/sandboxes', strictHostKeyChecking: true, updateHostKeys: false,
        identityFile: '/job/work/ssh/identity', knownHostsFile: '/job/work/ssh/known_hosts',
      } },
    } },
    models: { mode: 'replace', providers: { kivro: {
      baseUrl: 'http://127.0.0.1:18789/v1', apiKey: 'kivro-ephemeral-broker-no-provider-secret', api: 'openai-completions',
      timeoutSeconds: sandboxWallTimeoutSeconds(permissions.limits.timeoutSeconds, maxPauseMs),
      models: [{ id: permissions.inference.model, name: permissions.inference.model, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: Math.min(4096, permissions.limits.maxTokens), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } },
    tools: { profile: permissions.tools.length ? 'full' : 'minimal', allow: tools, deny: ['exec', 'process', 'browser', 'gateway', 'nodes', 'cron', 'message', 'sessions_spawn', 'session_status', 'apply_patch', 'web_search', 'web_fetch'], elevated: { enabled: false }, sandbox: { tools: { allow: tools } } },
    plugins: { enabled: true, allow: ['kivro-broker'], load: { paths: ['/opt/kivro/plugin'] }, entries: { 'kivro-broker': { enabled: true, ...(reviewed ? { config: { reviewedResearch: reviewed } } : {}) } } }, browser: { enabled: false },
    skills: { allowBundled: [], load: { extraDirs: ['/job/input/skills'], watch: false } },
    env: { shellEnv: { enabled: false } },
    logging: { level: 'error', consoleLevel: 'silent' },
  };
}

export function isSupportedVersion(output: string): boolean {
  return /^OpenClaw 2026\.8\.2 \(0965053\)(?:\s|$)/.test(output.trim());
}
