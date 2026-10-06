import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const wire = vi.hoisted(() => ({ calls: [] as Array<{ url: URL; options: Record<string, any> }>, destroys: [] as Error[],
  responses: [] as Array<{ status?: number; headers?: Record<string, string>; body?: string; peer?: string; hold?: boolean; onEnd?: () => void }> }));
vi.mock('node:https', () => ({ request: (url: URL, options: Record<string, any>) => {
  const req = new EventEmitter() as EventEmitter & { end(): void; destroy(error: Error): void };
  let destroyed = false;
  wire.calls.push({ url, options });
  const fixture = wire.responses.shift() ?? {};
  req.destroy = error => { if (!destroyed) { destroyed = true; wire.destroys.push(error); req.emit('error', error); } };
  req.end = () => queueMicrotask(() => {
    const socket = new EventEmitter() as EventEmitter & { remoteAddress: string };
    options.lookup(url.hostname, {}, (_error: unknown, address: string) => { socket.remoteAddress = fixture.peer ?? address; });
    req.emit('socket', socket); socket.emit('connect');
    if (destroyed) return;
    const res = Object.assign(new EventEmitter(), { statusCode: fixture.status ?? 200, headers: fixture.headers ?? { 'content-type': 'text/plain' } });
    req.emit('response', res);
    if (!destroyed) res.emit('data', Buffer.from(fixture.body ?? 'ok'));
    if (!destroyed && !fixture.hold) { res.emit('end'); fixture.onEnd?.(); }
  });
  return req;
} }));

import { assertPublicAddress, NetworkPolicyError, parsePublicUrl, SafeHttpClient } from '../src/egress.js';

beforeEach(() => { wire.calls.length = 0; wire.responses.length = 0; wire.destroys.length = 0; });
describe('public-address classification', () => {
  it.each(['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.1.2.3', '169.254.169.254', '172.16.0.1', '192.0.0.8',
    '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '2001:db8::1',
    '2002:7f00:1::', '64:ff9b::7f00:1', '100::1', '2001::1', '3fff::1', 'fec0::1', 'fe80::1%en0'])('blocks %s', address => {
    expect(() => assertPublicAddress(address)).toThrow(NetworkPolicyError);
  });
  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888'])('allows global address %s', address => {
    expect(() => assertPublicAddress(address)).not.toThrow();
  });
  it.each(['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/', 'https://[::1]/',
    'file:///etc/passwd', 'gopher://example.com/', 'https://u:p@example.com/', 'https://example.com:22/',
    'https://localhost./', 'https://printer/', 'https://app.internal/', 'https://example.com/#token'])('rejects unsafe URL %s', url => {
    expect(() => parsePublicUrl(url)).toThrow(NetworkPolicyError);
  });
});

describe('actual HTTP connection boundary', () => {
  it('blocks an already cancelled trusted client before DNS or socket creation', async () => {
    const controller = new AbortController(), resolver = vi.fn(); controller.abort(new Error('private abort reason'));
    await expect(new SafeHttpClient({ resolver, signal: controller.signal }).request({ url: 'https://example.com/' })).rejects.toThrow(/^NETWORK_CANCELLED$/);
    expect(resolver).not.toHaveBeenCalled(); expect(wire.calls).toHaveLength(0);
  });
  it('abandons pending DNS, removes listeners, and never connects when late DNS completes', async () => {
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
    let resolved!: (value: { address: string; family: number }[]) => void;
    const client = new SafeHttpClient({ signal: controller.signal, resolver: () => new Promise(resolve => { resolved = resolve; }) });
    const outcome = expect(client.request({ url: 'https://example.com/' })).rejects.toThrow(/^NETWORK_CANCELLED$/);
    controller.abort({ private: 'reason' }); await outcome; resolved([{ address: '8.8.8.8', family: 4 }]); await Promise.resolve();
    expect(wire.calls).toHaveLength(0); expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
  it('destroys an in-flight response and does not leak its trusted abort reason', async () => {
    const controller = new AbortController(); wire.responses.push({ hold: true });
    const result = new SafeHttpClient({ signal: controller.signal }).request({ url: 'https://8.8.8.8/' }), outcome = expect(result).rejects.toThrow(/^NETWORK_CANCELLED$/);
    await vi.waitFor(() => expect(wire.calls).toHaveLength(1)); controller.abort(new Error('secret-key'));
    await outcome; expect(wire.destroys.map(error => error.message)).toEqual(['NETWORK_CANCELLED']);
  });
  it('does not follow a redirect after cancellation and removes listeners after normal completion', async () => {
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
    wire.responses.push({ status: 302, headers: { location: '/next' }, onEnd: () => controller.abort() });
    await expect(new SafeHttpClient({ signal: controller.signal }).request({ url: 'https://8.8.8.8/' })).rejects.toThrow('NETWORK_CANCELLED'); expect(wire.calls).toHaveLength(1); expect(remove).toHaveBeenCalled();
    const normal = new AbortController(); await new SafeHttpClient({ signal: normal.signal }).request({ url: 'https://8.8.8.8/' }); normal.abort(); expect(wire.destroys).toHaveLength(0);
  });
  it('pins one validated DNS answer while preserving hostname and disables socket pooling', async () => {
    const resolver = vi.fn().mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const response = await new SafeHttpClient({ resolver }).request({ url: 'https://public.example/page' });
    expect(response.status).toBe(200); expect(resolver).toHaveBeenCalledTimes(1);
    const call = wire.calls[0]!;
    expect(call.url.hostname).toBe('public.example'); expect(call.options.agent).toBe(false); expect(call.options.family).toBe(4);
    const callback = vi.fn(); call.options.lookup('public.example', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4); expect(resolver).toHaveBeenCalledTimes(1);
  });
  it('rejects mixed public/private DNS answers before opening any socket', async () => {
    const client = new SafeHttpClient({ resolver: async () => [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }] });
    await expect(client.request({ url: 'https://mixed.example' })).rejects.toMatchObject({ code: 'PRIVATE_DESTINATION_DENIED' });
    expect(wire.calls).toHaveLength(0);
  });
  it('re-resolves redirects, blocking rebinding to private DNS', async () => {
    wire.responses.push({ status: 302, headers: { location: '/next' }, body: '' });
    const resolver = vi.fn().mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    await expect(new SafeHttpClient({ resolver }).request({ url: 'https://rebinding.example/' })).rejects.toMatchObject({ code: 'PRIVATE_DESTINATION_DENIED' });
    expect(wire.calls).toHaveLength(1); expect(resolver).toHaveBeenCalledTimes(2);
  });
  it('denies redirect to cloud metadata without connecting', async () => {
    wire.responses.push({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    await expect(new SafeHttpClient().request({ url: 'https://8.8.8.8' })).rejects.toBeInstanceOf(NetworkPolicyError);
    expect(wire.calls).toHaveLength(1);
  });
  it('checks the connected peer against the pin', async () => {
    wire.responses.push({ peer: '127.0.0.1' });
    await expect(new SafeHttpClient().request({ url: 'https://8.8.8.8' })).rejects.toMatchObject({ code: 'PRIVATE_DESTINATION_DENIED' });
  });
  it('pins IPv6 without changing the URL host', async () => {
    await new SafeHttpClient({ resolver: async () => [{ address: '2606:4700::1111', family: 6 }] }).request({ url: 'https://ipv6.example/' });
    expect(wire.calls[0]!.options.family).toBe(6);
  });
  it('rejects redirects on credentialed POST', async () => {
    wire.responses.push({ status: 307, headers: { location: 'https://evil.example' } });
    await expect(new SafeHttpClient().request({ url: 'https://8.8.8.8', method: 'POST', body: '{}',
      headers: { authorization: 'secret' }, maxRedirects: 0 })).rejects.toMatchObject({ code: 'NETWORK_POLICY_DENIED' });
    expect(wire.calls).toHaveLength(1);
  });
  it('rejects cross-domain redirects outside an exact allowlist', async () => {
    wire.responses.push({ status: 302, headers: { location: 'https://other.example' } });
    const client = new SafeHttpClient({ resolver: async () => [{ address: '8.8.8.8', family: 4 }] });
    await expect(client.request({ url: 'https://allowed.example', allowedDomains: ['allowed.example'] })).rejects.toMatchObject({ code: 'NETWORK_POLICY_DENIED' });
  });
  it('enforces streamed size even without a content-length', async () => {
    wire.responses.push({ body: '0123456789' });
    await expect(new SafeHttpClient().request({ url: 'https://8.8.8.8', maxBytes: 5 })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
  it('accounts for redirect bodies within the same byte budget', async () => {
    wire.responses.push({ status: 302, headers: { location: '/next' }, body: 'redirect' }, { body: 'final' });
    const result = await new SafeHttpClient().request({ url: 'https://8.8.8.8/', maxBytes: 20 });
    expect(result.bytesReceived).toBe(13); expect(result.body.toString()).toBe('final');
  });
  it('blocks compressed bombs and executable content types', async () => {
    wire.responses.push({ headers: { 'content-encoding': 'gzip' } });
    await expect(new SafeHttpClient().request({ url: 'https://8.8.8.8' })).rejects.toMatchObject({ code: 'CONTENT_TYPE_DENIED' });
    wire.responses.push({ headers: { 'content-type': 'application/octet-stream' } });
    await expect(new SafeHttpClient().request({ url: 'https://8.8.8.8', allowedContentTypes: ['text/plain'] })).rejects.toMatchObject({ code: 'CONTENT_TYPE_DENIED' });
  });
  it('bounds DNS time', async () => {
    const client = new SafeHttpClient({ resolver: () => new Promise(() => {}) });
    await expect(client.request({ url: 'https://timeout.example', timeoutMs: 5 })).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
  });
});
