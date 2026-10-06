import Fastify from 'fastify';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { registerResponseValidation } from '../src/response-validation.js';
import { ApiError } from '../src/errors.js';

const instances: ReturnType<typeof Fastify>[] = [];
const fixture = () => {
  const app = Fastify(); instances.push(app);
  registerResponseValidation(app);
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ApiError ? error.statusCode : 500)
    .send({ error: { code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR', message: 'Response unavailable' } }));
  return app;
};
afterEach(async () => { for (const app of instances.splice(0)) await app.close(); });
describe('server response boundary', () => {
  it('validates a serialized DTO, including Date conversion, without exposing private ORM fields', async () => {
    const app = fixture();
    app.get('/api/health', async () => ({ status: 'ok', service: 'kivro-api', serverTime: new Date('2026-10-06T10:00:00Z') }));
    const result = await app.inject('/api/health');
    expect(result.statusCode).toBe(200); expect(result.json().serverTime).toBe('2026-10-06T10:00:00.000Z');
  });
  it.each([
    { user: { passwordHash: 'PRIVATE_MARKER' } },
    { user: null, extra: 'PRIVATE_MARKER' },
    'PRIVATE_MARKER',
  ])('replaces a malformed response with a bounded error and never leaks rejected data', async payload => {
    const app = fixture(); app.get('/api/auth/me', async () => payload);
    const result = await app.inject('/api/auth/me');
    expect(result.statusCode).toBe(500); expect(result.json().error.code).toBe('RESPONSE_CONTRACT_FAILED');
    expect(result.body).not.toContain('PRIVATE_MARKER'); expect(result.body).not.toContain('passwordHash');
  });
  it('cannot bypass validation by sending a buffer from a JSON endpoint', async () => {
    const app = fixture(); app.get('/api/auth/me', async (_request, reply) => reply.type('application/octet-stream').send(Buffer.from('PRIVATE_MARKER')));
    const result = await app.inject('/api/auth/me');
    expect(result.statusCode).toBe(500); expect(result.body).not.toContain('PRIVATE_MARKER');
  });
  it('refuses to register a new endpoint without its response contract', () => {
    const app = fixture();
    expect(() => app.get('/api/new-unreviewed-endpoint', async () => ({ private: 'PRIVATE_MARKER' }))).toThrow('RESPONSE_SCHEMA_MISSING');
    expect(() => app.get('/api/not-a-schema', { config: { responseContract: 'trusted' } }, async () => ({}))).toThrow('RESPONSE_SCHEMA_MISSING');
  });
  it('validates an explicitly declared local route schema without weakening a shared route', async () => {
    const app = fixture();
    app.get('/local-probe', { config: { responseContract: z.object({ ok: z.literal(true) }).strict() } }, async () => ({ ok: true }));
    app.get('/local-broken', { config: { responseContract: z.object({ ok: z.literal(true) }).strict() } }, async () => ({ ok: false }));
    app.get('/api/auth/me', { config: { responseContract: z.unknown() } }, async () => ({ secret: 'PRIVATE_MARKER' }));
    expect((await app.inject('/local-probe')).statusCode).toBe(200);
    expect((await app.inject('/local-broken')).statusCode).toBe(500);
    const shared = await app.inject('/api/auth/me');
    expect(shared.statusCode).toBe(500); expect(shared.body).not.toContain('PRIVATE_MARKER');
  });
  it('preserves authorized binary responses and still validates their errors', async () => {
    const app = fixture();
    app.get('/api/worker/assets/:id/download', async (request, reply) => {
      if ((request.params as { id: string }).id === 'missing') throw new ApiError(404, 'NOT_FOUND', 'Missing');
      return reply.type('application/octet-stream').send(Buffer.from('synthetic file'));
    });
    const file = await app.inject('/api/worker/assets/test/download'), error = await app.inject('/api/worker/assets/missing/download');
    expect(file.statusCode).toBe(200); expect(file.body).toBe('synthetic file');
    expect(error.statusCode).toBe(404); expect(error.json().error.code).toBe('NOT_FOUND');
  });
});
