import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, readdir, lstat, open, cp, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { summarizeToolObservations } from './observations.mjs';
import { sandboxTiming } from './timing.mjs';

const MAX_FRAME = 32 * 1024 * 1024;
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const pending = new Map();
let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffered += chunk;
  if (Buffer.byteLength(buffered) > MAX_FRAME) process.exit(70);
  for (;;) {
    const end = buffered.indexOf('\n');
    if (end < 0) break;
    const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
    try {
      const reply = JSON.parse(line), waiter = pending.get(reply.id);
      if (waiter) { pending.delete(reply.id); clearTimeout(waiter.timer); waiter.resolve(reply); }
    } catch { process.exit(70); }
  }
});
process.stdin.on('end', () => { if (!process.argv[2]?.endsWith('test')) process.exit(70); });

function run(binary, args, maxBytes = 8 * 1024 * 1024, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const out = [], err = []; let size = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI_TIMEOUT')); }, timeoutMs);
    for (const [stream, chunks] of [[child.stdout, out], [child.stderr, err]]) stream.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { child.kill('SIGKILL'); reject(new Error('CLI_OUTPUT_LIMIT')); } else chunks.push(chunk);
    });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }); });
  });
}

async function prepareSsh() {
  await mkdir('/job/work/ssh', { recursive: true, mode: 0o700 });
  for (const name of ['identity', 'host']) {
    const result = await run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', `/job/work/ssh/${name}`]);
    if (result.code !== 0) throw new Error('SSH_KEYGEN_FAILED');
  }
  await writeFile('/job/work/ssh/authorized_keys', await readFile('/job/work/ssh/identity.pub'), { mode: 0o600 });
  await writeFile('/job/work/ssh/known_hosts', `[127.0.0.1]:2222 ${await readFile('/job/work/ssh/host.pub', 'utf8')}`, { mode: 0o600 });
  await writeFile('/job/work/ssh/sshd_config', [
    'Port 2222', 'ListenAddress 127.0.0.1', 'HostKey /job/work/ssh/host',
    'PidFile /job/work/ssh/sshd.pid', 'AuthorizedKeysFile /job/work/ssh/authorized_keys',
    'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no',
    'PermitRootLogin no', 'AllowUsers node', 'AllowTcpForwarding no',
    'AllowAgentForwarding no', 'X11Forwarding no', 'PermitTunnel no',
    'PermitUserEnvironment no', 'PermitUserRC no', 'StrictModes yes', 'LogLevel ERROR',
  ].join('\n'));
  const sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', '/job/work/ssh/sshd_config'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let error = ''; sshd.stderr.on('data', chunk => { error += chunk.toString().slice(0, 1024); });
  sshd.on('error', () => process.exit(70));
  const args = ['-p', '2222', '-i', '/job/work/ssh/identity', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=/job/work/ssh/known_hosts', '-o', 'BatchMode=yes', 'node@127.0.0.1', 'true'];
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await run('/usr/bin/ssh', args);
    if (result.code === 0) return sshd;
    if (sshd.exitCode !== null) throw new Error(`SSH_START_FAILED:${error}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('SSH_LOOPBACK_UNAVAILABLE');
}

async function startInferenceBridge(timing) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || !['/v1/chat/completions', '/kivro/tool'].includes(req.url)) { res.writeHead(403).end(); return; }
      let size = 0; const parts = [];
      for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('REQUEST_TOO_LARGE'); parts.push(chunk); }
      const body = JSON.parse(Buffer.concat(parts).toString());
      const isTool = req.url === '/kivro/tool';
      if (isTool) {
        const manifest = JSON.parse(await readFile('/job/input/request.json', 'utf8'));
        if (!manifest.tools.includes(body.name)) throw new Error('UNDECLARED_TOOL');
        if (['blender_render', 'ffmpeg_transcode'].includes(body.name)) {
          const asset = manifest.assets.find(asset => asset.id === body.args?.assetId);
          if (!asset || !/^[a-f0-9-]{36}$/.test(asset.id)) throw new Error('UNDECLARED_ASSET');
          let binary, args;
          if (body.name === 'blender_render') {
            if (asset.mimeType !== 'application/x-blender' || !Number.isSafeInteger(body.args.frame) || body.args.frame < 1 || body.args.frame > 10000) throw new Error('INVALID_RENDER');
            binary = '/usr/bin/blender'; args = ['--background', '--factory-startup', '--disable-autoexec', `/job/input/${asset.id}`, '--engine', 'BLENDER_WORKBENCH', '--threads', '1', '--render-format', 'PNG', '--render-output', '/job/output/render_', '--render-frame', String(body.args.frame)];
          } else {
            if (!['video/mp4', 'audio/wav'].includes(asset.mimeType)) throw new Error('INVALID_MEDIA');
            binary = '/usr/bin/ffmpeg'; args = ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', `/job/input/${asset.id}`, '-t', '120', '-threads', '1', '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', '-n', '/job/output/transcoded.mp4'];
          }
          const result = await run(binary, args, 1024 * 1024, timing.wallMs);
          if (result.code !== 0) throw new Error('MEDIA_OPERATION_FAILED');
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ files: (await readdir('/job/output')).filter(name => /\.(png|mp4)$/.test(name)) })); return;
        }
      }
      const id = randomUUID();
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('BROKER_TIMEOUT')); }, timing.bridgeMs);
        pending.set(id, { resolve, timer }); emit(isTool ? { type: 'tool', id, name: body.name, args: body.args } : { type: 'inference', id, body });
      });
      if (response.error) { res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: response.error, type: 'kivro_policy' } })); return; }
      const payload = response.body;
      if (isTool) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload)); return; }
      if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload)); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choice of payload.choices ?? []) {
        const message = choice.message;
        const delta = { role: 'assistant', content: message?.content ?? null };
        if (message?.tool_calls) delta.tool_calls = message.tool_calls.map((call, index) => ({ ...call, index }));
        res.write(`data: ${JSON.stringify({ id: payload.id, object: 'chat.completion.chunk', created: payload.created, model: payload.model, choices: [{ index: choice.index, delta, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: payload.id, object: 'chat.completion.chunk', model: payload.model, choices: [{ index: choice.index, delta: {}, finish_reason: choice.finish_reason ?? 'stop' }], usage: payload.usage })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    } catch { res.writeHead(502).end(); }
  });
  server.requestTimeout = timing.bridgeMs + 5000;
  await new Promise(resolve => server.listen(18789, '127.0.0.1', resolve));
  return server;
}

async function collect(root, prefix = '', files = []) {
  for (const name of await readdir(root)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(name) || name.includes('..')) throw new Error('UNSAFE_OUTPUT_NAME');
    const path = `${root}/${name}`, stat = await lstat(path);
    if (stat.isDirectory()) { if (prefix.split('/').length > 8) throw new Error('OUTPUT_DEPTH'); await collect(path, `${prefix}${name}/`, files); continue; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024 || files.length >= 20) throw new Error('UNSAFE_OUTPUT_FILE');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (before.ino !== stat.ino || before.dev !== stat.dev || before.nlink !== 1) throw new Error('OUTPUT_CHANGED');
      const data = await handle.readFile();
      if (data.length !== stat.size || files.reduce((sum, file) => sum + file.sizeBytes, 0) + data.length > 16 * 1024 * 1024) throw new Error('OUTPUT_TOO_LARGE');
      files.push({ path: `${prefix}${name}`, sizeBytes: data.length, data: data.toString('base64') });
    } finally { await handle.close(); }
  }
  return files;
}

async function main() {
  for (const dir of ['/job/work/home', '/job/work/state', '/job/work/seed', '/job/output']) await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.argv[2] === 'self-test') { await import('./self-test.mjs'); return; }
  if (process.argv[2] === 'media-test') { await import('./media-self-test.mjs'); return; }
  const sshd = await prepareSsh();
  if (process.argv[2] === 'ssh-test') { emit({ type: 'ssh-test', ok: true }); sshd.kill(); return; }
  const version = await run('openclaw', ['--version']);
  if (!/^OpenClaw 2026\.8\.2 \(0965053\)/m.test(version.stdout)) throw new Error('OPENCLAW_VERSION_MISMATCH');
  const validation = await run('openclaw', ['config', 'validate', '--json']);
  if (validation.code !== 0) throw new Error(`CONFIG_INVALID:${validation.stdout.slice(0, 2000)}`);
  if (process.argv[2] === 'config-test') {
    const inspected = await run('openclaw', ['plugins', 'inspect', 'kivro-broker', '--runtime', '--json']);
    if (inspected.code !== 0) throw new Error(`PLUGIN_INSPECTION_FAILED:${inspected.stdout.slice(0, 2000)}:${inspected.stderr.slice(0, 2000)}`);
    const plugin = JSON.parse(inspected.stdout);
    const expected = ['research_search', 'research_fetch', 'research_download', 'resource_read', 'resource_query', 'connector_call', 'blender_render', 'ffmpeg_transcode'];
    if (plugin.plugin?.status !== 'loaded' || expected.some(name => !plugin.plugin.toolNames?.includes(name))) throw new Error('PLUGIN_TOOLS_MISSING');
    emit({ type: 'config-test', ok: true, version: version.stdout.trim(), tools: expected, timingPolicyVersion: 2, researchDownloadPolicyVersion: 1 }); sshd.kill(); return;
  }
  const manifest = JSON.parse(await readFile('/job/input/request.json', 'utf8'));
  const trace = {};
  if (manifest.correlationId !== undefined || manifest.attemptId !== undefined) {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
    if (!uuid.test(manifest.correlationId ?? '') || !uuid.test(manifest.attemptId ?? '')) throw new Error('INVALID_EXECUTION_CORRELATION');
    trace.correlationId = manifest.correlationId; trace.attemptId = manifest.attemptId;
  }
  const timing = sandboxTiming(manifest);
  const bridge = await startInferenceBridge(timing);
  await mkdir('/job/work/seed/input', { mode: 0o700 });
  for (const name of await readdir('/job/input')) {
    if (/^[a-f0-9-]{36}$/.test(name)) await cp(`/job/input/${name}`, `/job/work/seed/input/${name}`, { errorOnExist: true, force: false });
  }
  if (manifest.researchFiles) {
    if (!Array.isArray(manifest.researchFiles) || manifest.researchFiles.length > 5 || !manifest.tools.includes('research_download')) throw new Error('INVALID_RESEARCH_FILES');
    // OpenClaw's supported SSH filesystem bridge makes workspace skills/ read-only.
    // These are data files only: generated names cannot be SKILL.md or executables.
    await mkdir('/job/work/seed/skills/kivro-public-data', { recursive: true, mode: 0o755 });
    for (const file of manifest.researchFiles) {
      if (!/^skills\/kivro-public-data\/[a-f0-9-]{36}\.(png|jpg|webp|pdf|csv)$/.test(file.path) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1 || file.sizeBytes > 500000) throw new Error('INVALID_RESEARCH_FILES');
      const source = `/job/input/research/${file.path.split('/').at(-1)}`, handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== file.sizeBytes) throw new Error('INVALID_RESEARCH_FILES');
        const data = await handle.readFile();
        if (data.length !== file.sizeBytes || createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error('RESEARCH_FILE_HASH_MISMATCH');
        await writeFile(`/job/work/seed/${file.path}`, data, { flag: 'wx', mode: 0o444 });
      } finally { await handle.close(); }
    }
  }
  try { await cp('/job/input/resources', '/job/work/seed/resources', { recursive: true, errorOnExist: true, force: false }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir('/job/work/seed/result', { mode: 0o700 });
  const args = ['agent', 'exec', '--config', '/job/config/openclaw.json', '--message-file', '/job/input/prompt.txt', '--cwd', '/job/work/seed', '--state-dir', '/job/work/state', '--thinking', 'off', '--code-mode', 'direct', '--timeout', String(timing.wallSeconds), '--json'];
  emit({ type: 'started', version: version.stdout.trim(), ...trace });
  const result = await run('openclaw', args, 16 * 1024 * 1024, timing.wallMs + 5000);
  bridge.closeAllConnections(); bridge.close(); sshd.kill();
  if (result.code !== 0) {
    // Docker logging is disabled. Production discards stderr; the explicit
    // synthetic smoke harness can inspect it, never as a delivered artifact.
    process.stderr.write(JSON.stringify(result));
    emit({ type: 'failed', code: result.code === 2 ? 'TIMED_OUT' : 'OPENCLAW_EXECUTION_FAILED' }); return;
  }
  const envelope = JSON.parse(result.stdout);
  if (envelope.ok !== true || envelope.status !== 'ok' || typeof envelope.final !== 'string') throw new Error('INVALID_OPENCLAW_RESULT');
  let observations = [];
  try {
    const handle = await open('/job/work/tool-observations.ndjson', constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32768) throw new Error('UNSAFE_TOOL_OBSERVATIONS');
      const buffer = Buffer.alloc(32769), { bytesRead } = await handle.read(buffer);
      if (bytesRead > 32768) throw new Error('INVALID_TOOL_OBSERVATIONS');
      observations = buffer.subarray(0, bytesRead).toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } finally { await handle.close(); }
    if (observations.length > 128 || observations.some(item => Object.keys(item).sort().join(',') !== 'name,outcome' || !manifest.tools.includes(item.name) || !['SUCCEEDED', 'FAILED'].includes(item.outcome))) throw new Error('INVALID_TOOL_OBSERVATIONS');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const summary = summarizeToolObservations(envelope.toolSummary, observations, manifest.tools);
  observations = summary.observations; const toolSummary = summary.toolSummary;
  const roots = await readdir('/job/work/sandboxes').catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  // OpenClaw creates its SSH workspace lazily when a filesystem tool is used.
  // No workspace means no workspace artifacts, never a fallback search path.
  if (roots.length === 0) { emit({ type: 'result', text: envelope.final, usage: envelope.usage, observations, toolSummary, files: await collect('/job/output') }); return; }
  if (roots.length !== 1 || !/^[A-Za-z0-9_-]{1,160}$/.test(roots[0])) throw new Error('AMBIGUOUS_SANDBOX_WORKSPACE');
  const resultRoot = `/job/work/sandboxes/${roots[0]}/workspace/result`;
  const resultStat = await lstat(resultRoot).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!resultStat) { emit({ type: 'result', text: envelope.final, usage: envelope.usage, observations, toolSummary, files: await collect('/job/output') }); return; }
  if (await realpath(resultRoot) !== resultRoot || !(await lstat(resultRoot)).isDirectory()) throw new Error('UNSAFE_RESULT_ROOT');
  let resultManifest;
  try {
    const manifestPath = `${resultRoot}/kivro-result.json`, stat = await lstat(manifestPath);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('UNSAFE_RESULT_MANIFEST');
    resultManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const files = (await collect(resultRoot)).filter(file => file.path !== 'kivro-result.json');
  // Only the designated result subtree crosses the runtime boundary.
  for (const file of files) {
    const segments = file.path.split('/'); segments.pop();
    if (segments.length) await mkdir(`/job/output/${segments.join('/')}`, { recursive: true, mode: 0o700 });
    await writeFile(`/job/output/${file.path}`, Buffer.from(file.data, 'base64'), { flag: 'wx', mode: 0o600 });
  }
  emit({ type: 'result', text: envelope.final, usage: envelope.usage, resultManifest, observations, toolSummary, files: await collect('/job/output') });
}
main().catch(error => { emit({ type: 'failed', code: String(error.message).slice(0, 2000) }); process.exitCode = 1; }).finally(() => { process.stdout.write('', () => process.exit()); });
