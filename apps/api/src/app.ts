import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import { ZodError } from 'zod';
import { createDatabase, isSerializationConflict, Prisma, type PrismaClient } from '@kivro/database';
import { PRICE_TIERS, CATEGORIES, PREPAID_PAYMENT_POLICY, ContractError } from '@kivro/contracts';
import { PolicyError } from '@kivro/policy-engine';
import { createObjectStore, FileValidationError, type ObjectStore } from '@kivro/storage';
import { StripeBilling, BillingError } from '@kivro/billing';
import { AgentPolicyError, InferenceError } from '@kivro/marketplace-agent';
import { readConfig } from './config.js';
import { ApiError } from './errors.js';
import { attachIdentity, registerAuth } from './auth.js';
import { registerAccounts } from './accounts.js';
import { registerAccountTerms } from './account-terms.js';
import { createAccountMailer, type AccountMailer } from './account-mail.js';
import { registerCatalog } from './catalog.js';
import { registerJobs } from './jobs.js';
import { authenticateWorker, registerWorker, serverKeys } from './worker.js';
import { registerWorkerUsage } from './worker-usage.js';
import { registerAssets } from './assets.js';
import { registerAssetUploads } from './asset-uploads.js';
import { registerSecurityPolicy } from './security-policy.js';
import { registerBuyerApiVersion } from './api-version.js';
import { registerResponseValidation } from './response-validation.js';
import { registerAccountLimits } from './abuse.js';
import { registerProblemReports } from './problem-reports.js';
import { registerOperations } from './operations.js';
import { registerExampleAssets } from './example-assets.js';
import { registerBilling } from './billing.js';
import { registerWebhooks } from './webhooks.js';
import { registerJobCorrelation } from './correlation.js';
import { registerAgent } from './agent.js';
import { startBackground, redisConnection } from './background.js';
import type { ApiContext } from './context.js';

export interface AppOptions {
  env?: NodeJS.ProcessEnv; db?: PrismaClient; storage?: ObjectStore; billing?: StripeBilling | null;
  background?: boolean; logger?: boolean;
  mailer?: AccountMailer | null;
}
declare module 'fastify' { interface FastifyInstance { kivro: ApiContext } }

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? process.env;
  const config = readConfig(env);
  const app = Fastify({ logger: options.logger === false ? false : {
    level: env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-worker-signature"]', 'res.headers["set-cookie"]'],
  }, bodyLimit: 2 * 1024 ** 2, requestTimeout: 45_000, connectionTimeout: 15_000, trustProxy: false, disableRequestLogging: true });
  const db = options.db ?? createDatabase(env.DATABASE_URL);
  const storage = options.storage ?? createObjectStore(env);
  const billing = options.billing !== undefined ? options.billing : config.paymentMode === 'stripe' && config.stripeSecret && config.stripeWebhookSecret ? new StripeBilling(config.stripeSecret, config.stripeWebhookSecret, config.stripeConnectWebhookSecret || undefined) : null;
  if (config.production && !billing) throw new Error('Production requires a configured Stripe adapter');
  const mailer = options.mailer !== undefined ? options.mailer : createAccountMailer(config.smtp);
  const ctx: ApiContext = { db, storage, billing, config, app, mailer, wake: async () => undefined };
  app.decorate('kivro', ctx);
  app.decorateRequest('identity', null);
  app.decorateRequest('worker', null);
  app.decorateRequest('rawBody');
  registerBuyerApiVersion(app);
  registerResponseValidation(app);
  registerJobCorrelation(app);
  await app.register(cookie);
  await app.register(cors, { origin: config.webOrigin, credentials: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });
  await app.register(multipart, { limits: { files: 1, fileSize: config.maxUploadBytes, fields: 2, parts: 3 } });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 2 * 1024 ** 2 }, (request, body, done) => {
    request.rawBody = body as Buffer;
    try { done(null, JSON.parse((body as Buffer).toString('utf8'))); }
    catch { done(new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON')); }
  });
  app.addHook('onRequest', async request => {
    request.rawBody = Buffer.alloc(0);
    const pathname = new URL(request.url, 'http://api.invalid').pathname;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !pathname.startsWith('/api/worker/') && pathname !== '/api/billing/webhook') {
      const origin = request.headers.origin;
      if (origin && origin !== config.webOrigin) throw new ApiError(403, 'ORIGIN_DENIED', 'Request origin is not approved');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'ORIGIN_DENIED', 'Cross-site mutations are not allowed');
      if (request.cookies.kivro_session && !origin && !request.headers.authorization) throw new ApiError(403, 'ORIGIN_REQUIRED', 'Authenticated browser mutations require an Origin header');
    }
  });
  app.addHook('preParsing', async (request, _reply, payload) => {
    if (!request.url.startsWith('/api/worker/') || !request.headers['content-type']?.startsWith('multipart/form-data')) return payload;
    let size = 0; const chunks: Buffer[] = [];
    for await (const part of payload) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.length;
      if (size > config.maxUploadBytes + 8192) throw new ApiError(413, 'FILE_TOO_LARGE', 'Multipart upload exceeds the limit');
      chunks.push(chunk);
    }
    request.rawBody = Buffer.concat(chunks);
    const stream = Readable.from([request.rawBody]) as Readable & { receivedEncodedLength: number };
    stream.receivedEncodedLength = size;
    return stream;
  });
  app.addHook('preHandler', async request => {
    const pathname = new URL(request.url, 'http://api.invalid').pathname;
    if (pathname.startsWith('/api/worker/') && pathname !== '/api/worker/pair') await authenticateWorker(ctx, request);
    else if (pathname.startsWith('/api/') && pathname !== '/api/billing/webhook') await attachIdentity(ctx, request);
  });
  await app.register(rateLimit, { hook: 'preHandler', max: 180, timeWindow: '1 minute',
    keyGenerator: request => request.identity?.keyId ?? request.identity?.user.id ?? request.worker?.id ?? request.ip,
    errorResponseBuilder: () => ({ statusCode: 429, code: 'RATE_LIMITED', error: 'Too Many Requests', message: 'Too many requests; retry shortly' }) });
  registerAccountLimits(app, ctx);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, request, reply) => {
    const frameworkError = error as { statusCode?: number; code?: string; name?: string };
    let status = 500, code = 'INTERNAL_ERROR', message = 'The request could not be completed', details: unknown;
    if (error instanceof ApiError) { status = error.statusCode; code = error.code; message = error.message; details = error.details; }
    else if (error instanceof ZodError) { status = 400; code = 'VALIDATION_ERROR'; message = 'Request validation failed'; details = error.issues.map(i => ({ path: i.path, message: i.message })); }
    else if (error instanceof AgentPolicyError) {
      status = error.code === 'PLAN_NOT_FOUND' ? 404 : ['PLAN_CONFLICT', 'APPROVAL_REQUIRED', 'INVALID_PLAN_STATE', 'ACTIVE_JOBS_PREVENT_REPAIR'].includes(error.code) ? 409 : 400;
      code = error.code; message = error.message;
    }
    else if (error instanceof ContractError || error instanceof PolicyError) { status = 400; code = error.code; message = error.message; if (error instanceof ContractError) details = error.details; }
    else if (error instanceof BillingError) { status = error.code === 'INSUFFICIENT_FUNDS' ? 402 : 409; code = error.code; message = error.message; }
    else if (error instanceof FileValidationError) { status = 400; code = 'INVALID_FILE'; message = error.message; }
    else if (error instanceof InferenceError) { status = 503; code = error.code; message = 'Platform inference is unavailable'; }
    else if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') { status = 409; code = 'ALREADY_EXISTS'; message = 'A record with this identity already exists'; }
      else if (error.code === 'P2025') { status = 404; code = 'NOT_FOUND'; message = 'Resource not found'; }
      else if (isSerializationConflict(error)) { status = 409; code = 'CONCURRENT_UPDATE'; message = 'A concurrent update occurred; retry the request'; }
    } else if (typeof frameworkError.statusCode === 'number' && frameworkError.statusCode >= 400 && frameworkError.statusCode < 500) {
      status = frameworkError.statusCode; code = status === 429 ? 'RATE_LIMITED' : status === 413 ? 'BODY_TOO_LARGE' : 'INVALID_REQUEST';
      message = status === 429 ? 'Too many requests; retry shortly' : status === 413 ? 'Request exceeds the size limit' : 'Request could not be processed';
    }
    if (status >= 500) app.log.error({ requestId: request.id, code: frameworkError.code ?? frameworkError.name }, 'API request failed');
    reply.code(status).send({ error: { code, message, ...(details ? { details } : {}) } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
  const redis = new Redis({ ...redisConnection(config.redisUrl), lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2000, retryStrategy: () => null });
  redis.on('error', () => undefined);
  const ready = async (_request: unknown, reply: import('fastify').FastifyReply) => {
    const redisReady = async () => { if (redis.status === 'end') await redis.connect(); return redis.ping(); };
    const checks = await Promise.allSettled([db.$queryRaw`SELECT 1`, storage.ready(), redisReady()]);
    const names = ['database', 'storage', 'redis'];
    const healthy = checks.every(check => check.status === 'fulfilled');
    reply.code(healthy ? 200 : 503);
    return { status: healthy ? 'ready' : 'unavailable', services: Object.fromEntries(checks.map((c, i) => [names[i], c.status === 'fulfilled' ? 'ready' : 'unavailable'])) };
  };
  for (const path of ['/health', '/health/live', '/api/health']) app.get(path, async () => ({ status: 'ok', service: 'kivro-api', serverTime: new Date().toISOString() }));
  for (const path of ['/ready', '/health/ready', '/api/ready']) app.get(path, ready);
  app.get('/api/config', async () => ({ priceTiers: PRICE_TIERS, categories: CATEGORIES, paymentPolicy: PREPAID_PAYMENT_POLICY, devMode: config.devAuth, paymentMode: config.paymentMode }));
  registerAuth(app, ctx); registerAccounts(app, ctx); registerAccountTerms(app, ctx); registerCatalog(app, ctx); registerJobs(app, ctx); registerWorker(app, ctx);
  registerWorkerUsage(app, ctx); registerAssets(app, ctx); registerAssetUploads(app, ctx); registerSecurityPolicy(app, ctx); registerProblemReports(app, ctx); registerOperations(app, ctx); registerExampleAssets(app, ctx); registerBilling(app, ctx); registerWebhooks(app, ctx); registerAgent(app, ctx, env);
  let background: Awaited<ReturnType<typeof startBackground>> | undefined;
  app.addHook('onReady', async () => {
    if (options.background) {
      await serverKeys(ctx);
      await ctx.initializeInferenceRouting?.();
      background = await startBackground(ctx);
      ctx.wake = async () => { try { await background!.wake(); } catch { app.log.warn('Queue notification failed; periodic reconciliation will recover'); } };
    }
  });
  app.addHook('onClose', async () => { await background?.close(); mailer?.close?.(); redis.disconnect(); if (!options.db) await db.$disconnect(); });
  return app;
}
