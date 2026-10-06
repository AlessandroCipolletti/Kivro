import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertLocalEnvironment, composeArgs, loadEnvironment, root, run } from './common.js';

async function setup() {
  loadEnvironment(); assertLocalEnvironment();
  const sql = await readFile(resolve(root, 'packages/resource-broker/test/fixture.sql'), 'utf8');
  await run('docker', [...composeArgs, 'exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'kivro', '-d', 'kivro', '-f', '-'], { input: sql });
  console.log('Synthetic read-only Resource Broker database ready.');
}
setup().catch(error => { console.error(error.message); process.exitCode = 1; });
