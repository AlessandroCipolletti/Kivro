import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolvePublicUrl } from '@kivro/policy-engine';

export type HttpResponse = { status: number; body: Buffer; headers: Record<string, string | string[] | undefined> };
type HttpOptions = { method?: string; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; localApproved?: boolean; publicOnly?: boolean };
async function pinnedAddress(url: URL, options: HttpOptions, signal: AbortSignal): Promise<{ address: string; family: number } | undefined> {
  if (!options.publicOnly || (options.localApproved && ['127.0.0.1', '[::1]'].includes(url.hostname))) return undefined;
  const resolved = await new Promise<Awaited<ReturnType<typeof resolvePublicUrl>>>((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    resolvePublicUrl(url.href).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  return resolved.addresses[0]!;
}
/** The consumer must bound/hash bytes. No redirects, cookies or ambient auth. */
export async function streamingRequest<T>(url: URL, options: HttpOptions & { body?: Readable; consume: (response: IncomingMessage) => Promise<T> }): Promise<T> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('UNSAFE_HTTP_URL');
  const controller = new AbortController(), signal = controller.signal;
  const cancel = () => controller.abort(options.signal?.reason ?? new Error('HTTP_CANCELLED'));
  options.signal?.addEventListener('abort', cancel, { once: true }); if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error('HTTP_TIMEOUT')), options.timeoutMs ?? 60000);
  try {
    signal.throwIfAborted(); const address = await pinnedAddress(url, options, signal); signal.throwIfAborted();
    let upload: Promise<void> = Promise.resolve();
    const response = new Promise<T>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: options.method ?? 'GET', headers: options.headers, signal,
        ...(address ? { family: address.family, lookup: (_hostname, _options, callback) => callback(null, address!.address, address!.family) } : {}),
      }, response => {
        if ((response.statusCode ?? 0) >= 300 && response.statusCode! < 400) { request.destroy(new Error('HTTP_REDIRECT_DENIED')); response.destroy(); return; }
        void options.consume(response).then(resolve, error => { request.destroy(); response.destroy(); reject(error); });
      });
      request.on('error', reject);
      if (options.body) { upload = pipeline(options.body, request, { signal }); void upload.catch(reject); }
      else request.end();
    });
    const [result] = await Promise.all([response, upload]); return result;
  } catch (error) { controller.abort(); options.body?.destroy(); throw error; }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
}
export function assertEndpoint(raw: string, development: boolean): URL {
  const url = new URL(raw);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search || url.pathname !== '/' || (url.protocol !== 'https:' && !(development && local && url.protocol === 'http:'))) throw new Error('HTTPS_API_REQUIRED');
  return url;
}

export async function boundedRequest(url: URL, options: { method?: string; headers?: Record<string, string>; body?: Buffer; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal; localApproved?: boolean; publicOnly?: boolean }): Promise<HttpResponse> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('UNSAFE_HTTP_URL');
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason ?? new Error('HTTP_CANCELLED'));
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error('HTTP_TIMEOUT')), options.timeoutMs ?? 15_000);
  const signal = controller.signal;
  try {
    signal.throwIfAborted();
    const address = await pinnedAddress(url, options, signal);
    signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: options.method ?? 'GET', headers: options.headers, signal,
        ...(address ? { family: address.family, lookup: (_hostname, _options, callback) => callback(null, address!.address, address!.family) } : {}),
      }, response => {
        let size = 0; const parts: Buffer[] = [];
        const length = Number(response.headers['content-length']);
        if (Number.isFinite(length) && length > (options.maxBytes ?? 2 * 1024 ** 2)) { request.destroy(new Error('HTTP_BODY_TOO_LARGE')); return; }
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > (options.maxBytes ?? 2 * 1024 ** 2)) request.destroy(new Error('HTTP_BODY_TOO_LARGE')); else parts.push(chunk); });
        response.on('end', () => { if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) reject(new Error('HTTP_REDIRECT_DENIED')); else resolve({ status: response.statusCode ?? 0, body: Buffer.concat(parts), headers: response.headers }); });
        response.on('error', reject);
      });
      request.on('error', reject);
      request.end(options.body);
    });
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
}
