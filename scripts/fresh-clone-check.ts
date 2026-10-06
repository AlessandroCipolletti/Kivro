import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { root, run } from './common.js';
import { PrismaClient } from '../packages/database/src/index.js';
import { createObjectStore } from '../packages/storage/src/index.js';

// A clean source copy and new database schema; never clone local credentials,
// Worker identities, build output, or the user's financial records.
async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== '--run' || args.length > 2 || args[1] && args[1] !== '--with-runtime') throw new Error('Use --run [--with-runtime] for the isolated local bootstrap check');
  const withRuntime = args[1] === '--with-runtime';
  const directory = await mkdtemp(join(tmpdir(), 'kivro-fresh-source-'));
  const schema = `fresh_clone_${randomBytes(8).toString('hex')}`;
  const databaseUrl = `postgresql://kivro:kivro_local_only@127.0.0.1:55432/kivro?schema=${schema}`;
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    NODE_ENV: 'development', KIVRO_ENV: 'development', PAYMENT_MODE: 'fake', DATABASE_URL: databaseUrl,
    REDIS_URL: 'redis://127.0.0.1:56379', S3_ENDPOINT: 'http://127.0.0.1:59000', S3_BUCKET: 'kivro-development', S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'kivro_local', S3_SECRET_KEY: 'kivro_local_storage_only', S3_FORCE_PATH_STYLE: 'true' };
  let server: ChildProcess | undefined, finished: Promise<void> | undefined, bootstrapped = false;
  let evidence: Record<string, unknown> | undefined;
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  const ignored = new Set(['node_modules', '.git', '.next', '.env', '.kivro', '.local', '.agents', '.codex', 'dist', 'test-results', 'verification', 'playwright-report']);
  const stopServer = async () => {
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      const stopped = await Promise.race([finished!.then(() => true), delay(15000).then(() => false)]);
      if (!stopped) {
        await db.$disconnect();
        throw new Error(`Disposable server did not stop; preserved ${directory} and schema ${schema} for inspection`);
      }
    }
  };
  const cleanup = async () => {
    await stopServer();
    if (!/^fresh_clone_[a-f0-9]{16}$/.test(schema)) throw new Error('Invalid disposable schema');
    const storage = createObjectStore(env);
    try {
      if (withRuntime && bootstrapped) {
        const objects = [
          ...await db.asset.findMany({ select: { objectKey: true } }),
          ...await db.assetUpload.findMany({ select: { objectKey: true } }),
          ...await db.pendingObject.findMany({ select: { objectKey: true } }),
          ...await db.capabilityExampleAsset.findMany({ select: { objectKey: true } }),
        ];
        for (const key of new Set(objects.map(object => object.objectKey))) await storage.delete(key);
      }
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await storage.configureBrowserOrigin('http://localhost:3000');
      await rm(directory, { recursive: true, force: true });
    } catch {
      throw new Error(`Disposable cleanup failed; preserved remaining source/schema for review: ${directory}, ${schema}`);
    } finally { await db.$disconnect(); storage.client.destroy(); }
  };
  try {
    for (const name of await readdir(root)) {
      if (ignored.has(name) || name.startsWith('.env.') && name !== '.env.example') continue;
      await cp(join(root, name), join(directory, name), { recursive: true, filter: source => !ignored.has(basename(source)) && (!basename(source).startsWith('.env.') || basename(source) === '.env.example') });
    }
    await run('pnpm', ['install', '--frozen-lockfile'], { cwd: directory, env });
    await run('pnpm', ['dev:setup', '--reuse-services'], { cwd: directory, env });
    bootstrapped = true;
    let webUrl = '', apiUrl = '', output = '';
    server = spawn(process.execPath, ['--import', 'tsx', 'scripts/dev.ts'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout!.on('data', data => {
      const text = String(data); process.stdout.write(text); output = (output + text).slice(-20000);
      webUrl = /Kivro: (http:\/\/localhost:\d+)/.exec(output)?.[1] ?? webUrl;
      apiUrl = /API: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? apiUrl;
    });
    server.stderr!.on('data', data => process.stderr.write(data));
    let exited = false;
    finished = new Promise<void>(resolve => {
      server!.once('exit', () => { exited = true; resolve(); });
      server!.once('error', () => { exited = true; resolve(); });
    });
    const deadline = Date.now() + 120_000;
    let healthy = false;
    while (Date.now() < deadline && !exited) {
      if (webUrl && apiUrl) {
        try {
          const [page, ready, catalog] = await Promise.all([fetch(webUrl, { signal: AbortSignal.timeout(5000) }),
            fetch(`${apiUrl}/ready`, { signal: AbortSignal.timeout(5000) }), fetch(`${webUrl}/api/v1/capabilities`, { signal: AbortSignal.timeout(5000) })]);
          if (page.ok && ready.ok && catalog.ok) {
            assert((await page.text()).includes('Kivro'));
            const capabilities = await catalog.json(); assert(Array.isArray(capabilities) && capabilities.length > 0);
            healthy = true; break;
          }
        } catch { /* Wait for initial compilation and API startup only. */ }
      }
      await delay(500);
    }
    assert(healthy, 'Fresh-source startup and frontend API proxy did not become ready');
    await stopServer();
    if (withRuntime) {
      await run(process.execPath, ['--import', 'tsx', 'scripts/e2e-fixture.ts', '--run', '--browser'], { cwd: directory,
        env: { ...env, KIVRO_FIXTURE_SCHEMA: schema, KIVRO_BROWSER_CHANNEL: process.env.KIVRO_BROWSER_CHANNEL ?? 'chrome' } });
    }
    evidence = { kind: 'CLEAN_SOURCE_BOOTSTRAP', passed: true, installedFromFrozenLockfile: true,
      newDatabaseSchema: true, isolatedSecrets: true, browserWorkerRuntime: withRuntime, webUrl, apiUrl,
      note: 'Same macOS host and existing local Docker services; not a second-machine or clean Docker-volume proof.' };
  } finally {
    await cleanup();
  }
  console.log(JSON.stringify({ ...evidence, cleanupPassed: true }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Fresh-source verification failed'); process.exitCode = 1; });
