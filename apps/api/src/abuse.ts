import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient, Transaction } from '@kivro/database';
import type { ApiContext } from './context.js';
import { ApiError } from './errors.js';

export async function consumeBucket(db: PrismaClient | Transaction, identity: string, limit: number, windowMs: number, amountMinor = 0, spendLimit = 2_000_000_000) {
  const bucket = Math.floor(Date.now() / windowMs);
  const key = createHash('sha256').update(`${identity}:${bucket}`).digest('hex');
  const expiresAt = new Date((bucket + 1) * windowMs);
  if (amountMinor > spendLimit) throw new ApiError(429, 'ACCOUNT_LIMIT', 'The account spending or request limit has been reached');
  const result = await db.$queryRaw<{ hits: number }[]>`
    INSERT INTO "AbuseBucket" ("key", "hits", "amountMinor", "expiresAt")
    VALUES (${key}, 1, ${amountMinor}, ${expiresAt})
    ON CONFLICT ("key") DO UPDATE SET "hits" = "AbuseBucket"."hits" + 1,
      "amountMinor" = "AbuseBucket"."amountMinor" + ${amountMinor}
    WHERE "AbuseBucket"."hits" < ${limit} AND "AbuseBucket"."amountMinor" <= ${spendLimit - amountMinor}
    RETURNING "hits"`;
  if (!result.length) throw new ApiError(429, 'ACCOUNT_LIMIT', 'The account spending or request limit has been reached', { retryAt: expiresAt.toISOString() });
}

export function registerAccountLimits(app: FastifyInstance, ctx: ApiContext) {
  app.addHook('preHandler', async request => {
    if (!request.identity) return;
    const userId = request.identity.user.id;
    await consumeBucket(ctx.db, `account-minute:${userId}`, ctx.config.accountRequestsPerMinute, 60_000);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const endpoint = request.routeOptions.url?.replace(/^\/api\/v1\//, '/api/') ?? 'unknown';
      await consumeBucket(ctx.db, `account-endpoint:${userId}:${request.method}:${endpoint}`, ctx.config.accountWritesPerMinute, 60_000);
    }
  });
}
