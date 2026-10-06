import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { serializable, type User } from '@kivro/database';
import type { ApiContext } from './context.js';
import { publicUser, requireIdentity } from './auth.js';
import { ApiError } from './errors.js';

const developmentText = `Kivro local development participation terms

This is a development installation, not a public commercial service. These preliminary terms are not production legal terms.

Use only data and files you are authorized to process. Do not upload secrets or personal data to synthetic tests. Do not attempt to access another user's account, files, credentials or private seller resources.

Review the capability, inputs, permissions, execution schedule and displayed price before authorizing a job. Fake development credits have no monetary value; Stripe must remain in test mode here.

Prepaid job policy: credits are reserved at purchase, including scheduled purchases. Only validated delivery settles the reservation and creates the fixed seller entitlement. Offline offers may be retried within the waiting deadline; a pending retry does not charge the buyer or pay the seller. Confirmed cancellation before delivery, seller rejection, startup or provider failure, timeout, and undelivered platform failure release the full reservation, including after execution has begun. Recovery can delay release; financial inconsistencies or fraud require review rather than an invented balance adjustment. Cancellation cannot automatically undo an already settled delivery. Approved full refunds after settlement use compensating entries; later fraud or chargebacks can suspend accounts and require separate dispute review.

The platform bears payment-processing costs from its marketplace share, not by reducing the fixed seller entitlement. The job's displayed total is credits reserved, not a final tax invoice. Taxes have not been assessed for this development installation; unknown tax is not tax exemption or zero tax. Topup processing costs are not attributed to individual jobs. The operator must validate tax treatment, processing-fee policy and Connect topology before production launch.

When you explicitly authorize inference, inputs may be transmitted to the configured AI provider. Dedicated provider API usage can incur real provider charges even when marketplace payments use test credits. Generated results may be inaccurate and require your review.

Seller publication requires explicit, version-bound permissions and dedicated credentials. Personal OpenClaw configuration is not imported automatically. Do not grant resources or publish examples you are not authorized to share.

Development data may be retained for debugging and audit. The operator must supply reviewed marketplace terms and a privacy policy before public production use.`;

export function readMarketplaceTerms(env: NodeJS.ProcessEnv, development: boolean) {
  if (!env.MARKETPLACE_TERMS_FILE && !development) return null;
  const version = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).parse(env.MARKETPLACE_TERMS_VERSION || (development ? 'development-2026-10-06-v2' : undefined));
  const text = env.MARKETPLACE_TERMS_FILE ? readFileSync(env.MARKETPLACE_TERMS_FILE, 'utf8') : developmentText;
  if (text.length < 100 || Buffer.byteLength(text) > 100_000 || text.includes('\0')) throw new Error('Marketplace terms must contain 100-100000 bytes of text');
  return { version, text, sha256: createHash('sha256').update(text).digest('hex'), preliminary: !env.MARKETPLACE_TERMS_FILE };
}

export function requireAcceptedTerms(user: Pick<User, 'termsAcceptedVersion' | 'termsAcceptedHash' | 'termsAcceptedAt'>, ctx: Pick<ApiContext, 'config'>) {
  const terms = ctx.config.marketplaceTerms;
  if (!terms) throw new ApiError(503, 'TERMS_UNAVAILABLE', 'The operator must configure marketplace terms before paid execution');
  if (!user.termsAcceptedAt || user.termsAcceptedVersion !== terms.version || user.termsAcceptedHash !== terms.sha256) {
    throw new ApiError(428, 'TERMS_ACCEPTANCE_REQUIRED', 'Review and accept the current marketplace terms before purchasing', { version: terms.version });
  }
}

export async function currentTerms(ctx: ApiContext) {
  const terms = ctx.config.marketplaceTerms;
  if (!terms) throw new ApiError(503, 'TERMS_UNAVAILABLE', 'Marketplace terms are not configured');
  const stored = await ctx.db.platformSetting.upsert({ where: { key: `marketplaceTerms:${terms.version}` }, update: {},
    create: { key: `marketplaceTerms:${terms.version}`, value: terms } });
  if ((stored.value as { sha256?: string }).sha256 !== terms.sha256) throw new ApiError(503, 'TERMS_VERSION_CONFLICT', 'Changed marketplace terms require a new version');
  return terms;
}

export function registerAccountTerms(app: FastifyInstance, ctx: ApiContext) {
  app.get('/api/terms', async () => currentTerms(ctx));
  app.post('/api/account/terms', async request => {
    const { user } = requireIdentity(request);
    const body = z.object({ version: z.string().min(1).max(100) }).strict().parse(request.body);
    const terms = await currentTerms(ctx);
    if (body.version !== terms.version) throw new ApiError(409, 'TERMS_CHANGED', 'The terms changed; review the current version');
    const updated = await serializable(ctx.db, async tx => {
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (current.termsAcceptedVersion === terms.version && current.termsAcceptedHash === terms.sha256 && current.termsAcceptedAt) return current;
      const accepted = await tx.user.update({ where: { id: user.id }, data: { termsAcceptedVersion: terms.version, termsAcceptedHash: terms.sha256, termsAcceptedAt: new Date() } });
      await tx.auditEvent.create({ data: { actorId: user.id, type: 'MARKETPLACE_TERMS_ACCEPTED', metadata: { version: terms.version, sha256: terms.sha256 } } });
      return accepted;
    });
    return { user: publicUser(updated) };
  });
}
