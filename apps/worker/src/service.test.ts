import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, mkdir, readFile, lstat, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProcess } from '@kivro/openclaw-adapter';
import { fixtureOffer } from '../../../packages/job-protocol/src/fixtures.ts';
import { WorkerState } from './state.ts';
import { LaunchAgentService } from './service.ts';

const cleanup: { root: string; state: WorkerState }[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const item of cleanup.splice(0)) { item.state.close(); await rm(item.root, { recursive: true, force: true }); } });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-launch-agent-'))), home = join(root, 'home'); await mkdir(home, { mode: 0o700 });
  const state = new WorkerState(join(root, 'state')); cleanup.push({ root, state });
  state.set('identity', { apiUrl: 'https://api.example.com' });
  let loaded = false;
  const run = vi.fn<typeof runProcess>(async (binary, args, options) => {
    if (binary === '/usr/bin/plutil') return runProcess(binary, args, options);
    expect(binary).toBe('/bin/launchctl');
    if (args[0] === 'print') return { code: loaded ? 0 : 113, stdout: 'secret-environment-must-not-be-returned', stderr: '' };
    if (args[0] === 'bootstrap') loaded = true;
    else if (args[0] === 'bootout') loaded = false;
    else throw new Error('Unexpected launchctl operation');
    return { code: 0, stdout: '', stderr: '' };
  });
  const checkKeychain = vi.fn(async () => {});
  const service = new LaunchAgentService(state, { home, uid: process.getuid!(), platform: 'darwin', run, checkKeychain });
  return { root, home, state, service, run, checkKeychain };
}
describe.skipIf(process.platform !== 'darwin')('opt-in macOS LaunchAgent lifecycle (launchctl mocked; real plutil)', () => {
  it('installs only by explicit method, generates a valid private plist, excludes secrets and starts paused', async () => {
    vi.stubEnv('SELLER_OPENAI_API_KEY', 'do-not-persist'); vi.stubEnv('ANTHROPIC_API_KEY', 'do-not-persist'); vi.stubEnv('NODE_OPTIONS', '--eval unsafe'); vi.stubEnv('API_URL', 'https://ignored.example');
    const { state, service, run, checkKeychain } = await fixture();
    expect(run).not.toHaveBeenCalled(); expect((await service.status()).installed).toBe(false);
    const installed = await service.install(); expect(installed).toMatchObject({ installed: true, loaded: true, paused: true }); expect(checkKeychain).toHaveBeenCalledOnce();
    const bytes = await readFile(service.path, 'utf8'); expect(bytes).not.toMatch(/do-not-persist|NODE_OPTIONS|ANTHROPIC|SELLER_OPENAI|ignored.example/);
    const parsed = await runProcess('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', service.path]); expect(parsed.code).toBe(0);
    const definition = JSON.parse(parsed.stdout); expect(definition.ProgramArguments.at(-1)).toBe('start'); expect(definition.ProgramArguments).not.toContain('--env-file');
    expect(definition).toMatchObject({ RunAtLoad: true, KeepAlive: { SuccessfulExit: false }, Umask: 63, StandardOutPath: '/dev/null', StandardErrorPath: '/dev/null' });
    expect(definition.EnvironmentVariables).not.toHaveProperty('DEV_AUTH_ENABLED'); expect((await lstat(service.path)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(installed)).not.toContain('secret-environment'); expect(state.get('launchAgent')).toBeTruthy();
  });
  it('gracefully restarts/uninstalls only its own registration while preserving local state and pause', async () => {
    const { state, service, run } = await fixture(); await service.install(); state.set('localSentinel', 'retain'); state.resume('LOCAL');
    expect((await service.restart()).paused).toBe(true);
    expect(run.mock.calls.filter(([binary, args]) => binary === '/bin/launchctl' && args[0] === 'bootout')).toHaveLength(1);
    expect(await service.uninstall()).toMatchObject({ installed: false, paused: true }); expect(state.get('localSentinel')).toBe('retain');
    await expect(lstat(service.path)).rejects.toMatchObject({ code: 'ENOENT' }); expect(state.get('launchAgent')).toBeUndefined();
    expect(run.mock.calls.some(([, args]) => args.includes('kickstart') || args.includes('-k'))).toBe(false);
  });
  it('rejects active jobs and a running foreground lease before creating launchd files', async () => {
    const { state, service, run } = await fixture(); state.acquireLease('foreground');
    await expect(service.install()).rejects.toThrow('SERVICE_STOP_FOREGROUND_WORKER_FIRST'); expect(run).not.toHaveBeenCalled(); state.releaseLease('foreground');
    await service.install(); state.resume('LOCAL'); const offer = fixtureOffer(); state.claim(offer, 'fixture-container');
    run.mockClear(); await expect(service.restart()).rejects.toThrow('SERVICE_ACTIVE_JOBS_STOP_FIRST'); await expect(service.uninstall()).rejects.toThrow('SERVICE_ACTIVE_JOBS_STOP_FIRST');
    expect(run).not.toHaveBeenCalled(); expect(state.get('launchAgent')).toBeTruthy();
  });
  it('refuses symlink directories, changed plists and duplicate installation without deleting user files', async () => {
    const { root, home, service, state } = await fixture(); await mkdir(join(home, 'Library')); const unrelated = join(root, 'unrelated'); await mkdir(unrelated);
    await symlink(unrelated, join(home, 'Library', 'LaunchAgents')); await expect(service.install()).rejects.toThrow('UNSAFE_SERVICE_DIRECTORY');
    expect(state.get('launchAgent')).toBeUndefined(); await rm(join(home, 'Library', 'LaunchAgents')); await service.install();
    await expect(service.install()).rejects.toThrow('SERVICE_ALREADY_INSTALLED');
    await writeFile(service.path, 'user-modified-plist'); await expect(service.uninstall()).rejects.toThrow('SERVICE_FILE_CHANGED');
    expect(await readFile(service.path, 'utf8')).toBe('user-modified-plist');
  });
  it('does not persist an environment master key; retains failed bootstrap registration for explicit recovery', async () => {
    const { state, service, run, home } = await fixture();
    vi.stubEnv('KIVRO_WORKER_MASTER_KEY', 'a'.repeat(64));
    const strict = new LaunchAgentService(state, { home, uid: process.getuid!(), platform: 'darwin', run });
    await expect(strict.install()).rejects.toThrow('SERVICE_REQUIRES_KEYCHAIN_NOT_ENV_MASTER_KEY'); expect(run).not.toHaveBeenCalled();
    run.mockImplementation(async (binary, args, options) => binary === '/usr/bin/plutil' ? runProcess(binary, args, options) : { code: args[0] === 'print' ? 113 : 5, stdout: '', stderr: 'sensitive launchd error' });
    await expect(service.install()).rejects.toThrow('SERVICE_BOOTSTRAP_FAILED_USE_STATUS_OR_UNINSTALL'); expect(state.get('launchAgent')).toBeTruthy(); expect(state.paused()).toBe(true);
    await service.uninstall(); expect(state.get('launchAgent')).toBeUndefined();
  });
});
