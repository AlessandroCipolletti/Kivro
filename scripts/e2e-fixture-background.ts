// Observe the production BullMQ worker, not a test processor or direct maintenance call.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import type { Queue, Job } from '../apps/api/node_modules/bullmq/dist/esm/index.js';
import { redisConnection } from '../apps/api/src/background.js';

export const ISOLATED_FIXTURE_REDIS = 'redis://127.0.0.1:56379/15';
const LEASE = 'kivro-isolated-runtime-fixture';
const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
type FixtureLeaseClient = Awaited<Queue['client']> & {
  acquireFixtureLease(key: string, owner: string, ttlSeconds: number): Promise<string | null>;
  releaseFixtureLease(key: string, owner: string): Promise<number>;
};

export function fixtureSchema(value: string | undefined): string {
  if (value !== undefined && (value.length !== 28 || !/^fresh_clone_[a-f0-9]{16}$/.test(value))) throw new Error('FIXTURE_INVALID_SCHEMA');
  return value ?? 'public';
}

export class FixtureBackground {
  private queue?: Queue;
  private acquired = false;
  private cleanNamespace = false;
  private openedAt = 0;

  constructor(private readonly fixtureId: string, private readonly signal: AbortSignal) {}

  async acquire(): Promise<void> {
    const { Queue } = requireApi('bullmq') as typeof import('../apps/api/node_modules/bullmq/dist/esm/index.js');
    this.queue = new Queue('kivro-maintenance', { connection: { ...redisConnection(ISOLATED_FIXTURE_REDIS),
      connectTimeout: 5000, maxRetriesPerRequest: 1, retryStrategy: () => null } });
    this.queue.on('error', () => undefined);
    const client = await this.queue.client as FixtureLeaseClient;
    client.defineCommand('acquireFixtureLease', { numberOfKeys: 1,
      lua: 'return redis.call("set",KEYS[1],ARGV[1],"EX",ARGV[2],"NX")' });
    this.acquired = await client.acquireFixtureLease(LEASE, this.fixtureId, 15 * 60) === 'OK';
    if (!this.acquired) throw new Error('FIXTURE_BACKGROUND_NAMESPACE_BUSY');
    // Queue construction can create meta but no jobs. Never erase a previous run
    // or operate beside another worker, including one left by a crashed fixture.
    if ((await this.queue.getWorkers()).length || await this.queue.getJobCountByTypes('wait', 'active', 'delayed', 'completed', 'failed', 'paused', 'waiting-children') ||
      (await this.queue.getJobSchedulers()).length) throw new Error('FIXTURE_BACKGROUND_NAMESPACE_NOT_EMPTY');
    this.cleanNamespace = true;
    this.openedAt = Date.now();
  }

  async proveCompleted(purchase: { startedAt: number; respondedAt: number }): Promise<Record<string, unknown>> {
    assert(this.queue && this.acquired && this.cleanNamespace);
    const deadline = Date.now() + 30_000;
    let wake: Job | undefined, periodic: Job | undefined;
    while (Date.now() < deadline) {
      if (this.signal.aborted) throw new Error('FIXTURE_CANCELLED');
      const client = await this.queue.client;
      if (await client.get(LEASE) !== this.fixtureId) throw new Error('FIXTURE_BACKGROUND_LEASE_LOST');
      assert.equal((await this.queue.getWorkers()).length, 1, 'Only the isolated real API maintenance worker may consume fixture work');
      const completed = await this.queue.getJobs(['completed'], 0, 99);
      wake = completed.find(job => job.name === 'reconcile' && /^wake-\d+$/.test(job.id ?? '') &&
        job.timestamp >= purchase.startedAt && job.timestamp <= purchase.respondedAt &&
        job.processedOn !== undefined && job.finishedOn !== undefined && job.processedOn >= job.timestamp && job.finishedOn >= job.processedOn);
      periodic = completed.find(job => job.name === 'reconcile' && job.opts.repeat && job.timestamp >= this.openedAt &&
        job.processedOn !== undefined && job.finishedOn !== undefined && job.finishedOn >= purchase.respondedAt);
      if (wake && periodic) break;
      await delay(250, undefined, { signal: this.signal });
    }
    if (!wake || !periodic) throw new Error('FIXTURE_BACKGROUND_COMPLETION_NOT_OBSERVED');
    const receipt = (job: Job) => ({ id: job.id, name: job.name, enqueuedAt: new Date(job.timestamp).toISOString(),
      processedAt: new Date(job.processedOn!).toISOString(), completedAt: new Date(job.finishedOn!).toISOString(), state: 'completed' });
    return { enabled: true, redisLogicalDatabase: 15, queue: this.queue.name, exclusiveNamespace: true,
      processor: 'apps/api/src/background.ts:startBackground', purchaseWake: receipt(wake), periodicReconciliation: receipt(periodic),
      manualMaintenanceCalls: 0, testQueueProcessors: 0 };
  }

  async close(): Promise<void> {
    if (!this.queue) return;
    try {
      const client = await this.queue.client as FixtureLeaseClient;
      if (this.acquired && await client.get(LEASE) === this.fixtureId) {
        if (this.cleanNamespace) {
          if ((await this.queue.getWorkers()).length) throw new Error('FIXTURE_BACKGROUND_WORKER_STILL_CONNECTED');
          await this.queue.removeJobScheduler('periodic-reconciliation');
          // Only the leased, initially empty fixture queue is removed, never DB0
          // or Postgres jobs, audit rows, balances or financial history.
          await this.queue.obliterate();
        }
        client.defineCommand('releaseFixtureLease', { numberOfKeys: 1,
          lua: 'if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end' });
        await client.releaseFixtureLease(LEASE, this.fixtureId);
      } else if (this.acquired) throw new Error('FIXTURE_BACKGROUND_CLEANUP_LEASE_LOST');
    } finally { await this.queue.close(); }
  }
}
