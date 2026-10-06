import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

const uuid = z.string().uuid();
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

// Job.id is the canonical persisted trace identity; attempt/asset/ledger jobId
// foreign keys preserve it without a second mutable correlation column.
export function responseJobCorrelation(method: string, path: string, body: unknown): string | undefined {
  const route = new URL(path, 'http://correlation.invalid').pathname.replace(/^\/api\/v1\//, '/api/');
  const match = /^\/api\/(?:worker\/)?jobs\/([a-f0-9-]{36})(?:\/|$)/i.exec(route);
  if (match) return uuid.safeParse(match[1]).success ? match[1] : undefined;
  if (method === 'POST' && route === '/api/jobs') {
    const parsed = uuid.safeParse(object(body)?.id); return parsed.success ? parsed.data : undefined;
  }
  if (method === 'GET' && route === '/api/worker/offers') {
    const offers = object(body)?.offers;
    if (Array.isArray(offers) && offers.length === 1) {
      const parsed = uuid.safeParse(object(object(offers[0])?.payload)?.jobId); return parsed.success ? parsed.data : undefined;
    }
  }
  return undefined;
}

export function registerJobCorrelation(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode >= 400 || typeof payload !== 'string') return payload;
    let body: unknown;
    try { body = JSON.parse(payload); } catch { return payload; }
    const correlationId = responseJobCorrelation(request.method, request.url, body);
    if (correlationId) {
      reply.header('x-kivro-correlation-id', correlationId);
      app.log.info({ event: 'JOB_HTTP_RESPONSE', correlationId, requestId: request.id,
        method: request.method, route: request.routeOptions.url, statusCode: reply.statusCode }, 'Job request completed');
    }
    return payload;
  });
}
