import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { NetworkPolicyError, SafeHttpClient, type HttpTransport } from '@kivro/research-broker';
import { IntegrationError } from './api-keys.js';

export const WebhookEventTypeSchema = z.enum(['job.completed', 'job.failed', 'job.cancelled', 'job.started', 'orchestration.completed', 'orchestration.failed']);
export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;
export const WebhookEventSchema = z.object({ id: z.string().uuid(), type: WebhookEventTypeSchema, createdAt: z.string().datetime(),
  data: z.object({ jobId: z.string().uuid().optional(), orchestrationId: z.string().uuid().optional(),
    capabilityId: z.string().uuid().optional(), capabilityVersionId: z.string().uuid().optional(), status: z.string().min(1).max(64) }).strict(),
}).strict().superRefine((event, context) => {
  if (event.type.startsWith('job.') ? !event.data.jobId : !event.data.orchestrationId) {
    context.addIssue({ code: 'custom', message: 'An event must identify its resource.' });
  }
});
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
export interface WebhookEndpoint {
  id: string; userId: string; url: string; events: WebhookEventType[]; enabled: boolean;
  /** Opaque reference to encrypted server storage, never plaintext in a public DTO. */
  secretRef: string;
}
export interface WebhookDelivery {
  id: string; endpointId: string; userId: string; event: WebhookEvent;
  /** Number of completed attempts before this claimed attempt. */
  attempts: number; leaseToken: string;
}
export interface WebhookRepository {
  /** Durable lease claim (e.g. SKIP LOCKED), including lease expiry for crash recovery. */
  claimDue(request: { now: string; limit: number; leaseMs: number }): Promise<WebhookDelivery[]>;
  getEndpoint(id: string): Promise<WebhookEndpoint | null>;
  /** Compare lease token atomically; increment attempts once and retain only safe metadata. */
  finish(request: { deliveryId: string; leaseToken: string; status: 'SUCCEEDED' | 'RETRY' | 'DEAD';
    attemptedAt: string; nextAttemptAt: string | null; responseStatus?: number; failureCode?: string; disableEndpoint?: boolean }): Promise<void>;
}
export function createWebhookSecret(): string { return randomBytes(32).toString('base64url'); }
function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new IntegrationError('INVALID_WEBHOOK_SECRET');
}
export function signWebhook(secret: string, timestamp: string, rawBody: string | Buffer): string {
  assertSecret(secret);
  if (!/^\d{1,12}$/.test(timestamp)) throw new IntegrationError('INVALID_WEBHOOK_TIMESTAMP');
  return `v1=${createHmac('sha256', secret).update(timestamp).update('.').update(rawBody).digest('hex')}`;
}
/** Verify raw bytes before JSON parsing. Consumer must durably deduplicate returned event.id. */
export function verifyWebhook(request: { secret: string; timestamp: string; signature: string; rawBody: string | Buffer;
  eventId?: string; toleranceSeconds?: number; now?: Date }): WebhookEvent {
  const tolerance = request.toleranceSeconds ?? 300;
  if (!Number.isSafeInteger(tolerance) || tolerance < 1 || tolerance > 900 || Buffer.byteLength(request.rawBody) > 32000 ||
    !/^\d{1,12}$/.test(request.timestamp) || !/^v1=[a-f0-9]{64}$/.test(request.signature)) throw new IntegrationError('INVALID_WEBHOOK_SIGNATURE');
  const timestamp = Number(request.timestamp); const current = Math.floor((request.now ?? new Date()).getTime() / 1000);
  if (Math.abs(timestamp - current) > tolerance) throw new IntegrationError('EXPIRED_WEBHOOK_SIGNATURE');
  const expected = Buffer.from(signWebhook(request.secret, request.timestamp, request.rawBody).slice(3), 'hex');
  const actual = Buffer.from(request.signature.slice(3), 'hex');
  if (!timingSafeEqual(expected, actual)) throw new IntegrationError('INVALID_WEBHOOK_SIGNATURE');
  let event: WebhookEvent;
  try { event = WebhookEventSchema.parse(JSON.parse(request.rawBody.toString())); }
  catch { throw new IntegrationError('INVALID_WEBHOOK_EVENT'); }
  if (request.eventId && request.eventId !== event.id) throw new IntegrationError('INVALID_WEBHOOK_EVENT');
  return event;
}
export function createWebhookEvent(type: WebhookEventType, data: WebhookEvent['data'], now = new Date()): WebhookEvent {
  return WebhookEventSchema.parse({ id: randomUUID(), type, data, createdAt: now.toISOString() });
}
export async function validateWebhookEndpoint(url: string, client = new SafeHttpClient()): Promise<void> {
  await client.validateUrl(url, { httpsOnly: true });
}

export class WebhookDispatcher {
  private readonly http: HttpTransport;
  private readonly retryDelays: readonly number[];
  constructor(private readonly options: { repository: WebhookRepository; readSecret(ref: string): Promise<string>;
    http?: HttpTransport; retryDelaysMs?: readonly number[]; now?: () => Date }) {
    this.http = options.http ?? new SafeHttpClient();
    this.retryDelays = options.retryDelaysMs ?? [60_000, 300_000, 1_800_000, 7_200_000, 28_800_000, 86_400_000];
    if (this.retryDelays.length > 10 || this.retryDelays.some(delay => !Number.isSafeInteger(delay) || delay < 1000 || delay > 86_400_000)) {
      throw new IntegrationError('INVALID_RETRY_SCHEDULE');
    }
  }
  /** One durable queue tick. No detached timers, hidden retry loops or response-body logging. */
  async dispatchDue(limit = 20): Promise<{ processed: number }> {
    z.number().int().min(1).max(100).parse(limit);
    const deliveries = await this.options.repository.claimDue({ now: this.now().toISOString(), limit, leaseMs: 60_000 });
    // Claim only work that can start immediately; each request is capped at ten seconds.
    await Promise.all(deliveries.map(delivery => this.deliver(delivery)));
    return { processed: deliveries.length };
  }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  private async deliver(delivery: WebhookDelivery): Promise<void> {
    if (!Number.isSafeInteger(delivery.attempts) || delivery.attempts < 0) throw new IntegrationError('INVALID_DELIVERY');
    const endpoint = await this.options.repository.getEndpoint(delivery.endpointId);
    if (!endpoint || endpoint.id !== delivery.endpointId || endpoint.userId !== delivery.userId || !endpoint.enabled || !endpoint.events.includes(delivery.event.type)) {
      await this.finish(delivery, 'DEAD', undefined, 'ENDPOINT_UNAVAILABLE'); return;
    }
    let responseStatus: number | undefined; let code: string | undefined; let policyDenied = false;
    try {
      const event = WebhookEventSchema.parse(delivery.event);
      const body = JSON.stringify(event);
      if (Buffer.byteLength(body) > 32000) throw new IntegrationError('INVALID_WEBHOOK_EVENT');
      const timestamp = String(Math.floor(this.now().getTime() / 1000));
      const signature = signWebhook(await this.options.readSecret(endpoint.secretRef), timestamp, body);
      const response = await this.http.request({ url: endpoint.url, method: 'POST', httpsOnly: true, maxRedirects: 0,
        maxBytes: 16_384, timeoutMs: 10_000, body, headers: { 'content-type': 'application/json',
          'kivro-event-id': event.id, 'kivro-timestamp': timestamp, 'kivro-signature': signature } });
      responseStatus = response.status;
      if (responseStatus < 200 || responseStatus >= 300) code = 'HTTP_DELIVERY_FAILED';
    } catch (error) {
      code = error instanceof NetworkPolicyError ? error.code : 'DELIVERY_FAILED';
      policyDenied = error instanceof z.ZodError || error instanceof IntegrationError ||
        (error instanceof NetworkPolicyError && ['NETWORK_POLICY_DENIED', 'PRIVATE_DESTINATION_DENIED'].includes(error.code));
    }
    if (!code) { await this.finish(delivery, 'SUCCEEDED', responseStatus); return; }
    const dead = policyDenied || responseStatus === 410 || delivery.attempts >= this.retryDelays.length;
    await this.finish(delivery, dead ? 'DEAD' : 'RETRY', responseStatus, code, dead);
  }
  private async finish(delivery: WebhookDelivery, status: 'SUCCEEDED' | 'RETRY' | 'DEAD', responseStatus?: number,
    failureCode?: string, disableEndpoint = false): Promise<void> {
    const now = this.now();
    await this.options.repository.finish({ deliveryId: delivery.id, leaseToken: delivery.leaseToken, status,
      attemptedAt: now.toISOString(), nextAttemptAt: status === 'RETRY' ? new Date(now.getTime() + this.retryDelays[delivery.attempts]!).toISOString() : null,
      responseStatus, failureCode, disableEndpoint });
  }
}
