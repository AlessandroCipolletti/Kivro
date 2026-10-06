import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';

vi.mock('node:http', () => ({ request: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
async function fixture() {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  child.destroy.mockImplementation(() => child.emit('close'));
  let callback!: (response: EventEmitter) => void;
  vi.mocked(request).mockImplementation(((_options: unknown, receive: typeof callback) => { callback = receive; return child; }) as unknown as typeof request);
  const { callToolBridge } = await import(new URL('./plugin/bridge.mjs', import.meta.url).href);
  const response = Object.assign(new EventEmitter(), { statusCode: 200, destroy: vi.fn() });
  return { child, response, callToolBridge, receive: () => callback(response) };
}
describe('reviewed fixed-endpoint in-container bridge', () => {
  it('uses one credential-free loopback endpoint, explicit byte length, bounded wall timer and cancellation signal', async () => {
    const { child, response, receive, callToolBridge } = await fixture(), controller = new AbortController();
    const body = { name: 'resource_read', args: { resourceId: 'approved' } };
    const pending = callToolBridge(body, controller.signal, 930000);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ hostname: '127.0.0.1', port: 18789, path: '/kivro/tool', method: 'POST', agent: false, signal: controller.signal, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(JSON.stringify(body)) } }), expect.any(Function));
    await vi.advanceTimersByTimeAsync(70000); expect(child.destroy).not.toHaveBeenCalled();
    receive(); response.emit('data', Buffer.from('{"ok":true}')); response.emit('end'); child.emit('close');
    await expect(pending).resolves.toEqual({ ok: true }); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['redirect', 'bytes', 'malformed', 'socket', 'timeout'])('rejects %s without following a URL or returning remote diagnostic text', async failure => {
    const { child, response, receive, callToolBridge } = await fixture();
    const pending = callToolBridge({ name: 'resource_read', args: {} }, new AbortController().signal, 5000);
    const rejected = expect(pending).rejects.toThrow('KIVRO_TOOL_DENIED');
    if (failure === 'redirect') response.statusCode = 302;
    receive();
    if (failure === 'bytes') response.emit('data', Buffer.alloc(16 * 1024 * 1024 + 1));
    if (failure === 'malformed') { response.emit('data', Buffer.from('private-invalid-json')); response.emit('end'); }
    if (failure === 'socket') child.emit('error', new Error('private-socket-detail'));
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(5000);
    await rejected; child.emit('close'); expect(request).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects invalid/unbounded timers and oversized requests before opening a socket', async () => {
    const { callToolBridge } = await fixture();
    for (const timeoutMs of [0, Infinity, NaN, 4500001, 5000.5]) await expect(callToolBridge({}, undefined, timeoutMs)).rejects.toThrow('INVALID_BRIDGE_TIMEOUT');
    await expect(callToolBridge({ content: 'x'.repeat(2 * 1024 * 1024) }, undefined, 5000)).rejects.toThrow('KIVRO_TOOL_REQUEST_LIMIT');
    expect(request).not.toHaveBeenCalled();
  });
});
