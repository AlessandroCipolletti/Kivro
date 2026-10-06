import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, post } from '../src/lib/api';

afterEach(() => { vi.unstubAllGlobals(); });
const respond = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})));

describe('web HTTP response validation', () => {
  it('returns only a valid route-specific response and keeps authenticated fetch policy', async () => {
    respond({ user: null });
    expect(await api('/auth/me')).toEqual({ user: null });
    expect(fetch).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({ credentials: 'include', cache: 'no-store' }));
  });
  it.each([{}, { user: 'wrong type' }, { user: null, privateField: 'never expose' }])('rejects structurally invalid successful JSON', async body => {
    respond(body);
    await expect(api('/auth/me')).rejects.toMatchObject({ name: 'ApiError', code: 'INVALID_RESPONSE' });
  });
  it('rejects unreadable and empty successful responses', async () => {
    for (const response of [new Response('not json'), new Response(null, { status: 204 })]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await expect(api('/auth/me')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });
  it('validates the request method as well as the response route', async () => {
    respond({ user: null });
    await expect(post('/auth/me', {})).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('preserves validated error details and never trusts malformed error objects', async () => {
    respond({ error: { code: 'CONFLICT', message: 'Reload', details: { revision: 2 } } }, 409);
    await expect(api('/auth/me')).rejects.toMatchObject({ status: 409, code: 'CONFLICT', message: 'Reload', details: { revision: 2 } });
    respond({ error: { code: 17, message: { secret: 'never expose' } } }, 500);
    await expect(api('/auth/me')).rejects.toMatchObject({ status: 500, code: 'REQUEST_FAILED', message: 'The service is unavailable. Please try again.' });
  });
});
