import { lstat, realpath, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { sha256 } from '@kivro/crypto';
import { runProcess } from '@kivro/openclaw-adapter';
import { SecretStore } from './secrets.ts';
import type { WorkerState } from './state.ts';
import type { DeviceIdentity } from './transport.ts';

type Runner = typeof runProcess;
type Options = { home: string; uid: number; platform: string; nodePath: string; entryPath: string; tsxPath: string; run: Runner; checkKeychain: () => Promise<void> };
type Registration = { label: string; path: string; sha256: string; installedAt: string };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export class LaunchAgentService {
  readonly options: Options;
  readonly label: string;
  readonly path: string;
  readonly target: string;
  constructor(readonly state: WorkerState, options: Partial<Options> = {}) {
    this.options = { home: homedir(), uid: process.getuid?.() ?? -1, platform: process.platform,
      nodePath: process.execPath, entryPath: fileURLToPath(new URL('./index.ts', import.meta.url)), tsxPath: createRequire(import.meta.url).resolve('tsx'),
      run: runProcess, checkKeychain: async () => {
        if (process.env.KIVRO_WORKER_MASTER_KEY) throw new Error('SERVICE_REQUIRES_KEYCHAIN_NOT_ENV_MASTER_KEY');
        await new SecretStore(state).initialize();
      }, ...options };
    this.label = `io.kivro.worker.${sha256(state.root).slice(0, 20)}`;
    this.path = join(this.options.home, 'Library', 'LaunchAgents', `${this.label}.plist`);
    this.target = `gui/${this.options.uid}/${this.label}`;
  }
  private platform(): void { if (this.options.platform !== 'darwin' || this.options.uid <= 0) throw new Error('SERVICE_REQUIRES_MACOS_USER_SESSION'); }
  private idle(): void { if (this.state.activeAttempts().length) throw new Error('SERVICE_ACTIVE_JOBS_STOP_FIRST'); }
  private async launch(args: string[]) { return this.options.run('/bin/launchctl', args, { timeoutMs: 20000, maxBytes: 65536, env: { HOME: this.options.home, PATH: '/usr/bin:/bin', LANG: 'C' } }); }
  private async loaded(): Promise<boolean> {
    const result = await this.launch(['print', this.target]);
    if (result.code === 0) return true;
    if (result.code === 113 || result.code === 3) return false;
    throw new Error('SERVICE_STATUS_UNAVAILABLE');
  }
  private async safeDirectory(path: string): Promise<void> {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== resolve(path) || stat.uid !== this.options.uid || (stat.mode & 0o022)) throw new Error('UNSAFE_SERVICE_DIRECTORY');
  }
  private async executable(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new Error('SERVICE_ABSOLUTE_EXECUTABLE_REQUIRED');
    const canonical = await realpath(path), stat = await lstat(canonical);
    if (!stat.isFile() || ![0, this.options.uid].includes(stat.uid) || (stat.mode & 0o022)) throw new Error('UNSAFE_SERVICE_EXECUTABLE');
    return canonical;
  }
  private async registration(): Promise<Registration | undefined> {
    const registration = this.state.get<Registration>('launchAgent');
    if (!registration) return undefined;
    if (registration.label !== this.label || registration.path !== this.path) throw new Error('SERVICE_REGISTRATION_MISMATCH');
    const stat = await lstat(this.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== this.options.uid || (stat.mode & 0o077) || stat.size > 16384 || await realpath(this.path) !== this.path || sha256(await readFile(this.path)) !== registration.sha256) throw new Error('SERVICE_FILE_CHANGED');
    return registration;
  }
  async status() {
    this.platform();
    const registration = await this.registration(), loaded = await this.loaded();
    return { installed: !!registration, loaded, label: this.label, paused: this.state.paused(), activeJobs: this.state.activeAttempts().length,
      ...(registration ? { path: this.path, installedAt: registration.installedAt } : {}), next: registration ? 'Worker health is separate: run doctor and health.' : 'service install (explicit opt-in)' };
  }
  async definition() {
    this.platform();
    const identity = this.state.get<DeviceIdentity>('identity'); if (!identity) throw new Error('SERVICE_PAIR_FIRST');
    const node = await this.executable(this.options.nodePath), entry = await this.executable(this.options.entryPath), tsx = await this.executable(this.options.tsxPath);
    const development = process.env.KIVRO_ENV === 'development' && process.env.NODE_ENV !== 'production';
    const api = new URL(identity.apiUrl);
    if (api.protocol !== 'https:' && !(development && api.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname))) throw new Error('SERVICE_API_CONFIGURATION_INVALID');
    // Never copy the shell environment, .env files, provider keys or master key.
    const environment: Record<string, string> = { HOME: this.options.home, PATH: `${dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8', KIVRO_WORKER_HOME: this.state.root,
      KIVRO_ENV: development ? 'development' : 'production', NODE_ENV: development ? 'development' : 'production' };
    const image = process.env.KIVRO_SANDBOX_IMAGE ?? 'kivro-sandbox:2026.8.2';
    if (!/^[A-Za-z0-9][A-Za-z0-9_./:@-]{0,199}$/.test(image)) throw new Error('SERVICE_IMAGE_INVALID');
    environment.KIVRO_SANDBOX_IMAGE = image;
    if (process.env.OPENCLAW_BIN) environment.OPENCLAW_BIN = await this.executable(process.env.OPENCLAW_BIN);
    if (process.env.DOCKER_CONTEXT) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(process.env.DOCKER_CONTEXT)) throw new Error('SERVICE_DOCKER_CONTEXT_INVALID');
      environment.DOCKER_CONTEXT = process.env.DOCKER_CONTEXT;
    }
    if (process.env.DOCKER_HOST) {
      if (!process.env.DOCKER_HOST.startsWith('unix:///')) throw new Error('SERVICE_LOCAL_DOCKER_SOCKET_REQUIRED');
      const path = process.env.DOCKER_HOST.slice(7), socket = await lstat(path);
      if (!socket.isSocket() || ![0, this.options.uid].includes(socket.uid) || await realpath(path) !== resolve(path)) throw new Error('SERVICE_DOCKER_SOCKET_INVALID');
      environment.DOCKER_HOST = process.env.DOCKER_HOST;
    }
    return { Label: this.label, ProgramArguments: [node, '--import', tsx, entry, 'start'], WorkingDirectory: this.state.root,
      EnvironmentVariables: environment, RunAtLoad: true, KeepAlive: { SuccessfulExit: false }, ThrottleInterval: 30, ExitTimeOut: 45, Umask: 63,
      StandardOutPath: '/dev/null', StandardErrorPath: '/dev/null', ProcessType: 'Background', LimitLoadToSessionType: 'Aqua' };
  }
  async install() {
    this.platform(); this.idle();
    if (this.state.get('launchAgent')) throw new Error('SERVICE_ALREADY_INSTALLED');
    const lease = this.state.db.prepare('SELECT heartbeat FROM lease WHERE id=1').get() as { heartbeat: number } | undefined;
    if (lease && Date.now() - lease.heartbeat < 30000) throw new Error('SERVICE_STOP_FOREGROUND_WORKER_FIRST');
    await this.options.checkKeychain();
    const definition = await this.definition();
    if (await this.loaded()) throw new Error('SERVICE_ALREADY_LOADED');
    await this.safeDirectory(this.options.home);
    for (const path of [join(this.options.home, 'Library'), dirname(this.path)]) {
      await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }); await this.safeDirectory(path);
    }
    const converted = await this.options.run('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', '-'], { input: JSON.stringify(definition), timeoutMs: 5000, maxBytes: 16384 });
    if (converted.code !== 0) throw new Error('SERVICE_PLIST_GENERATION_FAILED');
    const file = await open(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(converted.stdout); await file.sync(); } finally { await file.close(); }
    const registration: Registration = { label: this.label, path: this.path, sha256: sha256(converted.stdout), installedAt: new Date().toISOString() };
    this.state.set('launchAgent', registration); this.state.pause('LOCAL'); this.state.delete('stopRequested');
    const result = await this.launch(['bootstrap', `gui/${this.options.uid}`, this.path]);
    if (result.code !== 0) { this.state.audit('SERVICE_BOOTSTRAP_FAILED', 'LOCAL'); throw new Error('SERVICE_BOOTSTRAP_FAILED_USE_STATUS_OR_UNINSTALL'); }
    this.state.audit('SERVICE_INSTALLED', 'LOCAL'); return this.status();
  }
  private async stop(): Promise<void> {
    this.idle(); this.state.pause('LOCAL');
    if (await this.loaded()) {
      const result = await this.launch(['bootout', this.target]); if (result.code !== 0) throw new Error('SERVICE_BOOTOUT_FAILED');
      const deadline = Date.now() + 45000;
      while (await this.loaded()) { if (Date.now() >= deadline) throw new Error('SERVICE_STOP_TIMEOUT'); await sleep(200); }
    }
    const deadline = Date.now() + 35000;
    while (true) {
      const lease = this.state.db.prepare('SELECT heartbeat FROM lease WHERE id=1').get() as { heartbeat: number } | undefined;
      if (!lease || Date.now() - lease.heartbeat >= 30000) break;
      if (Date.now() >= deadline) throw new Error('SERVICE_WORKER_STILL_RUNNING'); await sleep(200);
    }
  }
  async restart() {
    this.platform(); if (!await this.registration()) throw new Error('SERVICE_NOT_INSTALLED');
    await this.options.checkKeychain(); await this.stop(); await this.registration(); this.state.delete('stopRequested');
    const result = await this.launch(['bootstrap', `gui/${this.options.uid}`, this.path]); if (result.code !== 0) throw new Error('SERVICE_RESTART_FAILED');
    this.state.audit('SERVICE_RESTARTED', 'LOCAL'); return this.status();
  }
  async uninstall() {
    this.platform(); if (!await this.registration()) throw new Error('SERVICE_NOT_INSTALLED');
    await this.stop(); await this.registration(); await unlink(this.path); this.state.delete('launchAgent');
    this.state.audit('SERVICE_UNINSTALLED', 'LOCAL'); return { installed: false, paused: true, retained: 'Device identity, encrypted secrets, consent, job state and audit history.' };
  }
}
