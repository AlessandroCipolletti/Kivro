import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const composeArgs = ['compose', '-f', resolve(root, 'infrastructure/compose.yaml')];
export async function findDevelopmentPort(start: number, excluded: number[] = []): Promise<number> {
  if (!Number.isInteger(start) || start < 1024 || start > 65516) throw new Error('Development ports must be integers between 1024 and 65516.');
  for (let port = start; port < start + 20; port++) {
    if (excluded.includes(port)) continue;
    const available = await new Promise<boolean>(resolvePort => {
      const probe = createServer();
      probe.once('error', () => resolvePort(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePort(true)));
    });
    if (available) return port;
  }
  throw new Error(`No available port between ${start} and ${start + 19}.`);
}
export function developmentEnvironment(apiPort: number, webPort: number, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  return { ...base, API_PORT: String(apiPort), PORT: String(apiPort), WEB_PORT: String(webPort), API_URL: apiUrl, API_INTERNAL_URL: apiUrl, WEB_ORIGIN: `http://localhost:${webPort}` };
}
export function loadEnvironment(): void {
  const path = resolve(root, '.env');
  if (!existsSync(path)) throw new Error('Missing .env. Run pnpm dev:setup first.');
  const values = parse(readFileSync(path));
  for (const [key, value] of Object.entries(values)) if (process.env[key] === undefined) process.env[key] = value;
}
export function assertLocalEnvironment(): void {
  if (process.env.NODE_ENV === 'production' || process.env.KIVRO_ENV !== 'development') throw new Error('This command is only available with KIVRO_ENV=development.');
  for (const [key, requiredPort] of [['DATABASE_URL', '55432'], ['REDIS_URL', '56379'], ['S3_ENDPOINT', '59000']] as const) {
    const url = new URL(process.env[key] ?? '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.port !== requiredPort) throw new Error(`${key} must target Kivro local infrastructure on port ${requiredPort}.`);
    if (key === 'DATABASE_URL' && url.pathname !== '/kivro') throw new Error('Local setup only operates on the kivro database.');
  }
  if (process.env.S3_BUCKET !== 'kivro-development') throw new Error('Local setup only operates on the kivro-development bucket.');
}
export function run(command: string, args: string[], options: { cwd?: string; quiet?: boolean; allowFailure?: boolean; env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<number> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? root, env: options.env ?? process.env,
      stdio: options.input === undefined ? (options.quiet ? 'ignore' : 'inherit') : ['pipe', options.quiet ? 'ignore' : 'inherit', options.quiet ? 'ignore' : 'inherit'], shell: false });
    if (options.input !== undefined) { child.stdin?.on('error', () => undefined); child.stdin?.end(options.input); }
    child.on('error', reject);
    child.on('exit', code => code === 0 || options.allowFailure ? resolveRun(code ?? 1) : reject(new Error(`${command} ${args.join(' ')} failed (exit ${code}).`)));
  });
}
