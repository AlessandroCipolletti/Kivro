import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { hashManifest, type JobOffer } from '@kivro/contracts';
import { readFileLimits } from '@kivro/contracts/file-limits';
import { verifyNotice, verifyAcceptedPayload, type AuthorizedJobOffer, type JobNotice, type WorkerCommand, type SignedJobNotice } from '@kivro/job-protocol';
import { OpenClawAdapter, DockerSandbox, sniffFileMime, assertWorkerPermissions, attemptDeadline, type SandboxSpec, type SelectedSkill } from '@kivro/openclaw-adapter';
import { WorkerState } from './state.ts';
import { SecretStore } from './secrets.ts';
import { WorkerTransport, TransportError, type DeviceIdentity } from './transport.ts';
import { readiness, refreshDailyAdmission, workerStatus, type Readiness } from './readiness.ts';
import { InferenceBroker, validateInferenceConfig } from './inference.ts';
import type { LocalCapability } from './capabilities.ts';
import { projectResult } from './results.ts';
import { JobToolBroker } from './tools.ts';
import { assertCapabilityConsent, checkCapabilityResources } from './capability-health.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type ActiveJob = { spec: SandboxSpec; abort: AbortController; broker: InferenceBroker; tools?: JobToolBroker; task: Promise<void>; deadlineTimer?: ReturnType<typeof setTimeout> };
export class WorkerRuntime {
  readonly docker = new DockerSandbox(); readonly adapter = new OpenClawAdapter(this.docker); readonly owner = randomUUID();
  readonly active = new Map<string, ActiveJob>();
  private transport?: WorkerTransport; private report?: Readiness; private stopping = false; private syncing?: Promise<void>; private heartbeatDue = 0; private healthDue = 0;
  private usageSync?: Promise<void>;
  private lastStatus?: string;
  constructor(readonly state: WorkerState, readonly secrets: SecretStore, readonly image: string, readonly development: boolean, readonly onStatus?: (status: ReturnType<typeof workerStatus>) => void) {}
  private reportStatus(): void {
    if (!this.report || !this.onStatus) return;
    this.report = refreshDailyAdmission(this.report, this.state);
    const status = workerStatus(this.report, this.state.paused()), key = JSON.stringify(status);
    if (key !== this.lastStatus) { this.lastStatus = key; this.onStatus(status); }
  }
  async initialize(): Promise<void> {
    const identity = this.state.get<DeviceIdentity>('identity'); if (!identity) throw new Error('PAIRING_REQUIRED');
    this.transport = new WorkerTransport(identity.apiUrl, identity, await this.secrets.get('device-identity'), this.development);
    this.state.acquireLease(this.owner);
    try { await this.recover(identity.workerId); this.report = await readiness(this.state, this.secrets, this.docker, this.image, false, this.development); }
    catch (error) { this.state.releaseLease(this.owner); throw error; }
  }
  async recover(workerId: string): Promise<void> {
    for (const attempt of this.state.activeAttempts()) {
      // A crashed attachment cannot safely reattach its ephemeral inference channel.
      // Reap the entire container; preserve IDs/outbox and never replay inference.
      await this.docker.remove({ name: attempt.containerName, owner: workerId, attemptId: attempt.attemptId });
      const resultQueued = this.state.hasPendingResult(attempt.jobId);
      if (attempt.state !== 'UPLOADING_RESULTS' || !resultQueued) this.state.transition(attempt.jobId, this.state.get(`timeout:${attempt.jobId}`) || Date.now() >= attemptDeadline(attempt) ? 'TIMED_OUT' : 'FAILED');
      await chmod(join(this.state.root, 'jobs', attempt.attemptId, 'input'), 0o755).catch(() => {});
      await chmod(join(this.state.root, 'jobs', attempt.attemptId, 'config'), 0o755).catch(() => {});
      await rm(join(this.state.root, 'jobs', attempt.attemptId), { recursive: true, force: true });
    }
    for (const attempt of this.state.attempts()) this.state.finalizeUsage(attempt.jobId);
  }
  async start(): Promise<void> {
    await this.initialize();
    this.reportStatus();
    const onSignal = () => { this.stopping = true; this.state.pause('LOCAL'); for (const active of this.active.values()) { active.broker.cancel(); active.tools?.cancel(); active.abort.abort(); } };
    const leaseTimer = setInterval(() => { try { this.state.heartbeatLease(this.owner); } catch { onSignal(); } }, 1000);
    const controls = (async () => {
      while (!this.stopping) {
        if (this.state.get('stopRequested')) { this.state.delete('stopRequested'); onSignal(); break; }
        await this.processCommands(); await sleep(100);
      }
    })().catch(() => { this.state.pause('SECURITY'); onSignal(); });
    process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
    try {
      while (!this.stopping) {
        if (Date.now() >= this.healthDue) {
          this.report = await readiness(this.state, this.secrets, this.docker, this.image, false, this.development);
          for (const id of this.state.get<string[]>('capabilityIds') ?? []) {
            const capability = this.state.get<LocalCapability>(`capability:${id}`);
            try { if (!capability) throw new Error(); await checkCapabilityResources(this.state, this.secrets, capability); this.state.set(`capabilityHealth:${id}`, { ready: true, checkedAt: Date.now() }); }
            catch { this.state.set(`capabilityHealth:${id}`, { ready: false, checkedAt: Date.now() }); }
          }
          this.healthDue = Date.now() + 30_000;
        }
        if (!this.report?.sandboxReady) for (const job of this.active.values()) { job.broker.cancel(); job.abort.abort(); }
        if (Date.now() >= this.heartbeatDue) {
          try {
            await this.flush();
            const readyIds = this.readyCapabilityIds();
            const acks = this.state.get<{ id: string; status: string }[]>('commandAcknowledgements') ?? [];
            const daily = this.report?.dailyJobs;
            const response = await this.transport!.heartbeat({ version: '0.1.0', openclawVersion: this.report?.openclawVersion ?? 'UNKNOWN', sandboxReady: !!this.report?.sandboxReady, paused: this.state.paused(), capabilities: readyIds, runningJobIds: this.state.activeAttempts().map(attempt => attempt.jobId), acknowledgedCommandIds: acks.filter(ack => ack.status === 'DONE').map(ack => ack.id), health: { ready: !!this.report?.ready, inference: this.report?.checks.find(check => check.id === 'inference')?.status === 'PASS' ? 'READY' : 'FAILED', capacity: 1, policyVersion: 1, ...(daily ? { dailyJobLimit: daily.dailyJobLimit, dailyJobsClaimed: daily.claimedJobs, dailyJobsRemaining: daily.remainingJobs } : {}) } });
            for (const command of response.commands) this.state.command({ ...command, source: 'REMOTE' });
            this.state.set('lastHeartbeat', Date.now());
            let accepted = false;
            if (!this.stopping && this.readyCapabilityIds().length && !this.state.paused() && !this.state.activeAttempts().length) {
              for (const offer of (await this.transport!.offers()).offers) { if (await this.accept(offer)) { accepted = true; break; } }
            }
            this.heartbeatDue = accepted ? 0 : Date.now() + 5000;
          } catch (error) {
            if (error instanceof TransportError && [401, 403].includes(error.status)) { this.state.pause('SECURITY'); for (const job of this.active.values()) { job.broker.cancel(); job.abort.abort(); } }
            this.state.set('connection', 'DISCONNECTED'); this.heartbeatDue = Date.now() + 5000 + Math.floor(Math.random() * 2000);
          }
        }
        void this.flushUsage().catch(() => {});
        this.reportStatus(); await sleep(200);
      }
    } finally {
      this.stopping = true; await controls;
      clearInterval(leaseTimer);
      for (const job of this.active.values()) { job.broker.cancel(); job.tools?.cancel(); job.abort.abort(); }
      await Promise.allSettled([...this.active.values()].map(job => job.task));
      await this.flush().catch(() => {}); await this.flushUsage().catch(() => {}); this.state.releaseLease(this.owner);
      process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    }
  }
  readyCapabilityIds(): string[] {
    if (this.report) this.report = refreshDailyAdmission(this.report, this.state);
    if (!this.report?.ready) return [];
    const config = this.state.get<{ model: string; credentialRef: string }>('inference');
    return (this.state.get<string[]>('capabilityIds') ?? []).filter(id => {
      const capability = this.state.get<LocalCapability>(`capability:${id}`);
      try { if (!capability) return false; assertCapabilityConsent(this.state, capability); } catch { return false; }
      const proof = this.state.get<{ manifestHash: string; imageId: string; testedAt: number; inferenceHash: string }>(`capabilityProof:${id}`);
      const health = this.state.get<{ ready: boolean; checkedAt: number }>(`capabilityHealth:${id}`);
      return capability && proof?.manifestHash === capability.manifestHash && proof.imageId === this.report?.imageId && proof.inferenceHash === hashManifest(this.state.get('inference')) && Date.now() - proof.testedAt < 24 * 3600_000 && health?.ready && Date.now() - health.checkedAt < 60_000 && !this.state.get(`capabilityPause:${id}`) && capability.permissions.inference.model === config?.model && capability.permissions.inference.credentialRef === config?.credentialRef;
    });
  }
  async flush(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      for (const item of this.state.pending().filter(item => item.kind !== 'usage')) {
        try { await this.transport!.request('POST', item.path, item.body); }
        catch (error) {
          if (!(error instanceof TransportError) || ![404, 409].includes(error.status) || !['JOB_TERMINAL', 'STALE_ATTEMPT', 'OFFER_EXPIRED', 'ACCEPTANCE_BLOCKED', 'INVALID_JOB_STATE', 'PAYMENT_NOT_RESERVED'].includes(error.code)) throw error;
          const jobId = item.path.split('/')[4]!, attempt = this.state.attempt(jobId);
          const active = this.active.get(jobId); active?.broker.cancel(); active?.tools?.cancel(); active?.abort.abort();
          if (attempt && !['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(attempt.state)) this.state.transition(jobId, 'FAILED', false);
          if (['JOB_TERMINAL', 'STALE_ATTEMPT'].includes(error.code)) this.state.acknowledgeDelivery(item, true);
          else this.state.acknowledge(item.id);
          this.state.audit('CLOUD_ATTEMPT_REJECTED', 'WORKER', jobId); continue;
        }
        if (item.kind === 'result') { const id = item.path.split('/')[4]!; this.state.transition(id, 'SUCCEEDED', false); }
        this.state.acknowledgeDelivery(item);
      }
    })();
    try { await this.syncing; } finally { this.syncing = undefined; }
  }
  async flushUsage(): Promise<void> {
    if (this.usageSync) return this.usageSync;
    const item = this.state.pending().find(item => item.kind === 'usage' && (this.state.get<{ nextAt: number }>(`usageRetry:${item.id}`)?.nextAt ?? 0) <= Date.now());
    if (!item || !this.transport) return;
    this.usageSync = (async () => {
      try { await this.transport!.request('POST', item.path, item.body, AbortSignal.timeout(5000)); this.state.acknowledgeDelivery(item); }
      catch (error) {
        if (error instanceof TransportError && (error.code === 'USAGE_RECEIPT_CONFLICT' || error.code === 'USAGE_PERMISSION_MISMATCH')) this.state.rejectUsage(item, error.code);
        else this.state.deferUsage(item);
      }
    })();
    try { await this.usageSync; } finally { this.usageSync = undefined; }
  }
  async accept(signed: SignedJobNotice): Promise<boolean> {
    const readyIds = this.readyCapabilityIds();
    if (this.stopping || !this.report?.ready || !this.report.imageId || this.state.paused() || this.state.activeAttempts().length) return false;
    const identity = this.state.get<DeviceIdentity>('identity')!;
    const capability = this.state.get<LocalCapability>(`capability:${signed.payload.capabilityVersionId}`);
    if (!capability || !readyIds.includes(capability.capabilityVersionId)) return false;
    let offer: AuthorizedJobOffer;
    try {
      const notice = verifyNotice(signed, identity.serverPublicKey, identity.workerId, capability);
      assertCapabilityConsent(this.state, capability);
      offer = { ...notice, internalInstructions: capability.internalInstructions, input: {}, assets: [] };
      assertWorkerPermissions(offer.permissions);
      const skills = this.state.get<SelectedSkill[]>(`skills:${offer.capabilityVersionId}`) ?? [];
      if (hashManifest(skills) !== capability.skillsHash) throw new Error('DEPENDENCY_HASH_MISMATCH');
      const broker = new InferenceBroker(validateInferenceConfig(this.state.get('inference')), await this.secrets.get(offer.permissions.inference.credentialRef!), offer.permissions, this.state, offer.attemptId);
      const spec: SandboxSpec = { name: `kivro-job-${offer.attemptId}`, attemptId: offer.attemptId, owner: identity.workerId, imageId: this.report.imageId, limits: offer.permissions.limits };
      this.state.claim(offer, spec.name, signed);
      this.report = refreshDailyAdmission(this.report, this.state); this.heartbeatDue = 0;
      const abort = new AbortController();
      const active: ActiveJob = { spec, abort, broker, task: Promise.resolve() };
      abort.signal.addEventListener('abort', () => { broker.cancel(); active.tools?.cancel(); }, { once: true });
      this.active.set(offer.jobId, active);
      this.armDeadline(offer.jobId, active);
      active.task = this.run(offer, active, skills, notice).finally(() => { clearTimeout(active.deadlineTimer); this.active.delete(offer.jobId); this.heartbeatDue = 0; });
      return true;
    } catch { this.state.audit('OFFER_REJECTED', 'WORKER', signed.payload.jobId); return false; }
  }
  private expire(jobId: string, active: ActiveJob): void {
    if (active.abort.signal.aborted) return;
    this.state.set(`timeout:${jobId}`, true);
    active.abort.abort(new Error('TIMED_OUT'));
  }
  private assertBeforeDeadline(jobId: string, active: ActiveJob): void {
    const attempt = this.state.attempt(jobId);
    if (!attempt || Date.now() >= attemptDeadline(attempt)) this.expire(jobId, active);
    active.abort.signal.throwIfAborted();
  }
  private armDeadline(jobId: string, active: ActiveJob): void {
    clearTimeout(active.deadlineTimer);
    const attempt = this.state.attempt(jobId);
    if (!attempt || active.abort.signal.aborted) return;
    active.deadlineTimer = setTimeout(() => this.expire(jobId, active), Math.max(0, attemptDeadline(attempt) - Date.now()));
  }
  private async run(offer: JobOffer, active: ActiveJob, skills: SelectedSkill[], notice: JobNotice): Promise<void> {
    const root = join(this.state.root, 'jobs', offer.attemptId);
    try {
      await this.flush(); // Cloud must acknowledge the active attempt before any download/inference.
      this.assertBeforeDeadline(offer.jobId, active);
      if (active.abort.signal.aborted || this.state.paused()) throw new Error('CANCELLED');
      const identity = this.state.get<DeviceIdentity>('identity')!;
      offer = verifyAcceptedPayload(await this.transport!.acceptedPayload(offer.jobId, offer.attemptId, active.abort.signal), identity.serverPublicKey, notice, offer.manifestHash);
      const platform = readFileLimits(process.env);
      const inputLimit = Math.min(platform.inputBytes, offer.permissions.limits.maxInputBytes);
      const totalInputBytes = Buffer.byteLength(JSON.stringify(offer.input)) + offer.assets.reduce((total, asset) => total + asset.sizeBytes, 0);
      if (totalInputBytes > inputLimit || offer.assets.some(asset => asset.sizeBytes > platform.workerFileBytes)) throw new Error('INPUT_LIMIT_OR_CANCELLED');
      const capability = this.state.get<LocalCapability>(`capability:${offer.capabilityVersionId}`)!;
      await mkdir(join(this.state.root, 'jobs'), { recursive: true, mode: 0o700 }); await mkdir(root, { mode: 0o700 });
      active.tools = await JobToolBroker.create(offer, this.state, this.secrets, capability.dependencies);
      if (active.abort.signal.aborted) { active.tools.cancel(); throw new Error('CANCELLED'); }
      await active.tools.preparePublicResearch(root);
      this.assertBeforeDeadline(offer.jobId, active);
      const environment = await this.adapter.buildWorkerEnvironment(root, offer, skills, active.tools.researchTools(), active.tools.downloadedFiles()); Object.assign(active.spec, environment);
      await active.tools.installResearchFiles(environment.inputDir);
      for (const asset of offer.assets) {
        if (active.abort.signal.aborted) throw new Error('INPUT_LIMIT_OR_CANCELLED');
        const path = join(environment.inputDir, asset.id);
        await this.transport!.downloadToFile(asset, path, Math.min(inputLimit, platform.workerFileBytes), active.abort.signal);
        if (await sniffFileMime(path, asset.filename, Math.min(inputLimit, platform.workerFileBytes)) !== asset.mimeType) throw new Error('INPUT_MIME_MISMATCH');
      }
      await chmod(environment.inputDir, 0o555); await chmod(environment.configDir, 0o555);
      if (active.abort.signal.aborted || this.state.paused()) throw new Error('CANCELLED');
      this.assertBeforeDeadline(offer.jobId, active);
      const result = await this.adapter.execute(active.spec, offer, body => { this.assertBeforeDeadline(offer.jobId, active); return active.broker.request(body); }, active.abort.signal, async () => {
        this.assertBeforeDeadline(offer.jobId, active);
        this.state.transition(offer.jobId, 'RUNNING'); await this.flush(); this.assertBeforeDeadline(offer.jobId, active);
      }, (name, args) => active.tools!.execute(name, args));
      this.assertBeforeDeadline(offer.jobId, active);
      this.state.transition(offer.jobId, 'UPLOADING_RESULTS', false);
      projectResult(offer, result, result.files.map(file => ({ id: randomUUID(), filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes, sha256: file.sha256 })));
      const assets = [];
      const uploadRoot = join(root, 'uploads'); await mkdir(uploadRoot, { mode: 0o700 });
      for (const file of result.files) {
        if (active.abort.signal.aborted) throw new Error('CANCELLED');
        const path = join(uploadRoot, randomUUID()); await writeFile(path, file.data, { flag: 'wx', mode: 0o400 });
        assets.push(await this.transport!.uploadFile(offer.jobId, offer.attemptId, file, path, active.abort.signal));
      }
      const validated = projectResult(offer, result, assets);
      this.assertBeforeDeadline(offer.jobId, active);
      this.state.enqueue(`/api/worker/jobs/${offer.jobId}/result`, { attemptId: offer.attemptId, output: validated }, 'result');
      // Execution/upload finished within the bound. Retrying this immutable
      // result acknowledgement cannot restart work or turn delivery into timeout.
      clearTimeout(active.deadlineTimer);
      await this.flush().catch(() => {}); // Durable result retry never repeats execution.
    } catch (error) {
      const attempt = this.state.attempt(offer.jobId);
      if (attempt && !['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(attempt.state)) this.state.transition(offer.jobId, this.state.get(`timeout:${offer.jobId}`) || (error as Error).message === 'TIMED_OUT' ? 'TIMED_OUT' : active.abort.signal.aborted ? 'CANCELLED' : 'FAILED');
      const code = this.state.get(`timeout:${offer.jobId}`) ? 'TIMED_OUT' : error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'UNCLASSIFIED_FAILURE';
      this.state.audit(`EXECUTION_STOPPED_${code}`, 'WORKER', offer.jobId);
    } finally {
      active.broker.cancel(); active.tools?.cancel(); await active.broker.pause(); await active.tools?.pause();
      this.state.finalizeUsage(offer.jobId);
      await this.docker.remove(active.spec).catch(() => { this.state.pause('SECURITY'); });
      await chmod(join(root, 'input'), 0o755).catch(() => {}); await chmod(join(root, 'config'), 0o755).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }
  async processCommands(): Promise<void> {
    for (const command of this.state.commands()) {
      try {
        if (command.type === 'PAUSE_ALL') this.state.pause(command.source === 'LOCAL' ? 'LOCAL' : 'REMOTE');
        else if (command.type === 'RESUME_ALL') {
          this.report = await readiness(this.state, this.secrets, this.docker, this.image, false, this.development);
          if (!this.report.ready) throw new Error('RESUME_NOT_READY');
          this.state.resume(command.source === 'LOCAL' ? 'LOCAL' : 'REMOTE');
        } else await this.controlJob(command);
        this.state.finishCommand(command.id);
      } catch (error) { this.state.finishCommand(command.id, /^[A-Z0-9_]+$/.test((error as Error).message) ? (error as Error).message : 'JOB_CONTROL_FAILED'); }
      const acknowledgements = this.state.get<{ id: string; status: string }[]>('commandAcknowledgements') ?? [];
      this.state.set('commandAcknowledgements', [...acknowledgements.slice(-49), { id: command.id, status: this.state.commandResult(command.id)!.status }]);
      this.heartbeatDue = 0;
    }
  }
  async controlJob(command: WorkerCommand): Promise<void> {
    if (!command.jobId) throw new Error('JOB_ID_REQUIRED');
    const attempt = this.state.attempt(command.jobId), active = this.active.get(command.jobId);
    if (!attempt) throw new Error('JOB_NOT_FOUND');
    if (command.type === 'CANCEL_JOB') { if (active) { active.broker.cancel(); active.tools?.cancel(); active.abort.abort(); await active.task; } else if (!['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(attempt.state)) throw new Error('RESULT_FINALIZATION_PENDING'); return; }
    if (command.type === 'PAUSE_JOB') {
      if (attempt.state === 'PAUSED') return;
      if (!active || attempt.state !== 'RUNNING') throw new Error('PAUSE_NOT_SUPPORTED_IN_CURRENT_STAGE');
      this.assertBeforeDeadline(attempt.jobId, active);
      this.state.transition(attempt.jobId, 'PAUSE_REQUESTED', false);
      const drain = Promise.all([active.broker.pause(), active.tools?.pause()]);
      try {
        await this.docker.pause(active.spec); await drain;
        this.assertBeforeDeadline(attempt.jobId, active);
        this.state.transition(attempt.jobId, 'PAUSED'); this.armDeadline(attempt.jobId, active);
      }
      catch (error) { active.broker.cancel(); active.abort.abort(); throw error; }
    } else if (command.type === 'RESUME_JOB') {
      if (attempt.state === 'RUNNING') return;
      const assertResumeAuthority = () => {
        if (this.state.get('securityBlock')) throw new Error('SECURITY_BLOCK');
        if (this.state.paused() && command.resumeWhilePaused !== true) throw new Error('CLEAR_GLOBAL_PAUSE_BEFORE_JOB_RESUME');
      };
      assertResumeAuthority();
      this.report = await readiness(this.state, this.secrets, this.docker, this.image, false, this.development);
      const failures = this.report.checks.filter(check => check.status === 'FAIL');
      const existingJobReady = this.report.ready || this.report.sandboxReady && failures.length > 0 && failures.every(check => check.id === 'dailyJobs' && check.code === 'DAILY_JOB_LIMIT_REACHED');
      if (!existingJobReady || !active || attempt.state !== 'PAUSED') throw new Error('RESUME_NOT_READY');
      this.assertBeforeDeadline(attempt.jobId, active);
      const capability = this.state.get<LocalCapability>(`capability:${attempt.capabilityVersionId}`);
      if (!capability || this.report.imageId !== active.spec.imageId) throw new Error('RESUME_NOT_READY');
      const accepted = this.state.get<SignedJobNotice>(`notice:${attempt.attemptId}`);
      if (!accepted || accepted.payload.manifestHash !== capability.manifestHash) throw new Error('RESUME_MANIFEST_CHANGED');
      await checkCapabilityResources(this.state, this.secrets, capability);
      assertResumeAuthority();
      this.assertBeforeDeadline(attempt.jobId, active);
      if (this.state.paused() && command.resumeWhilePaused === true) this.state.audit('JOB_RESUME_GLOBAL_PAUSE_CONFIRMED', 'WORKER', attempt.jobId);
      this.state.transition(attempt.jobId, 'RESUMING');
      try {
        await this.flush();
        this.assertBeforeDeadline(attempt.jobId, active);
        this.state.transition(attempt.jobId, 'RUNNING'); this.armDeadline(attempt.jobId, active);
        // Charge the RUNNING acknowledgement/thaw handshake as active time.
        // Buffered sandbox frames cannot reach a broker before cloud consent.
        await this.flush(); assertResumeAuthority(); this.assertBeforeDeadline(attempt.jobId, active);
        active.broker.resume(); active.tools?.resume(); await this.docker.resume(active.spec);
        this.assertBeforeDeadline(attempt.jobId, active);
      } catch (error) { active.broker.cancel(); active.tools?.cancel(); active.abort.abort(); throw error; }
    }
  }
}
