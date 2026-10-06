import { describe, expect, it } from 'vitest';
import { developmentEnvironment, assertLocalEnvironment, findDevelopmentPort } from '../scripts/common.js';

describe('local development configuration', () => {
  it('rejects invalid listener ports before attempting a bind', async () => {
    for (const port of [0, 80, 65535, -1, NaN, 4000.5]) await expect(findDevelopmentPort(port)).rejects.toThrow('Development ports');
  });
  it('keeps the web proxy, API listener, worker endpoint and CSRF origin on selected ports', () => {
    const base = { API_URL: 'http://127.0.0.1:4000', API_INTERNAL_URL: 'http://127.0.0.1:4000', WEB_ORIGIN: 'http://localhost:3000', SESSION_SECRET: 'synthetic-fixture' };
    const actual = developmentEnvironment(4003, 3002, base);
    expect(actual).toMatchObject({ API_PORT: '4003', PORT: '4003', WEB_PORT: '3002', API_URL: 'http://127.0.0.1:4003', API_INTERNAL_URL: 'http://127.0.0.1:4003', WEB_ORIGIN: 'http://localhost:3002', SESSION_SECRET: 'synthetic-fixture' });
    expect(base.API_URL).toBe('http://127.0.0.1:4000');
  });
  it('refuses infrastructure setup/reset pointed at nonlocal or non-Kivro data', () => {
    const original = { ...process.env };
    Object.assign(process.env, { NODE_ENV: 'development', KIVRO_ENV: 'development', DATABASE_URL: 'postgresql://fixture@127.0.0.1:55432/kivro', REDIS_URL: 'redis://127.0.0.1:56379', S3_ENDPOINT: 'http://127.0.0.1:59000', S3_BUCKET: 'kivro-development' });
    try {
      expect(() => assertLocalEnvironment()).not.toThrow();
      for (const [key, value] of [['DATABASE_URL', 'postgresql://fixture@127.0.0.1:55432/personal'], ['REDIS_URL', 'redis://127.0.0.1:6379'], ['S3_ENDPOINT', 'https://storage.example.com:59000'], ['S3_BUCKET', 'production-assets'], ['KIVRO_ENV', 'production']]) {
        const previous = process.env[key]; process.env[key] = value;
        expect(() => assertLocalEnvironment()).toThrow();
        process.env[key] = previous;
      }
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
      Object.assign(process.env, original);
    }
  });
});
