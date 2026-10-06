import { loadEnvironment, run } from './common.js';

async function main() {
  const command = process.argv[2];
  if (!command || !['migrate', 'seed', 'studio'].includes(command)) throw new Error('Expected migrate, seed, or studio');
  loadEnvironment();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing. Run pnpm dev:setup to create local configuration.');
  await run('pnpm', ['--filter', '@kivro/database', command]);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
