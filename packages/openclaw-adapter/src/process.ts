import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export const processEnvironment = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}), ...(process.env.DOCKER_CONTEXT ? { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT } : {}) });
export function killProcessTree(child: { pid?: number }, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid) return;
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    // Some macOS execution policies deny process-group signals even for our
    // detached child. Docker containment is reaped separately by ownership.
    if (process.platform !== 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      try { process.kill(child.pid, signal); return; }
      catch (fallback) { if ((fallback as NodeJS.ErrnoException).code === 'ESRCH') return; }
    }
    throw new Error('PROCESS_TERMINATION_DENIED');
  }
}
export function spawnControlled(binary: string, args: string[], env = processEnvironment()): ChildProcessWithoutNullStreams {
  return spawn(binary, args, { shell: false, detached: process.platform !== 'win32', env, stdio: ['pipe', 'pipe', 'pipe'] });
}
export async function runProcess(binary: string, args: string[], options: { timeoutMs?: number; maxBytes?: number; input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawnControlled(binary, args, options.env), stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, failure: Error | undefined;
    const abort = (code: string) => { failure = new Error(code); killProcessTree(child, 'SIGKILL'); };
    const timer = setTimeout(() => abort('PROCESS_TIMEOUT'), options.timeoutMs ?? 20_000);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]] as const) stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 1024 * 1024)) abort('PROCESS_OUTPUT_LIMIT'); else chunks.push(chunk);
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (failure) reject(failure); else resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), code: code ?? 1 }); });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}
