import { describe, expect, it } from 'vitest';
import { readSmtpConfig } from '../src/account-mail.js';

describe('account SMTP configuration', () => {
  it('allows cleartext only for explicit local development', () => {
    expect(readSmtpConfig({ NODE_ENV: 'development' }, true)).toMatchObject({ host: '127.0.0.1', port: 51025, requireTLS: false });
    expect(readSmtpConfig({}, false)).toBeNull();
    expect(readSmtpConfig({ NODE_ENV: 'test' }, true)).toBeNull();
    expect(() => readSmtpConfig({ SMTP_HOST: 'smtp.example.org', SMTP_REQUIRE_TLS: 'false', SMTP_FROM: 'accounts@example.org' }, false)).toThrow('verified TLS');
    expect(() => readSmtpConfig({ SMTP_HOST: '127.0.0.1', SMTP_REQUIRE_TLS: 'false', SMTP_FROM: 'accounts@example.org' }, false)).toThrow('verified TLS');
    expect(readSmtpConfig({ SMTP_HOST: 'smtp.example.org', SMTP_FROM: 'accounts@example.org' }, false)).toMatchObject({ port: 587, requireTLS: true });
  });
  it('rejects partial credentials, malformed endpoints, invalid ports and sender/header injection', () => {
    expect(() => readSmtpConfig({ SMTP_HOST: 'smtp.example.org', SMTP_USER: 'only-user' }, false)).toThrow('configured together');
    expect(() => readSmtpConfig({ SMTP_HOST: 'smtp://user@host' }, true)).toThrow('hostname');
    expect(() => readSmtpConfig({ SMTP_PORT: 'NaN' }, true)).toThrow('SMTP_PORT');
    expect(() => readSmtpConfig({ SMTP_SECURE: 'off' }, true)).toThrow('SMTP_SECURE');
    expect(() => readSmtpConfig({ SMTP_FROM: 'accounts@kivro.local\r\nBcc: private@example.org' }, true)).toThrow();
  });
});
