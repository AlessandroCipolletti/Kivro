import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@kivro/database';
import { createApp } from '../src/app.js';
import { hashPassword, hashSecret, verifyPassword } from '../src/auth.js';
import { createAccountMailer, deliverAccountEmails, readSmtpConfig, type AccountMessage } from '../src/account-mail.js';
import { decryptSecret } from '../src/webhooks.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('account lifecycle and durable encrypted email (isolated PostgreSQL schema)', () => {
  let db: PrismaClient, app: FastifyInstance, initialHash: string;
  const schema = `account_test_${randomBytes(8).toString('hex')}`;
  const key = randomBytes(32).toString('hex'), delivered: AccountMessage[] = [];
  const initialPassword = 'Original-password-2026!';
  let ip = 1, failDelivery = false;
  const origin = 'http://localhost:3000';
  const post = (url: string, payload: Record<string, unknown>, session?: string) => app.inject({ method: 'POST', url, payload,
    remoteAddress: `127.0.1.${ip++}`, headers: { origin, ...(session ? { cookie: `kivro_session=${session}` } : {}) } });
  const fixture = async () => {
    const id = randomUUID(), session = randomUUID(), apiKey = randomUUID();
    const email = `${id}@accounts.kivro.local`;
    await db.user.create({ data: { id, email, name: 'Account lifecycle fixture', passwordHash: initialHash,
      sessions: { create: { tokenHash: hashSecret(session), expiresAt: new Date(Date.now() + 3600_000) } },
      apiKeys: { create: { name: 'Account fixture key', prefix: apiKey.slice(0, 12), secretHash: hashSecret(apiKey), scopes: ['jobs:read'] } } } });
    return { id, email, session, apiKey };
  };
  const requestToken = async (user: Awaited<ReturnType<typeof fixture>>, kind = 'PASSWORD_RESET') => {
    const response = kind === 'PASSWORD_RESET'
      ? await post('/api/auth/password-reset/request', { email: user.email })
      : await post('/api/auth/email-verification/request', {}, user.session);
    expect(response.statusCode, response.body).toBe(200);
    const action = await db.authAction.findFirstOrThrow({ where: { userId: user.id, kind }, orderBy: { createdAt: 'desc' }, include: { email: true } });
    const message = JSON.parse(decryptSecret(action.email!.payloadEncrypted!, key)) as { text: string };
    const token = /#token=([A-Za-z0-9_-]{43})/.exec(message.text)![1]!;
    expect(JSON.stringify(action)).not.toContain(token);
    expect(action.tokenHash).toBe(hashSecret(token));
    return { action, token };
  };
  beforeAll(async () => {
    process.loadEnvFile('.env');
    const url = new URL(process.env.DATABASE_URL!);
    if (process.env.KIVRO_ENV !== 'development' || url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/kivro') throw new Error('Requires local development database');
    url.searchParams.set('schema', schema);
    await promisify(execFile)('pnpm', ['--filter', '@kivro/database', 'exec', 'prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url.toString() } });
    db = new PrismaClient({ datasourceUrl: url.toString() });
    initialHash = await hashPassword(initialPassword);
    app = await createApp({ db, logger: false, env: { ...process.env, NODE_ENV: 'test', WEB_ORIGIN: origin, WEBHOOK_ENCRYPTION_KEY: key },
      mailer: { async send(message) { if (failDelivery) throw new Error(`Simulated failure containing private payload: ${message.text}`); delivered.push(message); } } });
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      if (!/^account_test_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe test schema');
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await db.$disconnect();
    }
  });
  it('returns identical responses for absent, suspended and eligible accounts and throttles repeat email creation', async () => {
    const user = await fixture();
    const known = await post('/api/auth/password-reset/request', { email: user.email });
    const unknown = await post('/api/auth/password-reset/request', { email: `${randomUUID()}@unknown.kivro.local` });
    expect(known.statusCode).toBe(200); expect(unknown.body).toBe(known.body);
    await post('/api/auth/password-reset/request', { email: user.email });
    expect(await db.authAction.count({ where: { userId: user.id } })).toBe(1);
    await db.user.update({ where: { id: user.id }, data: { suspendedAt: new Date() } });
    expect((await post('/api/auth/password-reset/request', { email: user.email })).body).toBe(known.body);
    expect(await db.authAction.count({ where: { userId: user.id } })).toBe(1);
  });
  it('sets HTTPS staging login cookies Secure without requiring live Stripe keys or trusting forwarded headers', async () => {
    const user = await fixture(), stagingOrigin = 'https://staging.kivro.invalid';
    const staging = await createApp({ db, logger: false, env: { ...process.env, NODE_ENV: 'test', KIVRO_ENV: 'staging',
      WEB_ORIGIN: stagingOrigin, PAYMENT_MODE: 'stripe', STRIPE_SECRET_KEY: 'sk_test_synthetic_cookie_only',
      STRIPE_WEBHOOK_SECRET: '', STRIPE_CONNECT_WEBHOOK_SECRET: '', DEV_AUTH_ENABLED: 'false', WEBHOOK_ENCRYPTION_KEY: key } });
    try {
      expect(staging.kivro.config.production).toBe(false);
      expect(staging.kivro.config.deploymentEnvironment).toBe('staging');
      const response = await staging.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: initialPassword },
        headers: { origin: stagingOrigin, 'x-forwarded-proto': 'http' } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['set-cookie']).toContain('; Secure');
      expect(response.headers['set-cookie']).toContain('; HttpOnly');
      expect(response.headers['set-cookie']).toContain('; SameSite=Lax');
      const local = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: initialPassword },
        headers: { origin, 'x-forwarded-proto': 'https' }, remoteAddress: `127.0.1.${ip++}` });
      expect(local.statusCode, local.body).toBe(200);
      expect(local.headers['set-cookie']).not.toContain('; Secure');
    } finally { await staging.close(); }
  });
  it('consumes one reset exactly once under concurrency and revokes every old session and API key', async () => {
    const user = await fixture(), { token } = await requestToken(user);
    const payload = { token, newPassword: 'Replacement-password-2026!' };
    const responses = await Promise.all([post('/api/auth/password-reset/confirm', payload), post('/api/auth/password-reset/confirm', payload)]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 400]);
    expect(await verifyPassword(payload.newPassword, (await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash)).toBe(true);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.apiKey.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    expect(await db.accountEmail.count({ where: { action: { userId: user.id }, payloadEncrypted: { not: null } } })).toBe(0);
    expect(await db.auditEvent.count({ where: { actorId: user.id, type: 'ACCOUNT_PASSWORD_RESET' } })).toBe(1);
    expect(JSON.stringify(await db.auditEvent.findMany({ where: { actorId: user.id } }))).not.toContain(token);
    expect((await post('/api/auth/login', { email: user.email, password: initialPassword })).statusCode).toBe(401);
    expect((await post('/api/auth/login', { email: user.email, password: payload.newPassword })).statusCode).toBe(200);
  });
  it.each(['expired', 'suspended', 'password-changed', 'email-changed'])('rejects a reset whose binding is %s', async scenario => {
    const user = await fixture(), { token, action } = await requestToken(user);
    if (scenario === 'expired') await db.authAction.update({ where: { id: action.id }, data: { expiresAt: new Date(0) } });
    if (scenario === 'suspended') await db.user.update({ where: { id: user.id }, data: { suspendedAt: new Date() } });
    if (scenario === 'password-changed') await db.user.update({ where: { id: user.id }, data: { passwordHash: 'rotated-credential-fixture' } });
    if (scenario === 'email-changed') await db.user.update({ where: { id: user.id }, data: { email: `${randomUUID()}@changed.kivro.local` } });
    const response = await post('/api/auth/password-reset/confirm', { token, newPassword: 'Replacement-password-2026!' });
    expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('INVALID_ACCOUNT_TOKEN');
  });
  it('verifies only the bound email, rejects wrong token kinds and does not create a session', async () => {
    const user = await fixture(), { token } = await requestToken(user, 'EMAIL_VERIFY');
    expect((await post('/api/auth/password-reset/confirm', { token, newPassword: 'Replacement-password-2026!' })).statusCode).toBe(400);
    const before = await db.session.count({ where: { userId: user.id } });
    expect((await post('/api/auth/email-verification/confirm', { token })).statusCode).toBe(200);
    expect((await post('/api/auth/email-verification/confirm', { token })).statusCode).toBe(400);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).not.toBeNull();
    expect(await db.session.count({ where: { userId: user.id } })).toBe(before);
    expect((await app.inject(`/api/auth/verify-email?token=${token}`)).statusCode).toBe(404);
  });
  it('protects profile and password updates against API keys, cross-site requests and incorrect current passwords', async () => {
    const user = await fixture();
    expect((await app.inject({ method: 'PUT', url: '/api/account', payload: { name: 'New name', bio: 'New bio' }, headers: { origin, cookie: `kivro_session=${user.session}` } })).json().user).toMatchObject({ name: 'New name', bio: 'New bio', emailVerifiedAt: null });
    expect((await app.inject({ method: 'PUT', url: '/api/account', payload: { name: 'No', bio: null }, headers: { authorization: `Bearer ${user.apiKey}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/account', payload: { name: 'No', bio: null }, headers: { origin: 'https://attacker.invalid', cookie: `kivro_session=${user.session}` } })).statusCode).toBe(403);
    expect((await post('/api/account/password', { currentPassword: 'Incorrect-password', newPassword: 'Replacement-password-2026!' }, user.session)).statusCode).toBe(400);
    const { token } = await requestToken(user);
    expect((await post('/api/account/password', { currentPassword: initialPassword, newPassword: 'Replacement-password-2026!' }, user.session)).statusCode).toBe(200);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect((await post('/api/auth/password-reset/confirm', { token, newPassword: initialPassword })).statusCode).toBe(400);
    expect(await db.apiKey.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  });
  it('recovers failed mail delivery, strips private errors and claims each delivery only once', async () => {
    // Clear bodies of preceding synthetic cases so this delivery batch is exact.
    await db.accountEmail.updateMany({ data: { payloadEncrypted: null } });
    const user = await fixture(), { action, token } = await requestToken(user);
    failDelivery = true;
    await deliverAccountEmails(app.kivro);
    const failed = await db.accountEmail.findUniqueOrThrow({ where: { actionId: action.id } });
    expect(failed).toMatchObject({ attempts: 1, lastError: 'ACCOUNT_EMAIL_DELIVERY_FAILED', deliveredAt: null });
    expect(JSON.stringify(failed)).not.toContain(token);
    failDelivery = false;
    await db.accountEmail.update({ where: { id: failed.id }, data: { nextAttemptAt: new Date(0) } });
    const before = delivered.length;
    await Promise.all([deliverAccountEmails(app.kivro), deliverAccountEmails(app.kivro)]);
    expect(delivered.length).toBe(before + 1);
    expect(delivered.at(-1)).toMatchObject({ id: failed.id, to: user.email });
    expect(delivered.at(-1)!.text).toContain(token);
    expect(await db.accountEmail.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ payloadEncrypted: null, attempts: 2, leaseId: null, lastError: null });
  });
  it('scrubs expired, exhausted and consumed queued messages without sending them', async () => {
    const before = delivered.length;
    for (const scenario of ['expired', 'exhausted', 'consumed']) {
      const user = await fixture(), { action } = await requestToken(user);
      if (scenario === 'expired') await db.authAction.update({ where: { id: action.id }, data: { expiresAt: new Date(0) } });
      if (scenario === 'consumed') await db.authAction.update({ where: { id: action.id }, data: { consumedAt: new Date() } });
      if (scenario === 'exhausted') await db.accountEmail.update({ where: { actionId: action.id }, data: { attempts: 5, nextAttemptAt: new Date(0) } });
    }
    await deliverAccountEmails(app.kivro);
    expect(delivered.length).toBe(before);
    expect(await db.accountEmail.count({ where: { payloadEncrypted: { not: null } } })).toBe(0);
  });
  it('delivers a real SMTP message to local Mailpit without external recipients', async () => {
    const mailer = createAccountMailer(readSmtpConfig({ NODE_ENV: 'development' }, true))!;
    const id = randomUUID(), recipient = `${id}@smtp.kivro.local`;
    try {
      await mailer.send({ id, to: recipient, subject: 'Kivro SMTP acceptance', text: `Synthetic SMTP transport acceptance ${id}` });
      const response = await fetch(`http://127.0.0.1:58025/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`);
      expect(response.ok).toBe(true);
      const result = await response.json() as { messages: { ID: string; Subject: string }[] };
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]!.Subject).toBe('Kivro SMTP acceptance');
    } finally { mailer.close?.(); }
  });
  it('requires explicit current terms before any paid reservation and audits acceptance once', async () => {
    const user = await fixture();
    const request = () => app.inject({ method: 'POST', url: '/api/jobs', headers: { origin, cookie: `kivro_session=${user.session}`, 'idempotency-key': randomUUID() },
      payload: { capabilityId: randomUUID(), input: {}, executionMode: 'NOW' } });
    expect((await request()).json().error.code).toBe('TERMS_ACCEPTANCE_REQUIRED');
    expect(await db.job.count({ where: { buyerId: user.id } })).toBe(0);
    const terms = (await app.inject('/api/terms')).json();
    expect(terms.preliminary).toBe(true);
    expect((await post('/api/account/terms', { version: 'stale' }, user.session)).statusCode).toBe(409);
    for (let i = 0; i < 2; i++) expect((await post('/api/account/terms', { version: terms.version }, user.session)).statusCode).toBe(200);
    expect(await db.auditEvent.count({ where: { actorId: user.id, type: 'MARKETPLACE_TERMS_ACCEPTED' } })).toBe(1);
    expect((await request()).json().error.code).toBe('NOT_FOUND');
    expect(await db.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ termsAcceptedVersion: terms.version, termsAcceptedHash: terms.sha256 });
    app.kivro.config.marketplaceTerms = { ...app.kivro.config.marketplaceTerms!, version: 'development-revised' };
    try { expect((await request()).json().error.code).toBe('TERMS_ACCEPTANCE_REQUIRED'); }
    finally { app.kivro.config.marketplaceTerms = terms; }
  });
});
