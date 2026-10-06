import { describe, expect, it } from 'vitest';
import { API_RESPONSE_ROUTES, apiResponseSchema, isFileResponse, parseApiResponse, ResponseContractError } from './responses.ts';

const user = { id: '00000000-0000-4000-8000-000000000001', name: 'Synthetic buyer', email: 'buyer@example.test', bio: null,
  emailVerifiedAt: null, termsAcceptedVersion: null, termsAcceptedAt: null, isAdmin: false };
describe('shared HTTP response contracts', () => {
  it('validates both canonical and versioned routes without interpreting query values as a route', () => {
    for (const path of ['/api/auth/me', '/api/auth/me?next=/api/admin/overview']) expect(parseApiResponse('GET', path, 200, { user })).toEqual({ user });
    expect(apiResponseSchema('GET', '/api/v1/capabilities?page=2')).toBe(apiResponseSchema('GET', '/api/capabilities'));
  });
  it('uses static endpoint precedence, the exact method and the complete path', () => {
    expect(parseApiResponse('GET', '/api/capabilities/page', 200, { items: [], total: 0, nextCursor: null })).toEqual({ items: [], total: 0, nextCursor: null });
    for (const [method, path] of [['POST', '/api/auth/me'], ['GET', '/api/auth/me/extra'], ['GET', '/api/nonexistent']]) {
      expect(() => parseApiResponse(method!, path!, 200, { user })).toThrow(ResponseContractError);
    }
  });
  it.each([{ user: { ...user, isAdmin: 'false' } }, { user: { ...user, passwordHash: 'never-deliver' } }, { user: { ...user, id: 'bad-id' } }, {}, null])(
    'fails closed without coercing or silently accepting an invalid account response', value => {
      expect(() => parseApiResponse('GET', '/api/auth/me', 200, value)).toThrow(ResponseContractError);
    });
  it('validates error envelopes and preserves structured details, not arbitrary server objects', () => {
    const error = { error: { code: 'CONFLICT', message: 'Reload', details: { revision: 2, pending: false, fields: ['name'] } } };
    expect(parseApiResponse('POST', '/api/unknown', 409, error)).toEqual(error);
    for (const invalid of [{ error: 'bad' }, { error: { code: 1, message: 'bad' } }, { ...error, stack: 'private' }]) {
      expect(() => parseApiResponse('POST', '/api/unknown', 500, invalid)).toThrow(ResponseContractError);
    }
  });
  it('validates unavailable readiness separately from error envelopes', () => {
    const ready = { status: 'unavailable', services: { database: 'ready', storage: 'unavailable', redis: 'ready' } };
    expect(parseApiResponse('GET', '/ready', 503, ready)).toEqual(ready);
    expect(() => parseApiResponse('GET', '/api/auth/me', 503, ready)).toThrow(ResponseContractError);
  });
  it('exempts only the named binary/redirect endpoints, never a JSON route with a changed MIME type', () => {
    expect(isFileResponse('GET', '/api/v1/assets/selected/download')).toBe(true);
    expect(isFileResponse('HEAD', '/api/capabilities/listing/examples/example/assets/file')).toBe(true);
    for (const [method, path] of [['POST', '/api/assets/selected/download'], ['GET', '/api/jobs/file/download'], ['GET', '/api/assets/uploads'], ['GET', '/api/assets/file/download/extra']]) {
      expect(isFileResponse(method!, path!)).toBe(false);
    }
  });
  it('has exactly one schema per method and route', () => {
    const keys = API_RESPONSE_ROUTES.map(route => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
