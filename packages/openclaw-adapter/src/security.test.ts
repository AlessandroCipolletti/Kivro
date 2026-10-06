import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IOContract } from '@kivro/contracts';
import { assertResultPath, collectResultDirectory, validateResultFiles } from './files.ts';
import { assertWorkerPermissions, buildOpenClawConfig } from './policy.ts';
import { DockerSandbox, sandboxArguments, SELF_TEST_LIMITS } from './docker.ts';
import * as processes from './process.ts';
import { fixtureOffer } from '../../job-protocol/src/fixtures.ts';
import { OpenClawAdapter } from './index.ts';
import { MAX_JOB_PAUSE_MS, sandboxWallTimeoutSeconds } from './timing.ts';

const contract: IOContract = { schemaVersion: 1, inputs: [], output: { type: 'FILES', description: '', required: true, files: { allowedMimeTypes: ['text/plain'], allowedExtensions: ['.txt'], maxFiles: 2, maxTotalSizeBytes: 1000 } } };
describe('filesystem boundary', () => {
  it('applies lower local output and single-file ceilings even when the seller allows more', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kivro-file-limits-'));
    const file = { path: 'answer.txt', data: Buffer.from('okay').toString('base64'), sizeBytes: 4 };
    try {
      await writeFile(join(root, 'answer.txt'), 'okay');
      vi.stubEnv('KIVRO_MAX_JOB_FILE_BYTES', '3');
      expect(() => validateResultFiles([file], contract, 100)).toThrow('OUTPUT_BYTE_LIMIT');
      await expect(collectResultDirectory(root, contract, 100)).rejects.toThrow('SPECIAL_OR_OVERSIZE_OUTPUT');
      vi.stubEnv('KIVRO_MAX_JOB_FILE_BYTES', '4'); vi.stubEnv('KIVRO_MAX_JOB_OUTPUT_BYTES', '3');
      expect(() => validateResultFiles([file], contract, 100)).toThrow('INVALID_RESULT_ENCODING');
      vi.stubEnv('KIVRO_MAX_JOB_OUTPUT_BYTES', '4');
      expect(validateResultFiles([file], contract, 100)[0]?.sizeBytes).toBe(4);
      expect(() => validateResultFiles([file], contract, 2)).toThrow();
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(['../secret', '/etc/passwd', 'a/../b', 'C:\\secret', 'a%2fb', 'a//b', 'a\u0000b', '.hidden', 'a/../../b'])('rejects dangerous path %s', path => { expect(() => assertResultPath(path)).toThrow(); });
  it('collects only regular files below the result root and rejects links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kivro-results-'));
    try {
      await mkdir(join(root, 'results')); await writeFile(join(root, 'private.txt'), 'private'); await writeFile(join(root, 'results', 'answer.txt'), 'approved');
      const result = await collectResultDirectory(join(root, 'results'), contract, 1000);
      expect(result.map(file => file.data.toString())).toEqual(['approved']);
      await symlink(join(root, 'private.txt'), join(root, 'results', 'escape.txt'));
      await expect(collectResultDirectory(join(root, 'results'), contract, 1000)).rejects.toThrow();
      await rm(join(root, 'results', 'escape.txt')); await link(join(root, 'private.txt'), join(root, 'results', 'hardlink.txt'));
      await expect(collectResultDirectory(join(root, 'results'), contract, 1000)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('does not trust MIME, base64 length, path aliases or size claims', () => {
    const file = { path: 'answer.txt', data: Buffer.from('okay').toString('base64'), sizeBytes: 4 };
    expect(validateResultFiles([file], contract, 100)[0]?.mimeType).toBe('text/plain');
    for (const values of [[{ ...file, sizeBytes: 1 }], [{ ...file, data: '!!!!' }], [file, { ...file, path: 'ANSWER.TXT' }], [{ ...file, data: Buffer.from('<script>x</script>').toString('base64'), sizeBytes: 18 }]]) expect(() => validateResultFiles(values, contract, 100)).toThrow();
  });
});
describe('mandatory sandbox policy', () => {
  it('keeps reviewed runner and OpenClaw wall ceilings finite and consistent with the pause policy', async () => {
    const { sandboxTiming } = await import(new URL('../../../security/sandbox/timing.mjs', import.meta.url).href);
    for (const timeoutSeconds of [5, 30, 120, 3600]) for (const maxPauseMs of [1000, 1501, 90000, MAX_JOB_PAUSE_MS]) {
      const wallSeconds = sandboxWallTimeoutSeconds(timeoutSeconds, maxPauseMs), offer = fixtureOffer(); offer.permissions.limits.timeoutSeconds = timeoutSeconds;
      expect(wallSeconds).toBe(timeoutSeconds + Math.ceil(maxPauseMs / 1000));
      expect(sandboxTiming({ timeoutSeconds, maxPauseMs })).toEqual({ wallSeconds, wallMs: timeoutSeconds * 1000 + maxPauseMs, bridgeMs: 65000 + maxPauseMs });
      expect(buildOpenClawConfig(offer.permissions, undefined, maxPauseMs)).toMatchObject({ agents: { defaults: { timeoutSeconds: wallSeconds } }, models: { providers: { kivro: { timeoutSeconds: wallSeconds } } } });
    }
    for (const timeoutSeconds of [0, -1, NaN, Infinity, 3601, 2.5]) {
      expect(() => sandboxWallTimeoutSeconds(timeoutSeconds, MAX_JOB_PAUSE_MS)).toThrow();
      expect(() => sandboxTiming({ timeoutSeconds, maxPauseMs: MAX_JOB_PAUSE_MS })).toThrow();
    }
    for (const maxPauseMs of [undefined, 0, 999, 1000.5, MAX_JOB_PAUSE_MS + 1, -1, Infinity]) {
      expect(() => sandboxTiming({ timeoutSeconds: 30, maxPauseMs })).toThrow();
      expect(() => buildOpenClawConfig(fixtureOffer().permissions, undefined, maxPauseMs ?? 0)).toThrow();
    }
  });
  it('validates actual CLI summaries, preserves unknown native outcomes and handles the documented zero-call omission', async () => {
    const { summarizeToolObservations: summarize } = await import(new URL('../../../security/sandbox/observations.mjs', import.meta.url).href);
    expect(summarize(undefined, [], ['read'])).toEqual({ observations: [], toolSummary: { calls: 0, failures: 0 } });
    expect(summarize({ calls: 2, failures: 0, tools: ['read', 'resource_read'] }, [{ name: 'resource_read', outcome: 'SUCCEEDED' }], ['read', 'resource_read'])).toEqual({ observations: [{ name: 'resource_read', outcome: 'SUCCEEDED' }, { name: 'read', outcome: 'OBSERVED' }], toolSummary: { calls: 2, failures: 0 } });
    for (const summary of [null, { calls: 129, failures: 0, tools: [] }, { calls: 1, failures: 2, tools: ['read'] }, { calls: 1, failures: 0, tools: ['exec'] }, { calls: 2, failures: 0, tools: ['read', 'read'] }]) expect(() => summarize(summary, [], ['read'])).toThrow();
    expect(() => summarize(undefined, [{ name: 'read', outcome: 'SUCCEEDED' }], ['read'])).toThrow('MISMATCH');
    expect(() => summarize({ calls: 1, failures: 0, tools: ['read'] }, [{ name: 'read', outcome: 'FAILED' }], ['read'])).toThrow('MISMATCH');
  });
  it('exposes only reviewed-source cache selectors in the owned plugin, with no raw query or URL field', async () => {
    const path = new URL('../../../security/sandbox/plugin/index.mjs', import.meta.url).href;
    const plugin = (await import(path)).default;
    const registerTool = vi.fn();
    plugin.register({ pluginConfig: { reviewedResearch: { searchSourceIds: ['public-search'], fetchSourceIds: ['public-docs'] } }, registerTool });
    for (const [definition] of registerTool.mock.calls.filter(([tool]) => tool.name.startsWith('research_'))) {
      expect(definition.parameters).toMatchObject({ additionalProperties: false, required: ['reviewedSourceId'], properties: { reviewedSourceId: { enum: [definition.name === 'research_search' ? 'public-search' : 'public-docs'] } } });
      expect(definition.parameters.properties).not.toHaveProperty('url'); expect(definition.parameters.properties).not.toHaveProperty('query');
    }
    expect(registerTool.mock.calls.filter(([tool]) => tool.name.startsWith('research_'))).toHaveLength(2);
    const permissions = fixtureOffer().permissions; permissions.tools = ['research.search', 'research.fetch']; permissions.network = { mode: 'RESEARCH', allowedDomains: ['example.com'] };
    const config = buildOpenClawConfig(permissions, { searchSourceIds: [], fetchSourceIds: ['public-docs'] });
    expect(config).toMatchObject({ tools: { allow: ['research_fetch'] }, plugins: { entries: { 'kivro-broker': { config: { reviewedResearch: { searchSourceIds: [], fetchSourceIds: ['public-docs'] } } } } } });
    expect(JSON.stringify(config)).not.toContain('https://example.com');
  });
  it('falls back only to the owned child PID when process-group signaling is denied', () => {
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
    const kill = vi.spyOn(process, 'kill').mockImplementationOnce(() => { throw denied; }).mockReturnValue(true);
    try {
      if (process.platform !== 'win32') { processes.killProcessTree({ pid: 12345 }, 'SIGKILL'); expect(kill.mock.calls).toEqual([[-12345, 'SIGKILL'], [12345, 'SIGKILL']]); }
      kill.mockImplementation(() => { throw denied; }); expect(() => processes.killProcessTree({ pid: 12345 })).toThrow('PROCESS_TERMINATION_DENIED');
    } finally { vi.restoreAllMocks(); }
  });
  it.each(['TIMED_OUT', 'CANCELLED', 'SIGNAL_DENIED'])('removes the container without waiting for a stuck host frame: %s', async reason => {
    const offer = fixtureOffer(), docker = new DockerSandbox(), signal = new AbortController();
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ReturnType<typeof processes.spawnControlled>;
    const spec = { imageId: `sha256:${'a'.repeat(64)}`, name: `kivro-job-${offer.attemptId}`, owner: offer.workerId, attemptId: offer.attemptId, limits: SELF_TEST_LIMITS };
    vi.spyOn(docker, 'create').mockResolvedValue(); const remove = vi.spyOn(docker, 'remove').mockResolvedValue();
    const spawn = vi.spyOn(processes, 'spawnControlled').mockReturnValue(child), kill = vi.spyOn(processes, 'killProcessTree').mockImplementation(() => {});
    if (reason === 'SIGNAL_DENIED') kill.mockImplementation(() => { throw new Error('PROCESS_TERMINATION_DENIED'); });
    const write = vi.spyOn(child.stdin, 'write');
    let frameEntered!: () => void, finishFrame!: (reply: unknown) => void;
    const entered = new Promise<void>(resolve => { frameEntered = resolve; });
    const onFrame = vi.fn(async () => { frameEntered(); return new Promise(resolve => { finishFrame = resolve; }); });
    try {
      const execution = docker.execute(spec, onFrame, signal.signal);
      const outcome = expect(execution).rejects.toThrow(reason === 'SIGNAL_DENIED' ? 'PROCESS_TERMINATION_DENIED' : reason);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      child.stdout.emit('data', '{"type":"inference"}\n'); await entered;
      signal.abort(new Error(reason)); await outcome;
      expect(remove).toHaveBeenCalledWith(spec); expect(kill).toHaveBeenCalledWith(child, 'SIGKILL');
      finishFrame({ private: 'late-result' }); await Promise.resolve(); await Promise.resolve();
      expect(write).not.toHaveBeenCalled();
    } finally { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); vi.restoreAllMocks(); }
  });
  it.each(['docker', 'adapter'])('awaits acceptance callback and cleans up without execution through %s', async boundary => {
    const offer = fixtureOffer(), docker = new DockerSandbox();
    const create = vi.spyOn(docker, 'create').mockResolvedValue();
    const remove = vi.spyOn(docker, 'remove').mockResolvedValue();
    const spawn = vi.spyOn(processes, 'spawnControlled');
    const spec = { imageId: `sha256:${'a'.repeat(64)}`, name: `kivro-job-${offer.attemptId}`, owner: offer.workerId, attemptId: offer.attemptId, limits: SELF_TEST_LIMITS };
    try {
      const onStarted = async () => { await Promise.resolve(); throw new Error('CLOUD_START_DENIED'); };
      const signal = new AbortController().signal;
      const execute = boundary === 'docker' ? docker.execute(spec, async () => {}, signal, onStarted) : new OpenClawAdapter(docker).execute(spec, offer, async () => {}, signal, onStarted);
      await expect(execute).rejects.toThrow('CLOUD_START_DENIED');
      expect(create).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledWith(spec); expect(spawn).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
  it('never exposes host paths, secrets, Docker sockets or privileged execution', () => {
    const offer = fixtureOffer(); const args = sandboxArguments({ imageId: `sha256:${'a'.repeat(64)}`, name: `kivro-job-${offer.attemptId}`, owner: offer.workerId, attemptId: offer.attemptId, limits: SELF_TEST_LIMITS });
    expect(args).toContain('--read-only'); expect(args).toContain('none'); expect(args).toContain('1000:1000'); expect(args).toContain('ALL');
    expect(args.join(' ')).not.toMatch(/docker\.sock|--privileged|--network host|--env/);
    const config = buildOpenClawConfig(offer.permissions);
    expect(JSON.stringify(config)).toContain('"mode":"all"'); expect(JSON.stringify(config)).not.toContain(process.env.HOME);
  });
  it('rejects permissions the runtime cannot enforce', () => {
    const permissions = fixtureOffer().permissions;
    for (const tool of ['exec', 'shell', 'process', 'browser', 'gateway', 'message', 'sessions_spawn']) expect(() => assertWorkerPermissions({ ...permissions, tools: [tool] })).toThrow();
    expect(() => assertWorkerPermissions({ ...permissions, limits: { ...permissions.limits, maxOutputBytes: 100000000 } })).toThrow();
    expect(() => assertWorkerPermissions({ ...permissions, network: { mode: 'NONE', allowedDomains: ['example.com'] } })).toThrow();
  });
});
