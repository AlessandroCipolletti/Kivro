import { randomBytes } from 'node:crypto';
import { assertProductionConfiguration } from '@kivro/policy-engine';
import { JobPauseLimitSchema, MAX_JOB_PAUSE_MS } from '@kivro/contracts';
import { readSmtpConfig } from './account-mail.js';
import { readMarketplaceTerms } from './account-terms.js';
import { z } from 'zod';
import { readFileLimits } from '@kivro/contracts/file-limits';

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  assertProductionConfiguration(env);
  const production = env.NODE_ENV === 'production' || env.KIVRO_ENV === 'production';
  const declaredEnvironment = env.KIVRO_ENV ?? env.NODE_ENV;
  const deploymentEnvironment = production ? 'production' : ['development', 'test', 'staging', 'preview'].includes(declaredEnvironment ?? '') ? declaredEnvironment! : 'unknown';
  const development = !production && ['development', 'test'].includes(env.KIVRO_ENV ?? env.NODE_ENV ?? '');
  const stripeSecret = env.STRIPE_SECRET_KEY ?? '';
  if (!production && [env.NODE_ENV, env.KIVRO_ENV].some(value => value === 'development' || value === 'test') && stripeSecret && !stripeSecret.startsWith('sk_test_')) {
    throw new Error('Development and test require a sk_test_ Stripe secret key or an empty key');
  }
  const paymentMode = env.PAYMENT_MODE ?? 'stripe';
  if (!['stripe', 'fake'].includes(paymentMode)) throw new Error('PAYMENT_MODE must be stripe or fake');
  if (paymentMode === 'fake' && !development) throw new Error('Fake payments require explicit development or test environment');
  if (env.DEV_AUTH_ENABLED === 'true' && !development) throw new Error('Development authentication cannot run outside explicit development/test');
  const webOrigin = new URL(env.WEB_ORIGIN ?? 'http://localhost:3000').origin;
  if (production && !webOrigin.startsWith('https://')) throw new Error('Production WEB_ORIGIN must use HTTPS');
  if (production && (!env.WORKER_SIGNING_PRIVATE_KEY || !env.WEBHOOK_ENCRYPTION_KEY || !env.CLAMAV_HOST)) {
    throw new Error('Production requires WORKER_SIGNING_PRIVATE_KEY, WEBHOOK_ENCRYPTION_KEY and CLAMAV_HOST');
  }
  if (env.WEBHOOK_ENCRYPTION_KEY && !/^[a-fA-F0-9]{64}$/.test(env.WEBHOOK_ENCRYPTION_KEY)) throw new Error('WEBHOOK_ENCRYPTION_KEY must be 32 bytes of hex');
  const fileLimits = readFileLimits(env);
  return {
    production, development, deploymentEnvironment, secureSessionCookies: production || webOrigin.startsWith('https://'), devAuth: development && env.DEV_AUTH_ENABLED === 'true', paymentMode,
    webOrigin, apiUrl: env.API_URL ?? 'http://127.0.0.1:4000', redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    signingPrivateKey: env.WORKER_SIGNING_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    webhookEncryptionKey: env.WEBHOOK_ENCRYPTION_KEY,
    smtp: readSmtpConfig(env, development),
    marketplaceTerms: readMarketplaceTerms(env, development),
    accountRequestsPerMinute: z.coerce.number().int().min(10).max(10000).parse(env.ACCOUNT_REQUESTS_PER_MINUTE || 180),
    accountWritesPerMinute: z.coerce.number().int().min(5).max(1000).parse(env.ACCOUNT_WRITES_PER_MINUTE || 60),
    accountJobsPerDay: z.coerce.number().int().min(1).max(10000).parse(env.ACCOUNT_JOBS_PER_DAY || 100),
    accountJobSpendMinorPerDay: z.coerce.number().int().min(1).max(100000000).parse(env.ACCOUNT_JOB_SPEND_MINOR_PER_DAY || 100000),
    agentTurnsPerDay: z.coerce.number().int().min(1).max(10000).parse(env.AGENT_TURNS_PER_DAY || 100),
    stripeSecret, stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '', stripeConnectWebhookSecret: env.STRIPE_CONNECT_WEBHOOK_SECRET ?? '',
    scannerHost: env.CLAMAV_HOST, scannerPort: Number(env.CLAMAV_PORT ?? 3310),
    maxUploadBytes: fileLimits.uploadBytes, fileLimits,
    assetRetentionDays: z.coerce.number().int().min(1).max(365).parse(env.ASSET_RETENTION_DAYS || 7),
    jobContentRetentionDays: z.coerce.number().int().min(1).max(365).parse(env.JOB_CONTENT_RETENTION_DAYS || 30),
    operationalAuditRetentionDays: z.coerce.number().int().min(1).max(3650).parse(env.OPERATIONAL_AUDIT_RETENTION_DAYS || 90),
    heartbeatTtlMs: 60_000, reconnectGraceMs: 120_000,
    maxPauseMs: JobPauseLimitSchema.parse(env.KIVRO_MAX_JOB_PAUSE_MS === undefined ? MAX_JOB_PAUSE_MS : Number(env.KIVRO_MAX_JOB_PAUSE_MS)),
    maxWaitMs: 7 * 24 * 60 * 60_000, offerTtlMs: 30_000,
    sessionDays: 14, requestIdPrefix: randomBytes(4).toString('hex'),
  };
}
export type ApiConfig = ReturnType<typeof readConfig>;
