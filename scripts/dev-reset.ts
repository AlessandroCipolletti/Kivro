import { loadEnvironment, assertLocalEnvironment, run, composeArgs } from './common.js';

async function reset() {
  loadEnvironment(); assertLocalEnvironment();
  if (!process.argv.includes('--confirm-local-data-loss')) throw new Error('This deletes only Kivro local PostgreSQL, Redis and S3 volumes. Re-run pnpm dev:reset --confirm-local-data-loss to confirm.');
  console.log('Deleting kivro-local Compose containers and volumes. Personal OpenClaw is not part of this Compose project.');
  await run('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans']);
  console.log('Local service data removed. Run pnpm dev:setup to recreate the development data.');
}
reset().catch(error => { console.error(error.message); process.exitCode = 1; });
