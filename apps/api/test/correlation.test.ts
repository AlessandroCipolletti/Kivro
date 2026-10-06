import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerJobCorrelation, responseJobCorrelation } from '../src/correlation.js';

describe('canonical job correlation', () => {
  const id = randomUUID();
  it('uses the persisted job identity across creation, v1 polling, Worker messages and output upload', () => {
    for (const [method, path, body] of [
      ['POST', '/api/jobs', { id }], ['GET', `/api/v1/jobs/${id}?ignored=private`, {}],
      ['POST', `/api/worker/jobs/${id}/events`, {}], ['POST', `/api/worker/jobs/${id}/uploads/${randomUUID()}/finalize`, {}],
      ['GET', '/api/worker/offers', { offers: [{ payload: { jobId: id } }] }],
    ] as const) expect(responseJobCorrelation(method, path, body)).toBe(id);
  });
  it('does not invent a single-job trace for lists or unrelated resources', () => {
    for (const [method, path, body] of [
      ['GET', '/api/jobs', [{ id }]], ['POST', '/api/assets/uploads', { id }],
      ['GET', '/api/worker/offers', { offers: [{ payload: { jobId: id } }, { payload: { jobId: randomUUID() } }] }],
      ['POST', '/api/jobs', { id: 'PRIVATE_MARKER' }], ['GET', '/api/jobs/invalid', {}],
    ] as const) expect(responseJobCorrelation(method, path, body)).toBeUndefined();
  });
  it('ignores caller correlation headers and logs only approved metadata after success', async () => {
    const app = Fastify({ logger: false, disableRequestLogging: true }); registerJobCorrelation(app);
    const log = vi.spyOn(app.log, 'info');
    app.post('/api/jobs', async () => ({ id }));
    app.get('/api/worker/jobs/:id/payload', async (_request, reply) => reply.code(404).send({ error: 'not found' }));
    try {
      const response = await app.inject({ method: 'POST', url: '/api/jobs', headers: { 'x-kivro-correlation-id': 'PRIVATE_MARKER', authorization: 'PRIVATE_MARKER' }, payload: { text: 'PRIVATE_MARKER' } });
      expect(response.headers['x-kivro-correlation-id']).toBe(id);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'JOB_HTTP_RESPONSE', correlationId: id, route: '/api/jobs' }), 'Job request completed');
      expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_MARKER');
      const denied = await app.inject(`/api/worker/jobs/${id}/payload`);
      expect(denied.headers).not.toHaveProperty('x-kivro-correlation-id'); expect(log).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
});
