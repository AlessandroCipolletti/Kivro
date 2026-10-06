import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ipaddr from 'ipaddr.js';

export type NetworkErrorCode = 'NETWORK_POLICY_DENIED' | 'PRIVATE_DESTINATION_DENIED' |
  'METHOD_NOT_ALLOWED' | 'NETWORK_BUDGET_EXCEEDED' | 'RESPONSE_TOO_LARGE' |
  'CONTENT_TYPE_DENIED' | 'NETWORK_TIMEOUT' | 'NETWORK_CANCELLED' | 'NETWORK_UNAVAILABLE' | 'PROVIDER_UNAVAILABLE';

export class NetworkPolicyError extends Error {
  constructor(public readonly code: NetworkErrorCode) { super(code); this.name = 'NetworkPolicyError'; }
}

const v4Special = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
  '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'].map(ipaddr.parseCIDR);
const v6Special = ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].map(ipaddr.parseCIDR);

/** Only globally routable unicast. IPv4 transition mechanisms fail closed. */
export function assertPublicAddress(address: string): void {
  if (!isIP(address) || address.includes('%')) throw new NetworkPolicyError('PRIVATE_DESTINATION_DENIED');
  const parsed = ipaddr.parse(address);
  const matches = (ranges: ReturnType<typeof ipaddr.parseCIDR>[]) => ranges.some(([network, bits]) =>
    parsed.kind() === network.kind() && parsed.match(network, bits));
  if (parsed.range() !== 'unicast' || (parsed.kind() === 'ipv4' ? matches(v4Special) :
    !parsed.match(ipaddr.parse('2000::'), 3) || matches(v6Special))) {
    throw new NetworkPolicyError('PRIVATE_DESTINATION_DENIED');
  }
}

export interface ResolvedAddress { address: string; family: number }
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
export interface SafeRequest {
  url: string;
  method?: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  httpsOnly?: boolean;
  allowedDomains?: readonly string[];
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
  allowedContentTypes?: readonly string[];
}
export interface SafeResponse {
  status: number; headers: Record<string, string>; body: Buffer; finalUrl: string;
  /** Includes every redirect body, so accounting cannot undercount redirect traffic. */
  bytesReceived?: number;
  contentBytes?: number;
  sha256?: string;
}
export type DownloadResponse = Omit<SafeResponse, 'body'> & { contentBytes: number; sha256: string };
export interface HttpTransport {
  request(request: SafeRequest): Promise<SafeResponse>;
  /** Trusted quarantine sink; never exposed as model input. */
  download?(request: SafeRequest, sink: Writable): Promise<DownloadResponse>;
}

export function parsePublicUrl(value: string, options: Pick<SafeRequest, 'httpsOnly' | 'allowedDomains'> = {}): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new NetworkPolicyError('NETWORK_POLICY_DENIED'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || (options.httpsOnly && url.protocol !== 'https:') ||
    url.username || url.password || url.hash || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) ||
    !hostname || /(^|\.)(localhost|local|internal|home|lan|test|invalid)$/.test(hostname) ||
    (!isIP(hostname) && !hostname.includes('.')) || value.length > 4096) {
    throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
  }
  if (options.allowedDomains && !options.allowedDomains.some(domain => domain.toLowerCase() === hostname)) {
    throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
  }
  if (isIP(hostname)) assertPublicAddress(hostname);
  return url;
}

function limitedInt(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
  return value;
}

export class SafeHttpClient implements HttpTransport {
  // Cancellation is trusted host configuration, never part of model/tool input.
  constructor(private readonly options: { resolver?: Resolver; blockedHosts?: readonly string[]; signal?: AbortSignal } = {}) {}

  private assertActive(): void { if (this.options.signal?.aborted) throw new NetworkPolicyError('NETWORK_CANCELLED'); }

  async validateUrl(value: string, options: Pick<SafeRequest, 'httpsOnly' | 'allowedDomains'> = {}): Promise<void> {
    const url = parsePublicUrl(value, options);
    await this.resolve(url, 5000);
  }

  private async resolve(url: URL, timeoutMs: number): Promise<ResolvedAddress> {
    this.assertActive();
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (this.options.blockedHosts?.some(item => item.toLowerCase() === host)) throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
      const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
        (this.options.resolver ?? (name => dnsLookup(name, { all: true, verbatim: true })))(host),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new NetworkPolicyError('NETWORK_TIMEOUT')), timeoutMs); }),
        new Promise<never>((_, reject) => { abort = () => reject(new NetworkPolicyError('NETWORK_CANCELLED')); this.options.signal?.addEventListener('abort', abort, { once: true }); if (this.options.signal?.aborted) abort(); }),
      ]);
      this.assertActive();
      if (!addresses.length) throw new NetworkPolicyError('NETWORK_UNAVAILABLE');
      for (const result of addresses) {
        assertPublicAddress(result.address);
        if (result.family !== isIP(result.address)) throw new NetworkPolicyError('PRIVATE_DESTINATION_DENIED');
      }
      return addresses[0]!;
    } catch (error) {
      if (error instanceof NetworkPolicyError) throw error;
      throw new NetworkPolicyError('NETWORK_UNAVAILABLE');
    } finally { clearTimeout(timer); if (abort) this.options.signal?.removeEventListener('abort', abort); }
  }

  async request(input: SafeRequest): Promise<SafeResponse> {
    return this.requestBound(input);
  }

  async download(input: SafeRequest, sink: Writable): Promise<DownloadResponse> {
    try {
      if (input.method && input.method !== 'GET' || input.body || Object.keys(input.headers ?? {}).some(key => key.toLowerCase() !== 'accept')) throw new NetworkPolicyError('METHOD_NOT_ALLOWED');
      const { body: _body, ...response } = await this.requestBound({ ...input, method: 'GET', httpsOnly: true }, sink);
      if (!response.sha256 || !response.contentBytes || response.status !== 200) throw new NetworkPolicyError('NETWORK_UNAVAILABLE');
      return { ...response, sha256: response.sha256, contentBytes: response.contentBytes };
    } catch (error) { sink.destroy(); throw error; }
  }

  private async requestBound(input: SafeRequest, sink?: Writable): Promise<SafeResponse> {
    this.assertActive();
    const method = input.method ?? 'GET';
    if (!['GET', 'HEAD', 'POST'].includes(method)) throw new NetworkPolicyError('METHOD_NOT_ALLOWED');
    if (input.body && method !== 'POST') throw new NetworkPolicyError('METHOD_NOT_ALLOWED');
    if (input.body && Buffer.byteLength(input.body) > 256_000) throw new NetworkPolicyError('RESPONSE_TOO_LARGE');
    const maxBytes = limitedInt(input.maxBytes ?? 1_000_000, 1, 5_000_000);
    const redirects = limitedInt(input.maxRedirects ?? 3, 0, 5);
    const timeoutMs = limitedInt(input.timeoutMs ?? 10_000, 1, 30_000);
    // Sensitive and side-effecting requests never forward credentials or bodies to redirects.
    if ((input.body || Object.keys(input.headers ?? {}).some(k => !['accept', 'content-type'].includes(k.toLowerCase()))) && redirects !== 0) {
      throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
    }
    for (const key of Object.keys(input.headers ?? {})) {
      if (['host', 'connection', 'transfer-encoding', 'content-length', 'proxy-authorization', 'cookie'].includes(key.toLowerCase())) {
        throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
      }
    }
    let url = parsePublicUrl(input.url, input);
    const deadline = Date.now() + timeoutMs;
    let remainingBytes = maxBytes;
    for (let hop = 0; ; hop++) {
      this.assertActive();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new NetworkPolicyError('NETWORK_TIMEOUT');
      const pin = await this.resolve(url, remaining);
      this.assertActive();
      if (Date.now() >= deadline) throw new NetworkPolicyError('NETWORK_TIMEOUT');
      const response = await this.connect(url, pin, { ...input, method, maxBytes: remainingBytes, timeoutMs: deadline - Date.now() }, sink);
      this.assertActive();
      remainingBytes -= response.contentBytes ?? response.body.length;
      if (![301, 302, 303, 307, 308].includes(response.status)) return { ...response, bytesReceived: maxBytes - remainingBytes };
      if (hop >= redirects || !response.headers.location || method === 'POST') throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
      let next: URL;
      try { next = new URL(response.headers.location, url); } catch { throw new NetworkPolicyError('NETWORK_POLICY_DENIED'); }
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw new NetworkPolicyError('NETWORK_POLICY_DENIED');
      url = parsePublicUrl(next.href, input);
    }
  }

  private connect(url: URL, pin: ResolvedAddress, input: SafeRequest & { maxBytes: number; timeoutMs: number }, sink?: Writable): Promise<SafeResponse> {
    this.assertActive();
    return new Promise((resolve, reject) => {
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(url, {
        method: input.method, agent: false, family: pin.family, maxHeaderSize: 16_384,
        // The original host remains the HTTP Host and TLS SNI/certificate identity.
        lookup: (_hostname, _options, callback) => callback(null, pin.address, pin.family),
        headers: { ...input.headers, 'accept-encoding': 'identity', 'user-agent': 'Kivro-Research/1.0' },
      });
      let settled = false;
      const timer = setTimeout(() => fail(new NetworkPolicyError('NETWORK_TIMEOUT')), input.timeoutMs);
      const abort = () => fail(new NetworkPolicyError('NETWORK_CANCELLED'));
      const cleanup = () => { clearTimeout(timer); this.options.signal?.removeEventListener('abort', abort); };
      // A completed HTTP request cannot abort a still-flushing quarantine sink.
      // Keep the absolute deadline authoritative until the whole pipeline ends.
      const fail = (error: NetworkPolicyError) => {
        if (settled) return; settled = true; cleanup(); sink?.destroy(); req.destroy(error); reject(error);
      };
      const succeed = (response: SafeResponse) => { if (settled) return; settled = true; cleanup(); resolve(response); };
      req.once('error', error => fail(error instanceof NetworkPolicyError ? error : new NetworkPolicyError('NETWORK_UNAVAILABLE')));
      req.once('socket', socket => {
        socket.once('connect', () => {
          try {
            const address = socket.remoteAddress;
            if (!address) throw new NetworkPolicyError('PRIVATE_DESTINATION_DENIED');
            const normalized = ipaddr.process(address).toNormalizedString();
            if (normalized !== ipaddr.process(pin.address).toNormalizedString()) throw new NetworkPolicyError('PRIVATE_DESTINATION_DENIED');
            assertPublicAddress(pin.address);
          } catch { fail(new NetworkPolicyError('PRIVATE_DESTINATION_DENIED')); }
        });
      });
      req.once('response', res => {
        res.once('error', () => fail(new NetworkPolicyError(this.options.signal?.aborted ? 'NETWORK_CANCELLED' : 'NETWORK_UNAVAILABLE')));
        const status = res.statusCode ?? 0;
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) if (typeof value === 'string') headers[key] = value;
        const type = (headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        const isRedirect = [301, 302, 303, 307, 308].includes(status);
        if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') {
          fail(new NetworkPolicyError('CONTENT_TYPE_DENIED')); return;
        }
        if (!isRedirect && input.method !== 'HEAD' && input.allowedContentTypes && !input.allowedContentTypes.includes(type)) {
          fail(new NetworkPolicyError('CONTENT_TYPE_DENIED')); return;
        }
        if (Number(headers['content-length']) > input.maxBytes) { fail(new NetworkPolicyError('RESPONSE_TOO_LARGE')); return; }
        if (sink && !isRedirect) {
          if (status !== 200) { fail(new NetworkPolicyError('NETWORK_UNAVAILABLE')); return; }
          const hash = createHash('sha256'); let bytes = 0;
          const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > input.maxBytes) { callback(new NetworkPolicyError('RESPONSE_TOO_LARGE')); return; }
            hash.update(chunk); callback(null, chunk);
          } });
          void pipeline(res, meter, sink, { signal: this.options.signal }).then(() => {
            succeed({ status, headers, body: Buffer.alloc(0), finalUrl: url.href, contentBytes: bytes, sha256: hash.digest('hex') });
          }, error => {
            fail(this.options.signal?.aborted ? new NetworkPolicyError('NETWORK_CANCELLED') : error instanceof NetworkPolicyError ? error : new NetworkPolicyError('NETWORK_UNAVAILABLE'));
          });
          return;
        }
        const chunks: Buffer[] = []; let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > input.maxBytes) fail(new NetworkPolicyError('RESPONSE_TOO_LARGE'));
          else chunks.push(chunk);
        });
        res.once('end', () => succeed({ status, headers, body: Buffer.concat(chunks), finalUrl: url.href }));
      });
      this.options.signal?.addEventListener('abort', abort, { once: true });
      if (this.options.signal?.aborted) { abort(); return; }
      req.end(input.body);
    });
  }
}
