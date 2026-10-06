import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { findDevelopmentPort, root, run } from './common.js';

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'kivro-cloud-artifacts-'));
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
  assert(/^\d+\.\d+\.\d+$/.test(version));
  const children: { process: ChildProcess; exited: Promise<void> }[] = [];
  const launch = (cwd: string, args: string[], port: number) => {
    const child = spawn(process.execPath, args, { cwd, env: { PATH: process.env.PATH, HOME: directory, NODE_PATH: '',
      NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let failure = '';
    child.stderr!.on('data', chunk => { failure = (failure + String(chunk)).slice(-4000); });
    const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
    children.push({ process: child, exited });
    return { child, failure: () => failure };
  };
  const ready = async (url: string, process: ReturnType<typeof launch>) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (process.child.exitCode !== null) throw new Error(`Artifact exited before readiness: ${process.failure()}`);
      try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (response.ok) return response; } catch { /* Startup only. */ }
      await delay(100);
    }
    throw new Error(`Artifact did not start: ${process.failure()}`);
  };
  try {
    for (const name of ['api', 'web']) await run('tar', ['-xzf', join(root, 'dist', `kivro-${name}-${version}-${process.platform}-${process.arch}.tar.gz`), '-C', directory]);
    const apiPort = await findDevelopmentPort(4100), webPort = await findDevelopmentPort(3100, [apiPort]);
    const api = launch(join(directory, 'api'), ['--import', 'tsx', '--input-type=module', '-e',
      "const {createApp}=await import('./src/app.ts');const app=await createApp({logger:false,env:{NODE_ENV:'test',PAYMENT_MODE:'fake',DATABASE_URL:'postgresql://test:test@127.0.0.1:1/test',S3_BUCKET:'test',S3_ACCESS_KEY:'test',S3_SECRET_KEY:'test'}});await app.listen({host:'127.0.0.1',port:Number(process.env.PORT)});process.once('SIGTERM',()=>{void app.close()});"], apiPort);
    const health = await ready(`http://127.0.0.1:${apiPort}/health`, api); assert.equal((await health.json()).status, 'ok');
    const config = await fetch(`http://127.0.0.1:${apiPort}/api/config`); assert(config.ok); assert((await config.json()).priceTiers.length > 0);
    const web = launch(join(directory, 'web'), ['apps/web/server.js'], webPort);
    const page = await ready(`http://127.0.0.1:${webPort}/`, web); const html = await page.text();
    assert(html.includes('Kivro') && html.includes('/_next/static/'));
    const chunks = await readdir(join(directory, 'web/apps/web/.next/static/chunks'));
    const script = chunks.find(name => name.endsWith('.js')); assert(script);
    const asset = await fetch(`http://127.0.0.1:${webPort}/_next/static/chunks/${encodeURIComponent(script)}`);
    assert(asset.ok); assert((await asset.text()).length > 0);
    console.log(JSON.stringify({ kind: 'ISOLATED_CLOUD_ARTIFACT_BOOT', passed: true, platform: process.platform, architecture: process.arch,
      isolatedHome: true, apiHealthAndConfig: true, webPageAndStaticAssets: true,
      note: 'No development-source imports or credentials; database readiness, browser workflows and production backend routing are separate gates.' }));
  } finally {
    for (const item of children) if (item.process.exitCode === null && item.process.signalCode === null) item.process.kill('SIGTERM');
    for (const item of children) {
      if (!await Promise.race([item.exited.then(() => true), delay(10000).then(() => false)])) { item.process.kill('SIGKILL'); await item.exited; }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Artifact verification failed'); process.exitCode = 1; });
