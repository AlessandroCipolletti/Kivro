import { createServer, type Socket, type Server } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { scanStreamWithClamAv, scanWithClamAv } from './scanner.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function scanner(mode: 'clean' | 'infected' | 'malformed' | 'close' | 'stall' | 'early' | 'backpressure' = 'clean') {
  const sockets = new Set<Socket>(); let received = Buffer.alloc(0), framedBytes = 0;
  const server: Server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    if (mode === 'close') { socket.destroy(); return; }
    if (mode === 'early') { socket.end('stream: OK\0'); return; }
    if (mode === 'backpressure') { socket.pause(); return; }
    let header = false, buffered = Buffer.alloc(0);
    socket.on('data', data => {
      buffered = Buffer.concat([buffered, data]);
      if (!header) { if (buffered.length < 10) return; expect(buffered.subarray(0, 10).toString()).toBe('zINSTREAM\0'); buffered = buffered.subarray(10); header = true; }
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(); if (buffered.length < 4 + length) return;
        framedBytes = Math.max(framedBytes, length); received = Buffer.concat([received, buffered.subarray(4, 4 + length)]); buffered = buffered.subarray(4 + length);
        if (!length && mode !== 'stall') socket.end(mode === 'clean' ? 'stream: OK\0' : mode === 'infected' ? 'stream: Test.Signature FOUND\0' : 'secret invalid scanner text\0');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { port: (server.address() as { port: number }).port, received: () => received, maxFrame: () => framedBytes };
}
describe('ClamAV bounded streaming protocol', () => {
  it('streams exact bounded INSTREAM frames and only accepts a complete clean verdict', async () => {
    const target = await scanner(), bytes = Buffer.alloc(200000, 65);
    const receipt = await scanStreamWithClamAv(Readable.from([bytes]), '127.0.0.1', target.port, { maxBytes: bytes.length, deadline: Date.now() + 2000 });
    expect(receipt).toMatchObject({ engine: 'CLAMAV', verdict: 'CLEAN', scannedBytes: bytes.length }); expect(target.received()).toEqual(bytes); expect(target.maxFrame()).toBeLessThanOrEqual(65536);
  });
  it.each([['infected', 'FILE_SCAN_INFECTED'], ['malformed', 'INVALID_SCANNER_RESPONSE'], ['close', /SCANNER_(EARLY_CLOSE|UNAVAILABLE)/]] as const)('fails closed on %s', async (mode, error) => {
    const target = await scanner(mode); await expect(scanWithClamAv(Buffer.from('public'), '127.0.0.1', target.port, { deadline: Date.now() + 1000 })).rejects.toThrow(error);
  });
  it('denies a clean verdict before the complete stream was sent', async () => {
    const target = await scanner('early');
    await expect(scanStreamWithClamAv(new Readable({ read() {} }), '127.0.0.1', target.port, { deadline: Date.now() + 1000 })).rejects.toThrow('INVALID_SCANNER_RESPONSE');
  });
  it('caps bytes even with a dishonest input stream', async () => {
    const target = await scanner(); await expect(scanStreamWithClamAv(Readable.from([Buffer.alloc(11)]), '127.0.0.1', target.port, { maxBytes: 10 })).rejects.toThrow('SCANNER_INPUT_LIMIT');
  });
  it('cancels an active stalled response and redacts the abort reason', async () => {
    const target = await scanner('stall'), abort = new AbortController();
    const outcome = expect(scanWithClamAv(Buffer.from('public'), '127.0.0.1', target.port, { signal: abort.signal })).rejects.toThrow(/^SCANNER_CANCELLED$/);
    setTimeout(() => abort.abort('secret key'), 20); await outcome;
  });
  it.each(['stall', 'backpressure'] as const)('enforces wall deadline during %s', async mode => {
    const target = await scanner(mode), start = performance.now();
    await expect(scanStreamWithClamAv(Readable.from([Buffer.alloc(8 * 1024 ** 2)]), '127.0.0.1', target.port, { deadline: Date.now() + 100, maxBytes: 8 * 1024 ** 2 })).rejects.toThrow('SCANNER_TIMEOUT');
    expect(performance.now() - start).toBeLessThan(1500);
  });
  it('does not connect for pre-cancellation or expired deadline', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(scanWithClamAv(Buffer.from('x'), '127.0.0.1', 1, { signal: abort.signal })).rejects.toThrow('SCANNER_CANCELLED');
    await expect(scanWithClamAv(Buffer.from('x'), '127.0.0.1', 1, { deadline: Date.now() - 1 })).rejects.toThrow('SCANNER_TIMEOUT');
  });
});
