import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:https';
import { EventEmitter } from 'node:events';
import type { ClientRequest, RequestOptions } from 'node:http';
import { resolvePublicUrl } from '@kivro/policy-engine';
import { boundedRequest } from './http.ts';

vi.mock('@kivro/policy-engine', () => ({ resolvePublicUrl: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

describe('bounded DNS resolution', () => {
  it.each([4, 6])('pins the selected IPv%s family instead of invoking automatic address selection', async family => {
    vi.mocked(resolvePublicUrl).mockResolvedValue({ url: new URL('https://example.com/'), addresses: [{ address: family === 4 ? '1.1.1.1' : '2606:4700:4700::1111', family }] });
    let captured: RequestOptions | undefined;
    vi.mocked(request).mockImplementation((...args) => {
      captured = args[1] as RequestOptions;
      const connection = Object.assign(new EventEmitter(), { end: () => queueMicrotask(() => connection.emit('error', new Error('TEST_NO_NETWORK'))) });
      return connection as unknown as ClientRequest;
    });
    await expect(boundedRequest(new URL('https://example.com/'), { publicOnly: true })).rejects.toThrow('TEST_NO_NETWORK');
    expect(captured).toMatchObject({ family, lookup: expect.any(Function) });
  });
  it('times out during DNS and never opens a socket on late resolution', async () => {
    vi.useFakeTimers();
    let resolveDns!: (value: Awaited<ReturnType<typeof resolvePublicUrl>>) => void;
    vi.mocked(resolvePublicUrl).mockReturnValue(new Promise(resolve => { resolveDns = resolve; }));
    const result = boundedRequest(new URL('https://example.com/'), { publicOnly: true, timeoutMs: 100 });
    const rejected = expect(result).rejects.toThrow('HTTP_TIMEOUT');
    await vi.advanceTimersByTimeAsync(100); await rejected;
    resolveDns({ url: new URL('https://example.com/'), addresses: [{ address: '1.1.1.1', family: 4 }] });
    await Promise.resolve(); await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  });
  it('cancels a pending lookup and skips DNS for already cancelled work', async () => {
    vi.mocked(resolvePublicUrl).mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const result = boundedRequest(new URL('https://example.com/'), { publicOnly: true, signal: controller.signal });
    controller.abort(new Error('TEST_CANCELLED'));
    await expect(result).rejects.toThrow('TEST_CANCELLED');
    await expect(boundedRequest(new URL('https://example.com/'), { publicOnly: true, signal: controller.signal })).rejects.toThrow('TEST_CANCELLED');
    expect(resolvePublicUrl).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
  });
});
