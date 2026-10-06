#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { readFile, lstat, realpath, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { executionFileCompatibilityIssues, hashManifest } from '@kivro/contracts';
import { IMPORT_EXCHANGE_MAX_DOCUMENT_BYTES, parseImportSelectionJson } from '@kivro/contracts/import-exchange';
import { generateDeviceIdentity, sha256, stableStringify } from '@kivro/crypto';
import { DockerSandbox, scanRuntime, importSelectedSkills } from '@kivro/openclaw-adapter';
import { WorkerState } from './state.ts';
import { SecretStore } from './secrets.ts';
import { WorkerTransport, type DeviceIdentity } from './transport.ts';
import { readiness, sandboxSelfTest, testPermissions, refreshDailyAdmission, type Readiness } from './readiness.ts';
import { InferenceBroker, validateInferenceConfig } from './inference.ts';
import { LocalCapabilitySchema, approveCapability, discoveredDependencyGrants } from './capabilities.ts';
import { approveBrokerResource } from './resource-config.ts';
import { approveConnector } from './connectors.ts';
import { testCapability } from './validation.ts';
import { WorkerRuntime } from './runtime.ts';
import { approveResource } from './resources.ts';
import { importDependencySkills, storeImportedSkills, revokeImportedSkill, type ImportedSkill } from './imports.ts';
import { LaunchAgentService } from './service.ts';
import { approveResearchPlan, revokeResearchPlan } from './research-config.ts';
import { approveResearchScanner, verifyResearchScanner } from './research-scanner.ts';
import { reviewObservations } from './observations.ts';
import { deploymentStatus, refreshDeployment } from './diagnostics.ts';
import { approveJobLimits } from './job-limits.ts';
import { readSellerTestInput } from './seller-test-bundle.ts';
import { CAPABILITY_PACKAGE_MAX_BYTES, exportCapabilityPackage, prepareCapabilityPackageImport, reviewCapabilityPackageExport } from './capability-package.ts';
import { discoverLocalInference } from './local-inference.ts';
import { projectImportInventory, importSelectionRecipe } from './import-exchange.ts';

export { WorkerRuntime, WorkerState, SecretStore, WorkerTransport };
export { readiness, sandboxSelfTest } from './readiness.ts';
export { InferenceBroker, validateInferenceConfig } from './inference.ts';
export { approveCapability } from './capabilities.ts';
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const help = { commands: [
  'scan [--config-root PATH] [--inventory]', 'doctor', 'health', 'pair CODE', 'start', 'stop --all', 'pause --all', 'resume --all', 'pause VERSION_ID', 'resume VERSION_ID',
  'job pause|cancel JOB_ID', 'job resume JOB_ID [--confirm-global-pause]', 'jobs', 'logs', 'service install|uninstall|status|restart', 'sandbox approve-image|self-test', 'secret set REF --stdin',
  'inference configure --file CONFIG --approve HASH', 'inference test', 'inference discover [--config-root PATH]', 'import --file PLAN [--config-root PATH] [--approve REVIEW_HASH]',
  'limits status', 'limits configure --file CONFIG [--approve HASH]',
  'import --ids ID,ID --approve SCAN_HASH (instruction-only legacy import)', 'import list', 'import revoke NAME',
  'import selection LOCAL_APPROVED_VERSION_ID --file RECIPE [--config-root PATH] [--approve REVIEW_HASH]',
  'resource approve|configure --file CONFIG --approve HASH', 'connector configure --file CONFIG --approve HASH', 'capability approve --file MANIFEST --approve HASH',
  'research approve --file PLAN [--approve HASH]', 'research revoke VERSION_ID',
  'research scanner-configure --file CONFIG [--approve HASH]', 'research scanner-test',
  'capability test VERSION_ID --file INPUT', 'capability observations VERSION_ID [--approve HASH]', 'capability list', 'security clear --acknowledge', 'version',
  'capability package-export VERSION_ID --price-tier TIER_ID [--publication-evidence FILE] [--approve HASH]',
  'capability package-import-preview NEW_VERSION_ID --file PACKAGE',
], privacy: 'Personal OpenClaw discovery is read-only. Personal credentials are never imported. Jobs require a verified Docker sandbox and dedicated inference. Service installation is explicit opt-in; it never copies .env keys.', configuration: 'docs/OPENCLAW_COMPATIBILITY.md' };
async function stdinSecret(): Promise<string> { if (process.stdin.isTTY) throw new Error('SECRET_MUST_USE_STDIN'); let value = ''; for await (const chunk of process.stdin) { value += chunk; if (value.length > 16384) throw new Error('SECRET_TOO_LONG'); } return value.trim(); }
async function jsonFile(path?: string): Promise<unknown> { if (!path) throw new Error('FILE_REQUIRED'); const value = await readFile(path); if (value.length > 2 * 1024 ** 2) throw new Error('CONFIG_FILE_TOO_LARGE'); return JSON.parse(value.toString()); }
async function localArtifactFile(rawPath: string | undefined, maxBytes: number, kind: 'CAPABILITY_PACKAGE' | 'IMPORT_EXCHANGE'): Promise<Buffer> {
  if (!rawPath) throw new Error('FILE_REQUIRED');
  const path = resolve(rawPath), stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()) || await realpath(path) !== path) throw new Error(`UNSAFE_${kind}_FILE`);
  if (stat.size > maxBytes) throw new Error(`${kind}_TOO_LARGE`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size || before.mtimeMs !== stat.mtimeMs) throw new Error(`${kind}_FILE_CHANGED`);
    const data = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < data.length) {
      const chunk = await handle.read(data, offset, data.length - offset, offset);
      if (!chunk.bytesRead) break; offset += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1) throw new Error(`${kind}_FILE_CHANGED`);
    return data.subarray(0, offset);
  } finally { await handle.close(); }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs({ args, allowPositionals: true, options: { all: { type: 'boolean' }, json: { type: 'boolean' }, file: { type: 'string' }, approve: { type: 'string' }, ids: { type: 'string' }, stdin: { type: 'boolean' }, acknowledge: { type: 'boolean' }, name: { type: 'string' }, inventory: { type: 'boolean' }, 'config-root': { type: 'string' }, 'confirm-global-pause': { type: 'boolean' }, 'price-tier': { type: 'string' }, 'publication-evidence': { type: 'string' }, help: { type: 'boolean' } } });
  const [command, subcommand, id] = parsed.positionals, options = parsed.values;
  if (!command || options.help || command === 'help') { print(help); return; }
  if (options['confirm-global-pause'] && (command !== 'job' || subcommand !== 'resume' || !id || options.all || parsed.positionals.length !== 3)) throw new Error('CONFIRM_GLOBAL_PAUSE_REQUIRES_ONE_JOB_RESUME');
  if (command === 'version') { print({ worker: '0.1.0', protocol: 1, openclaw: '2026.8.2 (0965053)' }); return; }
  if ((options['price-tier'] || options['publication-evidence']) && (command !== 'capability' || subcommand !== 'package-export')) throw new Error('PACKAGE_OPTIONS_REQUIRE_EXPORT');
  if (options.inventory && command !== 'scan') throw new Error('INVENTORY_REQUIRES_SCAN');
  if (options['config-root'] && !['scan', 'import'].includes(command) && !(command === 'inference' && subcommand === 'discover')) throw new Error('CONFIG_ROOT_ONLY_FOR_READ_ONLY_DISCOVERY');
  const configRoot = options['config-root'] ? resolve(options['config-root']) : undefined;
  if (command === 'scan') {
    const discovery = await scanRuntime(undefined, configRoot);
    if (options.inventory) print(projectImportInventory(discovery));
    else print({ discovery, approvalHash: sha256(stableStringify(discovery)), localInference: await discoverLocalInference(discovery.localInference ?? []) });
    return;
  }
  if (command === 'inference' && subcommand === 'discover') {
    if (parsed.positionals.length !== 2 || options.approve || options.file) throw new Error('INVALID_INFERENCE_DISCOVERY_COMMAND');
    const discovery = await scanRuntime(undefined, configRoot, { skills: false });
    print({ localInference: await discoverLocalInference(discovery.localInference ?? []) }); return;
  }
  const root = resolve(process.env.KIVRO_WORKER_HOME ?? join(homedir(), '.kivro', 'worker'));
  let state: WorkerState;
  try { state = new WorkerState(root); }
  catch (error) {
    if (command !== 'doctor') throw error;
    print({ ready: false, sandboxReady: false, openclawVersion: null, checks: [{ id: 'workerDatabase', status: 'FAIL', code: 'WORKER_DATABASE_UNAVAILABLE', action: 'Check private Worker home ownership, database integrity and writable storage. Never delete state as an automatic repair.' }], checkedAt: new Date().toISOString() }); process.exitCode = 1; return;
  }
  const secrets = new SecretStore(state), docker = new DockerSandbox();
  const development = process.env.KIVRO_ENV === 'development' && process.env.NODE_ENV !== 'production';
  const image = process.env.KIVRO_SANDBOX_IMAGE ?? 'kivro-sandbox:2026.8.2';
  try {
    if (command === 'limits') {
      if (id || parsed.positionals.length !== 2) throw new Error('INVALID_LIMITS_COMMAND');
      if (subcommand === 'status') { print(state.dailyJobs()); return; }
      if (subcommand === 'configure') { print(approveJobLimits(state, await jsonFile(options.file), options.approve)); return; }
      throw new Error('UNKNOWN_LIMITS_COMMAND');
    }
    if (command === 'service') {
      if (!['install', 'uninstall', 'status', 'restart'].includes(subcommand ?? '')) throw new Error('UNKNOWN_SERVICE_COMMAND');
      const service = new LaunchAgentService(state);
      print(await service[subcommand as 'install' | 'uninstall' | 'status' | 'restart']()); return;
    }
    if (command === 'start') {
      if (!state.get('identity') && development && process.env.DEV_AUTH_ENABLED === 'true') {
        const apiUrl = process.env.API_URL ?? '';
        const url = new URL(apiUrl);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('DEMO_PAIRING_REQUIRES_LOOPBACK');
        const codeFile = resolve('.kivro/demo-pairing.json'), stat = await lstat(codeFile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()) || await realpath(codeFile) !== codeFile || (stat.mode & 0o077) || stat.size > 4096) throw new Error('UNSAFE_DEMO_PAIRING_FILE');
        const pairing = JSON.parse(await readFile(codeFile, 'utf8'));
        if (pairing.apiUrl !== apiUrl || typeof pairing.code !== 'string' || Date.parse(pairing.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(pairing.expiresAt))) throw new Error('DEMO_PAIRING_EXPIRED_OR_MISMATCHED');
        const keys = generateDeviceIdentity(); await secrets.put('device-identity', keys.privateKey);
        const response = await new WorkerTransport(apiUrl, undefined, undefined, true).pair(pairing.code, keys.publicKey, 'Kivro Local Demo Worker');
        state.set('identity', { ...response, publicKey: keys.publicKey, apiUrl }); state.audit('DEVELOPMENT_DEVICE_PAIRED', 'LOCAL');
      }
      await new WorkerRuntime(state, secrets, image, development, status => print({ event: 'WORKER_STATUS', ...status })).start(); return;
    }
    if (command === 'doctor') { const report = await readiness(state, secrets, docker, image, true, development); print(report); if (!report.ready) process.exitCode = 1; return; }
    if (command === 'health') {
      const cached = state.get<Readiness>('health') ?? { ready: false, sandboxReady: false, openclawVersion: null, checks: [], checkedAt: new Date().toISOString() };
      print({ ...refreshDailyAdmission(cached, state), cloud: deploymentStatus(state), paused: state.paused(), lastHeartbeat: state.get('lastHeartbeat') ?? null, jobs: state.activeAttempts() }); return;
    }
    if (command === 'pair') {
      if (state.get('identity')) throw new Error('ALREADY_PAIRED_REVOKE_BEFORE_REPAIR');
      if (!subcommand) throw new Error('PAIRING_CODE_REQUIRED');
      let keys = state.get<{ publicKey: string }>('pendingIdentity');
      if (!keys) { const generated = generateDeviceIdentity(); await secrets.put('device-identity', generated.privateKey); keys = { publicKey: generated.publicKey }; state.set('pendingIdentity', keys); }
      const apiUrl = process.env.API_URL ?? 'https://api.kivro.com';
      const transport = new WorkerTransport(apiUrl, undefined, undefined, development);
      const result = await transport.pair(subcommand, keys.publicKey, options.name ?? 'Kivro Worker');
      state.set('identity', { ...result, publicKey: keys.publicKey, apiUrl } satisfies DeviceIdentity); state.delete('pendingIdentity'); state.audit('DEVICE_PAIRED', 'LOCAL');
      await refreshDeployment(state, secrets, development).catch(() => { /* Pairing succeeded; readiness remains separate and fail closed. */ });
      print({ workerId: result.workerId, paused: state.paused(), cloud: deploymentStatus(state), next: 'Configure dedicated inference, approve the sandbox image and capability, then resume.' }); return;
    }
    if (command === 'sandbox') {
      const imageId = await docker.imageId(image);
      if (subcommand === 'approve-image') { await sandboxSelfTest(state, docker, imageId); state.set('approvedImageId', imageId); state.audit('IMAGE_APPROVED', 'LOCAL'); print({ imageId, approved: true }); return; }
      if (subcommand === 'self-test') { if (state.get('approvedImageId') !== imageId) throw new Error('IMAGE_APPROVAL_REQUIRED'); await sandboxSelfTest(state, docker, imageId); print({ imageId, passed: true }); return; }
      throw new Error('UNKNOWN_SANDBOX_COMMAND');
    }
    if (command === 'secret' && subcommand === 'set') { if (!id || !options.stdin) throw new Error('USE_SECRET_SET_REF_STDIN'); await secrets.put(id, await stdinSecret()); state.delete('inferenceProof'); state.audit('DEDICATED_SECRET_SET', 'LOCAL'); print({ credentialRef: id, configured: true }); return; }
    if (command === 'inference' && subcommand === 'configure') {
      const config = validateInferenceConfig(await jsonFile(options.file)), approvalHash = hashManifest(config);
      if (options.approve !== approvalHash) { print({ config, approvalHash, approved: false, consent: 'Dedicated seller inference. Seller pays provider costs. Review endpoint, model, pricing and budgets, then repeat with --approve HASH.' }); return; }
      state.set('inference', config); state.delete('inferenceProof'); state.audit('INFERENCE_PERMISSION_CONSENT', 'LOCAL'); print({ configured: true, next: 'inference test' }); return;
    }
    if (command === 'inference' && subcommand === 'test') {
      const config = validateInferenceConfig(state.get('inference'));
      const permissions = testPermissions(config.model, config.credentialRef, config.provider);
      const broker = new InferenceBroker(config, await secrets.get(config.credentialRef), permissions, state, randomUUID());
      try {
        await broker.request({ model: config.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8 });
        state.set('inferenceProof', { hash: hashManifest(config), testedAt: Date.now() }); state.audit('INFERENCE_TEST_PASSED', 'LOCAL');
        print({ ready: true, model: config.model, usage: broker.usage() });
      } finally { broker.cancel(); }
      return;
    }
    if (command === 'import') {
      if (subcommand === 'revoke') { if (!id) throw new Error('IMPORTED_SKILL_NAME_REQUIRED'); print({ revoked: id, revalidationRequired: revokeImportedSkill(state, id) }); return; }
      if (subcommand === 'list') { print((state.get<ImportedSkill[]>('importedSkills') ?? []).map(({ name, sha256, sourceHash, importHash, dependencies }) => ({ name, sha256, sourceHash, importHash, dependencies }))); return; }
      if (subcommand === 'selection') {
        if (!id || parsed.positionals.length !== 3) throw new Error('VERSION_ID_REQUIRED');
        if (options.ids) throw new Error('IMPORT_SELECTION_OR_LEGACY_IDS_NOT_BOTH');
        const bytes = await localArtifactFile(options.file, IMPORT_EXCHANGE_MAX_DOCUMENT_BYTES, 'IMPORT_EXCHANGE');
        let document: string;
        try { document = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('INVALID_IMPORT_EXCHANGE_JSON'); }
        const recipe = parseImportSelectionJson(document), discovery = await scanRuntime(undefined, configRoot);
        print(await importSelectionRecipe(state, secrets, discovery, id, recipe, options.approve)); return;
      }
      const discovery = await scanRuntime(undefined, configRoot), approvalHash = sha256(stableStringify(discovery));
      if (options.file) { if (options.ids) throw new Error('IMPORT_PLAN_OR_LEGACY_IDS_NOT_BOTH'); print(await importDependencySkills(state, secrets, discovery, await jsonFile(options.file), options.approve)); return; }
      if (!options.approve) { print({ discovery, approvalHash }); return; }
      const selected = options.ids?.split(',').filter(Boolean) ?? [];
      if (!selected.length) throw new Error('SELECT_DEPENDENCIES_EXPLICITLY');
      const skills = await importSelectedSkills(discovery, selected, options.approve);
      const affected = storeImportedSkills(state, skills, { approvalHash, selected, at: new Date().toISOString() });
      print({ imported: skills.map(skill => ({ name: skill.name, sha256: skill.sha256 })), revalidationRequired: affected }); return;
    }
    if (command === 'resource' && subcommand === 'approve') { print(await approveResource(state, await jsonFile(options.file), options.approve)); return; }
    if (command === 'resource' && subcommand === 'configure') { print(approveBrokerResource(state, await jsonFile(options.file), options.approve)); return; }
    if (command === 'connector' && subcommand === 'configure') { print(approveConnector(state, await jsonFile(options.file), options.approve)); return; }
    if (command === 'research' && subcommand === 'scanner-configure') { print(approveResearchScanner(state, await jsonFile(options.file), options.approve)); return; }
    if (command === 'research' && subcommand === 'scanner-test') { await verifyResearchScanner(state); print({ passed: true, expiresInSeconds: 3600 }); return; }
    if (command === 'research' && subcommand === 'revoke') { if (!id) throw new Error('VERSION_ID_REQUIRED'); revokeResearchPlan(state, id); print({ revoked: id, revalidationRequired: true }); return; }
    if (command === 'research' && subcommand === 'approve') {
      const identity = state.get<DeviceIdentity>('identity'); if (!identity) throw new Error('PAIRING_REQUIRED');
      const transport = new WorkerTransport(identity.apiUrl, identity, await secrets.get('device-identity'), development);
      const sellerId = (await transport.diagnostics()).sellerId; if (!sellerId) throw new Error('AUTHENTICATED_SELLER_REQUIRED');
      print(approveResearchPlan(state, await jsonFile(options.file), sellerId, options.approve)); return;
    }
    if ((command === 'capability' || command === 'workers') && subcommand === 'approve') {
      const manifest = LocalCapabilitySchema.parse(await jsonFile(options.file)), approvalHash = hashManifest(manifest);
      if (!options.approve) { print({ manifest, approvalHash, fileCompatibilityIssues: executionFileCompatibilityIssues(manifest.ioContract), dependencySuggestions: discoveredDependencyGrants(state, manifest), approved: false, consent: 'Jobs run on this computer. Approve only reviewed instructions, tools, dependencies, inference and resource limits.' }); return; }
      print(approveCapability(state, manifest, options.approve)); return;
    }
    if ((command === 'capability' || command === 'workers') && subcommand === 'list') { print((state.get<string[]>('capabilityIds') ?? []).map(version => ({ versionId: version, paused: !!state.get(`capabilityPause:${version}`), manifest: state.get(`capability:${version}`) }))); return; }
    if (command === 'capability' && subcommand === 'package-export') {
      if (!id || parsed.positionals.length !== 3) throw new Error('VERSION_ID_REQUIRED');
      if (!options['price-tier']) throw new Error('PRICE_TIER_REQUIRED');
      const evidence = options['publication-evidence'] ? { publicationEvidence: await jsonFile(options['publication-evidence']) } : {};
      if (!options.approve) { print({ ...reviewCapabilityPackageExport(state, id, options['price-tier'], evidence), approved: false }); return; }
      process.stdout.write(`${exportCapabilityPackage(state, id, options['price-tier'], options.approve, evidence)}\n`); return;
    }
    if (command === 'capability' && subcommand === 'package-import-preview') {
      if (!id || parsed.positionals.length !== 3) throw new Error('VERSION_ID_REQUIRED');
      if (options.approve) throw new Error('PACKAGE_PREVIEW_CANNOT_APPROVE');
      print(prepareCapabilityPackageImport(state, await localArtifactFile(options.file, CAPABILITY_PACKAGE_MAX_BYTES, 'CAPABILITY_PACKAGE'), id)); return;
    }
    if (command === 'capability' && subcommand === 'test') { if (!id) throw new Error('VERSION_ID_REQUIRED'); if (!options.file) throw new Error('FILE_REQUIRED'); print(await testCapability(state, secrets, id, await readSellerTestInput(options.file), image, development)); return; }
    if (command === 'capability' && subcommand === 'observations') { if (!id) throw new Error('VERSION_ID_REQUIRED'); print(reviewObservations(state, id, options.approve)); return; }
    if (command === 'pause') { if (subcommand) { if (!state.get(`capability:${subcommand}`)) throw new Error('CAPABILITY_NOT_FOUND'); state.set(`capabilityPause:${subcommand}`, true); state.audit('CAPABILITY_PAUSED', 'LOCAL', subcommand); } else state.pause('LOCAL'); print({ paused: true, runningJobsContinue: state.activeAttempts().length }); return; }
    if (command === 'resume') {
      const report = await readiness(state, secrets, docker, image, true, development); if (!report.ready) { print(report); throw new Error('RESUME_NOT_READY'); }
      if (subcommand) { if (!state.get(`capability:${subcommand}`)) throw new Error('CAPABILITY_NOT_FOUND'); if (state.paused()) throw new Error('GLOBAL_PAUSE_ACTIVE'); state.set(`capabilityPause:${subcommand}`, false); state.audit('CAPABILITY_RESUMED', 'LOCAL', subcommand); }
      else state.resume('LOCAL'); print({ paused: state.paused() }); return;
    }
    if (command === 'stop') {
      if (!options.all) throw new Error('USE_STOP_ALL_TO_CANCEL_ACTIVE_JOBS');
      state.pause('LOCAL'); state.set('stopRequested', true);
      const identity = state.get<DeviceIdentity>('identity');
      if (identity) for (const attempt of state.activeAttempts()) await docker.remove({ name: attempt.containerName, owner: identity.workerId, attemptId: attempt.attemptId });
      print({ stoppedAccepting: true, sandboxProcessesStopped: true, daemonStopRequested: true, pendingFinalization: state.activeAttempts().length }); return;
    }
    if (command === 'jobs') { print(state.attempts()); return; }
    if (command === 'job' && ['pause', 'resume', 'cancel'].includes(subcommand ?? '')) {
      if (!id || !state.attempt(id)) throw new Error('JOB_NOT_FOUND');
      const commandId = randomUUID(); state.command({ id: commandId, jobId: id, type: subcommand === 'pause' ? 'PAUSE_JOB' : subcommand === 'resume' ? 'RESUME_JOB' : 'CANCEL_JOB', ...(options['confirm-global-pause'] ? { resumeWhilePaused: true } : {}), source: 'LOCAL' });
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) { const result = state.commandResult(commandId); if (result?.status !== 'PENDING') { print(result); if (result?.status !== 'DONE') process.exitCode = 1; return; } await new Promise(resolve => setTimeout(resolve, 200)); }
      throw new Error('CONTROL_PENDING_DAEMON_UNAVAILABLE');
    }
    if (command === 'security' && subcommand === 'clear') {
      if (!options.acknowledge) throw new Error('ACKNOWLEDGEMENT_REQUIRED');
      const report = await readiness(state, secrets, docker, image, true, development);
      if (report.checks.some(check => check.status === 'FAIL' && check.id !== 'security')) throw new Error('SECURITY_PREREQUISITES_FAILED');
      state.delete('securityBlock'); state.pause('LOCAL'); state.audit('SECURITY_BLOCK_CLEARED', 'LOCAL'); print({ cleared: true, paused: true }); return;
    }
    if (command === 'logs') { print(state.db.prepare('SELECT at,event,jobId,source FROM audit ORDER BY id DESC LIMIT 100').all()); return; }
    throw new Error('UNKNOWN_COMMAND');
  } finally { state.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { const code = error instanceof Error && /^[A-Z0-9_:.-]{1,200}$/.test(error.message) ? error.message : 'WORKER_COMMAND_FAILED'; process.stderr.write(`${JSON.stringify({ error: { code, message: 'Worker operation failed. Check doctor and the documented configuration.' } })}\n`); process.exitCode = 1; });
}
