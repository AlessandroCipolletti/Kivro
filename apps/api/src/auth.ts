import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import type { User, WorkerDevice } from '@kivro/database';
import { serializable, type Prisma } from '@kivro/database';
import { z } from 'zod';
import type { ApiContext } from './context.js';
import { ApiError } from './errors.js';
import { currentTerms } from './account-terms.js';

export const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');
export const API_SCOPES = ['capabilities:read', 'jobs:create', 'jobs:read', 'assets:create', 'assets:read', 'webhooks:manage'] as const;
export interface Identity { user: User; kind: 'session' | 'api-key'; scopes: string[]; keyId?: string }
declare module 'fastify' {
  interface FastifyRequest { identity: Identity | null; worker: WorkerDevice | null; rawBody: Buffer }
}

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 }, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, hash] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !hash || !/^[a-f0-9]{128}$/.test(hash)) return false;
  const derived = await derive(password, salt);
  return timingSafeEqual(derived, Buffer.from(hash, 'hex'));
}
export function publicUser(user: User) { return { id: user.id, name: user.name, email: user.email, bio: user.bio, emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
  termsAcceptedVersion: user.termsAcceptedVersion, termsAcceptedAt: user.termsAcceptedAt?.toISOString() ?? null, isAdmin: user.isAdmin }; }

export async function lockCredentials(tx: Prisma.TransactionClient, userId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`credentials:${userId}`}, 0))`;
}

export function requireIdentity(request: FastifyRequest, scope?: string): Identity {
  const identity = request.identity;
  if (!identity) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue');
  if (identity.user.suspendedAt) throw new ApiError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended');
  if (identity.kind === 'api-key' && (!scope || !identity.scopes.includes(scope))) throw new ApiError(403, 'INSUFFICIENT_SCOPE', 'API key does not have the required scope');
  return identity;
}
export function requireAdmin(request: FastifyRequest): User {
  const { user } = requireIdentity(request);
  if (!user.isAdmin) throw new ApiError(403, 'FORBIDDEN', 'Administrator access required');
  return user;
}

export async function attachIdentity(ctx: ApiContext, request: FastifyRequest) {
  const bearer = request.headers.authorization;
  if (bearer) {
    if (!bearer.startsWith('Bearer ') || bearer.length > 512) throw new ApiError(401, 'INVALID_API_KEY', 'Invalid bearer credential');
    const key = await ctx.db.apiKey.findUnique({ where: { secretHash: hashSecret(bearer.slice(7)) }, include: { user: true } });
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= new Date()) || key.user.suspendedAt) throw new ApiError(401, 'INVALID_API_KEY', 'API key is invalid or expired');
    request.identity = { user: key.user, kind: 'api-key', scopes: key.scopes, keyId: key.id };
    await ctx.db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    return;
  }
  const token = request.cookies.kivro_session;
  if (!token) return;
  const session = await ctx.db.session.findUnique({ where: { tokenHash: hashSecret(token) }, include: { user: true } });
  if (session && session.expiresAt > new Date() && !session.user.suspendedAt) request.identity = { user: session.user, kind: 'session', scopes: [] };
}

async function createSession(ctx: ApiContext, reply: FastifyReply, user: User) {
  const token = randomBytes(32).toString('base64url');
  const maxAge = ctx.config.sessionDays * 86400;
  await serializable(ctx.db, async tx => {
    await lockCredentials(tx, user.id);
    const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
    if (current.suspendedAt || current.passwordHash !== user.passwordHash) throw new ApiError(401, 'INVALID_LOGIN', 'Email or password is incorrect');
    await tx.session.create({ data: { userId: user.id, tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + maxAge * 1000) } });
  });
  reply.setCookie('kivro_session', token, { httpOnly: true, sameSite: 'lax', secure: ctx.config.secureSessionCookies, path: '/', maxAge });
  return { user: publicUser(user) };
}

export function registerAuth(app: FastifyInstance, ctx: ApiContext) {
  const email = z.string().trim().toLowerCase().email().max(254);
  app.get('/api/auth/me', async request => ({ user: request.identity ? publicUser(request.identity.user) : null }));
  app.post('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: request => request.ip } } }, async (request, reply) => {
    const body = z.object({ email, name: z.string().trim().min(1).max(100), password: z.string().min(12).max(128), acceptedTermsVersion: z.string().min(1).max(100).optional() }).strict().parse(request.body);
    const terms = body.acceptedTermsVersion ? await currentTerms(ctx) : null;
    if (terms && body.acceptedTermsVersion !== terms.version) throw new ApiError(409, 'TERMS_CHANGED', 'The terms changed; review the current version');
    const passwordHash = await hashPassword(body.password);
    const user = await ctx.db.$transaction(async tx => {
      const created = await tx.user.create({ data: { email: body.email, name: body.name, passwordHash, wallet: { create: {} },
        ...(terms ? { termsAcceptedVersion: terms.version, termsAcceptedHash: terms.sha256, termsAcceptedAt: new Date() } : {}) } });
      if (terms) await tx.auditEvent.create({ data: { actorId: created.id, type: 'MARKETPLACE_TERMS_ACCEPTED', metadata: { version: terms.version, sha256: terms.sha256 } } });
      return created;
    });
    return createSession(ctx, reply, user);
  });
  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: request => request.ip } } }, async (request, reply) => {
    const body = z.object({ email, password: z.string().min(1).max(128) }).strict().parse(request.body);
    const user = await ctx.db.user.findUnique({ where: { email: body.email } });
    const fallback = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;
    const valid = await verifyPassword(body.password, user?.passwordHash ?? fallback);
    if (!user || !valid || user.suspendedAt) throw new ApiError(401, 'INVALID_LOGIN', 'Email or password is incorrect');
    return createSession(ctx, reply, user);
  });
  app.post('/api/auth/logout', async (request, reply) => {
    if (request.cookies.kivro_session) await ctx.db.session.deleteMany({ where: { tokenHash: hashSecret(request.cookies.kivro_session) } });
    reply.clearCookie('kivro_session', { path: '/' });
    return { ok: true };
  });
  app.post('/api/auth/dev-login', async (request, reply) => {
    if (!ctx.config.devAuth) throw new ApiError(404, 'NOT_FOUND', 'Route not found');
    const { role } = z.object({ role: z.enum(['buyer', 'seller', 'admin']) }).strict().parse(request.body);
    const user = await ctx.db.user.findUnique({ where: { email: `${role}@kivro.local` } });
    if (!user || user.suspendedAt) throw new ApiError(409, 'DEMO_NOT_SEEDED', 'Run the explicit development seed first');
    return createSession(ctx, reply, user);
  });
  app.get('/api/api-keys', async request => {
    const { user } = requireIdentity(request);
    return ctx.db.apiKey.findMany({ where: { userId: user.id }, select: { id: true, name: true, prefix: true, scopes: true, expiresAt: true, revokedAt: true, lastUsedAt: true, createdAt: true } });
  });
  app.post('/api/api-keys', async request => {
    const { user } = requireIdentity(request);
    const body = z.object({ name: z.string().trim().min(1).max(100), scopes: z.array(z.enum(API_SCOPES)).min(1).max(6), expiresAt: z.string().datetime().optional() }).strict().parse(request.body);
    if (body.expiresAt && new Date(body.expiresAt) <= new Date()) throw new ApiError(400, 'INVALID_EXPIRY', 'Expiry must be in the future');
    const secret = `kivro_${randomBytes(32).toString('base64url')}`;
    const key = await serializable(ctx.db, async tx => {
      await lockCredentials(tx, user.id);
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (current.suspendedAt || current.passwordHash !== user.passwordHash) throw new ApiError(401, 'CREDENTIALS_CHANGED', 'Sign in again before creating an API key');
      const created = await tx.apiKey.create({ data: { userId: user.id, name: body.name, scopes: [...new Set(body.scopes)], secretHash: hashSecret(secret), prefix: secret.slice(0, 14), expiresAt: body.expiresAt ? new Date(body.expiresAt) : null } });
      await tx.auditEvent.create({ data: { actorId: user.id, type: 'API_KEY_CREATED', metadata: { keyId: created.id, scopes: created.scopes } } });
      return created;
    });
    return { id: key.id, name: key.name, prefix: key.prefix, scopes: key.scopes, secret };
  });
  const revoke = async (request: FastifyRequest) => {
    const { user } = requireIdentity(request);
    const params = request.params as { id?: string };
    const id = z.string().uuid().parse(params.id ?? (request.body as { id?: string } | undefined)?.id);
    await ctx.db.apiKey.updateMany({ where: { id, userId: user.id }, data: { revokedAt: new Date() } });
    await ctx.db.auditEvent.create({ data: { actorId: user.id, type: 'API_KEY_REVOKED', metadata: { keyId: id } } });
    return { ok: true };
  };
  app.delete('/api/api-keys', revoke);
  app.delete('/api/api-keys/:id', revoke);
}
