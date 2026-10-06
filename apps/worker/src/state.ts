import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, chmodSync, realpathSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkerUsageReceiptSchema, MAX_JOB_PAUSE_MS, type JobOffer } from '@kivro/contracts';
import { pauseBudget } from '@kivro/openclaw-adapter';
import type { WorkerCommand, SignedJobNotice } from '@kivro/job-protocol';
import { usageReceipt } from './usage.ts';
import { DEFAULT_DAILY_JOB_LIMIT, validateJobLimits } from './job-limits.ts';

export type Attempt = { jobId: string; attemptId: string; capabilityVersionId: string; state: string; containerName: string; createdAt: number; deadline: number; pausedAt: number | null; pausedDurationMs: number; maxPauseMs: number };
export type OutboxItem = { id: number; path: string; body: unknown; kind: string };
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

export class WorkerState {
  readonly db: DatabaseSync;
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(this.root) !== this.root || (process.getuid && stat.uid !== process.getuid())) throw new Error('UNSAFE_WORKER_HOME');
    chmodSync(this.root, 0o700);
    const path = join(this.root, 'state.sqlite');
    if (existsSync(path)) { const file = lstatSync(path); if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (process.getuid && file.uid !== process.getuid())) throw new Error('UNSAFE_STATE_FILE'); }
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (attemptId TEXT PRIMARY KEY, jobId TEXT UNIQUE NOT NULL, capabilityVersionId TEXT NOT NULL, nonce TEXT UNIQUE NOT NULL, state TEXT NOT NULL, containerName TEXT NOT NULL, createdAt INTEGER NOT NULL, deadline INTEGER NOT NULL, pausedAt INTEGER);
      CREATE INDEX IF NOT EXISTS attempts_created_at ON attempts(createdAt);
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', error TEXT, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, jobId TEXT, source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, heartbeat INTEGER NOT NULL);
    `);
    const columns = this.db.prepare('PRAGMA table_info(attempts)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'pausedDurationMs')) this.db.exec('ALTER TABLE attempts ADD COLUMN pausedDurationMs INTEGER NOT NULL DEFAULT 0');
    if (!columns.some(column => column.name === 'maxPauseMs')) this.db.exec(`ALTER TABLE attempts ADD COLUMN maxPauseMs INTEGER NOT NULL DEFAULT ${MAX_JOB_PAUSE_MS}`);
    this.db.exec("CREATE TRIGGER IF NOT EXISTS immutable_attempt_pause_budget BEFORE UPDATE OF maxPauseMs ON attempts WHEN NEW.maxPauseMs != OLD.maxPauseMs BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PAUSE_BUDGET'); END");
    if (!this.get('localDeviceId')) this.set('localDeviceId', randomUUID());
    if (this.get('localPause') === undefined) this.set('localPause', true);
  }
  close(): void { this.db.close(); }
  get<T = unknown>(key: string): T | undefined { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined; return row ? JSON.parse(row.value) as T : undefined; }
  set(key: string, value: unknown): void { this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  delete(key: string): void { this.db.prepare('DELETE FROM settings WHERE key=?').run(key); }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  audit(event: string, source: string, jobId?: string): void { this.db.prepare('INSERT INTO audit(at,event,source,jobId) VALUES(?,?,?,?)').run(Date.now(), event, source, jobId ?? null); }
  paused(): boolean { return this.get('localPause') === true || this.get('remotePause') === true || !!this.get('securityBlock'); }
  pause(source: 'LOCAL' | 'REMOTE' | 'SECURITY'): void {
    this.transaction(() => { this.set(source === 'LOCAL' ? 'localPause' : source === 'REMOTE' ? 'remotePause' : 'securityBlock', true); this.set('pausedAt', Date.now()); this.audit('PAUSE_ALL', source); });
  }
  resume(source: 'LOCAL' | 'REMOTE'): void {
    if (this.get('securityBlock')) throw new Error('SECURITY_BLOCK');
    this.transaction(() => { this.set(source === 'LOCAL' ? 'localPause' : 'remotePause', false); this.audit('RESUME_ALL', source); });
  }
  dailyJobs() { return this.dailyJobsAt(Date.now()); }
  private dailyJobsAt(now: number) {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) throw new Error('INVALID_WORKER_CLOCK');
    const stored = this.get('jobLimits');
    const { dailyJobLimit } = validateJobLimits(stored === undefined ? { dailyJobLimit: DEFAULT_DAILY_JOB_LIMIT } : stored);
    const latest = this.db.prepare('SELECT MAX(createdAt) AS at FROM attempts').get() as { at: number | null };
    if (latest.at !== null && latest.at > now) throw new Error('WORKER_CLOCK_ROLLBACK');
    const date = new Date(now).toISOString().slice(0, 10), dayStart = Date.parse(`${date}T00:00:00.000Z`);
    // Accepted attempts are the durable source of truth, including legacy,
    // failed and cancelled jobs. No resettable counter can refund admission.
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM attempts WHERE createdAt>=?').get(dayStart) as { total: number };
    return { date, timeZone: 'UTC' as const, dailyJobLimit, claimedJobs: row.total, remainingJobs: Math.max(0, dailyJobLimit - row.total) };
  }
  claim(offer: Pick<JobOffer, 'attemptId' | 'jobId' | 'capabilityVersionId' | 'nonce' | 'permissions'> & { maxPauseMs: number }, containerName: string, notice?: SignedJobNotice): void {
    this.transaction(() => {
      if (this.paused() || this.get(`capabilityPause:${offer.capabilityVersionId}`)) throw new Error('WORKER_PAUSED');
      if (this.activeAttempts().length) throw new Error('WORKER_BUSY');
      const now = Date.now();
      if (this.dailyJobsAt(now).remainingJobs === 0) throw new Error('DAILY_JOB_LIMIT_EXCEEDED');
      this.db.prepare('INSERT INTO attempts(attemptId,jobId,capabilityVersionId,nonce,state,containerName,createdAt,deadline,maxPauseMs) VALUES(?,?,?,?,?,?,?,?,?)').run(offer.attemptId, offer.jobId, offer.capabilityVersionId, offer.nonce, 'ACCEPTED', containerName, now, now + offer.permissions.limits.timeoutSeconds * 1000, pauseBudget(offer.maxPauseMs));
      this.enqueue(`/api/worker/jobs/${offer.jobId}/events`, { attemptId: offer.attemptId, type: 'ACCEPTED' }, 'event');
      if (notice) this.set(`notice:${offer.attemptId}`, notice);
      this.audit('ACCEPTED', 'WORKER', offer.jobId);
    });
  }
  attempts(): Attempt[] { return this.db.prepare('SELECT jobId,attemptId,capabilityVersionId,state,containerName,createdAt,deadline,pausedAt,pausedDurationMs,maxPauseMs FROM attempts ORDER BY createdAt').all() as unknown as Attempt[]; }
  activeAttempts(): Attempt[] { return this.attempts().filter(attempt => !TERMINAL.has(attempt.state)); }
  attempt(jobId: string): Attempt | undefined { return this.attempts().find(attempt => attempt.jobId === jobId); }
  transition(jobId: string, state: string, event = true): void {
    const attempt = this.attempt(jobId); if (!attempt) throw new Error('JOB_NOT_FOUND');
    if (attempt.state === state) return;
    if (TERMINAL.has(attempt.state)) throw new Error('JOB_TERMINAL');
    const allowed: Record<string, string[]> = { ACCEPTED: ['RUNNING', 'FAILED', 'CANCELLED', 'TIMED_OUT'], RUNNING: ['PAUSE_REQUESTED', 'UPLOADING_RESULTS', 'FAILED', 'CANCELLED', 'TIMED_OUT'], PAUSE_REQUESTED: ['PAUSED', 'FAILED', 'CANCELLED', 'TIMED_OUT'], PAUSED: ['RESUMING', 'FAILED', 'CANCELLED', 'TIMED_OUT'], RESUMING: ['RUNNING', 'FAILED', 'CANCELLED', 'TIMED_OUT'], UPLOADING_RESULTS: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] };
    if (!allowed[attempt.state]?.includes(state)) throw new Error('INVALID_LOCAL_JOB_TRANSITION');
    this.transaction(() => {
      const now = Date.now();
      const resumedMs = state === 'RUNNING' && attempt.pausedAt !== null ? Math.max(0, now - attempt.pausedAt) : 0;
      if (state === 'RUNNING' && attempt.pausedAt !== null && attempt.pausedDurationMs + resumedMs >= attempt.maxPauseMs) throw new Error('TIMED_OUT');
      // A resume health check does not thaw Docker. Preserve its pause origin
      // until RUNNING so duplicate commands/restarts cannot reset the budget.
      const pausedAt = state === 'PAUSED' ? now : state === 'RESUMING' ? attempt.pausedAt : null;
      this.db.prepare('UPDATE attempts SET state=?,pausedAt=?,deadline=deadline+?,pausedDurationMs=pausedDurationMs+? WHERE jobId=?').run(state, pausedAt, resumedMs, resumedMs, jobId);
      if (event && ['RUNNING', 'PAUSED', 'RESUMING', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(state)) this.enqueue(`/api/worker/jobs/${jobId}/events`, { attemptId: attempt.attemptId, type: state }, 'event');
      this.audit(state, 'WORKER', jobId);
    });
  }
  enqueue(path: string, body: unknown, kind: string): void { this.db.prepare('INSERT INTO outbox(path,body,kind) VALUES(?,?,?)').run(path, JSON.stringify(body), kind); }
  pending(): OutboxItem[] { return (this.db.prepare("SELECT * FROM outbox ORDER BY CASE WHEN kind='usage' THEN 1 ELSE 0 END,id LIMIT 100").all() as unknown as { id: number; path: string; body: string; kind: string }[]).map(item => ({ ...item, body: JSON.parse(item.body) })); }
  acknowledge(id: number): void { this.db.prepare('DELETE FROM outbox WHERE id=?').run(id); }
  acknowledgeDelivery(item: OutboxItem, historicalFinished = false): void {
    this.transaction(() => {
      const jobId = item.path.split('/')[4]!, attempt = this.attempt(jobId), body = item.body as { attemptId?: string; type?: string };
      if (attempt && body.attemptId === attempt.attemptId) {
        if (item.kind === 'event' && body.type === 'ACCEPTED') this.set(`cloudAccepted:${attempt.attemptId}`, true);
        if (historicalFinished || item.kind === 'result' || item.kind === 'event' && ['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(body.type ?? '')) this.set(`cloudFinished:${attempt.attemptId}`, true);
        if (item.kind === 'usage') { this.set(`usageDelivery:${attempt.attemptId}`, 'ACKNOWLEDGED'); this.delete(`usageRetry:${item.id}`); }
        this.queueUsage(attempt);
      }
      this.acknowledge(item.id);
    });
  }
  /** Called only after broker cancellation/drain, or crash recovery. A frozen
   * receipt never changes even if delivery is retried after an unknown ACK. */
  finalizeUsage(jobId: string): void {
    const attempt = this.attempt(jobId); if (!attempt) return;
    if (!TERMINAL.has(attempt.state) && !(attempt.state === 'UPLOADING_RESULTS' && this.hasPendingResult(jobId))) throw new Error('USAGE_EXECUTION_NOT_FINISHED');
    if (!this.get(`usageReceipt:${attempt.attemptId}`)) {
      try { this.set(`usageReceipt:${attempt.attemptId}`, usageReceipt(this, attempt.attemptId)); }
      catch {
        // Legacy token-only state cannot establish admitted calls or reserved
        // money. Do not fabricate an invoice-like receipt during upgrades.
        if (!this.get(`usageUnavailable:${attempt.attemptId}`)) { this.set(`usageUnavailable:${attempt.attemptId}`, true); this.audit('USAGE_RECEIPT_UNAVAILABLE', 'WORKER', jobId); }
        return;
      }
    }
    this.transaction(() => this.queueUsage(attempt));
  }
  private queueUsage(attempt: Attempt): void {
    if (!this.get(`cloudAccepted:${attempt.attemptId}`) || !this.get(`cloudFinished:${attempt.attemptId}`) || this.get(`usageDelivery:${attempt.attemptId}`)) return;
    const raw = this.get(`usageReceipt:${attempt.attemptId}`); if (!raw) return;
    const receipt = WorkerUsageReceiptSchema.safeParse(raw);
    if (!receipt.success || receipt.data.attemptId !== attempt.attemptId) { this.set(`usageDelivery:${attempt.attemptId}`, 'INVALID'); this.audit('USAGE_RECEIPT_INVALID', 'WORKER', attempt.jobId); return; }
    this.enqueue(`/api/worker/jobs/${attempt.jobId}/usage`, receipt.data, 'usage'); this.set(`usageDelivery:${attempt.attemptId}`, 'QUEUED');
  }
  deferUsage(item: OutboxItem): void {
    const failures = Math.min(10, (this.get<{ failures: number }>(`usageRetry:${item.id}`)?.failures ?? 0) + 1);
    this.set(`usageRetry:${item.id}`, { failures, nextAt: Date.now() + Math.min(1800000, 30000 * 2 ** (failures - 1)) });
    this.audit('USAGE_RECEIPT_RETRY_PENDING', 'WORKER', item.path.split('/')[4]);
  }
  rejectUsage(item: OutboxItem, code: 'USAGE_RECEIPT_CONFLICT' | 'USAGE_PERMISSION_MISMATCH'): void {
    const receipt = WorkerUsageReceiptSchema.parse(item.body);
    this.transaction(() => {
      this.set(`usageDelivery:${receipt.attemptId}`, 'REJECTED'); this.set(`usageRejection:${receipt.attemptId}`, code);
      this.delete(`usageRetry:${item.id}`); this.acknowledge(item.id); this.audit(code, 'WORKER', item.path.split('/')[4]);
    });
  }
  hasPendingResult(jobId: string): boolean { return !!this.db.prepare("SELECT 1 FROM outbox WHERE kind='result' AND path=? LIMIT 1").get(`/api/worker/jobs/${jobId}/result`); }
  command(command: WorkerCommand & { source?: string }): void { this.db.prepare('INSERT OR IGNORE INTO commands(id,payload,createdAt) VALUES(?,?,?)').run(command.id, JSON.stringify(command), Date.now()); }
  commands(): (WorkerCommand & { source?: string })[] { return (this.db.prepare("SELECT payload FROM commands WHERE status='PENDING' ORDER BY createdAt LIMIT 50").all() as unknown as { payload: string }[]).map(row => JSON.parse(row.payload)); }
  commandResult(id: string): { status: string; error?: string } | undefined { return this.db.prepare('SELECT status,error FROM commands WHERE id=?').get(id) as { status: string; error?: string } | undefined; }
  finishCommand(id: string, error?: string): void { this.db.prepare('UPDATE commands SET status=?,error=? WHERE id=?').run(error ? 'FAILED' : 'DONE', error ?? null, id); }
  acquireLease(owner: string): void {
    this.transaction(() => { const lease = this.db.prepare('SELECT * FROM lease WHERE id=1').get() as { heartbeat: number } | undefined;
      if (lease && Date.now() - lease.heartbeat < 30_000) throw new Error('WORKER_ALREADY_RUNNING');
      this.db.prepare('INSERT INTO lease(id,owner,heartbeat) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,heartbeat=excluded.heartbeat').run(owner, Date.now()); });
  }
  heartbeatLease(owner: string): void { const result = this.db.prepare('UPDATE lease SET heartbeat=? WHERE id=1 AND owner=?').run(Date.now(), owner); if (result.changes !== 1) throw new Error('WORKER_LEASE_LOST'); }
  releaseLease(owner: string): void { this.db.prepare('DELETE FROM lease WHERE id=1 AND owner=?').run(owner); }
}
