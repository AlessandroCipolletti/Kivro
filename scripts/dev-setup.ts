import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root, run, composeArgs, loadEnvironment, assertLocalEnvironment } from './common.js';

async function setup() {
  if (process.env.NODE_ENV === 'production' || process.env.KIVRO_ENV === 'production') throw new Error('Local setup is forbidden in production.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('Install Node.js 22.13 or newer.');
  await run('docker', ['info'], { quiet: true });
  await run('docker', ['compose', 'version'], { quiet: true });
  const envPath = resolve(root, '.env');
  if (!existsSync(envPath)) {
    const template = await readFile(resolve(root, '.env.example'), 'utf8');
    const { privateKey } = generateKeyPairSync('ed25519');
    const signing = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/g, '\\n');
    await writeFile(envPath, `${template.replace('replace-with-generated-local-secret', randomBytes(32).toString('hex'))}\nWORKER_SIGNING_PRIVATE_KEY="${signing}"\nWEBHOOK_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    console.log('Created private local .env configuration.');
  }
  loadEnvironment();
  assertLocalEnvironment();
  await mkdir(resolve(root, '.kivro'), { recursive: true, mode: 0o700 });
  if (process.argv.includes('--reuse-services')) console.log('Reusing existing local data services without changing their containers.');
  else {
    console.log('Starting PostgreSQL, Redis, S3 storage and local email capture...');
    await run('docker', [...composeArgs, 'up', '-d', '--wait', '--wait-timeout', '120']);
  }
  await run('pnpm', ['db:generate']);
  await run('pnpm', ['db:migrate']);
  const { createObjectStore } = await import('../packages/storage/src/index.js');
  const storage = createObjectStore(), deadline = Date.now() + 60000;
  try {
    // SeaweedFS's master health check can pass before its S3 listener is ready.
    for (;;) {
      try { await storage.ensureDevelopmentBucket(); break; }
      catch (error) { if (Date.now() >= deadline) throw error; await delay(1000); }
    }
    await storage.configureBrowserOrigin(new URL(process.env.WEB_ORIGIN ?? 'http://localhost:3000').origin);
  } finally { storage.client.destroy(); }
  console.log('S3 bucket ready.');
  await run('pnpm', ['db:seed']);
  const openclawCode = await run('openclaw', ['--version'], { allowFailure: true }).catch(() => 1);
  if (openclawCode !== 0) console.log('OpenClaw is not installed. Install the supported version documented in docs/OPENCLAW_COMPATIBILITY.md before running jobs.');
  console.log('\nKivro local data services are ready.\n\n  pnpm dev          Start web + API\n  pnpm worker:dev   Start seller Worker in a second terminal\n\nWeb: http://localhost:3000\nUse the development account selector for buyer@kivro.local and seller@kivro.local.\nPaid execution remains disabled until Worker pairing, sandbox and inference checks pass.');
}
setup().catch(error => { console.error(`Setup failed: ${error.message}`); process.exitCode = 1; });
