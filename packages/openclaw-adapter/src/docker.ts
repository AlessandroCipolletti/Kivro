import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import type { PermissionManifest } from '@kivro/contracts';
import { runProcess, spawnControlled, killProcessTree } from './process.ts';

export const SELF_TEST_LIMITS: PermissionManifest['limits'] = { timeoutSeconds: 120, memoryMb: 1024, cpu: 1, maxPids: 128, maxInputBytes: 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024, maxTokens: 32000 };
export const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_NAME = /^kivro-(?:job|probe)-[a-f0-9-]{36}$/;
export type SandboxSpec = { name: string; imageId: string; owner: string; attemptId: string; limits: PermissionManifest['limits']; inputDir?: string; configDir?: string; mode?: string };

export function sandboxArguments(spec: SandboxSpec): string[] {
  if (!CONTAINER_NAME.test(spec.name) || !IMAGE_ID.test(spec.imageId) || !/^[a-f0-9-]{36}$/.test(spec.attemptId) || !/^[a-zA-Z0-9-]{1,64}$/.test(spec.owner)) throw new Error('INVALID_SANDBOX_IDENTITY');
  const { limits } = spec;
  const args = ['create', '--interactive', '--name', spec.name, '--label', `io.kivro.owner=${spec.owner}`, '--label', `io.kivro.attempt=${spec.attemptId}`,
    '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--init',
    '--pids-limit', String(limits.maxPids), '--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb}m`, '--cpus', String(limits.cpu),
    '--ulimit', 'nofile=1024:1024', '--ulimit', 'core=0:0', '--log-driver', 'none', '--restart', 'no',
    '--tmpfs', '/job/work:rw,nosuid,nodev,size=268435456,uid=1000,gid=1000,mode=0700',
    '--tmpfs', `/job/output:rw,nosuid,nodev,noexec,size=${limits.maxOutputBytes},uid=1000,gid=1000,mode=0700`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16777216,uid=1000,gid=1000,mode=0700'];
  for (const [source, target] of [[spec.inputDir, '/job/input'], [spec.configDir, '/job/config']] as const) {
    if (!source) continue;
    if (!source.startsWith('/') || /[,\r\n]/.test(source)) throw new Error('INVALID_MOUNT_SOURCE');
    args.push('--mount', `type=bind,src=${source},dst=${target},readonly,bind-propagation=rprivate`);
  }
  args.push(spec.imageId);
  if (spec.mode) { if (!['self-test', 'ssh-test', 'config-test', 'media-test'].includes(spec.mode)) throw new Error('INVALID_PROBE'); args.push(spec.mode); }
  return args;
}

export function assertSandboxInspection(raw: unknown, spec: SandboxSpec): void {
  const value = z.object({
    Image: z.string(), Config: z.object({ User: z.string(), Labels: z.record(z.string()).nullable(), Entrypoint: z.array(z.string()).nullable() }),
    HostConfig: z.object({ NetworkMode: z.string(), ReadonlyRootfs: z.boolean(), Privileged: z.boolean(), CapDrop: z.array(z.string()).nullable(), CapAdd: z.array(z.string()).nullable(), SecurityOpt: z.array(z.string()).nullable(), Memory: z.number(), MemorySwap: z.number(), NanoCpus: z.number(), PidsLimit: z.number(), PidMode: z.string(), IpcMode: z.string(), Devices: z.array(z.unknown()).nullable(), PortBindings: z.record(z.unknown()).nullable(), Tmpfs: z.record(z.string()) }),
    Mounts: z.array(z.object({ Type: z.string(), Source: z.string().optional(), Destination: z.string(), RW: z.boolean() })),
  }).parse(raw);
  const h = value.HostConfig;
  if (value.Image !== spec.imageId || value.Config.User !== '1000:1000' || value.Config.Labels?.['io.kivro.owner'] !== spec.owner || value.Config.Labels?.['io.kivro.attempt'] !== spec.attemptId) throw new Error('SANDBOX_IDENTITY_MISMATCH');
  if (JSON.stringify(value.Config.Entrypoint) !== JSON.stringify(['node', '/opt/kivro/runner.mjs'])) throw new Error('SANDBOX_ENTRYPOINT_MISMATCH');
  if (h.NetworkMode !== 'none' || !h.ReadonlyRootfs || h.Privileged || !h.CapDrop?.includes('ALL') || h.CapAdd?.length || !h.SecurityOpt?.some(option => /^no-new-privileges(?::true)?$/.test(option)) || h.SecurityOpt.some(option => /unconfined/.test(option))) throw new Error('SANDBOX_SECURITY_MISMATCH');
  if (h.Memory !== spec.limits.memoryMb * 1024 ** 2 || h.MemorySwap !== h.Memory || h.NanoCpus !== spec.limits.cpu * 1e9 || h.PidsLimit !== spec.limits.maxPids || h.PidMode || h.IpcMode === 'host' || h.Devices?.length || Object.keys(h.PortBindings ?? {}).length) throw new Error('SANDBOX_RESOURCE_MISMATCH');
  const expected = new Map<string, string>();
  if (spec.inputDir) expected.set('/job/input', spec.inputDir);
  if (spec.configDir) expected.set('/job/config', spec.configDir);
  const mounts = value.Mounts.filter(mount => mount.Type !== 'tmpfs');
  if (mounts.length !== expected.size || mounts.some(mount => mount.Type !== 'bind' || mount.RW || expected.get(mount.Destination) !== mount.Source)) throw new Error('SANDBOX_MOUNT_MISMATCH');
  if (Object.keys(h.Tmpfs).sort().join(',') !== '/job/output,/job/work,/tmp' || Object.values(h.Tmpfs).some(options => !options.includes('size=') || !options.includes('nodev') || !options.includes('nosuid'))) throw new Error('SANDBOX_TMPFS_MISMATCH');
}

export class DockerSandbox {
  private readonly removals = new Map<string, Promise<void>>();
  constructor(readonly binary = 'docker') {}
  async call(args: string[], timeoutMs = 20_000) {
    const result = await runProcess(this.binary, args, { timeoutMs, maxBytes: 2 * 1024 * 1024 });
    if (result.code !== 0) throw new Error(`DOCKER_${args[0]?.toUpperCase()}_FAILED`);
    return result.stdout;
  }
  async imageId(image: string): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/.test(image)) throw new Error('INVALID_IMAGE_REFERENCE');
    const id = (await this.call(['image', 'inspect', '--format', '{{.Id}}', image])).trim();
    if (!IMAGE_ID.test(id)) throw new Error('INVALID_IMAGE_ID'); return id;
  }
  async available(): Promise<void> { await this.call(['info', '--format', '{{.ServerVersion}}']); }
  async create(spec: SandboxSpec): Promise<void> {
    if (spec.inputDir) spec.inputDir = await realpath(spec.inputDir);
    if (spec.configDir) spec.configDir = await realpath(spec.configDir);
    await this.call(sandboxArguments(spec));
    try { await this.inspect(spec); } catch (error) { await this.remove(spec).catch(() => {}); throw error; }
  }
  async inspect(spec: SandboxSpec): Promise<void> { const info = JSON.parse(await this.call(['inspect', spec.name])); assertSandboxInspection(info[0], spec); }
  async owned(spec: Pick<SandboxSpec, 'name' | 'owner' | 'attemptId'>): Promise<boolean> {
    if (!CONTAINER_NAME.test(spec.name)) throw new Error('INVALID_CONTAINER_NAME');
    try {
      const result = JSON.parse(await this.call(['inspect', spec.name]))[0];
      if (result.Config.Labels?.['io.kivro.owner'] !== spec.owner || result.Config.Labels?.['io.kivro.attempt'] !== spec.attemptId) throw new Error('CONTAINER_OWNERSHIP_MISMATCH');
      return true;
    } catch (error) { if ((error as Error).message === 'DOCKER_INSPECT_FAILED') return false; throw error; }
  }
  async pause(spec: SandboxSpec): Promise<void> { await this.inspect(spec); await this.call(['pause', spec.name]); const info = JSON.parse(await this.call(['inspect', spec.name]))[0]; if (!info.State.Paused) throw new Error('PAUSE_UNCONFIRMED'); }
  async resume(spec: SandboxSpec): Promise<void> { await this.inspect(spec); await this.call(['unpause', spec.name]); }
  async remove(spec: Pick<SandboxSpec, 'name' | 'owner' | 'attemptId'>): Promise<void> {
    const existing = this.removals.get(spec.name); if (existing) return existing;
    const task = (async () => {
      if (!await this.owned(spec)) return;
      await this.call(['unpause', spec.name]).catch(() => {});
      await this.call(['stop', '--time', '2', spec.name], 10_000).catch(() => {});
      try { await this.call(['rm', '--force', spec.name], 10_000); }
      catch (error) { if (await this.owned(spec)) throw error; }
    })();
    this.removals.set(spec.name, task);
    try { await task; } finally { this.removals.delete(spec.name); }
  }
  async probe(imageId: string, mode: 'self-test' | 'ssh-test' | 'config-test' | 'media-test', directories: { inputDir?: string; configDir?: string } = {}): Promise<Record<string, unknown>> {
    const attemptId = randomUUID(); const spec: SandboxSpec = { name: `kivro-probe-${attemptId}`, attemptId, owner: 'self-test', imageId, limits: SELF_TEST_LIMITS, mode, ...directories };
    await this.create(spec);
    try {
      const result = await this.call(['start', '--attach', spec.name], 90_000);
      const parsed = JSON.parse(result.trim());
      if (parsed.ok !== true || parsed.type !== mode) throw new Error('SANDBOX_SELF_TEST_FAILED');
      return parsed;
    } finally { await this.remove(spec); }
  }
  async execute(spec: SandboxSpec, onFrame: (frame: unknown) => Promise<unknown | undefined>, signal: AbortSignal, onStarted?: () => Promise<void> | void, diagnostics?: (chunk: string) => void): Promise<void> {
    await this.create(spec);
    if (signal.aborted) { await this.remove(spec); throw new Error('CANCELLED'); }
    try { await onStarted?.(); if (signal.aborted) throw new Error('CANCELLED'); }
    catch (error) { await this.remove(spec); throw error; }
    const child = spawnControlled(this.binary, ['start', '--attach', '--interactive', spec.name]);
    let chain = Promise.resolve(), buffer = '', bytes = 0, failure: Error | undefined;
    let rejectAborted!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
    // Attach the rejection handler before any stdout/abort event can fire.
    void aborted.catch(() => {});
    const abort = () => {
      failure ??= new Error(signal.reason instanceof Error && signal.reason.message === 'TIMED_OUT' ? 'TIMED_OUT' : 'CANCELLED');
      rejectAborted(failure);
      // EventEmitter/AbortSignal callbacks must never throw: a denied signal
      // must still reach the owned-container cleanup in finally.
      try { killProcessTree(child, 'SIGKILL'); } catch { /* remove() is authoritative for sandbox descendants. */ }
      void this.remove(spec).catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', () => {}); child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 32 * 1024 ** 2) abort(); else diagnostics?.(chunk.toString('utf8')); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk; bytes += Buffer.byteLength(chunk);
      if (Buffer.byteLength(buffer) > 24 * 1024 ** 2 || bytes > 64 * 1024 ** 2) { failure = new Error('SANDBOX_OUTPUT_LIMIT'); abort(); return; }
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        chain = chain.then(async () => {
          if (failure || signal.aborted) throw failure ?? new Error('CANCELLED');
          const reply = await Promise.race([onFrame(JSON.parse(line)), aborted]);
          if (reply !== undefined && !failure && !signal.aborted) child.stdin.write(`${JSON.stringify(reply)}\n`);
        }).catch(error => { failure ??= error instanceof Error ? error : new Error('INVALID_SANDBOX_FRAME'); abort(); });
      }
    });
    try {
      const code = await Promise.race([new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }), aborted]);
      await Promise.race([chain, aborted]);
      if (failure) throw failure;
      if (code !== 0) throw new Error('SANDBOX_EXIT_FAILED');
      if (buffer.trim()) throw new Error('INCOMPLETE_SANDBOX_FRAME');
    } finally { signal.removeEventListener('abort', abort); await this.remove(spec); killProcessTree(child, 'SIGKILL'); }
  }
}
