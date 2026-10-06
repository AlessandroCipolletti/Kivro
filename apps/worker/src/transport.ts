import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { AssetDTOSchema, WorkerWarningSnapshotSchema, type AssetDTO } from '@kivro/contracts';
import { signedHeaders, WorkerCommandSchema, SignedJobOfferSchema, SignedJobNoticeSchema } from '@kivro/job-protocol';
import { assertEd25519PublicKey } from '@kivro/crypto';
import type { CollectedFile } from '@kivro/openclaw-adapter';
import { assertEndpoint, boundedRequest } from './http.ts';
import { downloadFile, openUploadFile, uploadFile, type FileDescriptor } from './file-transfer.ts';

export type DeviceIdentity = { workerId: string; serverPublicKey: string; publicKey: string; apiUrl: string };
const PolicyVersionSchema = z.string().regex(/^[0-9A-Za-z.+-]{1,100}$/);
export const DeploymentEnvironmentSchema = z.enum(['production', 'staging', 'preview', 'development', 'test', 'unknown']);
const LegacyWorkerDiagnosticsSchema = z.object({ serverTime: z.string().datetime(), workerId: z.string().uuid(), minimumWorkerVersion: PolicyVersionSchema, minimumOpenClawVersion: PolicyVersionSchema, revokedWorkerVersions: z.array(PolicyVersionSchema).max(100), revokedOpenClawVersions: z.array(PolicyVersionSchema).max(100), policyReason: z.string().regex(/^[A-Z0-9_]{1,100}$/).nullable() }).strict();
export const WorkerDiagnosticsSchema = LegacyWorkerDiagnosticsSchema.extend({ sellerId: z.string().uuid().optional(), deploymentEnvironment: DeploymentEnvironmentSchema.optional(), securityWarnings: WorkerWarningSnapshotSchema.optional() });
const WorkerDiagnosticsV2Schema = WorkerDiagnosticsSchema.extend({ sellerId: z.string().uuid(), deploymentEnvironment: DeploymentEnvironmentSchema });
export type WorkerDiagnostics = z.infer<typeof WorkerDiagnosticsSchema>;
export class TransportError extends Error { constructor(readonly status: number, readonly code = 'UNKNOWN') { super(`WORKER_API_${status}`); } }
function responseError(status: number, body: Buffer): TransportError {
  let code = 'UNKNOWN'; try { const parsed = JSON.parse(body.toString()); if (/^[A-Z0-9_]{1,100}$/.test(parsed.error?.code)) code = parsed.error.code; } catch { /* No untrusted response text is logged. */ }
  return new TransportError(status, code);
}
export class WorkerTransport {
  readonly origin: URL;
  constructor(apiUrl: string, readonly identity?: DeviceIdentity, readonly privateKey?: string, readonly development = false) { this.origin = assertEndpoint(apiUrl, development); }
  async request(method: 'GET' | 'POST', pathname: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!/^\/api\/worker(?:\/|$)/.test(pathname) || /[?#\r\n]/.test(pathname)) throw new Error('INVALID_WORKER_ROUTE');
    const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const headers = this.identity && this.privateKey ? signedHeaders(this.identity.workerId, this.privateKey, method, pathname, bytes) : {};
    const response = await boundedRequest(new URL(pathname, this.origin), { method, headers: { ...headers, ...(bytes.length ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}) }, body: bytes, maxBytes: 4 * 1024 ** 2, signal });
    if (response.status < 200 || response.status >= 300) throw responseError(response.status, response.body);
    return response.body.length ? JSON.parse(response.body.toString()) : {};
  }
  async pair(code: string, publicKey: string, name: string): Promise<{ workerId: string; serverPublicKey: string }> {
    if (!/^[A-Za-z0-9-]{6,128}$/.test(code)) throw new Error('INVALID_PAIRING_CODE');
    const response = z.object({ workerId: z.string().uuid(), serverPublicKey: z.string().max(1024) }).parse(await this.request('POST', '/api/worker/pair', { code, publicKey, name: name.slice(0, 80), version: '0.1.0' }));
    assertEd25519PublicKey(response.serverPublicKey); return response;
  }
  async heartbeat(body: unknown) { return z.object({ commands: z.array(WorkerCommandSchema).max(100) }).parse(await this.request('POST', '/api/worker/heartbeat', body)); }
  async diagnostics(): Promise<WorkerDiagnostics> {
    if (!this.identity || !this.privateKey) throw new Error('NOT_PAIRED');
    let raw: unknown, legacy = false;
    try { raw = await this.request('GET', '/api/worker/diagnostics/v2'); }
    catch (error) {
      if (!(error instanceof TransportError) || error.status !== 404) throw error;
      legacy = true; raw = await this.request('GET', '/api/worker/diagnostics');
    }
    const result = (legacy ? LegacyWorkerDiagnosticsSchema : WorkerDiagnosticsV2Schema).safeParse(raw);
    if (!result.success) throw new Error('CLOUD_DIAGNOSTICS_INVALID');
    if (result.data.workerId !== this.identity.workerId) throw new Error('CLOUD_DEVICE_MISMATCH');
    return legacy ? { ...result.data, deploymentEnvironment: 'unknown' } : result.data;
  }
  async publicClock(): Promise<string> {
    // An unsigned clock hint can explain an authentication failure, but never
    // proves device validity and never changes the host clock or signing time.
    const response = await boundedRequest(new URL('/api/health', this.origin), { maxBytes: 4096, timeoutMs: 5000 });
    if (response.status !== 200) throw new Error('PUBLIC_CLOCK_UNAVAILABLE');
    const result = z.object({ serverTime: z.string().datetime() }).safeParse(JSON.parse(response.body.toString()));
    if (!result.success) throw new Error('PUBLIC_CLOCK_INVALID');
    return result.data.serverTime;
  }
  async offers() { return z.object({ offers: z.array(SignedJobNoticeSchema).max(10) }).parse(await this.request('GET', '/api/worker/offers')); }
  async acceptedPayload(jobId: string, attemptId: string, signal?: AbortSignal) {
    z.string().uuid().parse(jobId); z.string().uuid().parse(attemptId);
    if (!this.identity || !this.privateKey) throw new Error('NOT_PAIRED');
    const url = new URL(`/api/worker/jobs/${jobId}/payload`, this.origin); url.searchParams.set('attemptId', attemptId);
    const response = await boundedRequest(url, { headers: signedHeaders(this.identity.workerId, this.privateKey, 'GET', url.pathname), maxBytes: 4 * 1024 ** 2, signal });
    if (response.status !== 200) throw responseError(response.status, response.body);
    return SignedJobOfferSchema.parse(JSON.parse(response.body.toString()));
  }
  async downloadToFile(raw: AssetDTO, destination: string, maxBytes: number, signal?: AbortSignal): Promise<void> {
    const asset = AssetDTOSchema.parse(raw);
    if (!this.identity || !this.privateKey) throw new Error('NOT_PAIRED');
    const url = asset.downloadUrl ? new URL(asset.downloadUrl, this.origin) : new URL(`/api/worker/assets/${asset.id}/download`, this.origin);
    if (url.origin !== this.origin.origin || url.username || url.password || url.hash || url.search || url.pathname !== `/api/worker/assets/${asset.id}/download`) throw new Error('UNSAFE_ASSET_DOWNLOAD_URL');
    await downloadFile(url, signedHeaders(this.identity.workerId, this.privateKey, 'GET', url.pathname), asset, destination, maxBytes, signal);
  }
  async uploadFile(jobId: string, attemptId: string, file: FileDescriptor, path: string, signal?: AbortSignal): Promise<AssetDTO> {
    z.string().uuid().parse(jobId); z.string().uuid().parse(attemptId);
    if (!this.identity || !this.privateKey) throw new Error('NOT_PAIRED');
    signal?.throwIfAborted();
    const handle = await openUploadFile(path, file, signal);
    try {
      const ticket = z.object({ id: z.string().uuid(), uploadUrl: z.string().url().max(8192), method: z.literal('PUT'), headers: z.object({ 'content-type': z.literal(file.mimeType) }).strict(), expiresAt: z.string().datetime(), uploadUrlExpiresAt: z.string().datetime().optional() }).parse(await this.request('POST', `/api/worker/jobs/${jobId}/uploads`, { attemptId, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes, sha256: file.sha256 }, signal));
      if (Date.parse(ticket.expiresAt) <= Date.now() || Date.parse(ticket.uploadUrlExpiresAt ?? ticket.expiresAt) <= Date.now()) throw new Error('UPLOAD_TICKET_EXPIRED');
      const url = new URL(ticket.uploadUrl), local = this.development && ['localhost', '127.0.0.1', '[::1]'].includes(this.origin.hostname) && ['127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error('UNSAFE_UPLOAD_URL');
      signal?.throwIfAborted(); await uploadFile(url, handle, file, local, signal); signal?.throwIfAborted();
      const result = AssetDTOSchema.parse(await this.request('POST', `/api/worker/jobs/${jobId}/uploads/${ticket.id}/finalize`, { attemptId }, signal));
      if (result.sha256 !== file.sha256 || result.sizeBytes !== file.sizeBytes || result.mimeType !== file.mimeType || result.filename !== file.filename) throw new Error('UPLOADED_ASSET_INTEGRITY_FAILED');
      return result;
    } finally { await handle.close(); }
  }
  async upload(jobId: string, attemptId: string, file: CollectedFile, signal?: AbortSignal): Promise<AssetDTO> {
    // Container frames remain capped at 8 MiB/file. The network upload is a
    // private immutable disk spool, never a concatenated multipart API body.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kivro-upload-'))), path = join(root, 'result');
    try { await writeFile(path, file.data, { flag: 'wx', mode: 0o400 }); return await this.uploadFile(jobId, attemptId, file, path, signal); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}
