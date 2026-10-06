import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, writeFile, readFile, lstat, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDeviceIdentity, sha256 } from '@kivro/crypto';
import { verifyRequest } from '@kivro/job-protocol';
import { sniffFileMime } from '@kivro/openclaw-adapter';
import { WorkerTransport } from './transport.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(handler?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean> | boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-transfer-'))), data = Buffer.from('transfer-canary\n'.repeat(65536)), keys = generateDeviceIdentity();
  const asset = { id: randomUUID(), filename: 'canary.txt', mimeType: 'text/plain', sizeBytes: data.length, sha256: sha256(data) }, jobId = randomUUID(), attemptId = randomUUID(), uploadId = randomUUID();
  const requests: { method: string; path: string; size: number }[] = [], errors: unknown[] = [];
  let origin = '', finalizations = 0;
  const ticket = { id: uploadId, method: 'PUT', headers: { 'content-type': 'text/plain' }, expiresAt: new Date(Date.now() + 600000).toISOString(), uploadUrlExpiresAt: new Date(Date.now() + 300000).toISOString(), uploadUrl: '' };
  const server = createServer(async (request, response) => {
    try {
      if (await handler?.(request, response)) return;
      const parts: Buffer[] = []; for await (const chunk of request) parts.push(chunk);
      const body = Buffer.concat(parts); requests.push({ method: request.method!, path: request.url!, size: body.length });
      if (request.url?.startsWith('/api/worker/')) expect(verifyRequest(keys.publicKey, request.method!, request.url, body, request.headers as Record<string, string>)).toBe(true);
      if (request.url === `/api/worker/jobs/${jobId}/uploads`) {
        expect(JSON.parse(body.toString())).toEqual({ attemptId, filename: asset.filename, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, sha256: asset.sha256 });
        response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(ticket));
      } else if (request.url === '/quarantine/test?signature=test-only') {
        expect(request.method).toBe('PUT'); expect(request.headers['content-length']).toBe(String(data.length)); expect(request.headers['content-type']).toBe('text/plain');
        expect(Object.keys(request.headers).filter(key => /worker|authorization|cookie/i.test(key))).toEqual([]); expect(body).toEqual(data);
        response.writeHead(200).end();
      } else if (request.url === `/api/worker/jobs/${jobId}/uploads/${uploadId}/finalize`) {
        finalizations++; expect(JSON.parse(body.toString())).toEqual({ attemptId }); response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(asset));
      } else if (request.url === `/api/worker/assets/${asset.id}/download`) {
        response.writeHead(200, { 'content-length': data.length }); for (let offset = 0; offset < data.length; offset += 65536) response.write(data.subarray(offset, offset + 65536)); response.end();
      } else response.writeHead(404).end();
    } catch (error) { errors.push(error); response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS'); origin = `http://127.0.0.1:${address.port}`; ticket.uploadUrl = `${origin}/quarantine/test?signature=test-only`;
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); expect(errors).toEqual([]); });
  const transport = new WorkerTransport(origin, { workerId: randomUUID(), publicKey: keys.publicKey, serverPublicKey: keys.publicKey, apiUrl: origin }, keys.privateKey, true);
  const path = join(root, 'result'); await writeFile(path, data, { mode: 0o400 });
  return { root, data, asset, path, transport, requests, ticket, jobId, attemptId, finalizations: () => finalizations };
}
describe('bounded direct Worker file transport', () => {
  it('streams an integrity-checked read-only input file and direct signed PUT with exact length and no Worker auth at storage', async () => {
    const context = await fixture(), destination = join(context.root, 'download');
    await context.transport.downloadToFile(context.asset, destination, 2 * 1024 ** 2);
    expect(await readFile(destination)).toEqual(context.data); expect((await lstat(destination)).mode & 0o777).toBe(0o444);
    expect(await sniffFileMime(destination, 'canary.txt', 2 * 1024 ** 2)).toBe('text/plain');
    expect(await context.transport.uploadFile(context.jobId, context.attemptId, context.asset, context.path)).toEqual(context.asset);
    expect(context.finalizations()).toBe(1); expect(context.requests.filter(item => item.path.startsWith('/api/') && item.method === 'POST').every(item => item.size < 1000)).toBe(true);
  });
  it('rejects download corruption, declared oversize, unsafe routes and overwrites; removes incomplete files', async () => {
    const context = await fixture(), destination = join(context.root, 'download');
    await expect(context.transport.downloadToFile({ ...context.asset, sha256: '0'.repeat(64) }, destination, 2 * 1024 ** 2)).rejects.toThrow();
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(context.transport.downloadToFile(context.asset, destination, 10)).rejects.toThrow('INVALID_TRANSFER_FILE');
    await expect(context.transport.downloadToFile({ ...context.asset, downloadUrl: 'http://169.254.169.254/latest/meta-data' }, destination, 2 * 1024 ** 2)).rejects.toThrow('UNSAFE_ASSET_DOWNLOAD_URL');
    await writeFile(destination, 'existing'); await expect(context.transport.downloadToFile(context.asset, destination, 2 * 1024 ** 2)).rejects.toThrow(); expect(await readFile(destination, 'utf8')).toBe('existing');
  });
  it('rejects a chunked body over the signed size and cancelled streams without retaining a partial file', async () => {
    const context = await fixture((request, response) => {
      if (!request.url?.endsWith('/download')) return false;
      response.writeHead(200); response.end(Buffer.alloc(100)); return true;
    });
    const destination = join(context.root, 'too-large'), asset = { ...context.asset, sizeBytes: 20, sha256: sha256(Buffer.alloc(20)) };
    await expect(context.transport.downloadToFile(asset, destination, 1000)).rejects.toThrow(); await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    const controller = new AbortController(); controller.abort(); await expect(context.transport.downloadToFile(context.asset, destination, 2 * 1024 ** 2, controller.signal)).rejects.toThrow(); await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses expired tickets, unexpected storage headers and non-public/unsafe endpoints before finalization', async () => {
    const context = await fixture(); context.ticket.expiresAt = new Date(0).toISOString();
    await expect(context.transport.uploadFile(context.jobId, context.attemptId, context.asset, context.path)).rejects.toThrow('UPLOAD_TICKET_EXPIRED');
    context.ticket.expiresAt = new Date(Date.now() + 60000).toISOString(); context.ticket.uploadUrl = 'http://169.254.169.254/upload';
    await expect(context.transport.uploadFile(context.jobId, context.attemptId, context.asset, context.path)).rejects.toThrow('UNSAFE_UPLOAD_URL');
    context.ticket.uploadUrl = 'https://127.0.0.2/upload';
    await expect(context.transport.uploadFile(context.jobId, context.attemptId, context.asset, context.path)).rejects.toThrow();
    Object.assign(context.ticket.headers, { authorization: 'must-not-forward' });
    await expect(context.transport.uploadFile(context.jobId, context.attemptId, context.asset, context.path)).rejects.toThrow(); expect(context.finalizations()).toBe(0);
  });
  it('never follows upload/download redirects or finalizes redirected writes', async () => {
    const context = await fixture((request, response) => {
      if (request.url?.startsWith('/quarantine/') || request.url?.endsWith('/download')) { request.resume(); response.writeHead(307, { location: 'http://169.254.169.254/never-follow' }).end(); return true; }
      return false;
    });
    await expect(context.transport.uploadFile(context.jobId, context.attemptId, context.asset, context.path)).rejects.toThrow('HTTP_REDIRECT_DENIED');
    await expect(context.transport.downloadToFile(context.asset, join(context.root, 'download'), 2 * 1024 ** 2)).rejects.toThrow('HTTP_REDIRECT_DENIED'); expect(context.finalizations()).toBe(0);
  });
  it('cancels transfers in flight, removes partial input and never finalizes an aborted PUT', async () => {
    const download = new AbortController(), upload = new AbortController();
    const context = await fixture((request, response) => {
      if (request.url?.endsWith('/download')) { response.writeHead(200); response.write('partial'); setImmediate(() => download.abort()); return true; }
      if (request.url?.startsWith('/quarantine/')) { request.resume(); setImmediate(() => upload.abort()); return true; }
      return false;
    });
    const path = join(context.root, 'partial');
    await expect(context.transport.downloadToFile(context.asset, path, 2 * 1024 ** 2, download.signal)).rejects.toThrow();
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(context.transport.uploadFile(context.jobId, context.attemptId, context.asset, context.path, upload.signal)).rejects.toThrow(); expect(context.finalizations()).toBe(0);
  });
  it('rejects corrupt, symlinked and hardlinked local outputs before requesting upload authority', async () => {
    const context = await fixture();
    await expect(context.transport.uploadFile(context.jobId, context.attemptId, { ...context.asset, sha256: '0'.repeat(64) }, context.path)).rejects.toThrow('INTEGRITY');
    const symbolic = join(context.root, 'symbolic'); await symlink(context.path, symbolic);
    await expect(context.transport.uploadFile(context.jobId, context.attemptId, context.asset, symbolic)).rejects.toThrow('UNSAFE_UPLOAD_FILE');
    await link(context.path, join(context.root, 'hard'));
    await expect(context.transport.uploadFile(context.jobId, context.attemptId, context.asset, context.path)).rejects.toThrow('UNSAFE_UPLOAD_FILE'); expect(context.requests).toEqual([]);
  });
  it('checks text across stream boundaries and retains strict JSON/CSV validation', async () => {
    const { root } = await fixture();
    for (const [name, data] of [['bad.txt', `${' '.repeat(65534)}<script>bad`], ['bad.csv', `${'a'.repeat(65534)},=formula`], ['bad.json', '{"incomplete":'], ['utf.txt', Buffer.from([0xff, 0xfe])]] as const) {
      const path = join(root, name); await writeFile(path, data); await expect(sniffFileMime(path, name, 100000)).rejects.toThrow();
    }
    const path = join(root, 'valid.json'); await writeFile(path, '{"valid":true}'); expect(await sniffFileMime(path, 'valid.json', 100)).toBe('application/json');
  });
});
