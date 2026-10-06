import { loadEnvironment, run, composeArgs } from './common.js';

async function health() {
  loadEnvironment();
  await run('docker', [...composeArgs, 'ps']);
  for (const path of ['/health', '/ready']) {
    try {
      const response = await fetch(`${process.env.API_URL}${path}`, { signal: AbortSignal.timeout(5000) });
      console.log(`${path}: ${response.status}\n${JSON.stringify(await response.json(), null, 2)}`);
      if (!response.ok) process.exitCode = 1;
    } catch { console.log(`${path}: API unavailable. Run pnpm dev.`); process.exitCode = 1; }
  }
}
health().catch(error => { console.error(error.message); process.exitCode = 1; });
