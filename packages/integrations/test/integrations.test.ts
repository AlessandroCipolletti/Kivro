import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { NetworkPolicyError, type HttpTransport } from '@kivro/research-broker';
import { authenticateApiKey, createApiKey, createWebhookEvent, createWebhookSecret, signWebhook, verifyWebhook,
  WebhookDispatcher, type WebhookEndpoint, type WebhookRepository } from '../src/index.js';

const now = new Date('2026-10-06T10:00:00.000Z');
const userId = randomUUID();
describe('hashed buyer API keys', () => {
  it('returns the full random secret only separately and stores a secure hash', async () => {
    const issued = createApiKey({ userId, name: 'automation', scopes: ['jobs:read'] }, now);
    expect(issued.record.secretHash).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(issued.record)).not.toContain(issued.secret);
    const repository = { getById: vi.fn(async () => issued.record), touch: vi.fn(async () => {}) };
    await expect(authenticateApiKey(issued.secret, ['jobs:read'], repository, now)).resolves.toMatchObject({ userId });
    expect(repository.touch).toHaveBeenCalledWith(issued.record.id, now.toISOString());
    await expect(authenticateApiKey(issued.secret, ['jobs:create'], repository, now)).rejects.toThrow('INSUFFICIENT_SCOPE');
  });
  it('rejects altered, revoked and expired keys and seller scopes', async () => {
    const issued = createApiKey({ userId, name: 'automation', scopes: ['jobs:read'] }, now);
    const repo = { getById: async () => issued.record, touch: vi.fn(async () => {}) };
    const altered = issued.secret.slice(0, -1) + (issued.secret.endsWith('x') ? 'y' : 'x');
    await expect(authenticateApiKey(altered, [], repo, now)).rejects.toThrow('INVALID_API_KEY');
    issued.record.revokedAt = now.toISOString();
    await expect(authenticateApiKey(issued.secret, [], repo, now)).rejects.toThrow('INVALID_API_KEY');
    issued.record.revokedAt = null; issued.record.expiresAt = now.toISOString();
    await expect(authenticateApiKey(issued.secret, [], repo, now)).rejects.toThrow('INVALID_API_KEY');
    expect(() => createApiKey({ userId, name: 'worker', scopes: ['worker:execute' as never] })).toThrow();
    expect(repo.touch).not.toHaveBeenCalled();
  });
});
describe('webhook signatures', () => {
  it('covers exact raw bytes and timestamp, with event ID binding', () => {
    const secret = createWebhookSecret(); const event = createWebhookEvent('job.completed', { jobId: randomUUID(), status: 'SUCCEEDED' }, now);
    const rawBody = JSON.stringify(event); const timestamp = String(Math.floor(now.getTime() / 1000));
    const signature = signWebhook(secret, timestamp, rawBody);
    expect(verifyWebhook({ secret, timestamp, signature, rawBody, eventId: event.id, now })).toEqual(event);
    expect(() => verifyWebhook({ secret, timestamp, signature, rawBody: rawBody + ' ', now })).toThrow('INVALID_WEBHOOK_SIGNATURE');
    expect(() => verifyWebhook({ secret, timestamp, signature, rawBody, eventId: randomUUID(), now })).toThrow('INVALID_WEBHOOK_EVENT');
    expect(() => verifyWebhook({ secret, timestamp, signature, rawBody, now: new Date(now.getTime() + 301000) })).toThrow('EXPIRED_WEBHOOK_SIGNATURE');
    expect(() => verifyWebhook({ secret, timestamp, signature: 'v1=garbage', rawBody, now })).toThrow('INVALID_WEBHOOK_SIGNATURE');
  });
  it('does not permit large job results or undeclared payload fields', () => {
    expect(() => createWebhookEvent('job.completed', { jobId: randomUUID(), status: 'SUCCEEDED', result: 'private output' } as never, now)).toThrow();
    expect(() => createWebhookEvent('job.completed', { status: 'SUCCEEDED' }, now)).toThrow();
  });
});
function dispatcherSetup(status = 200) {
  const secret = createWebhookSecret(); const event = createWebhookEvent('job.completed', { jobId: randomUUID(), status: 'SUCCEEDED' }, now);
  const endpoint: WebhookEndpoint = { id: randomUUID(), userId, url: 'https://receiver.example/events', enabled: true, events: ['job.completed'], secretRef: 'encrypted-ref' };
  const delivery = { id: randomUUID(), endpointId: endpoint.id, userId, event, attempts: 0, leaseToken: randomUUID() };
  const repository: WebhookRepository = { claimDue: vi.fn(async () => [delivery]), getEndpoint: vi.fn(async () => endpoint), finish: vi.fn(async () => {}) };
  const http: HttpTransport = { request: vi.fn(async () => ({ status, body: Buffer.from('private receiver response'), headers: {}, finalUrl: endpoint.url })) };
  const dispatcher = new WebhookDispatcher({ repository, http, readSecret: async () => secret, now: () => now, retryDelaysMs: [1000, 2000] });
  return { dispatcher, repository, http, secret, event, endpoint, delivery };
}
describe('durable webhook delivery', () => {
  it('sends a signed HTTPS-only nonredirecting request and stores no response body', async () => {
    const h = dispatcherSetup(); await h.dispatcher.dispatchDue();
    const request = vi.mocked(h.http.request).mock.calls[0]![0];
    expect(request).toMatchObject({ httpsOnly: true, maxRedirects: 0, method: 'POST', timeoutMs: 10000 });
    expect(verifyWebhook({ secret: h.secret, timestamp: request.headers!['kivro-timestamp']!, signature: request.headers!['kivro-signature']!,
      rawBody: request.body!, eventId: h.event.id, now })).toEqual(h.event);
    expect(h.repository.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'SUCCEEDED', leaseToken: h.delivery.leaseToken }));
    expect(JSON.stringify(vi.mocked(h.repository.finish).mock.calls)).not.toContain('private receiver response');
  });
  it('persists bounded exponential retry scheduling across restarts', async () => {
    const h = dispatcherSetup(503); await h.dispatcher.dispatchDue();
    expect(h.repository.finish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'RETRY', nextAttemptAt: '2026-10-06T10:00:01.000Z' }));
    h.delivery.attempts = 1; await h.dispatcher.dispatchDue();
    expect(h.repository.finish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'RETRY', nextAttemptAt: '2026-10-06T10:00:02.000Z' }));
    h.delivery.attempts = 2; await h.dispatcher.dispatchDue();
    expect(h.repository.finish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'DEAD', disableEndpoint: true, nextAttemptAt: null }));
  });
  it('disables private/SSRF endpoints immediately', async () => {
    const h = dispatcherSetup(); vi.mocked(h.http.request).mockRejectedValue(new NetworkPolicyError('PRIVATE_DESTINATION_DENIED'));
    await h.dispatcher.dispatchDue();
    expect(h.repository.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'DEAD', disableEndpoint: true, failureCode: 'PRIVATE_DESTINATION_DENIED' }));
  });
  it('never delivers a buyer event to another buyer endpoint or disabled subscription', async () => {
    const h = dispatcherSetup(); h.endpoint.userId = randomUUID(); await h.dispatcher.dispatchDue();
    expect(h.http.request).not.toHaveBeenCalled();
    expect(h.repository.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'DEAD', failureCode: 'ENDPOINT_UNAVAILABLE' }));
  });
});
