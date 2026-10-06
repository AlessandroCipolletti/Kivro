import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { createConnection } from 'node:net';

const status = await readFile('/proc/self/status', 'utf8');
assert.match(status, /^CapEff:\s+0+$/m);
assert.match(status, /^NoNewPrivs:\s+1$/m);
assert.match(status, /^Seccomp:\s+2$/m);
assert.notEqual(process.getuid(), 0);
for (const directory of ['/job/input', '/job/config']) assert.equal(await readFile(`${directory}/canary.txt`, 'utf8'), 'kivro-read-only-canary');
for (const path of ['/etc/kivro-probe', '/job/input/canary.txt', '/job/config/canary.txt']) await assert.rejects(writeFile(path, 'denied'), error => ['EROFS', 'EACCES', 'EPERM'].includes(error.code));
for (const path of ['/var/run/docker.sock', '/Users', '/root/.ssh', '/home/node/.openclaw']) await assert.rejects(access(path));
for (const path of ['/job/work/probe', '/job/output/probe.txt']) await writeFile(path, 'sandbox self-test');
const routes = await readFile('/proc/net/route', 'utf8');
assert.equal(routes.trim().split('\n').length, 1);
await assert.rejects(new Promise((resolve, reject) => {
  const socket = createConnection({ host: '1.1.1.1', port: 443 });
  socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('timeout')); });
  socket.on('connect', () => { socket.destroy(); resolve(); }); socket.on('error', reject);
}));
process.stdout.write(`${JSON.stringify({ type: 'self-test', ok: true, checks: ['nonroot', 'read-only-root', 'read-only-input', 'read-only-config', 'no-host-files', 'no-docker-socket', 'network-none', 'cap-drop-all', 'no-new-privileges', 'seccomp', 'bounded-tmpfs'] })}\n`);
