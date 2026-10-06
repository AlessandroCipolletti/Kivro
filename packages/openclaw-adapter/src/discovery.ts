import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import JSON5 from 'json5';
import { parse as parseYaml } from 'yaml';
import { sha256, stableStringify } from '@kivro/crypto';
import { runProcess } from './process.ts';
import { isSupportedVersion, SUPPORTED_TOOLS, publicToolName } from './policy.ts';

export type DiscoveredDependency = {
  id: string; name: string; type: 'SKILL' | 'AI_MODEL' | 'CREDENTIAL' | 'EXECUTABLE' | 'PLUGIN' | 'TOOL' | 'RESOURCE' | 'INFERENCE' | 'NETWORK_DESTINATION' | 'CONFIGURATION';
  required: boolean; selected: false; confidence: 'DECLARED' | 'DETECTED' | 'INFERRED';
  certainty?: 'CONFIRMED' | 'LIKELY' | 'POSSIBLE' | 'UNKNOWN';
  support: 'SUPPORTED' | 'REVIEW_REQUIRED' | 'DEDICATED_CREDENTIAL_REQUIRED' | 'UNSUPPORTED'; dependsOn: string[];
  sourcePath?: string; contentHash?: string;
  adaptationRequired?: boolean; reason?: string;
};
export type ConfigurationMetadata = { agentIds: string[]; tools: string[]; mcpServers: { name: string; transport: 'STDIO' | 'HTTP' | 'UNKNOWN'; enabled: boolean }[]; workspaceReferences: { owner: string; kind: 'ABSOLUTE' | 'HOME_RELATIVE' | 'RELATIVE' | 'ENV_REFERENCE' }[]; environmentNames: string[]; sandboxMode: string | null; hasExternalIncludes: boolean };
export type LocalInferenceMetadata = { runtime: 'OLLAMA' | 'LM_STUDIO'; provider: 'openai-compatible'; endpoint: string; models: string[]; requiredService: string; hardwareRequirements: null };
export type RuntimeDiscovery = { version: string | null; compatible: boolean; configReadable: boolean; dependencies: DiscoveredDependency[]; warnings: string[]; configuration?: ConfigurationMetadata; localInference?: LocalInferenceMetadata[] };
export async function detectRuntime(binary = process.env.OPENCLAW_BIN ?? 'openclaw'): Promise<{ version: string; compatible: boolean }> {
  const result = await runProcess(binary, ['--version'], { timeoutMs: 15_000, maxBytes: 4096 });
  if (result.code !== 0) throw new Error('OPENCLAW_NOT_AVAILABLE');
  return { version: result.stdout.trim(), compatible: isSupportedVersion(result.stdout) };
}

async function readRegular(path: string, maxBytes: number): Promise<Buffer> {
  const stat = await lstat(path);
  if (await realpath(path) !== resolve(path) || !stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error('UNSAFE_IMPORT_FILE');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev || before.nlink !== 1 || before.size !== stat.size) throw new Error('IMPORT_CHANGED');
    const data = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < data.length) { const read = await handle.read(data, offset, data.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    const after = await handle.stat();
    if (offset !== stat.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1) throw new Error('IMPORT_CHANGED');
    return data.subarray(0, offset);
  } finally { await handle.close(); }
}
const names = z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/)).max(30);
const nativeRequirements = z.object({ bins: names.optional(), env: names.optional(), anyBins: names.optional(), config: names.optional() }).strict();
const brokerRequirements = z.object({ skills: names.optional(), tools: names.optional(), resources: names.optional(), domains: names.optional(), inference: z.boolean().optional() }).strict();
export const discoveryId = (type: string, name: string): string => sha256(`${type.toLowerCase()}:${name}`);
function object(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON5.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_SKILL_METADATA');
  return parsed as Record<string, unknown>;
}
export function skillMetadata(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const front = match ? object(parseYaml(match[1]!, { maxAliasCount: 10, uniqueKeys: true })) : {};
  const metadata = front.metadata === undefined ? {} : object(front.metadata);
  const native = object(metadata.openclaw ?? metadata.clawdbot ?? {}), kivro = object(metadata.kivro ?? {});
  const required = nativeRequirements.parse(native.requires ?? {}), brokers = brokerRequirements.parse(kivro.requires ?? {});
  if (native.primaryEnv !== undefined) required.env = [...new Set([...(required.env ?? []), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/).parse(native.primaryEnv)])];
  const os = native.os === undefined ? undefined : z.array(z.string()).max(10).parse(native.os);
  const blocked = !!native.install || !!required.anyBins?.length || !!required.config?.length || (os !== undefined && !os.includes('linux'));
  if (front['command-dispatch'] !== undefined) {
    if (front['command-dispatch'] !== 'tool' || typeof front['command-tool'] !== 'string') throw new Error('UNSUPPORTED_SKILL_DISPATCH');
    let tool = front['command-tool']; if (!SUPPORTED_TOOLS.has(tool)) tool = publicToolName(tool);
    brokers.tools = [...new Set([...(brokers.tools ?? []), tool])];
  }
  return { required, brokers, blocked, body: match ? content.slice(match[0].length) : content,
    description: typeof front.description === 'string' ? front.description.slice(0, 500) : 'Explicitly reviewed Kivro capability instructions.' };
}
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
/** Allowlisted model metadata only; provider credentials and config includes are never read or resolved. */
export function localInferenceMetadata(raw: unknown): LocalInferenceMetadata[] {
  const providers = record(record(record(raw).models).providers), result: LocalInferenceMetadata[] = [];
  for (const [name, runtime, requiredService] of [['ollama', 'OLLAMA', 'Ollama server'], ['lmstudio', 'LM_STUDIO', 'LM Studio local server']] as const) {
    const provider = record(providers[name]);
    if (typeof provider.baseUrl !== 'string') continue;
    try {
      const endpoint = new URL(provider.baseUrl);
      if (!['http:', 'https:'].includes(endpoint.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/', '/v1', '/v1/'].includes(endpoint.pathname)) continue;
      if (endpoint.hostname === 'localhost') endpoint.hostname = '127.0.0.1';
      endpoint.pathname = '/v1';
      const models = Array.isArray(provider.models) ? provider.models.slice(0, 100).map(item => record(item).id).filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./:@-]{0,199}$/.test(id) && !id.includes('..')) : [];
      result.push({ runtime, provider: 'openai-compatible', endpoint: endpoint.href, models: [...new Set(models)].sort(), requiredService, hardwareRequirements: null });
    } catch { /* Unsupported or unsafe provider metadata is not an import candidate. */ }
  }
  return result;
}
/** Projection of documented configuration only. Never resolve includes/env,
 * inspect referenced workspaces, connect MCP servers or return their options. */
export function configurationMetadata(raw: unknown): ConfigurationMetadata {
  const config = record(raw), safeName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value);
  const environment = new Set<string>(), toolNames = new Set<string>(); let hasExternalIncludes = false, visited = 0;
  const envName = (value: string) => { if (/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(value)) environment.add(value); };
  function visit(value: unknown, depth = 0) {
    if (++visited > 10000 || depth > 20) throw new Error('CONFIG_METADATA_LIMIT');
    if (typeof value === 'string') { for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]{0,99})\}/g)) envName(match[1]!); }
    else if (Array.isArray(value)) value.forEach(item => visit(item, depth + 1));
    else for (const [key, item] of Object.entries(record(value))) { if (key === '$include') hasExternalIncludes = true; if (key === 'env') { for (const [name, variable] of Object.entries(record(item))) if (typeof variable === 'string') envName(name); Object.keys(record(record(item).vars)).forEach(envName); } visit(item, depth + 1); }
  }
  visit(config);
  const agents = record(config.agents), defaults = record(agents.defaults), list = Array.isArray(agents.list) ? agents.list.map(record).slice(0, 100) : [];
  const agentIds = [...new Set(list.map(agent => agent.id).filter(safeName))].sort();
  const workspaces: ConfigurationMetadata['workspaceReferences'] = [];
  for (const [owner, agent] of [['defaults', defaults], ...list.filter(agent => safeName(agent.id)).map(agent => [`agent:${agent.id}`, agent])] as [string, Record<string, unknown>][]) {
    const path = agent.workspace;
    if (typeof path === 'string' && path.length) workspaces.push({ owner, kind: path.includes('${') ? 'ENV_REFERENCE' : path.startsWith('~/') ? 'HOME_RELATIVE' : path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? 'ABSOLUTE' : 'RELATIVE' });
  }
  for (const tools of [record(config.tools), ...list.map(agent => record(agent.tools))]) for (const group of ['allow', 'alsoAllow', 'deny']) {
    if (Array.isArray(tools[group])) (tools[group] as unknown[]).filter(safeName).forEach(name => toolNames.add(name));
  }
  const mcpServers: ConfigurationMetadata['mcpServers'] = Object.entries(record(record(config.mcp).servers)).filter(([name]) => safeName(name)).slice(0, 100).map(([name, raw]) => {
    const server = record(raw); return { name, enabled: server.enabled !== false, transport: typeof server.command === 'string' ? 'STDIO' : typeof server.url === 'string' ? 'HTTP' : 'UNKNOWN' };
  });
  const mode = record(defaults.sandbox).mode;
  if (environment.size > 100 || toolNames.size > 100) throw new Error('CONFIG_METADATA_LIMIT');
  return { agentIds, tools: [...toolNames].sort(), mcpServers, workspaceReferences: workspaces, environmentNames: [...environment].sort(), sandboxMode: ['off', 'non-main', 'all'].includes(String(mode)) ? String(mode) : null, hasExternalIncludes };
}
export async function scanRuntime(binary?: string, configRoot = join(homedir(), '.openclaw'), options: { skills?: boolean } = {}): Promise<RuntimeDiscovery> {
  const runtime = await detectRuntime(binary).catch(() => ({ version: null, compatible: false }));
  const dependencies: DiscoveredDependency[] = [], warnings: string[] = [];
  let localInference: LocalInferenceMetadata[] = [];
  let configReadable = false, configuration: ConfigurationMetadata | undefined;
  try {
    const path = join(configRoot, 'openclaw.json');
    const config = object(JSON5.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readRegular(path, 2 * 1024 ** 2))));
    configuration = configurationMetadata(config);
    localInference = localInferenceMetadata(config);
    configReadable = true;
    if (configuration.hasExternalIncludes) warnings.push('EXTERNAL_CONFIG_INCLUDES_NOT_FOLLOWED');
    const model = record(record(config.agents).defaults).model;
    const modelName = typeof model === 'string' ? model : record(model).primary;
    if (typeof modelName === 'string' && /^[a-zA-Z0-9_./:@-]{1,200}$/.test(modelName)) dependencies.push({ id: sha256(`model:${modelName}`), name: modelName, type: 'AI_MODEL', required: true, selected: false, support: 'DEDICATED_CREDENTIAL_REQUIRED', confidence: 'DETECTED', certainty: 'LIKELY', dependsOn: [] });
    for (const [name, value] of Object.entries(record(record(config.plugins).entries))) if (value && typeof value === 'object' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) dependencies.push({ id: sha256(`plugin:${name}`), name, type: 'PLUGIN', required: false, selected: false, support: 'UNSUPPORTED', confidence: 'DETECTED', certainty: 'LIKELY', dependsOn: [] });
  } catch { warnings.push('PERSONAL_CONFIG_UNREADABLE_OR_UNSAFE'); }
  // Personal workspace files, auth stores and provider values are never enumerated.
  if (options.skills === false) return { ...runtime, configReadable, dependencies, warnings: [...new Set(warnings)], configuration, ...(localInference.length ? { localInference } : {}) };
  const skillRoot = join(configRoot, 'skills');
  try {
    if ((await lstat(skillRoot)).isSymbolicLink()) throw new Error('SYMLINK_SKILLS');
    const entries = (await readdir(skillRoot)).sort();
    if (entries.length > 200) warnings.push('SKILL_SCAN_LIMIT_EXCEEDED');
    for (const name of entries.slice(0, 200)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name)) continue;
      const root = join(skillRoot, name);
      if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) continue;
      try {
        const sourcePath = join(root, 'SKILL.md'), data = await readRegular(sourcePath, 256 * 1024);
        const metadata = skillMetadata(new TextDecoder('utf-8', { fatal: true }).decode(data));
        const dependsOn: string[] = [];
        const require = (type: DiscoveredDependency['type'], requirement: string, support: DiscoveredDependency['support']) => {
          const id = discoveryId(type, requirement); dependsOn.push(id);
          if (type !== 'SKILL' && !dependencies.some(dependency => dependency.id === id)) {
            const credential = discoveryId('CREDENTIAL', 'KIVRO_DEDICATED_INFERENCE');
            dependencies.push({ id, name: requirement, type, required: true, selected: false, confidence: 'DECLARED', certainty: 'LIKELY', support, dependsOn: type === 'INFERENCE' ? [credential] : [] });
            if (type === 'INFERENCE' && !dependencies.some(dependency => dependency.id === credential)) dependencies.push({ id: credential, name: 'KIVRO_DEDICATED_INFERENCE', type: 'CREDENTIAL', required: true, selected: false, confidence: 'DECLARED', certainty: 'LIKELY', support: 'DEDICATED_CREDENTIAL_REQUIRED', dependsOn: [] });
          }
        };
        for (const requirement of metadata.required.env ?? []) require('CREDENTIAL', requirement, 'DEDICATED_CREDENTIAL_REQUIRED');
        for (const requirement of metadata.required.bins ?? []) require('EXECUTABLE', requirement, ['blender', 'ffmpeg', 'psql'].includes(requirement) ? 'REVIEW_REQUIRED' : 'UNSUPPORTED');
        for (const requirement of [...metadata.required.config ?? [], ...metadata.required.anyBins ?? []]) require('CONFIGURATION', requirement, 'UNSUPPORTED');
        for (const requirement of metadata.brokers.skills ?? []) require('SKILL', requirement, 'REVIEW_REQUIRED');
        for (const requirement of metadata.brokers.tools ?? []) require('TOOL', requirement, SUPPORTED_TOOLS.has(requirement) ? 'SUPPORTED' : 'UNSUPPORTED');
        for (const requirement of metadata.brokers.resources ?? []) require('RESOURCE', requirement, 'REVIEW_REQUIRED');
        for (const requirement of metadata.brokers.domains ?? []) require('NETWORK_DESTINATION', requirement, 'REVIEW_REQUIRED');
        if (metadata.brokers.inference) require('INFERENCE', 'configured', 'REVIEW_REQUIRED');
        dependencies.push({ id: discoveryId('SKILL', name), name, type: 'SKILL', required: false, selected: false, confidence: 'DETECTED', certainty: 'CONFIRMED', support: metadata.blocked ? 'UNSUPPORTED' : dependsOn.length ? 'REVIEW_REQUIRED' : 'SUPPORTED', dependsOn: [...new Set(dependsOn)], sourcePath, contentHash: sha256(data), adaptationRequired: !!metadata.required.env?.length || !!metadata.required.bins?.length, ...(metadata.blocked ? { reason: 'NATIVE_INSTALLER_CONFIG_PLATFORM_OR_ALTERNATIVE_EXECUTION_UNSUPPORTED' } : {}) });
      } catch { dependencies.push({ id: discoveryId('SKILL', name), name, type: 'SKILL', required: false, selected: false, confidence: 'DETECTED', certainty: 'UNKNOWN', support: 'UNSUPPORTED', dependsOn: [], reason: 'UNSAFE_OR_INVALID_SKILL_METADATA' }); warnings.push('SKILL_SCAN_FAILED'); }
    }
  } catch { warnings.push('NO_SAFE_PERSONAL_SKILL_DIRECTORY'); }
  return { ...runtime, configReadable, dependencies, warnings: [...new Set(warnings)], configuration, ...(localInference.length ? { localInference } : {}) };
}

export type SelectedSkill = { name: string; content: string; sha256: string };
export function selectedDependencyClosure(discovery: RuntimeDiscovery, selectedIds: string[]): DiscoveredDependency[] {
  if (!discovery.compatible) throw new Error('UNSUPPORTED_DISCOVERY_RUNTIME');
  if (!selectedIds.length || selectedIds.length > 100 || new Set(selectedIds).size !== selectedIds.length) throw new Error('INVALID_DEPENDENCY_SELECTION');
  const byId = new Map(discovery.dependencies.map(item => [item.id, item]));
  if (byId.size !== discovery.dependencies.length) throw new Error('DUPLICATE_DISCOVERY_DEPENDENCY');
  const visited = new Set<string>(), active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) throw new Error('DEPENDENCY_CYCLE');
    if (visited.has(id)) return;
    const dependency = byId.get(id); if (!dependency) throw new Error('UNKNOWN_DEPENDENCY');
    if (!selectedIds.includes(id)) throw new Error('REQUIRED_DEPENDENCY_NOT_SELECTED');
    if (dependency.support === 'UNSUPPORTED') throw new Error('UNSUPPORTED_IMPORT_DEPENDENCY');
    active.add(id); dependency.dependsOn.forEach(visit); active.delete(id); visited.add(id);
  };
  selectedIds.forEach(visit); return selectedIds.map(id => byId.get(id)!);
}
export async function readSelectedSkill(dependency: DiscoveredDependency): Promise<string> {
  const path = dependency.sourcePath;
  if (dependency.type !== 'SKILL' || !path || basename(path) !== 'SKILL.md') throw new Error('UNSAFE_SKILL_SOURCE');
  const content = await readRegular(path, 256 * 1024);
  if (sha256(content) !== dependency.contentHash) throw new Error('SKILL_CHANGED_REVIEW_REQUIRED');
  return new TextDecoder('utf-8', { fatal: true }).decode(content);
}
export async function importSelectedSkills(discovery: RuntimeDiscovery, selectedIds: string[], approvedSnapshotHash: string): Promise<SelectedSkill[]> {
  if (sha256(stableStringify(discovery)) !== approvedSnapshotHash) throw new Error('IMPORT_CONSENT_MISMATCH');
  const selected = selectedDependencyClosure(discovery, selectedIds);
  for (const dependency of selected) {
    if (dependency.type !== 'SKILL' || dependency.support !== 'SUPPORTED') throw new Error('DEPENDENCY_IMPORT_PLAN_REQUIRED');
    if (dependency.dependsOn.some(id => !selectedIds.includes(id))) throw new Error('REQUIRED_DEPENDENCY_NOT_SELECTED');
  }
  const result: SelectedSkill[] = [];
  for (const dependency of selected) {
    const content = await readSelectedSkill(dependency);
    result.push({ name: dependency.name, content, sha256: sha256(content) });
  }
  return result;
}
