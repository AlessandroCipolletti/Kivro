import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword, hashSecret } from '../src/auth.js';
import { readConfig } from '../src/config.js';
import { authenticateWorker, canonicalWorkerRequest } from '../src/worker.js';
import type { ApiContext } from '../src/context.js';
import type { FastifyRequest } from 'fastify';
import { encryptSecret, decryptSecret, webhookSignature } from '../src/webhooks.js';
import { createApp } from '../src/app.js';

describe('API security primitives', () => {
  it('uses salted, memory-hard password hashes and rejects invalid encodings', async () => {
    const one = await hashPassword('a-long-test-password');
    const two = await hashPassword('a-long-test-password');
    expect(one).not.toEqual(two);
    expect(await verifyPassword('a-long-test-password', one)).toBe(true);
    expect(await verifyPassword('wrong-password', one)).toBe(false);
    expect(await verifyPassword('anything', 'plaintext')).toBe(false);
    expect(hashSecret('api-key')).not.toContain('api-key');
  });
  it('never silently enables fake payments or development auth', () => {
    expect(() => readConfig({ PAYMENT_MODE: 'fake' })).toThrow();
    expect(() => readConfig({ NODE_ENV: 'production', KIVRO_ENV: 'development', PAYMENT_MODE: 'fake' })).toThrow();
    expect(() => readConfig({ NODE_ENV: 'staging', DEV_AUTH_ENABLED: 'true' })).toThrow();
    expect(readConfig({ NODE_ENV: 'test', PAYMENT_MODE: 'fake', DEV_AUTH_ENABLED: 'true' }).devAuth).toBe(true);
  });
  it('binds worker signatures to exact bytes, path, method and nonce', () => {
    const nonce = randomUUID(); const timestamp = String(Date.now());
    const first = canonicalWorkerRequest('POST', '/api/worker/heartbeat', timestamp, nonce, Buffer.from('{"x":1}'));
    const reformatted = canonicalWorkerRequest('POST', '/api/worker/heartbeat', timestamp, nonce, Buffer.from('{ "x": 1 }'));
    expect(first).not.toEqual(reformatted);
    expect(() => canonicalWorkerRequest('POST', '/api/worker/heartbeat?x=1', timestamp, nonce, Buffer.alloc(0))).toThrow();
    expect(() => canonicalWorkerRequest('GET', '/api/jobs', timestamp, nonce, Buffer.alloc(0))).toThrow();
  });
  it('authenticates encrypted webhook secrets and signs replay metadata', () => {
    const key = randomBytes(32).toString('hex');
    const encrypted = encryptSecret('only-display-once', key);
    expect(encrypted).not.toContain('only-display-once');
    expect(decryptSecret(encrypted, key)).toBe('only-display-once');
    const parts = encrypted.split('.'); parts[1] = '00'.repeat(16);
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
    expect(webhookSignature('secret', '100', '{}')).not.toEqual(webhookSignature('secret', '101', '{}'));
  });
  it('rejects nonnumeric timestamps before device lookup so NaN cannot bypass replay age checks', async () => {
    for (const timestamp of ['NaN', 'Infinity', '', '1e12', '-1000000000000', String(Date.now() - 120_000)]) {
      const request = { headers: { 'x-worker-id': randomUUID(), 'x-worker-timestamp': timestamp, 'x-worker-nonce': randomUUID(), 'x-worker-signature': 'unused' } } as unknown as FastifyRequest;
      await expect(authenticateWorker({} as ApiContext, request)).rejects.toMatchObject({ code: 'WORKER_TIMESTAMP_EXPIRED' });
    }
  });
  it('preserves a structured HTTP 429 when a route exceeds its burst limit', async () => {
    const app = await createApp({ logger: false, env: { NODE_ENV: 'test', PAYMENT_MODE: 'fake',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test', S3_BUCKET: 'test', S3_ACCESS_KEY: 'test', S3_SECRET_KEY: 'test' } });
    app.get('/rate-probe', { config: { responseContract: z.object({ ok: z.literal(true) }).strict(), rateLimit: { max: 2, timeWindow: '1 minute' } } }, async () => ({ ok: true }));
    try {
      expect((await app.inject('/rate-probe')).statusCode).toBe(200);
      expect((await app.inject('/rate-probe')).statusCode).toBe(200);
      const limited = await app.inject('/rate-probe');
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe('RATE_LIMITED');
    } finally { await app.close(); }
  });
});
