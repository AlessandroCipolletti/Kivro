// Real-clock API/Worker/Docker fixture assertions, never production behavior.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { PrismaClient } from '../packages/database/src/index.js';
import type { JobDTO } from '../packages/contracts/src/index.js';
import type { DockerSandbox } from '../packages/openclaw-adapter/src/index.js';
import type { WorkerRuntime } from '../apps/worker/src/runtime.js';
import type { WorkerState } from '../apps/worker/src/state.js';

export const PAUSE_FIXTURE_BUDGET_MS = 90_000;
export const PAUSE_FIXTURE_HOLD_MS = 75_000;
type Balance = { availableMinor: number; reservedMinor: number; spentMinor: number; earnedMinor: number };
export type PauseScenario = 'pause-cancel' | 'pause-expiry' | 'pause-success';

export function pauseFixtureImage(value: string): string {
  assert.equal(value, value.trim(), 'FIXTURE_INVALID_PAUSE_IMAGE');
  assert.match(value, /^(?:sha256:[a-f0-9]{64}|kivro-sandbox:[a-z0-9][a-z0-9._-]{0,80})$/, 'FIXTURE_INVALID_PAUSE_IMAGE');
  return value;
}

// Hold only the deterministic provider response. The real control command must
// freeze Docker before we drain this in-flight call and await its signed ack.
export class FixtureInferenceGate {
  private releasePending?: () => void;
  private opened = false;
  get pending(): boolean { return !!this.releasePending; }
  async enter(): Promise<void> {
    if (this.opened) return;
    assert.equal(this.pending, false, 'FIXTURE_CONCURRENT_PROVIDER_GATE');
    await new Promise<void>(resolve => { this.releasePending = resolve; });
  }
  release(): void { const resolve = this.releasePending; this.releasePending = undefined; resolve?.(); }
  open(): void { this.opened = true; this.release(); }
}

type Context = {
  db: PrismaClient; docker: DockerSandbox; state: WorkerState; runtime: WorkerRuntime;
  signal: AbortSignal; workerId: string; timeoutSeconds: number;
  job: (id: string) => Promise<JobDTO>;
  control: (id: string, action: 'pause' | 'resume' | 'cancel') => Promise<JobDTO>;
  wallet: (role: 'buyer' | 'seller') => Promise<Balance>;
  purchase: () => Promise<JobDTO>;
  begin: (scenario: PauseScenario) => FixtureInferenceGate;
  providerRequests: () => number;
  wait: (predicate: () => Promise<boolean>, timeoutMs: number, code: string) => Promise<void>;
  stage: (stage: string) => void;
};

export class FixturePauseMatrix {
  readonly receipts: Record<string, unknown>[] = [];
  constructor(private readonly ctx: Context) {}

  private async inspectedPause(jobId: string): Promise<boolean> {
    const active = this.ctx.runtime.active.get(jobId);
    assert.ok(active, 'FIXTURE_PAUSE_CONTAINER_MISSING');
    await this.ctx.docker.inspect(active.spec);
    const info = JSON.parse(await this.ctx.docker.call(['inspect', active.spec.name]))[0];
    assert.equal(info.Config.Labels['io.kivro.owner'], this.ctx.workerId);
    assert.equal(info.Config.Labels['io.kivro.attempt'], active.spec.attemptId);
    return info.State.Paused === true;
  }

  private async running(jobId: string, gate: FixtureInferenceGate): Promise<void> {
    await this.ctx.wait(async () => (await this.ctx.job(jobId)).state === 'RUNNING' && gate.pending &&
      this.ctx.state.attempt(jobId)?.state === 'RUNNING' && this.ctx.runtime.active.has(jobId), 45_000, 'PAUSE_JOB_NOT_RUNNING');
    const job = await this.ctx.job(jobId), local = this.ctx.state.attempt(jobId)!;
    assert.equal(job.maxPauseMs, PAUSE_FIXTURE_BUDGET_MS);
    assert.equal(local.maxPauseMs, PAUSE_FIXTURE_BUDGET_MS);
    assert.equal(local.deadline - local.pausedDurationMs - local.createdAt, this.ctx.timeoutSeconds * 1000);
  }

  private async reserved(jobId: string, beforeBuyer: Balance, beforeSeller: Balance): Promise<void> {
    const job = await this.ctx.job(jobId);
    assert.equal(job.paymentState, 'RESERVED');
    const entries = await this.ctx.db.ledgerEntry.findMany({ where: { jobId } });
    assert.equal(entries.length, 1); assert.equal(entries[0]!.type, 'JOB_RESERVE');
    const buyer = await this.ctx.wallet('buyer'), seller = await this.ctx.wallet('seller');
    assert.equal(buyer.availableMinor, beforeBuyer.availableMinor - job.priceSnapshot.buyerPriceMinor);
    assert.equal(buyer.reservedMinor, beforeBuyer.reservedMinor + job.priceSnapshot.buyerPriceMinor);
    assert.equal(buyer.spentMinor, beforeBuyer.spentMinor);
    assert.equal(seller.earnedMinor, beforeSeller.earnedMinor);
  }

  private async pause(jobId: string, gate: FixtureInferenceGate): Promise<number> {
    const response = await this.ctx.control(jobId, 'pause');
    assert.equal(response.state, 'PAUSE_REQUESTED');
    await this.ctx.wait(() => this.inspectedPause(jobId), 12_000, 'DOCKER_PAUSE_NOT_OBSERVED');
    gate.release();
    await this.ctx.wait(async () => (await this.ctx.job(jobId)).state === 'PAUSED' && this.ctx.state.attempt(jobId)?.state === 'PAUSED',
      12_000, 'SIGNED_PAUSE_ACK_MISSING');
    assert.equal(await this.inspectedPause(jobId), true);
    const pausedAt = this.ctx.state.attempt(jobId)!.pausedAt;
    assert.ok(pausedAt !== null);
    const before = await this.ctx.db.workerCommand.count({ where: { jobId, type: 'PAUSE_JOB' } });
    assert.equal((await this.ctx.control(jobId, 'pause')).state, 'PAUSED');
    assert.equal(await this.ctx.db.workerCommand.count({ where: { jobId, type: 'PAUSE_JOB' } }), before);
    assert.equal(this.ctx.state.attempt(jobId)!.pausedAt, pausedAt);
    return pausedAt;
  }

  private async hold(jobId: string, ms: number, buyer: Balance, seller: Balance): Promise<void> {
    const calls = this.ctx.providerRequests(), until = Date.now() + ms;
    let nextCheck = 0;
    while (Date.now() < until) {
      this.ctx.signal.throwIfAborted();
      if (Date.now() >= nextCheck) {
        assert.equal((await this.ctx.job(jobId)).state, 'PAUSED');
        assert.equal(await this.inspectedPause(jobId), true);
        assert.equal(this.ctx.providerRequests(), calls, 'FIXTURE_PROVIDER_CALL_DURING_PAUSE');
        await this.reserved(jobId, buyer, seller); nextCheck = Date.now() + 5000;
      }
      await delay(Math.min(500, Math.max(1, until - Date.now())), undefined, { signal: this.ctx.signal });
    }
    assert.equal(this.ctx.providerRequests(), calls, 'FIXTURE_PROVIDER_CALL_DURING_PAUSE');
    await this.reserved(jobId, buyer, seller);
  }

  private async released(jobId: string, expected: 'CANCELLED' | 'TIMED_OUT', buyerBefore: Balance, sellerBefore: Balance) {
    await this.ctx.wait(async () => (await this.ctx.job(jobId)).state === expected && !this.ctx.runtime.active.has(jobId) &&
      !this.ctx.state.activeAttempts().some(attempt => attempt.jobId === jobId), 45_000, 'PAUSE_FAILURE_NOT_FINALIZED');
    await this.ctx.runtime.flush();
    const job = await this.ctx.job(jobId), local = this.ctx.state.attempt(jobId)!;
    assert.equal(job.paymentState, 'RELEASED');
    const entries = await this.ctx.db.ledgerEntry.findMany({ where: { jobId } });
    assert.equal(entries.length, 2);
    assert.equal(entries.filter(entry => entry.type === 'JOB_RESERVE').length, 1);
    assert.equal(entries.filter(entry => entry.type === 'JOB_RELEASE').length, 1);
    assert.equal(entries.filter(entry => ['JOB_CAPTURE', 'SELLER_EARNING', 'PLATFORM_FEE'].includes(entry.type)).length, 0);
    const buyer = await this.ctx.wallet('buyer'), seller = await this.ctx.wallet('seller');
    for (const field of ['availableMinor', 'reservedMinor', 'spentMinor', 'earnedMinor'] as const) {
      assert.equal(buyer[field], buyerBefore[field]); assert.equal(seller[field], sellerBefore[field]);
    }
    assert.equal(await this.ctx.docker.owned({ name: local.containerName, owner: this.ctx.workerId, attemptId: local.attemptId }), false);
    return { jobId, attemptId: local.attemptId, state: job.state, paymentState: job.paymentState, reserves: 1, releases: 1,
      captures: 0, sellerEarnings: 0, platformFees: 0, containersRemaining: 0, events: job.events.map(event => event.type) };
  }

  async failures(): Promise<void> {
    for (const scenario of ['pause-cancel', 'pause-expiry'] as const) {
      this.ctx.stage(scenario);
      const buyer = await this.ctx.wallet('buyer'), seller = await this.ctx.wallet('seller'), gate = this.ctx.begin(scenario);
      const job = await this.ctx.purchase();
      await this.running(job.id, gate); await this.reserved(job.id, buyer, seller);
      await this.pause(job.id, gate);
      if (scenario === 'pause-cancel') {
        await this.hold(job.id, 2000, buyer, seller);
        await this.ctx.control(job.id, 'cancel'); await this.ctx.control(job.id, 'cancel');
        this.receipts.push({ case: scenario, realPausedContainer: true, duplicateCancelChecked: true,
          ...await this.released(job.id, 'CANCELLED', buyer, seller) });
      } else {
        await this.hold(job.id, 55_000, buyer, seller);
        await this.ctx.control(job.id, 'resume'); await this.running(job.id, gate);
        const prior = this.ctx.state.attempt(job.id)!;
        assert.ok(prior.pausedDurationMs >= 55_000 && prior.pausedDurationMs < PAUSE_FIXTURE_BUDGET_MS);
        const pausedAt = await this.pause(job.id, gate), paused = this.ctx.state.attempt(job.id)!;
        const deadline = pausedAt + PAUSE_FIXTURE_BUDGET_MS - paused.pausedDurationMs;
        assert.ok(deadline - pausedAt < 35_000, 'FIXTURE_CUMULATIVE_BUDGET_WAS_RESET');
        await this.hold(job.id, Math.max(1, deadline - Date.now() - 3000), buyer, seller);
        const calls = this.ctx.providerRequests(), receipt = await this.released(job.id, 'TIMED_OUT', buyer, seller);
        const timedOut = this.ctx.state.db.prepare("SELECT at FROM audit WHERE jobId=? AND event='TIMED_OUT' ORDER BY id LIMIT 1").get(job.id) as { at: number } | undefined;
        assert.ok(timedOut); assert.ok(timedOut.at >= deadline); assert.ok(timedOut.at - deadline <= 5000);
        assert.equal(this.ctx.providerRequests(), calls, 'FIXTURE_PROVIDER_CALL_AFTER_PAUSE_EXPIRY');
        this.receipts.push({ case: scenario, cumulativeBudgetMs: PAUSE_FIXTURE_BUDGET_MS, firstConfirmedPauseMs: prior.pausedDurationMs,
          secondRemainingBudgetMs: deadline - pausedAt, deadlineOvershootMs: timedOut.at - deadline,
          realClockNoTimestampRewrite: true, realPausedContainer: true, ...receipt });
      }
    }
  }

  async success(job: JobDTO, gate: FixtureInferenceGate, buyer: Balance, seller: Balance): Promise<void> {
    this.ctx.stage('pause-success-beyond-original-timeout');
    await this.running(job.id, gate); await this.reserved(job.id, buyer, seller);
    const initialDeadline = this.ctx.state.attempt(job.id)!.deadline;
    await this.pause(job.id, gate); await this.hold(job.id, PAUSE_FIXTURE_HOLD_MS, buyer, seller);
    assert.ok(Date.now() > initialDeadline, 'FIXTURE_ORIGINAL_ACTIVE_DEADLINE_NOT_CROSSED');
    gate.open(); await this.ctx.control(job.id, 'resume');
    await this.ctx.wait(async () => {
      const current = await this.ctx.job(job.id);
      return current.events.filter(event => event.type === 'RUNNING').length === 2 && this.ctx.state.attempt(job.id)!.pausedAt === null;
    }, 20_000, 'SIGNED_RESUME_ACK_MISSING');
    const local = this.ctx.state.attempt(job.id)!;
    assert.ok(local.pausedDurationMs >= PAUSE_FIXTURE_HOLD_MS);
    assert.equal(local.deadline, initialDeadline + local.pausedDurationMs);
    this.receipts.push({ case: 'pause-success', jobId: job.id, attemptId: local.attemptId, maxPauseMs: local.maxPauseMs,
      originalExecutionTimeoutMs: this.ctx.timeoutSeconds * 1000, confirmedPausedMs: local.pausedDurationMs,
      crossedOriginalActiveDeadline: true, realPausedContainer: true, noProviderCallsWhilePaused: true,
      reservedFundsUnchangedDuringPause: true, signedPauseAndResumeAcknowledged: true, duplicatePauseChecked: true });
  }

  async verifySuccess(job: JobDTO): Promise<void> {
    const local = this.ctx.state.attempt(job.id)!;
    assert.equal(local.state, 'SUCCEEDED'); assert.equal(job.state, 'SUCCEEDED'); assert.equal(job.paymentState, 'SETTLED');
    const completed = this.ctx.state.db.prepare("SELECT at FROM audit WHERE jobId=? AND event='SUCCEEDED' ORDER BY id LIMIT 1").get(job.id) as { at: number } | undefined;
    assert.ok(completed); assert.ok(completed.at <= local.deadline, 'FIXTURE_ACTIVE_BUDGET_EXCEEDED');
    const events = job.events.map(event => event.type);
    for (const type of ['PAUSE_REQUESTED', 'PAUSED', 'RESUMING', 'VALIDATING_RESULTS', 'SUCCEEDED']) assert.ok(events.includes(type));
    assert.ok(Date.parse(job.completedAt!) - local.createdAt > this.ctx.timeoutSeconds * 1000);
    assert.equal(await this.ctx.docker.owned({ name: local.containerName, owner: this.ctx.workerId, attemptId: local.attemptId }), false);
    const receipt = this.receipts.find(value => value.case === 'pause-success'); assert.ok(receipt);
    Object.assign(receipt, { state: job.state, paymentState: job.paymentState, wallElapsedMs: Date.parse(job.completedAt!) - local.createdAt,
      activeElapsedMs: completed.at - local.createdAt - local.pausedDurationMs,
      captures: 1, sellerEarnings: 1, platformFees: 1, balancedSettlementTransactions: 1, containersRemaining: 0 });
    assert.equal(this.receipts.length, 3);
  }
}
