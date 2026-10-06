import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import { resolvePublicUrl } from '@kivro/policy-engine';
import { json, serializable } from '@kivro/database';
import type { FastifyInstance } from 'fastify';
import type { ApiContext } from './context.js';
import { requireIdentity } from './auth.js';
import { ApiError } from './errors.js';

export const WEBHOOK_EVENTS = ['job.scheduled', 'job.eligible', 'job.started', 'job.completed', 'job.failed', 'job.cancelled', 'job.expired', 'job.schedule_changed', 'job.paused', 'job.resuming'] as const;
export const webhookSignature = (secret: string, timestamp: string, body: string) => createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
export function encryptSecret(secret: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${ciphertext.toString('hex')}`;
}
export function decryptSecret(encrypted: string, key: string): string {
  const [iv, tag, body] = encrypted.split('.');
  if (!iv || !tag || !body) throw new Error('Invalid encrypted webhook secret');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'));
  cipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([cipher.update(Buffer.from(body, 'hex')), cipher.final()]).toString('utf8');
}
export async function webhookKey(ctx: ApiContext): Promise<string> {
  if (ctx.config.webhookEncryptionKey) return ctx.config.webhookEncryptionKey;
  if (!ctx.config.development) throw new Error('WEBHOOK_ENCRYPTION_KEY is required');
  const setting = await ctx.db.platformSetting.upsert({ where: { key: 'developmentWebhookEncryptionKey' }, update: {},
    create: { key: 'developmentWebhookEncryptionKey', value: randomBytes(32).toString('hex') } });
  return z.string().parse(setting.value);
}

export async function postWebhook(urlString: string, body: string, headers: Record<string, string>): Promise<number> {
  const { url, addresses } = await resolvePublicUrl(urlString);
  if (url.protocol !== 'https:') throw new Error('Webhook endpoints require HTTPS');
  const address = addresses[0]!;
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: 'POST', agent: false, timeout: 10_000,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      headers: { ...headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } }, response => {
      const status = response.statusCode ?? 0;
      let received = 0;
      response.on('data', chunk => { received += chunk.length; if (received > 8192) response.destroy(); });
      response.once('error', () => resolve(status));
      response.once('end', () => resolve(status));
      response.once('close', () => resolve(status));
    });
    request.once('timeout', () => request.destroy(new Error('Webhook request timed out')));
    request.once('error', reject);
    request.end(body);
  });
}

export async function deliverWebhooks(ctx: ApiContext, send = postWebhook): Promise<void> {
  await ctx.db.webhookDelivery.updateMany({ where: { attempts: { gte: 7 }, nextAttemptAt: { lte: new Date() }, deliveredAt: null, failedAt: null },
    data: { failedAt: new Date(), lastError: 'RETRIES_EXHAUSTED' } });
  await serializable(ctx.db, async tx => {
    const events = await tx.outboxEvent.findMany({ where: { processedAt: null }, take: 100, orderBy: { createdAt: 'asc' } });
    for (const event of events) {
      const endpoints = await tx.webhookEndpoint.findMany({ where: { userId: event.userId, enabled: true, events: { has: event.type } } });
      await tx.webhookDelivery.createMany({ skipDuplicates: true, data: endpoints.map(endpoint => ({ endpointId: endpoint.id, eventId: event.id,
        payload: json({ id: event.id, type: event.type, createdAt: event.createdAt.toISOString(), data: event.payload }) })) });
      await tx.outboxEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
    }
  });
  const deliveries = await ctx.db.webhookDelivery.findMany({ where: { deliveredAt: null, failedAt: null, attempts: { lt: 7 }, nextAttemptAt: { lte: new Date() }, endpoint: { enabled: true } }, take: 10, include: { endpoint: true } });
  if (!deliveries.length) return;
  const key = await webhookKey(ctx);
  const delays = [60, 300, 1800, 7200, 28800, 86400, 86400];
  for (const delivery of deliveries) {
    const claim = await ctx.db.webhookDelivery.updateMany({ where: { id: delivery.id, attempts: delivery.attempts, nextAttemptAt: { lte: new Date() } },
      data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + delays[delivery.attempts]! * 1000) } });
    if (!claim.count) continue;
    let status: number | null = null;
    let error: string | null = null;
    try {
      const body = JSON.stringify(delivery.payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const secret = decryptSecret(delivery.endpoint.secretEncrypted, key);
      status = await send(delivery.endpoint.url, body, { 'kivro-event-id': delivery.eventId, 'kivro-timestamp': timestamp,
        'kivro-signature': `v1=${webhookSignature(secret, timestamp, body)}` });
      if (status < 200 || status >= 300) error = `HTTP_${status}`;
    } catch { error = 'DELIVERY_FAILED'; }
    await ctx.db.$transaction([
      ctx.db.webhookDelivery.update({ where: { id: delivery.id }, data: { lastStatus: status, lastError: error, deliveredAt: error ? null : new Date(), failedAt: error && delivery.attempts >= 6 ? new Date() : null } }),
      ctx.db.webhookEndpoint.update({ where: { id: delivery.endpointId }, data: error ? { lastFailureAt: new Date(), failureCount: { increment: 1 }, ...(delivery.endpoint.failureCount >= 19 ? { enabled: false } : {}) } : { lastSuccessAt: new Date(), failureCount: 0 } }),
    ]);
  }
}

export function registerWebhooks(app: FastifyInstance, ctx: ApiContext) {
  app.get('/api/webhooks', async request => {
    const { user } = requireIdentity(request, 'webhooks:manage');
    const endpoints = await ctx.db.webhookEndpoint.findMany({ where: { userId: user.id }, select: {
      id: true, url: true, events: true, enabled: true, failureCount: true, lastSuccessAt: true, lastFailureAt: true, createdAt: true,
      deliveries: { take: 20, orderBy: { nextAttemptAt: 'desc' }, select: { id: true, eventId: true, attempts: true, deliveredAt: true, failedAt: true, lastStatus: true, lastError: true, nextAttemptAt: true } },
    } });
    return endpoints.map(endpoint => ({ ...endpoint, status: !endpoint.enabled ? 'DISABLED' : endpoint.failureCount ? 'DEGRADED' : 'ACTIVE',
      deliveries: endpoint.deliveries.map(delivery => ({ ...delivery, status: delivery.deliveredAt ? 'DELIVERED' : delivery.failedAt ? 'FAILED' : !endpoint.enabled ? 'DISABLED' : delivery.attempts ? 'RETRYING' : 'PENDING' })) }));
  });
  app.post('/api/webhooks/:id/test', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    const { user } = requireIdentity(request, 'webhooks:manage');
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    z.object({}).strict().parse(request.body);
    const delivery = await serializable(ctx.db, async tx => {
      const endpoint = await tx.webhookEndpoint.findFirst({ where: { id, userId: user.id, enabled: true } });
      if (!endpoint) throw new ApiError(404, 'NOT_FOUND', 'Active webhook endpoint not found');
      const event = await tx.outboxEvent.create({ data: { userId: user.id, type: 'webhook.test', payload: { test: true }, processedAt: new Date() } });
      const created = await tx.webhookDelivery.create({ data: { endpointId: id, eventId: event.id,
        payload: { id: event.id, type: event.type, createdAt: event.createdAt.toISOString(), data: { test: true } } } });
      await tx.auditEvent.create({ data: { actorId: user.id, type: 'WEBHOOK_TEST_REQUESTED', metadata: { endpointId: id, deliveryId: created.id } } });
      return created;
    });
    await ctx.wake(); return { deliveryId: delivery.id, status: 'PENDING' };
  });
  app.post('/api/webhooks', async request => {
    const { user } = requireIdentity(request, 'webhooks:manage');
    const body = z.object({ url: z.string().url().max(2048), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length) }).strict().parse(request.body);
    const { url } = await resolvePublicUrl(body.url);
    if (url.protocol !== 'https:') throw new ApiError(400, 'HTTPS_REQUIRED', 'Webhook endpoints require HTTPS');
    if (await ctx.db.webhookEndpoint.count({ where: { userId: user.id, enabled: true } }) >= 10) throw new ApiError(409, 'WEBHOOK_LIMIT', 'At most ten active webhook endpoints are allowed');
    const secret = randomBytes(32).toString('base64url');
    const endpoint = await ctx.db.webhookEndpoint.create({ data: { userId: user.id, url: url.toString(), events: [...new Set(body.events)], secretEncrypted: encryptSecret(secret, await webhookKey(ctx)) } });
    return { id: endpoint.id, url: endpoint.url, events: endpoint.events, enabled: true, secret };
  });
  const remove = async (request: import('fastify').FastifyRequest) => {
    const { user } = requireIdentity(request, 'webhooks:manage');
    const id = z.string().uuid().parse((request.params as { id?: string }).id ?? (request.body as { id?: string })?.id);
    await ctx.db.webhookEndpoint.updateMany({ where: { id, userId: user.id }, data: { enabled: false } });
    return { ok: true };
  };
  app.delete('/api/webhooks', remove);
  app.delete('/api/webhooks/:id', remove);
}
