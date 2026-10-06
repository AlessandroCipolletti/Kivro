import { spawn, type ChildProcess } from 'node:child_process';
import { developmentEnvironment, findDevelopmentPort, loadEnvironment, root } from './common.js';
async function main() {
  loadEnvironment();
  if (process.env.NODE_ENV === 'production') throw new Error('Use production deployment configuration, not pnpm dev.');
  const apiPort = await findDevelopmentPort(Number(process.env.API_PORT ?? 4000));
  const webPort = await findDevelopmentPort(Number(process.env.WEB_PORT ?? 3000), [apiPort]);
  const origin = `http://localhost:${webPort}`;
  const env = developmentEnvironment(apiPort, webPort);
  const { createObjectStore } = await import('../packages/storage/src/index.js');
  await createObjectStore(env).configureBrowserOrigin(origin);
  const children: ChildProcess[] = [];
  let stopping = false;
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
    const deadline = setTimeout(() => {
      for (const child of children) if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, 10000);
    deadline.unref();
    process.exitCode = code;
  };
  process.once('SIGINT', () => stop()); process.once('SIGTERM', () => stop());
  const launch = (label: string, args: string[]) => {
    const child = spawn('pnpm', args, { cwd: root, env, stdio: ['inherit', 'pipe', 'pipe'], detached: true });
    children.push(child);
    child.stdout?.on('data', data => process.stdout.write(`[${label}] ${data}`));
    child.stderr?.on('data', data => process.stderr.write(`[${label}] ${data}`));
    child.once('error', error => { console.error(`[${label}] ${error.message}`); stop(1); });
    child.once('exit', code => { if (!stopping) stop(code ?? 1); });
  };
  launch('api', ['--filter', '@kivro/api', 'dev']);
  launch('web', ['--filter', '@kivro/web', 'exec', 'next', 'dev', '--port', String(webPort), '--hostname', '127.0.0.1']);
  console.log(`\nKivro: ${origin}\nAPI: ${env.API_URL}\n`);
  if (apiPort !== Number(process.env.API_PORT ?? 4000)) console.log(`Worker terminal: API_URL=${env.API_URL} pnpm worker:dev`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
