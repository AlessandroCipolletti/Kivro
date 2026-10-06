import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
type DownloadFixture = { status?: number; headers?: Record<string, string>; body?: string; peer?: string; completeRequest?: boolean };
const wire = vi.hoisted(() => ({ fixtures: [] as DownloadFixture[], calls: 0 }));
vi.mock('node:https', () => ({ request: (_url: URL, options: { lookup: (host: string, opts: object, callback: (error: unknown, address: string) => void) => void }) => {
  wire.calls++; const fixture = wire.fixtures.shift() ?? {};
  const req = new EventEmitter() as EventEmitter & { end(): void; destroy(error: Error): void }; let response: Readable | undefined, destroyed = false, completed = false;
  req.destroy = error => { if (!destroyed && !completed) { destroyed = true; response?.destroy(error); req.emit('error', error); } };
  req.end = () => queueMicrotask(() => {
    const socket = Object.assign(new EventEmitter(), { remoteAddress: '' }); options.lookup('', {}, (_error, address) => { socket.remoteAddress = fixture.peer ?? address; }); req.emit('socket', socket); socket.emit('connect'); if (destroyed) return;
    response = Object.assign(Readable.from([Buffer.from(fixture.body ?? 'a,b\n1,2\n')]), { statusCode: fixture.status ?? 200, headers: fixture.headers ?? { 'content-type': 'text/csv' } });
    response.once('end', () => { if (fixture.completeRequest) { completed = true; req.emit('close'); } }); req.emit('response', response);
  }); return req;
} }));
import { SafeHttpClient } from '../src/egress.js';
beforeEach(() => { wire.fixtures.length = 0; wire.calls = 0; });
function sink() { const chunks: Buffer[] = []; return { chunks, stream: new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }) }; }
const request = { url: 'https://8.8.8.8/data.csv', maxBytes: 100, allowedContentTypes: ['text/csv'], timeoutMs: 1000 };
it('streams only final validated bytes and accounts for redirect traffic', async () => {
  wire.fixtures.push({ status: 302, headers: { location: '/final.csv' }, body: 'redirect' }, { body: 'public,csv\n' }); const target = sink();
  const result = await new SafeHttpClient().download(request, target.stream);
  expect(Buffer.concat(target.chunks).toString()).toBe('public,csv\n'); expect(result.contentBytes).toBe(11); expect(result.bytesReceived).toBe(19);
  expect(result.sha256).toBe(createHash('sha256').update('public,csv\n').digest('hex')); expect(result).not.toHaveProperty('body');
});
it.each<DownloadFixture>([{ headers: { 'content-type': 'application/x-sh' } }, { headers: { 'content-type': 'text/csv', 'content-encoding': 'gzip' } }, { status: 302, headers: { location: 'https://127.0.0.1/' } }, { peer: '127.0.0.1' }])('never exposes forbidden responses to the sink: %j', async response => {
  wire.fixtures.push(response); const target = sink(); await expect(new SafeHttpClient().download(request, target.stream)).rejects.toThrow(); expect(target.chunks).toHaveLength(0); expect(target.stream.destroyed).toBe(true);
});
it('enforces body bounds without trusting content length', async () => {
  wire.fixtures.push({ body: 'x'.repeat(101) }); const target = sink(); await expect(new SafeHttpClient().download(request, target.stream)).rejects.toThrow('RESPONSE_TOO_LARGE'); expect(target.chunks).toHaveLength(0);
});
it('does not reuse credentials, request bodies or side-effecting methods for downloads', async () => {
  for (const change of [{ method: 'POST' as const }, { body: 'private' }, { headers: { authorization: 'secret' } }]) await expect(new SafeHttpClient().download({ ...request, ...change }, sink().stream)).rejects.toThrow('METHOD_NOT_ALLOWED'); expect(wire.calls).toBe(0);
});
it('rejects cancellation and retains sink backpressure', async () => {
  const abort = new AbortController(), stream = new Writable({ write(_chunk, _encoding, _done) {} });
  const result = new SafeHttpClient({ signal: abort.signal }).download(request, stream), outcome = expect(result).rejects.toThrow('NETWORK_CANCELLED');
  await vi.waitFor(() => expect(wire.calls).toBe(1)); abort.abort('private reason'); await outcome; expect(stream.destroyed).toBe(true);
});
it('retains the absolute deadline after the HTTP request closes while the sink is still flushing', async () => {
  wire.fixtures.push({ completeRequest: true });
  const abort = new AbortController(), stream = new Writable({ write(_chunk, _encoding, _done) {} });
  const result = new SafeHttpClient({ signal: abort.signal }).download({ ...request, timeoutMs: 25 }, stream).then(() => 'SUCCESS', error => (error as Error).message);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([result, new Promise<string>(resolve => { timer = setTimeout(() => resolve('DEADLINE_NOT_ENFORCED'), 500); })]);
    expect(outcome).toBe('NETWORK_TIMEOUT'); expect(stream.destroyed).toBe(true);
  } finally { clearTimeout(timer); abort.abort(); await result; }
});
