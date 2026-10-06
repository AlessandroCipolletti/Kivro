import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../apps/api/src/app.js';

describe.runIf(process.env.KIVRO_INTEGRATION === '1')('real API authorization and admission', () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let buyerCookie: string, sellerCookie: string;
  const origin = 'http://localhost:3000';
  const headers = (cookie?: string) => ({ origin, ...(cookie ? { cookie } : {}) });
  beforeAll(async () => {
    config({ path: '.env' });
    if (process.env.KIVRO_ENV !== 'development') throw new Error('Local API integration requires development infrastructure.');
    app = await createApp({ logger: false, background: false });
    await app.ready();
    const login = async (role: string) => {
      const response = await app.inject({ method: 'POST', url: '/api/auth/dev-login', headers: headers(), payload: { role } });
      expect(response.statusCode).toBe(200);
      const setCookie = response.headers['set-cookie'];
      return (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
    };
    buyerCookie = await login('buyer'); sellerCookie = await login('seller');
    const terms = (await app.inject('/api/terms')).json();
    expect((await app.inject({ method: 'POST', url: '/api/account/terms', headers: headers(buyerCookie), payload: { version: terms.version } })).statusCode).toBe(200);
  });
  afterAll(async () => { await app?.close(); });
  it('uses distinct unified accounts and private seller contract data', async () => {
    const buyer = (await app.inject({ url: '/api/auth/me', headers: headers(buyerCookie) })).json().user;
    const seller = (await app.inject({ url: '/api/auth/me', headers: headers(sellerCookie) })).json().user;
    expect(buyer.id).not.toBe(seller.id);
    const publicList = (await app.inject({ url: '/api/capabilities', headers: headers(buyerCookie) })).json();
    expect(publicList.length).toBeGreaterThan(0);
    for (const capability of publicList) {
      expect(capability.schedule).toBeUndefined();
      expect(capability.internalInstructions).toBeUndefined();
      expect(capability.permissions.inference.credentialRef).toBeUndefined();
    }
    const privateList = (await app.inject({ url: '/api/seller/capabilities', headers: headers(sellerCookie) })).json();
    expect(privateList[0].schedule).toBeDefined();
    expect(privateList[0].internalInstructions).toBeDefined();
    expect((await app.inject({ url: '/api/seller/capabilities', headers: headers(buyerCookie) })).json()).toEqual([]);
  });
  it('rejects cross-account capability mutation and cross-origin cookie mutations', async () => {
    const capability = (await app.inject({ url: '/api/capabilities' })).json()[0];
    const other = await app.inject({ method: 'POST', url: `/api/seller/capabilities/${capability.id}/pause`, headers: headers(buyerCookie), payload: { paused: true } });
    expect([403, 404]).toContain(other.statusCode);
    const csrf = await app.inject({ method: 'POST', url: `/api/seller/capabilities/${capability.id}/pause`, headers: { cookie: sellerCookie, origin: 'https://untrusted.invalid' }, payload: { paused: true } });
    expect(csrf.statusCode).toBe(403);
    expect(csrf.json().error.code).toBe('ORIGIN_DENIED');
  });
  it('does not reserve funds or create a job for an offline capability', async () => {
    const detail = await app.inject({ url: '/api/capabilities/document-analyzer' });
    expect(detail.statusCode, detail.body).toBe(200);
    const capability = detail.json();
    expect(capability.availability.canRunNow).toBe(false);
    const before = (await app.inject({ url: '/api/wallet', headers: headers(buyerCookie) })).json();
    const job = await app.inject({ method: 'POST', url: '/api/jobs', headers: { ...headers(buyerCookie), 'idempotency-key': randomUUID() }, payload: { capabilityId: capability.id, input: { text: 'A concrete local verification document.' }, executionMode: 'NOW' } });
    expect(job.statusCode).toBeGreaterThanOrEqual(400);
    const after = (await app.inject({ url: '/api/wallet', headers: headers(buyerCookie) })).json();
    expect(after.availableMinor).toBe(before.availableMinor);
    expect(after.reservedMinor).toBe(before.reservedMinor);
  });
  it('requires authentication for wallet, jobs and operator control', async () => {
    for (const url of ['/api/wallet', '/api/jobs', '/api/seller/workers', '/api/admin/overview']) expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/admin/overview', headers: headers(buyerCookie) })).statusCode).toBe(403);
    const guessed = await app.inject({ url: `/api/jobs/${randomUUID()}`, headers: headers(buyerCookie) });
    expect(guessed.statusCode).toBe(404);
  });
  it('preserves an idempotent development credit operation across repeated requests', async () => {
    const key = randomUUID();
    const before = (await app.inject({ url: '/api/wallet', headers: headers(buyerCookie) })).json();
    const request = { method: 'POST' as const, url: '/api/wallet/topup', headers: { ...headers(buyerCookie), 'idempotency-key': key }, payload: { amountMinor: 100 } };
    const first = await app.inject(request); const second = await app.inject(request);
    expect(first.statusCode).toBe(200); expect(second.statusCode).toBe(200);
    const after = (await app.inject({ url: '/api/wallet', headers: headers(buyerCookie) })).json();
    expect(after.availableMinor - before.availableMinor).toBe(100);
    const conflicting = await app.inject({ ...request, payload: { amountMinor: 200 } });
    expect(conflicting.statusCode).toBe(409);
  });
  it('returns a stable 429 error when a caller exceeds the request limit', async () => {
    let status = 200; let body: any;
    for (let i = 0; i < 190 && status === 200; i++) {
      const response = await app.inject({ url: '/api/config', remoteAddress: '198.51.100.90' });
      status = response.statusCode; body = response.json();
    }
    expect(status).toBe(429);
    expect(body.error.code).toBe('RATE_LIMITED');
  });
});
