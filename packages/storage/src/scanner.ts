import { connect } from 'node:net';
import { Readable } from 'node:stream';
import { FileValidationError } from './validation.js';

export type ScanOptions = { signal?: AbortSignal; deadline?: number; maxBytes?: number };
export type ScanReceipt = { engine: 'CLAMAV'; verdict: 'CLEAN'; scannedBytes: number; scannedAt: string };

/** The scanner endpoint is trusted deployment configuration, never a file/job field. */
export async function scanStreamWithClamAv(source: Readable, host: string, port = 3310, options: ScanOptions = {}): Promise<ScanReceipt> {
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + 30_000), maxBytes = options.maxBytes ?? 100 * 1024 ** 2;
  if (!host || /[\s\x00-\x1f]/.test(host) || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1024 ** 2) throw new Error('INVALID_SCANNER_CONFIGURATION');
  if (options.signal?.aborted) { source.destroy(); throw new Error('SCANNER_CANCELLED'); }
  if (!Number.isFinite(deadline) || deadline <= Date.now()) { source.destroy(); throw new Error('SCANNER_TIMEOUT'); }
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let response = '', total = 0, sent = false, settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true;
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort); socket.destroy(); source.destroy();
      if (error) reject(error); else resolve({ engine: 'CLAMAV', verdict: 'CLEAN', scannedBytes: total, scannedAt: new Date().toISOString() });
    };
    const abort = () => finish(new Error('SCANNER_CANCELLED'));
    const timer = setTimeout(() => finish(new Error('SCANNER_TIMEOUT')), Math.max(1, deadline - Date.now()));
    options.signal?.addEventListener('abort', abort, { once: true });
    socket.once('error', () => finish(new Error('SCANNER_UNAVAILABLE')));
    source.once('error', () => finish(new Error('SCANNER_INPUT_FAILED')));
    socket.once('close', () => { if (!settled) finish(new Error('SCANNER_EARLY_CLOSE')); });
    socket.on('data', chunk => {
      response += chunk.toString('ascii');
      if (response.length > 4096) { finish(new Error('INVALID_SCANNER_RESPONSE')); return; }
      if (response.includes('\0')) {
        if (!sent) { finish(new Error('INVALID_SCANNER_RESPONSE')); return; }
        if (/^stream: [^\x00\r\n]{1,300} FOUND\0$/.test(response)) { finish(new FileValidationError('FILE_SCAN_INFECTED')); return; }
        if (response !== 'stream: OK\0') { finish(new Error('INVALID_SCANNER_RESPONSE')); return; }
        finish();
      }
    });
    // Await every write callback: only one bounded INSTREAM frame is queued.
    const write = (data: Buffer | string) => new Promise<void>((done, fail) => {
      if (settled || options.signal?.aborted || Date.now() >= deadline) { fail(new Error('SCANNER_STOPPED')); return; }
      socket.write(data, error => error ? fail(error) : done());
    });
    socket.once('connect', () => { void (async () => {
      await write('zINSTREAM\0');
      for await (const raw of source) {
        const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        total += data.length; if (total > maxBytes) throw new Error('SCANNER_INPUT_LIMIT');
        for (let offset = 0; offset < data.length; offset += 65536) {
          const chunk = data.subarray(offset, offset + 65536), length = Buffer.alloc(4); length.writeUInt32BE(chunk.length);
          await write(length); await write(chunk);
        }
      }
      if (!total) throw new Error('SCANNER_EMPTY_INPUT');
      sent = true; await write(Buffer.alloc(4));
    })().catch(error => finish(error instanceof Error && /^SCANNER_[A-Z_]+$/.test(error.message) ? error : new Error('SCANNER_UNAVAILABLE'))); });
    if (options.signal?.aborted) abort();
  });
}

/** Backward-compatible API entry point; all callers now have an absolute bound. */
export async function scanWithClamAv(data: Buffer, host: string, port = 3310, options: ScanOptions = {}): Promise<void> {
  await scanStreamWithClamAv(Readable.from([data]), host, port, options);
}
