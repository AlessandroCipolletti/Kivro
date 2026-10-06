import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, readFile, lstat, readdir, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashManifest } from '@kivro/contracts';
import { scanRuntime, discoveryId, selectedDependencyClosure, importSelectedSkills, skillMetadata, configurationMetadata } from './discovery.ts';
import * as process from './process.ts';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(skills: Record<string, string>) {
  vi.spyOn(process, 'runProcess').mockResolvedValue({ code: 0, stdout: 'OpenClaw 2026.8.2 (0965053)', stderr: '' });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-discovery-'))); roots.push(root);
  await writeFile(join(root, 'openclaw.json'), JSON.stringify({ agents: { defaults: { model: 'personal/model' } }, plugins: { entries: { personal: { enabled: true } } }, env: { PERSONAL_KEY: 'do-not-import-key' } }));
  await writeFile(join(root, 'auth-profiles.json'), 'do-not-import-auth'); await writeFile(join(root, 'session.json'), 'do-not-import-session');
  for (const [name, content] of Object.entries(skills)) { await mkdir(join(root, 'skills', name), { recursive: true }); await writeFile(join(root, 'skills', name, 'SKILL.md'), content); }
  return root;
}
async function snapshot(root: string): Promise<unknown> {
  const entries: unknown[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name), stat = await lstat(path);
    entries.push({ name, mode: stat.mode, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, content: stat.isDirectory() ? await snapshot(path) : await readFile(path, 'utf8') });
  }
  return entries;
}
const metadata = (value: unknown) => `---\nmetadata: ${JSON.stringify(value)}\n---\nReviewed instructions.`;
describe('read-only explicit dependency discovery', () => {
  it('discovers references without selecting, exposing secrets, running tools, or modifying personal files/metadata', async () => {
    const root = await fixture({ report: metadata({ kivro: { requires: { skills: ['helper'], tools: ['resource.read'], resources: ['document'], inference: true } } }), helper: 'Helper instructions.' });
    const before = await snapshot(root), scan = await scanRuntime(undefined, root);
    expect(scan.compatible).toBe(true); expect(scan.dependencies.every(node => node.selected === false)).toBe(true);
    const ids = scan.dependencies.filter(node => node.type !== 'AI_MODEL' && node.type !== 'PLUGIN').map(node => node.id);
    expect(selectedDependencyClosure(scan, ids)).toHaveLength(6);
    expect(scan.dependencies.find(node => node.type === 'INFERENCE')?.dependsOn).toEqual([discoveryId('CREDENTIAL', 'KIVRO_DEDICATED_INFERENCE')]);
    expect(() => selectedDependencyClosure(scan, [discoveryId('SKILL', 'report')])).toThrow('REQUIRED_DEPENDENCY_NOT_SELECTED');
    expect(() => selectedDependencyClosure(scan, [...ids, discoveryId('PLUGIN', 'personal')])).toThrow();
    expect(JSON.stringify(scan)).not.toMatch(/do-not-import/); expect(scan.configuration?.environmentNames).toEqual(['PERSONAL_KEY']);
    expect(await snapshot(root)).toEqual(before);
    expect(process.runProcess).toHaveBeenCalledExactlyOnceWith(expect.anything(), ['--version'], expect.anything());
    await expect(importSelectedSkills(scan, ids, hashManifest(scan))).rejects.toThrow('DEPENDENCY_IMPORT_PLAN_REQUIRED');
  });
  it('projects documented config names and workspace reference types without values, paths, includes or MCP connections', async () => {
    const root = await fixture({ one: 'safe instructions' });
    await writeFile(join(root, 'openclaw.json'), JSON.stringify({ agents: { defaults: { workspace: '/private/workspace-canary', sandbox: { mode: 'all' } }, list: [{ id: 'reports', workspace: '${WORK_ROOT}/data', tools: { allow: ['resource_query'] } }] },
      tools: { allow: ['read', 'write'], deny: ['exec'] }, mcp: { servers: { privateDb: { command: 'never-execute-canary', args: ['secret-command-argument'], env: { MCP_PASSWORD: 'secret-mcp-value' } }, remote: { url: 'https://user:secret@private.example/path', headers: { authorization: 'Bearer ${MCP_TOKEN}' } } } },
      env: { vars: { PROVIDER_KEY: 'provider-secret-canary' }, shellEnv: { enabled: true } }, models: { providers: { seller: { apiKey: '${MODEL_KEY}' } } }, extra: { $include: '/private/do-not-read.json' },
    }));
    const before = await snapshot(root), scan = await scanRuntime(undefined, root, { skills: false });
    expect(scan.configuration).toEqual({ agentIds: ['reports'], tools: ['exec', 'read', 'resource_query', 'write'], mcpServers: [{ name: 'privateDb', transport: 'STDIO', enabled: true }, { name: 'remote', transport: 'HTTP', enabled: true }], workspaceReferences: [{ owner: 'defaults', kind: 'ABSOLUTE' }, { owner: 'agent:reports', kind: 'ENV_REFERENCE' }], environmentNames: ['MCP_PASSWORD', 'MCP_TOKEN', 'MODEL_KEY', 'PROVIDER_KEY', 'WORK_ROOT'], sandboxMode: 'all', hasExternalIncludes: true });
    expect(scan.warnings).toContain('EXTERNAL_CONFIG_INCLUDES_NOT_FOLLOWED'); expect(scan.dependencies).toEqual([]);
    expect(JSON.stringify(scan)).not.toMatch(/secret|canary|\/private\/|https:\/\/|never-execute/); expect(await snapshot(root)).toEqual(before);
    expect(process.runProcess).toHaveBeenCalledTimes(1);
  });
  it.each(['null', '[]', '"not-an-object"', '{agents: null, env: {vars: {KEY: "hidden"}}}'])('validates config object shape without exposing malformed values: %s', async config => {
    const root = await fixture({}); await writeFile(join(root, 'openclaw.json'), config);
    const scan = await scanRuntime(undefined, root, { skills: false });
    expect(scan.configReadable).toBe(config.startsWith('{')); expect(JSON.stringify(scan)).not.toContain('hidden');
  });
  it('bounds recursive metadata projection and drops invalid reference names', () => {
    expect(configurationMetadata({ agents: { list: [{ id: '../../private', workspace: '/secret' }] }, tools: { allow: ['exec', 'Bearer secret'] }, env: { vars: { 'bad key': 'secret' } } })).toMatchObject({ agentIds: [], tools: ['exec'], environmentNames: [], workspaceReferences: [] });
    expect(() => configurationMetadata({ env: { vars: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`KEY_${index}`, 'secret'])) } })).toThrow('CONFIG_METADATA_LIMIT');
    let deep: unknown = {}; for (let count = 0; count < 22; count++) deep = { child: deep }; expect(() => configurationMetadata(deep)).toThrow('CONFIG_METADATA_LIMIT');
  });
  it('imports only the selected immutable instruction file and rejects changed source and consent', async () => {
    const root = await fixture({ one: 'Instructions one', two: 'Instructions two' }), scan = await scanRuntime(undefined, root);
    const selected = [discoveryId('SKILL', 'one')], before = await snapshot(root);
    expect(await importSelectedSkills(scan, selected, hashManifest(scan))).toEqual([{ name: 'one', content: 'Instructions one', sha256: scan.dependencies.find(node => node.name === 'one')!.contentHash }]);
    expect(await snapshot(root)).toEqual(before);
    await expect(importSelectedSkills(scan, selected, '0'.repeat(64))).rejects.toThrow('CONSENT');
    await writeFile(join(root, 'skills', 'one', 'SKILL.md'), 'Changed instructions');
    await expect(importSelectedSkills(scan, selected, hashManifest(scan))).rejects.toThrow('SKILL_CHANGED_REVIEW_REQUIRED');
  });
  it('handles native JSON5 metadata and primaryEnv as review-required, never executable approval', async () => {
    const root = await fixture({ render: "---\nmetadata: \"{openclaw: {requires: {bins: ['blender']}, primaryEnv: 'PROVIDER_KEY'}}\"\n---\nRender via Blender." });
    const scan = await scanRuntime(undefined, root), skill = scan.dependencies.find(node => node.name === 'render')!;
    expect(skill).toMatchObject({ support: 'REVIEW_REQUIRED', adaptationRequired: true });
    expect(skill.dependsOn).toEqual(expect.arrayContaining([discoveryId('EXECUTABLE', 'blender'), discoveryId('CREDENTIAL', 'PROVIDER_KEY')]));
  });
  it.each([
    { openclaw: { requires: { bins: ['bash'] } } }, { openclaw: { requires: { anyBins: ['blender', 'bash'] } } },
    { openclaw: { requires: { config: ['browser.enabled'] } } }, { openclaw: { install: [{ kind: 'node', package: 'unsafe' }] } },
    { openclaw: { os: ['darwin'] } }, { kivro: { requires: { tools: ['exec'] } } },
  ])('rejects unsupported native execution/platform/dependency closure: %j', async value => {
    const root = await fixture({ unsafe: metadata(value) }), scan = await scanRuntime(undefined, root);
    const ids = scan.dependencies.filter(node => !['AI_MODEL', 'PLUGIN'].includes(node.type)).map(node => node.id);
    expect(() => selectedDependencyClosure(scan, ids)).toThrow('UNSUPPORTED_IMPORT_DEPENDENCY');
  });
  it.each([
    '---\nmetadata: {}\nmetadata: {}\n---\ntext', metadata({ openclaw: { requires: { env: 'not-an-array' } } }),
    metadata({ openclaw: { requires: { unknown: ['ignored-binary'] } } }), metadata({ openclaw: { os: 'darwin' } }),
    '---\ncommand-dispatch: tool\ncommand-tool: exec\n---\ntext',
  ])('does not downgrade invalid metadata to a supported instruction-only skill', async content => {
    const root = await fixture({ invalid: content }), scan = await scanRuntime(undefined, root);
    expect(scan.dependencies.find(node => node.name === 'invalid')?.support).toBe('UNSUPPORTED');
  });
  it('rejects symlinked/hardlinked skill files and malformed UTF-8', async () => {
    const root = await fixture({ symbolic: 'original', hard: 'original', binary: 'original' });
    await rm(join(root, 'skills', 'symbolic', 'SKILL.md')); await symlink(join(root, 'auth-profiles.json'), join(root, 'skills', 'symbolic', 'SKILL.md'));
    await rm(join(root, 'skills', 'hard', 'SKILL.md')); await link(join(root, 'auth-profiles.json'), join(root, 'skills', 'hard', 'SKILL.md'));
    await writeFile(join(root, 'skills', 'binary', 'SKILL.md'), Buffer.from([0xc3, 0x28]));
    const scan = await scanRuntime(undefined, root);
    expect(scan.dependencies.filter(node => node.type === 'SKILL').every(node => node.support === 'UNSUPPORTED')).toBe(true);
  });
  it('rejects unknown, duplicate and cyclic selections; unknown prerequisites cannot disappear', async () => {
    const root = await fixture({ a: metadata({ kivro: { requires: { skills: ['b'] } } }), b: metadata({ kivro: { requires: { skills: ['a'] } } }) });
    const scan = await scanRuntime(undefined, root), a = discoveryId('SKILL', 'a'), b = discoveryId('SKILL', 'b');
    expect(() => selectedDependencyClosure(scan, [a, b])).toThrow('DEPENDENCY_CYCLE');
    expect(() => selectedDependencyClosure(scan, [a, a])).toThrow('INVALID_DEPENDENCY_SELECTION');
    expect(() => selectedDependencyClosure(scan, ['0'.repeat(64)])).toThrow('UNKNOWN_DEPENDENCY');
    expect(() => skillMetadata(metadata({ kivro: { requires: { tools: ['../../exec'] } } }))).toThrow();
  });
});
