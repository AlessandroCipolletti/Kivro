import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import type { ApiContext } from './context.js';
import { decryptSecret, webhookKey } from './webhooks.js';

const MessageSchema = z.object({ to: z.string().email().max(254), subject: z.string().max(200), text: z.string().max(4000) }).strict();
export type AccountMessage = z.infer<typeof MessageSchema> & { id: string };
export interface AccountMailer { send(message: AccountMessage): Promise<void>; close?(): void }

export function readSmtpConfig(env: NodeJS.ProcessEnv, development: boolean) {
  const host = env.SMTP_HOST ?? (development && env.NODE_ENV !== 'test' ? '127.0.0.1' : undefined);
  if (!host) return null;
  if (!/^[a-zA-Z0-9.:-]+$/.test(host)) throw new Error('SMTP_HOST must be a hostname or IP address');
  const secure = env.SMTP_SECURE === 'true';
  const requireTLS = env.SMTP_REQUIRE_TLS !== 'false';
  const port = Number(env.SMTP_PORT ?? (development ? 51025 : secure ? 465 : 587));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SMTP_PORT');
  for (const flag of ['SMTP_SECURE', 'SMTP_REQUIRE_TLS']) if (env[flag] && !['true', 'false'].includes(env[flag]!)) throw new Error(`Invalid ${flag}`);
  const local = development && ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!local && !secure && !requireTLS) throw new Error('Remote SMTP requires verified TLS');
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) throw new Error('SMTP_USER and SMTP_PASSWORD must be configured together');
  const from = z.string().email().max(254).parse(env.SMTP_FROM ?? (development ? 'accounts@kivro.local' : undefined));
  return { host, port, secure, requireTLS: local && env.SMTP_REQUIRE_TLS === undefined ? false : requireTLS,
    from, user: env.SMTP_USER, password: env.SMTP_PASSWORD };
}

export function createAccountMailer(config: ReturnType<typeof readSmtpConfig>): AccountMailer | null {
  if (!config) return null;
  const transport = nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure,
    requireTLS: config.requireTLS, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    ...(config.user ? { auth: { user: config.user, pass: config.password! } } : {}),
    disableFileAccess: true, disableUrlAccess: true,
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 20_000, dnsTimeout: 5000 });
  return {
    async send(message) {
      const safe = MessageSchema.parse({ to: message.to, subject: message.subject, text: message.text });
      const result = await transport.sendMail({ ...safe, from: config.from,
        messageId: `<${z.string().uuid().parse(message.id)}@${config.from.split('@')[1]}>` });
      if (!result.accepted.length || result.rejected.length) throw new Error('SMTP_RECIPIENT_REJECTED');
    },
    close: () => transport.close(),
  };
}

export async function deliverAccountEmails(ctx: ApiContext): Promise<void> {
  const now = new Date();
  await ctx.db.accountEmail.updateMany({ where: { payloadEncrypted: { not: null }, OR: [
    { action: { expiresAt: { lte: now } } }, { action: { consumedAt: { not: null } } },
    { action: { user: { suspendedAt: { not: null } } } }, { attempts: { gte: 5 }, nextAttemptAt: { lte: now } },
  ] }, data: { payloadEncrypted: null, leaseId: null } });
  // Retain only a short diagnostic window, without recoverable message bodies.
  await ctx.db.authAction.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 7 * 86400_000) } } });
  if (!ctx.mailer) return;
  const emails = await ctx.db.accountEmail.findMany({ where: { payloadEncrypted: { not: null }, deliveredAt: null,
    attempts: { lt: 5 }, nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: 'asc' }, take: 10 });
  if (!emails.length) return;
  const key = await webhookKey(ctx);
  for (const email of emails) {
    const leaseId = randomUUID();
    const claim = await ctx.db.accountEmail.updateMany({ where: { id: email.id, attempts: email.attempts,
      payloadEncrypted: { not: null }, nextAttemptAt: { lte: new Date() },
      action: { consumedAt: null, expiresAt: { gt: new Date() }, user: { suspendedAt: null } } },
      data: { leaseId, attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 120_000) } });
    if (!claim.count) continue;
    try {
      const message = MessageSchema.parse(JSON.parse(decryptSecret(email.payloadEncrypted!, key)));
      await ctx.mailer.send({ id: email.id, ...message });
      await ctx.db.accountEmail.updateMany({ where: { id: email.id, leaseId },
        data: { deliveredAt: new Date(), payloadEncrypted: null, leaseId: null, lastError: null } });
    } catch {
      // Never log SMTP errors: providers can include recipients or message data.
      await ctx.db.accountEmail.updateMany({ where: { id: email.id, leaseId }, data: { leaseId: null,
        lastError: 'ACCOUNT_EMAIL_DELIVERY_FAILED', nextAttemptAt: new Date(Date.now() + [5, 15, 60, 300, 300][email.attempts]! * 1000),
        ...(email.attempts >= 4 ? { payloadEncrypted: null } : {}) } });
    }
  }
}
