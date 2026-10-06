import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { serializable, type Prisma } from '@kivro/database';
import { z } from 'zod';
import { hashPassword, hashSecret, lockCredentials, publicUser, requireIdentity, verifyPassword } from './auth.js';
import type { ApiContext } from './context.js';
import { ApiError } from './errors.js';
import { encryptSecret, webhookKey } from './webhooks.js';

const password = z.string().min(12).max(128);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const genericResponse = { ok: true, message: 'If the account is eligible, an email will arrive shortly.' };
const invalidAction = () => new ApiError(400, 'INVALID_ACCOUNT_TOKEN', 'This link is invalid or expired. Request a new one.');
const limited = { config: { rateLimit: { max: 8, timeWindow: '1 minute', keyGenerator: (request: { ip: string }) => request.ip } } };

async function revokeCredentials(tx: Prisma.TransactionClient, userId: string) {
  const now = new Date();
  await tx.session.deleteMany({ where: { userId } });
  await tx.apiKey.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  await tx.authAction.updateMany({ where: { userId, consumedAt: null }, data: { consumedAt: now } });
  await tx.accountEmail.updateMany({ where: { action: { userId }, payloadEncrypted: { not: null } }, data: { payloadEncrypted: null, leaseId: null } });
}

async function requestAction(ctx: ApiContext, email: string, kind: 'PASSWORD_RESET' | 'EMAIL_VERIFY') {
  if (!ctx.mailer) throw new ApiError(503, 'ACCOUNT_EMAIL_UNAVAILABLE', 'Account email delivery is not configured');
  const started = Date.now();
  try {
    const candidate = await ctx.db.user.findUnique({ where: { email } });
    if (!candidate) return genericResponse;
    const key = await webhookKey(ctx);
    await serializable(ctx.db, async tx => {
      await lockCredentials(tx, candidate.id);
      const user = await tx.user.findUniqueOrThrow({ where: { id: candidate.id } });
      if (user.suspendedAt || user.email !== email || (kind === 'EMAIL_VERIFY' && user.emailVerifiedAt)) return;
      const recent = await tx.authAction.findFirst({ where: { userId: user.id, kind, createdAt: { gt: new Date(Date.now() - 60_000) } } });
      if (recent) return;
      const secret = randomBytes(32).toString('base64url');
      const path = kind === 'PASSWORD_RESET' ? 'reset-password' : 'verify-email';
      const link = `${ctx.config.webOrigin}/auth/${path}#token=${secret}`;
      const subject = kind === 'PASSWORD_RESET' ? 'Reset your Kivro password' : 'Verify your Kivro email';
      const text = `${subject}\n\n${link}\n\nThis single-use link expires in 30 minutes. If you did not request it, ignore this email.`;
      await tx.authAction.create({ data: { userId: user.id, kind, issuedEmail: email, tokenHash: hashSecret(secret),
        credentialFingerprint: hashSecret(user.passwordHash), expiresAt: new Date(Date.now() + 30 * 60_000),
        email: { create: { payloadEncrypted: encryptSecret(JSON.stringify({ to: email, subject, text }), key) } } } });
    });
    await ctx.wake();
    return genericResponse;
  } finally { await delay(Math.max(0, 150 - (Date.now() - started))); }
}

async function confirmAction(ctx: ApiContext, secret: string, kind: 'PASSWORD_RESET' | 'EMAIL_VERIFY', newHash?: string) {
  const action = await ctx.db.authAction.findUnique({ where: { tokenHash: hashSecret(secret) } });
  if (!action || action.kind !== kind) throw invalidAction();
  return serializable(ctx.db, async tx => {
    await lockCredentials(tx, action.userId);
    const current = await tx.authAction.findUniqueOrThrow({ where: { id: action.id }, include: { user: true } });
    if (current.consumedAt || current.expiresAt <= new Date() || current.user.suspendedAt || current.issuedEmail !== current.user.email
      || current.credentialFingerprint !== hashSecret(current.user.passwordHash)) throw invalidAction();
    const now = new Date();
    if (kind === 'PASSWORD_RESET') {
      await tx.user.update({ where: { id: current.userId }, data: { passwordHash: newHash! } });
      await revokeCredentials(tx, current.userId);
    } else {
      await tx.user.update({ where: { id: current.userId }, data: { emailVerifiedAt: now } });
      await tx.authAction.update({ where: { id: current.id }, data: { consumedAt: now } });
      await tx.accountEmail.updateMany({ where: { actionId: current.id }, data: { payloadEncrypted: null, leaseId: null } });
    }
    await tx.auditEvent.create({ data: { actorId: current.userId, type: kind === 'PASSWORD_RESET' ? 'ACCOUNT_PASSWORD_RESET' : 'ACCOUNT_EMAIL_VERIFIED', metadata: {} } });
    return { ok: true };
  });
}

export function registerAccounts(app: FastifyInstance, ctx: ApiContext) {
  app.put('/api/account', async request => {
    const { user } = requireIdentity(request);
    const body = z.object({ name: z.string().trim().min(1).max(100), bio: z.string().trim().max(2000).nullable() }).strict().parse(request.body);
    const updated = await ctx.db.user.update({ where: { id: user.id }, data: body });
    return { user: publicUser(updated) };
  });
  app.post('/api/account/password', limited, async (request, reply) => {
    const { user } = requireIdentity(request);
    const body = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }).strict().parse(request.body);
    if (!await verifyPassword(body.currentPassword, user.passwordHash)) throw new ApiError(400, 'INVALID_PASSWORD', 'The current password is incorrect');
    const newHash = await hashPassword(body.newPassword);
    await serializable(ctx.db, async tx => {
      await lockCredentials(tx, user.id);
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (current.passwordHash !== user.passwordHash || current.suspendedAt) throw new ApiError(409, 'CREDENTIALS_CHANGED', 'Sign in again before changing your password');
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
      await revokeCredentials(tx, user.id);
      await tx.auditEvent.create({ data: { actorId: user.id, type: 'ACCOUNT_PASSWORD_CHANGED', metadata: {} } });
    });
    reply.clearCookie('kivro_session', { path: '/' });
    return { ok: true };
  });
  app.post('/api/auth/password-reset/request', limited, async request => {
    const { email } = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict().parse(request.body);
    return requestAction(ctx, email, 'PASSWORD_RESET');
  });
  app.post('/api/auth/password-reset/confirm', limited, async (request, reply) => {
    const body = z.object({ token, newPassword: password }).strict().parse(request.body);
    const result = await confirmAction(ctx, body.token, 'PASSWORD_RESET', await hashPassword(body.newPassword));
    reply.clearCookie('kivro_session', { path: '/' });
    return result;
  });
  app.post('/api/auth/email-verification/request', limited, async request => {
    const { user } = requireIdentity(request);
    z.object({}).strict().parse(request.body);
    return requestAction(ctx, user.email, 'EMAIL_VERIFY');
  });
  app.post('/api/auth/email-verification/confirm', limited, async request => {
    const body = z.object({ token }).strict().parse(request.body);
    return confirmAction(ctx, body.token, 'EMAIL_VERIFY');
  });
}
