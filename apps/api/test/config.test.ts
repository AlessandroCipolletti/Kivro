import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';

describe('bounded cumulative pause configuration', () => {
  const env = { NODE_ENV: 'test', PAYMENT_MODE: 'fake' };
  it('defaults to fifteen cumulative minutes and supports shorter job snapshots', () => {
    expect(readConfig(env).maxPauseMs).toBe(900000);
    for (const value of ['1000', '75000', '900000']) expect(readConfig({ ...env, KIVRO_MAX_JOB_PAUSE_MS: value }).maxPauseMs).toBe(Number(value));
  });
  it.each(['', ' ', '0', '999', '900001', '-1', 'NaN', 'Infinity', '1500.5'])('rejects unsupported pause budget %j', value => {
    expect(() => readConfig({ ...env, KIVRO_MAX_JOB_PAUSE_MS: value })).toThrow();
  });
});

// Explicit synthetic strings only: never load .env, construct Stripe or make I/O.
const developmentEnvironments: NodeJS.ProcessEnv[] = [
  { NODE_ENV: 'development' }, { NODE_ENV: 'test' }, { KIVRO_ENV: 'development' }, { KIVRO_ENV: 'test' },
];
const production: NodeJS.ProcessEnv = {
  NODE_ENV: 'production', PAYMENT_MODE: 'stripe', SESSION_SECRET: 'synthetic-unit-session-secret-with-no-provider-access',
  WEB_ORIGIN: 'https://web.invalid', API_URL: 'https://api.invalid',
  DATABASE_URL: 'postgresql://synthetic:synthetic@db.invalid/unit', S3_ACCESS_KEY: 'synthetic-unit-access', S3_SECRET_KEY: 'synthetic-unit-secret',
  STRIPE_SECRET_KEY: 'sk_live_synthetic_unit_only', STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_unit_only',
  WORKER_SIGNING_PRIVATE_KEY: 'synthetic-unit-signing-key-not-used', WEBHOOK_ENCRYPTION_KEY: '1'.repeat(64), CLAMAV_HOST: 'scanner.invalid',
};

describe('API configuration payment safety', () => {
  it.each(developmentEnvironments)('rejects non-test secret keys with explicit environment %j, even in fake mode', env => {
    for (const paymentMode of ['stripe', 'fake']) for (const secret of [
      'sk_live_synthetic_unit_only', 'rk_test_synthetic_unit_only', 'pk_test_synthetic_unit_only', 'not-a-key', ' ', ' sk_test_synthetic_unit_only',
    ]) {
      expect(() => readConfig({ ...env, PAYMENT_MODE: paymentMode, STRIPE_SECRET_KEY: secret })).toThrow('Development and test require a sk_test_');
    }
  });
  it.each(developmentEnvironments)('allows omitted/empty keys and test-prefixed keys with environment %j', env => {
    for (const paymentMode of ['stripe', 'fake']) for (const secret of [undefined, '', 'sk_test_synthetic_unit_only']) {
      expect(readConfig({ ...env, PAYMENT_MODE: paymentMode, STRIPE_SECRET_KEY: secret }).stripeSecret).toBe(secret ?? '');
    }
  });
  it('cannot hide a development/test flag behind the other nonproduction environment flag', () => {
    for (const env of [{ NODE_ENV: 'test', KIVRO_ENV: 'staging' }, { NODE_ENV: 'development', KIVRO_ENV: 'staging' }]) {
      expect(() => readConfig({ ...env, PAYMENT_MODE: 'stripe', STRIPE_SECRET_KEY: 'sk_live_synthetic_unit_only' })).toThrow('Development and test require a sk_test_');
    }
  });
  it('does not echo a rejected secret in the configuration error', () => {
    const secret = 'sk_live_synthetic_sensitive_suffix';
    try { readConfig({ NODE_ENV: 'test', PAYMENT_MODE: 'fake', STRIPE_SECRET_KEY: secret }); throw new Error('Expected key rejection'); }
    catch (error) { expect((error as Error).message).toContain('Development and test require'); expect((error as Error).message).not.toContain(secret); }
  });
  it('preserves production precedence and the existing live-key requirement', () => {
    for (const env of [production, { ...production, KIVRO_ENV: 'test' }, { ...production, NODE_ENV: 'test', KIVRO_ENV: 'production' }]) {
      expect(readConfig(env)).toMatchObject({ production: true, development: false, stripeSecret: production.STRIPE_SECRET_KEY });
      for (const secret of [undefined, '', 'sk_test_synthetic_unit_only']) {
        expect(() => readConfig({ ...env, STRIPE_SECRET_KEY: secret })).toThrow('Production requires live Stripe credentials');
      }
    }
    expect(() => readConfig({ ...production, PAYMENT_MODE: 'fake' })).toThrow('Production requires Stripe payments');
  });
});

describe('API upload byte limit configuration', () => {
  const env = { NODE_ENV: 'test', PAYMENT_MODE: 'fake' };
  it('retains the 25 MiB default only when the setting is absent', () => {
    expect(readConfig(env).maxUploadBytes).toBe(25 * 1024 ** 2);
  });
  it.each(['1', '1024', String(25 * 1024 ** 2), String(100 * 1024 ** 2)])('accepts bounded positive integer %s', value => {
    expect(readConfig({ ...env, MAX_UPLOAD_BYTES: value }).maxUploadBytes).toBe(Number(value));
  });
  it.each(['NaN', 'Infinity', '-Infinity', '1e309', 'not-a-number', '', ' ', '0', '-1', '0.5', '1.1', String(100 * 1024 ** 2 + 1), String(Number.MAX_SAFE_INTEGER)])('rejects invalid limit %j rather than coercing/clamping it into service', value => {
    expect(() => readConfig({ ...env, MAX_UPLOAD_BYTES: value })).toThrow();
  });
  it('applies the same upload ceiling in production without changing Stripe mode rules', () => {
    expect(readConfig({ ...production, MAX_UPLOAD_BYTES: String(100 * 1024 ** 2) }).maxUploadBytes).toBe(100 * 1024 ** 2);
    expect(() => readConfig({ ...production, MAX_UPLOAD_BYTES: String(100 * 1024 ** 2 + 1) })).toThrow();
  });
});

describe('authenticated deployment environment metadata', () => {
  it.each(['development', 'test', 'staging', 'preview'])('reports explicit %s without hostname inference', environment => {
    expect(readConfig({ KIVRO_ENV: environment }).deploymentEnvironment).toBe(environment);
  });
  it('retains production precedence and does not label an unclassified endpoint safe', () => {
    expect(readConfig({ ...production, KIVRO_ENV: 'test' }).deploymentEnvironment).toBe('production');
    expect(readConfig({ ...production, KIVRO_ENV: 'staging' }).deploymentEnvironment).toBe('production');
    expect(readConfig({}).deploymentEnvironment).toBe('unknown');
    expect(readConfig({ KIVRO_ENV: 'private-invalid-value' }).deploymentEnvironment).toBe('unknown');
  });
});

describe('session cookie transport security', () => {
  it('protects HTTPS staging cookies independently of live payment mode', () => {
    expect(readConfig({ NODE_ENV: 'test', KIVRO_ENV: 'staging', WEB_ORIGIN: 'https://staging.invalid',
      PAYMENT_MODE: 'stripe', STRIPE_SECRET_KEY: 'sk_test_synthetic_unit_only' })).toMatchObject({
      production: false, deploymentEnvironment: 'staging', secureSessionCookies: true, paymentMode: 'stripe',
    });
  });
  it('requires Secure for any canonical HTTPS origin while keeping local HTTP usable', () => {
    expect(readConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'https://preview.invalid' }).secureSessionCookies).toBe(true);
    expect(readConfig({ NODE_ENV: 'development', WEB_ORIGIN: 'http://localhost:3000' }).secureSessionCookies).toBe(false);
    expect(readConfig(production).secureSessionCookies).toBe(true);
  });
});
